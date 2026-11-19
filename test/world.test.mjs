/**
 * 小地图 World 的测试：工具回执、提示词注入、静默降级、纯 create、配置补齐。
 *
 * 本文件重点钉「三道条件」和「降级」——也就是方案 §4 / §5 里最容易悄悄坏掉的那几条：
 *
 *   A. 出图那句只在 ①mapImggenOn 开 ②worlds.imggen.enabled===true ③scene 非空
 *      **三条全满足**时出现；缺任意一条 → 整段不出现，且**绝不出现 imggen_draw / scene 字样**。
 *   B. 读 config 全程不抛错（config 缺失 / 坏 JSON / 200ms 重试）。
 *   C. `envPromptVars()` 在没 start、目录不存在、全是坏数据时都不抛错。
 *   D. 回执里不出现路线/坐标/距离字眼（需求红线的第二道守门）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { test, report } from './harness.mjs';
import { DEFAULTS, LABEL } from '../src/config.js';
import {
  MapWorld, MAP_TOOL_DECLS, configCandidates, decodeDataUrl, readImggenEnabled, readWorldEnabled,
  sniffImage,
} from '../src/world.js';
import { applyTerrain } from '../src/state.js';
import { terrainPlaces } from '../src/places.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.parse('2026-11-15T14:00:00+08:00');

/** 会出现在回执上的路线/远近字眼。 */
const GEO_WORDS = /路线|导航|坐标|经纬|公里|千米|多远|左转|右转|直走|沿路|车程/;

let seq = 0;
const run = `${process.pid}-${Date.now().toString(36)}`;

/**
 * 造一个数据目录：`<root>/data/home/companion`。
 *
 * `readImggenEnabled` 按 `<dataDir>/../config.json` 找（照 funlink 的 `readFunEnabled`），
 * 所以 config 要落在 `<root>/data/home/config.json`。真机就是这个形状。
 */
async function makeDataDir(worlds = null) {
  const root = await mkdtemp(join(tmpdir(), `map-${run}-${seq += 1}-`));
  const dataDir = join(root, 'data', 'home', 'companion');
  await mkdir(dataDir, { recursive: true });
  if (worlds !== null) {
    await writeFile(join(dataDir, '..', 'config.json'), JSON.stringify({ worlds }, null, 2), 'utf8');
  }
  return dataDir;
}

/** 一个够用的假宿主。 */
function makeHost() {
  const logged = [];
  return {
    logged,
    log: {
      info: (m, meta) => logged.push(['info', m, meta]),
      warn: (m, meta) => logged.push(['warn', m, meta]),
      error: (m) => logged.push(['error', m]),
      debug() {},
    },
  };
}

/**
 * 起一个 World。
 *
 * `imggen` / `feast` / `fun` 传 `true` / `false` 决定写入对应的 `worlds.<id>.enabled`；
 * `null` = 不写那个段（模拟没装 / 读不到）。
 */
async function makeWorld({
  cfg = {}, imggen = null, feast = null, fun = null, terrain = '', started = true, now = () => NOW,
} = {}) {
  const worlds = {};
  if (imggen !== null) worlds.imggen = { enabled: imggen };
  if (feast !== null) worlds.feast = { enabled: feast };
  if (fun !== null) worlds.fun = { enabled: fun };
  const dataDir = await makeDataDir(Object.keys(worlds).length ? worlds : null);
  const host = makeHost();
  const world = new MapWorld({
    cfg: { ...DEFAULTS, enabled: true, ...cfg },
    dataDir,
    timezone: TZ,
    now,
    persist: () => {},
  });
  if (started) await world.start(host);
  const tools = Object.fromEntries(world.tools().map((t) => [t.name, t.handler]));
  if (terrain) {
    const r = await world.webUi('zh').invoke('places', 'terrain', [{ id: terrain }]);
    assert.equal(r.ok, true, `建地形 ${terrain} 失败：${r.error}`);
  }
  return { world, host, tools, dataDir };
}

// ===========================================================================
// 入口形状 / defaults / create 纯度
// ===========================================================================

test('入口形状：六工具、零事件、id=map、label 是定稿的「鱼的小世界」', async () => {
  const def = (await import('../src/index.js')).default;
  assert.equal(def.id, 'map', 'world id 必须是 map（maplink 契约靠它）');
  assert.equal(def.label, LABEL);
  assert.equal(MAP_TOOL_DECLS.length, 6, '方案 §6 是 6 个工具');
  assert.deepEqual(MAP_TOOL_DECLS.map((t) => t.name).sort(), [
    'map_add', 'map_cover', 'map_edit', 'map_look', 'map_places', 'map_view',
  ]);
  assert.deepEqual(def.describe.events, [], '不推任何事件');
  assert.equal(def.describe.tools.length, 6);
  // 每个工具都要有给人看的 summary（市场用）
  for (const t of def.describe.tools) {
    assert.ok(t.summary?.zh, `${t.name} 缺 summary`);
  }
});

test('defaults：enabled 恒 false，配置就是那五项（+enabled）', async () => {
  const def = (await import('../src/index.js')).default;
  const d = def.defaults();
  assert.equal(d.enabled, false, '启用由部署决定，定义里恒为 false');
  assert.deepEqual(
    Object.keys(d).sort(),
    ['enabled', 'mapFeastOn', 'mapFunOn', 'mapImggenOn', 'mapOn', 'mapStyleRef'],
  );
  assert.equal(d.mapOn, true);
  assert.equal(d.mapImggenOn, true);
  assert.equal(d.mapFeastOn, true, '鱼的每一天联动开关默认开');
  assert.equal(d.mapFunOn, true, '娱乐时间联动开关默认开');
  assert.equal(d.mapStyleRef, '', '整图样式参考默认空');
  // 每次给新对象，不改共享 DEFAULTS
  const d2 = def.defaults();
  assert.notEqual(d, d2);
  assert.equal(DEFAULTS.mapOn, true);
  def.preflight({ cfg: {} });
});

test('create() 必须是纯的：不读盘、不建目录、不启定时器', async () => {
  const def = (await import('../src/index.js')).default;
  const pureDir = await mkdtemp(join(tmpdir(), `map-pure-${run}-`));
  const ghost = def.create({
    cfg: {}, dataDir: pureDir, timezone: TZ,
    persist: () => { throw new Error('create 期间不该 persist'); },
  });
  assert.ok(ghost instanceof MapWorld);
  assert.deepEqual(await readdir(pureDir), [], 'create 之后目录还是空的');
});

// ===========================================================================
// readImggenEnabled：只读一个布尔字段
// ===========================================================================

test('readImggenEnabled：true/false/没有这个段/没 config 都不抛错', async () => {
  assert.equal(await readImggenEnabled(await makeDataDir({ imggen: { enabled: true } })), true);
  assert.equal(await readImggenEnabled(await makeDataDir({ imggen: { enabled: false } })), false);
  assert.equal(await readImggenEnabled(await makeDataDir({ imggen: {} })), false);
  assert.equal(await readImggenEnabled(await makeDataDir({ fun: { enabled: true } })), false,
    '只有 imggen 的 enabled，别的世界的 enabled 不算');
  assert.equal(await readImggenEnabled(await makeDataDir(null)), false, '没有 config 时 false');
  // 只认布尔 true：字符串 "true" 不算
  assert.equal(await readImggenEnabled(await makeDataDir({ imggen: { enabled: 'true' } })), false);
});

// ---------------------------------------------------------------------------
// config.json 的两个位置都得认（真机 bug：只认 dataDir/.. 会永远读不到）
// ---------------------------------------------------------------------------

test('config 就在 dataDir 里时也读得到（真机布局）', async () => {
  // 2026-11-15 实测：真机是 <dataDir>/config.json（E:\Coopanion\data\home\companion\config.json），
  // 不是 <dataDir>/../config.json。只认后者会让三个联动在真机上永远不出现，且没有任何报错。
  const root = await mkdtemp(join(tmpdir(), `map-cfg-in-${run}-`));
  const dataDir = join(root, 'companion');
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({
    worlds: { imggen: { enabled: true }, feast: { enabled: true }, fun: { enabled: true } },
  }), 'utf8');
  assert.equal(await readWorldEnabled(dataDir, 'imggen'), true, 'dataDir/config.json 该读得到');
  assert.equal(await readWorldEnabled(dataDir, 'feast'), true);
  assert.equal(await readWorldEnabled(dataDir, 'fun'), true);
});

test('config 在 dataDir 上一层时也读得到（funlink 假设的布局）', async () => {
  // 保持和 feed-world/src/life/funlink.js 兼容：那边假设 <dataDir>/../config.json。
  const dataDir = await makeDataDir({ feast: { enabled: true } });
  assert.equal(await readWorldEnabled(dataDir, 'feast'), true);
});

test('两个位置都没有时返回 false，不抛错', async () => {
  const root = await mkdtemp(join(tmpdir(), `map-cfg-none-${run}-`));
  const dataDir = join(root, 'companion');
  await mkdir(dataDir, { recursive: true });
  assert.equal(await readWorldEnabled(dataDir, 'feast'), false);
  assert.equal(await readWorldEnabled(dataDir, ''), false, '空 worldId 直接 false');
});

test('configCandidates 按优先级给出两个路径', () => {
  const list = configCandidates('E:\\x\\companion');
  assert.equal(list.length, 2);
  assert.ok(list[0].endsWith('companion\\config.json') || list[0].endsWith('companion/config.json'), list[0]);
  // join() 会把 `..` 规范化掉，所以第二个是解析后的**父目录**，不是字面带 `..` 的字符串。
  assert.ok(list[1].endsWith('x\\config.json') || list[1].endsWith('x/config.json'), list[1]);
  assert.notEqual(list[0], list[1], '两个候选不能是同一个路径');
});

test('readImggenEnabled：坏 JSON 也不抛（重试一次后降级）', async () => {
  const dataDir = await makeDataDir(null);
  await writeFile(join(dataDir, '..', 'config.json'), '{ 这不是 json', 'utf8');
  assert.equal(await readImggenEnabled(dataDir), false);
});

// ===========================================================================
// envPromptVars：不抛错、两个占位符分开
// ===========================================================================

test('envPromptVars：没 start 也能调，不抛错，三个键都在', async () => {
  const world = new MapWorld({ cfg: { ...DEFAULTS }, dataDir: await makeDataDir(null), timezone: TZ });
  const v = world.envPromptVars();
  assert.deepEqual(Object.keys(v).sort(), ['map_feast_block', 'map_imggen_block', 'map_places_block']);
  assert.equal(v.map_places_block, '', '还没 start 就是空串');
  assert.equal(v.map_imggen_block, '');
  assert.equal(v.map_feast_block, '');
});

test('envPromptVars：只列当前住所及常去正名，不列普通地点', async () => {
  const { world } = await makeWorld({ imggen: false, terrain: 'forest' });
  assert.equal((await world.webUi('zh').invoke('places', 'setHome', [{ id: 'forest-home' }])).ok, true);
  const v = world.envPromptVars();
  assert.ok(!v.map_places_block.includes('溪边'), v.map_places_block);
  assert.ok(v.map_places_block.includes('forest-home'));
  assert.ok(v.map_places_block.includes('家'));
  assert.match(v.map_places_block, /5/);
  assert.equal(v.map_imggen_block, '', '没装生图 → 那句整段不出现');
  assert.ok(!v.map_places_block.includes('imggen_draw'), '没装就一个字都不提生图');
  assert.ok(!v.map_places_block.includes('scene'), '没装就不该出现 scene 这个词');
});

test('envPromptVars：mapOn 关掉 → 地点清单空串（工具还在）', async () => {
  const { world, tools } = await makeWorld({ cfg: { mapOn: false }, imggen: false, terrain: 'forest' });
  assert.equal(world.envPromptVars().map_places_block, '');
  const r = await tools.map_places({});
  assert.ok(r.text.includes('溪边'), '地图关了工具照样能用');
});

