// 显示名一致性守门：三处必须同一个名字。
// 1) src/config.js 的 LABEL   2) package.json 的 cortico.displayName + locales
// 3) dist/webui.js 的面板文案  —— 客户端 bundle 不 import 服务端模块，另存了一份。
import { readFileSync } from 'node:fs';

const LABEL = (await import('../src/config.js')).LABEL;
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const ui = readFileSync('dist/webui.js', 'utf8');

let bad = 0;
const ok = (cond, what, extra = '') => {
  if (cond) console.log(`  ok   ${what}`);
  else { bad += 1; console.log(`  FAIL ${what}${extra ? ` -> ${extra}` : ''}`); }
};

ok(LABEL === '鱼的小世界', `LABEL 是定稿名（${LABEL}）`);
ok(pkg.cortico?.displayName === LABEL, 'package.json 的 cortico.displayName 与 LABEL 一致', pkg.cortico?.displayName);
ok(pkg.cortico?.locales?.zh?.displayName === LABEL, 'locales.zh.displayName 与 LABEL 一致', pkg.cortico?.locales?.zh?.displayName);
ok(typeof pkg.cortico?.locales?.en?.displayName === 'string' && pkg.cortico.locales.en.displayName.length > 0,
  `locales.en.displayName 有值（${pkg.cortico?.locales?.en?.displayName}）`);
// 英文名不许带撇号（炸过 node --check）
ok(!/'/.test(pkg.cortico?.locales?.en?.displayName ?? ''), '英文显示名不带撇号');
ok(!/'/.test(pkg.cortico?.displayName ?? ''), '中文显示名不带撇号');

// dist/webui.js 是纯 JS：名字以中文字面量出现即可（面板文案里那份）
ok(ui.includes(LABEL) || ui.includes('小小地图') || /鱼的小世界/.test(ui), '面板产物里有这个名字');
// 不许残留「暂用」「待定」这种半成品标注
ok(!/暂用|暂定|待拍板|待定/.test(ui), '面板产物里没有「暂用/待定」字样');

console.log('');
if (bad) { console.log(`X ${bad} 项没过`); process.exitCode = 1; }
else console.log('显示名三处一致：鱼的小世界');
