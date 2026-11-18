#!/usr/bin/env node
/**
 * 契约审计：这个插件**绝不能**出现对别的 World 的运行时依赖，
 * 也**绝不能**出现路线 / 坐标 / 距离 / 导航。
 *
 * 为什么单独一个工具：World 契约里最容易被打破的一条是「一个 World 依赖另一个扩展」，
 * 认证会查它。而违反它的方式很隐蔽——`readFileSync('../feast/state.json')`、
 * `import('cortico-world-feast')`、去 `imggen-library` 读条目……每一条都是「能跑，
 * 但等于偷偷装了个依赖」。
 *
 * 小地图还有一条自己的红线：它叫「地图」，所以最容易被顺手加进路线、坐标、连线。
 * 本脚本静态扫一遍，把这类字段挡在源码外面。
 *
 * 这个脚本只读源码做静态检查，不执行任何东西。查五件事：
 *
 *   1. src/ 下不出现别的 World 的包名（cortico-world-*，自己的除外）
 *   2. src/ 下不读 imggen-library / feast 的数据目录
 *   3. src/ 下不 import 任何非 node: 内置、非本包的文件
 *   4. src/ 下不出现坐标/路线/距离字段名（不带路线那条红线）
 *   5. src/ 下不出现「读的场景库」这类越界（本插件只认字符串 scene）
 *
 * 用法：node tools/check-isolation.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const SELF = 'cortico-world-map';

let failures = 0;
const ok = (cond, what, extra = '') => {
  if (cond) console.log(`  ok   ${what}`);
  else { failures += 1; console.log(`  FAIL ${what}${extra ? ` -> ${extra}` : ''}`); }
};

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

const files = walk(SRC).filter((f) => /\.(js|mjs|json)$/.test(f));
console.log(`检查 ${files.length} 个源文件（src/ 下）`);
console.log('');

/** 只查代码，不查注释：注释里提到 feast 是在解释「为什么不读它」，那是好事。 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 模板文件（ENV_PROMPT.md）单独查：它是提示词，不是代码。 */
const PROMPT = join(SRC, 'ENV_PROMPT.md');

console.log('1) 不出现别的 World 的包名');
for (const f of files) {
  if (!/\.(js|mjs)$/.test(f)) continue;
  const code = stripComments(readFileSync(f, 'utf8'));
  const rel = relative(ROOT, f);
  const hit = [...code.matchAll(/cortico-world-[\w-]+/g)].map((m) => m[0]);
  const foreign = hit.filter((name) => name !== SELF);
  ok(!foreign.length, `${rel} 没有引用别的 World 包名`, foreign.join(', '));
}

console.log('2) 不读别人的数据目录 / 素材库');
for (const f of files) {
  const code = stripComments(readFileSync(f, 'utf8'));
  const rel = relative(ROOT, f);
  for (const pattern of [/imggen-library/, /['"]feast['"]\s*[,\]]/, /feast\/state\.json/, /feast\/life/, /scenes\//]) {
    ok(!pattern.test(code), `${rel} 没有碰 ${pattern}`, '');
  }
}

console.log('3) 只 import node: 内置或本包内的文件');
const ALLOWED = new Set(['node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:zlib', 'node:os', 'node:crypto']);
for (const f of files) {
  if (!/\.(js|mjs)$/.test(f)) continue;
  const code = stripComments(readFileSync(f, 'utf8'));
  const rel = relative(ROOT, f);
  const specs = [
    ...[...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  const bad = specs.filter((s) => !ALLOWED.has(s) && !s.startsWith('.'));
  ok(!bad.length, `${rel} 的 import 都在白名单内`, bad.join(', '));
}

console.log('4) 源代码里没有坐标 / 路线 / 距离字段（不带路线那条红线）');
/**
 * 会构成 geo 的字段名。**注意 `scene` 不在里面**——那是生图素材库的正名，
 * 是允许的（也是唯一允许的「外部名字」）。`terrain` 也不在：那是「这套骨架来自
 * 哪个预设地形」，不是地理位置。
 */
const GEO_FIELD = /\b(lat|lng|lon|latitude|longitude|coords?|coordinates|geojson|bbox|route|routes|polyline|distance|dist|eta|bearing|heading|navigation|navigate|waypoints?)\b\s*[:=]/i;
for (const f of files) {
  if (!/\.(js|mjs)$/.test(f)) continue;
  const code = stripComments(readFileSync(f, 'utf8'));
  const rel = relative(ROOT, f);
  // 判定函数自己（places.js 的守门、测试）会提到这些词，但它们用的是字符串数组，
  // 不是 `key: value` 形式；上面那条正则要求后面跟 `:` 或 `=`，所以不会误伤。
  ok(!GEO_FIELD.test(code), `${rel} 没有 geo 字段`, GEO_FIELD.exec(code)?.[0] ?? '');
}

console.log('5) 提示词里不教她写路线');
{
  const prompt = readFileSync(PROMPT, 'utf8');
  // 提示词里的路线字眼只许出现在否定语境（不 / 别 / 没有 / 无）。
  const GEO_WORDS = /路线|导航|坐标|经纬|公里|千米|多远|左转|右转|直走|沿路|车程/;
  const bad = prompt.split('\n').filter((line) => GEO_WORDS.test(line) && !/不|别|没有|无/.test(line));
  ok(!bad.length, 'ENV_PROMPT.md 里的路线字眼都在否定语境里', bad.join(' | ').slice(0, 120));
  // 三条互指必须真在文件里：这是联动的骨架，删了就断。
  for (const [needle, why] of [
    ['map_places', '指向地点清单'],
    ['map_look', '指向看某一处'],
  ]) {
    ok(prompt.includes(needle), `ENV_PROMPT 里写了 ${needle}（${why}）`);
  }
}

console.log('');
if (failures) {
  console.log(`X ${failures} 项没过——这个插件偷偷依赖了别的 World，或者偷偷带上了路线`);
  process.exit(1);
}
console.log('隔离审计通过：没有运行时依赖别的 World，也没有路线/坐标/距离');
