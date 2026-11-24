(function (root) {
  'use strict';

  const batchSize = 100;

  function entries(students) {
    return students.map(({id, name}) => [id, {name, active: true}]);
  }

  async function reconcile(db, uid, revision, desired) {
    const teacher = db.collection('teachers').doc(uid);
    const index = teacher.collection('studentBindingIndex');
    const head = teacher.collection('workspace').doc('head');
    const byId = new Map(desired);

    const pending = new Map(desired.map(([id, entry]) => [id, {ref: index.doc(id), entry}]));
    const current = await index.get({source: 'server'}).catch(error => {
      throw indexError(error, '讀取學生索引');
    });
    for (const doc of current.docs) {
      const entry = byId.get(doc.id);
      if (!entry) {
        pending.set(doc.id, {ref: doc.ref});
        continue;
      }
      const {name, active, ...extra} = doc.data();
      if (name === entry.name && active === entry.active && !Object.keys(extra).length) {
        pending.delete(doc.id);
      }
    }

    const changes = [...pending.values()];
    const result = {total: byId.size, written: 0, deleted: 0};
    for (let start = 0; start < changes.length; start += batchSize) {
      const batch = changes.slice(start, start + batchSize);
      await db.runTransaction(async transaction => {
        // A tab with an older workspace must never restore a renamed or deleted entry.
        const snapshot = await transaction.get(head);
        const currentRevision = snapshot.exists ? snapshot.data().revision : 0;
        if (currentRevision !== revision) {
          throw Object.assign(new Error('工作區有較新的版本。'), {code: 'index-revision-changed'});
        }
        for (const {ref, entry} of batch) {
          if (entry) transaction.set(ref, entry);
          else transaction.delete(ref);
        }
      }).catch(error => {
        throw indexError(error, '提交索引寫入', result);
      });
      const written = batch.filter(change => change.entry).length;
      result.written += written;
      result.deleted += batch.length - written;
    }
    return result;
  }

  function indexError(error, stage, progress = {written: 0, deleted: 0}) {
    return Object.assign(new Error(error.message || 'Firestore 未提供錯誤原因。', {cause: error}), {
      code: error.code || 'unknown', stage, written: progress.written, deleted: progress.deleted
    });
  }

  const api = {entries, reconcile};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TutorFlowStudentIndex = api;
})(globalThis);
