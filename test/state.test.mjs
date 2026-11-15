/**
 * 地点状态纯逻辑的测试。
 *
 * 重点：
 *   1. 加/改/删/传图/置顶/换地形都不抛错，坏输入给 error 不炸；
 *   2. **「有 cover 就锁死」**：`editPlace` 改不到 cover，也没有任何「重生」函数；
 *   3. **换地形只追加不删**（方案 §3：换地形不删已有地点）；
 *   4. 落盘状态里不会混进 geo 字段。
 */
import assert from 'node:assert/strict';

import { test, report } from './harness.mjs';
import {
  MAX_ALIASES, MAX_PLACES, addPlace, applyTerrain, applyTerrainSelection, editPlace, kindLabelOf,
  listPlaces, newState, normalizeKind, normalizeState, placeById, placeView, removePlace,
  resolvePlace, setCover, summaryOf,
} from '../src/state.js';
import { terrainPlaces } from '../src/places.js';

/** 一个已经选了「林间」的状态。 */
function forestState() {
  const st = newState();
  const r = applyTerrain(st, 'forest', 1000);
  assert.ok(!r.error, r.error);
  return st;
}

// ---------------------------------------------------------------------------
// 空状态 / 归一化
// ---------------------------------------------------------------------------

test('newState 是空的：没有地形、没有地点', () => {
  const st = newState();
  assert.equal(st.terrain, '');
  assert.deepEqual(st.places, []);
});

test('normalizeState：坏输入一律回空状态，不抛错', () => {
  for (const bad of [null, undefined, '字符串', 42, []]) {
    const st = normalizeState(bad);
    assert.deepEqual(st.places, [], `坏输入 ${String(bad)} 该回空`);
    assert.equal(st.terrain, '');
  }
});

test('normalizeState：没 id/没名字的丢掉，重复 id 只留一条', () => {
  const st = normalizeState({
    places: [
      { id: 'a', name: '甲' },
      { id: 'a', name: '甲二' },
      { name: '没 id' },
      { id: 'b' },
      { id: 'c', name: '丙' },
    ],
  });
  assert.deepEqual(st.places.map((p) => p.id), ['a', 'c']);
  assert.equal(st.places[0].name, '甲', '重复 id 留第一条');
});

test('normalizeState：落盘状态里不会留下 geo 字段', () => {
  const st = normalizeState({
    places: [{ id: 'a', name: '甲', lat: 1, lng: 2, route: ['x'], distance: 10, geo: {} }],
  });
  const p = st.places[0];
  for (const key of ['lat', 'lng', 'route', 'distance', 'geo']) {
    assert.ok(!(key in p), `落盘状态里不该有「${key}」`);
  }
});

test('normalizeState：地形认不出来就置空（不让脏地形 id 活下来）', () => {
  assert.equal(normalizeState({ terrain: 'forest', places: [] }).terrain, 'forest');
  assert.equal(normalizeState({ terrain: '火星', places: [] }).terrain, '火星', '这里只归一化，校验交给 terrainOf');
});

// ---------------------------------------------------------------------------
// 预设地形
// ---------------------------------------------------------------------------

test('applyTerrain：建一套 5 处，地形记上，返回新加的那几条', () => {
  const st = forestState();
  assert.equal(st.terrain, 'forest');
  assert.equal(st.places.length, 5);
  assert.equal(st.places.filter((p) => p.kind === 'home').length, 1);
});

test('applyTerrain：同一套选两次不会变成两份（幂等）', () => {
  const st = forestState();
  const again = applyTerrain(st, 'forest', 2000);
  assert.deepEqual(again.added, [], '第二次一条都不该加');
  assert.equal(st.places.length, 5, '还是 5 处');
});

test('applyTerrain：换地形只追加，不删已有地点（方案 §3）', () => {
  const st = forestState();
  // 先把「溪边」写上描写，换地形之后它必须还在、且没被冲掉
  editPlace(st, 'forest-creek', { desc: '一条很浅的溪，石头是青的' }, 1500);
  const r = applyTerrain(st, 'neighborhood', 3000);
  assert.equal(r.added.length, 5, '该追加小区的 5 处');
  assert.equal(st.places.length, 10, '林间 + 小区 = 10 处');
  assert.equal(st.terrain, 'neighborhood', '地形切到新的');
  assert.equal(placeById(st, 'forest-creek').desc, '一条很浅的溪，石头是青的', '旧地点的描写必须还在');
});

test('applyTerrain：不认识的地形给 error，不动状态', () => {
  const st = forestState();
  const r = applyTerrain(st, '火星', 4000);
  assert.ok(r.error, '该报错');
  assert.equal(st.places.length, 5, '一处都不该加');
  assert.equal(st.terrain, 'forest', '地形不该变');
});