test('envPromptVars：mapOn 关掉时发图那句也必须空（它引用「上面」那份清单）', async () => {
  // 三条条件都成立，但清单被 mapOn 关掉了——那句「填上面写明的那个正名」就成了悬空指代。
  const { world, tools } = await makeWorld({ cfg: { mapOn: false }, imggen: true, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  const v = world.envPromptVars();
  assert.equal(v.map_places_block, '');
  assert.equal(v.map_imggen_block, '', '没清单就不该有「填上面那个」');
  assert.ok(!v.map_imggen_block.includes('上面'));
});

test('envPromptVars：数据烂成什么样都不抛错', async () => {
  const dataDir = await makeDataDir(null);
  const world = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir, timezone: TZ });
  await world.start(makeHost());
  await mkdir(join(dataDir, 'map'), { recursive: true });
  await writeFile(world.stateFile(), '{ "places": "不是数组" ', 'utf8');
  const world2 = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir, timezone: TZ });
  await world2.start(makeHost());
  assert.doesNotThrow(() => world2.envPromptVars());
});

// ===========================================================================
// 三道条件：出图那句到底出不出现
// ===========================================================================

test('三道条件全满足 → map_look 递「scene 填「溪边」」', async () => {
  // 装了生图 + 装了鱼的每一天：两半句都能说
  const { world, tools } = await makeWorld({ imggen: true, feast: true, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  const r = await tools.map_look({ place: '溪边' });
  assert.ok(r.text.includes('imggen_draw'), `该递发图那句：\n${r.text}`);
  assert.ok(r.text.includes('scene'), '该说 scene 填什么');
  assert.ok(r.text.includes('「溪边」'), '该点名正名');
  assert.ok(r.text.includes('feast_life_now'), 'feast 也装了才该指向 feast_life_now 那身');
  assert.equal(world.canMentionImggen({ scene: '溪边' }), true);
});

test('生图装了但鱼的每一天没装：只提 scene，不提 feast_life_now', async () => {
  const { tools } = await makeWorld({ imggen: true, feast: false, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  const r = await tools.map_look({ place: '溪边' });
  assert.ok(r.text.includes('imggen_draw'), '生图装了就该提 scene');
  assert.ok(!r.text.includes('feast_life_now'), `没装 feast 就不许指向 feast_life_now：\n${r.text}`);
  assert.ok(r.text.includes('按你这会儿真穿的那身填'), '要给出不依赖 feast 的说法');
});

test('条件① mapImggenOn 关掉 → 即使装了生图、scene 也非空，整段不出现', async () => {
  const { world, tools } = await makeWorld({ cfg: { mapImggenOn: false }, imggen: true, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  const r = await tools.map_look({ place: '溪边' });
  assert.ok(!r.text.includes('imggen_draw'), `关了开关就不许提：\n${r.text}`);
  assert.ok(!r.text.includes('scene'), '连 scene 这个词都不该出现');
  assert.equal(world.canMentionImggen({ scene: '溪边' }), false);
  // 但文字描写照旧
  assert.ok(r.text.includes('一条很浅的溪'), '文字描写必须还在');
});

test('条件② 没装生图（读不到 worlds.imggen.enabled）→ 整段不出现', async () => {
  const { world, tools } = await makeWorld({ imggen: null, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  const r = await tools.map_look({ place: '溪边' });
  assert.ok(!r.text.includes('imggen_draw'), `没装就不许提：\n${r.text}`);
  assert.ok(!r.text.includes('scene'));
  assert.equal(world.canMentionImggen({ scene: '溪边' }), false);
});

test('条件② 装了但 enabled=false → 整段不出现', async () => {
  const { world, tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  const r = await tools.map_look({ place: '溪边' });
  assert.ok(!r.text.includes('imggen_draw'), `停用就不许提：\n${r.text}`);
  assert.equal(world.canMentionImggen({ scene: '溪边' }), false);
});

test('条件③ scene 空（库里没有）→ 整段不出现，且不编场景名', async () => {
  const { world, tools } = await makeWorld({ imggen: true, terrain: 'forest' });
  // 装了生图、开关也开着，但这处没有 scene
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪' });
  const r = await tools.map_look({ place: '溪边' });
  assert.ok(!r.text.includes('imggen_draw'), `scene 空就不许提：\n${r.text}`);
  assert.ok(!r.text.includes('scene'));
  assert.equal(world.canMentionImggen({ scene: '' }), false);
  assert.equal(world.canMentionImggen({ name: '溪边' }), false, '绝不拿名字兜成 scene');
});

test('预设骨架出厂时一处都不提生图（四套地形 × 装了生图）', async () => {
  for (const terrain of ['forest', 'neighborhood', 'riverside', 'foothill']) {
    const { world, tools } = await makeWorld({ imggen: true, terrain });
    assert.equal(world.envPromptVars().map_imggen_block, '', `${terrain}：骨架没有 scene，那句不该出现`);
    const view = await tools.map_view({});
    assert.ok(!view.text.includes('imggen_draw'), `${terrain}：map_view 不该提生图`);
    assert.ok(!view.text.includes('scene'), `${terrain}：map_view 不该出现 scene`);
  }
});

test('一处有 scene、另一处没有：只有那处提，另一处不提', async () => {
  const { tools } = await makeWorld({ imggen: true, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  await tools.map_edit({ place: '老橡树', desc: '一棵很粗的树' });
  const withScene = await tools.map_look({ place: '溪边' });
  const without = await tools.map_look({ place: '老橡树' });
  assert.ok(withScene.text.includes('imggen_draw'));
  assert.ok(!without.text.includes('imggen_draw'), `老橡树没有 scene，不该提：\n${without.text}`);
});

// ===========================================================================
// 工具回执
// ===========================================================================

test('map_places：空地图给的是「怎么开始」，不是报错', async () => {
  const { tools } = await makeWorld({ imggen: false });
  const r = await tools.map_places({});
  assert.ok(!r.failed, r.text);
  assert.ok(r.text.includes('空的'), r.text);
  assert.ok(r.text.includes('预设地形') || r.text.includes('map_add'), '该告诉她怎么开始');
});

test('map_places：小地图默认一页、kind 筛、认不出的 kind 给提示', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const all = await tools.map_places({});
  assert.ok(all.text.includes('溪边') && all.text.includes('老橡树'), all.text);
  assert.ok(all.text.includes('5'), `该报总数：\n${all.text}`);

  const home = await tools.map_places({ kind: '家' });
  assert.ok(home.text.includes('家'), home.text);
  assert.ok(!home.text.includes('溪边'), `只看「家」时不该列溪边：\n${home.text}`);

  const bad = await tools.map_places({ kind: '火星' });
  assert.ok(bad.text.includes('没有'), bad.text);
});

/** 从索引条目取 id，不把页码、提示文字当作地点。 */
function listedIds(text) {
  return [...text.matchAll(/^- .*?（id=([^）]+)）/gm)].map((match) => match[1]);
}

async function makePagedWorld() {
  const ctx = await makeWorld({ terrain: 'forest' });
  for (const terrain of ['neighborhood', 'riverside', 'foothill', 'travel']) {
    assert.equal((await ctx.world.webUi('zh').invoke('places', 'terrain', [{ id: terrain }])).ok, true);
  }
  return ctx;
}

test('map_places：默认十条、末页、越界、最大二十条及 all 兼容', async () => {
  const { tools } = await makePagedWorld();
  const first = await tools.map_places({});
  const second = await tools.map_places({ page: 2 });
  const last = await tools.map_places({ page: 3 });
  assert.equal(listedIds(first.text).length, 10);
  assert.equal(listedIds(second.text).length, 10);
  assert.equal(listedIds(last.text).length, 5);
  assert.match(first.text, /匹配 25 处/);
  assert.match(first.text, /下一页.*page=2.*limit=10/);
  assert.doesNotMatch(last.text, /下一页/);
  const all = await tools.map_places({ all: true });
  assert.equal(listedIds(all.text).length, 25);
  assert.deepEqual([...listedIds(first.text), ...listedIds(second.text), ...listedIds(last.text)], listedIds(all.text));
  assert.doesNotMatch(all.text, /下一页/);
  assert.equal(listedIds((await tools.map_places({ limit: 20 })).text).length, 20);
  assert.equal(listedIds((await tools.map_places({ page: 2, limit: 20 })).text).length, 5);
  assert.equal(listedIds((await tools.map_places({ page: 25, limit: 1 })).text).length, 1);
  const outside = await tools.map_places({ page: 4 });
  assert.equal(listedIds(outside.text).length, 0);
  assert.match(outside.text, /25.*3/);
  assert.match(outside.text, /page/);
  const view = await tools.map_view({});
  const names = [...all.text.matchAll(/^- (.*?)（id=/gm)].map((match) => match[1]);
  const viewNames = [...view.text.matchAll(/^[·★] (.*?)：/gm)].map((match) => match[1]);
  assert.deepEqual(viewNames.sort(), names.sort(), '整图完整展示所有地点，包括同名住所');
  for (const group of ['家', '周围', '旅行']) assert.ok(view.text.includes(`【${group}】`));
});

test('map_places：非法 page/limit 给明确失败文字', async () => {
  const { tools } = await makeWorld({ terrain: 'forest' });
  for (const field of ['page', 'limit']) {
    const invalid = [0, -1, 1.5, '2', true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
    if (field === 'limit') invalid.push(21);
    for (const value of invalid) {
      const r = await tools.map_places({ [field]: value });
      assert.match(r.text, /失败/, `${field}=${String(value)}`);
      assert.ok(r.text.includes(field), r.text);
      assert.equal(listedIds(r.text).length, 0);
    }
  }
});

test('map_places：kind、tag、relatedTo 先筛选再分页，all 仍遵守筛选', async () => {
  const { world, tools } = await makePagedWorld();
  const places = (await world.webUi('zh').invoke('places', 'list')).places;
  const selected = places.filter((p) => p.kind === 'around').slice(0, 7);
  for (const p of selected) await tools.map_edit({ place: p.id, tags: ['青苔'], relations: [{ placeId: 'travel-seaside-town', note: '共享相册记忆' }] });
  for (const filter of [{ kind: 'around' }, { tag: '青苔' }, { relatedTo: 'travel-seaside-town' }, { kind: 'around', tag: '青苔', relatedTo: 'travel-seaside-town' }]) {
    const all = await tools.map_places({ ...filter, all: true });
    const ids = listedIds(all.text);
    assert.equal(ids.length, filter.tag || filter.relatedTo ? 7 : 16);
    const combined = [];
    for (let page = 1; page <= Math.ceil(ids.length / 3); page += 1) {
      const r = await tools.map_places({ ...filter, page, limit: 3 });
      assert.ok(r.text.includes(`匹配 ${ids.length} 处`), r.text);
      combined.push(...listedIds(r.text));
    }
    assert.deepEqual(combined, ids, '过滤后页间不能重复或遗漏');
  }
  const none = await tools.map_places({ tag: '不存在的标签' });
  assert.equal(listedIds(none.text).length, 0);
  assert.match(none.text, /没有/);
});

test('map_look：没写描写时明说空着，绝不替主人编', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const r = await tools.map_look({ place: '溪边' });
  assert.ok(r.text.includes('还没写描写'), r.text);
  assert.ok(r.text.includes('别替') || r.text.includes('不知道'), '要明确说别编');
});

test('map_look：没图时明说没图，有图时说文件名', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  assert.ok((await tools.map_look({ place: '溪边' })).text.includes('还没图'));

  // 挂一张真实存在的图（写盘 + setCover 都走同一个入口）
  const { world, dataDir } = await makeWorld({ imggen: false, terrain: 'forest' });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const dir = join(dataDir, 'map', 'covers');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'forest-creek.png'), png);
  const up = await world.webUi('zh').invoke('places', 'upload', [{ id: 'forest-creek', data: `data:image/png;base64,${png.toString('base64')}` }]);
  assert.equal(up.ok, true, up.error);
  const w2 = Object.fromEntries(world.tools().map((t) => [t.name, t.handler]));
  const r = await w2.map_look({ place: '溪边' });
  assert.ok(r.text.includes(up.cover), r.text);
  assert.ok(r.text.includes('有图'), r.text);
});

test('map_look：找不到那一处时列出有的地名，不抛错', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const r = await tools.map_look({ place: '火星基地' });
  assert.ok(r.text.includes('没有'), r.text);
  assert.ok(r.text.includes('溪边'), '该给出现有的地名');
  assert.ok(!r.failed, '找不到不是工具失败');
});

test('map_look：空地图时给的是「先建地图」，不是崩溃', async () => {
  const { tools } = await makeWorld({ imggen: false });
  const r = await tools.map_look({ place: '家' });
  assert.ok(!r.failed, r.text);
  assert.ok(r.text.includes('空的'), r.text);
});

test('map_add：只填文字就能加，回执里带归类', async () => {
  const { tools } = await makeWorld({ imggen: false });
  const r = await tools.map_add({ name: '旧码头', kind: '常去的', desc: '木板上有个洞', style: '水彩，灰蓝' });
  assert.ok(r.text.includes('旧码头'), r.text);
  assert.ok(r.text.includes('常去的'), r.text);
  assert.ok(r.text.includes('木板上有个洞'), r.text);
  // 加进去之后 map_places 看得到
  assert.ok((await tools.map_places({})).text.includes('旧码头'));
});

test('map_add：重名 / 没名字都给一句人话，不抛错', async () => {
  const { tools } = await makeWorld({ imggen: false });
  await tools.map_add({ name: '旧码头' });
  const dup = await tools.map_add({ name: '旧码头' });
  assert.ok(dup.text.includes('已经有一处'), dup.text);
  assert.ok(!dup.failed);
  const empty = await tools.map_add({});
  assert.ok(!empty.failed, '没名字也不该 failed');
  assert.ok(empty.text.length > 5);
});

test('map_add：就算模型硬塞坐标也不进状态（红线）', async () => {
  const { world, tools, dataDir } = await makeWorld({ imggen: false });
  await tools.map_add({ name: '某处', desc: '一句话' });
  // 工具声明里没有 geo 参数，模型多塞的字段会被 handler 丢掉
  const raw = JSON.parse(await (await import('node:fs/promises')).readFile(world.stateFile(), 'utf8'));
  for (const p of raw.places) {
    for (const key of ['lat', 'lng', 'route', 'distance', 'geo', 'coords']) {
      assert.ok(!(key in p), `${p.id} 落盘时不该有「${key}」`);
    }
  }
  assert.ok(dataDir);
});

test('map_edit：只改传进来的项，没传的不动', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', style: '水彩' });
  const r = await tools.map_edit({ place: '溪边', frequent: true });
  assert.ok(r.text.includes('常去'), r.text);
  const look = await tools.map_look({ place: '溪边' });
  assert.ok(look.text.includes('一条很浅的溪'), '第二次只改常去，描写不该被冲掉');
  assert.ok(look.text.includes('★'), '常去要标出来');
});

test('map_edit：什么都没说要改时给提示，不假装改了', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const r = await tools.map_edit({ place: '溪边' });
  assert.ok(r.text.includes('没说要改什么'), r.text);
});

test('map_cover：没图时说明要主人上传；清空后可以再放', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const r = await tools.map_cover({ place: '溪边' });
  assert.ok(r.text.includes('没有图'), r.text);
  assert.ok(r.text.includes('面板'), '要说清楚图是主人从面板传的');

  const cleared = await tools.map_cover({ place: '溪边', clear: true });
  assert.ok(cleared.text.includes('本来就没有图'), cleared.text);
});

test('map_cover：file 填一个不存在的名字 → 明确说找不到，不凭空挂上', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const r = await tools.map_cover({ place: '溪边', file: 'creek.png' });
  assert.ok(r.text.includes('没找到'), r.text);
  assert.ok(r.text.includes('面板'), '要指向正确的做法');
});

test('map_view：分组铺开，不带路线连线', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const r = await tools.map_view({});
  assert.ok(r.text.includes('【家】'), r.text);
  assert.ok(r.text.includes('【周围】'), r.text);
  assert.ok(r.text.includes('5'), '该报总数');
  assert.ok(!GEO_WORDS.test(r.text), `不该出现路线字眼：\n${r.text}`);
});

test('map_view：空地图给一句话，不崩', async () => {
  const { tools } = await makeWorld({ imggen: false });
  const r = await tools.map_view({});
  assert.ok(r.text.includes('空的'), r.text);
});

// ===========================================================================
// 红线：回执里不出现路线 / 坐标 / 距离
// ===========================================================================

test('map_add：填了 scene 但三条不全满足时，回执里不念出那个名字', async () => {
  const { tools } = await makeWorld({ imggen: false });
  const r = await tools.map_add({ name: '某处', desc: '一句话', scene: '某个场景' });
  assert.ok(!r.text.includes('某个场景'), `没装生图就不该念 scene 的名字：\n${r.text}`);
  assert.ok(!r.text.includes('imggen_draw'));
  // 装了之后同一个操作就该念出来
  const { tools: t2 } = await makeWorld({ imggen: true });
  const r2 = await t2.map_add({ name: '某处', desc: '一句话', scene: '某个场景' });
  assert.ok(r2.text.includes('某个场景'), `装了就该念：\n${r2.text}`);
});

test('map_edit：改 scene 但三条不全满足时，说明「这会儿用不上」且不念名字', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  const r = await tools.map_edit({ place: '溪边', scene: '某个场景' });
  assert.ok(!r.text.includes('某个场景'), `不该念名字：\n${r.text}`);
  assert.ok(r.text.includes('等装了生图'), `该解释为什么这会儿不说：\n${r.text}`);
});

