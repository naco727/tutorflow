(function (root) {
  'use strict';

  const CHUNK_SIZE = 160_000;
  const MAX_CHUNKS = 32;
  const VERSION = 1;
  const validId = /^[\w.-]{1,160}$/;
  const validDate = /^\d{4,6}-\d{2}-\d{2}$/;
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const empty = () => ({students: [], courses: [], notes: [], bookings: [], settings: {}, initialized: true});
  const failure = (code, message) => Object.assign(new Error(message), {code});

  function validateWorkspace(input) {
    if (!isRecord(input)) throw failure('invalid-backup', '備份檔必須是 TutorFlow JSON。');
    const {exportedAt, ...workspace} = input;
    workspace.bookings ??= [];
    workspace.settings ??= {};
    workspace.initialized = true;
    const ids = {};
    for (const group of ['students', 'courses', 'notes', 'bookings']) {
      if (!Array.isArray(workspace[group])) throw failure('invalid-backup', `缺少 ${group} 資料陣列。`);
      ids[group] = new Set();
      for (const item of workspace[group]) {
        if (!isRecord(item) || typeof item.id !== 'string' || !validId.test(item.id) || ids[group].has(item.id)) {
          throw failure('invalid-backup', `${group} 含有無效或重複的 ID。`);
        }
        ids[group].add(item.id);
        for (const field of ['studentId', 'courseId', 'seriesId']) {
          if (item[field] != null && item[field] !== '' && (typeof item[field] !== 'string' || !validId.test(item[field]))) {
            throw failure('invalid-backup', `${group} 含有無效的關聯 ID。`);
          }
        }
        if (group !== 'students' && (typeof item.date !== 'string' || !validDate.test(item.date))) {
          throw failure('invalid-backup', `${group} 含有無效日期。`);
        }
        if (['courses', 'bookings'].includes(group) && (![item.start, item.end].every(t => typeof t === 'string' && validTime.test(t)) || item.end <= item.start)) {
          throw failure('invalid-backup', `${group} 含有無效的起訖時間。`);
        }
        if (group === 'courses' && item.studentColorSnapshot != null && !['sage', 'lav', 'apricot'].includes(item.studentColorSnapshot)) {
          throw failure('invalid-backup', '課程含有無效的學生顏色。');
        }
      }
    }
    if (!isRecord(workspace.settings)) throw failure('invalid-backup', '備份的設定格式有誤。');
    for (const student of workspace.students) {
      if (typeof student.name !== 'string' || (student.color != null && !['sage', 'lav', 'apricot'].includes(student.color))) {
        throw failure('invalid-backup', '學生姓名或顏色格式有誤。');
      }
    }
    const availability = workspace.settings.availability;
    if (availability != null) {
      if (!isRecord(availability)) throw failure('invalid-backup', '空堂設定格式有誤。');
      const validWindow = slot => isRecord(slot) && [slot.start, slot.end].every(time => typeof time === 'string' && validTime.test(time));
      if (availability.weekly != null && (!Array.isArray(availability.weekly) || !availability.weekly.every(validWindow))) {
        throw failure('invalid-backup', '每週可授課時間格式有誤。');
      }
      if (availability.publicSlots != null && (!Array.isArray(availability.publicSlots) ||
          !availability.publicSlots.every(slot => validWindow(slot) && typeof slot.date === 'string' && validDate.test(slot.date)))) {
        throw failure('invalid-backup', '公開空堂日期或時間格式有誤。');
      }
    }
    return {
      workspace,
      counts: Object.fromEntries(Object.keys(ids).map(group => [group, ids[group].size])),
      paidLessons: workspace.courses.filter(course => course.paid).length,
      missingLinks: workspace.courses.filter(course => !ids.students.has(course.studentId) && !course.studentNameSnapshot).length +
        workspace.notes.filter(note => !ids.students.has(note.studentId) || (note.courseId && !ids.courses.has(note.courseId))).length +
        workspace.bookings.filter(booking => booking.studentId && !ids.students.has(booking.studentId)).length
    };
  }

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > CHUNK_SIZE * MAX_CHUNKS * 3 / 4) {
      throw failure('workspace-too-large', '資料已超過單次原子同步上限。請先匯出備份。');
    }
    const chunks = [];
    // 每塊獨立編碼，維持交易的文件和請求大小上限。
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE * 3 / 4) {
      const block = bytes.subarray(offset, offset + CHUNK_SIZE * 3 / 4);
      let binary = '';
      for (let i = 0; i < block.length; i += 8192) binary += String.fromCharCode(...block.subarray(i, i + 8192));
      chunks.push(btoa(binary));
    }
    return chunks;
  }

  function decode(chunks) {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let text = '';
    for (const chunk of chunks) {
      text += decoder.decode(Uint8Array.from(atob(chunk), char => char.charCodeAt(0)), {stream: true});
    }
    return text + decoder.decode();
  }

  function workspaceStore(db, uid) {
    const head = db.collection('teachers').doc(uid).collection('workspace').doc('head');
    const chunkRef = index => head.collection('chunks').doc(String(index));
    const server = {source: 'server'};
    function readHead(snapshot) {
      if (!snapshot.exists) return {revision: 0, chunkCount: 0, migrated: false, mutationId: ''};
      const info = snapshot.data();
      if (info.version !== VERSION || !Number.isSafeInteger(info.revision) || info.revision < 1 ||
          !Number.isInteger(info.chunkCount) || info.chunkCount < 1 || info.chunkCount > MAX_CHUNKS) {
        throw failure('invalid-workspace', '雲端資料版本或分塊清單無法讀取。');
      }
      return info;
    }

    async function load() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const info = readHead(await head.get(server));
        if (!info.revision) return {...info, text: '', chunks: []};
        const docs = (await head.collection('chunks').get(server)).docs;
        const byId = new Map(docs.map(doc => [doc.id, doc.data().payload]));
        const latest = readHead(await head.get(server));
        if (latest.revision !== info.revision) continue;
        const chunks = Array.from({length: info.chunkCount}, (_, index) => byId.get(String(index)));
        if (chunks.some(chunk => typeof chunk !== 'string')) throw failure('invalid-workspace', '雲端資料缺少部分分塊。');
        return {...info, text: decode(chunks), chunks};
      }
      throw failure('conflict', '其他裝置正在更新資料，請稍後重新載入。');
    }

    async function write({text, base, mutationId, migrate = false}) {
      const chunks = encode(text);
      const next = await db.runTransaction(async transaction => {
        const remote = readHead(await transaction.get(head));
        // 網路回應遺失時，以相同操作 ID 重試，避免重複套用匯入。
        if (remote.mutationId === mutationId) return remote;
        if (remote.revision !== base.revision || (migrate && remote.revision !== 0)) {
          throw failure('conflict', '另一台裝置已有較新版本。請先匯出本機待同步資料。');
        }
        const info = {
          version: VERSION,
          revision: remote.revision + 1,
          chunkCount: chunks.length,
          migrated: remote.migrated || migrate,
          mutationId
        };
        chunks.forEach((payload, index) => {
          if (payload !== base.chunks[index]) transaction.set(chunkRef(index), {payload});
        });
        for (let index = chunks.length; index < remote.chunkCount; index++) transaction.delete(chunkRef(index));
        transaction.set(head, info);
        return info;
      });
      return {...next, text, chunks};
    }
    return {load, write, watch: (next, error) => head.onSnapshot({includeMetadataChanges: true}, snapshot => {
      if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) {
        try { next(readHead(snapshot).revision); } catch (problem) { error(problem); }
      }
    }, error)};
  }

  const api = {empty, validateWorkspace, workspaceStore, encode, decode, failure};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TutorFlowCloud = api;
})(globalThis);
