/**
 * 地点状态的纯逻辑：加、改、传图、置顶、换地形、列出。
 *
 * 不碰文件、不碰定时器、不碰宿主，便于单测；World 只负责把结果变成工具回执。
 *
 * 状态形状（落 `<dataDir>/map/state.json`）：
 * {
 *   version: 1,
 *   terrain: 'forest',            // 当前地形 id（'' = 还没选）
 *   places: [place...],           // 每条的字段严格照 places.normalizePlace（含可选 modifiedAt）
 *   updatedAt: 0,                 // ms
 * }
 *
 * place.modifiedAt 是可选的非负毫秒时间戳；旧 v1 记录归一后按 0 处理。版本号仍为 1。
 * **没有路线、没有坐标、没有距离**：数字字段只有时间戳（`updatedAt` / `modifiedAt`），不表示地理位置。`test/places.test.mjs` 有守门断言钉住这件事。
 *
 * **「有 cover 就锁死」在这里落成两件事**：
 *   1. `setCover()` 是唯一能改 `cover` 的入口——没有别的地方会自己写它；
 *   2. 本模块**没有任何「重生/重画」函数**。要换图只能主人手动再 `setCover` 一次，
 *      或者先 `setCover(state, id, '')` 清空。代码永远不会替她重新生成一张。
 */

import {
  KINDS, findPlaceCandidates, hasFunVenue, hasScene, normalizeCoverFocus, normalizeKind, normalizeModifiedAt, normalizePlace, slugFor, terrainPlaces,
} from './places.js';

export const STATE_VERSION = 1;

/** 一个地点最多存几个别名。 */
export const MAX_ALIASES = 8;
/** 一条地点最多存多少个地点（防手滑灌爆）。 */
export const MAX_PLACES = 60;

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function touchPlace(place, nowMs) {
  place.modifiedAt = normalizeModifiedAt(nowMs);
}

/** 空状态。 */
export function newState() {
  return { version: STATE_VERSION, terrain: '', places: [], updatedAt: 0 };
}

/**
 * 把磁盘上的旧状态补齐成当前形状（不信任文件内容）。
 *
 * 认不出的 place 直接丢掉（没 id 没名字的那种）；多余字段一律丢——
 * 老状态里混进来的 `lat` / `lng` / `route` 不会活到下一次落盘。
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return newState();
  const terrain = text(raw.terrain, 20);
  const places = [];
  const seen = new Set();
  for (const it of Array.isArray(raw.places) ? raw.places : []) {
    const p = normalizePlace(it, terrain);
    if (!p) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    places.push(p);
    // 旧版本可能已超限：保留有效地点，容量限制只在新增入口执行，避免重启丢数据。
  }
  const placeIds = new Set(places.map((p) => p.id));
  for (const place of places) {
    place.relations = place.relations.filter((relation) => placeIds.has(relation.placeId));
  }
  return {
    version: STATE_VERSION,
    terrain,
    places,
    ...(places.some((p) => p.id === raw.homeId && p.kind === 'home') ? { homeId: raw.homeId } : {}),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
  };
}

/**
 * 列出地点：`frequent` 的排最前，其次按 kind（家 → 常去的 → 周围），
 * 同档保持原顺序（她改过的先后关系不会被悄悄打乱）。
 *
 * `kind` 可以是三档之一，也可以写中文标签（「家」「常去的」「周围」）。
 * 认不出来就当没筛（不抛错、不回空——她随口写个词不该把列表清空）。
 */
export function listPlaces(state, { kind = '' } = {}) {
  const all = Array.isArray(state?.places) ? state.places : [];
  const want = normalizeKind(kind);
  const filtered = want ? all.filter((p) => p.kind === want) : all;
  const rank = { home: 0, frequent: 1, around: 2 };
  return filtered
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => {
      const fa = a.p.frequent ? 0 : 1;
      const fb = b.p.frequent ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const ka = rank[a.p.kind] ?? 2;
      const kb = rank[b.p.kind] ?? 2;
      if (ka !== kb) return ka - kb;
      return a.idx - b.idx;
    })
    .map((x) => x.p);
}

/** `kind` 归一（实现放在 places.js，这里转出去，工具和面板都从这一条路走）。 */
export { normalizeKind };

/** 按 id 找；找不到返回 null。 */
export function placeById(state, id) {
  const key = text(id, 40);
  if (!key) return null;
  return (state?.places ?? []).find((p) => p.id === key) ?? null;
}

