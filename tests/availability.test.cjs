const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {documentPath, mergeSlots, viewSlots} = require('../tutorflow-availability.js');
const {prepare, verify} = require('../scripts/availability-migration.cjs');
const {patchWorker} = require('../worker/apply-availability-change.cjs');

const available = {date: '2026-11-24', start: '16:00', end: '18:30', status: 'available'};
const booked = {...available, start: '18:30', end: '19:00', status: 'booked', revision: 12};
const replacement = {...available, end: '18:00'};
const typed = obj => Object.fromEntries(Object.entries(obj).map(([key, value]) =>
  [key, typeof value === 'string' ? {stringValue: value} : {integerValue: String(value)}]));
const asRow = fields => ({mapValue: {fields}});
const db = 'projects/turtorflow/databases/(default)/documents';

test('aggregating the verified legacy collection retains every typed field and original status', () => {
  const fields = {...typed(available), extra: {mapValue: {fields: {checked: {booleanValue: false}}}}};
  const backup = {documents: [
    {name: db + '/publicAvailability/2026-11-24_1600', fields},
    {name: db + '/publicAvailability/2026-11-24_1830', fields: typed(booked)}
  ]};
  const destination = prepare(backup, 'owner-id');
  assert.equal(destination.name, db + '/' + documentPath('owner-id'));
  assert.deepEqual(destination.fields.slots.arrayValue.values, [asRow(fields), asRow(typed(booked))]);
  assert.equal(verify(backup, 'owner-id', destination), 2);
  assert.throws(() => verify(backup, 'owner-id', {...destination, fields: {}}), /內容不同/);
  assert.throws(() => prepare({...backup, nextPageToken: 'pending'}, 'owner-id'), /分頁/);
});

test('sync changes openings and preserves booked rows, metadata and empty-doc behavior', () => {
  const prior = {slots: [{...available, label: 'original'}, booked]};
  const overlapsBooking = {...available, start: '18:45', end: '20:00'};
  const after = mergeSlots(prior, [replacement, overlapsBooking]);
  assert.deepEqual(after, [{...replacement, label: 'original'}, booked]);
  assert.deepEqual(viewSlots({slots: after}), [replacement]);
  assert.deepEqual(mergeSlots(prior, []), [booked]);
  assert.throws(() => mergeSlots({slots: {}}, [available]), {code: 'failed-precondition'});
});

test('Worker uses only trusted UID, reads one document and keeps the original filters', async () => {
  const {readTeacherAvailabilityDocument, selectTeacherAvailability} = await import('../worker/availability.mjs');
  let requested;
  const rows = await readTeacherAvailabilityDocument({TEACHER_UID: 'owner-id', teacherUid: 'attacker'}, async (url, options) => {
    requested = url;
    assert.equal(options.cache, 'no-store');
    return Response.json({fields: {slots: {arrayValue: {values: [
      asRow(typed({...available, start: '20:00', end: '21:00'})),
      asRow(typed(booked)),
      asRow(typed(available)),
      asRow(typed({...available, date: '2026-11-22'}))
    ]}}}});
  });
  assert.equal(new URL(requested).pathname, '/v1/' + db.replace('(default)', encodeURIComponent('(default)')) + '/teachers/owner-id/public/publicAvailability');
  assert.equal(new URL(requested).search, '');
  assert.deepEqual(selectTeacherAvailability(rows, {date: '2026-11-24', time: '17:00'}), [
    {date: available.date, start: '16:00', end: '18:30'},
    {date: available.date, start: '20:00', end: '21:00'}
  ]);
  await assert.rejects(readTeacherAvailabilityDocument({TEACHER_UID: 'foo/../secret'}, () => assert.fail('no request')), /TEACHER_UID/);
  await assert.rejects(readTeacherAvailabilityDocument({TEACHER_UID: 'owner-id'}, async () => new Response(null, {status: 404})), /Firestore 404/);
  await assert.rejects(readTeacherAvailabilityDocument({TEACHER_UID: 'owner-id'}, async () => Response.json({fields: {}})), /slots/);
});

test('Worker patch fingerprints the provided source and keeps other sections byte-for-byte', async () => {
  const header = 'const PROJECT_ID = "turtorflow";\nconst taipeiNow = () => ({date:"2026-11-24",time:"16:00"});\n';
  const originalReader = 'async function availability() {\n  const data = {};\n  return data.documents || data.nextPageToken;\n}\n\n';
  const unchanged = '// =====================================\n// 預約訊息連結\nfunction bookingUrl() { return "oaMessage"; }\n';
  const oldCaller = 'async function handleEvent(env) {\n  const slots = await availability();\n  return {slots, link: bookingUrl()};\n}\n';
  const patched = patchWorker(header + originalReader + unchanged + oldCaller);
  assert.ok(patched.startsWith(header));
  assert.ok(patched.includes(unchanged));
  assert.ok(patched.endsWith(oldCaller.replace('await availability()', 'await availability(env)')));
  assert.throws(() => patchWorker('wrong Worker'));
  const ctx = vm.createContext({fetch: async () => Response.json({fields: {slots: {arrayValue: {values: [asRow(typed(available))]}}}})});
  const output = await vm.runInContext(patched + '\nhandleEvent({TEACHER_UID:"owner-id"})', ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), {slots: [{date: available.date, start: available.start, end: available.end}], link: 'oaMessage'});
});
