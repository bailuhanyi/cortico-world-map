/**
 * 小地图的配置段与文案。
 *
 * 段名是 `config.json` 的 `worlds.map`（world id 必须是 `map`——「鱼的每一天」那边的
 * `maplink` 只读 `worlds.map.enabled` 这一个布尔字段来决定要不要在「自己的时间」里
 * 加一行 `map_places → map_look`）。WebUI 热改就地写这个对象，World 每次用时现读，
 * 所以这里只有默认值与 schema，不持有副本。
 *
 * **刻意只有三项**（`MAP-小地图插件-方案.md` §6 定稿的正是这三项）：
 *   mapOn / mapImggenOn / mapStyleRef。
 *
 * 为什么没有「叫醒档位」这类键：这个 World **不自己推事件**（describe.events 是空数组）。
 * 她什么时候看地图，由「鱼的每一天」的 `maplink` 那一行顺手一提，或者她自己调 `map_places`。
 */

export const ID = 'map';

/**
 * 显示名。**已定稿：「鱼的小世界」**（2026-11-15 主人拍板）。
 *
 * 改名字要同时动三处，缺一处就会界面与包里对不上：
 *   1. 这里（`LABEL`，World 自己的 label 和 `envPromptVars` 的标题）；
 *   2. `package.json` 的 `cortico.displayName` + `cortico.locales.*.displayName`（市场读这个）；
 *   3. `dist/webui.js` 里的面板文案（客户端 bundle 不 import 服务端模块，另存了一份）。
 *
 * 英文名 `Little World` 不带撇号——`Fish's Every Day` 那次炸过 JS 单引号字符串，
 * `node --check` 直接 `SyntaxError`。
 */
export const LABEL = '鱼的小世界';

/** `worlds.map` 段的默认值；`enabled` 由框架的 World 开关管理。 */
export const DEFAULTS = Object.freeze({
  enabled: false,
  /** 总开关。关掉=不往提示词注入地点清单，工具与面板还在。 */
  mapOn: true,
  /**
   * 可选联动开关。关掉=纯文字 + 本地图，**绝不提 `imggen_draw`**，
   * 即使装了生图工作室也不提（方案 §4 三条触发条件里的第一条）。
   */
  mapImggenOn: true,
  /**
   * 「鱼的每一天」联动开关（2026-11-15 加）。
   *
   * 关掉=提示词里**一个字都不提** `feast_life_plan` / `feast_life_now`。
   * 和 `mapImggenOn` 同构：开关开着**还要** 读到 `worlds.feast.enabled === true`
   * **还要** 真有地点，那两句才出现——没装就整段不提，绝不指向不存在的工具。
   */
  mapFeastOn: true,
  /**
   * 「娱乐时间」联动开关（2026-11-15 加）。
   *
   * 关掉=不提 `fun_go` / `fun_places`。旅游地点那处「最接近的一处」那句话
   * 同样要三条全满足才出现（开关 + `worlds.fun.enabled` + `funVenue` 非空）。
   */
  mapFunOn: true,
  /**
   * 整图样式参考（方案 §4「选择 3 的可选加成」）。
   * **这一版只留字段不实现**——空=各地点用自己的 `style`。
   */
  mapStyleRef: '',
});

const ZH = {
  label: LABEL,
  lamp: '小地图',
  stopped: '未启动',
  badgePlaces: '地点',
  badgeCover: '有图',
  prompt: '小地图 World 的环境说明：这条鱼周围有哪些地点——家、常去的、附近的。每一处只有文字描写（空间、陈设、配色、光线、氛围）和一句画风锚点，可以配一张主人放的本地图；没有路线、没有坐标、没有距离、没有导航。不调别的 World 的工具、不读别人的状态。',
  config: {
    title: LABEL,
    mapOn: '开着',
    mapOnDesc: '总开关。关掉之后不往提示词里注入地点清单；工具和面板照旧可用，她随时能看。',
    mapImggenOn: '可以提生图',
    mapImggenOnDesc: '可选联动。关掉之后一律不提生图工作室、不提 scene，只给文字描写和主人放的图——即使装了生图工作室也不提。',
    mapFeastOn: '跟「鱼的每一天」对齐',
    mapFeastOnDesc: '开着时会提醒她写日程、说「此刻在哪」都用这些地点正名。关掉就一个字都不提鱼的每一天——即便装了也不提。',
    mapFunOn: '跟「娱乐时间」对齐',
    mapFunOnDesc: '旅游那几处会顺带提一句「想真去逛就填娱乐时间里最接近的那处」。关掉就不提娱乐时间——即便装了也不提。',
    mapStyleRef: '整图样式参考',
    mapStyleRefDesc: '留空=每个地点用自己的画风锚点。这一版只留了这个字段，暂时不影响回执。',
  },
  storage: {
    label: '地点记录',
    note: '清掉之后所有地点（文字描写、画风锚点、常去标记、主人放的图）都会没，回到「还没选地形」的空状态。不会动别的 World 的任何东西，也不动生图工作室的素材库。',
  },
};

