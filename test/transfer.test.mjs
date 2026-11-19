import assert from 'node:assert/strict';
import { test, report } from './harness.mjs';
import { newState, normalizeState } from '../src/state.js';
import { buildExport, prepareImport, MAX_COVER_BYTES } from '../src/transfer.js';

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d49484452', 'hex')]);
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const place = (id, name, cover = '') => ({
  id, name, aliases: [], kind: 'around', desc: '', style: '', cover, scene: '', funVenue: '', frequent: false, terrain: '',
});
const stateWith = (...places) => ({ ...newState(), places });

 test('buildExport emits versioned bundle and exports referenced covers only', async () => {
  const state = stateWith(place('creek', '溪边', 'creek.png'), place('park', '公园'));
  const bundle = await buildExport(state, async (filename) => filename === 'creek.png' ? dataUrl : '');
  assert.deepEqual(Object.keys(bundle), ['format', 'version', 'state', 'covers']);
  assert.equal(bundle.format, 'little-world');
  assert.equal(bundle.version, 1);
  assert.deepEqual(Object.keys(bundle.covers), ['creek.png']);
});

test('buildExport rejects missing or invalid images instead of dropping them', async () => {
  await assert.rejects(buildExport(stateWith(place('creek', '溪边', 'creek.png')), async () => ''), /读取图片失败/);
  await assert.rejects(buildExport(stateWith(place('creek', '溪边', 'creek.png')), async () => 'data:image/png;base64,aGk='), /魔数/);
});

test('prepareImport skip merges only new ids and reports same-name conflict', () => {
  const current = stateWith(place('old-id', '已有地点'));
  const bundle = { format: 'little-world', version: 1, state: stateWith(place('new-id', '已有地点'), place('fresh-id', '新地点')), covers: {} };
  const result = prepareImport(current, bundle, { mode: 'skip' });
  assert.deepEqual(result.summary.added, ['fresh-id']);
  assert.deepEqual(result.summary.skipped, ['new-id']);
  assert.equal(result.summary.conflicts.length, 1);
  assert.match(result.summary.conflicts[0], /重名/);
  assert.deepEqual(current.places.map((p) => p.id), ['old-id']);
});

test('prepareImport merge updates only existing ids and preserves local-only fields', () => {
  const localPlace = place('shared', '地点', 'local.png');
  localPlace.tags = ['本地标签'];
  localPlace.relations = [{ placeId: 'local-target', note: '本地关联' }];
  const local = { ...stateWith(localPlace, place('local-target', '本地新增')), homeId: 'shared' };
  const incoming = place('shared', '地点');
  incoming.desc = '备份描写';
  incoming.tags = ['备份标签'];
  const result = prepareImport(local, { format: 'little-world', version: 1, state: stateWith(incoming, place('new-place', '不应新增')), covers: {} }, { mode: 'merge' });
  assert.deepEqual(result.summary.updated, ['shared']);
  assert.deepEqual(result.summary.added, []);
  assert.deepEqual(result.summary.skipped, ['new-place']);
  const updated = result.state.places[0];
  assert.equal(updated.name, '地点');
  assert.equal(updated.desc, '备份描写');
  assert.equal(updated.cover, 'local.png');
  assert.deepEqual(updated.tags, ['本地标签']);
  assert.deepEqual(updated.relations, localPlace.relations);
  assert.equal(result.state.places[1].name, '本地新增');
  assert.equal(result.state.homeId, 'shared');
  assert.ok(result.summary.conflicts.some((s) => s.includes('tags')));
});

test('prepareImport overwrite updates same id, keeps names unique, preserves valid homeId', () => {
  const current = { ...stateWith(place('shared', '旧名')), homeId: 'shared' };
  const incoming = { ...stateWith(place('shared', '新名'), place('other', '他处')), homeId: 'other' };
  const result = prepareImport(current, { format: 'little-world', version: 1, state: incoming, covers: {} }, { mode: 'overwrite' });
  assert.deepEqual(result.summary.updated, ['shared']);
  assert.deepEqual(result.summary.added, ['other']);
  assert.equal(result.state.homeId, 'other');
});

test('prepareImport ignores broken imported homeId and retains current home when valid', () => {
  const current = { ...stateWith(place('home-one', '家')), homeId: 'home-one' };
  const incoming = { ...stateWith(place('new-place', '新地方')), homeId: 'missing' };
  const result = prepareImport(current, { format: 'little-world', version: 1, state: incoming, covers: {} });
  assert.equal(result.state.homeId, 'home-one');
});

test('prepareImport validates bundle version, ids, image presence and data', () => {
  const state = stateWith(place('safe-id', '地点', 'safe-id.png'));
  const base = { format: 'little-world', version: 1, state, covers: { 'safe-id.png': dataUrl } };
  assert.throws(() => prepareImport(newState(), { ...base, version: 2 }), /不支持导入版本/);
  assert.throws(() => prepareImport(newState(), { ...base, state: stateWith(place('../escape', '坏 id')) }), /id 不安全/);
  assert.throws(() => prepareImport(newState(), { ...base, covers: {} }), /图片缺失/);
  assert.throws(() => prepareImport(newState(), { ...base, covers: { 'safe-id.png': 'data:image/png;base64,aGk=' } }), /魔数/);
});

