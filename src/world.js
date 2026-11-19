/**
 * 小地图 World。
 *
 * 这条鱼周围的**地方**：家在哪、常去哪儿、附近有什么。每一处只有文字描写
 * （空间、陈设、配色、光线、氛围）和一句画风锚点；画面靠主人自己上传一张本地图，
 * **装了生图工作室也只是「可以」联动出图，不装照样完整可用**。
 *
 * 六个工具（`MAP-小地图插件-方案.md` §6）：
 *   - `map_places` 列出地点（家 / 常去 / 周围，`frequent` 排前）；
 *   - `map_look`   看某一处：文字描写 + style + 有没有图 +（装了生图且 scene 非空才）发图填哪个 scene；
 *   - `map_add`    主人加一处：只填文字，不填坐标；
 *   - `map_edit`   改文字 / 置顶「常去」/ 改 style；
 *   - `map_cover`  换本地图或清空（清空才允许下次重画）；
 *   - `map_view`   整张小地图（分组铺开，纯展示）。
 *
 * **绝不带路线、坐标、距离、导航**：不画「从家到公司怎么走」，place 里也没有任何
 * geo 字段。日程里写去哪是「鱼的每一天」自己的事，小地图只提供「这个地点长什么样」。
 *
 * **不推任何事件**（`describe.events` 是空数组、`start()` 里没有定时器）：她什么时候
 * 看地图，由「鱼的每一天」的 `maplink` 那一行顺手一提，或者她自己调 `map_places`。
 *
 * 红线（World 契约）：不调别的 World 的工具、不读别人的状态或日程文件；
 * 只读 `config.json` 的一个布尔字段（`worlds.imggen.enabled`，和 funlink 读
 * `worlds.fun.enabled` 同一套）；`envPromptVars()` 永不抛错；`create()` 保持纯。
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildExport, prepareImport } from './transfer.js';
import {
  archiveCoverResources, inspectCoverResources, listCoverArchives, restoreCoverResources,
} from './cover-resources.js';
import { readPanelPrefs, writePanelPrefs } from './panel-prefs.js';
import { fileURLToPath } from 'node:url';

import { DEFAULTS, ID, configGroup, panelText, text } from './config.js';
import {
  KIND_LABEL, MAX_TAGS, TERRAINS, findTerrain, findPlace, hasFunVenue, hasScene, normalizePlace, normalizeTags, terrainPlaces,
} from './places.js';
import {
  MAX_ALIASES, addPlace, applyTerrain, applyTerrainSelection, editPlace, kindLabelOf, listPlaces,
  newState, normalizeKind, normalizeState, placeById, placeView, removePlace, resolvePlace, resolvePlaceCandidates,
  setCover, setCoverFocus, summaryOf,
} from './state.js';

const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const msg = (err) => (err instanceof Error ? err.message : String(err));
const revisionOf = (value) => createHash('sha256').update(JSON.stringify(value, (key, item) => (
  key === 'modifiedAt' && item === 0 ? undefined : item
))).digest('hex');

const DRAFT_LIMITS = { name: 40, desc: 400, style: 160, aliases: 300, kind: 20, scene: 40, funVenue: 40, tags: 240, relationsJson: 1600 };
const cleanDraftFields = (input) => Object.fromEntries(Object.entries(DRAFT_LIMITS)
  .filter(([key]) => typeof input?.[key] === 'string')
  .map(([key, limit]) => [key, input[key].slice(0, limit)]));

function normalizeDrafts(drafts) {
  if (!Array.isArray(drafts) || drafts.length > 61) throw new Error('草稿数量无效');
  const clean = new Map();
  for (const entry of drafts) {
    if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(entry.id) || entry.id.includes('..')) continue;
    const fields = cleanDraftFields(entry.fields);
    if (!Object.keys(fields).length) continue;
    const base = entry.base;
    const validBase = base && typeof base.revision === 'string' && /^[a-f0-9]{64}$/.test(base.revision)
      && base.fields && typeof base.fields === 'object' && !Array.isArray(base.fields);
    clean.set(entry.id, { fields, ...(validBase ? { base: { revision: base.revision, fields: cleanDraftFields(base.fields) } } : {}) });
  }
  return clean;
}

const draftEntries = (drafts) => [...drafts].map(([id, entry]) => ({ id, ...entry }));

/**
 * 删除后能撤销的时限（毫秒）。
 *
 * 只在内存里留一次：面板显示倒计时、服务端拒绝过期 token，两边用这一个数。
 * 进程重启就没了，这是刻意的——撤销是「手滑之后那一下」，不是回收站。
 */
const UNDO_TTL_MS = 10_000;

