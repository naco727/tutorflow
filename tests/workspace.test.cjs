const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validateWorkspace, empty, workspaceStore, encode, decode} = require('../tutorflow-cloud.js');

const lesson = {id: 'c1', studentId: 's1', date: '2027-01-01', start: '13:00', end: '15:00', paid: true, rateSnapshot: 700};
const sample = {...empty(), students: [{id: 's1', name: '學生'}], courses: [lesson], notes: [{id: 'n1', date: lesson.date, studentId: 's1', courseId: 'c1'}]};

test('legacy backup keeps original IDs, financial snapshots and note links', () => {
  const {bookings, ...legacy} = sample;
  const result = validateWorkspace({...legacy, exportedAt: 'last week'});
  assert.deepEqual(result.workspace, sample);
  assert.equal(result.paidLessons, 1);
  assert.equal(result.missingLinks, 0);
});

test('reject duplicated or unsafe IDs and invalid schedule before uploading', () => {
  for (const courses of [[lesson, lesson], [{...lesson, id: '"><script>'}], [{...lesson, end: '12:00'}]]) {
    assert.throws(() => validateWorkspace({...sample, courses}), {code: 'invalid-backup'});
  }
});

test('UTF-8 is preserved across chunk boundaries and oversized backups are refused', () => {
  const input = 'x' + '家教🙂'.repeat(25000);
  assert.ok(encode(input).length > 1);
  assert.equal(decode(encode(input)), input);
  assert.throws(() => encode('x'.repeat(3_840_001)), {code: 'workspace-too-large'});
});

function mockFirestore() {
  const state = new Map();
  let failOnce = false;
  const snapshot = (path, value) => ({id: path.split('/').pop(), exists: value !== undefined, data: () => value});
  const ref = (path, isCollection) => ({
    path,
    collection: name => ref(path + '/' + name, true),
    doc: name => ref(path + '/' + name, false),
    get: async () => isCollection
      ? {docs: [...state].filter(([key]) => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/'))
        .map(([key, value]) => snapshot(key, value))}
      : snapshot(path, state.get(path))
  });
  return {
    collection: name => ref(name, true),
    failNext: () => { failOnce = true; },
    async runTransaction(worker) {
      const pending = [];
      const result = await worker({
        get: document => document.get(),
        set: (document, value) => pending.push(() => state.set(document.path, value)),
        delete: document => pending.push(() => state.delete(document.path))
      });
      if (failOnce) { failOnce = false; throw Error('network'); }
      pending.forEach(apply => apply());
      return result;
    }
  };
}

test('initial migration is atomic, recoverable, idempotent and isolated by UID', async () => {
  const db = mockFirestore();
  const first = workspaceStore(db, 'teacherA');
  const second = workspaceStore(db, 'teacherB');
  const blank = await first.load();
  const job = {text: JSON.stringify(sample), base: blank, mutationId: 'migration-1', migrate: true};
  db.failNext();
  await assert.rejects(first.write(job), /network/);
  assert.equal((await first.load()).revision, 0);
  await first.write(job);
  await first.write(job);
  const restored = await first.load();
  assert.equal(restored.revision, 1);
  assert.equal(restored.migrated, true);
  assert.deepEqual(JSON.parse(restored.text), sample);
  assert.equal((await second.load()).revision, 0);
  await assert.rejects(first.write({...job, mutationId: 'migration-2'}), {code: 'conflict'});
});

test('same UID across devices sees changes and a stale write cannot replace them', async () => {
  const db = mockFirestore(), device1 = workspaceStore(db, 'teacher'), device2 = workspaceStore(db, 'teacher');
  const initial = await device1.write({text: JSON.stringify(sample), base: await device1.load(), mutationId: 'one'});
  const openOnAnotherDevice = await device2.load();
  const next = {...sample, courses: [{...lesson, paid: false}]};
  await device1.write({text: JSON.stringify(next), base: initial, mutationId: 'two'});
  await assert.rejects(device2.write({text: JSON.stringify(empty()), base: openOnAnotherDevice, mutationId: 'three'}), {code: 'conflict'});
  assert.deepEqual(JSON.parse((await device2.load()).text), next);
});
