const defaultProject = 'turtorflow';

export async function readTeacherAvailabilityDocument(env, fetchDocument = fetch) {
  const teacherUid = env?.TEACHER_UID;
  if (typeof teacherUid !== 'string' || !/^[^/\s]{1,128}$/.test(teacherUid) || /^(__.*__|\.{1,2})$/.test(teacherUid)) {
    throw new Error('TEACHER_UID is missing or invalid');
  }
  const project = env.FIREBASE_PROJECT_ID || defaultProject;
  const database = env.FIRESTORE_DATABASE_ID || '(default)';
  const root = 'https://firestore.googleapis.com/v1/projects/';
  const url = root + encodeURIComponent(project) + '/databases/' + encodeURIComponent(database) +
    '/documents/teachers/' + encodeURIComponent(teacherUid) + '/public/publicAvailability';
  const response = await fetchDocument(url, {cache: 'no-store'});
  if (!response.ok) throw new Error('Firestore ' + response.status);
  const document = await response.json();
  const arrayValue = document.fields?.slots?.arrayValue;
  if (!arrayValue || !Array.isArray(arrayValue.values ?? [])) {
    throw new Error('Firestore public availability document is missing its slots array');
  }
  return arrayValue.values ?? [];
}

export function selectTeacherAvailability(rows, now) {
  const slots = [];
  for (const row of rows) {
    const f = row.mapValue?.fields || {};
    const date = f.date?.stringValue;
    const start = f.start?.stringValue;
    const end = f.end?.stringValue;
    const status = f.status?.stringValue;
    if (status !== 'available' || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') ||
        !/^\d{2}:\d{2}$/.test(start || '') || !/^\d{2}:\d{2}$/.test(end || '') ||
        end <= start || date < now.date || (date === now.date && end <= now.time)) continue;
    slots.push({date, start, end});
  }
  return slots.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}