// ---------------------------------------------------------------------------
// 勾选式追加（预设不再「点了就全加」）
// ---------------------------------------------------------------------------

test('applyTerrainSelection：只加勾上的那几处', () => {
  const st = newState();
  const r = applyTerrainSelection(st, 'forest', ['forest-home', 'forest-creek'], 100);
  assert.deepEqual(st.places.map((p) => p.id), ['forest-home', 'forest-creek'], '只该有勾的那两处');
  assert.deepEqual(r.added.map((p) => p.id), ['forest-home', 'forest-creek']);
  assert.equal(st.terrain, 'forest');
});

test('applyTerrainSelection：传空数组 = 一处都不加（不是错误）', () => {
  const st = forestState();
  const r = applyTerrainSelection(st, 'riverside', [], 100);
  assert.deepEqual(r.added, []);
  assert.equal(r.error, '', '全不选不算错');
  assert.equal(st.places.length, 5, '一处都不该加');
  assert.equal(st.terrain, 'forest', '没选就不该改地形');
});

test('applyTerrainSelection：已有的那几处跳过、不覆盖主人改过的内容', () => {
  // 空状态先只勾两处，再补勾一处（第三处是新的）
  const st = newState();
  applyTerrainSelection(st, 'forest', ['forest-home', 'forest-creek'], 50);
  editPlace(st, 'forest-creek', { desc: '一条很浅的溪' }, 60);
  const r = applyTerrainSelection(st, 'forest', ['forest-creek', 'forest-clearing'], 100);
  assert.deepEqual(r.added.map((p) => p.id), ['forest-clearing'], '只加缺的那处');
  assert.deepEqual(r.skipped, ['forest-creek'], '已有的报进 skipped');
  assert.equal(placeById(st, 'forest-creek').desc, '一条很浅的溪', '已有的描写不许被覆盖');
  assert.equal(st.places.length, 3);
});

test('applyTerrainSelection：undefined = 全加（旧「点了就全加」的行为）', () => {
  const st = newState();
  applyTerrainSelection(st, 'foothill', undefined, 0);
  assert.equal(st.places.length, 5);
  assert.equal(st.terrain, 'foothill');
});

test('applyTerrainSelection：不认识的地形给 error，不动状态', () => {
  const st = forestState();
  const r = applyTerrainSelection(st, '火星', ['x'], 0);
  assert.ok(r.error);
  assert.equal(st.places.length, 5);
});

test('旅游那套勾进来之后 kind 是 travel，且带 funVenue', () => {
  const st = forestState();
  applyTerrainSelection(st, 'travel', ['travel-seaside-town', 'travel-snow-inn'], 0);
  const seaside = placeById(st, 'travel-seaside-town');
  assert.equal(seaside.kind, 'travel');
  assert.equal(seaside.funVenue, '江边');
  assert.equal(seaside.terrain, 'travel');
  // 和居住地形并存，互不影响
  assert.equal(placeById(st, 'forest-creek').kind, 'around');
});

test('地形骨架的 id 带地形前缀，两套的「家」不撞', () => {
  const st = forestState();
  applyTerrain(st, 'riverside', 5000);
  const homes = st.places.filter((p) => p.kind === 'home');
  assert.equal(homes.length, 2, '两套各一个家');
  assert.equal(new Set(homes.map((p) => p.id)).size, 2, 'id 不许撞');
  assert.deepEqual(homes.map((p) => p.id).sort(), ['forest-home', 'riverside-home']);
});

// ---------------------------------------------------------------------------
// 加 / 改 / 删
// ---------------------------------------------------------------------------

test('addPlace：只填文字就能建一处，id 自动起', () => {
  const st = newState();
  const { place, error } = addPlace(st, { name: '旧码头', kind: 'around', desc: '木板上有个洞' }, 10);
  assert.ok(!error, error);
  assert.equal(place.name, '旧码头');
  assert.equal(place.desc, '木板上有个洞');
  assert.ok(place.id, '该自动起一个 id');
  assert.equal(st.places.length, 1);
});

test('addPlace：没名字 / 撞正名 / 超上限 都只回 error，不抛错', () => {
  const st = newState();
  assert.ok(addPlace(st, {}, 0).error, '没名字该报错');
  assert.ok(addPlace(st, { name: '   ' }, 0).error, '空白名字该报错');

  addPlace(st, { name: '旧码头' }, 0);
  const dup = addPlace(st, { name: '旧码头' }, 0);
  assert.ok(dup.error, '撞正名该报错');
  assert.equal(st.places.length, 1, '撞了就不该加进去');

  // 灌到上限
  for (let i = 0; i < MAX_PLACES; i += 1) addPlace(st, { name: `地方${i}` }, 0);
  const over = addPlace(st, { name: '再来一处' }, 0);
  assert.ok(over.error, '超上限该报错');
});

