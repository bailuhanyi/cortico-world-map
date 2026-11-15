#!/usr/bin/env node
/**
 * 提示词模板自检：ENV_PROMPT.md 里的 `{{变量}}` 必须和 `envPromptVars()` 的键一一对上。
 *
 * 为什么要这一项：宿主把 `envPromptVars()` 的返回值填进模板里的 `{{key}}`。
 * 键名打错（写了 `{{map_places}}` 但给的是 `map_places_block`）**不会报错**——
 * 占位符原样留在提示词里，她就真的看到一行 `{{map_places}}`。
 *
 * 这个插件还多一条：**「不提生图也能读通」**。所以这里要钉住——
 * 把两个块都填成空串之后，模板里不许剩下任何 `imggen_draw` / `scene` / 「发图」字样。
 * 那是方案 §5 第 1 句的要求（常驻那句不提生图也能读通）。
 *
 * 用法：node tools/check-prompt.mjs
 */
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../src/config.js';
import { MapWorld } from '../src/world.js';

const PROMPT = fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url));
const TZ = 'Asia/Shanghai';

let failures = 0;
const ok = (cond, what, extra = '') => {
  if (cond) console.log(`  ok   ${what}`);
  else { failures += 1; console.log(`  FAIL ${what}${extra ? ` → ${extra}` : ''}`); }
};

const template = await readFile(PROMPT, 'utf8');
const used = [...new Set([...template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];

// 一个没有任何地点的数据目录：这时候三块都该是空串。
const dataDir = await mkdtemp(join(tmpdir(), 'map-prompt-'));
const world = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir, timezone: TZ, persist: () => {} });
await world.start({ log: { info() {}, warn() {} } });
const vars = world.envPromptVars();
const provided = Object.keys(vars);

/**
 * 造一个「三个联动都装了、并且有一处带 scene 的地方」的世界，
 * 用来验条件块真的会生成那两句。
 */
async function makeFullWorld() {
  const dir = join(await mkdtemp(join(tmpdir(), 'map-prompt-full-')), 'data', 'home', 'companion');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '..', 'config.json'), JSON.stringify({
    worlds: { imggen: { enabled: true }, feast: { enabled: true }, fun: { enabled: true } },
  }), 'utf8');
  const w = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir: dir, timezone: TZ, persist: () => {} });
  await w.start({ log: { info() {}, warn() {} } });
  const ui = w.webUi('zh');
  await ui.invoke('places', 'terrain', [{ id: 'forest' }]);
  const t = Object.fromEntries(w.tools().map((x) => [x.name, x.handler]));
  await t.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  const v = w.envPromptVars();
  await w.stop();
  return { feastBlock: v.map_feast_block, imggenBlock: v.map_imggen_block, placesBlock: v.map_places_block };
}

console.log('ENV_PROMPT.md 里用到的占位符：', used.join(', ') || '（无）');
console.log('envPromptVars() 提供的键：', provided.join(', ') || '（无）');

for (const key of used) {
  ok(provided.includes(key), `模板里的 {{${key}}} 有对应返回值`);
}
for (const key of provided) {
  ok(used.includes(key), `envPromptVars 的 ${key} 在模板里被用到（没有白算）`);
}

// 模板本身不能残留未闭合的花括号或占位符拼写痕迹。
ok(!/\{\{[^}]*$/.test(template), '没有未闭合的 {{');
ok(!/\uFFFD/.test(template), '模板里没有替换字符（编码没坏）');

// 三块都空的时候（空地图、三个联动都没装）：整份提示词必须只靠常驻正文就能读通。
// 这一条是「绝不指向不存在的工具」的机器版——常驻段落里不许出现任何外部工具名。
{
  const rendered = template
    .replace(/\{\{\s*map_places_block\s*\}\}/g, '')
    .replace(/\{\{\s*map_imggen_block\s*\}\}/g, '')
    .replace(/\{\{\s*map_feast_block\s*\}\}/g, '');
  ok(!/imggen_draw/.test(rendered), '「不提生图也能读通」：空块时整份提示词里没有 imggen_draw');
  ok(!/\bscene\b/.test(rendered), '空块时整份提示词里没有 scene 这个词', /\bscene\b/.test(rendered) ? '（那是骨架级泄露，必须进了块才能出现）' : '');
  ok(!/生图/.test(rendered), '空块时整份提示词里没有「生图」两字', /生图/.test(rendered) ? '' : '');
  // feast / fun 的外部工具名：常驻段落里一个都不许有（只能进条件块）。
  for (const [needle, why] of [
    ['feast_life_plan', '写日程'],
    ['feast_life_now', '此刻在哪'],
    ['feast_life_play', '记一笔'],
    ['fun_go', '去娱乐时间某处'],
    ['fun_places', '看能去哪'],
  ]) {
    ok(!rendered.includes(needle), `空块时整份提示词里没有 ${needle}（${why}）`,
      rendered.includes(needle) ? `「${needle}」漏在常驻段落里了，必须挪进条件块` : '');
  }
}

// 三条互指得真的有地方生成（这是联动的骨架，删了就断）。
// 注意：feast / imggen 那两句现在**由 envPromptVars 的条件块生成**，不在模板正文里
// （放进正文就等于「没装也提」，违反「绝不指向不存在的工具」）。
// 所以这里查模板里的两处常驻指引 + 查块里确实会生成那两句。
for (const [needle, why] of [
  ['map_places', '列出地点'],
  ['map_look', '看某一处'],
]) {
  ok(template.includes(needle), `ENV_PROMPT 里写了 ${needle}（${why}）`);
}
{
  // 装上所有联动 + 有地点时，两块里该各自出现对方的工具名。
  const full = await makeFullWorld();
  ok(full.feastBlock.includes('feast_life_plan'), '装了 feast 时 map_feast_block 里写着 feast_life_plan');
  ok(full.feastBlock.includes('feast_life_now'), '装了 feast 时 map_feast_block 里写着 feast_life_now');
  ok(full.imggenBlock.includes('imggen_draw'), '装了 imggen 时 map_imggen_block 里写着 imggen_draw');
}

// 空地图时两块都必须是空串（不能因为没地点就吐出半句话）。
{
  ok(vars.map_places_block === '', '没地点时 map_places_block 是空串');
  ok(vars.map_imggen_block === '', '没地点、没生图时 map_imggen_block 是空串');
}

await world.stop();

console.log('');
if (failures) {
  console.log(`X ${failures} 项没过`);
  process.exit(1);
}
console.log('全部通过');