test('真值表：三条件 8 种组合，只有全真才提（把「三条全满足」钉成矩阵）', async () => {
  // 这一条比上面几条「逐条否定」更硬：它把 8 种组合全跑一遍，
  // 任何一条以后被改松了、或者被改成「或」，这里立刻红。
  for (const imggenWanted of [true, false]) {
    for (const installed of [true, false]) {
      for (const hasSceneFlag of [true, false]) {
        const { tools } = await makeWorld({
          cfg: { mapImggenOn: imggenWanted },
          imggen: installed ? true : null,
          terrain: 'forest',
        });
        await tools.map_edit({ place: '溪边', desc: '一段描写', ...(hasSceneFlag ? { scene: '溪边' } : {}) });
        const r = await tools.map_look({ place: '溪边' });
        const mentioned = /imggen_draw/.test(r.text);
        const expect = imggenWanted && installed && hasSceneFlag;
        assert.equal(mentioned, expect,
          `mapImggenOn=${imggenWanted} installed=${installed} scene=${hasSceneFlag}：`
          + `应当${expect ? '' : '不'}提，实际${mentioned ? '' : '没'}提`);
      }
    }
  }
});

// ===========================================================================
// 「鱼的每一天」联动：mapFeastOn + worlds.feast.enabled + 有地点
// ===========================================================================

test('feast 真值表：开关 + 装没装 + 有没有地点，三个都真才提 feast_life_*', async () => {
  for (const wanted of [true, false]) {
    for (const installed of [true, false]) {
      for (const withPlace of [true, false]) {
        const { world, tools } = await makeWorld({
          cfg: { mapFeastOn: wanted },
          feast: installed ? true : null,
          terrain: withPlace ? 'forest' : '',
        });
        const block = world.envPromptVars().map_feast_block;
        const mentioned = block.includes('feast_life_plan') || block.includes('feast_life_now');
        const expect = wanted && installed && withPlace;
        assert.equal(mentioned, expect,
          `mapFeastOn=${wanted} installed=${installed} hasPlace=${withPlace}：`
          + `应当${expect ? '' : '不'}提，实际提了=${mentioned}`);
        // 另外：任何情况下都不许提 imggen_draw 在这块里
        assert.ok(!block.includes('imggen_draw'), 'feast 那块不该夹带生图');
        void tools;
      }
    }
  }
});

test('mapFeastOn 关掉 → 回执和提示词里一个字都不提 feast_life_*', async () => {
  const { world, tools } = await makeWorld({
    cfg: { mapFeastOn: false }, feast: true, imggen: true, terrain: 'forest',
  });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
  assert.equal(world.envPromptVars().map_feast_block, '');
  const look = await tools.map_look({ place: '溪边' });
  assert.ok(!look.text.includes('feast_life_now'), `关了开关就不许指向 feast：\n${look.text}`);
  const view = await tools.map_view({});
  assert.ok(!view.text.includes('feast_life'), `map_view 也不许：\n${view.text}`);
});

test('没装鱼的每一天 → ENV_PROMPT 注入块里没有 feast_life_*', async () => {
  const { world } = await makeWorld({ feast: null, imggen: false, terrain: 'forest' });
  const v = world.envPromptVars();
  assert.equal(v.map_feast_block, '');
  assert.ok(!`${v.map_places_block}${v.map_imggen_block}`.includes('feast_life'),
    '没装就整段不提，绝不指向不存在的工具');
});

// ===========================================================================
// 「娱乐时间」联动：mapFunOn + worlds.fun.enabled + funVenue 非空
// ===========================================================================

test('fun 真值表：开关 + 装没装 + 有没有 funVenue，三个都真才提 fun_go', async () => {
  for (const wanted of [true, false]) {
    for (const installed of [true, false]) {
      for (const withVenue of [true, false]) {
        const { tools } = await makeWorld({
          cfg: { mapFunOn: wanted },
          fun: installed ? true : null,
          terrain: 'travel',
        });
        // 旅游骨架自带 funVenue；不想要就把那处清空
        const target = '海边小镇';
        if (!withVenue) await tools.map_edit({ place: target, funVenue: '' });
        const r = await tools.map_look({ place: target });
        const mentioned = r.text.includes('fun_go');
        const expect = wanted && installed && withVenue;
        assert.equal(mentioned, expect,
          `mapFunOn=${wanted} installed=${installed} funVenue=${withVenue}：`
          + `应当${expect ? '' : '不'}提，实际提了=${mentioned}`);
        // 没满足就一定不许出现 fun_go 或 fun_places
        if (!expect) {
          assert.ok(!r.text.includes('fun_go'), `不该出现 fun_go：\n${r.text}`);
          assert.ok(!r.text.includes('fun_places'), `不该出现 fun_places：\n${r.text}`);
        }
      }
    }
  }
});

test('旅游那处：提 fun_go 时明说「最接近的一处、不是同一个地方」', async () => {
  const { tools } = await makeWorld({ fun: true, terrain: 'travel' });
  const r = await tools.map_look({ place: '海边小镇' });
  assert.ok(r.text.includes('fun_go'), r.text);
  assert.ok(r.text.includes('江边'), '该点名「江边」');
  assert.ok(r.text.includes('最接近'), `必须说清是最接近的一处，不能假装同一个地方：\n${r.text}`);
  assert.ok(/不是同一个地方|别把/.test(r.text), `要防她说成同一个地方：\n${r.text}`);
});

test('居住地形那几处不预置 funVenue，所以永远不提去哪逛', async () => {
  const { tools } = await makeWorld({ fun: true, imggen: true, feast: true, terrain: 'forest' });
  for (const name of ['家', '溪边', '老橡树', '蘑菇坡', '林间空地']) {
    const r = await tools.map_look({ place: name });
    assert.ok(!r.text.includes('fun_go'), `${name} 不该提 fun_go：\n${r.text}`);
  }
});

test('mapFunOn 关掉 → 不许出现 fun_*（装了也不许）', async () => {
  const { world, tools } = await makeWorld({ cfg: { mapFunOn: false }, fun: true, terrain: 'travel' });
  const r = await tools.map_look({ place: '雪山客栈' });
  assert.ok(!r.text.includes('fun_'), `关了开关就不许出现 fun_*：\n${r.text}`);
  const view = await tools.map_view({});
  assert.ok(!view.text.includes('fun_'), `map_view 也不许：\n${view.text}`);
  void world;
});

// ===========================================================================
// 旅游：不带行程
// ===========================================================================

