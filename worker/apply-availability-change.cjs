'use strict';

const fs = require('node:fs');
const path = require('node:path');

function patchWorker(source) {
  const start = source.indexOf('async function availability() {');
  const nextSection = '// =====================================';
  const end = source.indexOf(nextSection, start);
  const call = 'const slots = await availability();';
  const oldSpan = source.slice(start, end);
  if (start < 0 || end < 0 || !oldSpan.includes('data.documents') || !oldSpan.includes('nextPageToken') ||
      source.split(call).length !== 2 || !source.slice(end).includes('// 預約訊息連結')) {
    throw Error('Worker 字樣與已審查的版本不同，請依實際原始碼套用，不會產生檔案。');
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const adapter = fs.readFileSync(path.join(__dirname, 'availability.mjs'), 'utf8').trimEnd()
    .replace(/^export /gm, '')
    .replace("const defaultProject = 'turtorflow';", 'const defaultProject = PROJECT_ID;');
  const replacement = (adapter + '\n\nasync function availability(env) {\n' +
    '  const now = taipeiNow();\n' +
    '  const rows = await readTeacherAvailabilityDocument(env);\n' +
    '  return selectTeacherAvailability(rows, now);\n}\n\n').replace(/\r?\n/g, newline);
  return (source.slice(0, start) + replacement + source.slice(end))
    .replace(call, 'const slots = await availability(env);');
}

if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw Error('Usage: node worker/apply-availability-change.cjs old-worker.mjs updated-worker.mjs');
    const updated = patchWorker(fs.readFileSync(input, 'utf8'));
    // Exclusive create protects the saved source and any previous generated output.
    fs.writeFileSync(output, updated, {flag: 'wx'});
    console.log('已產生待檢查的 Worker。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {patchWorker};
