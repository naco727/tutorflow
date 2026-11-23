(function (root) {
  'use strict';

  const fail = (code, message) => Object.assign(new Error(message), {code});

  function documentPath(teacherUid) {
    if (typeof teacherUid !== 'string' || !/^[^/\s]{1,128}$/.test(teacherUid) || /^(__.*__|\.{1,2})$/.test(teacherUid)) {
      throw fail('invalid-argument', '老師 UID 格式不正確。');
    }
    return 'teachers/' + teacherUid + '/public/publicAvailability';
  }

  function slotArray(document) {
    if (document === undefined || document === null) return [];
    if (!Array.isArray(document.slots)) {
      throw fail('failed-precondition', '既有公開文件缺少 slots 陣列，已停止更新。');
    }
    return document.slots;
  }

  function validateRow(row) {
    if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        ![row.start, row.end].every(time => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
        row.end <= row.start || typeof row.status !== 'string') {
      throw fail('failed-precondition', '公開空堂的日期、時間或狀態格式有誤，已停止更新。');
    }
  }

  function mergeSlots(original, calculatedSlots) {
    const key = slot => slot.date + ':' + slot.start;
    const desired = new Map();
    for (const {date, start, end, status} of calculatedSlots) {
      const slot = {date, start, end, status};
      validateRow(slot);
      if (status !== 'available') throw fail('invalid-argument', '同步只接受計算出的可預約時段。');
      desired.set(key(slot), slot);
    }
    const prior = slotArray(original);
    const seen = new Set();
    const next = [];

    // Existing fields are preserved for matched rows, and booking statuses are never reset.
    for (const row of prior) {
      validateRow(row);
      const id = key(row);
      if (seen.has(id)) throw fail('failed-precondition', '既有空堂的日期與開始時間重複，需要人工核對。');
      seen.add(id);
      const replacement = desired.get(id);
      desired.delete(id);
      if (row.status !== 'available') next.push(row);
      else if (replacement) next.push({...row, ...replacement});
    }
    const blocked = next.filter(row => row.status !== 'available');
    for (const slot of desired.values()) next.push(slot);
    // A changed start time must not create a new opening across a reserved interval.
    return next.filter(slot => slot.status !== 'available' || !blocked.some(row =>
      row.date === slot.date && row.start < slot.end && slot.start < row.end));
  }

  function viewSlots(document) {
    return slotArray(document).map(row => {
      validateRow(row);
      const {date, start, end, status} = row;
      return {date, start, end, status};
    }).filter(row => row.status === 'available');
  }

  async function sync(db, teacherUid, calculatedSlots) {
    const ref = db.doc(documentPath(teacherUid));
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists && !calculatedSlots.length) return {writtenCount: 0};
      const slots = mergeSlots(snapshot.exists ? snapshot.data() : null, calculatedSlots);
      // Update the array only; a transaction protects against concurrent reservation changes.
      if (snapshot.exists) transaction.update(ref, {slots});
      else transaction.set(ref, {slots});
      return {writtenCount: slots.filter(row => row.status === 'available').length};
    });
  }

  const api = {documentPath, mergeSlots, viewSlots, sync};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TutorFlowAvailability = api;
})(globalThis);