test('守门断言：旅游预设的文案里没有「几天/行程/怎么去/第几天」', async () => {
  const JOURNEY = /几天|行程|怎么去|第[一二三四五]天|去程|回程|车次|航班|住宿几晚|几晚/;
  const { tools } = await makeWorld({ fun: true, imggen: true, feast: true, terrain: 'travel' });
  const { TERRAINS } = await import('../src/places.js');
  const travel = TERRAINS.find((t) => t.id === 'travel');
  // note 可以提到这些词，但必须是在否定它们（「都不在这里」）。
  if (JOURNEY.test(travel.note)) {
    assert.ok(/不|别|没有/.test(travel.note), `旅游预设说明提到了行程却没否定：${travel.note}`);
  }
  // 地点名里一个行程字眼都不许有（那是数据，不是解释）。
  for (const p of travel.places) {
    const blob = [p.name, ...(p.aliases ?? [])].join(' ');
    assert.ok(!JOURNEY.test(blob), `${p.name} 里出现了行程字眼：${blob}`);
  }
  // 回执与整张图：同样只许否定语境。
  for (const name of ['海边小镇', '林间营地']) {
    const r = await tools.map_look({ place: name });
    for (const line of r.text.split('\n')) {
      if (!JOURNEY.test(line)) continue;
      assert.ok(/不|别|没有/.test(line), `map_look 这句提到行程却没否定：${line}`);
    }
  }
  const view = await tools.map_view({});
  for (const line of view.text.split('\n')) {
    if (!JOURNEY.test(line)) continue;
    assert.ok(/不|别|没有/.test(line), `map_view 这句提到行程却没否定：${line}`);
  }
});

// ===========================================================================
// 常驻前缀的 token 预算（发布前实测出来的成本问题）
// ===========================================================================

/** 造一处描写很长的地点，用来验截断。 */
const LONG_DESC = '窗台上有几盆花，光从东边斜进来，地板是旧的木条，踩上去有点响，墙角堆着几个纸箱，'
  + '桌上摊着一本翻到一半的书，杯子里的水凉了，椅背上搭着一条毯子，窗玻璃上有一层灰。';

test('富数据不增加 env 负载，详情、面板与落盘完整保留', async () => {
  const { world, tools } = await makeWorld({ imggen: true, feast: true, terrain: 'forest' });
  await tools.map_edit({ place: 'forest-creek', frequent: true, scene: '原场景' });
  const before = world.envPromptVars();
  const rich = {
    desc: LONG_DESC.repeat(4).slice(0, 400), aliases: ['独有溪水别称'], tags: ['独有青苔标签'],
    style: '独有水墨画风', scene: '独有场景正名',
    relations: [{ placeId: 'forest-home', note: '窗边能看见溪面' }],
  };
  await tools.map_edit({ place: 'forest-creek', ...rich });
  world.cfg.mapStyleRef = '独有世界默认画风';
  assert.deepEqual(world.envPromptVars(), before, '丰富字段不应改变常驻文本');
  assert.match(before.map_imggen_block, /map_look/);
  assert.match(before.map_feast_block, /map_places/);
  const list = (await tools.map_places({ all: true })).text;
  const look = (await tools.map_look({ place: '独有溪水别称' })).text;
  for (const value of [rich.desc, ...rich.aliases, ...rich.tags, rich.style, rich.scene, rich.relations[0].note]) {
    assert.ok(!list.includes(value.slice(0, 20)), `索引不带详情：${value.slice(0, 20)}`);
    assert.ok(look.includes(value), `详情保留：${value.slice(0, 20)}`);
  }
  const saved = JSON.parse(await readFile(world.stateFile(), 'utf8')).places.find((p) => p.id === 'forest-creek');
  const panel = (await world.webUi('zh').invoke('places', 'list')).places.find((p) => p.id === 'forest-creek');
  for (const [key, value] of Object.entries(rich)) {
    assert.deepEqual(saved[key], value, `落盘保留 ${key}`);
    assert.deepEqual(panel[key], value, `面板保留 ${key}`);
  }
});

test('常驻索引：两种常去来源都认，最多五处且排除当前住所', async () => {
  const { world, tools } = await makeWorld({ terrain: 'forest' });
  await world.webUi('zh').invoke('places', 'setHome', [{ id: 'forest-home' }]);
  await tools.map_edit({ place: 'forest-home', frequent: true });
  await tools.map_edit({ place: 'forest-creek', frequent: true });
  await tools.map_edit({ place: 'forest-old-oak', kind: 'frequent', frequent: false });
  let block = world.envPromptVars().map_places_block;
  assert.ok(block.includes('溪边（id=forest-creek）'));
  assert.ok(block.includes('老橡树（id=forest-old-oak）'));
  assert.equal(block.split('id=forest-home').length - 1, 1);
  assert.ok(!block.includes('forest-mushroom-slope'));
  for (let i = 0; i < 8; i += 1) await tools.map_add({ name: `常去补充${i}`, frequent: true });
  block = world.envPromptVars().map_places_block;
  assert.equal(block.split('\n').filter((line) => line.startsWith('- ')).length, 5);
  assert.equal(block.split('id=forest-home').length - 1, 1);
  assert.match(block, /13/);
  assert.match(block, /map_places/);
});

test('守门断言：常驻前缀不随「描写长度」膨胀，且总量有上限', async () => {
  // 两条：
  //   ① 不变量：地点不变，描写从 0 字变 400 字，注入块完全不增长，
  //      不许按描写长度线性膨胀（旧行为：25 处 × 400 字 ≈ 30 KB / 9.4k tokens）；
  //   ② 上限：60 处 × 400 字时仍 ≤ 5 KB。
  const build = async (n, descLen) => {
    const { world, tools } = await makeWorld({ imggen: true, feast: true, terrain: 'forest' });
    const have = (await world.webUi('zh').invoke('places', 'list', [])).places.length;
    for (let i = have; i < n; i += 1) await tools.map_add({ name: `补的${i}号` });
    if (descLen) {
      const all = (await world.webUi('zh').invoke('places', 'list', [])).places;
      for (const p of all) await tools.map_edit({ place: p.name, desc: LONG_DESC.repeat(4).slice(0, descLen) });
    }
    const v = world.envPromptVars();
    return Buffer.byteLength(v.map_places_block + v.map_imggen_block + v.map_feast_block, 'utf8');
  };

  // ① 不变量：5 处短描写 vs 5 处 400 字描写
  const plain = await build(5, 0);
  const long = await build(5, 400);
  assert.equal(long, plain, '描写长度不得增加常驻负载');

  // ② 上限：60 处（MAX_PLACES）× 400 字
  const worst = await build(60, 400);
  assert.ok(worst <= 5000, `60 处 × 400 字时注入块 ${worst} B，超过 5000 B 上限`);
});

test('map_places 不带描写，map_view 仍截 60 字，map_look 保留全文', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: LONG_DESC });
  const list = await tools.map_places({});
  assert.ok(!list.text.includes(LONG_DESC), `清单不该带完整描写：\n${list.text}`);
  assert.ok(!list.text.includes(LONG_DESC.slice(0, 10)), '索引连描写摘要都不带');

  const view = await tools.map_view({});
  assert.ok(!view.text.includes(LONG_DESC), '整张图也不该带完整描写');
  assert.ok(view.text.includes(LONG_DESC.slice(0, 60) + '…'), '整张图保留 60 字描写摘要');
  assert.ok(!view.text.includes(LONG_DESC.slice(0, 61)), '摘要不可超过 60 字');

  // 详情永远给全文
  const look = await tools.map_look({ place: '溪边' });
  assert.ok(look.text.includes(LONG_DESC), 'map_look 必须给完整描写');
});

test('守门断言：六个工具的回执里都没有路线/坐标/距离字眼', async () => {
  const { tools } = await makeWorld({ imggen: true, terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '一条很浅的溪，石头是青的', style: '水彩，青灰', scene: '溪边' });
  const outputs = [
    await tools.map_places({}),
    await tools.map_look({ place: '溪边' }),
    await tools.map_add({ name: '旧码头', desc: '木板上有个洞' }),
    await tools.map_edit({ place: '旧码头', desc: '木板换了一块' }),
    await tools.map_cover({ place: '溪边' }),
    await tools.map_view({}),
  ];
  for (const r of outputs) {
    assert.ok(!GEO_WORDS.test(r.text), `回执里出现了路线字眼：\n${r.text}`);
  }
});

test('守门断言：ENV_PROMPT 里没有「从这里走十分钟 / 导航到 X」这种教她编路的话', async () => {
  const { readFile } = await import('node:fs/promises');
  const prompt = await readFile(fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url)), 'utf8');
  assert.match(prompt, /(?:没有|不提供)[^。\n]*路线/, '要明确说明不提供路线');
  // 路线字眼只许出现在「不许这么说」的否定语境里。
  // 逐句判：句子里出现路线字眼时，同一句必须带否定词（不 / 别 / 没有 / 无）。
  for (const line of prompt.split('\n')) {
    if (!GEO_WORDS.test(line)) continue;
    assert.ok(/不|别|没有|无/.test(line), `这句提到了路线却没否定它：${line}`);
  }
});

// ===========================================================================
// 静态降级 / 边界
// ===========================================================================

test('stop 之后再调工具：failed 回执，不抛错', async () => {
  const { world, tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  await world.stop();
  const r = await tools.map_places({});
  assert.equal(r.failed, true);
  assert.ok(r.text.includes('失败'), r.text);
});

test('坏参数不炸：object / 数组 / null 当入参', async () => {
  const { tools } = await makeWorld({ imggen: false, terrain: 'forest' });
  for (const bad of [{ place: { evil: true } }, { place: [] }, { place: null }, { kind: 42 }]) {
    const r = await tools.map_look(bad);
    assert.equal(typeof r.text, 'string', `入参 ${JSON.stringify(bad)} 该给字符串回执`);
  }
  assert.equal(typeof (await tools.map_places({ kind: {} })).text, 'string');
});

test('配置段补齐：只补缺的键，不覆盖已有值，enabled 跳过', async () => {
  const dataDir = await makeDataDir(null);
  const patches = [];
  const world = new MapWorld({
    cfg: { enabled: true, mapOn: false },
    dataDir,
    timezone: TZ,
    persist: (patch) => { patches.push(patch); Object.assign(world.cfg, patch); },
  });
  await world.start(makeHost());
  const patch = patches[0];
  assert.ok(patch, '该 persist 一次');
  assert.equal('enabled' in patch, false, 'enabled 归宿主，别补');
  assert.equal('mapOn' in patch, false, '已有的值不许覆盖');
  assert.equal(patch.mapImggenOn, true, '缺的键按默认补');
  assert.equal(patch.mapStyleRef, '');
  assert.equal(world.cfg.mapOn, false, '用户的值保留');
});

test('配置段补齐：全齐了就不 persist', async () => {
  const dataDir = await makeDataDir(null);
  const patches = [];
  const world = new MapWorld({
    cfg: {
      enabled: true, mapOn: true, mapImggenOn: true, mapFeastOn: true, mapFunOn: true, mapStyleRef: '',
    },
    dataDir, timezone: TZ, persist: (p) => patches.push(p),
  });
  await world.start(makeHost());
  assert.deepEqual(patches, [], '一个键都不缺就不该写');
});

test('persist 抛错也不影响启动（界面显示不对，但世界照跑）', async () => {
  const dataDir = await makeDataDir(null);
  const host = makeHost();
  const world = new MapWorld({
    cfg: { enabled: true }, dataDir, timezone: TZ,
    persist: () => { throw new Error('磁盘满了'); },
  });
  await world.start(host);
  assert.ok(host.logged.some(([level, m]) => level === 'warn' && m.includes('配置段没补齐')));
  const tools = Object.fromEntries(world.tools().map((t) => [t.name, t.handler]));
  assert.equal(typeof (await tools.map_places({})).text, 'string', '配置没补上也要照常能列');
});

// ===========================================================================
// 图片守门：魔数、大小、data URL
// ===========================================================================

test('sniffImage：按文件头认四种，认不看扩展名', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000', 'hex');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const gif = Buffer.from('GIF89a', 'latin1');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  assert.equal(sniffImage(png)?.mime, 'image/png');
  assert.equal(sniffImage(jpg)?.mime, 'image/jpeg');
  assert.equal(sniffImage(gif)?.mime, 'image/gif');
  assert.equal(sniffImage(webp)?.mime, 'image/webp');
  assert.equal(sniffImage(Buffer.from('不是图', 'utf8')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  assert.equal(sniffImage('字符串'), null);
});

test('decodeDataUrl：坏的给 error 不抛；好的认出 mime 与扩展名', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const good = decodeDataUrl(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(good.mime, 'image/png');
  assert.equal(good.ext, 'png');
  assert.ok(Buffer.isBuffer(good.bytes));

  for (const bad of ['', 'not a url', 'data:text/plain;base64,aGk=', `data:image/png;base64,${Buffer.from('hello').toString('base64')}`]) {
    const r = decodeDataUrl(bad);
    assert.ok(r.error, `该被拒：${bad.slice(0, 30)}`);
  }
  // 声明 png 但内容是 jpg：按魔数认，认 jpg
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(decodeDataUrl(`data:image/png;base64,${jpg.toString('base64')}`).ext, 'jpg',
    '扩展名听魔数的，不听声明的');
});

test('上传：真 PNG 能进、挂上、读回 data URL；非图片被拒', async () => {
  const { world, dataDir } = await makeWorld({ imggen: false, terrain: 'forest' });
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 7)]);
  const ok = await world.webUi('zh').invoke('places', 'upload', [{ id: 'forest-creek', data: `data:image/png;base64,${png.toString('base64')}` }]);
  assert.equal(ok.ok, true, ok.error);
  assert.match(ok.cover, /^forest-creek\.[a-f0-9]{12}\.png$/);
  const back = await world.webUi('zh').invoke('places', 'cover', [{ id: 'forest-creek' }]);
  assert.equal(back.ok, true);
  assert.ok(back.dataUrl.startsWith('data:image/png;base64,'), back.dataUrl.slice(0, 40));
  // 文件真落盘了
  assert.deepEqual(await readdir(join(dataDir, 'map', 'covers')), [ok.cover]);

  const bad = await world.webUi('zh').invoke('places', 'upload', [{ id: 'forest-creek', data: `data:image/png;base64,${Buffer.from('hello').toString('base64')}` }]);
  assert.equal(bad.ok, false, '不是图片该被拒');
  assert.ok(bad.error.includes('png'), bad.error);
});

