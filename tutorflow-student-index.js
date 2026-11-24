(function (root) {
  'use strict';

  const batchSize = 100;

  function entries(students) {
    return students.map(({id, name, archived}) => [id, {name, active: !archived}]);
  }

  async function reconcile(db, uid, revision, desired) {
    const teacher = db.collection('teachers').doc(uid);
    const index = teacher.collection('studentBindingIndex');
    const head = teacher.collection('workspace').doc('head');
    const byId = new Map(desired);

    const pending = new Map(desired.map(([id, entry]) => [id, {ref: index.doc(id), entry}]));
    const current = await index.get({source: 'server'});
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
      });
    }
    return byId.size;
  }

  const api = {entries, reconcile};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TutorFlowStudentIndex = api;
})(globalThis);
