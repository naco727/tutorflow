import assert from 'node:assert/strict';
import {createHmac, generateKeyPairSync} from 'node:crypto';
import {test} from 'node:test';
import {Script} from 'node:vm';
import cloud from '../tutorflow-cloud.js';
import worker from '../worker/tutorflow-worker.mjs';

const origin = 'https://worker.example.invalid';
const key = 'fixture-monthly-admin-key-only-for-test';
const teacher = 'teacher-primary';
const project = 'demo-tutorflow';
const headName = 'projects/' + project + '/databases/(default)/documents/teachers/' + teacher + '/workspace/head';
const env = {MONTHLY_ADMIN_KEY: key, TUTORFLOW_TEACHER_UID: teacher, FIREBASE_PROJECT_ID: project};
const makeRequest = (path, options) => new Request(origin + path, options);

test('monthly page is a private-data-free shell and requests require a separate key', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unauthorized requests cannot access Firebase'));
  const page = await worker.fetch(makeRequest('/admin/monthly'), env);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  const html = await page.text();
  assert.ok(!html.includes(key));
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(script);
  assert.ok(page.headers.get('Content-Security-Policy').includes("'nonce-" + script[1] + "'"));
  assert.doesNotThrow(() => new Script(script[2]));
  assert.equal((await worker.fetch(makeRequest('/admin/monthly-students'), env)).status, 403);
  assert.equal((await worker.fetch(makeRequest('/admin/monthly-preview', {
    method: 'POST', headers: {Authorization: 'Bearer rich-menu-key'}
  }), {...env, RICHMENU_ADMIN_KEY: 'rich-menu-key'})).status, 403);
  assert.equal((await worker.fetch(makeRequest('/admin/monthly-students', {
    headers: {Authorization: 'Bearer ' + key}
  }), {...env, RICHMENU_ADMIN_KEY: key})).status, 503);
  assert.equal((await worker.fetch(makeRequest('/admin/monthly-students', {
    headers: {Authorization: 'Bearer ' + key, Origin: 'https://elsewhere.example.invalid'}
  }), env)).status, 403);
});

test('monthly preview reads a configured teacher only and sends narrowed, read-only results', async t => {
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const configured = {...env, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
    client_email: 'service@example.invalid', project_id: project, private_key: privateKey.export({format: 'pem', type: 'pkcs8'})
  })};
  const finished = {id: 'c1', studentId: 's1', date: '2026-12-04', start: '10:00', end: '11:30',
    rateSnapshot: 800, status: 'completed', paid: true, memo: 'excluded memo'};
  const scheduled = {...finished, id: 'c2', date: '2026-12-12', status: 'scheduled'};
  const workspace = {
    students: [{id: 's1', name: '學生甲', phone: 'excluded phone', rate: 3400}, {id: 's2', name: '學生乙'}],
    courses: [finished, scheduled, {...finished, id: 'cancelled', status: 'cancelled'},
      {...finished, id: 'other', studentId: 's2'}],
    notes: [{note: 'excluded notes'}]
  };
  const chunks = cloud.encode(JSON.stringify(workspace));
  let firestoreCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'oauth2.googleapis.com') {
      assert.equal(options.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      return Response.json({access_token: 'fixture-google-token', expires_in: 3600});
    }
    assert.equal(url.hostname, 'firestore.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer fixture-google-token');
    firestoreCalls++;
    if (url.pathname.endsWith(':runQuery')) {
      assert.ok(url.pathname.endsWith('/teachers/' + teacher + ':runQuery'));
      assert.deepEqual(JSON.parse(options.body).structuredQuery.select.fields, [{fieldPath: 'name'}]);
      return Response.json([{document: {name: headName.replace('/workspace/head', '/studentBindingIndex/s1'),
        fields: {name: {stringValue: '學生甲'}}}}]);
    }
    assert.ok(url.pathname.endsWith('/documents:batchGet'));
    const {documents} = JSON.parse(options.body);
    return Response.json(documents.map(name => {
      if (name === headName) return {found: {name, updateTime: '2026-12-01T00:00:00Z', fields: {
        version: {integerValue: '1'}, revision: {integerValue: '10'}, chunkCount: {integerValue: String(chunks.length)},
        mutationId: {stringValue: 'fixture'}
      }}};
      assert.ok(name.startsWith(headName + '/chunks/'));
      return {found: {name, fields: {payload: {stringValue: chunks[Number(name.split('/').at(-1))]}}}};
    }).reverse());
  });
  const headers = {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Origin: origin};
  const list = await worker.fetch(makeRequest('/admin/monthly-students', {headers}), configured);
  assert.deepEqual(await list.json(), {students: [{id: 's1', name: '學生甲'}]});
  const preview = await worker.fetch(makeRequest('/admin/monthly-preview', {
    method: 'POST', headers, body: JSON.stringify({studentId: 's1', month: '2026-12', teacherUid: 'ignored-other-teacher'})
  }), configured);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('Cache-Control'), 'no-store');
  const text = await preview.text();
  assert.doesNotMatch(text, /excluded|學生乙|3400|payload|fixture-google-token/);
  const result = JSON.parse(text);
  assert.equal(result.revision, 10);
  assert.deepEqual(result.rows.map(row => row.id), ['c1', 'c2']);
  assert.deepEqual(result.totals, {completedHours: 1.5, due: 1200, paid: 1200, unpaid: 0,
    scheduledHours: 1.5, scheduledEstimate: 1200});
  assert.equal(firestoreCalls, 4);
});

test('signed LINE binding postback still opens the existing KV name flow', async t => {
  const pending = [];
  const kv = new Map();
  const lineSecret = 'line-test-secret';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.line.me/v2/bot/message/reply');
    const {messages, replyToken} = JSON.parse(options.body);
    assert.equal(replyToken, 'fixture-reply');
    assert.match(messages[0].text, /月結課程綁定/);
    return new Response(null, {status: 200});
  });
  const body = JSON.stringify({events: [{type: 'postback', source: {type: 'user', userId: 'user-test'},
    replyToken: 'fixture-reply', postback: {data: 'bind_monthly_student'}}]});
  const response = await worker.fetch(makeRequest('/', {
    method: 'POST', body, headers: {'x-line-signature': createHmac('sha256', lineSecret).update(body).digest('base64')}
  }), {
    ...env, LINE_CHANNEL_SECRET: lineSecret, LINE_CHANNEL_ACCESS_TOKEN: 'line-test-token',
    FIREBASE_SERVICE_ACCOUNT: 'valid-presence-for-this-route', MONTHLY_BINDINGS: {
      get: async () => null,
      put: async (id, value, options) => {
        assert.equal(options.expirationTtl, 600);
        kv.set(id, JSON.parse(value));
      }
    }
  }, {waitUntil: job => pending.push(job)});
  assert.equal(response.status, 200);
  await Promise.all(pending);
  assert.equal(kv.get('monthly:state:' + teacher + ':user-test').action, 'awaiting_student_name');
});