test('addPlace：坐标等 geo 字段填进来也会被丢掉', () => {
  const st = newState();
  const { place } = addPlace(st, { name: '某处', lat: 31, lng: 121, distance: 300, route: ['a'] }, 0);
  for (const key of ['lat', 'lng', 'distance', 'route']) {
    assert.ok(!(key in place), `不该留下「${key}」`);
  }
});

test('editPlace：只改传进来的字段，没传的一个字都不动', () => {
  const st = forestState();
  editPlace(st, 'forest-creek', { desc: '一条很浅的溪', style: '水彩，青灰' }, 100);
  editPlace(st, 'forest-creek', { frequent: true }, 200);
  const p = placeById(st, 'forest-creek');
  assert.equal(p.desc, '一条很浅的溪', '第二次只改 frequent，描写不许被冲掉');
  assert.equal(p.style, '水彩，青灰');
  assert.equal(p.frequent, true);
});

test('editPlace：改不到 cover（有图就锁死那条）', () => {
  const st = forestState();
  setCover(st, 'forest-creek', 'creek.png', 100);
  editPlace(st, 'forest-creek', { cover: 'other.png', desc: '改了描写' }, 200);
  assert.equal(placeById(st, 'forest-creek').cover, 'creek.png',
    'editPlace 不该能改 cover——换图只能走 map_cover/setCover');
});

test('editPlace：改成别人的正名会被拦下，不抛错', () => {
  const st = forestState();
  const r = editPlace(st, 'forest-creek', { name: '老橡树' }, 100);
  assert.ok(r.error, '该拦');
  assert.equal(placeById(st, 'forest-creek').name, '溪边', '名字没变');
});

test('editPlace：找不到那一处只回 error', () => {
  const st = forestState();
  const r = editPlace(st, '不存在', { desc: 'x' }, 0);
  assert.ok(r.error);
  assert.deepEqual(r.changed, []);
});

test('editPlace：别名整套替换，且去重去空', () => {
  const st = forestState();
  editPlace(st, 'forest-creek', { aliases: ['小溪', '', '小溪', '溪水'] }, 0);
  assert.deepEqual(placeById(st, 'forest-creek').aliases, ['小溪', '溪水']);
  assert.ok(MAX_ALIASES >= 2);
});

test('removePlace：删掉就没了，删不存在的回 error', () => {
  const st = forestState();
  const r = removePlace(st, 'forest-creek', 0);
  assert.equal(r.removed.name, '溪边');
  assert.equal(st.places.length, 4);
  assert.ok(removePlace(st, 'forest-creek', 0).error, '删第二次该报错');
});

// ---------------------------------------------------------------------------
// 传图 / 锁死
// ---------------------------------------------------------------------------

test('setCover：挂图 / 换图 / 清空 都走这一条', () => {
  const st = forestState();
  assert.equal(setCover(st, 'forest-creek', 'creek.png', 0).cover, 'creek.png');
  assert.equal(setCover(st, 'forest-creek', 'creek2.webp', 0).cover, 'creek2.webp', '换图');
  const cleared = setCover(st, 'forest-creek', '', 0);
  assert.equal(cleared.cleared, true);
  assert.equal(placeById(st, 'forest-creek').cover, '', '清空之后就没有图了');
});

test('setCover：路径和怪异文件名都被挡住（只收文件名）', () => {
  const st = forestState();
  assert.equal(setCover(st, 'forest-creek', 'a/b/c.png', 0).cover, 'c.png', '目录被剥掉');
  const before = placeById(st, 'forest-creek').cover;
  const bad = setCover(st, 'forest-creek', '有空格 的名字.png', 0);
  assert.ok(bad.error, '不安全的文件名该被拒');
  assert.equal(placeById(st, 'forest-creek').cover, before, '拒了就该保持原样，不能挂上去也不能清掉');
  // 空串是「清空」，不是「被拒」——这两件事不能混
  assert.equal(setCover(st, 'forest-creek', '', 0).cleared, true);
  assert.equal(placeById(st, 'forest-creek').cover, '');
});

test('setCover：找不到地点回 error，不抛错', () => {
  const st = forestState();
  const r = setCover(st, '不存在', 'x.png', 0);
  assert.ok(r.error);
  assert.equal(r.cover, '');
});

// ---------------------------------------------------------------------------
// 列 / 摘要 / 视图
// ---------------------------------------------------------------------------

