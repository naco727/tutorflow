const assert = require('node:assert/strict');
const {test} = require('node:test');
const firebase = require('firebase/compat/app');
require('firebase/compat/auth');
require('firebase/compat/firestore');
const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const {doc, setDoc} = require('firebase/firestore');
const {empty, workspaceStore} = require('../tutorflow-cloud.js');
const availability = require('../tutorflow-availability.js');
const studentIndex = require('../tutorflow-student-index.js');

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
    const verifiedToken = await auth.currentUser.getIdTokenResult(true);
    assert.equal(verifiedToken.claims.email, email);
    await access.set({role: 'teacher', status: 'pending', email: verifiedToken.claims.email});
    assert.equal((await access.get({source: 'server'})).data().email, email);
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
    const draft = {
      ...empty(),
      students: [
        {id: 'demo', name: '甲乙', rate: 800},
        ...Array.from({length: 100}, (_, index) => ({id: 's-' + index, name: [2, 3].includes(index) ? '同名' : '學生 ' + index}))
      ],
      courses: [{id: 'c1', studentId: 'demo', date: '2099-01-01', start: '10:00', end: '11:00', status: 'completed'}]
    };
    const base = await first.write({text: JSON.stringify(draft), base: await first.load(), mutationId: 'demo-import', migrate: true});
    assert.deepEqual(JSON.parse((await second.load()).text), draft);
    const students = db.collection('teachers').doc(uid).collection('studentBindingIndex');
    const originalEntries = studentIndex.entries(draft.students);
    let batches = 0;
    const interruptedIndexDb = {
      collection: db.collection.bind(db),
      runTransaction: callback => {
        batches += 1;
        if (batches === 1) return db.runTransaction(callback);
        throw Object.assign(new Error('offline'), {code: 'unavailable'});
      }
    };
    await assert.rejects(studentIndex.reconcile(interruptedIndexDb, uid, base.revision, originalEntries), {code: 'unavailable'});
    assert.equal((await students.get({source: 'server'})).size, 100);
    assert.equal((await first.load()).text, base.text);
    assert.equal(await studentIndex.reconcile(db, uid, base.revision, originalEntries), 101);
    const indexSnapshot = await students.get({source: 'server'});
    assert.equal(indexSnapshot.size, 101);
    assert.deepEqual(indexSnapshot.docs.find(entry => entry.id === 'demo').data(), {name: '甲乙', active: true});
    assert.deepEqual(await first.load(), base);

    const {default: lineWorker, handleStudentLookup} = await import('../worker/tutorflow-worker.mjs');
    const emulatorToken = await auth.currentUser.getIdToken();
    const presentedToken = emulatorToken.endsWith('.') ? emulatorToken + 'fixture' : emulatorToken;
    const env = {TEACHER_UID: uid, FIREBASE_PROJECT_ID: projectId, FIREBASE_WEB_API_KEY: projectId};
    const fetcher = (input, options) => {
      const url = new URL(input);
      if (url.hostname === 'identitytoolkit.googleapis.com') {
        return fetch(origin + '/identitytoolkit.googleapis.com' + url.pathname + url.search, {
          ...options, body: JSON.stringify({idToken: emulatorToken})
        });
      }
      assert.equal(url.hostname, 'firestore.googleapis.com');
      return fetch('http://127.0.0.1:8080' + url.pathname + url.search, {
        ...options, headers: {...options.headers, Authorization: 'Bearer ' + emulatorToken}
      });
    };
    const lookup = (name, options = env, token = presentedToken) => handleStudentLookup(
      new Request('https://example.invalid/admin/student-lookup', {
        method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
        body: JSON.stringify({name})
      }), options, fetcher
    );
    assert.equal((await lineWorker.fetch(new Request('https://example.invalid/admin/student-lookup', {
      method: 'POST'
    }), env)).status, 401);
    assert.equal((await lookup('甲乙', env, '')).status, 401);
    assert.equal((await lookup('甲乙', {...env, TEACHER_UID: 'another-teacher'})).status, 403);
    assert.deepEqual(await (await lookup('甲乙')).json(), {status: 'matched', student: {id: 'demo', name: '甲乙'}});
    assert.deepEqual(await (await lookup('同名')).json(), {status: 'ambiguous'});

    const edited = {...draft, students: [
      {...draft.students[0], name: '甲丙'},
      {...draft.students[1], archived: true}, ...draft.students.slice(3), {id: 'new', name: '丁戊'}
    ]};
    const latest = await first.write({text: JSON.stringify(edited), base, mutationId: 'rename-and-archive'});
    assert.equal(await studentIndex.reconcile(db, uid, latest.revision, studentIndex.entries(edited.students)), 101);
    await assert.rejects(studentIndex.reconcile(db, uid, base.revision, originalEntries), {code: 'index-revision-changed'});
    assert.deepEqual((await students.doc('demo').get()).data(), {name: '甲丙', active: true});
    assert.deepEqual((await students.doc('s-0').get()).data(), {name: '學生 0', active: false});
    assert.equal((await students.doc('s-1').get()).exists, false);
    assert.deepEqual((await students.doc('new').get()).data(), {name: '丁戊', active: true});
    assert.deepEqual(await (await lookup('甲乙')).json(), {status: 'not-found'});
    assert.deepEqual(await (await lookup('甲丙')).json(), {status: 'matched', student: {id: 'demo', name: '甲丙'}});
    assert.deepEqual(await (await lookup('學生 0')).json(), {status: 'not-found'});
    assert.deepEqual(await first.load(), latest);
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
    const students = [{id:'fixture-student', name:'模擬學生'}];
    const created = await store.write({
      text: JSON.stringify({...empty(), students}),
      base: await store.load(), mutationId: 'teacher-deletion-fixture'
    });
    await studentIndex.reconcile(teacherDb, teacher.uid, created.revision, studentIndex.entries(students));
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
      assert.equal((await getDocs(collection(db, 'teachers/' + teacher.uid + '/studentBindingIndex'))).empty, true);
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
