import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { coverName, isSafeId } from './places.js';

const COVER_ENTRY = /^[\w.-]{1,160}$/;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const SAFE_ARCHIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 50;
const safeEntry = (name) => COVER_ENTRY.test(name) && name !== '.' && name !== '..' && !name.includes('..');
const keyOf = (filename) => process.platform === 'win32' || process.platform === 'darwin'
  ? filename.toLowerCase() : filename;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digestJson = (value) => sha256(Buffer.from(JSON.stringify(value)));

const MAGIC = [
  (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6)),
  (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
];
const isImageBytes = (bytes) => MAGIC.some((test) => test(bytes));

async function directoryStatus(dir, source, warn) {
  try {
    if ((await lstat(dir)).isDirectory()) return 'directory';
    warn(source, 'unsupported-directory');
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
    warn(source, 'unreadable');
  }
  return 'unknown';
}

/** Read-only inventory; archiveable is merely a candidate, never authority without a fresh revision check. */
export async function inspectCoverResources(mapDir, { current, saved, undo }) {
  const warnings = [];
  const references = new Map();
  const files = [];
  const snapshotHashes = {};
  const warn = (source, code) => {
    if (!warnings.some((warning) => warning.source === source && warning.code === code)) warnings.push({ source, code });
  };
  const collect = (snapshot, source) => {
    if (!Array.isArray(snapshot?.places)) return false;
    for (const place of snapshot.places) {
      if (place?.cover == null || place.cover === '') continue;
      const filename = coverName(place.cover);
      if (!safeEntry(filename) || filename !== place.cover) warn(source, 'unusual-reference');
      if (!safeEntry(filename)) continue;
      const key = keyOf(filename);
      const record = references.get(key) ?? { filename, references: [] };
      const placeId = isSafeId(place.id) ? place.id : '';
      if (!record.references.some((ref) => ref.source === source && ref.placeId === placeId)) {
        record.references.push({ source, placeId });
      }
      references.set(key, record);
    }
    return true;
  };
  const collectTree = (raw, source, seen = new Set()) => {
    if (!raw || typeof raw !== 'object' || seen.has(raw)) return false;
    seen.add(raw);
    let found = false;
    if (Array.isArray(raw.places)) {
      if (raw.version !== 1) warn(source, 'invalid-snapshot');
      found = collect(raw, source);
    }
    for (const key of ['before', 'state', 'bundle']) {
      if (raw[key] && typeof raw[key] === 'object') found = collectTree(raw[key], source, seen) || found;
    }
    return found;
  };
  const collectJson = (bytes, source, requireRecovery = false) => {
    let raw;
    try { raw = JSON.parse(bytes.toString('utf8')); } catch { warn(source, 'invalid-snapshot'); return; }
    if (requireRecovery) {
      if (Array.isArray(raw?.before?.places)) collect(raw.before, source);
      const valid = raw?.version === 1 && raw.before?.version === 1 && Array.isArray(raw.before.places)
        && typeof raw.after === 'string' && /^[a-f0-9]{64}$/.test(raw.after);
      if (!valid) warn(source, 'invalid-snapshot');
      return;
    }
    if (!collectTree(raw, source)) warn(source, 'invalid-snapshot');
  };
  const scanSnapshot = async (filename, source, recovery = false) => {
    const file = join(mapDir, filename);
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.size > MAX_SNAPSHOT_BYTES) {
        snapshotHashes[filename] = `unsupported:${entry.size}`;
        warn(source, 'unsupported-snapshot');
        return;
      }
      const bytes = await readFile(file);
      snapshotHashes[filename] = sha256(bytes);
      collectJson(bytes, source, recovery);
    } catch (err) {
      if (err.code === 'ENOENT') snapshotHashes[filename] = 'missing';
      else { snapshotHashes[filename] = `unreadable:${err.code ?? 'error'}`; warn(source, 'unreadable'); }
    }
  };

  snapshotHashes['<current>'] = digestJson(current ?? null);
  collect(current, 'current');
  if (saved != null) {
    snapshotHashes['<saved>'] = sha256(Buffer.from(saved));
    collectJson(Buffer.from(saved), 'saved');
  }
  if (undo != null) {
    snapshotHashes['<undo>'] = sha256(Buffer.from(undo));
    collectJson(Buffer.from(undo), 'undo');
  }

  const mapStatus = await directoryStatus(mapDir, 'storage', warn);
  let coversScanned = mapStatus === 'missing';
  if (mapStatus === 'directory') {
    let mapNames = [];
    try { mapNames = (await readdir(mapDir)).sort(); }
    catch { warn('storage', 'unreadable'); }
    const snapshots = [
      ['state.json', 'disk', false],
      ['state.json.bak', 'backup', false],
      ['import-recovery.json', 'recovery', true],
      ['state.json.tmp', 'staged-state', false],
      ['state.json.bak.tmp', 'staged-backup', false],
      ['import-recovery.json.tmp', 'staged-recovery', true],
    ];
    const known = new Set(snapshots.map(([name]) => name));
    for (const name of mapNames) {
      if (known.has(name) || !/(?:state|recovery|backup|\.bak(?:$|[.-])|\.corrupt(?:-|$))/i.test(name)) continue;
      snapshots.push([name, `snapshot:${name}`, /recovery/i.test(name)]);
    }
    for (const [filename, source, recovery] of snapshots) await scanSnapshot(filename, source, recovery);

    const coversDir = join(mapDir, 'covers');
    const coversStatus = await directoryStatus(coversDir, 'covers', warn);
    coversScanned = coversStatus === 'missing';
    if (coversStatus === 'directory') {
      try {
        const names = await readdir(coversDir);
        for (const name of names.sort((a, b) => a.localeCompare(b))) {
          if (!safeEntry(name)) continue;
          const refs = references.get(keyOf(name))?.references ?? [];
          if (!refs.length && !IMAGE_EXTENSION.test(name)) continue;
          try {
            const metadata = await lstat(join(coversDir, name));
            if (!metadata.isFile()) { warn('covers', 'skipped-entry'); continue; }
            if (metadata.size > MAX_COVER_BYTES) {
              files.push({ filename: name, bytes: metadata.size, sha256: '', image: false, archiveable: false, references: refs });
              warn('covers', 'unsupported-image');
              continue;
            }
            const bytes = await readFile(join(coversDir, name));
            const image = isImageBytes(bytes);
            const archiveable = image && IMAGE_EXTENSION.test(name) && refs.length === 0;
            if (!image && IMAGE_EXTENSION.test(name)) warn('covers', 'invalid-image');
            files.push({ filename: name, bytes: metadata.size, sha256: sha256(bytes), image, archiveable, references: refs });
          } catch { warn('covers', 'unreadable'); }
        }
        coversScanned = true;
      } catch (err) {
        if (err.code === 'ENOENT') coversScanned = true;
        else warn('covers', 'unreadable');
      }
    }
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename));
  const found = new Set(files.map(({ filename }) => keyOf(filename)));
  const missing = coversScanned ? [...references]
    .filter(([key]) => !found.has(key))
    .map(([, record]) => record)
    .sort((a, b) => a.filename.localeCompare(b.filename)) : [];
  const snapshotRevision = digestJson(snapshotHashes);
  const revision = digestJson({
    snapshotRevision,
    files: files.map(({ filename, bytes, sha256: digest, image, archiveable, references: refs }) => ({ filename, bytes, sha256: digest, image, archiveable, references: refs })),
    missing,
    warnings,
  });
  return { ok: true, revision, snapshotRevision, files, missing, warnings };
}

