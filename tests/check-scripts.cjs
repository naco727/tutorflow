const fs = require('node:fs');
const vm = require('node:vm');
const page = fs.readFileSync('index.html', 'utf8');
for (const match of page.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
  const filename = match[1] || 'index.html';
  new vm.Script(match[1] ? fs.readFileSync(filename, 'utf8') : match[2], {filename});
}
console.log('TutorFlow HTML 與前端 JavaScript 語法檢查通過。');
