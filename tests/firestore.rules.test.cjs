const {before, after, test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {initializeTestEnvironment, assertSucceeds, assertFails} = require('@firebase/rules-unit-testing');
const {doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch} = require('firebase/firestore');

let fixture;
const projectId = 'demo-tutorflow';
const legacy = 'a8HEV8D9IkdAVxu2z3KssWCk0oc2';
const membership = uid => `memberships/${uid}`;
const head = uid => `teachers/${uid}/workspace/head`;
const chunk = (uid, index = 0) => `${head(uid)}/chunks/${index}`;
const publicSlot = 'publicAvailability/2099-01-01_0900';
const slot = {date: '2099-01-01', start: '09:00', end: '10:00', status: 'available'};
const metadata = (revision = 1, chunkCount = 1) => ({version: 1, revision, chunkCount, migrated: false, mutationId: `action-${revision}`});
const as = (uid, provider = 'password', verified = true) => fixture.authenticatedContext(uid, {
  email: `${uid}@example.invalid`, email_verified: verified, firebase: {sign_in_provider: provider}
}).firestore();

before(async () => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Tests require an emulator, never production.');
  fixture = await initializeTestEnvironment({projectId, firestore: {rules: fs.readFileSync('firestore.rules', 'utf8')}});
  await fixture.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [uid, role, status] of [
      ['teacher-a', 'teacher', 'active'], ['teacher-b', 'teacher', 'active'], ['pending', 'teacher', 'pending'],
      ['disabled', 'teacher', 'disabled'], ['admin', 'admin', 'active'], [legacy, 'teacher', 'active'],
      ['bulk', 'teacher', 'active']
    ]) await setDoc(doc(db, membership(uid)), {role, status});
    await setDoc(doc(db, publicSlot), slot);
  });
});
after(async () => { await fixture?.cleanup(); });

test('A and B can write and read their own data only, including payment and note chunks', async () => {
  for (const uid of ['teacher-a', 'teacher-b']) {
    const db = as(uid), batch = writeBatch(db);
    batch.set(doc(db, head(uid)), metadata());
    batch.set(doc(db, chunk(uid)), {payload: 'example-data'});
    await assertSucceeds(batch.commit());
    await assertSucceeds(getDoc(doc(db, head(uid))));
    await assertSucceeds(getDoc(doc(db, chunk(uid))));
  }
  await assertFails(getDoc(doc(as('teacher-a'), head('teacher-b'))));
  await assertFails(getDocs(collection(as('teacher-a'), head('teacher-b') + '/chunks')));
  await assertFails(setDoc(doc(as('teacher-b'), head('teacher-a')), metadata(2)));
  await assertFails(getDoc(doc(as('admin'), chunk('teacher-a'))));
  await assertFails(getDoc(doc(fixture.unauthenticatedContext().firestore(), head('teacher-a'))));
  await assertFails(setDoc(doc(as('teacher-a'), chunk('teacher-a')), {payload: 'unversioned'}));
});

test('approval is server enforced and phone or unverified accounts are denied', async () => {
  for (const uid of ['pending', 'disabled', legacy]) {
    await assertFails(getDoc(doc(as(uid), head(uid))));
    await assertFails(setDoc(doc(as(uid), head(uid)), metadata()));
  }
  await assertFails(getDoc(doc(as('teacher-a', 'password', false), head('teacher-a'))));
  await assertSucceeds(getDoc(doc(as('teacher-a', 'password', true), head('teacher-a'))));
  const phone = as('teacher-a', 'phone', true);
  await assertFails(getDoc(doc(phone, membership('teacher-a'))));
  await assertFails(getDoc(doc(phone, head('teacher-a'))));
  await assertFails(setDoc(doc(phone, 'teachers/teacher-a/public/publicAvailability'), {slots: []}));
  await assertFails(getDoc(doc(as('teacher-a', 'google.com', true), head('teacher-a'))));
});

test('teachers cannot promote themselves or tamper with approvals, admin can approve teachers only', async () => {
  const teacher = as('pending'), admin = as('admin'), newcomer = as('new');
  await assertFails(setDoc(doc(newcomer, membership('new')), {role: 'admin', status: 'active'}));
  await assertSucceeds(setDoc(doc(newcomer, membership('new')), {role: 'teacher', status: 'pending'}));
  await assertFails(updateDoc(doc(teacher, membership('pending')), {role: 'admin', status: 'active'}));
  await assertFails(updateDoc(doc(teacher, membership('pending')), {status: 'active'}));
  await assertFails(getDocs(collection(teacher, 'memberships')));
  await assertSucceeds(getDocs(collection(admin, 'memberships')));
  await assertFails(updateDoc(doc(admin, membership('pending')), {role: 'admin'}));
  await assertFails(updateDoc(doc(admin, membership('pending')), {status: 'active', legacyImport: true}));
  await assertSucceeds(updateDoc(doc(admin, membership('pending')), {status: 'active'}));
  await assertSucceeds(getDoc(doc(teacher, head('pending'))));
  await assertSucceeds(updateDoc(doc(admin, membership('pending')), {status: 'disabled'}));
  await assertFails(getDoc(doc(teacher, head('pending'))));
});