test('listPlaces：常去的排最前，其次 家 > 常去的 > 周围', () => {
  const st = newState();
  addPlace(st, { name: '周围甲', kind: 'around' }, 0);
  addPlace(st, { name: '家', kind: 'home' }, 0);
  addPlace(st, { name: '常去甲', kind: 'frequent' }, 0);
  addPlace(st, { name: '周围乙', kind: 'around', frequent: true }, 0);

  const names = listPlaces(st).map((p) => p.name);
  assert.equal(names[0], '周围乙', '标了常去的排最前（即使 kind 是 around）');
  // 剩下的按 kind：home → 常去的 → 周围
  assert.deepEqual(names.slice(1), ['家', '常去甲', '周围甲']);
});

test('listPlaces：kind 筛（英文 id 和中文标签都认），认不出就当没筛', () => {
  const st = forestState();
  assert.equal(listPlaces(st, { kind: 'home' }).length, 1);
  assert.equal(listPlaces(st, { kind: '家' }).length, 1);
  assert.equal(listPlaces(st, { kind: 'around' }).length, 4);
  assert.equal(listPlaces(st, { kind: '周围' }).length, 4);
  assert.equal(listPlaces(st, { kind: '莫名其妙' }).length, 5, '认不出就当没筛，别回空');
  assert.equal(listPlaces(st, { kind: '' }).length, 5);
});

test('normalizeKind：三档 + 中文 + 空', () => {
  assert.equal(normalizeKind('home'), 'home');
  assert.equal(normalizeKind('家'), 'home');
  assert.equal(normalizeKind('常去'), 'frequent');
  assert.equal(normalizeKind('常去的'), 'frequent');
  assert.equal(normalizeKind('附近'), 'around');
  assert.equal(normalizeKind('火星'), '');
  assert.equal(normalizeKind(null), '');
});

test('summaryOf：数得清总数 / 有图 / 有 scene / 有 funVenue / 常去 / 家 / 旅行', () => {
  const st = forestState();
  setCover(st, 'forest-creek', 'creek.png', 0);
  editPlace(st, 'forest-creek', { scene: '溪边' }, 0);
  editPlace(st, 'forest-home', { frequent: true }, 0);
  applyTerrainSelection(st, 'travel', ['travel-seaside-town'], 0);
  const s = summaryOf(st);
  assert.deepEqual(s, {
    total: 6, withCover: 1, withScene: 1, withFunVenue: 1, frequent: 1, home: 1, travel: 1,
  });
});

test('placeView：把 hasScene 算好给出去（面板和回执共用一个判据）', () => {
  const st = forestState();
  const p = placeById(st, 'forest-creek');
  assert.equal(placeView(p).hasScene, false, '空 scene 该是 false');
  editPlace(st, 'forest-creek', { scene: '溪边' }, 0);
  const v = placeView(placeById(st, 'forest-creek'));
  assert.equal(v.hasScene, true);
  assert.equal(v.scene, '溪边');
  assert.equal(v.kindLabel, '周围');
  assert.equal(placeView(null), null);
});

test('kindLabelOf：三档都有中文，认不出的落「周围」', () => {
  assert.equal(kindLabelOf('home'), '家');
  assert.equal(kindLabelOf('frequent'), '常去的');
  assert.equal(kindLabelOf('around'), '周围');
  assert.equal(kindLabelOf('火星'), '周围');
});

test('resolvePlace：id 和正名都能找', () => {
  const st = forestState();
  assert.equal(resolvePlace(st, 'forest-creek')?.name, '溪边');
  assert.equal(resolvePlace(st, '溪边')?.id, 'forest-creek');
  assert.equal(resolvePlace(st, '小溪')?.id, 'forest-creek');
  assert.equal(resolvePlace(st, '火星'), null);
});

test('所有写操作都会更新 updatedAt', () => {
  const st = forestState();
  assert.equal(st.updatedAt, 1000);
  addPlace(st, { name: '新地方' }, 2222);
  assert.equal(st.updatedAt, 2222);
});

test('state 里没有任何 geo 字段（落盘形状守门）', () => {
  const st = forestState();
  applyTerrain(st, 'foothill', 0);
  for (const key of ['route', 'routes', 'distance', 'coords', 'navigation', 'x', 'y']) {
    assert.ok(!(key in st), `state 顶层不该有「${key}」`);
    for (const p of st.places) {
      assert.ok(!(key in p), `${p.id} 不该有「${key}」`);
    }
  }
});

test('terrainPlaces 交给 applyTerrain 时形状不变（骨架没被改坏）', () => {
  const before = terrainPlaces('riverside');
  const st = newState();
  applyTerrain(st, 'riverside', 0);
  assert.deepEqual(st.places.map((p) => p.id), before.map((p) => p.id));
  assert.deepEqual(terrainPlaces('riverside').map((p) => p.desc), before.map((p) => p.desc), '骨架是纯函数，不该被调用方改掉');
});

await report();
