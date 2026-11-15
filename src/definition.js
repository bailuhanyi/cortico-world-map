/**
 * WorldDefinition：默认配置、实例工厂和自描述。
 *
 * `create()` 必须保持纯：不读状态文件、不建目录、不启动定时器
 * （`test/world.test.mjs` 有一条钉住「create 之后目录还是空的」）。
 */
import { DEFAULTS, ID, LABEL } from './config.js';
import { MAP_TOOL_DECLS, MapWorld } from './world.js';

/** 自描述里每个工具配一句给人看的话，按工具名。 */
const TOOL_SUMMARIES = {
  map_places: {
    zh: '看周围有哪些地方：家、常去的、附近的、旅行的，按常去排前；可只看某一类。',
    en: 'See the places around her: home, the ones she often goes to, nearby and travel places; can filter by kind.',
  },
  map_look: {
    zh: '看某一处长什么样：文字描写、画风锚点、有没有图；装了生图且这处有场景名才递发图该填哪个 scene，旅游处还会提娱乐时间里最接近那处。',
    en: 'Look at one place: its written description, style line and whether it has a photo; names the image scene only when that place really has one, and for travel places the nearest venue in Fun time.',
  },
  map_add: {
    zh: '加一处地方：只填文字（名字、别名、归类、描写、画风），没有坐标也没有远近。',
    en: 'Add a place: words only (name, aliases, kind, description, style); no coordinates, no distances.',
  },
  map_edit: {
    zh: '改某一处的文字、画风、归类、是否常去、scene 正名、娱乐时间那处；只动传进来的那几项。',
    en: 'Edit one place: words, style, kind, frequent flag, scene name, nearest Fun time venue; only the fields passed in.',
  },
  map_cover: {
    zh: '换这处地方的本地图或清空；有图就锁着不自动变，清空之后主人才可以再放一张。',
    en: 'Swap or clear the local photo of one place; a photo stays put once set, and only the owner puts a new one.',
  },
  map_view: {
    zh: '整张小地图：按家 / 常去 / 周围 / 旅行分组铺开，纯展示，没有连线、没有路线、也没有行程。',
    en: 'The whole little map: grouped as home / frequent / around / travel, display only, no lines, no routes and no itinerary.',
  },
};

function describeTools(decls) {
  return decls.map(({ name, description, parameters, tags }) => ({
    name,
    description,
    parameters,
    tags,
    summary: TOOL_SUMMARIES[name],
  }));
}

export const mapDefinition = {
  id: ID,
  label: LABEL,
  /** `worlds.map` 段的默认值；启用与否由部署决定，定义里恒为 false。 */
  defaults: () => structuredClone(DEFAULTS),
  preflight: () => {
    if (typeof structuredClone !== 'function') throw new Error('小地图需要 Node 22+ 的 structuredClone。');
  },
  create: (ctx) => new MapWorld({
    cfg: ctx.cfg,
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    // 补齐配置段用：宿主的 /api/config 读的是落盘的 worlds.map（不做默认值合并）。
    persist: typeof ctx.persist === 'function' ? (patch) => ctx.persist(patch) : null,
  }),
  /**
   * 自描述：可能出现的全部工具与事件，不进提示词。
   *
   * **events 是空数组，这是有意的**——这个 World 不推任何事件。
   * 看地图的时机由「鱼的每一天」的 `maplink` 那一行顺手一提，或她自己 `map_places`。
   * 写成空数组也让认证那边一眼看得出它不主动打扰。
   */
  describe: {
    tools: describeTools(MAP_TOOL_DECLS),
    events: [],
  },
};

export default mapDefinition;