const EN = {
  label: 'Little World',
  lamp: 'Little world',
  stopped: 'not running',
  badgePlaces: 'Places',
  badgeCover: 'Photos',
  prompt: 'The Little World world: the places around her — home, the ones she often goes to, the ones nearby. Each place is only words (space, furnishings, colours, light, mood) plus one fixed style line, optionally with a local photo the owner uploaded. No routes, no coordinates, no distances, no navigation. It never calls another world tools and never reads their state.',
  config: {
    title: 'Little World',
    mapOn: 'Enabled',
    mapOnDesc: 'Master switch. Off: no place list in the prompt; the tools and panel still work and she can look any time.',
    mapImggenOn: 'May mention image generation',
    mapImggenOnDesc: 'Optional link. Off: never mention the image studio or a scene name — only the written description and the owner photo, even when the image studio is installed.',
    mapFeastOn: 'Align with Fish Every Day',
    mapFeastOnDesc: 'When on, she is reminded to use these place names when writing her day and when saying where she is. Off: not a word about Fish Every Day, even when it is installed.',
    mapFunOn: 'Align with Fun time',
    mapFunOnDesc: 'Travel places mention the nearest place she can actually visit in Fun time. Off: nothing about Fun time, even when it is installed.',
    mapStyleRef: 'Whole-map style reference',
    mapStyleRefDesc: 'Empty means every place uses its own style line. The field exists this version but does not change any receipt yet.',
  },
  storage: {
    label: 'Place records',
    note: 'Clearing this erases every place (description, style line, frequent flag, owner photo) and goes back to "no terrain chosen yet". Nothing of any other world is touched, and the image studio library is never touched.',
  },
};

export function text(language = 'zh') {
  return language === 'en' ? EN : ZH;
}

/**
 * 面板自己的文案。
 *
 * 客户端产物（`dist/webui.js`）不 import 服务端模块，所以面板标题和说明
 * 这里给一份、bundle 里另存一份——改文案时两处一起改（feast / fun 也是这么做的）。
 */
export function panelText(language = 'zh') {
  if (language === 'en') {
    return {
      places: {
        title: 'Places',
        description: 'A wall of place cards: home, the ones she often goes to, the ones nearby. Edit the words, upload a photo, pin one as frequent, or start from a preset terrain.',
      },
    };
  }
  return {
    places: {
      title: '地点',
      description: '地点卡片墙：家、常去的、周围的。改文字描写、传一张本地图、标成「常去」，或者从一套预设地形开始。',
    },
  };
}

/** WebUI 的配置组；路径必须落在 `worlds.map.` 段内。 */
export function configGroup(language = 'zh') {
  const t = text(language).config;
  const K = `worlds.${ID}`;
  return {
    id: `world:${ID}`,
    owner: `world:${ID}`,
    schema: {
      type: 'object',
      title: t.title,
      properties: {
        [`${K}.mapOn`]: {
          type: 'boolean',
          title: t.mapOn,
          description: t.mapOnDesc,
          'x-hot': true,
        },
        [`${K}.mapImggenOn`]: {
          type: 'boolean',
          title: t.mapImggenOn,
          description: t.mapImggenOnDesc,
          'x-hot': true,
        },
        [`${K}.mapFeastOn`]: {
          type: 'boolean',
          title: t.mapFeastOn,
          description: t.mapFeastOnDesc,
          'x-hot': true,
        },
        [`${K}.mapFunOn`]: {
          type: 'boolean',
          title: t.mapFunOn,
          description: t.mapFunOnDesc,
          'x-hot': true,
        },
        [`${K}.mapStyleRef`]: {
          type: 'string',
          title: t.mapStyleRef,
          description: t.mapStyleRefDesc,
          'x-hot': true,
        },
      },
    },
  };
}
