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
import { fileURLToPath } from 'node:url';

import { DEFAULTS, ID, configGroup, panelText, text } from './config.js';
import {
  KIND_LABEL, TERRAINS, findTerrain, findPlace, hasFunVenue, hasScene, normalizePlace, terrainPlaces,
} from './places.js';
import {
  MAX_ALIASES, addPlace, applyTerrain, applyTerrainSelection, editPlace, kindLabelOf, listPlaces,
  newState, normalizeKind, normalizeState, placeById, placeView, removePlace, resolvePlace,
  setCover, summaryOf,
} from './state.js';

const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

const msg = (err) => (err instanceof Error ? err.message : String(err));

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

/**
 * 常驻前缀里每处地点最多带几个字的描写。
 *
 * 只够「认出是哪处」；完整描写永远由 `map_look` 现给。
 * 不改这个值会让常驻前缀随描写长度线性膨胀（实测 25 处 × 400 字 ≈ 9k tokens，每轮都付）。
 */
const ENV_DESC_CHARS = 40;

/**
 * 常驻前缀里最多列几处地点。
 *
 * 超过就用「还有 N 处」带过——`MAX_PLACES` 是 60，全列进去会白白撑爆前缀。
 * 这条和 `ENV_DESC_CHARS` 一起把常驻部分的大小**钉成常数级**。
 */
const ENV_PLACES_MAX = 20;