/**
 * 加一个地点。
 *
 * 只填文字：`name / aliases / kind / desc / style`，**不填坐标**（也没有坐标可填）。
 * `scene` 允许填——那是主人自己知道库里有什么才填的正名字符串，不是我们读出来的。
 *
 * 返回 `{ place, error }`：error 非空表示没加（名字空、或撞了正名），
 * 不抛错——她随口起个名字不该炸。
 */
export function addPlace(state, input = {}, nowMs = 0) {
  if (!state || !Array.isArray(state.places)) return { place: null, error: '状态还没准备好' };
  const name = text(input.name, 40);
  if (!name) return { place: null, error: '得给这处地方起个名字' };
  const dup = state.places.find((p) => p.name === name);
  if (dup) return { place: null, error: `已经有一处叫「${name}」了，换个名字或者直接改那一处` };
  if (state.places.length >= MAX_PLACES) {
    return { place: null, error: `地点太多了（最多 ${MAX_PLACES} 处），先删掉几处再加` };
  }
  const place = normalizePlace({
    id: slugFor(name, state.places),
    name,
    aliases: input.aliases,
    tags: input.tags,
    kind: input.kind,
    desc: input.desc,
    style: input.style,
    cover: '',
    scene: input.scene,
    funVenue: input.funVenue,
    frequent: input.frequent === true,
    terrain: text(input.terrain, 20) || state.terrain,
  });
  if (!place) return { place: null, error: '这处地方没建起来' };
  touchPlace(place, nowMs);
  state.places.push(place);
  state.updatedAt = Number(nowMs) || 0;
  return { place, error: '' };
}

/**
 * 改一处地点的文字描写 / 置顶 / 改 style / 改别名 / 改 scene / 改 funVenue / 改归类。
 *
 * **改不到 `cover`**：图片只有 `setCover()` 能碰（「有 cover 就锁死」那条）。
 * 只改传进来的字段，没传的一律不动——她只说「改成常去」，不该把描写的字冲掉。
 * 传空串是**清空**（例如把 `scene` 清掉，以后就不再提发图填什么）。
 */
export function editPlace(state, id, patch = {}, nowMs = 0) {
  const place = placeById(state, id);
  if (!place) return { place: null, changed: [], error: `没有这一处（${text(id, 40) || '空'}）` };
  const changed = [];
  const setIf = (key, next) => {
    if (next === undefined) return;
    if (place[key] === next) return;
    place[key] = next;
    changed.push(key);
  };
  if (patch.name !== undefined) {
    const name = text(patch.name, 40);
    if (name && name !== place.name) {
      const dup = state.places.find((p) => p !== place && p.name === name);
      if (dup) return { place, changed, error: `已经有一处叫「${name}」了` };
      setIf('name', name);
    }
  }
  if (patch.aliases !== undefined) {
    const aliases = normalizePlace({ ...place, aliases: patch.aliases }).aliases;
    if (JSON.stringify(place.aliases ?? []) !== JSON.stringify(aliases)) setIf('aliases', aliases);
  }
  if (patch.tags !== undefined) {
    const tags = normalizePlace({ ...place, tags: patch.tags }).tags;
    if (JSON.stringify(place.tags ?? []) !== JSON.stringify(tags)) setIf('tags', tags);
  }
  if (patch.kind !== undefined) {
    const kind = normalizeKind(patch.kind);
    if (kind) setIf('kind', kind);
  }
  if (patch.desc !== undefined) setIf('desc', text(patch.desc, 400));
  if (patch.style !== undefined) setIf('style', text(patch.style, 160));
  if (patch.scene !== undefined) setIf('scene', text(patch.scene, 40));
  if (patch.funVenue !== undefined) setIf('funVenue', text(patch.funVenue, 40));
  if (patch.frequent !== undefined) setIf('frequent', patch.frequent === true);
  if (patch.relations !== undefined) {
    const relations = normalizePlace({ ...place, relations: patch.relations }).relations.filter((relation) => state.places.some((target) => target.id === relation.placeId));
    if (JSON.stringify(place.relations) !== JSON.stringify(relations)) {
      place.relations = relations;
      changed.push('relations');
    }
  }
  if (changed.length) touchPlace(place, nowMs);
  state.updatedAt = Number(nowMs) || 0;
  return { place, changed, error: '' };
}

/**
 * 传图 / 换图 / 清空。
 *
 * `filename` 传空串 = 清空（清空之后主人才可以「重画」——本插件自己不画，
 * 这里只表示「这处现在没有锁死的图」）。
 *
 * 只收文件名，不收路径（`coverName` 会把目录剥掉、把不安全的名字变成空）。
 * 返回 `{ place, cover, cleared, error }`。
 */
