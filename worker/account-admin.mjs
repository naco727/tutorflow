const oauthUrl = 'https://oauth2.googleapis.com/token';
const firebaseKeys = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const retiredTestUid = 'a8HEV8D9IkdAVxu2z3KssWCk0oc2';
const encoder = new TextEncoder();
const validUid = uid => typeof uid === 'string' &&
  /^[A-Za-z0-9_.-]{1,128}$/.test(uid) && !/^(?:\.{1,2}|__.*__)$/.test(uid);

class RequestError extends Error {
  constructor(code, status) {
    super(code);
    this.status = status;
  }
}

const failure = (code, status) => new RequestError(code, status);
const base64url = bytes => btoa(String.fromCharCode(...bytes))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwtPart = data => base64url(encoder.encode(JSON.stringify(data)));
const jwtBytes = part => Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const jwtJson = part => JSON.parse(new TextDecoder().decode(jwtBytes(part)));
const rsa = {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'};

async function googleToken(env, project, fetcher) {
  let account;
  try {
    account = JSON.parse(env.FIREBASE_ACCOUNT_ADMIN_SERVICE_ACCOUNT);
    if (account.type !== 'service_account' || account.project_id !== project ||
        !account.client_email || !account.private_key_id || !account.private_key) throw Error();
  } catch {
    throw failure('not-configured', 503);
  }
  const keyBytes = Uint8Array.from(atob(account.private_key
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes, rsa, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = jwtPart({alg: 'RS256', typ: 'JWT', kid: account.private_key_id}) + '.' + jwtPart({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: oauthUrl,
    iat: now,
    exp: now + 300
  });
  const signature = await crypto.subtle.sign(rsa.name, key, encoder.encode(unsigned));
  const response = await fetcher(oauthUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + base64url(new Uint8Array(signature))
    })
  });
  if (!response.ok) throw failure('not-configured', 503);
  const {access_token: token} = await response.json();
  if (typeof token !== 'string' || !token) throw failure('not-configured', 503);
  return token;
}

