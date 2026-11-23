const assert = require('node:assert/strict');
const {test} = require('node:test');
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/firestore');
const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const {doc, setDoc} = require('firebase/firestore');
const {empty, workspaceStore} = require('../tutorflow-cloud.js');
const availability = require('../tutorflow-availability.js');

const projectId = 'demo-tutorflow';
const origin = 'http://127.0.0.1:9099';
const authApi = `${origin}/emulator/v1/projects/${projectId}`;
const userApp = name => {
  const app = firebase.initializeApp({projectId, apiKey: 'demo-tutorflow', appId: 'demo-tutorflow'}, name);
  app.auth().useEmulator(origin, {disableWarnings: true});
  app.firestore().useEmulator('127.0.0.1', 8080);
  return app;
};
async function emulatorCodes(path) {
  const response = await fetch(authApi + '/' + path);
  assert.equal(response.ok, true);
  return response.json();
}

test('password registration, verification, reset, approval and two clients sharing one workspace', async () => {
  const app = userApp('email-a'), device = userApp('email-device');
  const auth = app.auth(), db = app.firestore();
  const email = 'tutorflow-emulator@example.invalid';
  const firstPassword = 'Demo-only-password1';
  const updatedPassword = 'Demo-only-password2';
  let fixture;
  try {
    await assert.rejects(device.auth().signInWithEmailAndPassword('never-registered@example.invalid', firstPassword),
      error => ['auth/user-not-found', 'auth/invalid-credential'].includes(error.code));
    const {user} = await auth.createUserWithEmailAndPassword(email, firstPassword);
    const uid = user.uid;
    await assert.rejects(device.auth().createUserWithEmailAndPassword(email.toUpperCase(), updatedPassword),
      {code: 'auth/email-already-in-use'});
    const access = db.collection('memberships').doc(uid);
    await assert.rejects(access.set({role: 'teacher', status: 'pending'}), {code: 'permission-denied'});
    await assert.rejects(workspaceStore(db, uid).load(), {code: 'permission-denied'});
    await user.sendEmailVerification();
    const verification = (await emulatorCodes('oobCodes')).oobCodes.find(item => item.email === email && item.requestType === 'VERIFY_EMAIL');
    assert.ok(verification);
    await auth.applyActionCode(verification.oobCode);
    await auth.currentUser.reload();
    assert.equal(auth.currentUser.emailVerified, true);
    await auth.currentUser.getIdToken(true);
    await access.set({role: 'teacher', status: 'pending'});
    await auth.sendPasswordResetEmail(email);
    const reset = (await emulatorCodes('oobCodes')).oobCodes.find(item => item.email === email && item.requestType === 'PASSWORD_RESET');
    assert.ok(reset);
    await auth.confirmPasswordReset(reset.oobCode, updatedPassword);
    await auth.signOut();
    await assert.rejects(auth.signInWithEmailAndPassword(email, firstPassword), error => ['auth/wrong-password', 'auth/invalid-credential'].includes(error.code));
    assert.equal((await auth.signInWithEmailAndPassword(email, updatedPassword)).user.uid, uid);
    assert.equal((await device.auth().signInWithEmailAndPassword(email, updatedPassword)).user.uid, uid);
    fixture = await initializeTestEnvironment({projectId});
    await fixture.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'memberships', uid), {role: 'teacher', status: 'active'}));

    const first = workspaceStore(db, uid), second = workspaceStore(device.firestore(), uid);
    const draft = {...empty(), students: [{id: 'demo', name: '模擬器學生'}]};
    await first.write({text: JSON.stringify(draft), base: await first.load(), mutationId: 'demo-import', migrate: true});
    assert.deepEqual(JSON.parse((await second.load()).text), draft);
    const slot = {date: '2099-01-01', start: '09:00', end: '10:00', status: 'available'};
    await availability.sync(db, uid, [slot]);
    const publicPath = availability.documentPath(uid);
    assert.deepEqual((await device.firestore().doc(publicPath).get()).data(), {slots: [slot]});
    await availability.sync(db, uid, []);
    assert.deepEqual((await device.firestore().doc(publicPath).get({source: 'server'})).data(), {slots: []});
    await auth.signOut();
    await assert.rejects(first.load(), {code: 'permission-denied'});
  } finally {
    await fixture?.cleanup();
    await Promise.all([app.delete(), device.delete()]);
  }
});

