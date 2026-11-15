#!/usr/bin/env node
/**
 * dry-mount 冒烟：按宿主的调用顺序，把扩展**真加载一遍**，看契约有没有踩线。
 *
 * 宿主加载一个 World 大致是：
 *   1. `import(包入口)` 拿 default export（必须是 WorldDefinition）
 *   2. 读 `id` / `label` / `defaults()` / `preflight()`
 *   3. `create(ctx)` 拿实例（**必须纯**：不读盘、不建目录、不起定时器）
 *   4. `start(host)` 之后才 `tools()` / `envPromptVars()` / `webUi()`
 *   5. 停的时候 `stop()`
 *
 * 这里把这套顺序跑一遍，重点验：
 *   - default export 的形状对不对（认证会查）
 *   - `create()` 纯不纯（目录里不能多出东西）
 *   - `envPromptVars()` 在模板在/不在、有没有地点、装没装生图时都不抛错
 *   - 六个工具拿得到、`map_look` 能看一处
 *   - `webUi()` 的 config 路径都在 `worlds.map.` 段里
 *   - **world id 是 `map`**（「鱼的每一天」的 maplink 靠这一个契约）
 *
 * 不用 `node --test`，直接 `node tools/smoke.mjs`，退出码 0 = 全过。
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import definition, { MAP_TOOL_DECLS, MAP_WORLD_ID, MapWorld } from '../src/index.js';

const TZ = 'Asia/Shanghai';
let failures = 0;
const ok = (cond, what, extra = '') => {
  if (cond) {
    console.log(`  ok   ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${what}${extra ? ` → ${extra}` : ''}`);
  }
};

console.log('1) 入口形状');
ok(definition.id === MAP_WORLD_ID, `id 是 ${MAP_WORLD_ID}`);
ok(MAP_WORLD_ID === 'map', 'world id 必须是 map（maplink 契约）');
ok(typeof definition.label === 'string' && definition.label.length > 0, `label 是「${definition.label}」`);
ok(typeof definition.defaults === 'function', 'defaults 是函数');
ok(typeof definition.preflight === 'function', 'preflight 是函数');
ok(typeof definition.create === 'function', 'create 是函数');
ok(Array.isArray(definition.describe?.tools) && definition.describe.tools.length === 6, 'describe.tools 六条');
ok(Array.isArray(definition.describe?.events) && definition.describe.events.length === 0, 'describe.events 为空（不推事件）');

console.log('2) defaults / preflight');
const d = definition.defaults();
ok(d.enabled === false, 'defaults().enabled 恒为 false（启用由部署决定）');
ok(Object.keys(d).length === 6, `defaults 只有 6 个键（含 enabled），实际 ${Object.keys(d).length}`);
ok(d.mapFeastOn === true, 'mapFeastOn 默认开（鱼的每一天联动）');
ok(d.mapFunOn === true, 'mapFunOn 默认开（娱乐时间联动）');
definition.preflight({ cfg: {} });
ok(true, 'preflight 不抛');
ok(d !== definition.defaults(), 'defaults() 每次给新对象（不改共享 DEFAULTS）');

console.log('3) create() 必须是纯的');
const pureDir = await mkdtemp(join(tmpdir(), 'map-smoke-pure-'));
const ghost = definition.create({
  cfg: {}, dataDir: pureDir, timezone: TZ,
  persist: () => { throw new Error('create 期间不该 persist'); },
});
ok(ghost instanceof MapWorld, 'create 返回 MapWorld 实例');
ok((await readdir(pureDir)).length === 0, 'create 之后目录还是空的（不建目录）');
await rm(pureDir, { recursive: true, force: true });

console.log('4) start / tools / envPromptVars / webUi');
const root = await mkdtemp(join(tmpdir(), 'map-smoke-'));
const dataDir = join(root, 'data', 'home', 'companion');
await mkdir(dataDir, { recursive: true });
const logged = [];
const host = { log: { info: (m, meta) => logged.push([m, meta]), warn: (m) => logged.push([`WARN ${m}`]), error() {} } };
const world = new MapWorld({ cfg: { enabled: true }, dataDir, timezone: TZ, persist: () => {} });
await world.start(host);
ok(logged.some(([m]) => /小地图已启动/.test(m)), 'start 打了启动日志');

const names = world.tools().map((t) => t.name).sort();
ok(names.join(',') === 'map_add,map_cover,map_edit,map_look,map_places,map_view', `六个工具都在：${names.join(',')}`);
ok(MAP_TOOL_DECLS.length === 6, 'MAP_TOOL_DECLS 六条');
for (const t of world.tools()) {
  ok(typeof t.handler === 'function', `${t.name} 有 handler`);
  ok(typeof t.description === 'string' && t.description.length > 10, `${t.name} 有描述`);
  ok(t.parameters?.type === 'object', `${t.name} 有 parameters`);
}

// envPromptVars 不抛，且空地图时两块都空
let vars;
try {
  vars = world.envPromptVars();
  ok(true, 'envPromptVars() 不抛');
} catch (err) {
  ok(false, 'envPromptVars() 不抛', err.message);
  vars = {};
}
ok(typeof vars.map_places_block === 'string', 'map_places_block 是字符串');
ok(typeof vars.map_imggen_block === 'string', 'map_imggen_block 是字符串');
ok(typeof vars.map_feast_block === 'string', 'map_feast_block 是字符串');
ok(vars.map_places_block === '', '空地图时不注入地点清单');
ok(vars.map_imggen_block === '', '没装生图时不注入发图那句');
ok(vars.map_feast_block === '', '没装鱼的每一天时不注入写日程那句');

// 关掉 mapOn：不注入
const ui = world.webUi('zh');
ok(ui.label === definition.label, 'webUi label');
ok(Array.isArray(ui.lamps) && ui.lamps.length === 1, 'webUi 有一盏灯');
ok(Array.isArray(ui.config) && ui.config.length === 1, 'webUi 一组配置');
ok(ui.promptDocs?.[0]?.key === 'worlds.map.env', 'webUi 的 promptDocs key 是 worlds.map.env');
const cfgPaths = Object.keys(ui.config[0].schema.properties);
ok(cfgPaths.every((p) => p.startsWith('worlds.map.')), `配置路径都在 worlds.map. 段：${cfgPaths.join(',')}`);
ok(cfgPaths.length === 5, `配置项就是 5 个，实际 ${cfgPaths.length}`);
ok(cfgPaths.includes('worlds.map.mapFeastOn'), '配置里有 mapFeastOn');
ok(cfgPaths.includes('worlds.map.mapFunOn'), '配置里有 mapFunOn');
ok(Array.isArray(ui.panels) && ui.panels.length === 1, 'webUi 声明一个面板');
ok(ui.panels[0].id === 'places', '面板 id 是 places');

console.log('5) 真跑一遍（选地形 → 看一处 → 加一处 → 传图 → 整张图）');
const tool = (n) => world.tools().find((t) => t.name === n).handler;
const pick = await ui.invoke('places', 'terrain', [{ id: 'forest' }]);
ok(pick.ok === true, `选地形成功：${pick.error ?? pick.added?.join('、')}`);
ok(pick.added.length === 5, `林间建了 5 处，实际 ${pick.added.length}`);

// 勾选式：只勾两处，只该加那两处（预设不再「点了就全加」）
const sel = await ui.invoke('places', 'terrain', [{ id: 'riverside', ids: ['riverside-home', 'riverside-old-pier'] }]);
ok(sel.ok === true && sel.added.length === 2, `勾选只加 2 处，实际 ${sel.added?.length}`);
const afterSel = await tool('map_places')({});
ok(/周围一共 7 处地方/.test(afterSel.text), `5+2=7 处，实际：${afterSel.text.slice(0, 30)}`);
ok(!/芦苇滩/.test(afterSel.text), '没勾的那处不该出现');

const places = await tool('map_places')({});
ok(/周围一共 7 处地方/.test(places.text), `map_places 有正文：${places.text.slice(0, 40)}`);

const look = await tool('map_look')({ place: '溪边' });
ok(/溪边/.test(look.text), 'map_look 认得溪边');
ok(/还没写描写/.test(look.text), '空描写时明说空着（绝不替主人编）');
ok(!/imggen_draw/.test(look.text), '没装生图时不提 imggen_draw');
ok(!/feast_life/.test(look.text), '没装鱼的每一天时不提 feast_life_*');

// 旅游预设：勾一处，带 funVenue；没装娱乐时间就不许提 fun_go
const trav = await ui.invoke('places', 'terrain', [{ id: 'travel', ids: ['travel-seaside-town'] }]);
ok(trav.ok === true && trav.added.length === 1, `旅游加了 1 处：${trav.added?.join('、')}`);
const travelLook = await tool('map_look')({ place: '海边小镇' });
ok(/海边小镇/.test(travelLook.text), 'map_look 认得旅游那处');
ok(!/fun_go/.test(travelLook.text), '没装娱乐时间就不许提 fun_go');
ok(/【旅行】/.test((await tool('map_view')({})).text), 'map_view 有「旅行」那一段');

// 注意别用「旧码头」——江边那套的 `riverside-old-pier` 正名就是它，会撞名。
const added = await tool('map_add')({ name: '巷口小卖部', kind: '常去的', desc: '玻璃柜台，夏天有冰柜' });
ok(/巷口小卖部/.test(added.text) && /常去的/.test(added.text), `map_add 加上了：${added.text.slice(0, 40)}`);

// 传一张真 PNG（走面板入口，和 WebUI 上传同一个路径）
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32, 5)]);
const up = await ui.invoke('places', 'upload', [{ id: 'forest-creek', data: `data:image/png;base64,${png.toString('base64')}` }]);
ok(up.ok === true, `传图成功：${up.error ?? up.cover}`);
const back = await ui.invoke('places', 'cover', [{ id: 'forest-creek' }]);
ok(back.dataUrl.startsWith('data:image/png;base64,'), '读回 base64 data URL（面板就这么显示）');

const view = await tool('map_view')({});
ok(/【家】/.test(view.text) && /【周围】/.test(view.text), 'map_view 分组铺开');
ok(!/路线|坐标|导航|公里/.test(view.text), 'map_view 不带路线字眼');

// 内联提示词：有地点之后该有清单，但仍然不提生图
const vars2 = world.envPromptVars();
ok(vars2.map_places_block.includes('溪边'), '有地点之后注入清单');
ok(vars2.map_imggen_block === '', '没装生图时仍然不注入发图那句');
ok(!/imggen_draw/.test(vars2.map_places_block), '清单里不出现 imggen_draw');

// 写了 scene、装了生图之后才出现
const root2 = await mkdtemp(join(tmpdir(), 'map-smoke-2-'));
const dataDir2 = join(root2, 'data', 'home', 'companion');
await mkdir(dataDir2, { recursive: true });
await writeFile(join(dataDir2, '..', 'config.json'), JSON.stringify({ worlds: { imggen: { enabled: true } } }), 'utf8');
const w2 = new MapWorld({ cfg: { enabled: true }, dataDir: dataDir2, timezone: TZ, persist: () => {} });
await w2.start(host);
const ui2 = w2.webUi('zh');
await ui2.invoke('places', 'terrain', [{ id: 'forest' }]);
const t2 = (n) => w2.tools().find((t) => t.name === n).handler;
await t2('map_edit')({ place: '溪边', desc: '一条很浅的溪', scene: '溪边' });
const look2 = await t2('map_look')({ place: '溪边' });
ok(/imggen_draw/.test(look2.text), '三条全满足时才递 imggen_draw');
ok(/scene\` 填「溪边」/.test(look2.text), '点名的是主人填的那个 scene');
const vars3 = w2.envPromptVars();
ok(vars3.map_imggen_block !== '', '装了生图且有 scene 之后注入发图那句');
await w2.stop();
await rm(root2, { recursive: true, force: true });

console.log('6) 坏输入不炸');
const bad1 = await tool('map_look')({ place: '火星基地' });
ok(/没有/.test(bad1.text) && bad1.failed !== true, '报不存在的地方：给正文，不算失败');
const bad2 = await tool('map_look')({ place: { evil: true } });
ok(typeof bad2.text === 'string', 'object 当 place：给字符串回执');
const bad3 = await tool('map_places')({ kind: '火星' });
ok(typeof bad3.text === 'string' && /家/.test(bad3.text), 'kind 坏值：说明能填什么');

console.log('7) stop');
await world.stop();
const r = await tool('map_places')({});
ok(r.failed === true && /失败/.test(r.text), '停之后再调工具：failed 回执，不抛');
ok(logged.every(([m]) => typeof m === 'string'), '输出是字符串');

await rm(root, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(`X ${failures} 项没过`);
  process.exit(1);
}
console.log('全部通过');