test('读图：文件被删掉时面板拿到「没图」，不报错', async () => {
  const { world, dataDir } = await makeWorld({ imggen: false, terrain: 'forest' });
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 1)]);
  const uploaded = await world.webUi('zh').invoke('places', 'upload', [{ id: 'forest-creek', data: `data:image/png;base64,${png.toString('base64')}` }]);
  const { unlink } = await import('node:fs/promises');
  await unlink(join(dataDir, 'map', 'covers', uploaded.cover));
  const back = await world.webUi('zh').invoke('places', 'cover', [{ id: 'forest-creek' }]);
  assert.equal(back.ok, true, '文件没了也不该报错');
  assert.equal(back.dataUrl, '');
});

test('同名地点必须明确选择，id 修改独立', async () => {
  const { world, tools } = await makeWorld({ terrain: 'forest' });
  await world.webUi('zh').invoke('places', 'terrain', [{ id: 'riverside' }]);
  for (const name of ['map_look', 'map_edit', 'map_cover']) {
    const r = await tools[name]({ place: '家', desc: '不该写入', clear: true });
    assert.match(r.text, /forest-home/); assert.match(r.text, /riverside-home/);
  }
  await tools.map_edit({ place: 'riverside-home', desc: '临江的房间' });
  assert.doesNotMatch((await tools.map_look({ place: 'forest-home' })).text, /临江的房间/);
});

test('世界默认画风热改、地点优先且不写回继承值', async () => {
  const { world, tools } = await makeWorld({ terrain: 'forest', cfg: { mapStyleRef: '藏青暖黄绘本' } });
  assert.match((await tools.map_look({ place: '溪边' })).text, /画风：藏青暖黄绘本/);
  assert.doesNotMatch(world.envPromptVars().map_places_block, /藏青暖黄绘本/);
  const list = await world.webUi('zh').invoke('places', 'list');
  assert.equal(list.places.find((p) => p.id === 'forest-creek').style, '');
  await tools.map_edit({ place: '溪边', style: '水彩' }); world.cfg.mapStyleRef = '铅笔画';
  assert.match((await tools.map_look({ place: '溪边' })).text, /画风：水彩/);
  await tools.map_edit({ place: '溪边', style: '' });
  assert.match((await tools.map_look({ place: '溪边' })).text, /画风：铅笔画/);
});

test('示例描写只填新增且默认保持空白', async () => {
  const { world } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  await ui.invoke('places', 'terrain', [{ id: 'riverside', withDescriptions: true }]);
  const list = await ui.invoke('places', 'list');
  assert.ok(list.places.filter((p) => p.terrain === 'riverside').every((p) => p.desc));
  assert.ok(list.places.filter((p) => p.terrain === 'forest').every((p) => !p.desc));
});

test('损坏记录无备份时所有写入口阻断且退出不覆盖原文', async () => {
  const { world, tools, dataDir } = await makeWorld({ started: false });
  await mkdir(join(dataDir, 'map'), { recursive: true }); await writeFile(world.stateFile(), '{bad json', 'utf8');
  await world.start(makeHost()); const ui = world.webUi('zh');
  assert.match((await ui.invoke('places', 'list')).storageWarning, /暂停写入/);
  assert.equal((await ui.invoke('places', 'add', [{ name: '新地点' }])).ok, false);
  assert.equal((await tools.map_add({ name: '新地点' })).failed, true);
  await world.stop(); assert.equal(await readFile(world.stateFile(), 'utf8'), '{bad json');
});

test('上一版备份恢复并保留损坏文件，修改后可正常保存', async () => {
  const { world, tools, dataDir } = await makeWorld({ terrain: 'forest' });
  await tools.map_edit({ place: '溪边', desc: '备份里的溪水' }); await tools.map_edit({ place: '溪边', desc: '最新的溪水' });
  await world.stop(); await writeFile(world.stateFile(), '{broken', 'utf8');
  const recovered = new MapWorld({ dataDir, cfg: { ...DEFAULTS } }); await recovered.start(makeHost());
  const ui = recovered.webUi('zh'); const list = await ui.invoke('places', 'list');
  assert.match(list.storageWarning, /备份恢复/);
  assert.equal(list.places.find((p) => p.id === 'forest-creek').desc, '备份里的溪水');
  assert.ok((await readdir(join(dataDir, 'map'))).some((name) => name.startsWith('state.json.corrupt-')));
  await recovered.stop(); assert.equal(await readFile(world.stateFile(), 'utf8'), '{broken');
  await recovered.start(makeHost()); await ui.invoke('places', 'edit', [{ id: 'forest-creek', desc: '恢复后保存' }]);
  assert.equal(JSON.parse(await readFile(world.stateFile(), 'utf8')).places.find((p) => p.id === 'forest-creek').desc, '恢复后保存'); await recovered.stop();
});

test('面板并行写入可串行保存并重启读回', async () => {
  const { world, dataDir } = await makeWorld(); const ui = world.webUi('zh');
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => ui.invoke('places', 'add', [{ name: `并发地点${i}` }])));
  assert.ok(results.every((r) => r.ok)); await world.stop();
  const next = new MapWorld({ dataDir, cfg: { ...DEFAULTS } }); await next.start(makeHost());
  assert.equal((await next.webUi('zh').invoke('places', 'list')).places.length, 10); await next.stop();
});

test('当前住所泛称解析持久化，明确id仍独立且非home拒绝', async () => {
  const { world, tools, dataDir } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  await ui.invoke('places', 'terrain', [{ id: 'riverside', withDescriptions: true }]);
  assert.equal((await ui.invoke('places', 'setHome', [{ id: 'forest-creek' }])).ok, false);
  assert.equal((await ui.invoke('places', 'setHome', [{ id: 'riverside-home' }])).ok, true);
  for (const name of ['家', '家里', '回家']) assert.match((await tools.map_look({ place: name })).text, /浅蓝窗帘/);
  assert.doesNotMatch((await tools.map_look({ place: 'forest-home' })).text, /浅蓝窗帘/);
  await world.stop(); const next = new MapWorld({ dataDir, cfg: { ...DEFAULTS } }); await next.start(makeHost());
  assert.equal((await next.webUi('zh').invoke('places', 'list')).homeId, 'riverside-home');
  await next.webUi('zh').invoke('places', 'remove', [{ id: 'riverside-home' }]);
  assert.equal((await next.webUi('zh').invoke('places', 'list')).homeId, ''); await next.stop();
});

test('面板版本检查保护模型更新，刷新版本后可保存', async () => {
  const { world, tools } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  const before = (await ui.invoke('places', 'list')).places.find((p) => p.id === 'forest-creek');
  await tools.map_edit({ place: '溪边', desc: '模型更新' });
  const conflict = await ui.invoke('places', 'edit', [{ id: before.id, expectedRevision: before.revision, desc: '旧草稿' }]);
  assert.equal(conflict.conflict, true); assert.equal(conflict.current.desc, '模型更新');
  assert.equal((await ui.invoke('places', 'edit', [{ id: before.id, expectedRevision: conflict.current.revision, desc: '确认内容' }])).ok, true);
});

test('持久草稿过滤未知字段并可跨重启读取', async () => {
  const { world, dataDir } = await makeWorld(); const ui = world.webUi('zh');
  assert.equal((await ui.invoke('places', 'saveDrafts', [{ drafts: [{ id: 'new', fields: { desc: '草稿', cover: 'bad', extra: 'bad' } }, { id: '../bad', fields: { desc: 'bad' } }] }])).ok, true);
  await world.stop(); const next = new MapWorld({ dataDir, cfg: { ...DEFAULTS } }); await next.start(makeHost());
  assert.deepEqual((await next.webUi('zh').invoke('places', 'drafts')).drafts, [{ id: 'new', fields: { desc: '草稿' } }]); await next.stop();
});

test('含封面世界导出导入，过期预览不会写入', async () => {
  const source = await makeWorld({ terrain: 'forest' }); const sourceUi = source.world.webUi('zh');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 3)]);
  await sourceUi.invoke('places', 'upload', [{ id: 'forest-creek', data: `data:image/png;base64,${png.toString('base64')}` }]);
  const bundle = (await sourceUi.invoke('places', 'export')).bundle; assert.ok(bundle.covers[bundle.state.places.find((p) => p.id === 'forest-creek').cover]);
  const target = await makeWorld(); const ui = target.world.webUi('zh');
  const preview = await ui.invoke('places', 'previewImport', [{ bundle, mode: 'overwrite' }]);
  await ui.invoke('places', 'add', [{ name: '预览后新增' }]);
  assert.equal((await ui.invoke('places', 'import', [{ bundle, mode: 'overwrite', expectedRevision: preview.expectedRevision }])).conflict, true);
  const fresh = await ui.invoke('places', 'previewImport', [{ bundle, mode: 'overwrite' }]);
  const changedBundle = structuredClone(bundle);
  changedBundle.state.places[0].desc = '预览外的更改';
  assert.equal((await ui.invoke('places', 'import', [{ bundle: changedBundle, mode: 'overwrite', expectedRevision: fresh.expectedRevision }])).conflict, true);
  assert.equal((await ui.invoke('places', 'import', [{ bundle, mode: 'merge', expectedRevision: fresh.expectedRevision }])).conflict, true);
  assert.equal((await ui.invoke('places', 'import', [{ bundle, mode: 'overwrite', expectedRevision: fresh.expectedRevision }])).ok, true);
  assert.equal((await ui.invoke('places', 'cover', [{ id: 'forest-creek' }])).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
});

