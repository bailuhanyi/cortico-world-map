/**
 * 地点库：预设地形 + place 归一化 + `hasScene` / `hasFunVenue` 判定。
 *
 * **这个文件就是「小地图」的全部内容模型**，照 `MAP-小地图插件-方案.md` §3 定稿。
 * 每个地点只有文字 + 图片引用：
 *
 *   id / name / aliases / kind / desc / style / cover / scene / funVenue / frequent / terrain / relations / tags / modifiedAt?
 *
 * **没有坐标、没有路线、没有距离、没有导航**——这是需求红线，不是「这一版先不做」。
 * `test/places.test.mjs` 里钉了一条守门断言：任何 place 都不许出现 geo 字段。
 * 所以这里连「离家的远近」「从家走几分钟」这种字眼都不该进数据。
 * 旅游预设也一样：没有「几天」「行程」「怎么去」，那些归「鱼的每一天」的日程。
 *
 * 两个「外部正名」字段都是**字符串，不是读库**：
 *   - `scene`    → 生图素材库里的场景正名（和 `fun-world/src/venues.js` 同一套）；
 *   - `funVenue` → 娱乐时间那二十处里的某一处正名。
 *
 * 本插件不读 `imggen-library`、不读 fun 的场所库，只把「该填哪个名字」递到她嘴边。
 * 对不上就留空、回执整段不提，**绝不替她编一个不存在的名字**。
 */

/** 四档 `kind` 的中文标签（只用于分组展示，不是 geo）。 */
export const KIND_LABEL = Object.freeze({
  home: '家',
  frequent: '常去的',
  around: '周围',
  travel: '旅行',
});

/** `kind` 的合法取值。`travel` 是 2026-11-15 加旅游预设时新增的一档。 */
export const KINDS = Object.freeze(['home', 'frequent', 'around', 'travel']);

/**
 * `kind` 归一：英文 id 和中文标签都认；空/认不出 → ''。
 *
 * 放在 places.js 而不是 state.js：`normalizePlace()` 要用它，而 places.js 是最底层
 * （不能被 state.js 反向依赖）。加地点时主人写「常去的」和写 `frequent` 等价。
 */
export function normalizeKind(kind) {
  const k = text(kind, 10);
  if (!k) return '';
  if (KINDS.includes(k)) return k;
  if (k === '家' || k === '家里') return 'home';
  if (k === '常去' || k === '常去的' || k === '常去的地方') return 'frequent';
  if (k === '周围' || k === '附近' || k === '周边的') return 'around';
  if (k === '旅行' || k === '旅游' || k === '远处') return 'travel';
  return '';
}

/**
 * 预设地形（方案 §3「选择：预设，开箱即有『周围』」）。
 *
 * 五套，每套 5 个地点；默认生成空 `desc` 骨架，也可显式选用示例描写。
 * `style` / `scene` 也留空：骨架不知道主人喜欢什么画风、也不知道素材库里有什么场景，
 * 猜一个反而是错的。
 */