function validateArchiveId(id) {
  return typeof id === 'string' && SAFE_ARCHIVE_ID.test(id);
}

async function readArchive(mapDir, id) {
  if (!validateArchiveId(id)) throw new Error('封面归档编号无效');
  const root = join(mapDir, 'cover-archive');
  const archiveDir = join(root, id);
  const rootStat = await lstat(root);
  const archiveStat = await lstat(archiveDir);
  if (!rootStat.isDirectory() || !archiveStat.isDirectory()) throw new Error('找不到这份封面归档');
  const manifestPath = join(archiveDir, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > 1024 * 1024) throw new Error('封面归档清单无效');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new Error('封面归档清单无法读取'); }
  if (manifest?.version !== 1 || manifest.id !== id || !['moving', 'partial', 'archived', 'restored'].includes(manifest.status)
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_ARCHIVE_FILES) {
    throw new Error('封面归档清单格式无效');
  }
  const seen = new Set();
  for (const item of manifest.files) {
    if (!item || !safeEntry(item.filename) || !IMAGE_EXTENSION.test(item.filename) || seen.has(keyOf(item.filename))
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_COVER_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error('封面归档文件清单无效');
    }
    seen.add(keyOf(item.filename));
  }
  return { archiveDir, manifestPath, manifest };
}

