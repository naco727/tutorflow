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

test('SMS emulator rejects incorrect codes and resolves the same phone to the same UID', async () => {
  // The browser SDK implements the reCAPTCHA widget. Use Auth REST only against the local emulator here.
  const phoneNumber = '+886900000101';
  const authRequest = (operation, data) => fetch(origin + '/identitytoolkit.googleapis.com/v1/accounts:' + operation + '?key=demo-tutorflow', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(data)
  });
  let firstUid;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = await authRequest('sendVerificationCode', {phoneNumber});
    assert.equal(sent.ok, true);
    const {sessionInfo} = await sent.json();
    const {verificationCodes} = await emulatorCodes('verificationCodes');
    const code = verificationCodes.find(item => item.phoneNumber === phoneNumber && item.sessionInfo === sessionInfo)?.code;
    assert.match(code, /^\d{6}$/);
    const incorrect = await authRequest('signInWithPhoneNumber', {sessionInfo, code: code === '111111' ? '222222' : '111111'});
    assert.equal(incorrect.status, 400);
    assert.match((await incorrect.json()).error.message, /INVALID_CODE/);
    const confirmed = await authRequest('signInWithPhoneNumber', {sessionInfo, code});
    assert.equal(confirmed.ok, true);
    const {localId, idToken} = await confirmed.json();
    assert.ok(localId);
    if (firstUid) assert.equal(localId, firstUid);
    firstUid = localId;
    const lookup = await authRequest('lookup', {idToken});
    assert.equal((await lookup.json()).users[0].phoneNumber, phoneNumber);
  }
});

test('password registration, verification, reset, approval and two clients sharing one workspace', async () => {
  const app = userApp('email-a'), device = userApp('email-device');
  const auth = app.auth(), db = app.firestore();
  const email = 'tutorflow-emulator@example.invalid';
  const firstPassword = 'Demo-only-password1';
  const updatedPassword = 'Demo-only-password2';
  let fixture;
  try {
    const {user} = await auth.createUserWithEmailAndPassword(email, firstPassword);
    const uid = user.uid;
    const access = db.collection('memberships').doc(uid);
    await access.set({role: 'teacher', status: 'pending'});
    await assert.rejects(workspaceStore(db, uid).load(), {code: 'permission-denied'});
    await user.sendEmailVerification();
    const verification = (await emulatorCodes('oobCodes')).oobCodes.find(item => item.email === email && item.requestType === 'VERIFY_EMAIL');
    assert.ok(verification);
    await auth.applyActionCode(verification.oobCode);
    await auth.currentUser.reload();
    assert.equal(auth.currentUser.emailVerified, true);
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