test('合并旧备份后重启仍保留自建地点、封面、草稿和本地修改', async () => {
  const { world, tools, dataDir } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const bundle = (await ui.invoke('places', 'export')).bundle;
  await tools.map_add({ name: '用户书房', desc: '用户独有描写', tags: ['私人'] });
  const custom = (await ui.invoke('places', 'list')).places.find((p) => p.name === '用户书房');
  await tools.map_edit({ place: 'forest-creek', desc: '后来修改的溪水', tags: ['清静'] });
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 7)]);
  const data = `data:image/png;base64,${png.toString('base64')}`;
  await ui.invoke('places', 'upload', [{ id: custom.id, data }]);
  await ui.invoke('places', 'saveDrafts', [{ drafts: [{ id: custom.id, fields: { desc: '未保存草稿' } }] }]);
  const preview = await ui.invoke('places', 'previewImport', [{ bundle, mode: 'merge' }]);
  assert.equal((await ui.invoke('places', 'import', [{ bundle, mode: 'merge', expectedRevision: preview.expectedRevision }])).ok, true);
  await world.stop();
  const next = new MapWorld({ dataDir, cfg: { ...DEFAULTS } }); await next.start(makeHost());
  const nextUi = next.webUi('zh');
  const list = await nextUi.invoke('places', 'list');
  assert.equal(list.places.find((p) => p.id === custom.id).desc, '用户独有描写');
  assert.equal(list.places.find((p) => p.id === 'forest-creek').desc, '后来修改的溪水');
  assert.deepEqual(list.places.find((p) => p.id === 'forest-creek').tags, ['清静']);
  assert.equal((await nextUi.invoke('places', 'cover', [{ id: custom.id }])).dataUrl, data);
  assert.deepEqual((await nextUi.invoke('places', 'drafts')).drafts, [{ id: custom.id, fields: { desc: '未保存草稿' } }]);
  await next.stop();
});

test('地点关联保存重启并同步目标重命名，删除目标立即清理', async () => {
  const { world, tools, dataDir } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  const before = (await ui.invoke('places', 'list')).places.find((p) => p.id === 'forest-home');
  await tools.map_edit({ place: 'forest-home', relations: [{ placeId: 'forest-creek', note: '窗边能看见溪面' }] });
  assert.match((await tools.map_look({ place: 'forest-home' })).text, /窗边能看见溪面/);
  assert.match((await tools.map_view({})).text, /窗边能看见溪面/);
  assert.doesNotMatch(world.envPromptVars().map_places_block, /窗边能看见溪面/);
  assert.equal((await ui.invoke('places', 'edit', [{ id: before.id, expectedRevision: before.revision, desc: '旧版本' }])).conflict, true);
  await tools.map_edit({ place: 'forest-creek', name: '清溪' });
  assert.match((await tools.map_look({ place: 'forest-home' })).text, /与 清溪/);
  await world.stop(); const next = new MapWorld({ dataDir, cfg: { ...DEFAULTS } }); await next.start(makeHost());
  const nextUi = next.webUi('zh'); assert.equal((await nextUi.invoke('places', 'list')).places.find((p) => p.id === 'forest-home').relations.length, 1);
  await nextUi.invoke('places', 'remove', [{ id: 'forest-creek' }]);
  assert.deepEqual((await nextUi.invoke('places', 'list')).places.find((p) => p.id === 'forest-home').relations, []); await next.stop();
});

test('无效关联整体拒绝且不修改其他字段，空数组明确清空', async () => {
  const { world, tools } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  for (const relations of [[{ placeId: 'missing', note: '相望' }], [{ placeId: 'forest-creek', note: '向东走十米' }], [{ placeId: 'forest-home', note: '相望' }]]) {
    const r = await ui.invoke('places', 'edit', [{ id: 'forest-home', desc: '不该保存', relations }]); assert.equal(r.ok, false);
    assert.doesNotMatch((await tools.map_look({ place: 'forest-home' })).text, /不该保存/);
  }
  await tools.map_edit({ place: 'forest-home', relations: [{ placeId: 'forest-creek', note: '窗边能看见溪面' }] });
  await tools.map_edit({ place: 'forest-home', relations: [] });
  assert.deepEqual((await ui.invoke('places', 'list')).places.find((p) => p.id === 'forest-home').relations, []);
});

// ===========================================================================
// 批量管理：一次改多处的标签 / 常去 / 归类
// ===========================================================================

test('批量改：标签、常去、归类一次改多处，没传的字段一个都不动', async () => {
  const { world } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  const before = (await ui.invoke('places', 'list')).places;
  const ids = ['forest-creek', 'forest-old-oak', 'forest-home'];
  const r = await ui.invoke('places', 'batchEdit', [{ ids, addTags: ['水边', '安静'], frequent: true, kind: 'around' }]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.updated, 3);
  assert.deepEqual(r.skipped, []);
  const after = (await ui.invoke('places', 'list')).places;
  for (const id of ids) {
    const p = after.find((x) => x.id === id);
    const old = before.find((x) => x.id === id);
    assert.deepEqual(p.tags, ['水边', '安静'], `${id} 的标签该是这两条`);
    assert.equal(p.frequent, true, `${id} 该标成常去`);
    assert.equal(p.kind, 'around', `${id} 归类该改成周围`);
    assert.equal(p.desc, old.desc, `${id} 的描写不该被碰`);
    assert.equal(p.name, old.name, `${id} 的名字不该被碰`);
    assert.deepEqual(p.aliases, old.aliases, `${id} 的别名不该被碰`);
  }
  const untouched = after.filter((p) => !ids.includes(p.id));
  assert.ok(untouched.length > 0, '应有没被勾选的地点');
  for (const p of untouched) {
    assert.deepEqual(p.tags, [], `${p.id} 没被勾选，不该有标签`);
    assert.equal(p.frequent, false, `${p.id} 没被勾选，不该变常去`);
  }
});

test('批量移标签只删指定的那几条，同处别的标签留着', async () => {
  const { world } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  await ui.invoke('places', 'batchEdit', [{ ids: ['forest-creek'], addTags: ['水边', '安静', '青石'] }]);
  const r = await ui.invoke('places', 'batchEdit', [{ ids: ['forest-creek'], removeTags: ['安静'] }]);
  assert.equal(r.ok, true, r.error);
  const p = (await ui.invoke('places', 'list')).places.find((x) => x.id === 'forest-creek');
  assert.deepEqual(p.tags, ['水边', '青石']);
});

test('批量改：坏输入整次拒绝，一处都不写', async () => {
  const { world } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  const before = JSON.stringify((await ui.invoke('places', 'list')).places);
  const cases = [
    [{ ids: [], frequent: true }, '空勾选'],
    [{ ids: ['forest-creek', 'nope'], frequent: true }, '有不存在的 id'],
    [{ ids: ['forest-creek', 'forest-creek'], frequent: true }, '重复 id'],
    [{ ids: ['forest-creek'], kind: '火星' }, '归类认不出'],
    [{ ids: ['forest-creek'] }, '什么都没要改'],
  ];
  for (const [args, why] of cases) {
    const r = await ui.invoke('places', 'batchEdit', [args]);
    assert.equal(r.ok, false, `${why} 应该被拒绝`);
    assert.ok(r.error && r.error.length > 0, `${why} 要说清原因`);
  }
  assert.equal(JSON.stringify((await ui.invoke('places', 'list')).places), before, '被拒绝的批量改不能动任何数据');
});

test('批量加标签：已经满 8 个的那一处跳过并说明原因，其余照改', async () => {
  const { world } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  const eight = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
  await ui.invoke('places', 'batchEdit', [{ ids: ['forest-creek'], addTags: eight }]);
  assert.deepEqual((await ui.invoke('places', 'list')).places.find((p) => p.id === 'forest-creek').tags, eight);
  const r = await ui.invoke('places', 'batchEdit', [{ ids: ['forest-creek', 'forest-old-oak'], addTags: ['新标签'] }]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.updated, 1, '只有没满的那一处该被改');
  assert.equal(r.skipped.length, 1, '满了的那一处要被单独报告');
  assert.equal(r.skipped[0].id, 'forest-creek');
  assert.match(r.skipped[0].reason, /8/);
  const list = (await ui.invoke('places', 'list')).places;
  assert.deepEqual(list.find((p) => p.id === 'forest-old-oak').tags, ['新标签']);
  assert.deepEqual(list.find((p) => p.id === 'forest-creek').tags, eight, '满的那处一个标签都不该变');
});

// ===========================================================================
// 删除后 10 秒撤销
// ===========================================================================

test('删掉之后 10 秒内可撤销：地点、图、住所和指向它的关系一起回来', async () => {
  let clock = NOW;
  const { world } = await makeWorld({ terrain: 'forest', now: () => clock });
  const ui = world.webUi('zh');
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 3)]);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  await ui.invoke('places', 'upload', [{ id: 'forest-creek', data: dataUrl }]);
  await ui.invoke('places', 'edit', [{ id: 'forest-home', relations: [{ placeId: 'forest-creek', note: '窗边能看见溪面' }] }]);
  await ui.invoke('places', 'setHome', [{ id: 'forest-home' }]);

  const removed = await ui.invoke('places', 'remove', [{ id: 'forest-creek' }]);
  assert.equal(removed.ok, true, removed.error);
  assert.ok(removed.undo?.token, '删除回执里要带撤销牌');
  let list = await ui.invoke('places', 'list');
  assert.equal(list.places.some((p) => p.id === 'forest-creek'), false, '删完该不在了');
  assert.equal(list.undo?.token, removed.undo.token, 'list 里也要能看到撤销牌（面板刷新后还在）');
  assert.deepEqual(list.places.find((p) => p.id === 'forest-home').relations, [], '删掉目标后关系该被清掉');

  clock += 3000;
  const back = await ui.invoke('places', 'undoRemove', [{ token: removed.undo.token }]);
  assert.equal(back.ok, true, back.error);
  list = await ui.invoke('places', 'list');
  assert.ok(list.places.some((p) => p.id === 'forest-creek'), '撤销后地点该回来');
  assert.deepEqual(list.places.find((p) => p.id === 'forest-home').relations,
    [{ placeId: 'forest-creek', note: '窗边能看见溪面' }], '指向它的关系该一起回来');
  assert.equal(list.homeId, 'forest-home');
  assert.equal((await ui.invoke('places', 'cover', [{ id: 'forest-creek' }])).dataUrl, dataUrl, '图该还在');
  assert.equal(list.undo, null, '撤销之后不该再挂着撤销牌');
});

test('超过 10 秒就撤不回来，而且一个 token 只能撤销一次', async () => {
  let clock = NOW;
  const { world } = await makeWorld({ terrain: 'forest', now: () => clock });
  const ui = world.webUi('zh');
  const a = await ui.invoke('places', 'remove', [{ id: 'forest-creek' }]);
  clock += 10_001;
  const late = await ui.invoke('places', 'undoRemove', [{ token: a.undo.token }]);
  assert.equal(late.ok, false, '过期了不该还能撤');
  assert.match(late.error, /10 秒|过期/);
  assert.equal((await ui.invoke('places', 'list')).places.some((p) => p.id === 'forest-creek'), false);

  const b = await ui.invoke('places', 'remove', [{ id: 'forest-old-oak' }]);
  assert.equal((await ui.invoke('places', 'undoRemove', [{ token: b.undo.token }])).ok, true);
  const again = await ui.invoke('places', 'undoRemove', [{ token: b.undo.token }]);
  assert.equal(again.ok, false, '撤销过之后同一个 token 不能再用');
});

test('删完之后又改了别处，撤销会被拒绝，那次修改不会被冲掉', async () => {
  const { world } = await makeWorld({ terrain: 'forest' }); const ui = world.webUi('zh');
  const a = await ui.invoke('places', 'remove', [{ id: 'forest-creek' }]);
  await ui.invoke('places', 'edit', [{ id: 'forest-old-oak', desc: '删完之后又改的' }]);
  const r = await ui.invoke('places', 'undoRemove', [{ token: a.undo.token }]);
  assert.equal(r.ok, false, '中间改过别处，撤销就该被拒');
  assert.match(r.error, /改过|冲掉/);
  const list = (await ui.invoke('places', 'list')).places;
  assert.equal(list.find((p) => p.id === 'forest-old-oak').desc, '删完之后又改的', '撤销被拒时那次修改必须还在');
  assert.equal(list.some((p) => p.id === 'forest-creek'), false);
});