/** 本地图的最大字节数（方案 §4：≤ 8 MiB）。 */
export const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** 只认这四种，按**文件头魔数**判，不看扩展名。 */
const MAGIC = [
  { mime: 'image/png', ext: 'png', match: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { mime: 'image/jpeg', ext: 'jpg', match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', match: (b) => b.length >= 6 && /^GIF8[79]a/.test(b.toString('latin1', 0, 6)) },
  { mime: 'image/webp', ext: 'webp', match: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
];

/**
 * 按文件头认出图片类型。认不出返回 null——**绝不靠扩展名信**。
 * 这是不变量：主人从别处拖进来的 `.png` 可能是别的东西。
 */
export function sniffImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  return MAGIC.find((m) => m.match(bytes)) ?? null;
}

/**
 * 解 data URL（`data:image/png;base64,....`）成 Buffer + mime。
 * 坏数据返回 `{ error }`，不抛错。
 */
export function decodeDataUrl(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) return { error: '这不是一张 data URL 图片' };
  const b64 = m[2].replace(/\s+/g, '');
  if (b64.length > Math.ceil(MAX_COVER_BYTES / 3) * 4) return { error: `图片超过 ${MAX_COVER_BYTES / 1024 / 1024} MiB` };
  let bytes;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch {
    return { error: 'base64 数据解不开' };
  }
  if (!bytes.length) return { error: 'base64 是空的' };
  if (bytes.length > MAX_COVER_BYTES) return { error: `图片超过 ${MAX_COVER_BYTES / 1024 / 1024} MiB` };
  const sniff = sniffImage(bytes);
  if (!sniff) return { error: '只认 png / jpg / webp / gif（按文件头认，不看扩展名）' };
  return { bytes, mime: sniff.mime, ext: sniff.ext };
}

/**
 * 找 Coo 的主 config.json。
 *
 * **两个位置都得试**，因为不同版本/不同部署不一样：
 *   1. `<dataDir>/config.json`      —— 真机（2026-11-15 实测 `E:\Coopanion\data\home\companion\config.json`）；
 *   2. `<dataDir>/../config.json`   —— `feed-world/src/life/funlink.js` 与 `wardrobe.js` 假设的布局
 *      （它们的注释写的数据目录是 `…/home/companion`，config 在上一层）。
 *
 * 只按后者查，在真机上会永远读到「没有 config」→ 三个联动全部静默不出现，
 * 而且**没有任何报错**（静默降级本身是对的，但这里是降级到了错的地方）。
 *
 * 返回按优先级排好的候选路径；调用方逐个试。
 */
export function configCandidates(dataDir) {
  const base = typeof dataDir === 'string' && dataDir.trim() ? dataDir.trim() : process.cwd();
  return [join(base, 'config.json'), join(base, '..', 'config.json')];
}

/**
 * 读 Coo config 里某个 World 的 `enabled`——**只这一个布尔字段**。
 *
 * 和 `feed-world/src/life/funlink.js` 的 `readFunEnabled` 同一套：
 * 读配置文件不算 World 间依赖，不调对方的工具、不读对方的状态或素材库。
 *
 * `config.json` 是 Coo **整份重写**的，存在「读到写了一半的文件」的窗口：
 * 解析失败时等 200ms 重试一次再降级，否则用户改配置那一瞬间会误判成「没装」。
 *
 * @param {string} dataDir 数据目录
 * @param {string} worldId 段名：`imggen` / `feast` / `fun`
 * @returns {Promise<boolean>} 装并且启用了才 true；其余一律 false（静默降级）。
 */
export async function readWorldEnabled(dataDir, worldId) {
  const key = typeof worldId === 'string' ? worldId.trim() : '';
  if (!key) return false;
  const tryOnce = async () => {
    for (const cfgPath of configCandidates(dataDir)) {
      try {
        const raw = JSON.parse(await readFile(cfgPath, 'utf8'));
        // 读到了文件就按它判（哪怕没有这个段 —— 那是「没装」而不是「读不到」）。
        return raw?.worlds?.[key]?.enabled === true;
      } catch {
        // 这个路径读不到/坏了，试下一个
      }
    }
    return null; // 两个路径都不行 → 区分「读不到/解析失败」和「读到了但没启用」
  };
  const first = await tryOnce();
  if (first !== null) return first;
  await new Promise((r) => setTimeout(r, 200));
  const second = await tryOnce();
  return second === true;
}

/** 读 `worlds.imggen.enabled`（保留具名导出，测试和文档里一直用它）。 */
export function readImggenEnabled(dataDir) {
  return readWorldEnabled(dataDir, 'imggen');
}

/** 三档 kind 的展示顺序。 */
const KIND_ORDER = ['home', 'frequent', 'around', 'travel'];

/** 常驻只保留当前住所与五处常去地点索引；所有详情按需查询。 */
const ENV_FREQUENT_MAX = 5;
const LIST_PAGE_SIZE = 10;
const LIST_PAGE_MAX = 20;

/**
 * `map_view` 完整概览回执里每处带几个字的描写。
 *
 * 概览仅给短描写，完整描写由 `map_look` 现给；`map_places` 只返回索引。
 */
const LIST_DESC_CHARS = 60;

/** 把一段描写截到 `max` 字，超了加省略号。 */
function briefDesc(desc, max) {
  const s = typeof desc === 'string' ? desc : '';
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 工具声明（不含 handler）；describe 与 tools() 共用。 */
export const MAP_TOOL_DECLS = [
  {
    name: 'map_places',
    tags: ['read', 'snapshot'],
    description: '分页查询地点索引：名称、id、分类、常去及有图状态。按常去优先排序，详情用 map_look。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: '分类筛选：家 / 常去的 / 周围 / 旅行，或 home / frequent / around / travel；不填则不限分类。',
        },
        all: { type: 'boolean', description: 'true 返回筛选后的全部索引，忽略分页；默认分页。' },
        page: { type: 'integer', minimum: 1, description: '页码，从 1 开始，默认 1。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '每页条数，默认 10，最多 20。' },
        tag: { type: 'string', description: '只列包含这个标签的地点。' },
        relatedTo: { type: 'string', description: '只列与这个地点有主人登记关联的地点 id。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'map_look',
    tags: ['read', 'snapshot'],
    description: '查询地点完整描写、有效画风、标签、关联和图片状态；具体描述或发图前使用。空白内容不得编造。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '哪一处，填正名（家 / 溪边 / 老橡树…），别名也认。' },
      },
      required: ['place'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_add',
    tags: ['write'],
    description: '按主人要求新增文字地点；不登记坐标、路线或距离。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '这处叫什么，例如「溪边」「楼下长椅」。' },
        aliases: { type: 'array', items: { type: 'string' }, description: '别名，最多 8 个，例如「小溪」「溪水」。' },
        kind: { type: 'string', description: '家 / 常去的 / 周围 / 旅行。不填算「周围」。' },
        desc: { type: 'string', description: '一句话文字描写：只写空间、陈设、配色、光线、氛围——不写姿势表情、不写她在干什么、不写「从这里走十分钟到哪」。' },
        style: { type: 'string', description: '一句画风锚点，以后每次出图都带上，越稳定越好。' },
        scene: { type: 'string', description: '生图素材库里的场景正名，**主人知道库里有什么才填**；拿不准就别填，留空不影响任何事。' },
        funVenue: { type: 'string', description: '娱乐时间里**最接近这处**的那个场所正名（例如「江边」「爬山」）；填了才可能提「想真去逛去哪」，拿不准就别填。' },
        frequent: { type: 'boolean', description: '是不是常去（置顶）。' },
        tags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 24 }, description: '主人自定义标签，最多 8 个。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_edit',
    tags: ['write'],
    description: '按主人要求修改地点，仅更新传入字段；数组整套替换。换图用 map_cover。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '改哪一处，填正名或 id。' },
        name: { type: 'string', description: '改成这个正名。' },
        aliases: { type: 'array', items: { type: 'string' }, description: '整套别名（不是追加）。' },
        kind: { type: 'string', description: '家 / 常去的 / 周围 / 旅行。' },
        desc: { type: 'string', description: '换成这段文字描写。' },
        style: { type: 'string', description: '换成这句画风锚点。' },
        scene: { type: 'string', description: '换成这个 scene 正名；传空串就是清掉（以后不再提发图填什么）。' },
        funVenue: { type: 'string', description: '换成娱乐时间里最接近这处的那一处正名；传空串就是清掉（以后不再提去那儿逛）。' },
        frequent: { type: 'boolean', description: '标成 / 取消「常去」。' },
        tags: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 24 }, description: '整套替换主人自定义标签；空数组清空。' },
        relations: {
          type: 'array', maxItems: 8,
          description: '主人明确要求时登记地点关联；整套替换，空数组清空。只写两处的语境说明，不写方向、远近或走法，不能自行推断长期事实。',
          items: { type: 'object', properties: {
            placeId: { type: 'string', description: '已存在的目标地点 id，用 map_places 确认，不填名字。' },
            note: { type: 'string', maxLength: 80, description: '关联说明，例如“窗边能看见溪面”；不含方位、距离或路径。' },
          }, required: ['placeId', 'note'], additionalProperties: false },
        },
      },
      required: ['place'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_cover',
    tags: ['write'],
    description: '查询封面，或按主人明确要求挂载已上传的本地图片、清空封面；不生成图片，不自动改图。',
    parameters: {
      type: 'object',
      properties: {
        place: { type: 'string', description: '哪一处，填正名或 id。' },
        file: { type: 'string', description: '要挂的图片文件名（主人已经放进这处目录的那张）。不填就看现在挂着什么。' },
        clear: { type: 'boolean', description: '填 true 就清空这处的图。' },
      },
      required: ['place'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_view',
    tags: ['read', 'snapshot'],
    description: '整张小地图：按「家 / 常去的 / 周围 / 旅行」分组把每一处铺开，带文字描写和有没有图。纯展示——**没有连线、没有路线、没有远近、也没有行程**。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

export class MapWorld {
  #host = null;
  #state = null;
  #started = false;
  #storageWarning = '';
  #drafts = new Map();
  #writeBlocked = false;
  #lastSaved = null;
  #queue = Promise.resolve();
  /**
   * 刚刚删掉的那一处，等待撤销（`{ token, before, after, expiresAt, name }`）。
   *
   * `before` 是删除前的整份 state 快照：撤销时整份换回去，
   * 连带把「别处指向它的关系」和「它是不是当前住所」一起还原——
   * 只塞回一条地点会留下指向空气的关系，那比不撤销更糟。
   * 只有 `revisionOf(#state) === after`（这期间没人动过）才允许换回。
   */
  #undo = null;
  #now;
  #persist = null;
  #rawCfg = null;
  /**
   * 三个「别的 World 装没装」的快照。
   *
   * 为什么要有快照：`envPromptVars()` 和 `webUi()` 是**同步**的，没法在里面 await
   * 读 config。所以照 fun 的 `#funInstalled` 同一套——在 `start()`、每次工具调用、
   * 面板取数时刷新，同步方法只读快照。
   */
  #installed = { imggen: false, feast: false, fun: false };
  #installedAt = 0;

  constructor(opts = {}) {
    this.id = ID;
    this.#rawCfg = opts.cfg ?? {};
    this.cfg = { ...DEFAULTS, ...this.#rawCfg };
    this.dataDir = opts.dataDir ?? process.cwd();
    this.language = 'zh';
    this.timezone = opts.timezone || 'Asia/Shanghai';
    this.#now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.#persist = typeof opts.persist === 'function' ? opts.persist : null;
  }

  // -------------------------------------------------------------------------
  // 配置（热改：每次用时现读）
  // -------------------------------------------------------------------------

  #on() {
    const v = this.cfg?.mapOn;
    return v === undefined || v === null ? Boolean(DEFAULTS.mapOn) : Boolean(v);
  }

  #imggenWanted() {
    const v = this.cfg?.mapImggenOn;
    return v === undefined || v === null ? Boolean(DEFAULTS.mapImggenOn) : Boolean(v);
  }

  #feastWanted() {
    const v = this.cfg?.mapFeastOn;
    return v === undefined || v === null ? Boolean(DEFAULTS.mapFeastOn) : Boolean(v);
  }

  #funWanted() {
    const v = this.cfg?.mapFunOn;
    return v === undefined || v === null ? Boolean(DEFAULTS.mapFunOn) : Boolean(v);
  }

  /**
   * 把 `worlds.map` 段里缺的键补成默认值（启动时做一次）。
   *
   * 宿主的 `/api/config` 拿落盘的段**直接**渲染，不合并 defaults：
   *   boolean 缺 → 界面显示 false，而 World 自己按 true 在跑。
   * 只补缺的键，不覆盖用户已有的值；`enabled` 归宿主；没有 persist 就跳过；绝不抛错。
   */
  #ensureConfigSection() {
    if (!this.#persist) return;
    try {
      const raw = this.#rawCfg ?? {};
      const patch = {};
      for (const [key, value] of Object.entries(DEFAULTS)) {
        if (key === 'enabled') continue;
        if (key in raw) continue;
        patch[key] = value;
      }
      if (!Object.keys(patch).length) return;
      this.#persist(patch);
      Object.assign(this.cfg, patch);
      Object.assign(raw, patch);
      this.#host?.log?.info?.('小地图：配置段补齐了缺失的键', { keys: Object.keys(patch) });
    } catch (err) {
      this.#host?.log?.warn?.('小地图：配置段没补齐（界面可能显示和实际不一致）', { err: msg(err) });
    }
  }

  stateFile() {
    return join(this.dataDir, 'map', 'state.json');
  }

  coversDir() {
    return join(this.dataDir, 'map', 'covers');
  }

  /** 最近一次成功导入前的快照（只给面板「恢复上次导入前」用）。 */
  recoveryFile() {
    return join(this.dataDir, 'map', 'import-recovery.json');
  }

  // -------------------------------------------------------------------------
  // 别的 World 装没装：只读 config 的布尔字段
  // -------------------------------------------------------------------------

  /**
   * 刷新三个「装没装」快照：`worlds.imggen.enabled` / `.feast.enabled` / `.fun.enabled`。
   *
   * 调用点：`start()`、每次工具调用之前（工具都是 async，顺手读一次）、面板取数。
   * 带 60 秒 TTL，免得面板一分钟刷一次就真去读一遍 config。
   * **永不抛错**：读不到就是 false，静默降级。
   *
   * 三个一起刷是因为它们共用同一份 config.json——读一次文件就够了，
   * 各自开一个 200ms 重试反而会在 Coo 重写配置时叠三次等待。
   */
  async #refreshInstalled(force = false) {
    const now = Date.now();
    if (!force && this.#installedAt && now - this.#installedAt < 60000) return this.#installed;
    const read = async (id) => {
      try {
        return await readWorldEnabled(this.dataDir, id);
      } catch {
        return false;
      }
    };
    try {
      const [imggen, feast, fun] = await Promise.all([read('imggen'), read('feast'), read('fun')]);
      this.#installed = { imggen, feast, fun };
    } catch {
      this.#installed = { imggen: false, feast: false, fun: false };
    }
    this.#installedAt = now;
    return this.#installed;
  }

  /** 生图工作室装没装（快照）。 */
  get imggenInstalled() {
    return this.#installed.imggen === true;
  }

  /** 「鱼的每一天」装没装（快照）。 */
  get feastInstalled() {
    return this.#installed.feast === true;
  }

  /** 「娱乐时间」装没装（快照）。 */
  get funInstalled() {
    return this.#installed.fun === true;
  }

  /**
   * 这处地方能不能提「发图时 scene 填什么」。
   *
   * **三条全满足才 true**（方案 §4）：
   *   ① 配置 `mapImggenOn` 开着；
   *   ② 读到 `worlds.imggen.enabled === true`；
   *   ③ 这处 `scene` 非空（主人真把库里的正名填进来了）。
   * 缺一条整段不出现——绝不指向不存在的工具或场景名。
   */
  canMentionImggen(place) {
    return this.#imggenWanted() && this.imggenInstalled && hasScene(place);
  }

  /**
   * 能不能提「写日程/说此刻在哪用这些正名」（指向 `feast_life_plan` / `feast_life_now`）。
   *
   * 同样三条：开关 `mapFeastOn` + `worlds.feast.enabled === true` + 有地点。
   * 和 `canMentionImggen` 完全同构——没装就一个字都不提，绝不指向不存在的工具。
   */
  canMentionFeast() {
    try {
      if (!this.#feastWanted() || !this.feastInstalled) return false;
      return listPlaces(this.#state ?? newState()).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * 这处地方能不能提「想真去逛就 `fun_go` 填哪一处」。
   *
   * 三条：开关 `mapFunOn` + `worlds.fun.enabled === true` + 这处 `funVenue` 非空。
   *
   * **只在旅游那类地点上真正用得到**：远方地名（「海边小镇」）在娱乐时间里不存在，
   * 所以预置的是「最接近的那一处」（江边），回执会明说是**最接近的一处**，
   * 不假装是同一个地方——那正是这条红线要挡的「指向不存在的地名」。
   */
  canMentionFun(place) {
    return this.#funWanted() && this.funInstalled && hasFunVenue(place);
  }

  // -------------------------------------------------------------------------
  // 提示词
  // -------------------------------------------------------------------------

  /**
   * 只放**一天变不了几次**的东西：地点正名与别名，以及几个可选块。
   *
   * 每处都带细节会顶掉常驻前缀，所以这里只列名字 + 一句短描写，细节留给 `map_look`。
   *
   * **占位符按「哪个联动」分开给**，这样每一块都能整段消失：
   *   - `map_places_block`：地点清单（`mapOn` 关掉 → 空串）；
   *   - `map_imggen_block`：发图那句（`mapImggenOn` + `worlds.imggen.enabled` + 有 scene → 否则空串）；
   *   - `map_feast_block`：写日程用正名那句（`mapFeastOn` + `worlds.feast.enabled` + 有地点 → 否则空串）。
   *
   * **`map_imggen_block` 里提到 `feast_life_now` 的那半句也是条件的**：生图装了但
   * 鱼的每一天没装时，只能说「outfits 按你当时穿的说」，不能说「查 feast_life_now」——
   * 那正是「指向不存在的工具」。
   *
   * **这个方法绝不能抛错**：契约里抛错会把整个 World 卸载掉。
   */
  envPromptVars() {
    const empty = { map_places_block: '', map_imggen_block: '', map_feast_block: '' };
    try {
      const st = this.#state ?? newState();
      const places = listPlaces(st);
      if (!this.#on() || !places.length) return empty;

      const home = placeById(st, st.homeId);
      const currentHome = home?.kind === 'home' ? home : null;
      const shown = places.filter((p) => p.id !== currentHome?.id && (p.frequent || p.kind === 'frequent')).slice(0, ENV_FREQUENT_MAX);
      const lines = [`地点共 ${places.length} 处。`];
      if (currentHome) lines.push(`当前住所：${currentHome.name}（id=${currentHome.id}）。家、家里、回家指这一处；明确指定其他地点时按指定查询。`);
      if (shown.length) lines.push('常去地点索引：');
      for (const p of shown) lines.push(`- ${p.name}（id=${p.id}）`);
      lines.push('其余地点用 map_places 分页查询；描写、画风、标签和关联用 map_look 查询，索引未列出不代表不存在。');

      const imggen = this.canMentionAnyImggen()
        ? [
          '## 想发图的时候',
          '',
          '发图前先用 map_look 查询地点；仅当回执提供 scene 时才用于 imggen_draw，不编造场景正名。',
          this.canMentionFeast()
            ? '`outfits` 填 `feast_life_now` 里那身，别自己编衣服。'
            : '`outfits` 按你这会儿真穿的那身填，别自己编衣服名字。',
          '登记的场景名未经本插件核实；画风按 map_look 回执填写。',
        ].join('\n')
        : '';

      // 「写日程用正名」这句：只在鱼的每一天装了、并且真有地点时才出现。
      const feast = this.canMentionFeast()
        ? [
          '## 写日程、说此刻在哪的时候',
          '',
          '地点用登记的**正名**；索引未列出的先用 map_places 查询，不自行发明地名。',
          '`feast_life_plan` 交回的每一段、`feast_life_now` 回答「我这会儿在哪」时，`location` 都用同一个正名——这样第二天的你和主人都对得上同一个地方。',
        ].join('\n')
        : '';

      return { map_places_block: lines.join('\n'), map_imggen_block: imggen, map_feast_block: feast };
    } catch (err) {
      this.#host?.log?.warn?.('小地图：地点清单算不出来', { err: msg(err) });
      return empty;
    }
  }

  /** 全图上有没有任何一处可提 scene（决定要不要给那句总提示）。 */
  canMentionAnyImggen() {
    try {
      if (!this.#imggenWanted() || !this.imggenInstalled) return false;
      return listPlaces(this.#state ?? newState()).some(hasScene);
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 工具
  // -------------------------------------------------------------------------

  tools() {
    return MAP_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: (args) => this.#runTool(decl.name, args ?? {}),
    }));
  }

  #runTool(name, args) {
    return this.#serial(async () => {
      try {
        // 现读一次三个「装没装」：工具都是 async，顺手刷新，刚装完她就能看到。
        await this.#refreshInstalled();
        return await this.#tool(name, args);
      } catch (err) {
        return { text: `[${name} 失败] ${msg(err)}`, failed: true };
      }
    });
  }

  async #tool(name, args) {
    this.#ensureStarted();
    if (['map_add', 'map_edit', 'map_cover'].includes(name)) this.#ensureWritable();
    switch (name) {
      case 'map_places': return { text: this.#placesText(args) };
      case 'map_look': return { text: this.#lookText(args) };
      case 'map_add': return { text: await this.#addText(args) };
      case 'map_edit': return { text: await this.#editText(args) };
      case 'map_cover': return { text: await this.#coverText(args) };
      case 'map_view': return { text: this.#viewText() };
      default: return { text: `[${name} 失败] 不认识这个工具。`, failed: true };
    }
  }

  // ---- map_places ---------------------------------------------------------

  #placesText(args) {
    const st = this.#state;
    const all = listPlaces(st);
    if (!all.length) {
      return [
        '小地图还是空的——一处地方都没有。',
        '主人可以在面板里选一套预设地形（林间 / 小区 / 江边 / 山脚 / 旅行），勾上要的那几处，就有空壳了；',
        '也可以直接用 map_add 加一处（只填文字，没有坐标也没有远近）。',
      ].join('\n');
    }
    const kind = normalizeKind(args?.kind);
    const rawKind = typeof args?.kind === 'string' ? args.kind.trim() : '';
    // 写了 kind 但认不出来：明确告诉她能填什么。
    // 不能悄悄当「没筛」——那会让她以为筛生效了，看到的其实还是全部。
    if (rawKind && !kind) {
      return `没有「${rawKind.slice(0, 20)}」这一类。能填的是：家 / 常去的 / 周围 / 旅行。`;
    }
    const tag = typeof args?.tag === 'string' ? args.tag.trim() : '';
    const relatedTo = typeof args?.relatedTo === 'string' ? args.relatedTo.trim() : '';
    const picks = all.filter((p) => (!kind || p.kind === kind)
      && (!tag || (p.tags ?? []).includes(tag))
      && (!relatedTo || (p.relations ?? []).some((r) => r.placeId === relatedTo)));
    const unpaged = args?.all === true;
    const page = args?.page ?? 1;
    const limit = args?.limit ?? LIST_PAGE_SIZE;
    if (!unpaged && (!Number.isSafeInteger(page) || page < 1)) return '[map_places 失败] page 必须是从 1 开始的整数。';
    if (!unpaged && (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_PAGE_MAX)) return `[map_places 失败] limit 必须是 1 至 ${LIST_PAGE_MAX} 的整数。`;
    if (!picks.length) return '没有符合筛选条件的地点。';
    const pages = Math.ceil(picks.length / limit);
    if (!unpaged && page > pages) return `匹配 ${picks.length} 处，共 ${pages} 页；请使用 1 至 ${pages} 的 page。`;
    const shown = unpaged ? picks : picks.slice((page - 1) * limit, page * limit);
    const lines = [`地点共 ${all.length} 处，匹配 ${picks.length} 处${unpaged ? '（全部）' : `，第 ${page}/${pages} 页`}：`];
    for (const p of shown) {
      lines.push(`- ${p.name}（id=${p.id}）［${kindLabelOf(p.kind)}］${p.frequent ? '★常去' : ''} ${p.cover ? '有图' : '还没图'}`);
    }
    if (!unpaged && page < pages) lines.push(`下一页：map_places 保持筛选条件，page=${page + 1}，limit=${limit}。`);
    lines.push('详情用 map_look（place 填 id；正名或别名也可，同名须明确 id）。');
    return lines.join('\n');
  }

  // ---- map_look ----------------------------------------------------------

  #lookText(args) {
    const st = this.#state;
    if (!listPlaces(st).length) {
      return '小地图还是空的，没地方可看。先让主人在面板里选一套预设地形，或者 map_add 加一处。';
    }
    const name = typeof args?.place === 'string' ? args.place : '';
    const place = resolvePlace(st, name);
    if (!place) return this.#missingPlace(name);

    const lines = [`${place.name}［${kindLabelOf(place.kind)}］${place.frequent ? ' ★常去' : ''}`];
    if (place.aliases.length) lines.push(`也叫：${place.aliases.join('、')}`);
    if (place.desc) {
      lines.push(place.desc);
    } else {
      // 空着就明说空着。**绝不替主人编一段描写**——这一处是他的地方。
      lines.push('（这处还没写描写。等主人补一句「什么样」，别替他想——那是他的地方，不是你的。）');
    }
    if (this.#effectiveStyle(place)) lines.push(`画风：${this.#effectiveStyle(place)}`);
    if (place.tags?.length) lines.push(`标签：${place.tags.join('、')}`);
    const relations = this.#relationLines(place);
    if (relations.length) lines.push('关联地点（仅按主人登记的说明）：\n' + relations.join('\n'));

    lines.push(place.cover
      ? `这处有图：${place.cover}（主人上传，面板可查看；本次回执没有附图片，不能声称已看见图片内容，外观以已登记描写为准）。`
      : '这处还没图。图要主人从面板上传一张，你自己变不出来。');

    // 发图那句：三条全满足才出现（mapImggenOn + worlds.imggen.enabled + scene 非空）。
    if (this.canMentionImggen(place)) {
      // outfits 那半截也看 feast 装没装——没装就不能让她去查 feast_life_now。
      lines.push(this.canMentionFeast()
        ? `想发图的时候就画这儿：\`imggen_draw\` 的 \`scene\` 填「${place.scene}」，\`outfits\` 填 \`feast_life_now\` 里那身，别自己编地方和衣服。`
        : `想发图的时候就画这儿：\`imggen_draw\` 的 \`scene\` 填「${place.scene}」，\`outfits\` 按你这会儿真穿的那身填，别自己编地方和衣服。`);
    }

    // 娱乐时间那句：同样三条才出现（mapFunOn + worlds.fun.enabled + funVenue 非空）。
    if (this.canMentionFun(place)) {
      lines.push(`这一趟想真去逛逛：\`fun_go\` 的 \`place\` 填「${place.funVenue}」——那是娱乐时间里**最接近这处**的一处，能逛、能拍照、能买点东西。`);
      lines.push('（不是同一个地方：别把「' + place.funVenue + '」说成「' + place.name + '」。想去就直说去了那处。）');
    }

    lines.push('（一处地方就是它自己长什么样，不是去别处的路上。）');
    return lines.join('\n');
  }

  #relationError(place, value) {
    if (!Array.isArray(value) || value.length > 8) return '地点关联必须是最多 8 条的列表';
    const normalized = normalizePlace({ ...place, relations: value }).relations;
    if (normalized.length !== value.length || value.some((r) => typeof r?.note !== 'string' || r.note.trim().length > 80)) {
      return '关联无效：请选择不同的已有地点，并填写 1–80 字说明；不能重复、自身关联或填写方位、路程信息';
    }
    if (normalized.some((r) => !placeById(this.#state, r.placeId))) return '关联目标已不存在，请重新选择地点';
    return '';
  }

  #relationLines(place) {
    const relations = Array.isArray(place?.relations) ? place.relations : [];
    return relations.flatMap((relation) => {
      const target = placeById(this.#state, relation.placeId);
      return target && relation.note ? [`- ${place.name} 与 ${target.name}：${relation.note}`] : [];
    });
  }

  #effectiveStyle(place) {
    return place?.style || (typeof this.cfg.mapStyleRef === 'string' ? this.cfg.mapStyleRef.replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  }

  #missingPlace(name) {
    if (['家', '家里', '回家'].includes(typeof name === 'string' ? name.trim() : '') && this.#state?.homeId) {
      const currentHome = placeById(this.#state, this.#state.homeId);
      if (currentHome) return `当前住所是「${currentHome.name}」（id=${currentHome.id}）。需要别处时请用明确地点名或 id。`;
    }
    const candidates = resolvePlaceCandidates(this.#state, name);
    if (candidates.length > 1) {
      return `「${String(name).slice(0, 40)}」对应多处地方，请用明确的 id 选择：${candidates.map((p) => `${p.name}［${findTerrain(p.terrain)?.label || kindLabelOf(p.kind)}］ id=${p.id}`).join(' / ')}。`;
    }
    return `没有「${String(name).slice(0, 40)}」这一处。周围有的是：${listPlaces(this.#state).slice(0, 8).map((p) => `${p.name}（${p.id}）`).join(' / ')}。`;
  }

  // ---- map_add -----------------------------------------------------------

  async #addText(args) {
    const input = {
      name: args?.name,
      aliases: Array.isArray(args?.aliases) ? args.aliases.slice(0, MAX_ALIASES) : undefined,
      kind: args?.kind,
      desc: args?.desc,
      style: args?.style,
      scene: args?.scene,
      funVenue: args?.funVenue,
      frequent: args?.frequent,
      tags: args?.tags,
    };
    const { place, error } = addPlace(this.#state, input, this.#now());
    if (error) return `${error}。\n（拿不准就 map_places 看看现在有哪些地方。）`;
    await this.#save();
    const lines = [`加了一处：${place.name}［${kindLabelOf(place.kind)}］。`];
    if (place.aliases.length) lines.push(`也叫：${place.aliases.join('、')}`);
    if (place.desc) lines.push(place.desc);
    else lines.push('（描写还空着，等主人补一句。别替他写。）');
    if (this.#effectiveStyle(place)) lines.push(`画风：${this.#effectiveStyle(place)}`);
    // scene / funVenue 都只在「三条全满足」时提（和 map_look 用同一个判据）。
    // 不满足时连这个词都不出现——否则等于告诉她「有个叫 scene 的东西可以填」，
    // 而那个东西这会儿根本用不上。
    if (this.canMentionImggen(place)) {
      lines.push(`生图 scene 填「${place.scene}」（主人填的才作数）。`);
    }
    if (this.canMentionFun(place)) {
      lines.push(`娱乐时间里最接近这处的是「${place.funVenue}」（想去逛时 \`fun_go\` 填这个）。`);
    }
    lines.push('要给它放一张图，用 map_cover；想让主人看见，主人在面板里就能看到这张卡。');
    return lines.join('\n');
  }

  // ---- map_edit ----------------------------------------------------------

  async #editText(args) {
    const name = typeof args?.place === 'string' ? args.place : '';
    const place = resolvePlace(this.#state, name);
    if (!place) return this.#missingPlace(name);
    if (args && Object.hasOwn(args, 'relations')) {
      const relationError = this.#relationError(place, args.relations);
      if (relationError) return `${relationError}。`;
    }
    const patch = {};
    for (const key of ['name', 'aliases', 'kind', 'desc', 'style', 'scene', 'funVenue', 'frequent', 'tags', 'relations']) {
      if (args && key in args) patch[key] = args[key];
    }
    if (!Object.keys(patch).length) {
      return '没说要改什么。能改的是：描写、画风锚点、别名、归类、是否常去、scene 正名、funVenue、地点关联——要换图用 map_cover。';
    }
    const { changed, error } = editPlace(this.#state, place.id, patch, this.#now());
    if (error) return `${error}。`;
    if (!changed.length) return `「${place.name}」这几项本来就长这样，没动。`;
    await this.#save();
    const LABEL = {
      name: '正名', aliases: '别名', kind: '归类', desc: '描写', style: '画风',
      scene: '场景名', funVenue: '娱乐时间那处', frequent: '常去', relations: '地点关联',
    };
    const out = [
      `改了「${place.name}」：${changed.map((k) => LABEL[k] ?? k).join('、')}。`,
      ... (changed.includes('relations') ? this.#relationLines(place) : []),
      place.desc ? `现在那句：${place.desc}` : '（描写现在是空的，等主人补。）',
      place.cover ? `图没动：${place.cover}（有图就锁着，要换得先 map_cover 清空）。` : '这处还没图。',
    ];
    // 改了 scene / funVenue 但三条不全满足：说一句「这会儿用不上」，但**不把名字念出来**。
    if (changed.includes('scene') && !this.canMentionImggen(place)) {
      out.push('（场景名记下了；发图那句要等装了生图工作室、并且配置里开着「可以提生图」才会出现。）');
    }
    if (changed.includes('funVenue') && !this.canMentionFun(place)) {
      out.push('（娱乐时间那处记下了；逛那处的话要等装了娱乐时间、并且配置里开着「跟娱乐时间对齐」才会出现。）');
    }
    return out.join('\n');
  }

  // ---- map_cover ---------------------------------------------------------

  async #coverText(args) {
    const name = typeof args?.place === 'string' ? args.place : '';
    const place = resolvePlace(this.#state, name);
    if (!place) return this.#missingPlace(name);

    if (args?.clear === true) {
      const before = place.cover;
      const { error } = setCover(this.#state, place.id, '', this.#now());
      if (error) return `${error}。`;
      await this.#save();
      return before
        ? `「${place.name}」的图清掉了（原来是 ${before}）。这会儿这处没有图，主人可以再放一张新的。`
        : `「${place.name}」本来就没有图，不用清。`;
    }

    const file = typeof args?.file === 'string' ? args.file.trim() : '';
    if (file) {
      // 只认主人真放进这处目录的那张——不凭空挂一个不存在的名字。
      const available = await this.#listCovers(place.id);
      if (!available.includes(file)) {
        const hint = available.length ? `这处现在放着的是：${available.join('、')}。` : '这处目录里还没有任何图片。';
        return `没找到「${file}」这张图。${hint}\n（图得主人在面板里上传一张，你没法自己造一张出来。）`;
      }
      const { cover, error } = setCover(this.#state, place.id, file, this.#now());
      if (error) return `${error}。`;
      await this.#save();
      return `「${place.name}」的图换成 ${cover} 了。`;
    }

    const available = await this.#listCovers(place.id);
    const lines = [
      place.cover
        ? `「${place.name}」现在挂着 ${place.cover}（有图就锁着，不会自己变；要换先 clear 清空）。`
        : `「${place.name}」现在没有图。`,
    ];
    if (available.length) {
      lines.push(`这处目录里放着：${available.join('、')}。要挂哪张就 file 填它的名字。`);
    } else {
      lines.push('这处目录里还没有图片——图要主人从面板上传（你自己画不出来，也别假装有）。');
    }
    return lines.join('\n');
  }

  // ---- map_view ----------------------------------------------------------

  #viewText() {
    const st = this.#state;
    const places = listPlaces(st);
    const s = summaryOf(st);
    if (!places.length) {
      return '小地图还是空的。主人在面板里选一套预设地形就能开箱有「周围」。';
    }
    const terrain = findTerrain(st.terrain);
    const lines = [
      `小地图（${terrain ? terrain.label : '没选地形'}）：一共 ${s.total} 处，${s.withCover} 处有图，${s.home} 处是家，${s.frequent} 处标了常去。`,
    ];
    for (const kind of KIND_ORDER) {
      const group = places.filter((p) => p.kind === kind);
      if (!group.length) continue;
      lines.push(`\n【${KIND_LABEL[kind]}】`);
      for (const p of group) {
        const pin = p.frequent ? '★' : '·';
        lines.push(`${pin} ${p.name}${p.cover ? ' 📷' : ''}${p.desc ? `：${briefDesc(p.desc, LIST_DESC_CHARS)}` : '：还没写描写'}`);
        lines.push(...this.#relationLines(p));
      }
    }
    lines.push('\n（只是一张地方清单，纯展示：谁和谁都不相连。）');
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // 存图
  // -------------------------------------------------------------------------

  /** 这处目录里现有的图片文件名（按魔数认，不看扩展名）。读不到就空数组。 */
  async #listCovers(placeId) {
    try {
      const names = await readdir(this.coversDir());
      return names.filter((n) => n.startsWith(`${placeId}.`)).sort();
    } catch {
      return [];
    }
  }

  /**
   * 写一张图进 `<dataDir>/map/covers/<id>.<ext>`，并把 cover 挂上去。
   *
   * 校验顺序：data URL 形状 → 字节数 ≤ 8 MiB → **文件头魔数** → 才落盘。
   * 扩展名按魔数定，不听用户传的。
   * 返回 `{ ok, cover, mime, bytes }` 或 `{ ok: false, error }`。
   */
  async #writeCover(placeId, dataUrl) {
    const place = placeById(this.#state, placeId);
    if (!place) return { ok: false, error: `没有这一处（${placeId}）` };
    const decoded = decodeDataUrl(dataUrl);
    if (decoded.error) return { ok: false, error: decoded.error };
    const dir = this.coversDir();
    await mkdir(dir, { recursive: true });
    // Different image bytes must invalidate stale crop saves, including same-extension uploads.
    const digest = createHash('sha256').update(decoded.bytes).digest('hex').slice(0, 12);
    const file = `${placeId}.${digest}.${decoded.ext}`;
    const target = join(dir, file);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, decoded.bytes);
    await rename(tmp, target);
    const { cover, error } = setCover(this.#state, placeId, file, this.#now());
    if (error) return { ok: false, error };
    await this.#save();
    // Older immutable cover files may still be referenced by state.json.bak,
    // import recovery, or undo snapshots; keep them available for restoration.
    return { ok: true, cover, mime: decoded.mime, bytes: decoded.bytes.length };
  }

  /** 读一处地方的图，返回 base64 data URL（面板显示用）。没有图返回 `{ ok: true, dataUrl: '' }`。 */
  async #readCover(placeId) {
    const place = placeById(this.#state, placeId);
    if (!place) {
      // 面板开屏时可能还没拿到 id（宿主会拿 getMethods 空跑一遍）：给空图，不算失败。
      // 真的传了个不存在的 id 也一样——一张读不到的图不该把面板打成错误页。
      return { ok: true, dataUrl: '', mime: '', bytes: 0 };
    }
    if (!place.cover) return { ok: true, dataUrl: '', mime: '', bytes: 0 };
    try {
      const file = join(this.coversDir(), place.cover);
      const st = await stat(file);
      if (!st.isFile()) return { ok: true, dataUrl: '', mime: '', bytes: 0 };
      if (st.size > MAX_COVER_BYTES) return { ok: false, error: `这张图超过 ${MAX_COVER_BYTES / 1024 / 1024} MiB，不显示` };
      const bytes = await readFile(file);
      const sniff = sniffImage(bytes);
      if (!sniff) return { ok: false, error: '这张图不是 png/jpg/webp/gif，不显示' };
      return { ok: true, dataUrl: `data:${sniff.mime};base64,${bytes.toString('base64')}`, mime: sniff.mime, bytes: bytes.length };
    } catch {
      // 文件被删了/挪走了：面板上显示「没图」，不报错、不炸面板。
      return { ok: true, dataUrl: '', mime: '', bytes: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // 存取
  // -------------------------------------------------------------------------

  async #load() {
    const file = this.stateFile();
    this.#storageWarning = '';
    this.#writeBlocked = false;
    this.#lastSaved = null;
    const parse = (source) => {
      const raw = JSON.parse(source);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.places)) {
        throw new Error('地点记录格式不完整');
      }
      return normalizeState(raw);
    };
    let source;
    let primaryError;
    try {
      source = await readFile(file, 'utf8');
      const state = parse(source);
      this.#lastSaved = JSON.stringify(state, null, 2);
      if (state.homeId && !state.places.some((p) => p.id === state.homeId && p.kind === 'home')) state.homeId = '';
      return state;
    } catch (err) {
      primaryError = err;
    }
    try {
      const backup = parse(await readFile(`${file}.bak`, 'utf8'));
      if (backup.homeId && !backup.places.some((p) => p.id === backup.homeId && p.kind === 'home')) backup.homeId = '';
      // 恢复前保留原始文件，避免正常保存掩盖损坏证据。
      if (source !== undefined) {
        await writeFile(`${file}.corrupt-${Date.now()}`, source, { encoding: 'utf8', flag: 'wx' });
      } else if (primaryError?.code !== 'ENOENT') {
        throw primaryError;
      }
      this.#lastSaved = JSON.stringify(backup, null, 2);
      this.#storageWarning = '地点记录读取失败，已从上一次保存的备份恢复；原文件已保留（如存在）。';
      this.#host?.log?.warn?.(this.#storageWarning);
      return backup;
    } catch (backupError) {
      if (primaryError?.code === 'ENOENT' && backupError?.code === 'ENOENT') return newState();
      this.#writeBlocked = true;
      this.#storageWarning = '地点记录无法读取，已保护原文件并暂停写入。请修复记录或备份后重新启动世界。';
      this.#host?.log?.warn?.(this.#storageWarning, { err: msg(primaryError) });
      return newState();
    }
  }

  #ensureWritable() {
    if (this.#writeBlocked) throw new Error(this.#storageWarning);
  }

  async #save() {
    if (!this.#state || this.#writeBlocked) return;
    const file = this.stateFile();
    const next = JSON.stringify(this.#state, null, 2);
    if (next === this.#lastSaved) return;
    await mkdir(dirname(file), { recursive: true });
    if (this.#lastSaved !== null) {
      await writeFile(`${file}.bak.tmp`, this.#lastSaved, 'utf8');
      await rename(`${file}.bak.tmp`, `${file}.bak`);
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, file);
    this.#lastSaved = next;
  }

  #serial(task) {
    const run = () => task();
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => {}, () => {});
    return result;
  }

  #ensureStarted() {
    if (!this.#started || !this.#state) throw new Error('小地图还没启动；等它启用后再试。');
  }

  // -------------------------------------------------------------------------
  // WebUI
  // -------------------------------------------------------------------------

  webUi(language = 'zh') {
    this.language = language === 'en' ? 'en' : 'zh';
    const t = text(this.language);
    const p = panelText(this.language);
    const st = this.#state ?? newState();
    const s = summaryOf(st);
    return {
      label: t.label,
      lamps: [{
        label: t.lamp,
        state: this.#started ? 'online' : 'offline',
        hint: this.#started
          ? (s.total ? `${s.total} 处地方，${s.withCover} 处有图` : '还没有地点')
          : t.stopped,
      }],
      badges: [
        { label: t.badgePlaces, value: String(s.total), tone: s.total ? 'plain' : 'off' },
        { label: t.badgeCover, value: `${s.withCover}/${s.total}`, tone: s.withCover ? 'plain' : 'off' },
      ],
      panels: [
        { id: 'places', title: p.places.title, description: p.places.description, getMethods: ['list', 'cover', 'drafts', 'export', 'inspectCovers', 'listCoverArchives', 'getPanelPrefs'] },
      ],
      invoke: (panel, method, args) => this.#serial(() => this.#invoke(panel, method, args ?? [])),
      config: [configGroup(this.language)],
      promptDocs: [{
        key: `worlds.${ID}.env`,
        title: t.label,
        description: t.prompt,
        path: ENV_PROMPT,
        role: 'envPrompt',
      }],
      storage: [{
        key: 'map-state',
        label: t.storage.label,
        kind: 'disk',
        location: this.stateFile(),
        danger: true,
        note: t.storage.note,
        stat: () => {
          const cur = this.#state;
          if (!cur) return '还没启动';
          const sum = summaryOf(cur);
          const terrain = findTerrain(cur.terrain);
          return `${sum.total} 处地方（${terrain ? terrain.label : '没选地形'}）· ${sum.withCover} 处有图`;
        },
        clear: () => this.#serial(() => this.#clearState()),
      }],
    };
  }

  // -------------------------------------------------------------------------
  // 面板数据面（客户端 bundle 只走这里，不读私有状态）
  // -------------------------------------------------------------------------

  /**
   * 面板调用的唯一入口。
   *
   * 契约：**只读方法必须幂等、不写盘**；写方法走的是和工具同一套纯函数，
   * 所以在面板上改一处和她自己调 `map_edit` 是一回事——不会有第二套逻辑。
   * 任何异常都兜成 `{ ok: false, error }`，不让面板挂掉。
   */
  async #invoke(panel, method, args) {
    try {
      this.#ensureStarted();
      await this.#refreshInstalled();
      if (panel !== 'places') throw new Error(`不认识的面板：${panel}`);
      const a = Array.isArray(args) ? (args[0] ?? {}) : (args ?? {});
      if (!['list', 'cover', 'drafts', 'saveDrafts', 'export', 'previewImport', 'recoveryInfo', 'previewRestore',
        'inspectCovers', 'listCoverArchives', 'getPanelPrefs', 'savePanelPrefs'].includes(method)) this.#ensureWritable();
      switch (method) {
        case 'list': return this.#listData();
        case 'inspectCovers': return await inspectCoverResources(dirname(this.stateFile()), {
          current: this.#state, saved: this.#lastSaved, undo: this.#undo?.before,
        });
        case 'listCoverArchives': return await listCoverArchives(dirname(this.stateFile()));
        case 'getPanelPrefs': return { ok: true, prefs: await readPanelPrefs(join(dirname(this.stateFile()), 'views.json')) };
        case 'archiveCovers': return await archiveCoverResources(dirname(this.stateFile()), {
          current: this.#state, saved: this.#lastSaved, undo: this.#undo?.before,
        }, { filenames: a.filenames, expectedRevision: a.expectedRevision, now: this.#now() });
        case 'restoreCoverArchive': return await restoreCoverResources(dirname(this.stateFile()), String(a.id ?? ''));
        case 'savePanelPrefs': return { ok: true, prefs: await writePanelPrefs(join(dirname(this.stateFile()), 'views.json'), a.prefs) };
        case 'cover': return await this.#readCover(String(a.id ?? ''));
        case 'upload': return await this.#uploadFromPanel(String(a.id ?? ''), a.data);
        case 'clearCover': return await this.#panelClearCover(String(a.id ?? ''));
        case 'coverFocus': return await this.#panelCoverFocus(a);
        case 'add': return await this.#panelAdd(a);
        case 'edit': return await this.#panelEdit(a);
        case 'remove': return await this.#panelRemove(String(a.id ?? ''));
        case 'undoRemove': return await this.#panelUndoRemove(String(a.token ?? ''));
        case 'batchEdit': return await this.#panelBatchEdit(a);
        case 'frequent': return await this.#panelFrequent(String(a.id ?? ''), a.on === true);
        case 'terrain': return await this.#panelTerrain(a);
        case 'setHome': return await this.#setHome(String(a.id ?? ''));
        case 'drafts': return { ok: true, drafts: structuredClone(draftEntries(this.#drafts)) };
        case 'saveDrafts': return await this.#saveDrafts(a.drafts);
        case 'export': return { ok: true, bundle: await buildExport(this.#state, (_filename, place) => this.#readCover(place.id)) };
        case 'previewImport': {
          const plan = prepareImport(this.#state, a.bundle, { mode: a.mode, decisions: a.decisions });
          return {
            ok: true,
            summary: plan.summary,
            items: plan.items,
            expectedRevision: revisionOf([this.#state, a.bundle, a.mode ?? 'skip', a.decisions ?? null]),
          };
        }
        case 'import': return await this.#importBundle(a);
        case 'recoveryInfo': return await this.#recoveryInfo();
        case 'previewRestore': return await this.#previewRestore();
        case 'restore': return await this.#restore(a);
        case 'removeDraft': return await this.#saveDrafts(draftEntries(this.#drafts).filter(({ id }) => id !== String(a.id ?? '')));
        default: throw new Error(`places 没有 ${method} 这个方法`);
      }
    } catch (err) {
      return { ok: false, error: msg(err) };
    }
  }

  #listData() {
    const st = this.#state;
    const places = listPlaces(st);
    const sum = summaryOf(st);
    return {
      ok: true,
      on: this.#on(),
      storageWarning: this.#storageWarning,
      // 三个联动的实况：面板据此决定要不要显示那一列说明。
      installed: {
        imggen: this.imggenInstalled,
        feast: this.feastInstalled,
        fun: this.funInstalled,
      },
      wanted: {
        imggen: this.#imggenWanted(),
        feast: this.#feastWanted(),
        fun: this.#funWanted(),
      },
      canMentionImggen: this.canMentionAnyImggen(),
      canMentionFeast: this.canMentionFeast(),
      terrain: st.terrain,
      terrainLabel: findTerrain(st.terrain)?.label ?? '',
      terrains: TERRAINS.map((t) => ({
        id: t.id,
        label: t.label,
        note: t.note,
        count: t.places.length,
        // 勾选表要的：这套骨架的每一处，带上「是不是已经有了」。
        skeletons: terrainPlaces(t.id).map((p) => ({
          id: p.id,
          name: p.name,
          kind: p.kind,
          kindLabel: kindLabelOf(p.kind),
          aliases: p.aliases,
          funVenue: p.funVenue,
          exists: st.places.some((x) => x.id === p.id),
        })),
      })),
      summary: sum,
      homeId: st.homeId ?? '',
      stateRevision: revisionOf(st),
      // 刚删掉的那一处还能不能撤回（10 秒内、且这期间没改过别处）。
      undo: this.#undoInfo(),
      places: places.map((p) => ({
        revision: revisionOf(p),
        ...placeView(p, st),
        effectiveStyle: this.#effectiveStyle(p),
        terrainLabel: findTerrain(p.terrain)?.label ?? '',
        // 每处单独再判一次：面板上「这处能不能提 scene / 去哪逛」和工具回执用同一个判据。
        canMentionImggen: this.canMentionImggen(p),
        canMentionFun: this.canMentionFun(p),
      })),
    };
  }

  async #setHome(id) {
    const place = placeById(this.#state, id);
    if (id && place?.kind !== 'home') return { ok: false, error: '请选择归类为家的地点' };
    this.#state.homeId = id;
    this.#state.updatedAt = this.#now();
    await this.#save();
    return { ok: true, homeId: id };
  }

  async #saveDrafts(drafts) {
    const clean = normalizeDrafts(drafts);
    if (JSON.stringify([...clean]) === JSON.stringify([...this.#drafts])) return { ok: true };
    const file = join(this.dataDir, 'map', 'drafts.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, drafts: draftEntries(clean) }), 'utf8');
    await rename(`${file}.tmp`, file);
    this.#drafts = clean;
    return { ok: true };
  }

  async #importBundle(a) {
    if (a.expectedRevision !== revisionOf([this.#state, a.bundle, a.mode ?? 'skip', a.decisions ?? null])) return { ok: false, error: '地点、文件或导入模式已变化，请重新预览导入', conflict: true };
    const plan = prepareImport(this.#state, a.bundle, { mode: a.mode, decisions: a.decisions });
    const previous = structuredClone(this.#state);
    const previousById = new Map(previous.places.map((place) => [place.id, place]));
    const withoutModifiedAt = (place) => {
      const { modifiedAt, ...content } = place;
      return content;
    };
    for (const place of plan.state.places) {
      const before = previousById.get(place.id);
      if (before && JSON.stringify(withoutModifiedAt(before)) !== JSON.stringify(withoutModifiedAt(place))) {
        place.modifiedAt = this.#now();
      }
    }
    if (!this.#state.homeId && plan.state.homeId) {
      const namedHome = plan.state.places.find((p) => p.id === plan.state.homeId);
      if (namedHome && previous.places.some((p) => p.name === namedHome.name && p.id !== namedHome.id)) {
        plan.state.homeId = '';
        plan.summary.conflicts.push(`当前住所「${namedHome.name}」与现有地点重名；导入后请在面板明确指定住所`);
      }
    }
    await mkdir(this.coversDir(), { recursive: true });
    for (const image of plan.images) {
      const target = join(this.coversDir(), image.filename);
      await writeFile(`${target}.tmp`, image.bytes);
      await rename(`${target}.tmp`, target);
    }
    this.#state = plan.state;
    this.#state.updatedAt = this.#now();
    try { await this.#save(); } catch (err) { this.#state = previous; throw err; }
    try { await this.#writeRecovery(previous); } catch (err) { this.#host?.log?.warn?.('小地图：导入前恢复点没保存成功', { err: msg(err) }); }
    return { ok: true, summary: plan.summary };
  }

  /** 导入成功后记下「导入前」那份状态，供面板一次性回退。 */
  async #writeRecovery(before) {
    const file = this.recoveryFile();
    await mkdir(dirname(file), { recursive: true });
    const payload = {
      version: 1,
      createdAt: new Date(this.#now()).toISOString(),
      before,
      after: revisionOf(this.#state),
    };
    await writeFile(`${file}.tmp`, JSON.stringify(payload), 'utf8');
    await rename(`${file}.tmp`, file);
  }

  async #readRecovery() {
    try {
      const raw = JSON.parse(await readFile(this.recoveryFile(), 'utf8'));
      if (!raw || typeof raw !== 'object' || !raw.before || !Array.isArray(raw.before.places)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async #recoveryInfo() {
    const data = await this.#readRecovery();
    if (!data) return { ok: true, available: false, canRestore: false };
    const canRestore = data.after === revisionOf(this.#state);
    return {
      ok: true,
      available: true,
      canRestore,
      createdAt: data.createdAt ?? '',
      total: data.before.places.length,
      reason: canRestore ? '' : '导入后地点已被修改，无法一键恢复',
    };
  }

  async #previewRestore() {
    const data = await this.#readRecovery();
    if (!data) return { ok: false, error: '暂无导入恢复点' };
    const current = this.#state;
    const before = data.before;
    const currentById = new Map(current.places.map((place) => [place.id, place]));
    const beforeById = new Map(before.places.map((place) => [place.id, place]));
    const removed = current.places.filter((place) => !beforeById.has(place.id)).map((place) => place.name);
    const restored = before.places
      .filter((place) => {
        const now = currentById.get(place.id);
        return !now || JSON.stringify(now) !== JSON.stringify(place);
      })
      .map((place) => place.name);
    return {
      ok: true,
      expectedRevision: revisionOf([current, before]),
      summary: {
        beforeCount: current.places.length,
        afterCount: before.places.length,
        removed,
        restored,
      },
    };
  }

  async #restore(a) {
    const data = await this.#readRecovery();
    if (!data) return { ok: false, error: '暂无导入恢复点' };
    if (a.expectedRevision !== revisionOf([this.#state, data.before])) {
      return { ok: false, error: '恢复点或地点已变化，请重新预览恢复', conflict: true };
    }
    this.#state = structuredClone(data.before);
    this.#state.updatedAt = this.#now();
    await this.#save();
    try { await unlink(this.recoveryFile()); } catch { /* 已经没了就算了 */ }
    return { ok: true };
  }

  async #uploadFromPanel(id, dataUrl) {
    const r = await this.#writeCover(id, dataUrl);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, cover: r.cover, mime: r.mime, bytes: r.bytes };
  }

  async #panelCoverFocus(a) {
    const place = placeById(this.#state, String(a.id ?? ''));
    if (!place) return { ok: false, error: `没有这一处（${String(a.id ?? '')}）` };
    const currentRevision = revisionOf(place);
    if ((a.expectedCover !== undefined && a.expectedCover !== place.cover)
      || (a.expectedRevision !== undefined && a.expectedRevision !== currentRevision)) {
      return { ok: false, conflict: true, current: { ...placeView(place, this.#state), revision: currentRevision } };
    }
    const { error, changed } = setCoverFocus(this.#state, place.id, { x: a.x, y: a.y }, this.#now());
    if (error) return { ok: false, error };
    if (changed) await this.#save();
    return { ok: true, changed, place: { ...placeView(place, this.#state), revision: revisionOf(place) } };
  }

  async #panelClearCover(id) {
    const place = placeById(this.#state, id);
    if (!place) return { ok: false, error: `没有这一处（${id}）` };
    const { error } = setCover(this.#state, id, '', this.#now());
    if (error) return { ok: false, error };
    await this.#save();
    return { ok: true };
  }

  async #panelAdd(a) {
    const { place, error } = addPlace(this.#state, {
      name: a.name,
      aliases: a.aliases,
      kind: a.kind,
      desc: a.desc,
      style: a.style,
      scene: a.scene,
      funVenue: a.funVenue,
      frequent: a.frequent,
      tags: a.tags,
    }, this.#now());
    if (error) return { ok: false, error };
    await this.#save();
    return { ok: true, place: placeView(place, this.#state) };
  }

  async #panelEdit(a) {
    const place = placeById(this.#state, String(a.id ?? '')) ?? resolvePlace(this.#state, a.id);
    if (!place) return { ok: false, error: `没有这一处（${String(a.id ?? '')}）` };
    if (Object.hasOwn(a, 'relations')) {
      const relationError = this.#relationError(place, a.relations);
      if (relationError) return { ok: false, error: relationError };
    }
    const currentRevision = revisionOf(place);
    if (a.expectedRevision !== undefined && a.expectedRevision !== currentRevision) {
      return { ok: false, conflict: true, current: { ...placeView(place, this.#state), revision: currentRevision } };
    }
    const patch = {};
    for (const key of ['name', 'aliases', 'kind', 'desc', 'style', 'scene', 'funVenue', 'frequent', 'tags', 'relations']) {
      if (key in a) patch[key] = a[key];
    }
    const { error, changed } = editPlace(this.#state, place.id, patch, this.#now());
    if (error) return { ok: false, error };
    if (changed.length) await this.#save();
    return { ok: true, changed, place: { ...placeView(placeById(this.#state, place.id), this.#state), revision: revisionOf(place) } };
  }

  /**
   * 删掉一处，并留一张 10 秒的「撤销牌」。
   *
   * 返回的 `undo` 直接交给面板显示倒计时；`before` 快照只留在服务端内存里，
   * 不写盘、不进任何回执——它是整份 state，没必要也**不该**给面板。
   */
  async #panelRemove(id) {
    const before = JSON.stringify(this.#state);
    const { removed, error } = removePlace(this.#state, id, this.#now());
    if (error) return { ok: false, error };
    await this.#save();
    this.#undo = {
      token: `undo-${randomUUID()}`,
      before,
      after: revisionOf(this.#state),
      expiresAt: this.#now() + UNDO_TTL_MS,
      name: removed?.name ?? '',
    };
    return { ok: true, removed: removed?.name ?? '', undo: this.#undoInfo() };
  }

  /** 当前那张撤销牌的对外样子；过期就当没有，顺手清掉。 */
  #undoInfo() {
    const u = this.#undo;
    if (!u) return null;
    const remainingMs = u.expiresAt - this.#now();
    if (remainingMs <= 0) {
      this.#undo = null;
      return null;
    }
    return { token: u.token, name: u.name, expiresAt: u.expiresAt, remainingMs };
  }

  /**
   * 撤销刚才那次删除。
   *
   * 三道门：token 对得上、没超过 10 秒、这期间 state 没被改过。
   * 第三道是关键——撤销用的是**删除前的整份快照**，如果中间主人改了别的
   * （哪怕只是给另一处加了个标签），换回去就等于把他的修改一起冲掉。
   */
  async #panelUndoRemove(token) {
    const u = this.#undo;
    if (!u) return { ok: false, error: '没有可以撤销的删除（可能已经过期）' };
    if (!token || token !== u.token) return { ok: false, error: '这次撤销已经失效（后面又有新的改动或删除）' };
    if (this.#now() > u.expiresAt) {
      this.#undo = null;
      return { ok: false, error: '超过 10 秒了，这次删除不能再撤销' };
    }
    if (revisionOf(this.#state) !== u.after) {
      this.#undo = null;
      return { ok: false, error: '地点在这之间被改过，撤销会把那些修改一起冲掉，已拒绝' };
    }
    try {
      this.#state = normalizeState(JSON.parse(u.before));
    } catch {
      return { ok: false, error: '撤销用的快照读不出来，这次撤销作废' };
    }
    await this.#save();
    this.#undo = null;
    return { ok: true, restored: u.name };
  }

  /**
   * 一次改多处：加/移标签、标记或取消「常去」、调整归类。
   *
   * 只做传进来的那几项，没传的不动。几处刻意的行为：
   *   - 先整体校验再写：有任何 id 不存在、归类认不出、一条改动都没给，整次不动；
   *   - **逐处**决定要不要跳过：加标签会超过 8 个的那一处跳过并单独报告，
   *     其余照改——不因为一处满了就把整批回滚；
   *   - 标签仍走 `normalizeTags`（纯文本、每条 ≤24 字、去重），不另开一套规则。
   */
  async #panelBatchEdit(a) {
    const ids = Array.isArray(a?.ids) ? a.ids.filter((x) => typeof x === 'string' && x.trim()) : [];
    if (!ids.length) return { ok: false, error: '先在卡片上勾选要处理的地点' };
    if (new Set(ids).size !== ids.length) return { ok: false, error: '勾选名单里有重复的地点' };
    const places = ids.map((id) => placeById(this.#state, id));
    if (places.some((p) => !p)) return { ok: false, error: '有勾选的地点已经不存在了，刷新后再试' };

    const addTags = normalizeTags(a?.addTags);
    const removeTags = normalizeTags(a?.removeTags);
    const touchedKind = a !== null && typeof a === 'object' && Object.hasOwn(a, 'kind');
    const kind = touchedKind ? normalizeKind(a.kind) : '';
    if (touchedKind && !kind) return { ok: false, error: '归类只认「家 / 常去的 / 周围 / 旅行」四档' };
    const touchedFrequent = a !== null && typeof a === 'object' && Object.hasOwn(a, 'frequent');
    const frequent = touchedFrequent ? a.frequent === true : undefined;
    if (!addTags.length && !removeTags.length && !kind && !touchedFrequent) return { ok: false, error: '没有要改的内容' };

    const updated = [];
    const skipped = [];
    for (const place of places) {
      const patch = {};
      if (addTags.length || removeTags.length) {
        const base = Array.isArray(place.tags) ? place.tags : [];
        const merged = [...base];
        for (const tag of addTags) if (!merged.includes(tag)) merged.push(tag);
        const wanted = merged.filter((tag) => !removeTags.includes(tag));
        // 先按「合并后到底会有几条」判，再归一：归一本身会把超出的截掉，
        // 拿截完的结果去比永远比不出来，那样就成了「悄悄丢标签」。
        if (wanted.length > MAX_TAGS) {
          skipped.push({ id: place.id, name: place.name, reason: `标签最多 ${MAX_TAGS} 个，这处已有 ${base.length} 个` });
          continue;
        }
        patch.tags = normalizeTags(wanted);
      }
      if (kind) patch.kind = kind;
      if (frequent !== undefined) patch.frequent = frequent;
      const { changed, error } = editPlace(this.#state, place.id, patch, this.#now());
      if (error) {
        skipped.push({ id: place.id, name: place.name, reason: error });
        continue;
      }
      if (changed.length) updated.push(place.id);
    }
    if (updated.length) await this.#save();
    return { ok: true, updated: updated.length, skipped, total: ids.length };
  }

  async #panelFrequent(id, on) {
    const place = placeById(this.#state, id);
    if (!place) return { ok: false, error: `没有这一处（${id}）` };
    const { error } = editPlace(this.#state, id, { frequent: on }, this.#now());
    if (error) return { ok: false, error };
    await this.#save();
    return { ok: true, frequent: on };
  }

  /**
   * 从预设地形里**挑着**加几处（面板的勾选表走这里）。
   *
   * `a.ids` 是要加的那几条骨架 id；不传 = 全加（和原来的「点了就全加」等价）。
   * 传空数组 = 一处都不加（勾选表被全不选），这不是错误。
   */
  async #panelTerrain(a) {
    const id = typeof a?.id === 'string' ? a.id : '';
    const ids = Array.isArray(a?.ids) ? a.ids.filter((x) => typeof x === 'string') : null;
    const { added, terrain, skipped, error } = applyTerrainSelection(this.#state, id, ids, this.#now(), { withDescriptions: a.withDescriptions === true });
    if (error) return { ok: false, error };
    if (added.length) await this.#save();
    return {
      ok: true,
      terrain,
      terrainLabel: findTerrain(terrain)?.label ?? '',
      added: added.map((p) => p.name),
      skipped: skipped.length,
    };
  }

  /** 清空地点记录（存储页「清掉」）。只清 state 这一份，不碰别的 World。 */
  async #clearState() {
    this.#ensureWritable();
    this.#state = newState();
    await this.#save();
    this.#host?.log?.info?.('小地图：地点记录已清空');
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async start(host) {
    if (this.#started) return;
    this.#host = host;
    this.#ensureConfigSection();
    this.#state = await this.#load();
    try {
      const draftFile = JSON.parse(await readFile(join(this.dataDir, 'map', 'drafts.json'), 'utf8'));
      this.#drafts = normalizeDrafts(draftFile.drafts ?? []);
    } catch { this.#drafts = new Map(); }
    // 三个联动装没装：启动时读一次（只读 config 的布尔字段）。
    await this.#refreshInstalled(true).catch(() => {});
    this.#started = true;
    this.#host?.log?.info?.('小地图已启动', {
      places: this.#state.places.length,
      terrain: this.#state.terrain || null,
      installed: { ...this.#installed },
    });
  }

  async stop() {
    await this.#queue;
    this.#started = false;
    try { await this.#save(); } catch { /* 停的时候存不上就算了 */ }
    this.#host = null;
  }
}

/** 给面板/测试用的地形名清单。 */
export function terrainNames() {
  return TERRAINS.flatMap((t) => [t.id, t.label]);
}

export { KIND_LABEL, TERRAINS, findPlace, hasFunVenue, hasScene, terrainPlaces };
export default { MAP_TOOL_DECLS, MapWorld };
