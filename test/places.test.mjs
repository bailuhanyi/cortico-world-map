/**
 * 地点库 + 归一化的测试。
 *
 * 重点钉三件事：
 *   1. **不带的红线**：place 里不许有任何 geo 字段，四套地形没有一个「远近/路线」字眼；
 *   2. **预设地形**：四套各有 5 个空 desc 骨架，`kind` 里恰有一个 `home`；
 *   3. **`scene` 是字符串不是读库**：`hasScene` 的判定和 fun-world 逐字一致，
 *      预设骨架的 scene 全是空串（骨架不知道主人库里有什么，猜一个就是错）。
 */
import assert from 'node:assert/strict';

import { test, report } from './harness.mjs';
import {
  KIND_LABEL, KINDS, TERRAINS, coverName, findPlace, findTerrain, hasFunVenue, hasScene, isSafeId,
  isTerrain, normalizeKind, normalizePlace, slugFor, terrainPlaces,
} from '../src/places.js';

// ---------------------------------------------------------------------------
// 红线：不带路线、坐标、距离、导航
// ---------------------------------------------------------------------------

/**
 * 会出现在 place 上的 geo 字段名（含常见变体）。
 * 这条表就是需求红线的机器版：**加一个 geo 字段进来，测试必须红**。
 */
const GEO_KEYS = [
  'lat', 'lng', 'lon', 'latitude', 'longitude', 'coord', 'coords', 'coordinates',
  'x', 'y', 'xy', 'pos', 'position', 'location', 'geo', 'geojson', 'bbox',
  'route', 'routes', 'path', 'paths', 'distance', 'dist', 'km', 'meters', 'eta',
  'bearing', 'heading', 'direction', 'directions', 'nav', 'navigate', 'navigation',
  'walk', 'walkingMinutes', 'minutesAway', 'nearby', 'adjacent', 'edges', 'links',
];

/** 描写里不该出现的「远近 / 路线」字眼。 */
const GEO_WORDS = /路线|导航|坐标|经纬|公里|千米|米远|多远|几步|路口|左转|右转|直走|沿路|地图上的[东西南北]|西北|东南|徒步几分|车程/;

const ALL_SKELETONS = TERRAINS.flatMap((t) => terrainPlaces(t.id));

test('五套地形（四套居住地形 + 一套旅游），每套 3–5 个地点，id 唯一', () => {
  assert.equal(TERRAINS.length, 5, '四套居住地形 + 一套旅游（2026-11-15 加）');
  for (const t of TERRAINS) {
    assert.ok(t.places.length >= 3 && t.places.length <= 5, `${t.label} 该有 3–5 处，实际 ${t.places.length}`);
  }
  const ids = ALL_SKELETONS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, '地点 id 重复了');
});

test('四套居住地形各有恰一个 kind=home（旅游那套没有「家」）', () => {
  for (const t of TERRAINS.filter((x) => x.id !== 'travel')) {
    const ps = terrainPlaces(t.id);
    assert.equal(ps.filter((p) => p.kind === 'home').length, 1, `${t.label} 应当恰有一个「家」`);
    assert.equal(ps.filter((p) => p.kind === 'around').length, ps.length - 1, `${t.label} 其余该是「周围」`);
  }
  // 旅游那套全归 travel，没有「家」也没有「周围」
  const travel = terrainPlaces('travel');
  assert.equal(travel.filter((p) => p.kind === 'travel').length, travel.length, '旅游那套全该是 travel');
  assert.equal(travel.filter((p) => p.kind === 'home').length, 0, '旅游那套不该有「家」');
  // 林间那套的「家」带树洞/小木屋这类别名（方案 §3 表里点名的）
  const forestHome = terrainPlaces('forest')[0];
  assert.equal(forestHome.name, '家');
  assert.ok(forestHome.aliases.includes('树洞') || forestHome.aliases.includes('小木屋'), '林间的家该带树洞/小木屋别名');
});

test('预设骨架全是空 desc / 空 style / 空 scene（主人只改文字、传图）', () => {
  for (const p of ALL_SKELETONS) {
    assert.equal(p.desc, '', `${p.name} 的 desc 该是空的`);
    assert.equal(p.style, '', `${p.name} 的 style 该是空的`);
    assert.equal(p.scene, '', `${p.name} 的 scene 该是空的（骨架不知道库里有什么）`);
    assert.equal(p.cover, '', `${p.name} 不该预置图`);
    assert.equal(p.frequent, false, `${p.name} 不该预置常去`);
  }
});