test('coverFocus panel validates, persists, and returns complete revision conflicts', async () => {
  const { world, dataDir } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const id = 'forest-creek';
  const get = async () => (await ui.invoke('places', 'list')).places.find((p) => p.id === id);
  assert.equal((await ui.invoke('places', 'coverFocus', [{ id, x: 10, y: 20 }])).ok, false);
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 5)]);
  await ui.invoke('places', 'upload', [{ id, data: `data:image/png;base64,${png.toString('base64')}` }]);
  const initial = await get();
  const saved = await ui.invoke('places', 'coverFocus', [{ id, x: 25.5, y: 70, expectedCover: initial.cover, expectedRevision: initial.revision }]);
  assert.equal(saved.ok, true, saved.error);
  assert.deepEqual(saved.place.coverFocus, { x: 25.5, y: 70 });
  assert.notEqual(saved.place.revision, initial.revision);
  for (const patch of [{ x: '2', y: 3 }, { x: 0, y: 101 }, { x: NaN, y: 2 }, { x: 3 }, { x: 2, y: Infinity }]) {
    assert.equal((await ui.invoke('places', 'coverFocus', [{ id, ...patch }])).ok, false);
    assert.equal((await get()).revision, saved.place.revision);
  }
  const staleRevision = await ui.invoke('places', 'coverFocus', [{ id, x: 0, y: 100, expectedRevision: initial.revision }]);
  assert.equal(staleRevision.conflict, true);
  assert.deepEqual(staleRevision.current.coverFocus, saved.place.coverFocus);
  const staleCover = await ui.invoke('places', 'coverFocus', [{ id, x: 0, y: 100, expectedCover: 'old.png' }]);
  assert.equal(staleCover.conflict, true);
  const editConflict = await ui.invoke('places', 'edit', [{ id, desc: 'stale', expectedRevision: initial.revision }]);
  for (const key of ['name', 'aliases', 'kind', 'desc', 'style', 'scene', 'funVenue', 'frequent', 'tags', 'relations', 'cover', 'coverFocus', 'revision']) {
    assert.deepEqual(editConflict.current[key], saved.place[key], `conflict.current includes ${key}`);
  }
  await world.stop();
  const restarted = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir, timezone: TZ, now: () => NOW });
  await restarted.start(makeHost());
  const next = restarted.webUi('zh');
  assert.deepEqual((await next.invoke('places', 'list')).places.find((p) => p.id === id).coverFocus, saved.place.coverFocus);
  assert.equal((await next.invoke('places', 'coverFocus', [{ id, x: 50, y: 50 }])).ok, true);
  assert.equal(Object.hasOwn((await next.invoke('places', 'list')).places.find((p) => p.id === id), 'coverFocus'), false);
  await restarted.stop();
});

test('same-extension cover replacements invalidate stale focus and keep backup image files', async () => {
  const { world, dataDir } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const id = 'forest-creek';
  const data = (n) => `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, n)]).toString('base64')}`;
  const first = await ui.invoke('places', 'upload', [{ id, data: data(1) }]);
  const before = (await ui.invoke('places', 'list')).places.find((p) => p.id === id);
  const second = await ui.invoke('places', 'upload', [{ id, data: data(2) }]);
  assert.notEqual(first.cover, second.cover);
  const stale = await ui.invoke('places', 'coverFocus', [{ id, x: 2, y: 3, expectedCover: before.cover, expectedRevision: before.revision }]);
  assert.equal(stale.conflict, true);
  assert.equal(stale.current.cover, second.cover);
  const existing = await readdir(join(dataDir, 'map', 'covers'));
  assert.ok(existing.includes(first.cover));
  assert.ok(existing.includes(second.cover));
  await ui.invoke('places', 'coverFocus', [{ id, x: 2, y: 3 }]);
  await ui.invoke('places', 'upload', [{ id, data: data(2) }]);
  assert.equal(Object.hasOwn((await ui.invoke('places', 'list')).places.find((p) => p.id === id), 'coverFocus'), false);
  await ui.invoke('places', 'coverFocus', [{ id, x: 2, y: 3 }]);
  await ui.invoke('places', 'clearCover', [{ id }]);
  const cleared = (await ui.invoke('places', 'list')).places.find((p) => p.id === id);
  assert.equal(cleared.cover, '');
  assert.equal(Object.hasOwn(cleared, 'coverFocus'), false);
  await world.stop();
});

test('draft base snapshots sanitize, survive restarts/removals, and retain historical drafts', async () => {
  const { world, dataDir } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const p = (await ui.invoke('places', 'list')).places[0];
  const base = { revision: p.revision, fields: { name: p.name, desc: 'original', aliases: 'old alias', relationsJson: '[]', extra: 'drop' } };
  const drafts = [
    { id: p.id, fields: { desc: 'draft', extra: 'drop' }, base },
    { id: 'new', fields: { name: 'historical' } },
    { id: 'invalid-base', fields: { desc: 'keep' }, base: { revision: 'bad', fields: { desc: 'drop' } } },
  ];
  assert.equal((await ui.invoke('places', 'saveDrafts', [{ drafts }])).ok, true);
  const expected = [
    { id: p.id, fields: { desc: 'draft' }, base: { revision: p.revision, fields: { name: p.name, desc: 'original', aliases: 'old alias', relationsJson: '[]' } } },
    drafts[1],
    { id: 'invalid-base', fields: { desc: 'keep' } },
  ];
  assert.deepEqual((await ui.invoke('places', 'drafts')).drafts, expected);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'map', 'drafts.json'), 'utf8')).drafts, expected);
  await world.stop();
  const restarted = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir, timezone: TZ, now: () => NOW });
  await restarted.start(makeHost());
  const next = restarted.webUi('zh');
  assert.deepEqual((await next.invoke('places', 'drafts')).drafts, expected);
  assert.equal((await next.invoke('places', 'removeDraft', [{ id: 'new' }])).ok, true);
  assert.deepEqual((await next.invoke('places', 'drafts')).drafts, [expected[0], expected[2]]);
  await restarted.stop();
});

const coverPng = (n) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, n)]);
const coverData = (n) => `data:image/png;base64,${coverPng(n).toString('base64')}`;
const viewPrefs = (id) => ({
  version: 1,
  savedViews: [{ id: 'favorite-view', name: '  溪边  ', query: '  water  ', filter: 'hasCover', tagFilter: '', view: 'relations', sort: 'viewed' }],
  recentViewed: [id, id], recentEdited: [id], pinned: [id],
});

test('cover inspection inventories current, saved, disk, backup, recovery and undo references without writes', async () => {
  const { world } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const id = 'forest-creek';
  const first = await ui.invoke('places', 'upload', [{ id, data: coverData(1) }]);
  const second = await ui.invoke('places', 'upload', [{ id, data: coverData(2) }]);
  const before = (await ui.invoke('places', 'export')).bundle;
  const plan = await ui.invoke('places', 'previewImport', [{ bundle: before, mode: 'overwrite' }]);
  assert.equal((await ui.invoke('places', 'import', [{ bundle: before, mode: 'overwrite', expectedRevision: plan.expectedRevision }])).ok, true);
  const third = (await ui.invoke('places', 'list')).places.find((place) => place.id === id).cover;
  const removal = await ui.invoke('places', 'remove', [{ id }]);
  const currentId = 'forest-home';
  const fourth = await ui.invoke('places', 'upload', [{ id: currentId, data: coverData(4) }]);
  const paths = [world.stateFile(), `${world.stateFile()}.bak`, world.recoveryFile()];
  const beforeBytes = await Promise.all(paths.map((path) => readFile(path)));
  const covers = await readdir(world.coversDir());
  const inspected = await ui.invoke('places', 'inspectCovers');
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.missing, []);
  assert.deepEqual(inspected.warnings, []);
  const files = new Map(inspected.files.map((file) => [file.filename, file]));
  for (const file of files.values()) assert.equal(file.bytes, coverPng(1).length);
  assert.deepEqual(files.get(first.cover).references, []);
  assert.deepEqual(files.get(second.cover).references, [{ source: 'recovery', placeId: id }]);
  assert.deepEqual(files.get(third).references, [{ source: 'undo', placeId: id }]);
  assert.deepEqual(files.get(fourth.cover).references, ['current', 'saved', 'disk'].map((source) => ({ source, placeId: currentId })));
  assert.deepEqual(await ui.invoke('places', 'inspectCovers'), inspected);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), beforeBytes);
  assert.deepEqual(await readdir(world.coversDir()), covers);
  assert.equal((await ui.invoke('places', 'list')).undo.token, removal.undo.token);
  await world.stop();
});

test('cover archive checks content revisions, moves only known orphans, and restores without loss', async () => {
  const { world, dataDir } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const coverDir = world.coversDir();
  await mkdir(coverDir, { recursive: true });
  const filename = 'orphan.png';
  await writeFile(join(coverDir, filename), coverPng(1));
  let inventory = await ui.invoke('places', 'inspectCovers');
  const candidate = inventory.files.find((file) => file.filename === filename);
  assert.equal(candidate.archiveable, true);
  assert.deepEqual(candidate.references, []);
  const originalState = await readFile(world.stateFile());
  const altered = coverPng(2);
  await writeFile(join(coverDir, filename), altered);
  const stale = await ui.invoke('places', 'archiveCovers', [{ filenames: [filename], expectedRevision: inventory.revision }]);
  assert.equal(stale.ok, false);
  assert.deepEqual(await readFile(join(coverDir, filename)), altered, 'stale inventory cannot move changed bytes');
  inventory = await ui.invoke('places', 'inspectCovers');
  const archived = await ui.invoke('places', 'archiveCovers', [{ filenames: [filename], expectedRevision: inventory.revision }]);
  assert.equal(archived.ok, true, archived.error);
  assert.match(archived.archive.id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(archived.archive.files, [{ filename, bytes: altered.length, sha256: createHash('sha256').update(altered).digest('hex') }]);
  await assert.rejects(readFile(join(coverDir, filename)), { code: 'ENOENT' });
  const quarantined = join(dataDir, 'map', 'cover-archive', archived.archive.id, filename);
  assert.deepEqual(await readFile(quarantined), altered);
  const archives = await ui.invoke('places', 'listCoverArchives');
  assert.equal(archives.archives.length, 1);
  assert.equal(archives.archives[0].status, 'archived');
  assert.deepEqual(await readFile(world.stateFile()), originalState, 'archiving does not mutate state');
  const restored = await ui.invoke('places', 'restoreCoverArchive', [{ id: archived.archive.id }]);
  assert.deepEqual(restored, { ok: true, archiveId: archived.archive.id, restored: [filename], alreadyPresent: [] });
  assert.deepEqual(await readFile(join(coverDir, filename)), altered);
  const again = await ui.invoke('places', 'restoreCoverArchive', [{ id: archived.archive.id }]);
  assert.deepEqual(again.alreadyPresent, [filename], 'restore is idempotent and preserves archive copy');
  assert.deepEqual(await readFile(quarantined), altered);
  await world.stop();
});

test('cover archive rejects referenced images and malformed snapshot history', async () => {
  const { world } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const upload = await ui.invoke('places', 'upload', [{ id: 'forest-creek', data: coverData(3) }]);
  const inventory = await ui.invoke('places', 'inspectCovers');
  const referenced = inventory.files.find((file) => file.filename === upload.cover);
  assert.equal(referenced.archiveable, false);
  assert.ok(referenced.references.length);
  assert.equal((await ui.invoke('places', 'archiveCovers', [{ filenames: [upload.cover], expectedRevision: inventory.revision }])).ok, false);
  assert.deepEqual(await readFile(join(world.coversDir(), upload.cover)), coverPng(3));
  const corrupt = join(world.dataDir, 'map', 'state.json.corrupt-test');
  await writeFile(corrupt, '{not-json');
  const unsafe = await ui.invoke('places', 'inspectCovers');
  assert.ok(unsafe.warnings.some((warning) => warning.source === 'snapshot:state.json.corrupt-test'));
  assert.equal((await ui.invoke('places', 'archiveCovers', [{ filenames: ['loose.png'], expectedRevision: unsafe.revision }])).ok, false);
  assert.equal((await ui.invoke('places', 'deleteCovers', [{ filename: upload.cover }])).ok, false, 'there is no permanent delete RPC');
  await world.stop();
});

test('cover archive never overwrites a conflicting path during restore', async () => {
  const { world } = await makeWorld();
  const ui = world.webUi('zh');
  const covers = world.coversDir();
  await mkdir(covers, { recursive: true });
  const filename = 'kept.png';
  await writeFile(join(covers, filename), coverPng(4));
  const inventory = await ui.invoke('places', 'inspectCovers');
  const archived = await ui.invoke('places', 'archiveCovers', [{ filenames: [filename], expectedRevision: inventory.revision }]);
  assert.equal(archived.ok, true, archived.error);
  const conflict = coverPng(5);
  await writeFile(join(covers, filename), conflict);
  const refused = await ui.invoke('places', 'restoreCoverArchive', [{ id: archived.archive.id }]);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /不会覆盖/);
  assert.deepEqual(await readFile(join(covers, filename)), conflict);
  assert.deepEqual(await readFile(join(world.dataDir, 'map', 'cover-archive', archived.archive.id, filename)), coverPng(4));
  await world.stop();
});

