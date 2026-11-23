const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('teacher minimum is saved, applied to full slots, and passed to Firestore sync', async () => {
  const page = fs.readFileSync('index.html', 'utf8');
  const part = page.slice(page.indexOf('    const PUBLIC_AVAILABILITY_COLLECTION'), page.indexOf('    function renderPublicModeSlots'));
  const date = '2099-01-05';
  const parseDate = value => new Date(value + 'T00:00:00');
  const weekday = parseDate(date).getDay();
  const minimumInput = {value: '', reportValidity: () => true};
  let savedConfig, uploaded;
  const controls = {
    '#availabilityMinimumHours': minimumInput,
    '#availabilityHorizon': {value: '2'},
    '[data-availability-action="sync"]': {disabled: false},
    [`[data-availability-day="${weekday}"]`]: {querySelector: selector => ({
      '[data-availability-enabled]': {checked: true},
      '[data-availability-start]': {value: '09:00'},
      '[data-availability-end]': {value: '16:00'}
    })[selector]}
  };
  const data = {
    settings: {availability: {durationMinutes: 90}},
    courses: [['09:30', '10:00'], ['10:31', '11:00'], ['12:30', '13:30']]
      .map(([start, end]) => ({date, start, end, status: 'scheduled'})),
    bookings: []
  };
  const db = {};
  const context = vm.createContext({
    data, $: selector => controls[selector], parseDate,
    availabilityDayNames: ['日', '一', '二', '三', '四', '五', '六'],
    todayISO: () => '2099-01-04', addDays: (_, offset) => offset ? date : '2099-01-04',
    dateTime: (day, time) => Date.parse(day + 'T' + time),
    save: () => { savedConfig = JSON.parse(JSON.stringify(data.settings.availability)); },
    toast: () => {}, flushWorkspace: async () => true,
    FIREBASE_CONFIG: {projectId: 'demo-tutorflow'},
    cloudSession: {user: {uid: 'teacher-a'}, db},
    window: {firebase: {apps: [{name: '[DEFAULT]'}], auth: () => ({currentUser: {uid: 'teacher-a'}})}},
    FIREBASE_SDK_URLS: [], loopback: false,
    TutorFlowAvailability: {sync: async (actualDb, uid, slots) => {
      assert.equal(actualDb, db);
      assert.equal(uid, 'teacher-a');
      uploaded = JSON.parse(JSON.stringify(slots));
      return {writtenCount: slots.length};
    }}
  });
  vm.runInContext(part, context);
  const times = slots => slots.map(({start, end}) => [start, end]);
  await vm.runInContext('syncAvailability()', context);
  assert.equal(savedConfig.minimumMinutes, 31);
  assert.deepEqual(times(uploaded), [['10:00', '10:31'], ['11:00', '12:30'], ['13:30', '16:00']]);

  minimumInput.value = '1.5';
  minimumInput.valueAsNumber = 1.5;
  await vm.runInContext('syncAvailability()', context);
  assert.equal(savedConfig.minimumMinutes, 90);
  assert.equal(vm.runInContext('getAvailabilityConfig().minimumMinutes', context), 90);
  assert.deepEqual(times(uploaded), [['11:00', '12:30'], ['13:30', '16:00']]);
  assert.deepEqual(uploaded, savedConfig.publicSlots);

  minimumInput.value = '3';
  minimumInput.valueAsNumber = 3;
  await vm.runInContext('syncAvailability()', context);
  assert.deepEqual(uploaded, []);
  assert.equal(controls['[data-availability-action="sync"]'].disabled, false);
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