test('旅游预设预置 funVenue（娱乐时间里最接近的那处），居住地形一律留空', () => {
  const travel = terrainPlaces('travel');
  const FUN_VENUES = ['江边', '爬山', '旧货市场', '澡堂', '公园'];
  for (const p of travel) {
    assert.ok(p.funVenue, `${p.name} 该预置一个 funVenue`);
    assert.ok(FUN_VENUES.includes(p.funVenue), `${p.name} 的 funVenue「${p.funVenue}」不在 fun 那二十处里`);
    assert.equal(hasFunVenue(p), true);
  }
  // 居住地形不该预置：那些地方本来就有自己的名字，不需要映射
  for (const t of TERRAINS.filter((x) => x.id !== 'travel')) {
    for (const p of terrainPlaces(t.id)) {
      assert.equal(p.funVenue, '', `${p.name} 不该预置 funVenue`);
      assert.equal(hasFunVenue(p), false);
    }
  }
});

test('守门断言：place 不含任何 geo 字段（不带路线/坐标/距离/导航）', () => {
  for (const p of ALL_SKELETONS) {
    for (const key of GEO_KEYS) {
      assert.ok(!(key in p), `${p.id} 不该有字段「${key}」——这是不带路线的红线`);
    }
  }
  // 归一化之后也不能悄悄多出 geo 字段：塞进去的老脏数据要被丢掉。
  const dirty = normalizePlace({
    id: 'creek', name: '溪边', kind: 'around', desc: '一条很浅的溪',
    lat: 31.2, lng: 121.5, route: ['家', '溪边'], distance: 300, geo: { x: 1 },
  });
  for (const key of GEO_KEYS) {
    assert.ok(!(key in dirty), `归一化之后不该留下「${key}」`);
  }
  assert.equal(dirty.desc, '一条很浅的溪', '该留的字段要留着');
});

test('守门断言：归一化后的 place 字段集合就是那十一个', () => {
  const EXPECTED = [
    'id', 'name', 'aliases', 'kind', 'desc', 'style', 'cover', 'scene', 'funVenue', 'frequent', 'terrain',
  ];
  for (const p of ALL_SKELETONS) {
    assert.deepEqual(Object.keys(p).sort(), [...EXPECTED].sort(), `${p.id} 的字段集合漂了`);
  }
});

