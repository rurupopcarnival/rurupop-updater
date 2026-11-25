// src/ui.html から src/ui.js を生成する
import { readFileSync, writeFileSync } from 'node:fs';
const ui = readFileSync(new URL('./src/ui.html', import.meta.url), 'utf8');
writeFileSync(new URL('./src/ui.js', import.meta.url), `// 自動生成（node build.mjs）\nexport const UI_HTML = ${JSON.stringify(ui)};\n`);
console.log('ui.js generated');
