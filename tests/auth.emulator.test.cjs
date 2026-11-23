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
    const {user} = await auth.createUserWithEmailAndPassword(email, firstPassword);
    const uid = user.uid;
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

test('email sign-in links verify the email, reuse an existing UID and enforce membership', async () => {
  const app = userApp('email-link'), device = userApp('email-link-device');
  const auth = app.auth(), otherAuth = device.auth(), db = app.firestore();
  const settings = {url: 'http://127.0.0.1:8765/', handleCodeInApp: true};
  const existingEmail = 'existing-link-admin@example.invalid';
  const newEmail = 'new-link-teacher@example.invalid';
  let fixture;

  async function linkFor(email) {
    await auth.sendSignInLinkToEmail(email, settings);
    const {oobCodes} = await emulatorCodes('oobCodes');
    const link = oobCodes.find(item => item.email === email && item.requestType === 'EMAIL_SIGNIN')?.oobLink;
    assert.ok(link);
    assert.equal(otherAuth.isSignInWithEmailLink(link), true);
    return link;
  }

  try {
    const {user: existing} = await auth.createUserWithEmailAndPassword(existingEmail, 'Emulator-only-password1');
    const originalUid = existing.uid;
    fixture = await initializeTestEnvironment({projectId});
    await fixture.withSecurityRulesDisabled(context => setDoc(doc(context.firestore(), 'memberships', originalUid), {role: 'admin', status: 'active'}));
    await auth.signOut();

    const adminLink = await linkFor(existingEmail);
    const {user: admin} = await auth.signInWithEmailLink(existingEmail, adminLink);
    assert.equal(admin.uid, originalUid);
    assert.equal(admin.emailVerified, true);
    const token = await admin.getIdTokenResult();
    assert.equal(token.signInProvider, 'password');
    assert.equal(token.claims.email_verified, true);
    assert.equal((await db.collection('memberships').doc(originalUid).get()).data().role, 'admin');
    assert.equal((await db.collection('memberships').get()).empty, false);
    await workspaceStore(db, originalUid).load();
    await assert.rejects(otherAuth.signInWithEmailLink(existingEmail, adminLink), {code: 'auth/invalid-action-code'});

    const teacherLink = await linkFor(newEmail);
    await assert.rejects(otherAuth.signInWithEmailLink('wrong-email@example.invalid', teacherLink));
    const {user: teacher} = await otherAuth.signInWithEmailLink(newEmail, teacherLink);
    assert.equal(teacher.emailVerified, true);
    const teacherDb = device.firestore();
    await teacherDb.collection('memberships').doc(teacher.uid).set({role: 'teacher', status: 'pending'});
    await assert.rejects(workspaceStore(teacherDb, teacher.uid).load(), {code: 'permission-denied'});
    await assert.rejects(workspaceStore(teacherDb, originalUid).load(), {code: 'permission-denied'});
  } finally {
    await fixture?.cleanup();
    await Promise.all([app.delete(), device.delete()]);
  }
});