export const TERRAINS = Object.freeze([
  {
    id: 'forest',
    label: '林间',
    note: '家在最里面，外头是树、坡、溪和空地。',
    places: [
      { slug: 'home', name: '家', aliases: ['屋里', '树洞', '小木屋'], kind: 'home' },
      { slug: 'old-oak', name: '老橡树', aliases: ['大橡树', '大树'], kind: 'around' },
      { slug: 'creek', name: '溪边', aliases: ['小溪', '溪水'], kind: 'around' },
      { slug: 'mushroom-slope', name: '蘑菇坡', aliases: ['蘑菇林', '坡上'], kind: 'around' },
      { slug: 'clearing', name: '林间空地', aliases: ['空地', '林间'], kind: 'around' },
    ],
  },
  {
    id: 'neighborhood',
    label: '小区',
    note: '家在一栋楼里，楼下是院子、长椅、便利店。',
    places: [
      { slug: 'home', name: '家', aliases: ['屋里', '家里'], kind: 'home' },
      { slug: 'bench', name: '楼下长椅', aliases: ['长椅', '楼下'], kind: 'around' },
      { slug: 'store-front', name: '便利店门口', aliases: ['便利店', '小店门口'], kind: 'around' },
      { slug: 'garden', name: '小花园', aliases: ['花园', '花坛'], kind: 'around' },
      { slug: 'stairwell', name: '单元楼道', aliases: ['楼道', '楼梯口'], kind: 'around' },
    ],
  },
  {
    id: 'riverside',
    label: '江边',
    note: '家离水很近，门外是堤、码头、芦苇和石墩。',
    places: [
      { slug: 'home', name: '家', aliases: ['屋里', '家里'], kind: 'home' },
      { slug: 'levee-steps', name: '江堤台阶', aliases: ['堤上', '台阶'], kind: 'around' },
      { slug: 'old-pier', name: '旧码头', aliases: ['码头', '老码头'], kind: 'around' },
      { slug: 'reeds', name: '芦苇滩', aliases: ['芦苇', '滩上'], kind: 'around' },
      { slug: 'bollard', name: '江边石墩', aliases: ['石墩', '系缆桩'], kind: 'around' },
    ],
  },
  {
    id: 'foothill',
    label: '山脚',
    note: '家贴着山，往上走是泉、亭子和碎石坡。',
    places: [
      { slug: 'home', name: '家', aliases: ['屋里', '家里'], kind: 'home' },
      { slug: 'trailhead', name: '上山口', aliases: ['山口', '入山口'], kind: 'around' },
      { slug: 'spring', name: '山泉', aliases: ['泉水', '泉眼'], kind: 'around' },
      { slug: 'pavilion', name: '半坡亭', aliases: ['亭子', '半山亭'], kind: 'around' },
      { slug: 'scree', name: '碎石坡', aliases: ['石坡', '碎石'], kind: 'around' },
    ],
  },
  {
    id: 'travel',
    label: '旅行',
    note: '远一点的地方。只说那儿长什么样——几天、怎么去、行程怎么排，都不在这里。',
    /**
     * 旅游预设（2026-11-15 加）。
     *
     * 地点名刻意用「远方」的：主人想要的是一个能出图的目的地。
     * 但娱乐时间那二十处里**没有**「海边小镇」「雪山」这种词，硬让她 `fun_go` 填
     * 这几个字，fun 会回「没听说过这处」——那正是红线禁止的「指向不存在的东西」。
     *
     * 所以每处预置一个 `funVenue`：娱乐时间里**最接近的那一处**的正名。
     * 回执会明说「那是娱乐时间里最接近这处的一处」，不会假装是同一个地方。
     * 这几个名字写死在这里，是因为它们就是 fun 0.1.x 的场所正名（主人可改可清空）。
     */
    places: [
      { slug: 'seaside-town', name: '海边小镇', aliases: ['小镇', '海边'], kind: 'travel', funVenue: '江边' },
      { slug: 'snow-inn', name: '雪山客栈', aliases: ['雪山', '客栈'], kind: 'travel', funVenue: '爬山' },
      { slug: 'old-town', name: '古城老街', aliases: ['古城', '老街'], kind: 'travel', funVenue: '旧货市场' },
      { slug: 'hot-spring', name: '温泉旅馆', aliases: ['温泉', '旅馆'], kind: 'travel', funVenue: '澡堂' },
      { slug: 'camp', name: '林间营地', aliases: ['营地', '露营'], kind: 'travel', funVenue: '公园' },
    ],
  },
]);

/** 地形 id 合法吗。 */
export function isTerrain(id) {
  return TERRAINS.some((t) => t.id === id);
}

/** 按 id 取地形；不认识返回 null（不抛错）。 */
export function findTerrain(id) {
  const key = typeof id === 'string' ? id.trim() : '';
  if (!key) return null;
  return TERRAINS.find((t) => t.id === key) ?? TERRAINS.find((t) => t.label === key) ?? null;
}