async function saveManifest(path, manifest) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  await rename(temporary, path);
}

/** Atomically move selected, hash-verified unreferenced images into a recoverable archive. */
export async function archiveCoverResources(mapDir, context, { filenames, expectedRevision, now = Date.now() }) {
  if (!Array.isArray(filenames) || filenames.length < 1 || filenames.length > MAX_ARCHIVE_FILES
    || filenames.some((name) => !safeEntry(name)) || new Set(filenames.map(keyOf)).size !== filenames.length) {
    throw new Error(`请选择 1 至 ${MAX_ARCHIVE_FILES} 个有效且不重复的文件名`);
  }
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new Error('请先重新盘点封面');
  const inspection = await inspectCoverResources(mapDir, context);
  if (inspection.revision !== expectedRevision) throw new Error('封面资源或引用已变化，请重新盘点');
  if (inspection.warnings.length || inspection.missing.length) throw new Error('存在无法确认的状态或图片引用；为避免误动文件，本次不执行归档');
  const selected = filenames.map((filename) => {
    const found = inspection.files.find((file) => keyOf(file.filename) === keyOf(filename));
    if (!found || !found.archiveable || found.references.length) throw new Error(`「${filename}」没有通过无引用图片校验，未执行归档`);
    return { filename: found.filename, bytes: found.bytes, sha256: found.sha256 };
  });
  const coversDir = join(mapDir, 'covers');
  if ((await directoryStatus(coversDir, 'covers', () => {})) !== 'directory') throw new Error('封面目录状态异常，未执行归档');
  const archiveRoot = join(mapDir, 'cover-archive');
  try { await mkdir(archiveRoot); }
  catch (err) { if (err.code !== 'EEXIST') throw err; }
  if (!(await lstat(archiveRoot)).isDirectory()) throw new Error('归档目录不是普通目录');
  const id = randomUUID();
  const archiveDir = join(archiveRoot, id);
  await mkdir(archiveDir);
  const manifestPath = join(archiveDir, 'manifest.json');
  const archiveTime = Number.isFinite(now) && now >= 0 ? now : Date.now();
  const manifest = { version: 1, id, createdAt: new Date(archiveTime).toISOString(), status: 'moving', files: selected };
  const moved = [];
  try {
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    for (const item of selected) {
      const source = join(coversDir, item.filename);
      const destination = join(archiveDir, item.filename);
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile()) throw new Error(`「${item.filename}」不再是普通图片文件`);
      const before = await readFile(source);
      if (before.length !== item.bytes || sha256(before) !== item.sha256 || !isImageBytes(before)) throw new Error(`「${item.filename}」在归档前已变化`);
      await rename(source, destination);
      moved.push(item);
      const destinationStat = await lstat(destination);
      const after = await readFile(destination);
      if (!destinationStat.isFile() || after.length !== item.bytes || sha256(after) !== item.sha256) throw new Error(`「${item.filename}」归档后校验失败`);
    }
    const afterMove = await inspectCoverResources(mapDir, context);
    const movedKeys = new Set(selected.map(({ filename }) => keyOf(filename)));
    const nowReferenced = afterMove.missing.filter(({ filename }) => movedKeys.has(keyOf(filename)));
    const presentWithReferences = afterMove.files.filter((file) => movedKeys.has(keyOf(file.filename)) && file.references.length);
    if (afterMove.warnings.length || nowReferenced.length || presentWithReferences.length
      || afterMove.snapshotRevision !== inspection.snapshotRevision) throw new Error('归档期间检测到引用或状态变化，已尝试恢复原位置');
    manifest.status = 'archived';
    await saveManifest(manifestPath, manifest);
    return {
      ok: true,
      archive: { id, createdAt: manifest.createdAt, files: selected.map((item) => ({ ...item })), path: `map/cover-archive/${id}` },
      revision: afterMove.revision,
    };
  } catch (err) {
    const rollbackErrors = [];
    for (const item of [...moved].reverse()) {
      try {
        const source = join(coversDir, item.filename);
        const archived = join(archiveDir, item.filename);
        try { await lstat(source); throw new Error(`原位置「${item.filename}」已被占用`); }
        catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        await rename(archived, source);
      } catch (rollbackError) { rollbackErrors.push(`${item.filename}: ${rollbackError.message}`); }
    }
    manifest.status = rollbackErrors.length ? 'partial' : 'restored';
    try { await saveManifest(manifestPath, manifest); } catch { /* keep recovery evidence */ }
    const suffix = rollbackErrors.length ? `；部分文件仍在可恢复归档中：${rollbackErrors.join('；')}` : '；原文件已恢复';
    throw new Error(`${err.message}${suffix}`);
  }
}

