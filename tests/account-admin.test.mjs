import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, verify} from 'node:crypto';
import {test} from 'node:test';
import {handleAccountAdmin} from '../worker/account-admin.mjs';

const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const project = 'demo-tutorflow';
const origin = 'https://naco727.github.io';
const database = 'projects/' + project + '/databases/(default)/documents/';
const env = {
  FIREBASE_PROJECT_ID: project,
  FIREBASE_ACCOUNT_ADMIN_SERVICE_ACCOUNT: JSON.stringify({
    type: 'service_account', project_id: project, private_key_id: 'fixture',
    client_email: 'fixture@example.invalid', private_key: privateKey.export({format: 'pem', type: 'pkcs8'})
  })
};

function fixture(actorUid = 'admin', actorRole = 'admin', actorStatus = 'active') {
  const now = Math.floor(Date.now() / 1000);
  const claims = {sub: actorUid, aud: project, iss: 'https://securetoken.google.com/' + project,
    exp: now + 600, iat: now, auth_time: now - 1,
    email_verified: true, firebase: {sign_in_provider: 'password'}};
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = encoded({alg:'RS256',kid:'fixture'}) + '.' + encoded(claims);
  const idToken = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  const documents = new Map(), users = new Map(), changes = [];
  const authUser = uid => ({localId: uid, email: uid + '@example.invalid', emailVerified: true});
  const resource = (path, fields) => ({name: database + path, fields, updateTime: '2026-01-01T00:00:00Z'});
  const add = (path, fields) => documents.set(path, resource(path, fields));
  const membership = (uid, role, status) => {
    add('memberships/' + uid, {role: {stringValue: role}, status: {stringValue: status}});
    users.set(uid, authUser(uid));
  };
  membership(actorUid, actorRole, actorStatus);
  membership('teacher', 'teacher', 'pending');
  membership('other-admin', 'admin', 'active');
  users.set('unrelated', authUser('unrelated'));
  add('teachers/teacher/workspace/head', {});
  add('teachers/teacher/workspace/head/chunks/0', {payload: {stringValue: 'fixture-data'}});
  add('teachers/teacher/public/publicAvailability', {});
  add('teachers/other-admin/workspace/head', {});

  let failCommit = false;
  const fetcher = async (resource, options) => {
    const url = new URL(resource);
    if (url.hostname === 'www.googleapis.com') {
      return Response.json({keys: [{...publicKey.export({format:'jwk'}), alg:'RS256', kid:'fixture'}]});
    }
    if (url.hostname === 'oauth2.googleapis.com') {
      const jwt = options.body.get('assertion').split('.');
      const claims = JSON.parse(Buffer.from(jwt[1], 'base64url'));
      assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
      assert.ok(verify('RSA-SHA256', Buffer.from(jwt[0]+'.'+jwt[1]), publicKey, Buffer.from(jwt[2], 'base64url')));
      return Response.json({access_token: 'google-fixture'});
    }
    assert.equal(options.headers.Authorization, 'Bearer google-fixture');
    if (url.hostname === 'identitytoolkit.googleapis.com') {
      assert.ok(url.pathname.startsWith('/v1/projects/' + project + '/accounts:'));
      const body = JSON.parse(options.body);
      if (url.pathname.endsWith(':lookup')) {
        return Response.json({users: body.localId.map(uid => users.get(uid)).filter(Boolean)});
      }
      assert.ok(url.pathname.endsWith(':delete'));
      assert.equal(field('memberships/' + body.localId, 'status'), 'deleting');
      changes.push('delete-auth:' + body.localId);
      const existed = users.delete(body.localId);
      return existed ? Response.json({}) : Response.json({error:{message:'USER_NOT_FOUND'}}, {status:400});
    }
    assert.equal(url.hostname, 'firestore.googleapis.com');
    if (url.pathname.endsWith(':beginTransaction')) return Response.json({transaction: 'transaction'});
    if (url.pathname.endsWith(':batchGet')) {
      const body = JSON.parse(options.body);
      assert.equal(body.transaction, 'transaction');
      return Response.json(body.documents.map(name => {
        const found = documents.get(name.slice(database.length));
        return found ? {found} : {missing:name};
      }));
    }
    if (url.pathname.endsWith(':rollback')) return Response.json({});
    if (url.pathname.endsWith(':commit')) {
      const {writes, transaction} = JSON.parse(options.body);
      if (writes[0].update) assert.equal(transaction, 'transaction');
      if (writes[0].delete && failCommit) {
        failCommit = false;
        return Response.json({}, {status:503});
      }
      for (const write of writes) {
        const path = (write.update?.name || write.delete).slice(database.length);
        if (write.update) add(path, {...documents.get(path)?.fields, ...write.update.fields});
        else documents.delete(path);
        changes.push(path);
      }
      return Response.json({});
    }
    const path = decodeURIComponent(url.pathname).slice(4 + database.length);
    if (url.searchParams.has('pageSize')) {
      assert.ok(url.searchParams.has('mask.fieldPaths'));
      return Response.json({documents: [...documents.entries()].filter(([key]) =>
        key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(([,doc]) => ({name: doc.name}))});
    }
    return documents.has(path) ? Response.json(documents.get(path)) : new Response(null,{status:404});
  };
  const field = (path, key) => documents.get(path)?.fields[key]?.stringValue;
  const makeRequest = (route, options = {}) => {
    const path = route === 'list' ? 'teacher-emails' : 'delete-teacher';
    const request = new Request('https://worker.example/admin/' + path, {
      method: route === 'list' ? 'GET' : 'POST',
      headers: {Origin: options.origin || origin, Authorization: 'Bearer ' + (options.token ?? idToken),
        'Content-Type': 'application/json'},
      body: route === 'list' ? undefined : JSON.stringify(options.body || {uid: 'teacher', confirmUid: 'teacher'})
    });
    return handleAccountAdmin(request, env, fetcher);
  };
  return {makeRequest, idToken, changes, documents, users, field, failDataCommit: () => {failCommit = true;}};
}

test('a verified active admin can see verified emails for TutorFlow accounts only', async () => {
  const ctx = fixture();
  ctx.users.get('other-admin').emailVerified = false;
  const result = await ctx.makeRequest('list');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
  assert.deepEqual((await result.json()).teachers, [
    {uid:'admin',email:'admin@example.invalid'}, {uid:'teacher',email:'teacher@example.invalid'}
  ]);
  assert.deepEqual(ctx.changes, []);
  assert.equal((await fixture('ordinary','teacher').makeRequest('list')).status, 403);
});

test('reject unauthorized, revoked, cross-origin and protected account deletion', async () => {
  assert.equal((await fixture('ordinary','teacher').makeRequest('delete')).status, 403);
  assert.equal((await fixture('disabled-admin','admin','disabled').makeRequest('delete')).status, 403);
  const ctx = fixture();
  assert.equal((await ctx.makeRequest('delete',{token:'invalid'})).status, 401);
  assert.equal((await ctx.makeRequest('delete',{token:ctx.idToken.replace(/\.[^.]+$/, '.invalid')})).status, 401);
  assert.equal((await ctx.makeRequest('delete',{origin:'https://elsewhere.example'})).status, 403);
  for (const uid of ['admin','other-admin']) {
    assert.equal((await ctx.makeRequest('delete',{body:{uid,confirmUid:uid}})).status, 409);
  }
  assert.equal((await ctx.makeRequest('delete',{body:{uid:'teacher',confirmUid:'wrong'}})).status, 400);
  ctx.users.get('admin').validSince = String(Math.floor(Date.now()/1000));
  assert.equal((await ctx.makeRequest('delete')).status, 401);
  assert.deepEqual(ctx.changes, []);
});

test('delete one UID, resume after a partial failure and preserve other accounts', async () => {
  const ctx = fixture();
  ctx.failDataCommit();
  const partial = await ctx.makeRequest('delete');
  assert.equal(partial.status,503);
  assert.deepEqual(await partial.json(),{code:'delete-incomplete'});
  assert.equal(ctx.field('memberships/teacher','status'),'deleting');
  assert.equal(ctx.users.has('teacher'), false);
  assert.equal(ctx.documents.has('teachers/teacher/workspace/head/chunks/0'),true);
  assert.equal((await ctx.makeRequest('delete')).status,200);
  assert.equal((await ctx.makeRequest('delete')).status,200);
  assert.equal(ctx.documents.has('memberships/teacher'),false);
  assert.equal(ctx.documents.has('retiredTeacherAccounts/teacher'),true);
  assert.equal(ctx.documents.has('teachers/teacher/workspace/head'),false);
  assert.equal(ctx.documents.has('teachers/teacher/workspace/head/chunks/0'),false);
  assert.equal(ctx.documents.has('teachers/teacher/public/publicAvailability'),false);
  assert.equal(ctx.documents.has('teachers/other-admin/workspace/head'),true);
  assert.equal(ctx.users.has('other-admin'),true);
});