test('守门断言：地形文案里没有远近/路线字眼', () => {
  for (const t of TERRAINS) {
    assert.ok(!GEO_WORDS.test(t.note), `${t.label} 的说明里出现了路线字样：${t.note}`);
    for (const p of t.places) {
      const blob = [p.name, ...(p.aliases ?? [])].join(' ');
      assert.ok(!GEO_WORDS.test(blob), `${t.label} 的「${p.name}」里出现了路线字样：${blob}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

test('normalizePlace：认不出的 kind 落 around，脏别名去重去空', () => {
  const p = normalizePlace({
    id: 'x', name: '测试处', kind: '莫名其妙', aliases: ['甲', '', ' 甲  ', '乙', null, '甲'],
  });
  assert.equal(p.kind, 'around');
  assert.deepEqual(p.aliases, ['甲', '乙'], '别名要去重、去空、去和正名重复的');
  assert.equal(normalizePlace({ id: 'x', name: '测试处', aliases: ['测试处'] }).aliases.length, 0,
    '别名等于正名时该被丢掉');
});

test('normalizePlace：没 id 或没名字就丢掉（不抛错）', () => {
  assert.equal(normalizePlace(null), null);
  assert.equal(normalizePlace({}), null);
  assert.equal(normalizePlace({ id: 'a' }), null);
  assert.equal(normalizePlace({ name: '只有名字' }), null);
  assert.equal(normalizePlace('字符串'), null);
});

test('normalizePlace：terrain 认不出来就留空，认得出来就留', () => {
  assert.equal(normalizePlace({ id: 'a', name: 'A', terrain: 'forest' }).terrain, 'forest');
  assert.equal(normalizePlace({ id: 'a', name: 'A', terrain: '火星' }).terrain, '');
  assert.equal(normalizePlace({ id: 'a', name: 'A' }, 'forest').terrain, 'forest', '骨架回填地形');
});

test('coverName：只留文件名，剥掉目录，不安全的名字变空', () => {
  assert.equal(coverName('creek.png'), 'creek.png');
  assert.equal(coverName('a/b/c.webp'), 'c.webp');
  assert.equal(coverName('..\\..\\evil.png'), 'evil.png');
  assert.equal(coverName('../../etc/passwd'), 'passwd');
  assert.equal(coverName('有空格.png'), '', '中文/空格的文件名不受支持，该变空');
  assert.equal(coverName(''), '');
  assert.equal(coverName(null), '');
});

// ---------------------------------------------------------------------------
// hasScene：和 fun-world 同一套
// ---------------------------------------------------------------------------

test('hasScene：只看字符串非空（不读库、不猜）', () => {
  assert.equal(hasScene({ scene: '溪边' }), true);
  assert.equal(hasScene({ scene: '  溪边  ' }), true);
  assert.equal(hasScene({ scene: '' }), false);
  assert.equal(hasScene({ scene: '   ' }), false);
  assert.equal(hasScene({ scene: null }), false);
  assert.equal(hasScene({}), false);
  assert.equal(hasScene(null), false);
  assert.equal(hasScene({ name: '溪边' }), false, '名字不是 scene——绝不兜成名字');
});

test('预设骨架一处都不带 scene（所以出厂时绝不会提发图填什么）', () => {
  assert.equal(ALL_SKELETONS.filter(hasScene).length, 0);
});

// ---------------------------------------------------------------------------
// 查找
// ---------------------------------------------------------------------------

test('守门断言：id 会被拼进图片文件名，所以不安全的一律丢掉', () => {
  // 手改坏的 state.json 塞一个 '../../evil'，落盘时就会写到数据目录外面。
  for (const bad of ['../../evil', 'a/b', '..', 'x..y', '', 'C:\\x', 'a b']) {
    assert.equal(isSafeId(bad), false, `${JSON.stringify(bad)} 该被判不安全`);
    assert.equal(normalizePlace({ id: bad, name: '坏地方' }), null, `${JSON.stringify(bad)} 该整条丢掉`);
  }
  for (const good of ['creek', 'forest-creek', 'forest_home', 'a.b', 'p1']) {
    assert.equal(isSafeId(good), true, `${good} 该合法`);
    assert.ok(normalizePlace({ id: good, name: '地方' }), `${good} 该留下`);
  }
  // 预设骨架的 id 必须全都合法（它们也要拼文件名）
  for (const p of ALL_SKELETONS) {
    assert.equal(isSafeId(p.id), true, `骨架 id ${p.id} 不合法`);
  }
});

test('findPlace：正名 > 别名 > id > 唯一包含；歧义回 null', () => {
  const places = terrainPlaces('forest');
  assert.equal(findPlace(places, '溪边')?.name, '溪边');
  assert.equal(findPlace(places, '小溪')?.name, '溪边', '别名该认');
  assert.equal(findPlace(places, 'forest-creek')?.name, '溪边', 'id 该认');
  assert.equal(findPlace(places, '老橡')?.name, '老橡树', '唯一包含该认');
  assert.equal(findPlace(places, ''), null);
  assert.equal(findPlace(places, '火星'), null);
  assert.equal(findPlace([], '溪边'), null);
  // 「大」同时是「大橡树」和……这里只测唯一性：不相干就 null
  assert.equal(findPlace(places, '空地')?.name, '林间空地');
});

test('findTerrain / isTerrain：四套都认，中文标签也认', () => {
  for (const t of TERRAINS) {
    assert.equal(isTerrain(t.id), true, `${t.id} 该合法`);
    assert.equal(findTerrain(t.id)?.id, t.id);
    assert.equal(findTerrain(t.label)?.id, t.id, `中文标签「${t.label}」该认`);
  }
  assert.equal(isTerrain('火星'), false);
  assert.equal(findTerrain('火星'), null);
  assert.equal(findTerrain(''), null);
  assert.equal(findTerrain(null), null);
});

test('slugFor：撞了就加序号，不会产出重复 id', () => {
  assert.equal(slugFor('creek', []), 'creek');
  assert.equal(slugFor('creek', [{ id: 'creek' }]), 'creek-2');
  assert.equal(slugFor('creek', [{ id: 'creek' }, { id: 'creek-2' }]), 'creek-3');
  // 中文名产不出 ascii，回落到 place-N
  assert.ok(/^place-\d+$/.test(slugFor('溪边', [])), `实际：${slugFor('溪边', [])}`);
  assert.equal(new Set([slugFor('x', []), slugFor('x', [{ id: 'x' }])]).size, 2);
});

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

test('KIND_LABEL / KINDS 四档齐全（含行）', () => {
  assert.deepEqual([...KINDS], ['home', 'frequent', 'around', 'travel']);
  for (const k of KINDS) assert.ok(KIND_LABEL[k], `${k} 缺中文标签`);
  assert.equal(KIND_LABEL.travel, '旅行');
});

test('五套地形的 label 就是那五个', () => {
  assert.deepEqual(TERRAINS.map((t) => t.label), ['林间', '小区', '江边', '山脚', '旅行']);
  assert.deepEqual(TERRAINS.map((t) => t.id), ['forest', 'neighborhood', 'riverside', 'foothill', 'travel']);
});

await report();
