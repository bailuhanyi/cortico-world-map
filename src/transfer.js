import { createHash } from 'node:crypto';
import { MAX_PLACES, normalizeState } from './state.js';
import { normalizePlace } from './places.js';

export const TRANSFER_FORMAT = 'little-world';
export const TRANSFER_VERSION = 1;
export const MAX_COVER_BYTES = 8 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAGIC = [
  { mime: 'image/png', ext: 'png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 },
  { mime: 'image/gif', ext: 'gif', test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

function fail(message) {
  throw new Error(message);
}

function sniff(bytes) {
  return MAGIC.find((m) => m.test(bytes)) ?? null;
}

function assertSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..');
}

function assertStateShape(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.places)) fail('状态格式无效');
  const seen = new Set();
  for (const place of state.places) {
    if (!place || !assertSafeId(place.id)) fail('地点 id 不安全');
    if (seen.has(place.id)) fail(`地点 id 重复：${place.id}`);
    seen.add(place.id);
  }
}

function retainHomeId(state) {
  if (!Object.hasOwn(state, 'homeId')) return state;
  const valid = state.places.some((place) => place.id === state.homeId);
  state.homeId = valid ? state.homeId : '';
  return state;
}

const MERGE_FIELDS = ['aliases', 'tags', 'kind', 'desc', 'style', 'scene', 'funVenue', 'terrain', 'relations'];

function isBlank(value) {
  return Array.isArray(value) ? value.length === 0 : typeof value === 'string' ? value.trim() === '' : value == null;
}

/** Merge only into local blanks. A non-empty local value is an intentional choice. */
function mergeLocalFirst(current, incoming, raw, conflicts) {
  const merged = { ...current };
  const filled = [];
  for (const key of MERGE_FIELDS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!isBlank(current[key]) && JSON.stringify(current[key]) !== JSON.stringify(incoming[key])) {
      conflicts.push(`${current.name}（${current.id}）的 ${key} 与备份不同，保留本地内容`);
    }
    if (isBlank(current[key]) && !isBlank(incoming[key])) {
      merged[key] = Array.isArray(incoming[key]) ? [...incoming[key]] : incoming[key];
      filled.push(key);
    }
  }
  for (const key of ['cover', 'frequent']) {
    if (Object.hasOwn(raw, key) && !isBlank(current[key]) && JSON.stringify(current[key]) !== JSON.stringify(incoming[key])) {
      conflicts.push(`${current.name}（${current.id}）的 ${key} 保留本地内容`);
    }
  }
  if (Object.hasOwn(raw, 'cover') && isBlank(current.cover) && !isBlank(incoming.cover)) {
    merged.cover = incoming.cover;
    if (incoming.coverFocus) merged.coverFocus = { ...incoming.coverFocus };
    else delete merged.coverFocus;
    filled.push('cover');
  }
  return { merged, filled };
}

function dataUrlBytes(dataUrl, filename) {
  if (typeof dataUrl !== 'string') fail(`图片数据无效：${filename}`);
  const match = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[1].length === 0) fail(`图片不是有效的 base64 data URL：${filename}`);
  const encoded = match[1];
  if (encoded.length > Math.ceil(MAX_COVER_BYTES / 3) * 4) fail(`图片超过 8 MiB：${filename}`);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_COVER_BYTES || bytes.toString('base64') !== encoded) fail(`图片大小或 base64 编码无效：${filename}`);
  const image = sniff(bytes);
  if (!image) fail(`图片魔数不受支持：${filename}`);
  return { bytes, image };
}

function bundleSize(bundle) {
  let json;
  try { json = JSON.stringify(bundle); } catch { fail('导入内容无法序列化'); }
  if (Buffer.byteLength(json, 'utf8') > MAX_BUNDLE_BYTES) fail('导入文件超过 64 MiB');
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) fail('导入文件格式无效');
  bundleSize(bundle);
  if (bundle.format !== TRANSFER_FORMAT) fail('不是小世界导出文件');
  if (bundle.version !== TRANSFER_VERSION) fail(`不支持导入版本：${String(bundle.version)}`);
  assertStateShape(bundle.state);
  if (!bundle.covers || typeof bundle.covers !== 'object' || Array.isArray(bundle.covers)) fail('图片清单格式无效');
  return bundle;
}

