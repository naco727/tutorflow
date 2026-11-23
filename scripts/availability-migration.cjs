'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const {documentPath} = require('../tutorflow-availability.js');

function sourceDocuments(backup) {
  if (!backup || !Array.isArray(backup.documents) || backup.nextPageToken || !backup.documents.length) {
    throw Error('備份必須包含所有非空來源文件。請先抓完所有分頁。');
  }
  const used = new Set();
  let collectionPath;
  for (const document of backup.documents) {
    const match = /^(projects\/[^/]+\/databases\/[^/]+\/documents\/publicAvailability)\/([^/]+)$/.exec(document?.name || '');
    if (!match || used.has(document.name) || !document.fields) throw Error('備份含有錯誤來源、重複文件或空欄位。');
    if (collectionPath && match[1] !== collectionPath) throw Error('所有文件須來自同一資料庫的來源集合。');
    collectionPath = match[1];
    used.add(document.name);
    if (!['date', 'start', 'end', 'status'].every(key => typeof document.fields[key]?.stringValue === 'string')) {
      throw Error('來源文件的日期、時間或狀態欄位與已確認的格式不同。');
    }
  }
  return backup.documents;
}

function prepare(backup, teacherUid) {
  const documents = sourceDocuments(backup);
  const databasePath = documents[0].name.split('/documents/')[0];
  const name = databasePath + '/documents/' + documentPath(teacherUid);
  const fields = {
    slots: {arrayValue: {values: documents.map(doc => ({mapValue: {fields: doc.fields}}))}}
  };
  if (Buffer.byteLength(JSON.stringify(fields), 'utf8') >= 1024 * 1024) {
    throw Error('準備的資料接近或超過單份 Firestore 文件的大小上限，需要人工檢查。');
  }
  return {name, fields};
}

function verify(backup, teacherUid, destination) {
  const planned = prepare(backup, teacherUid);
  assert.equal(destination?.name, planned.name, '目標文件路徑不同。');
  assert.deepEqual(destination.fields, planned.fields, '欄位、型別、陣列順序或內容不同。');
  return sourceDocuments(backup).length;
}

if (require.main === module) {
  try {
    const [action, input, teacherUid, target] = process.argv.slice(2);
    if (!input || !teacherUid || !['prepare', 'verify'].includes(action)) {
      throw Error('Usage: availability-migration.cjs prepare backup.json UID [output.json] | verify backup.json UID remote-backup.json');
    }
    const load = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
    const backup = load(input);
    if (action === 'verify') {
      if (!target) throw Error('請提供目標文件的唯讀備份。');
      console.log(`已完整核對 ${verify(backup, teacherUid, load(target))} 個原有空堂。`);
    } else {
      if (!target) throw Error('請指定新的本機輸出檔名。');
      fs.writeFileSync(target, JSON.stringify(prepare(backup, teacherUid), null, 2) + '\n', {flag: 'wx'});
      console.log('已產生待審核的本機目標文件。');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {prepare, verify};