test('prepareImport validates image byte ceiling and data-url base64 strictly', () => {
  const oversized = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(MAX_COVER_BYTES)]);
  const encoded = `data:image/png;base64,${oversized.toString('base64')}`;
  const state = stateWith(place('large', '大图', 'large.png'));
  assert.throws(() => prepareImport(newState(), { format: 'little-world', version: 1, state, covers: { 'large.png': encoded } }), /8 MiB/);
  assert.throws(() => prepareImport(newState(), { format: 'little-world', version: 1, state, covers: { 'large.png': 'data:image/png;base64,%%%%' } }), /data URL/);
});

test('prepareImport produces safe unique image names and only for imported places', () => {
  const current = stateWith(place('skip-me', '已有'));
  const incoming = stateWith(place('skip-me', '已有', 'a.png'), place('new-place', '新', 'b.png'));
  const bundle = { format: 'little-world', version: 1, state: incoming, covers: { 'a.png': dataUrl, 'b.png': dataUrl, unused: 'not-data' } };
  const result = prepareImport(current, bundle, { mode: 'skip' });
  assert.equal(result.images.length, 1);
  assert.match(result.images[0].filename, /^new-place\.import-[a-f0-9]{12}\.png$/);
  assert.equal(result.state.places.find((p) => p.id === 'new-place').cover, result.images[0].filename);
});

test('prepareImport respects the 60-place ceiling but allows historical over-capacity state', () => {
  const historical = Array.from({ length: 61 }, (_, i) => place(`old-${i}`, `旧地点${i}`));
  const current = normalizeState(stateWith(...historical));
  const bundle = { format: 'little-world', version: 1, state: stateWith(place('fresh', '新地点')), covers: {} };
  const result = prepareImport(current, bundle);
  assert.equal(result.state.places.length, 61);
  assert.deepEqual(result.summary.added, []);
  assert.deepEqual(result.summary.skipped, ['fresh']);
  assert.equal(result.summary.warnings.length, 1);
});

test('relations round-trip and missing skipped targets are removed with warning', async () => {
  const source = stateWith({ ...place('house', '小屋'), relations: [{ placeId: 'creek', note: '窗边能看见溪面' }] }, place('creek', '溪边'));
  const bundle = await buildExport(source);
  const roundTrip = prepareImport(newState(), bundle);
  assert.deepEqual(roundTrip.state.places.find((p) => p.id === 'house').relations, [{ placeId: 'creek', note: '窗边能看见溪面' }]);
  const conflict = prepareImport(stateWith(place('other-creek', '溪边')), bundle);
  assert.deepEqual(conflict.state.places.find((p) => p.id === 'house').relations, []);
  assert.ok(conflict.summary.warnings.some((w) => w.includes('关联')));
  assert.equal(source.places[0].relations.length, 1);
});

test('merge preserves all existing fields, missing fields and false; never writes retained images', () => {
  const p = { ...place('shared', '地点', 'same.png'), desc: '本地新描写', style: '本地画风', aliases: ['本地别名'], tags: ['本地标签'], scene: '场景', funVenue: '场所', terrain: 'forest', frequent: false };
  const current = normalizeState(stateWith(p));
  const bundle = { format: 'little-world', version: 1, state: stateWith({ ...place('shared', '地点', 'same.png'), desc: '', style: '旧画风', frequent: true }), covers: { 'same.png': dataUrl } };
  const snapshot = JSON.stringify([current, bundle]);
  const result = prepareImport(current, bundle, { mode: 'merge' });
  assert.deepEqual(result.state.places, current.places);
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.summary.updated, []);
  assert.equal(JSON.stringify([current, bundle]), snapshot);
  const partial = { ...bundle, state: stateWith({ id: 'shared', name: '地点' }), covers: {} };
  assert.deepEqual(prepareImport(current, partial, { mode: 'merge' }).state.places, current.places);
});

test('merge skips identity conflicts, preserves home and excludes ambiguous relation targets', () => {
  const current = normalizeState({ ...stateWith({ ...place('one', '本地家'), kind: 'home' }, place('two', '本地咖啡店')), homeId: 'one' });
  const bundle = { format: 'little-world', version: 1, state: { ...stateWith({ ...place('one', '本地家'), relations: [{ placeId: 'two', note: '共享相册' }] }, { ...place('two', '旧备份书店'), desc: '不应进入' }), homeId: 'two' }, covers: {} };
  const result = prepareImport(current, bundle, { mode: 'merge' });
  assert.deepEqual(result.state.places, current.places);
  assert.equal(result.state.homeId, 'one');
  assert.ok(result.summary.conflicts.some((s) => s.includes('名称不同')));
  assert.ok(result.summary.warnings.some((s) => s.includes('关联')));
});