/** Create a portable bundle. readCover(filename, place) returns a data URL or {dataUrl}. */
export async function buildExport(state, readCover) {
  assertStateShape(state);
  const normalized = retainHomeId({ ...normalizeState(state), ...(Object.hasOwn(state, 'homeId') ? { homeId: state.homeId } : {}) });
  const covers = {};
  for (const place of normalized.places) {
    if (!place.cover) continue;
    if (!SAFE_FILENAME.test(place.cover) || place.cover.includes('..')) fail(`图片文件名不安全：${place.cover}`);
    if (typeof readCover !== 'function') fail(`缺少图片读取器：${place.cover}`);
    const result = await readCover(place.cover, place);
    const dataUrl = typeof result === 'string' ? result : result?.dataUrl;
    if (!dataUrl) fail(`读取图片失败：${place.cover}`);
    dataUrlBytes(dataUrl, place.cover);
    covers[place.cover] = dataUrl;
  }
  const bundle = { format: TRANSFER_FORMAT, version: TRANSFER_VERSION, state: normalized, covers };
  bundleSize(bundle);
  return bundle;
}

/** 逐项选择：`[{ id, mode }]`。没给就是整次一个模式（老契约）。 */
function parseDecisions(decisions) {
  if (decisions === undefined || decisions === null) return null;
  if (!Array.isArray(decisions)) fail('逐项选择格式无效');
  const map = new Map();
  for (const item of decisions) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !ITEM_MODES.includes(item.mode)) {
      fail('逐项选择格式无效');
    }
    map.set(item.id, item.mode);
  }
  return map;
}

const ITEM_MODES = ['skip', 'merge', 'overwrite'];
/** 面板逐项差异要展示的字段（顺序固定，面板按它铺行）。 */
const ITEM_FIELDS = ['name', 'aliases', 'tags', 'kind', 'desc', 'style', 'scene', 'funVenue', 'terrain', 'relations', 'frequent', 'cover', 'coverFocus'];

function itemOf(place, local, result, action, mode, conflicts, raw) {
  const changes = ITEM_FIELDS.map((field) => {
    const localValue = local ? local[field] : '';
    const incomingValue = Object.hasOwn(raw, field) ? raw[field] : place[field];
    const resultValue = result ? result[field] : '';
    return {
      field,
      changed: JSON.stringify(localValue) !== JSON.stringify(resultValue),
      local: localValue,
      incoming: incomingValue,
      result: resultValue,
    };
  });
  return {
    id: place.id,
    name: place.name,
    localName: local?.name ?? null,
    action,
    mode,
    changes,
    conflicts,
  };
}

