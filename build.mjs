// src/ui.html（＋台本エンジン）から src/ui.js を生成する
import { readFileSync, writeFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const engine = r('./src/engine.cjs').replace(/<\/script/gi, '<\\/script');
const ui = r('./src/ui.html').replace('/*__ENGINE__*/', () => engine);
writeFileSync(new URL('./src/ui.js', import.meta.url), `// 自動生成（node build.mjs）\nexport const UI_HTML = ${JSON.stringify(ui)};\n`);
console.log('ui.js generated');