/** 这条鱼当前有没有选地形（state.terrain 非空且合法）。 */
export function terrainOf(state) {
  const id = typeof state?.terrain === 'string' ? state.terrain.trim() : '';
  return isTerrain(id) ? id : '';
}

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function textList(v, maxItems, maxLen) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  for (const it of arr) {
    const s = text(it, maxLen);
    if (!s) continue;
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

// Keep relationships descriptive; reject actionable route, measurement, and compass details.
const RELATION_RESTRICTED = /路线|导航|坐标|左转|右转|距离|路程|公里|千米|几分钟|[\d一二三四五六七八九十百几]+\s*(?:米|分钟|小时)|(?:向|往|朝|正)[东西南北]|[东西南北](?:侧|面|边|方)|(?:左|右)(?:侧|边|面)|\b(?:routes?|navigation|coordinates?|distance|east|west|north|south)\b/i;

/** 每处地点最多几个标签：归一、面板校验和批量编辑共用这一个数。 */
export const MAX_TAGS = 8;

/** 标签只收纯文本；先检查完整输入，避免截断把红线内容藏在尾部。 */
export function normalizeTags(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue;
    const full = item.replace(/\s+/g, ' ').trim();
    if (!full || /[<>\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u.test(full)
      || RELATION_RESTRICTED.test(full)) continue;
    const tag = Array.from(full).slice(0, 24).join('').trim();
    if (out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function normalizeRelations(value, selfId) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object') continue;
    const placeId = typeof item.placeId === 'string' ? item.placeId.trim() : '';
    const fullNote = typeof item.note === 'string' ? item.note.replace(/\s+/g, ' ').trim() : '';
    const note = fullNote.slice(0, 80);
    if (!isSafeId(placeId) || placeId === selfId || seen.has(placeId) || !note || RELATION_RESTRICTED.test(fullNote)) continue;
    seen.add(placeId);
    out.push({ placeId, note });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * `id` 只许这些字符。
 *
 * 为什么必须管：`id` 会被拼成图片文件名（`<covers>/<id>.<ext>`）。手改坏的
 * state.json 里塞一个 `../../evil`，落盘时就会写到数据目录外面去。
 * 这里在**入口**（`normalizePlace`）就拦掉，而不是等拼路径的时候再补。
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

/** id 合不合法（导出给测试和面板用）。 */
export function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..');
}

/**
 * 把一条 place 归一化成当前形状（不信任磁盘内容）。
 *
 * 只产下面列出的字段（含描述标签和关系）——**多余字段一律丢掉**，geo 字段当然也丢。
 * 这样老状态里混进来的 `lat` / `lng` / `route` 不会活到下一次落盘。
 *
 * （比方案 §3 的十个多了 `funVenue`：2026-11-15 加旅游预设时新增，
 *   用来指娱乐时间里最接近这处的那一个场所。仍然没有任何 geo 含义。）
 */
/** Cover focal point in image percentages; absent means centered. Never a geographic position. */
export function normalizeCoverFocus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { x, y } = value;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return undefined;
  return { x, y };
}

/** Place edit time in milliseconds. Missing and invalid times are unknown (0). */
export function normalizeModifiedAt(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizePlace(raw, fallbackTerrain = '') {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id, 40);
  const name = text(raw.name, 40);
  // id 不安全（带路径、带 ..）就整条丢掉——这是会被拼进文件路径的东西。
  if (!isSafeId(id) || !name) return null;
  // 主人写「常去的」和写 `frequent` 等价；认不出的落 around（不丢这处地方）。
  const kind = normalizeKind(raw.kind) || 'around';
  const terrain = isTerrain(raw.terrain) ? raw.terrain : (isTerrain(fallbackTerrain) ? fallbackTerrain : '');
  const cover = coverName(raw.cover);
  const coverFocus = cover ? normalizeCoverFocus(raw.coverFocus) : undefined;
  return {
    id,
    name,
    aliases: textList(raw.aliases, 8, 30).filter((a) => a !== name),
    tags: normalizeTags(raw.tags),
    kind,
    desc: text(raw.desc, 400),
    style: text(raw.style, 160),
    cover,
    ...(coverFocus ? { coverFocus } : {}),
    scene: text(raw.scene, 40),
    funVenue: text(raw.funVenue, 40),
    frequent: raw.frequent === true,
    terrain,
    relations: normalizeRelations(raw.relations, id),
    modifiedAt: normalizeModifiedAt(raw.modifiedAt),
  };
}

/** `cover` 只存文件名，不存路径（防着有人手改状态文件往别处指）。 */
export function coverName(v) {
  const s = text(v, 160);
  if (!s) return '';
  // 去目录：`a/b/c.png` → `c.png`；`..\..\x.png` → `x.png`
  const base = s.split(/[\\/]/).pop() ?? '';
  return /^[\w.\-]+$/.test(base) ? base : '';
}

/**
 * 这处地点在生图素材库里有没有对应的场景名。
 *
 * 有 → 回执可以叫她「`scene` 填『X』」；
 * 没有 → 一个字都不提，免得她填了个库里没有的名字（那会提示「库里没找到」）。
 *
 * 判定和 `fun-world/src/venues.js` 的 `hasScene()` 逐字一致：**只看字符串非空**。
 * 本插件不读库，所以能力的上限就是「主人真把库里的正名填进 `scene`」。
 */
export function hasScene(place) {
  return typeof place?.scene === 'string' && place.scene.trim() !== '';
}

/**
 * 这处地点有没有登记「娱乐时间里最接近的那一处」。
 *
 * 和 `hasScene` 完全同构：**只看字符串非空**，不读 fun 的场所库、不猜。
 * 空 → 回执一个字都不提（绝不让她 `fun_go` 填一个 fun 不认识的词）。
 */
export function hasFunVenue(place) {
  return typeof place?.funVenue === 'string' && place.funVenue.trim() !== '';
}

/** 仅描写空间、陈设、配色和氛围；不预设人物或事件。 */
const TERRAIN_DESCRIPTIONS = Object.freeze({
  'forest-home': '圆拱木窗映着苔绿色墙面，矮桌和棉麻软垫围出温暖安静的小屋。',
  'forest-old-oak': '粗厚树干覆着灰绿苔藓，盘根间铺满褐色落叶，树冠下光影柔和。',
  'forest-creek': '浅青溪水映着碎银般的光，圆润卵石和深绿蕨叶构成清凉幽静的景致。',
  'forest-mushroom-slope': '赭褐土坡缀着乳白与砖红的菌伞，松针厚软，微湿的林色朦胧柔和。',
  'forest-clearing': '浅绿草地被浓密树冠围合，几截原木与细碎白花相衬，空气明净安宁。',
  'neighborhood-home': '奶油白墙面配浅木书柜，布艺沙发和暖黄台灯让客厅显得柔软舒适。',
  'neighborhood-bench': '深棕长椅嵌在灰砖庭院里，花盆和常绿灌木点出朴素安静的生活气息。',
  'neighborhood-store-front': '玻璃橱窗透着暖白灯光，蓝白遮棚下摆着整齐货架，门前明亮亲切。',
  'neighborhood-garden': '红砖花坛盛着粉白小花，墨绿矮篱围出整洁庭院，碎石铺面清爽宁静。',
  'neighborhood-stairwell': '米灰墙面衬着深绿扶手，磨石台阶和方形窗格保留着朴素沉静的质感。',
  'riverside-home': '浅蓝窗帘映着水色，藤椅与白木小桌相配，室内通透而清静。',
  'riverside-levee-steps': '青灰石阶带着细密水痕，栏杆呈暗铁色，开阔水面铺着淡银光泽。',
  'riverside-old-pier': '旧木平台呈烟褐色，粗绳与生锈铁环留着岁月纹理，水光沉静柔暗。',
  'riverside-reeds': '浅金芦苇簇成疏密有致的屏障，湿润滩石泛着灰白色，水面柔和朦胧。',
  'riverside-bollard': '圆钝石墩覆着浅灰斑驳纹理，麻绳盘在石面，蓝灰江水衬出清寂气氛。',
  'foothill-home': '石墙与深色木梁围出小屋，陶罐和格纹毯点缀其间，暖褐色调质朴安稳。',
  'foothill-trailhead': '苍绿山石与低矮灌木围出开阔缺口，木牌带着旧褐纹理，景致清朗沉静。',
  'foothill-spring': '清透泉池嵌在灰白岩壁间，翠绿苔痕与细小水纹相衬，氛围清凉澄净。',
  'foothill-pavilion': '暗红亭柱托着青灰瓦檐，石桌与木凳陈设简洁，疏淡山色带来安静空阔感。',
  'foothill-scree': '银灰碎石铺成粗粝坡面，赭色岩块和稀疏草簇相间，色调干净冷静。',
  'travel-seaside-town': '白墙小屋配海蓝窗框，露台摆着陶盆与藤椅，明亮天光让街巷清新松弛。',
  'travel-snow-inn': '深木护墙衬着乳白厚毯，铸铁壁炉与琥珀色灯罩令客栈温暖沉静。',
  'travel-old-town': '灰砖院墙围着青石铺地，旧木铺面挂着暗红灯笼，古朴色调柔和安静。',
  'travel-hot-spring': '浅木隔屏与灰石浴池相映，乳白蒸汽笼着暖黄灯光，空间柔润静谧。',
  'travel-camp': '米白帐篷围出疏朗营地，折叠木桌和珐琅杯陈设简洁，墨绿林色宁静柔和。',
});

/**
 * 一套地形要建的地点（初始化时只建一套；换地形只追加不删）。
 *
 * 默认返回空描写骨架；`{ withDescriptions: true }` 显式启用示例描写。
 * `style` / `scene` / `cover` 始终为空，`frequent` 为 false。
 * id 带地形前缀（`forest-home`），这样换地形追加时不会和上一套的 `home` 撞 id。
 */
export function terrainPlaces(terrainId, options = {}) {
  const terrain = findTerrain(terrainId);
  if (!terrain) return [];
  return terrain.places.map((p) => normalizePlace({
    id: `${terrain.id}-${p.slug}`,
    name: p.name,
    aliases: p.aliases,
    kind: p.kind,
    desc: options?.withDescriptions === true ? TERRAIN_DESCRIPTIONS[`${terrain.id}-${p.slug}`] : '',
    style: '',
    cover: '',
    scene: '',
    // 旅游预设预置一个「娱乐时间里最接近的那处」；其余地形留空。
    funVenue: p.funVenue ?? '',
    frequent: false,
    terrain: terrain.id,
    relations: [],
  }));
}

/**
 * 返回匹配候选，保持列表原序：明确 id > 正名或别名精确命中 > 包含匹配。
 * 正名与别名指向不同地点时同样需要澄清；调用方可展示候选的 id、名字和地形。
 * 返回原地点引用，不修改列表。空输入 / 无匹配返回 []。
 */
export function findPlaceCandidates(places, name) {
  const n = text(name, 60);
  const list = Array.isArray(places) ? places.filter((p) => p && typeof p.name === 'string') : [];
  if (!n) return [];
  const ids = list.filter((p) => p.id === n);
  if (ids.length) return ids;
  const aliasesOf = (p) => (Array.isArray(p.aliases) ? p.aliases : []).filter((a) => typeof a === 'string');
  const exact = list.filter((p) => p.name === n || aliasesOf(p).includes(n));
  if (exact.length) return exact;
  const lower = n.toLowerCase();
  return list.filter((p) => p.name.includes(n)
    || aliasesOf(p).some((a) => a.includes(n))
    || (p.name && n.includes(p.name))
    || (typeof p.id === 'string' && p.id.toLowerCase() === lower));
}

/** 仅唯一候选才返回地点；无匹配或有歧义均返回 null。 */
export function findPlace(places, name) {
  const candidates = findPlaceCandidates(places, name);
  return candidates.length === 1 ? candidates[0] : null;
}

/** 从 `name` 起一个不撞的 id（加地点时用；纯函数，靠传入的 existing 判重）。 */
export function slugFor(name, existing = []) {
  const taken = new Set((Array.isArray(existing) ? existing : []).map((p) => p?.id).filter(Boolean));
  const ascii = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = ascii || `place-${taken.size + 1}`;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 999; i += 1) {
    const next = `${base}-${i}`;
    if (!taken.has(next)) return next;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export default { TERRAINS, KIND_LABEL, KINDS };