test('merge fills cover and relations to local-only targets without touching unrelated local cover', () => {
  const current = normalizeState(stateWith(place('one', '已有'), place('two', '本地独有', 'same.png')));
  const bundle = { format: 'little-world', version: 1, state: stateWith({ id: 'one', name: '已有', cover: 'same.png', relations: [{ placeId: 'two', note: '共享相册' }] }), covers: { 'same.png': dataUrl } };
  const result = prepareImport(current, bundle, { mode: 'merge' });
  assert.equal(result.images.length, 1);
  assert.match(result.state.places[0].cover, /^one\.import-/);
  assert.equal(result.state.places[1].cover, 'same.png');
  assert.deepEqual(result.state.places[0].relations, bundle.state.places[0].relations);
  assert.deepEqual(result.summary.updated, ['one']);
});

test('coverFocus export/import roundtrip and old backups remain compatible', async () => {
  const focused = { ...place('crop', '图片', 'crop.png'), coverFocus: { x: 12.5, y: 99 }, modifiedAt: 123.5 };
  const bundle = await buildExport(stateWith(focused), async () => dataUrl);
  assert.deepEqual(bundle.state.places[0].coverFocus, focused.coverFocus);
  assert.equal(bundle.state.places[0].modifiedAt, 123.5);
  const imported = prepareImport(newState(), JSON.parse(JSON.stringify(bundle)));
  assert.deepEqual(imported.state.places[0].coverFocus, focused.coverFocus);
  assert.equal(imported.state.places[0].modifiedAt, 123.5);
  const again = await buildExport(imported.state, async () => dataUrl);
  assert.deepEqual(again.state.places[0].coverFocus, focused.coverFocus);
  assert.equal(again.state.places[0].modifiedAt, 123.5);
  delete bundle.state.places[0].coverFocus;
  delete bundle.state.places[0].modifiedAt;
  const old = prepareImport(newState(), bundle);
  assert.equal(Object.hasOwn(old.state.places[0], 'coverFocus'), false);
  assert.equal(old.state.places[0].modifiedAt, 0);
});

test('imports preserve local modification times while new backup places retain theirs', () => {
  const local = { ...place('shared', '地点'), modifiedAt: 900 };
  const older = { ...place('shared', '地点'), desc: '备份描写', modifiedAt: 100 };
  const incomingNew = { ...place('new-place', '新地点'), modifiedAt: 200 };
  const bundle = { format: 'little-world', version: 1, state: stateWith(older, incomingNew), covers: {} };
  const merged = prepareImport(stateWith({ ...local, desc: '' }), bundle, { mode: 'merge' });
  assert.equal(merged.state.places.find((p) => p.id === local.id).modifiedAt, 900);
  assert.equal(merged.state.places.find((p) => p.id === local.id).desc, '备份描写');
  const overwritten = prepareImport(stateWith(local), bundle, { mode: 'overwrite' });
  assert.equal(overwritten.state.places.find((p) => p.id === local.id).modifiedAt, 900);
  assert.equal(overwritten.state.places.find((p) => p.id === 'new-place').modifiedAt, 200);
  const legacy = { ...older };
  delete legacy.modifiedAt;
  const legacyOverwrite = prepareImport(stateWith(local), { ...bundle, state: stateWith(legacy) }, { mode: 'overwrite' });
  assert.equal(legacyOverwrite.state.places[0].modifiedAt, 900);
});

test('merge adopts imported crop only with its cover; overwrite never retains unrelated crop', () => {
  const local = { ...place('shared', '地点', 'local.png'), coverFocus: { x: 5, y: 10 } };
  const incoming = { ...place('shared', '地点', 'incoming.png'), coverFocus: { x: 70, y: 90 } };
  const bundle = { format: 'little-world', version: 1, state: stateWith(incoming), covers: { 'incoming.png': dataUrl } };
  for (const focus of [local.coverFocus, undefined]) {
    const current = stateWith({ ...local, coverFocus: focus });
    const result = prepareImport(current, bundle, { mode: 'merge' });
    assert.equal(result.state.places[0].cover, local.cover);
    assert.deepEqual(result.state.places[0].coverFocus, focus);
    assert.equal(result.images.length, 0);
    assert.deepEqual(current.places[0].coverFocus, focus);
  }
  const filled = prepareImport(stateWith({ ...local, cover: '' }), bundle, { mode: 'merge' });
  assert.deepEqual(filled.state.places[0].coverFocus, incoming.coverFocus);
  assert.equal(filled.images.length, 1);
  assert.deepEqual(filled.items[0].changes.find((c) => c.field === 'coverFocus').result, incoming.coverFocus);
  const overwritten = prepareImport(stateWith(local), bundle, { mode: 'overwrite' });
  assert.deepEqual(overwritten.state.places[0].coverFocus, incoming.coverFocus);
  delete incoming.coverFocus;
  for (const mode of ['merge', 'overwrite']) {
    const current = stateWith({ ...local, cover: mode === 'merge' ? '' : local.cover });
    assert.equal(Object.hasOwn(prepareImport(current, bundle, { mode }).state.places[0], 'coverFocus'), false);
  }
  incoming.cover = '';
  incoming.coverFocus = { x: 99, y: 99 };
  assert.equal(Object.hasOwn(prepareImport(stateWith(local), bundle, { mode: 'overwrite' }).state.places[0], 'coverFocus'), false);
});

await report();