test('account Worker uses real emulated Auth and Firestore REST operations', async () => {
  const {generateKeyPairSync, sign} = require('node:crypto');
  const {handleAccountAdmin} = await import('../worker/account-admin.mjs');
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
  const env = {
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_ACCOUNT_ADMIN_SERVICE_ACCOUNT: JSON.stringify({
      type: 'service_account', project_id: projectId, private_key_id: 'emulator-only',
      client_email: 'emulator@example.invalid', private_key: privateKey.export({format: 'pem', type: 'pkcs8'})
    })
  };
  const actorApp = userApp('admin-worker'), teacherApp = userApp('teacher-worker');
  const actorEmail = 'worker-emulator-admin@example.invalid';
  const teacherEmail = 'worker-emulator-teacher@example.invalid';
  let fixture;

  async function emailSignIn(auth, email) {
    await auth.sendSignInLinkToEmail(email, {url: 'http://127.0.0.1:8765/', handleCodeInApp: true});
    const {oobCodes} = await emulatorCodes('oobCodes');
    const action = oobCodes.find(item => item.email === email && item.requestType === 'EMAIL_SIGNIN');
    return (await auth.signInWithEmailLink(email, action.oobLink)).user;
  }
  const fetcher = (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'www.googleapis.com') {
      return Promise.resolve(Response.json({keys: [{...publicKey.export({format:'jwk'}), alg:'RS256', kid:'emulator-only'}]}));
    }
    if (target.hostname === 'oauth2.googleapis.com') return Promise.resolve(Response.json({access_token: 'owner'}));
    if (target.hostname === 'identitytoolkit.googleapis.com') {
      return fetch(origin + '/identitytoolkit.googleapis.com' + target.pathname + target.search, options);
    }
    assert.equal(target.hostname, 'firestore.googleapis.com');
    return fetch('http://127.0.0.1:8080' + target.pathname + target.search, options);
  };

  try {
    const actor = await emailSignIn(actorApp.auth(), actorEmail);
    const teacher = await emailSignIn(teacherApp.auth(), teacherEmail);
    fixture = await initializeTestEnvironment({projectId});
    await fixture.withSecurityRulesDisabled(async context => {
      await setDoc(doc(context.firestore(), 'memberships', actor.uid), {role: 'admin', status: 'active'});
      await setDoc(doc(context.firestore(), 'memberships', teacher.uid), {role: 'teacher', status: 'active'});
    });
    const teacherDb = teacherApp.firestore(), store = workspaceStore(teacherDb, teacher.uid);
    await store.write({
      text: JSON.stringify({...empty(), students:[{id:'fixture-student', name:'模擬學生'}]}),
      base: await store.load(), mutationId: 'teacher-deletion-fixture'
    });
    await availability.sync(teacherDb, teacher.uid, [{date:'2099-01-01',start:'09:00',end:'10:00',status:'available'}]);
    // Auth Emulator provides unsigned claims. Sign them with the test key used by the Worker fixture.
    const [, payload] = (await actor.getIdToken()).split('.');
    const header = Buffer.from(JSON.stringify({alg:'RS256',kid:'emulator-only'})).toString('base64url');
    const unsigned = header + '.' + payload;
    const token = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
    const headers = {Origin:'https://naco727.github.io', Authorization:'Bearer '+token, 'Content-Type':'application/json'};
    const call = (path, options) => handleAccountAdmin(new Request('https://example.invalid/admin/' + path, {
      headers, ...options
    }), env, fetcher);

    const listed = await call('teacher-emails');
    assert.equal(listed.status, 200, JSON.stringify(await listed.clone().json()));
    assert.deepEqual((await listed.json()).teachers.find(item => item.uid === teacher.uid), {uid: teacher.uid, email: teacherEmail});
    const removed = await call('delete-teacher', {method:'POST', body:JSON.stringify({uid:teacher.uid, confirmUid:teacher.uid})});
    assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()));
    await assert.rejects(teacher.getIdToken(true), error =>
      ['auth/user-not-found', 'auth/invalid-refresh-token'].includes(error.code));
    const after = await call('teacher-emails');
    assert.equal(after.status, 200);
    assert.equal((await after.json()).teachers.some(item => item.uid === teacher.uid), false);
    await fixture.withSecurityRulesDisabled(async context => {
      const {getDoc, getDocs, collection} = require('firebase/firestore');
      const db = context.firestore();
      for (const path of ['memberships/' + teacher.uid, 'teachers/' + teacher.uid + '/workspace/head', availability.documentPath(teacher.uid)]) {
        assert.equal((await getDoc(doc(db, path))).exists(), false);
      }
      assert.equal((await getDocs(collection(db, 'teachers/' + teacher.uid + '/workspace/head/chunks'))).empty, true);
      assert.equal((await getDoc(doc(db, 'memberships/' + actor.uid))).exists(), true);
    });
  } finally {
    await fixture?.cleanup();
    await Promise.all([actorApp.delete(), teacherApp.delete()]);
  }
});

test('an existing passwordless admin can set a password and retain the same UID and role', async () => {
  const app = userApp('set-password'), device = userApp('set-password-device');
  const auth = app.auth(), otherAuth = device.auth(), db = device.firestore();
  const settings = {url: 'http://127.0.0.1:8765/', handleCodeInApp: true};
  const existingEmail = 'existing-link-admin@example.invalid';
  const password = 'Admin-password-set-on-migration7';
  let fixture;

  try {
    await auth.sendSignInLinkToEmail(existingEmail, settings);
    const {oobCodes} = await emulatorCodes('oobCodes');
    const link = oobCodes.find(item => item.email === existingEmail && item.requestType === 'EMAIL_SIGNIN');
    const {user: existing} = await auth.signInWithEmailLink(existingEmail, link.oobLink);
    assert.equal(existing.emailVerified, true);
    fixture = await initializeTestEnvironment({projectId});
    await fixture.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'memberships', existing.uid), {role: 'admin', status: 'active'}));
    await auth.signOut();

    await otherAuth.sendPasswordResetEmail(existingEmail, {url: settings.url});
    const reset = (await emulatorCodes('oobCodes')).oobCodes.find(item => item.email === existingEmail && item.requestType === 'PASSWORD_RESET');
    await otherAuth.confirmPasswordReset(reset.oobCode, password);
    const {user: admin} = await otherAuth.signInWithEmailAndPassword(existingEmail, password);
    assert.equal(admin.uid, existing.uid);
    assert.equal(admin.emailVerified, true);
    const token = await admin.getIdTokenResult();
    assert.equal(token.signInProvider, 'password');
    assert.equal(token.claims.email_verified, true);
    assert.equal((await db.collection('memberships').doc(existing.uid).get()).data().role, 'admin');
    assert.equal((await db.collection('memberships').get()).empty, false);
    await workspaceStore(db, existing.uid).load();
  } finally {
    await fixture?.cleanup();
    await Promise.all([app.delete(), device.delete()]);
  }
});