test('verified membership email is private and can only match the account token', async () => {
  const uid = 'email-applicant', admin = as('admin'), teacher = as(uid);
  const path = membership(uid), email = uid + '@example.invalid';
  const application = {role: 'teacher', status: 'pending'};
  await assertFails(setDoc(doc(teacher, path), {...application, email: 'someone-else@example.invalid'}));
  await assertFails(setDoc(doc(as(uid, 'password', false), path), {...application, email}));
  await assertSucceeds(setDoc(doc(teacher, path), {...application, email}));
  assert.equal((await assertSucceeds(getDoc(doc(admin, path)))).data().email, email);
  await assertFails(getDoc(doc(as('teacher-a'), path)));
  await assertFails(getDoc(doc(fixture.unauthenticatedContext().firestore(), path)));
  await assertFails(updateDoc(doc(admin, path), {email: 'wrong@example.invalid'}));
  await assertFails(updateDoc(doc(teacher, path), {email, status: 'active'}));
  await assertFails(deleteDoc(doc(admin, path)));
  await assertSucceeds(updateDoc(doc(admin, path), {status: 'active'}));
  await assertSucceeds(updateDoc(doc(as('teacher-b'), membership('teacher-b')), {email: 'teacher-b@example.invalid'}));
  await assertSucceeds(updateDoc(doc(admin, membership('admin')), {email: 'admin@example.invalid'}));
});

test('full 32-chunk migration stays within Firestore Rules call limits', async () => {
  const db = as('bulk'), batch = writeBatch(db);
  batch.set(doc(db, head('bulk')), {...metadata(1, 32), migrated: true});
  for (let index = 0; index < 32; index++) batch.set(doc(db, chunk('bulk', index)), {payload: 'sample'});
  await assertSucceeds(batch.commit());
});

test('each approved teacher can update exactly one public document for their UID', async () => {
  const guest = fixture.unauthenticatedContext().firestore(), teacher = as('teacher-a'), other = as('teacher-b');
  const path = 'teachers/teacher-a/public/publicAvailability';
  const secondPath = 'teachers/teacher-b/public/publicAvailability';
  await assertSucceeds(setDoc(doc(teacher, path), {slots: [slot]}));
  await assertSucceeds(setDoc(doc(other, secondPath), {slots: []}));
  await assertSucceeds(getDoc(doc(guest, path)));
  await assertSucceeds(getDoc(doc(other, path)));
  await assertFails(getDocs(collection(guest, 'teachers/teacher-a/public')));
  await assertFails(getDoc(doc(guest, 'teachers/teacher-a/public/somethingElse')));
  await assertFails(setDoc(doc(teacher, path + '/slots/0800'), slot));
  await assertFails(updateDoc(doc(other, path), {slots: []}));
  await assertFails(updateDoc(doc(as('admin'), path), {slots: []}));
  await assertFails(setDoc(doc(as('disabled'), 'teachers/disabled/public/publicAvailability'), {slots: []}));
  await assertFails(setDoc(doc(teacher, path), {slots: [], studentName: 'private'}));
  await assertFails(setDoc(doc(teacher, path), {slots: {name: 'bad'}}));
  await assertFails(deleteDoc(doc(teacher, path)));
  assert.deepEqual((await getDoc(doc(guest, path))).data(), {slots: [slot]});
});

test('old root availability and bridge are inaccessible to app clients', async () => {
  const guest = fixture.unauthenticatedContext().firestore(), teacher = as('teacher-a');
  await assertFails(getDocs(collection(guest, 'publicAvailability')));
  await assertFails(getDoc(doc(guest, publicSlot)));
  await assertFails(getDoc(doc(teacher, publicSlot)));
  await assertFails(setDoc(doc(teacher, publicSlot), slot));
  await assertFails(deleteDoc(doc(teacher, publicSlot)));
  await assertFails(setDoc(doc(as(legacy, 'phone'), publicSlot), slot));
  await assertFails(getDoc(doc(as('admin'), 'legacyLineBridge/config')));
});

test('only admin controls whether new pending memberships can be created', async () => {
  const admin = as('admin'), teacher = as('teacher-a'), applicant = as('fresh-teacher');
  await assertFails(setDoc(doc(teacher, 'systemSettings/main'), {signupOpen: false}));
  await assertSucceeds(setDoc(doc(admin, 'systemSettings/main'), {signupOpen: false}));
  await assertFails(setDoc(doc(applicant, membership('fresh-teacher')), {role: 'teacher', status: 'pending'}));
  await assertSucceeds(setDoc(doc(admin, 'systemSettings/main'), {signupOpen: true}));
  await assertSucceeds(setDoc(doc(applicant, membership('fresh-teacher')), {role: 'teacher', status: 'pending'}));
});

test('deleting memberships cannot be reactivated and retired UIDs cannot register again', async () => {
  const uid = 'retiring-teacher';
  const marker = 'retiredTeacherAccounts/' + uid;
  await fixture.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, membership(uid)), {role: 'teacher', status: 'deleting'});
    await setDoc(doc(db, marker), {retired: true});
  });
  const teacher = as(uid), admin = as('admin');
  await assertFails(getDoc(doc(teacher, head(uid))));
  await assertFails(setDoc(doc(teacher, 'teachers/' + uid + '/public/publicAvailability'), {slots: []}));
  await assertFails(updateDoc(doc(admin, membership(uid)), {status: 'active'}));
  await assertFails(deleteDoc(doc(admin, marker)));
  await assertFails(getDoc(doc(admin, marker)));
  await fixture.withSecurityRulesDisabled(context => deleteDoc(doc(context.firestore(), membership(uid))));
  await assertFails(setDoc(doc(teacher, membership(uid)), {role: 'teacher', status: 'pending'}));
});