/** Validate and prepare an import without filesystem writes or mutating either input state. */
export function prepareImport(current, input, { mode = 'skip', decisions } = {}) {
  if (!['skip', 'overwrite', 'merge'].includes(mode)) fail('导入模式必须是 skip、overwrite 或 merge');
  const decisionMap = parseDecisions(decisions);
  const bundle = validateBundle(input);
  assertStateShape(current);

  const rawById = new Map(bundle.state.places.map((p) => [p.id, p]));
  // Resolve relation targets against the final merged world, not the backup alone.
  const incoming = { places: bundle.state.places.map((p) => normalizePlace(p, bundle.state.terrain)) };
  if (incoming.places.some((p) => !p)) fail('导入地点数据无效');
  const referenced = new Set(incoming.places.map((p) => p.cover).filter(Boolean));
  const decoded = new Map();
  for (const filename of referenced) {
    if (!SAFE_FILENAME.test(filename) || filename.includes('..')) fail(`图片文件名不安全：${filename}`);
    if (!Object.hasOwn(bundle.covers, filename)) fail(`引用的图片缺失：${filename}`);
    decoded.set(filename, dataUrlBytes(bundle.covers[filename], filename));
  }

  const result = retainHomeId({ ...normalizeState(current), ...(Object.hasOwn(current, 'homeId') ? { homeId: current.homeId } : {}) });
  const byId = new Map(result.places.map((place, index) => [place.id, index]));
  const existingNames = new Map(result.places.map((place) => [place.name, place.id]));
  const accepted = [];
  const importImages = new Set();
  const ambiguousIds = new Set(incoming.places.filter((p) => byId.has(p.id) && result.places[byId.get(p.id)].name !== p.name).map((p) => p.id));
  const added = [];
  const updated = [];
  const skipped = [];
  const conflicts = [];
  const warnings = [];
  const items = [];
  for (const place of incoming.places) {
    const existingIndex = byId.get(place.id);
    const localBefore = existingIndex !== undefined ? result.places[existingIndex] : undefined;
    const raw = rawById.get(place.id) ?? place;
    // 逐项选择优先；没给这一项才落到整次的模式。
    const explicit = decisionMap?.get(place.id);
    const effectiveMode = explicit ?? mode;
    // 整次的 skip 只跳「已存在的同 id」，新地点照旧加进来（0.2.0 起的契约）；
    // 逐项点「跳过」才是这一处什么都不做。
    const skipThis = effectiveMode === 'skip' && (explicit !== undefined || existingIndex !== undefined);
    const conflictsBefore = conflicts.length;
    let action = 'skipped';
    let resultPlace = localBefore;
    if (skipThis) {
      skipped.push(place.id);
    } else if (existingIndex !== undefined && effectiveMode === 'merge') {
      const currentPlace = result.places[existingIndex];
      if (place.name !== currentPlace.name) {
        skipped.push(place.id);
        conflicts.push(`${place.name}（${place.id}）与本地同 id 地点「${currentPlace.name}」名称不同，已跳过；请先确认后再覆盖`);
      } else {
        const safePlace = { ...place, relations: place.relations.filter((r) => byId.has(r.placeId) && !ambiguousIds.has(r.placeId)) };
        if (safePlace.relations.length !== place.relations.length) warnings.push(`${place.name} 的部分关联目标缺失或身份冲突，未采纳这些关联`);
        const { merged, filled } = mergeLocalFirst(currentPlace, safePlace, raw, conflicts);
        if (filled.includes('cover')) importImages.add(place.id);
        accepted.push(merged);
        if (filled.length) {
          updated.push(place.id);
          action = 'updated';
        } else {
          skipped.push(place.id);
        }
        result.places[existingIndex] = merged;
        resultPlace = merged;
      }
    } else if (existingIndex === undefined && effectiveMode === 'merge') {
      skipped.push(place.id);
    } else {
      // overwrite：有就整条替换，没有就新增（逐项勾选新地点走的也是这条）。
      const nameOwner = existingNames.get(place.name);
      let blocked = false;
      if (nameOwner && nameOwner !== place.id) {
        skipped.push(place.id);
        conflicts.push(`${place.name}（${place.id}）与现有地点 ${nameOwner} 重名，已跳过`);
        blocked = true;
      }
      if (!blocked && existingIndex === undefined && result.places.length >= MAX_PLACES) {
        skipped.push(place.id);
        warnings.push(`${place.name}（${place.id}）因地点容量已满而跳过`);
        blocked = true;
      }
      if (!blocked) {
        accepted.push(place);
        if (place.cover) importImages.add(place.id);
        if (existingIndex !== undefined) {
          updated.push(place.id);
          action = 'updated';
          existingNames.delete(result.places[existingIndex].name);
          const localModifiedAt = result.places[existingIndex].modifiedAt;
          if (Number.isFinite(localModifiedAt) && localModifiedAt >= 0) place.modifiedAt = localModifiedAt;
          result.places[existingIndex] = place;
        } else {
          added.push(place.id);
          action = 'added';
          result.places.push(place);
        }
        byId.set(place.id, existingIndex === undefined ? result.places.length - 1 : existingIndex);
        existingNames.set(place.name, place.id);
        resultPlace = place;
      }
    }
    items.push(itemOf(place, localBefore, resultPlace, action, effectiveMode, conflicts.slice(conflictsBefore), raw));
  }

  const images = [];
  for (const place of accepted) {
    if (!importImages.has(place.id)) continue;
    const sourceName = place.cover;
    const entry = decoded.get(sourceName);
    if (!entry) fail(`引用的图片缺失：${sourceName}`);
    const digest = createHash('sha256').update(entry.bytes).digest('hex').slice(0, 12);
    const filename = `${place.id}.import-${digest}.${entry.image.ext}`;
    if (!SAFE_FILENAME.test(filename)) fail(`导入图片文件名不安全：${filename}`);
    place.cover = filename;
    images.push({ filename, bytes: Buffer.from(entry.bytes) });
  }

  const finalIds = new Set(result.places.map((place) => place.id));
  for (const place of result.places) {
    const relations = place.relations ?? [];
    place.relations = relations.filter((relation) => finalIds.has(relation.placeId));
    if (place.relations.length !== relations.length) warnings.push(`${place.name} 的部分关联地点未导入，已移除无效关联`);
  }
  const importedHome = bundle.state.homeId;
  const currentHome = current.homeId;
  result.homeId = mode === 'merge'
    ? (finalIds.has(currentHome) ? currentHome : '')
    : (finalIds.has(importedHome) ? importedHome : (finalIds.has(currentHome) ? currentHome : ''));

  return {
    state: result,
    images,
    summary: { added, updated, skipped, conflicts, warnings },
    items,
  };
}
