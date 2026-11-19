import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isSafeId, normalizeTags } from './places.js';

const VERSION = 1;
const MAX_VIEWS = 8;
const MAX_RECENT = 12;
const MAX_PINNED = 60;
const FILTERS = ['all', 'frequent', 'noDesc', 'noCover', 'hasCover', 'noRelation'];
const SORTS = ['kind', 'updated', 'viewed', 'name', 'frequent', 'cover', 'completeness'];
const VIEWS = ['cards', 'relations'];
const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('面板偏好格式无效');
const defaults = () => ({ version: VERSION, savedViews: [], recentViewed: [], recentEdited: [], pinned: [] });

function shortText(value, max, required = false) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw invalid();
  const clean = value.trim();
  if (Array.from(clean).length > max || (required && !clean)) throw invalid();
  return clean;
}

function normalizePrefs(value) {
  if (!isRecord(value) || value.version !== VERSION || !Array.isArray(value.savedViews)) throw invalid();
  if (value.savedViews.length > MAX_VIEWS) throw new Error(`最多保存 ${MAX_VIEWS} 个视图`);
  const seen = new Set();
  const savedViews = Array.from(value.savedViews, (item) => {
    if (!isRecord(item) || !isSafeId(item.id) || seen.has(item.id) || !FILTERS.includes(item.filter)
      || !SORTS.includes(item.sort) || !VIEWS.includes(item.view)) throw invalid();
    seen.add(item.id);
    const tagFilter = shortText(item.tagFilter, 24);
    if (tagFilter && normalizeTags([tagFilter])[0] !== tagFilter) throw invalid();
    return {
      id: item.id, name: shortText(item.name, 40, true), query: shortText(item.query, 160),
      filter: item.filter, tagFilter, view: item.view, sort: item.sort,
    };
  });
  const recent = (ids) => {
    if (!Array.isArray(ids) || ids.length > MAX_RECENT || !Array.from(ids).every(isSafeId)) throw invalid();
    return [...new Set(ids)];
  };
  const pinned = value.pinned === undefined ? [] : value.pinned;
  if (!Array.isArray(pinned) || pinned.length > MAX_PINNED || !pinned.every(isSafeId)) throw invalid();
  return {
    version: VERSION, savedViews, recentViewed: recent(value.recentViewed), recentEdited: recent(value.recentEdited),
    pinned: [...new Set(pinned)],
  };
}

export async function readPanelPrefs(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return defaults();
    throw err;
  }
  if (Number.isInteger(parsed?.version) && parsed.version > VERSION) throw new Error('当前版本无法读取此面板偏好文件');
  try { return normalizePrefs(parsed); } catch { return defaults(); }
}

export async function writePanelPrefs(file, value) {
  const prefs = normalizePrefs(value);
  // Do not replace preferences written in a newer format.
  await readPanelPrefs(file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(prefs), 'utf8');
  await rename(`${file}.tmp`, file);
  return prefs;
}