async function restoreExclusive(source, destination, item) {
  const temporary = `${destination}.${randomUUID()}.restore.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const bytes = await readFile(temporary);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256 || !isImageBytes(bytes)) {
      throw new Error(`归档中的「${item.filename}」校验失败`);
    }
    await link(temporary, destination);
    await unlink(temporary);
  } catch (err) {
    try { await unlink(temporary); } catch { /* keep recovery copy in archive */ }
    throw err;
  }
}

/** Restore an archive without overwriting any file currently present in covers. */
export async function restoreCoverResources(mapDir, id) {
  const { archiveDir, manifestPath, manifest } = await readArchive(mapDir, id);
  const coversDir = join(mapDir, 'covers');
  try { await mkdir(coversDir, { recursive: true }); }
  catch { throw new Error('封面目录无法创建'); }
  if (!(await lstat(coversDir)).isDirectory()) throw new Error('封面目录不是普通目录');
  const plan = [];
  for (const item of manifest.files) {
    const archived = join(archiveDir, item.filename);
    const destination = join(coversDir, item.filename);
    let archivedBytes = null;
    try {
      const statArchived = await lstat(archived);
      if (!statArchived.isFile() || statArchived.size !== item.bytes) throw new Error(`归档中的「${item.filename}」不匹配清单`);
      archivedBytes = await readFile(archived);
      if (sha256(archivedBytes) !== item.sha256 || !isImageBytes(archivedBytes)) throw new Error(`归档中的「${item.filename}」校验失败`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    let destinationExists = false;
    try {
      const st = await lstat(destination);
      if (!st.isFile()) throw new Error(`目标「${item.filename}」已被占用`);
      const bytes = await readFile(destination);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256 || !isImageBytes(bytes)) throw new Error(`不会覆盖不同内容的「${item.filename}」`);
      destinationExists = true;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!archivedBytes && !destinationExists) throw new Error(`归档和原位置都缺少「${item.filename}」`);
    plan.push({ ...item, archived, destination, destinationExists });
  }
  const restored = [];
  try {
    for (const item of plan) {
      if (item.destinationExists) continue;
      await restoreExclusive(item.archived, item.destination, item);
      restored.push(item);
    }
    manifest.status = 'restored';
    await saveManifest(manifestPath, manifest);
    return {
      ok: true, archiveId: id,
      restored: restored.map(({ filename }) => filename),
      alreadyPresent: plan.filter((item) => item.destinationExists).map(({ filename }) => filename),
    };
  } catch (err) {
    manifest.status = restored.length ? 'partial' : 'archived';
    try { await saveManifest(manifestPath, manifest); } catch { /* retain recovery evidence */ }
    const suffix = restored.length ? `；已恢复的 ${restored.map(({ filename }) => filename).join('、')} 保持原样，归档副本仍保留` : '';
    throw new Error(`${err.message}${suffix}`);
  }
}

/** Return only validated archive manifests; corrupt entries are reported, never removed. */
export async function listCoverArchives(mapDir) {
  const root = join(mapDir, 'cover-archive');
  const warnings = [];
  const archives = [];
  let names;
  try {
    if (!(await lstat(root)).isDirectory()) return { ok: true, archives, warnings: [{ code: 'unsupported-directory' }] };
    names = await readdir(root);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, archives, warnings };
    return { ok: true, archives, warnings: [{ code: 'unreadable' }] };
  }
  for (const id of names.sort()) {
    if (!validateArchiveId(id)) { warnings.push({ id, code: 'skipped-entry' }); continue; }
    try {
      const { manifest } = await readArchive(mapDir, id);
      archives.push({
        id, createdAt: manifest.createdAt ?? '', status: manifest.status,
        files: manifest.files.map(({ filename, bytes }) => ({ filename, bytes })),
      });
    } catch { warnings.push({ id, code: 'invalid-archive' }); }
  }
  return { ok: true, archives, warnings };
}