/**
 * `map_places` / `map_view` 回执里每处带几个字的描写。
 *
 * 这两个工具是**清单**不是详情：认得出是哪处就够，完整描写由 `map_look` 现给。
 * 不截的话 25 处 × 200 字实测约 3.5–5k tokens 一次回执，而她只是想知道「有哪些地方」。
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
    description: '看看周围有哪些地方：家、常去的、附近的、去远处旅行的。每处给一句文字描写、有没有图、是不是常去。默认按「常去 > 家 > 周围 > 旅行」排；想只看一类就填 kind。没有路线、没有远近，也没有「怎么走」。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: '只看某一类：家 / 常去的 / 周围 / 旅行（英文 home / frequent / around / travel 也认）。不填就全列。',
        },
        all: { type: 'boolean', description: '填 true 就列全部，否则也只列全部（这里没有截断，留着这个参数是为了和别的工具一致）。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'map_look',
    tags: ['read', 'snapshot'],
    description: '看某一处长什么样：回执给这一处的文字描写、画风锚点、有没有图。写日程说「此刻在哪」、或者想发图之前用它。这处还空着的时候会明说空着——别替主人编一段描写。',
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
    description: '加一处地方。只填文字：名字、别名、属于哪一类（家 / 常去的 / 周围 / 旅行）、一句描写、一句画风锚点。**不填坐标、不填路线、不填多远**——这个插件没有这些。',
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
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_edit',
    tags: ['write'],
    description: '改某一处的文字：描写、画风锚点、别名、归类、是否常去、scene 正名、娱乐时间那处。只改传进来的那几项，没传的一个字都不动。要换图用 map_cover。',
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
      },
      required: ['place'],
      additionalProperties: false,
    },
  },
  {
    name: 'map_cover',
    tags: ['write'],
    description: '这处地方的图：换成本地的一张、或者清空。**图是主人从面板上传的**，不是这里画的；你来这里只做两件事——把主人放好的那张挂上去，或者清空。清空之后主人才可以再放一张新的（有图的时候它锁死，不会自己变）。',
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
  #queue = Promise.resolve();
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

      // ---- 截断：这是**常驻**前缀，每轮都付钱 ----
      //
      // 方案 §6 写的是「只列名字 + 一句**短**描写，细节留给 map_look」。
      // 之前把整段 `desc`（上限 400 字）都塞在这里，实测 25 处 × 400 字 ≈ 6.6–9.4k tokens，
      // 每一轮都要付一遍。现在：
      //   · 每处描写只取开头 ENV_DESC_CHARS 字（够认出是哪处，细节叫 map_look）；
      //   · 清单最多列 ENV_PLACES_MAX 处，其余让她用 map_places 看全。
      // 这样常驻部分与「地点数 × 描写长度」脱钩，兜住了上限。
      const shown = places.slice(0, ENV_PLACES_MAX);
      const lines = ['（周围的地方：）'];
      for (const p of shown) {
        const alias = p.aliases.length ? `（也叫 ${p.aliases.slice(0, 3).join('、')}）` : '';
        const pin = p.frequent ? '★' : '';
        const pic = p.cover ? ' 有图' : '';
        // 这处有没有 scene 只在「可以提生图」时说出来；否则连这个词都不出现。
        const scene = this.canMentionImggen(p) ? ` 生图 scene 填「${p.scene}」` : '';
        let desc = '：还没写描写';
        if (p.desc) desc = `：${briefDesc(p.desc, ENV_DESC_CHARS)}`;
        lines.push(`- ${pin}${p.name}${alias}${pic}${desc}${scene}`);
      }
      if (places.length > shown.length) {
        lines.push(`（还有 ${places.length - shown.length} 处没列出来——map_places 能看全。）`);
      }

      const imggen = this.canMentionAnyImggen()
        ? [
          '## 想发图的时候',
          '',
          '`imggen_draw` 的 `scene` 填上面写明的那个正名，别自己编地方。',
          this.canMentionFeast()
            ? '`outfits` 填 `feast_life_now` 里那身，别自己编衣服。'
            : '`outfits` 按你这会儿真穿的那身填，别自己编衣服名字。',
          '上面**没写** scene 的那几处，就是素材库里没有——把地方写进 `prompt` 就行，别硬填一个库里没有的名字。',
        ].join('\n')
        : '';

      // 「写日程用正名」这句：只在鱼的每一天装了、并且真有地点时才出现。
      const feast = this.canMentionFeast()
        ? [
          '## 写日程、说此刻在哪的时候',
          '',
          '地点用上面清单里的**正名**（「家」「溪边」「老橡树」），别自己发明一个不在清单里的地名。',
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
    const picks = kind ? all.filter((p) => p.kind === kind) : all;
    if (!picks.length) {
      const have = [...new Set(all.map((p) => kindLabelOf(p.kind)))].join(' / ');
      return `「${kindLabelOf(kind)}」这一类现在一处都没有。现在有的是：${have}。`;
    }

    const lines = [`周围一共 ${all.length} 处地方${kind ? `，这里只列「${kindLabelOf(kind)}」这几处` : ''}：`];
    for (const p of picks) {
      const bits = [p.name];
      if (p.aliases.length) bits.push(`（也叫 ${p.aliases.slice(0, 3).join('、')}）`);
      bits.push(`［${kindLabelOf(p.kind)}］`);
      if (p.frequent) bits.push('★常去');
      lines.push(`- ${bits.join('')}${p.desc ? `：${briefDesc(p.desc, LIST_DESC_CHARS)}` : '：还没写描写'}`);
      lines.push(`  ${p.cover ? '有图' : '还没图'}${p.style ? ` · 画风：${p.style}` : ''}`);
    }
    lines.push('想看某一处具体长什么样：map_look（place 填正名）。');
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
    if (!place) {
      const names = listPlaces(st).slice(0, 8).map((p) => p.name).join(' / ');
      return `没有「${String(name).slice(0, 40)}」这一处。周围有的是：${names}。`;
    }

    const lines = [`${place.name}［${kindLabelOf(place.kind)}］${place.frequent ? ' ★常去' : ''}`];
    if (place.aliases.length) lines.push(`也叫：${place.aliases.join('、')}`);
    if (place.desc) {
      lines.push(place.desc);
    } else {
      // 空着就明说空着。**绝不替主人编一段描写**——这一处是他的地方。
      lines.push('（这处还没写描写。等主人补一句「什么样」，别替他想——那是他的地方，不是你的。）');
    }
    if (place.style) lines.push(`画风：${place.style}`);

    lines.push(place.cover
      ? `这处有图：${place.cover}（主人放的，就照这张看）。`
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
    };
    const { place, error } = addPlace(this.#state, input, this.#now());
    if (error) return `${error}。\n（拿不准就 map_places 看看现在有哪些地方。）`;
    await this.#save();
    const lines = [`加了一处：${place.name}［${kindLabelOf(place.kind)}］。`];
    if (place.aliases.length) lines.push(`也叫：${place.aliases.join('、')}`);
    if (place.desc) lines.push(place.desc);
    else lines.push('（描写还空着，等主人补一句。别替他写。）');
    if (place.style) lines.push(`画风：${place.style}`);
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
    if (!place) {
      const names = listPlaces(this.#state).slice(0, 8).map((p) => p.name).join(' / ');
      return `没有「${String(name).slice(0, 40)}」这一处。周围有的是：${names || '（还没有）'}。`;
    }
    const patch = {};
    for (const key of ['name', 'aliases', 'kind', 'desc', 'style', 'scene', 'funVenue', 'frequent']) {
      if (args && key in args) patch[key] = args[key];
    }
    if (!Object.keys(patch).length) {
      return '没说要改什么。能改的是：描写、画风锚点、别名、归类、是否常去、scene 正名、funVenue——要换图用 map_cover。';
    }
    const { changed, error } = editPlace(this.#state, place.id, patch, this.#now());
    if (error) return `${error}。`;
    if (!changed.length) return `「${place.name}」这几项本来就长这样，没动。`;
    await this.#save();
    const LABEL = {
      name: '正名', aliases: '别名', kind: '归类', desc: '描写', style: '画风',
      scene: '场景名', funVenue: '娱乐时间那处', frequent: '常去',
    };
    const out = [
      `改了「${place.name}」：${changed.map((k) => LABEL[k] ?? k).join('、')}。`,
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
    if (!place) {
      const names = listPlaces(this.#state).slice(0, 8).map((p) => p.name).join(' / ');
      return `没有「${String(name).slice(0, 40)}」这一处。周围有的是：${names || '（还没有）'}。`;
    }

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
    // 换扩展名时先把同名旧图删掉，免得目录里留着两张都是 <id>.* 的。
    try {
      const old = await readdir(dir);
      for (const n of old) {
        if (n.startsWith(`${placeId}.`) && n !== `${placeId}.${decoded.ext}`) {
          await unlink(join(dir, n)).catch(() => {});
        }
      }
    } catch { /* 目录都不存在就算了 */ }
    const file = `${placeId}.${decoded.ext}`;
    const target = join(dir, file);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, decoded.bytes);
    await rename(tmp, target);
    const { cover, error } = setCover(this.#state, placeId, file, this.#now());
    if (error) return { ok: false, error };
    await this.#save();
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
    try {
      const raw = JSON.parse(await readFile(this.stateFile(), 'utf8'));
      return normalizeState(raw);
    } catch {
      return newState();
    }
  }

  async #save() {
    if (!this.#state) return;
    const file = this.stateFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
    await rename(tmp, file);
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
        { id: 'places', title: p.places.title, description: p.places.description, getMethods: ['list', 'cover'] },
      ],
      invoke: (panel, method, args) => this.#invoke(panel, method, args ?? []),
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
        clear: () => this.#clearState(),
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
      switch (method) {
        case 'list': return this.#listData();
        case 'cover': return await this.#readCover(String(a.id ?? ''));
        case 'upload': return await this.#uploadFromPanel(String(a.id ?? ''), a.data);
        case 'clearCover': return await this.#panelClearCover(String(a.id ?? ''));
        case 'add': return await this.#panelAdd(a);
        case 'edit': return await this.#panelEdit(a);
        case 'remove': return await this.#panelRemove(String(a.id ?? ''));
        case 'frequent': return await this.#panelFrequent(String(a.id ?? ''), a.on === true);
        case 'terrain': return await this.#panelTerrain(a);
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
      places: places.map((p) => ({
        ...placeView(p),
        // 每处单独再判一次：面板上「这处能不能提 scene / 去哪逛」和工具回执用同一个判据。
        canMentionImggen: this.canMentionImggen(p),
        canMentionFun: this.canMentionFun(p),
      })),
    };
  }

  async #uploadFromPanel(id, dataUrl) {
    const r = await this.#writeCover(id, dataUrl);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, cover: r.cover, mime: r.mime, bytes: r.bytes };
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
    }, this.#now());
    if (error) return { ok: false, error };
    await this.#save();
    return { ok: true, place: placeView(place) };
  }

  async #panelEdit(a) {
    const place = placeById(this.#state, String(a.id ?? '')) ?? resolvePlace(this.#state, a.id);
    if (!place) return { ok: false, error: `没有这一处（${String(a.id ?? '')}）` };
    const patch = {};
    for (const key of ['name', 'aliases', 'kind', 'desc', 'style', 'scene', 'funVenue', 'frequent']) {
      if (key in a) patch[key] = a[key];
    }
    const { error, changed } = editPlace(this.#state, place.id, patch, this.#now());
    if (error) return { ok: false, error };
    if (changed.length) await this.#save();
    return { ok: true, changed, place: placeView(placeById(this.#state, place.id)) };
  }

  async #panelRemove(id) {
    const { removed, error } = removePlace(this.#state, id, this.#now());
    if (error) return { ok: false, error };
    await this.#save();
    return { ok: true, removed: removed?.name ?? '' };
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
    const { added, terrain, skipped, error } = applyTerrainSelection(this.#state, id, ids, this.#now());
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