export function setCover(state, id, filename, nowMs = 0) {
  const place = placeById(state, id);
  if (!place) return { place: null, cover: '', cleared: false, error: `没有这一处（${text(id, 40) || '空'}）` };
  const want = text(filename, 160);
  if (!want) {
    if (place.cover || place.coverFocus) {
      place.cover = '';
      delete place.coverFocus;
      touchPlace(place, nowMs);
      state.updatedAt = Number(nowMs) || 0;
    }
    return { place, cover: '', cleared: true, error: '' };
  }
  const safe = normalizePlace({ ...place, cover: want }).cover;
  if (!safe) return { place, cover: place.cover, cleared: false, error: '这个文件名不能用（只收字母、数字、点、短横和下划线）' };
  if (place.cover !== safe || place.coverFocus) {
    place.cover = safe;
    delete place.coverFocus;
    touchPlace(place, nowMs);
    state.updatedAt = Number(nowMs) || 0;
  }
  return { place, cover: safe, cleared: false, error: '' };
}

/** Set the crop anchor for the currently attached cover only. */
export function setCoverFocus(state, id, focus, nowMs = 0) {
  const place = placeById(state, id);
  if (!place) return { place: null, changed: false, error: `没有这一处（${text(id, 40) || '空'}）` };
  if (!place.cover) return { place, changed: false, error: '这处还没有图片' };
  const next = normalizeCoverFocus(focus);
  if (!next) return { place, changed: false, error: '图片焦点 x、y 必须是 0 到 100 的有限数字' };
  const previous = place.coverFocus ?? { x: 50, y: 50 };
  const changed = previous.x !== next.x || previous.y !== next.y;
  if (changed) {
    if (next.x === 50 && next.y === 50) delete place.coverFocus;
    else place.coverFocus = next;
    touchPlace(place, nowMs);
    state.updatedAt = Number(nowMs) || 0;
  }
  return { place, changed, error: '' };
}

/** 删掉一处地点。返回 `{ removed, error }`。 */
export function removePlace(state, id, nowMs = 0) {
  const place = placeById(state, id);
  if (!place) return { removed: null, error: `没有这一处（${text(id, 40) || '空'}）` };
  state.places = state.places.filter((p) => p !== place);
  for (const remaining of state.places) {
    const relations = remaining.relations ?? [];
    const kept = relations.filter((relation) => relation.placeId !== place.id);
    if (kept.length !== relations.length) {
      remaining.relations = kept;
      touchPlace(remaining, nowMs);
    }
  }
  if (state.homeId === place.id) state.homeId = '';
  state.updatedAt = Number(nowMs) || 0;
  return { removed: place, error: '' };
}

/**
 * 换 / 加一套地形：**只追加，不删已有地点**（方案 §3「换地形不删已有地点」）。
 *
 * 默认把这一套**全部**加进来（`applyTerrainSelection(state, id, null)` 的简写）。
 * 面板走的是勾选版 `applyTerrainSelection`——预设不再「点了就全加」，
 * 但工具和测试里「一次加全套」仍然用得着这个入口。
 *
 * 已经同 id 的骨架跳过，所以连点两次「选林间」不会变成两份家。
 * 返回 `{ added, terrain, error }`：added 是新加的那几条，空数组表示本来就有。
 */
export function applyTerrain(state, terrainId, nowMs = 0) {
  return applyTerrainSelection(state, terrainId, null, nowMs);
}

/**
 * 勾选式追加：只加 `wantedIds` 里那几条（`null` = 全选）。
 *
 * 面板的勾选表走这里。几个刻意的行为：
 *   - `wantedIds` 传了但一条都不匹配骨架 → `added` 为空、`error` 为空，
 *     调用方据此说「这几处本来就在」而不是当成失败；
 *   - 已经有同 id 的跳过（不覆盖**主人改过的**那处，可能是他重命名过的）；
 *   - **不删**任何已有地点，换地形/补地形都只往上加。
 *
 * @param {object} state
 * @param {string} terrainId 地形 id（或中文标签）
 * @param {string[]|null} wantedIds 只加这些骨架 id；null/undefined = 全加
 * @param {number} nowMs
 * @param {{withDescriptions?: boolean}} options 为新地点启用示例描写；已有地点不变
 * @returns {{added: object[], terrain: string, skipped: string[], error: string}}
 */