test('cover inspection retains raw disk and staged references and reports missing or unreadable entries', async () => {
  const { world } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const covers = world.coversDir();
  await mkdir(covers);
  const filename = 'historical.PNG';
  await writeFile(join(covers, filename), coverPng(1));
  await writeFile(join(covers, 'cover.png.tmp'), coverPng(2));
  await mkdir(join(covers, 'folder.png'));
  await writeFile(`${world.stateFile()}.bak`, JSON.stringify({ places: [{ id: 'old-place', name: '旧地点', cover: filename }] }));
  await writeFile(`${world.stateFile()}.tmp`, JSON.stringify({ version: 1, places: [{ id: 'raw-place', cover: filename }] }));
  await writeFile(`${world.stateFile()}.bak.tmp`, JSON.stringify({ version: 1, places: [{ id: 'staged-place', cover: 'missing.png' }] }));
  await writeFile(world.recoveryFile(), '{broken');
  const inventory = await ui.invoke('places', 'inspectCovers');
  assert.deepEqual(inventory.files.map(({ filename, bytes, references }) => ({ filename, bytes, references })), [{ filename, bytes: 16, references: [{ source: 'backup', placeId: 'old-place' }, { source: 'staged-state', placeId: 'raw-place' }] }]);
  assert.deepEqual(inventory.missing, [{ filename: 'missing.png', references: [{ source: 'staged-backup', placeId: 'staged-place' }] }]);
  assert.deepEqual(inventory.warnings, [
    { source: 'backup', code: 'invalid-snapshot' },
    { source: 'recovery', code: 'invalid-snapshot' },
    { source: 'covers', code: 'skipped-entry' },
  ]);
  assert.equal((await ui.invoke('places', 'deleteCovers', [{ filename }])).ok, false);
  assert.deepEqual(await readFile(join(covers, filename)), coverPng(1));
  await world.stop();
});

test('cover inspection stays read-only when state cannot be read', async () => {
  const dataDir = await makeDataDir({});
  const world = new MapWorld({ dataDir });
  await mkdir(world.coversDir(), { recursive: true });
  await writeFile(world.stateFile(), '{broken');
  await writeFile(join(world.coversDir(), 'kept.png'), coverPng(1));
  await world.start(makeHost());
  const ui = world.webUi('zh');
  assert.ok((await ui.invoke('places', 'list')).storageWarning);
  const inventory = await ui.invoke('places', 'inspectCovers');
  assert.deepEqual(inventory.files.map(({ filename, bytes, references }) => ({ filename, bytes, references })), [{ filename: 'kept.png', bytes: 16, references: [] }]);
  assert.deepEqual(inventory.warnings, [{ source: 'disk', code: 'invalid-snapshot' }]);
  await world.stop();
  assert.equal(await readFile(world.stateFile(), 'utf8'), '{broken');
  assert.deepEqual(await readFile(join(world.coversDir(), 'kept.png')), coverPng(1));
});

test('panel preferences persist independently and do not invalidate undo revisions', async () => {
  const { world, dataDir } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const id = 'forest-home';
  const prefsFile = join(dataDir, 'map', 'views.json');
  assert.deepEqual(await ui.invoke('places', 'getPanelPrefs'), { ok: true, prefs: { version: 1, savedViews: [], recentViewed: [], recentEdited: [], pinned: [] } });
  await assert.rejects(readFile(prefsFile), { code: 'ENOENT' });
  const removal = await ui.invoke('places', 'remove', [{ id: 'forest-creek' }]);
  const paths = [world.stateFile(), `${world.stateFile()}.bak`];
  const previous = await Promise.all(paths.map((path) => readFile(path)));
  const revision = (await ui.invoke('places', 'list')).stateRevision;
  const prefs = viewPrefs(id);
  const saved = await ui.invoke('places', 'savePanelPrefs', [{ prefs }]);
  assert.equal(saved.ok, true, saved.error);
  assert.equal(saved.prefs.savedViews[0].name, '溪边');
  assert.equal(saved.prefs.savedViews[0].query, 'water');
  assert.deepEqual(saved.prefs.recentViewed, [id]);
  assert.deepEqual(JSON.parse(await readFile(prefsFile, 'utf8')), saved.prefs);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), previous);
  assert.equal((await ui.invoke('places', 'list')).stateRevision, revision);
  assert.equal((await ui.invoke('places', 'undoRemove', [{ token: removal.undo.token }])).ok, true);
  await world.stop();
  const restarted = new MapWorld({ dataDir });
  await restarted.start(makeHost());
  const next = restarted.webUi('zh');
  assert.deepEqual(await next.invoke('places', 'getPanelPrefs'), saved);
  assert.equal(Object.hasOwn((await next.invoke('places', 'export')).bundle.state, 'savedViews'), false);
  await restarted.stop();
});

test('panel preferences reject invalid edits, excessive entries and newer versions', async () => {
  const { world, dataDir } = await makeWorld({ terrain: 'forest' });
  const ui = world.webUi('zh');
  const id = 'forest-home';
  const prefsFile = join(dataDir, 'map', 'views.json');
  const save = (prefs) => ui.invoke('places', 'savePanelPrefs', [{ prefs }]);
  const prefs = viewPrefs(id);
  const baseline = await save(prefs);
  assert.equal(baseline.ok, true, baseline.error);
  const view = prefs.savedViews[0];
  for (const patch of [{ name: '   ' }, { query: 'z'.repeat(161) }, { filter: 'other' }, { sort: 'other' }, { view: 'other' }, { tagFilter: '<bad>' }, { id: '../escaped' }]) {
    assert.equal((await save({ ...prefs, savedViews: [{ ...view, ...patch }] })).ok, false, JSON.stringify(patch));
  }
  assert.equal((await save({ ...prefs, savedViews: [{ ...view, filter: 'noRelation' }] })).ok, true);
  const afterNoRelation = await ui.invoke('places', 'getPanelPrefs');
  assert.equal(afterNoRelation.prefs.savedViews[0].filter, 'noRelation');
  assert.equal((await save(prefs)).ok, true);
  assert.equal((await save({ ...prefs, savedViews: [{ ...view, filter: 'other' }] })).ok, false);
  assert.equal((await save({ ...prefs, pinned: ['../escaped'] })).ok, false);
  assert.equal((await save({ ...prefs, pinned: Array.from({ length: 61 }, (_, i) => `pin${i}`) })).ok, false);
  assert.equal((await save({ ...prefs, recentViewed: ['../escaped'] })).ok, false);
  assert.equal((await save({ ...prefs, recentEdited: Array.from({ length: 13 }, (_, i) => `p${i}`) })).ok, false);
  assert.equal((await save({ ...prefs, savedViews: Array.from({ length: 9 }, (_, i) => ({ ...view, id: `v${i}` })) })).ok, false);
  assert.deepEqual(await ui.invoke('places', 'getPanelPrefs'), baseline);
  await writeFile(prefsFile, '{broken');
  assert.deepEqual((await ui.invoke('places', 'getPanelPrefs')).prefs.savedViews, []);
  assert.equal((await save(prefs)).ok, true);
  const future = JSON.stringify({ ...prefs, version: 2 });
  await writeFile(prefsFile, future);
  assert.equal((await ui.invoke('places', 'getPanelPrefs')).ok, false);
  assert.equal((await save(prefs)).ok, false);
  assert.equal(await readFile(prefsFile, 'utf8'), future);
  await world.stop();
});

test('per-place modifiedAt follows actual current writes and survives reload', async () => {
  let now = 1000;
  const { world, dataDir } = await makeWorld({ terrain: 'forest', now: () => now });
  const ui = world.webUi('zh');
  const get = async (id) => (await ui.invoke('places', 'list')).places.find((place) => place.id === id);
  assert.ok((await ui.invoke('places', 'list')).places.every((place) => place.modifiedAt === 1000));
  now = 2000;
  assert.equal((await ui.invoke('places', 'edit', [{ id: 'forest-creek', desc: '溪水' }])).ok, true);
  assert.equal((await get('forest-creek')).modifiedAt, 2000);
  now = 3000;
  assert.equal((await ui.invoke('places', 'edit', [{ id: 'forest-creek', desc: '溪水' }])).changed.length, 0);
  assert.equal((await get('forest-creek')).modifiedAt, 2000);
  const png = `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8, 1)]).toString('base64')}`;
  now = 4000;
  assert.equal((await ui.invoke('places', 'upload', [{ id: 'forest-creek', data: png }])).ok, true);
  assert.equal((await get('forest-creek')).modifiedAt, 4000);
  await world.stop();
  const restarted = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir, now: () => now });
  await restarted.start(makeHost());
  assert.equal((await restarted.webUi('zh').invoke('places', 'list')).places.find((place) => place.id === 'forest-creek').modifiedAt, 4000);
  await restarted.stop();
});

test('imports timestamp actual existing-place changes with current time but leave no-ops unchanged', async () => {
  let now = 1000;
  const { world } = await makeWorld({ terrain: 'forest', now: () => now });
  const ui = world.webUi('zh');
  const get = async () => (await ui.invoke('places', 'list')).places.find((place) => place.id === 'forest-creek');
  const base = (await ui.invoke('places', 'export')).bundle;
  base.state.places.find((place) => place.id === 'forest-creek').modifiedAt = 1;
  base.state.places.find((place) => place.id === 'forest-creek').desc = '导入的新描写';
  const preview = await ui.invoke('places', 'previewImport', [{ bundle: base, mode: 'overwrite' }]);
  now = 2000;
  const imported = await ui.invoke('places', 'import', [{ bundle: base, mode: 'overwrite', expectedRevision: preview.expectedRevision }]);
  assert.equal(imported.ok, true, imported.error);
  assert.equal((await get()).modifiedAt, 2000, '实际导入的当前修改使用现在的时间，不采用备份旧时间');
  const same = (await ui.invoke('places', 'export')).bundle;
  same.state.places.find((place) => place.id === 'forest-creek').modifiedAt = 0;
  const noOpPreview = await ui.invoke('places', 'previewImport', [{ bundle: same, mode: 'overwrite' }]);
  now = 3000;
  assert.equal((await ui.invoke('places', 'import', [{ bundle: same, mode: 'overwrite', expectedRevision: noOpPreview.expectedRevision }])).ok, true);
  assert.equal((await get()).modifiedAt, 2000, '仅改变备份里的时间而没有内容变化，不算当前编辑');
  await world.stop();
});

test('legacy import recovery revisions remain usable with default zero timestamps', async () => {
  const dataDir = await makeDataDir({});
  const mapDir = join(dataDir, 'map');
  await mkdir(mapDir, { recursive: true });
  const legacyState = {
    version: 1, terrain: 'forest',
    places: terrainPlaces('forest').map(({ modifiedAt, ...place }) => place), updatedAt: 123,
  };
  const legacyText = JSON.stringify(legacyState, null, 2);
  await writeFile(join(mapDir, 'state.json'), legacyText);
  const before = { version: 1, terrain: '', places: [], updatedAt: 0 };
  const oldRevision = createHash('sha256').update(JSON.stringify(legacyState)).digest('hex');
  await writeFile(join(mapDir, 'import-recovery.json'), JSON.stringify({ version: 1, before, after: oldRevision }));
  const world = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir });
  await world.start(makeHost());
  const ui = world.webUi('zh');
  const info = await ui.invoke('places', 'recoveryInfo');
  assert.equal(info.available, true);
  assert.equal(info.canRestore, true);
  assert.ok((await ui.invoke('places', 'list')).places.every((place) => place.modifiedAt === 0));
  assert.equal((await ui.invoke('places', 'previewRestore')).ok, true);
  await world.stop();
});

await report();