async function verifyCallerToken(token, project, fetcher) {
  let decoded, claims, parts;
  try {
    const [header, payload, signature, extra] = (token || '').split('.');
    if (!header || !payload || !signature || extra !== undefined || token.length > 8192) throw Error();
    parts = [header, payload, signature];
    decoded = jwtJson(header);
    claims = jwtJson(payload);
    const now = Math.floor(Date.now() / 1000);
    if (decoded.alg !== 'RS256' || typeof decoded.kid !== 'string' || !decoded.kid ||
        claims.iss !== 'https://securetoken.google.com/' + project || claims.aud !== project ||
        !validUid(claims.sub) || claims.sub === retiredTestUid || !Number.isInteger(claims.exp) || claims.exp <= now ||
        !Number.isInteger(claims.iat) || claims.iat > now ||
        !Number.isInteger(claims.auth_time) || claims.auth_time <= 0 || claims.auth_time > claims.iat ||
        claims.email_verified !== true || claims.firebase?.sign_in_provider !== 'password' ||
        claims.firebase.tenant) throw Error();
  } catch {
    throw failure('unauthenticated', 401);
  }
  const response = await fetcher(firebaseKeys, {signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw failure('backend-unavailable', 503);
  const {keys} = await response.json();
  const jwk = keys?.find(key => key.kid === decoded.kid && key.kty === 'RSA' && key.alg === 'RS256');
  if (!jwk) throw failure('unauthenticated', 401);
  const key = await crypto.subtle.importKey('jwk', jwk, rsa, false, ['verify']);
  const [header, payload, signature] = parts;
  const verified = await crypto.subtle.verify(rsa.name, key, jwtBytes(signature), encoder.encode(header + '.' + payload));
  if (!verified) throw failure('unauthenticated', 401);
  return claims;
}

function googleApi(project, accessToken, fetcher) {
  const encodedProject = encodeURIComponent(project);
  const identity = 'https://identitytoolkit.googleapis.com/v1/projects/' + encodedProject + '/accounts:';
  const database = 'projects/' + project + '/databases/(default)';
  const firestore = 'https://firestore.googleapis.com/v1/' + database + '/documents';
  const name = path => database + '/documents/' + path;
  const headers = {Authorization: 'Bearer ' + accessToken};
  const get = url => fetcher(url, {headers, cache: 'no-store', signal: AbortSignal.timeout(10000)});
  const post = (url, body) => fetcher(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {...headers, 'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });

  return {
    name,
    async checkCallerStatus(claims) {
      const response = await post(identity + 'lookup', {localId: [claims.sub]});
      if (!response.ok) throw failure('backend-unavailable', 503);
      const {users} = await response.json();
      const user = users?.[0];
      const validSince = Number(user?.validSince ?? 0);
      if (users?.length !== 1 || user.localId !== claims.sub || user.disabled || user.tenantId ||
          user.emailVerified !== true || !Number.isSafeInteger(validSince) || claims.auth_time < validSince) {
        throw failure('unauthenticated', 401);
      }
    },

    async document(path) {
      const response = await get(firestore + '/' + path);
      if (response.status === 404) return null;
      if (!response.ok) throw failure('backend-unavailable', 503);
      return response.json();
    },

    async documents(paths, transaction) {
      const response = await post(firestore + ':batchGet', {documents: paths.map(name), transaction});
      if (!response.ok) throw failure('backend-unavailable', 503);
      const result = await response.json();
      const found = new Map(result.filter(item => item.found).map(item => [item.found.name, item.found]));
      return paths.map(path => found.get(name(path)) || null);
    },

    async begin() {
      const response = await post(firestore + ':beginTransaction', {options: {readWrite: {}}});
      if (!response.ok) throw failure('backend-unavailable', 503);
      return (await response.json()).transaction;
    },

    async rollback(transaction) {
      await post(firestore + ':rollback', {transaction});
    },

    async commit(writes, transaction) {
      const response = await post(firestore + ':commit', {writes, transaction});
      if (response.ok) return;
      const data = await response.json().catch(() => ({}));
      if (['ABORTED', 'FAILED_PRECONDITION', 'ALREADY_EXISTS', 'NOT_FOUND'].includes(data.error?.status)) {
        throw failure('concurrent-change', 409);
      }
      throw failure('backend-unavailable', 503);
    },

    async deleteAuth(uid) {
      const response = await post(identity + 'delete', {localId: uid});
      if (response.ok) return;
      const data = await response.json().catch(() => ({}));
      if (data.error?.message === 'USER_NOT_FOUND') return;
      throw failure('backend-unavailable', 503);
    },

    async collectionNames(path, firstPageOnly = false) {
      const prefix = name(path) + '/';
      const names = [];
      let nextPageToken;
      do {
        // Skip reading student payloads. The document names alone are enough to delete them.
        const url = new URL(firestore + '/' + path);
        url.searchParams.set('pageSize', '100');
        url.searchParams.set('mask.fieldPaths', 'deletionMarker');
        if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);
        const response = await get(url);
        if (!response.ok) throw failure('backend-unavailable', 503);
        const page = await response.json();
        for (const document of page.documents || []) {
          if (!document.name.startsWith(prefix) || !/^[^/]+$/.test(document.name.slice(prefix.length))) {
            throw failure('backend-unavailable', 503);
          }
          names.push(document.name);
        }
        nextPageToken = page.nextPageToken;
        if (path !== 'memberships' && names.length > 400) throw failure('backend-unavailable', 503);
      } while (nextPageToken && !firstPageOnly);
      return names;
    },

    async accountEmails(uids) {
      const result = [];
      for (let index = 0; index < uids.length; index += 100) {
        const response = await post(identity + 'lookup', {localId: uids.slice(index, index + 100)});
        if (!response.ok) throw failure('backend-unavailable', 503);
        const {users} = await response.json();
        for (const user of users || []) {
          if (typeof user.email === 'string' && user.emailVerified === true) {
            result.push({uid: user.localId, email: user.email});
          }
        }
      }
      return result;
    }
  };
}

const field = (doc, key) => doc?.fields?.[key]?.stringValue;
const version = doc => ({updateTime: doc.updateTime});

function requireAdmin(document) {
  if (field(document, 'role') !== 'admin' || field(document, 'status') !== 'active') {
    throw failure('forbidden', 403);
  }
}

async function deleteTeacher(api, actorUid, targetUid) {
  const actorPath = 'memberships/' + actorUid;
  const targetPath = 'memberships/' + targetUid;
  const markerPath = 'retiredTeacherAccounts/' + targetUid;
  const transaction = await api.begin();
  let committed = false;
  try {
    const [actor, target, marker] = await api.documents([actorPath, targetPath, markerPath], transaction);
    requireAdmin(actor);
    if (actorUid === targetUid) throw failure('protected-account', 409);
    if (!target && marker) return;
    if (!target) throw failure('teacher-not-found', 404);
    if (field(target, 'role') !== 'teacher') throw failure('protected-account', 409);

    const status = field(target, 'status');
    if (status === 'deleting') {
      if (!marker) throw failure('concurrent-change', 409);
    } else {
      if (marker || !['active', 'pending', 'disabled'].includes(status)) throw failure('concurrent-change', 409);
      await api.commit([
        {
          update: {name: api.name(targetPath), fields: {status: {stringValue: 'deleting'}}},
          updateMask: {fieldPaths: ['status']},
          currentDocument: version(target)
        },
        {update: {name: api.name(markerPath), fields: {retired: {booleanValue: true}}}, currentDocument: {exists: false}}
      ], transaction);
      committed = true;
    }
  } finally {
    if (!committed) await api.rollback(transaction).catch(() => {});
  }

  // Only the deletion job can continue after the marker is set, even if Auth has already been deleted.
  try {
    const locked = await api.document(targetPath);
    if (!locked && await api.document(markerPath)) return;
    if (field(locked, 'role') !== 'teacher' || field(locked, 'status') !== 'deleting') {
      throw failure('concurrent-change', 409);
    }
    const chunks = await api.collectionNames('teachers/' + targetUid + '/workspace/head/chunks');
    await api.deleteAuth(targetUid);
    const indexPath = 'teachers/' + targetUid + '/studentBindingIndex';
    for (let entries = await api.collectionNames(indexPath, true); entries.length;
      entries = await api.collectionNames(indexPath, true)) {
      await api.commit(entries.map(name => ({delete: name})));
    }
    await api.commit([
      ...chunks.map(name => ({delete: name})),
      ...[
        'teachers/' + targetUid + '/workspace/head',
        'teachers/' + targetUid + '/public/publicAvailability',
        'teachers/' + targetUid
      ].map(path => ({delete: api.name(path)})),
      {delete: api.name(targetPath), currentDocument: version(locked)}
    ]);
  } catch {
    throw failure('delete-incomplete', 503);
  }
}

async function requestBody(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    throw failure('invalid-request', 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw failure('invalid-request', 400);
  const decoder = new TextDecoder();
  let body = '', size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1024) {
      await reader.cancel();
      throw failure('invalid-request', 400);
    }
    body += decoder.decode(value, {stream: true});
  }
  try {
    return JSON.parse(body + decoder.decode());
  } catch {
    throw failure('invalid-request', 400);
  }
}

export async function handleAccountAdmin(request, env, fetcher = fetch) {
  const origin = request.headers.get('Origin');
  const allowedOrigin = env.TUTORFLOW_ADMIN_ORIGIN || 'https://naco727.github.io';
  const headers = {'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff'};
  if (origin === allowedOrigin) headers['Access-Control-Allow-Origin'] = origin;
  const reply = (body, status) => Response.json(body, {status, headers});

  const path = new URL(request.url).pathname;
  const deleting = path === '/admin/delete-teacher';
  const listing = path === '/admin/teacher-emails';
  if (!deleting && !listing) return reply({code: 'not-found'}, 404);
  if (origin !== allowedOrigin) return reply({code: 'forbidden'}, 403);
  if (request.method === 'OPTIONS') {
    return new Response(null, {status: 204, headers: {
      ...headers,
      'Access-Control-Allow-Methods': deleting ? 'POST, OPTIONS' : 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600'
    }});
  }
  if (request.method !== (deleting ? 'POST' : 'GET')) return reply({code: 'method-not-allowed'}, 405);

  try {
    const project = env.FIREBASE_PROJECT_ID || 'turtorflow';
    if (!/^[a-z][a-z0-9-]{4,29}$/.test(project)) throw failure('not-configured', 503);
    const idToken = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9._-]+)$/i)?.[1];
    const body = deleting ? await requestBody(request) : null;
    if (deleting && (!validUid(body?.uid) || body.confirmUid !== body.uid)) throw failure('invalid-request', 400);
    const claims = await verifyCallerToken(idToken, project, fetcher);
    const api = googleApi(project, await googleToken(env, project, fetcher), fetcher);
    await api.checkCallerStatus(claims);
    if (listing) {
      requireAdmin(await api.document('memberships/' + claims.sub));
      const uids = (await api.collectionNames('memberships')).map(name => name.split('/').at(-1));
      return reply({teachers: await api.accountEmails(uids)}, 200);
    }
    await deleteTeacher(api, claims.sub, body.uid);
    return reply({deleted: true}, 200);
  } catch (error) {
    if (error instanceof RequestError) return reply({code: error.message}, error.status);
    return reply({code: 'backend-unavailable'}, 503);
  }
}

export default {fetch: (request, env) => handleAccountAdmin(request, env)};