export function applyTerrainSelection(state, terrainId, wantedIds = null, nowMs = 0, options = {}) {
  const empty = { added: [], terrain: '', skipped: [], error: '' };
  if (!state || !Array.isArray(state.places)) return { ...empty, error: '状态还没准备好' };
  const skeletons = terrainPlaces(terrainId, options);
  if (!skeletons.length) return { ...empty, error: `没有「${text(terrainId, 20)}」这套地形` };

  const wanted = Array.isArray(wantedIds) ? new Set(wantedIds.filter((x) => typeof x === 'string')) : null;
  const taken = new Set(state.places.map((p) => p.id));
  const added = [];
  const skipped = [];
  for (const p of skeletons) {
    if (wanted && !wanted.has(p.id)) continue;
    if (taken.has(p.id)) { skipped.push(p.id); continue; }
    taken.add(p.id);
    added.push(p);
  }
  const available = Math.max(0, MAX_PLACES - state.places.length);
  if (added.length > available) {
    return {
      added: [], terrain: state.terrain, skipped,
      error: `地点最多 ${MAX_PLACES} 处，当前已有 ${state.places.length} 处，剩余 ${available} 处容量；本次需新增 ${added.length} 处，整次未添加，请减少勾选或先删除地点`,
    };
  }
  for (const place of added) touchPlace(place, nowMs);
  state.places.push(...added);
  // 一条都没选（勾选表被全不选）时不动地形——「我还没决定」不等于「我选了这套」。
  if (added.length || !wanted || wanted.size) {
    state.terrain = skeletons[0].terrain;
  }
  state.updatedAt = Number(nowMs) || 0;
  return { added, terrain: state.terrain, skipped, error: '' };
}

/**
 * 一处地方的「此刻摘要」，面板和回执共用。
 *
 * 明确把 `hasScene` / `hasFunVenue` 算好给出去：面板要显示「生图时 scene 填「X」」
 * 还是「库里没有这处，scene 不用填」，判据只有这一个函数，不各写一份。
 */
export function placeCompleteness(place, state) {
  const incoming = new Set((state?.places ?? []).flatMap((item) => (item.relations ?? []).filter((r) => r.placeId === place?.id).map(() => item.id)));
  const hasRelation = (place?.relations ?? []).length > 0 || incoming.size > 0;
  return {
    missingDesc: !text(place?.desc, 400),
    missingCover: !text(place?.cover, 160),
    orphan: !hasRelation,
    missingRelationTarget: Array.isArray(state?.places)
      && (place?.relations ?? []).some((r) => !state.places.some((target) => target.id === r.placeId)),
  };
}

export function placeView(place, state) {
  if (!place) return null;
  return {
    id: place.id,
    name: place.name,
    aliases: [...(place.aliases ?? [])],
    kind: place.kind,
    kindLabel: kindLabelOf(place.kind),
    desc: place.desc,
    style: place.style,
    cover: place.cover,
    ...(place.cover && place.coverFocus ? { coverFocus: { ...place.coverFocus } } : {}),
    hasCover: Boolean(place.cover),
    scene: place.scene,
    hasScene: hasScene(place),
    funVenue: place.funVenue ?? '',
    hasFunVenue: hasFunVenue(place),
    frequent: place.frequent,
    modifiedAt: normalizeModifiedAt(place.modifiedAt),
    terrain: place.terrain,
    tags: [...(place.tags ?? [])],
    completeness: placeCompleteness(place, state),
    relations: (place.relations ?? []).map((relation) => ({ ...relation })),
  };
}

/** kind 的中文标签（面板用）。四档，认不出的落「周围」。 */
export function kindLabelOf(kind) {
  return {
    home: '家', frequent: '常去的', around: '周围', travel: '旅行',
  }[kind] ?? '周围';
}

/** 统计（面板徽章用）。 */
export function summaryOf(state) {
  const places = Array.isArray(state?.places) ? state.places : [];
  return {
    total: places.length,
    withCover: places.filter((p) => p.cover).length,
    withScene: places.filter(hasScene).length,
    withFunVenue: places.filter(hasFunVenue).length,
    frequent: places.filter((p) => p.frequent).length,
    home: places.filter((p) => p.kind === 'home').length,
    travel: places.filter((p) => p.kind === 'travel').length,
  };
}

/** 按 id、名字或别名返回候选，供工具回执请求用户澄清。 */
export function resolvePlaceCandidates(state, name) {
  const exactId = placeById(state, name);
  if (exactId) return [exactId];
  if (['家', '家里', '回家'].includes(typeof name === 'string' ? name.trim() : '')) {
    const home = placeById(state, state?.homeId);
    if (home?.kind === 'home') return [home];
  }
  return findPlaceCandidates(state?.places, name);
}

/** 按名字或 id 找（工具入参用）；歧义返回 null，调用方可另取候选。 */
export function resolvePlace(state, name) {
  const candidates = resolvePlaceCandidates(state, name);
  return candidates.length === 1 ? candidates[0] : null;
}
