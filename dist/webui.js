/**
 * 小地图面板的浏览器端（Coo WebUI 扩展面板）。
 *
 * 约定（照 fun-world / feed-world 的做法）：
 *   · 默认导出 `{ panels: { <panelId>: { mount(ctx) } } }`
 *   · 只往 `ctx.root` 里写 DOM，不碰 document.body
 *   · 数据一律走 `ctx.invoke(method, args)`，**不读私有状态、不算时间**
 *   · 定时器只用 `ctx.interval` / `ctx.timeout`（宿主会在面板关掉时 dispose）
 *
 * 样式：注入一个 <style> 到 ctx.root 里。宿主可能是普通 DOM 也可能是 shadow root，
 * 光靠外部 css 在 shadow root 里吃不到；注入 <style> 两边都成立。
 * 颜色走宿主主题的自定义属性（--surface/--foreground/--border/--accent…），
 * 自定义属性会继承进 shadow root，所以明暗两套主题都不用自己写。
 *
 * 面板：**一张地点卡片墙**。
 *   - 有 cover 的显示缩略图（`ctx.invoke('cover', {id})` 拿 base64 data URL），
 *     没图的显示那段文字描写；
 *   - 点卡片展开：改描写 / 改画风 / 改归类 / 标常去 / 传图 / 清空 / 删；
 *   - 顶部能选预设地形、加一处地方。
 *
 * **不画路线、不画连线、不按远近排序**：卡片只是按「常去 > 家 > 周围」分组铺开，
 * 这是展示顺序不是位置关系。界面里没有一个坐标输入框——这插件根本没有坐标。
 */

const CSS = `
.map{--m-line:var(--border,#e3e4e3);--m-ink:var(--foreground,#1b1a1e);--m-dim:var(--muted-foreground,#5c5c60);--m-card:var(--surface,#fbfbfb);--m-soft:color-mix(in srgb,var(--surface,#fbfbfb) 92%,var(--foreground,#1b1a1e));--m-accent:var(--accent,#00a870);--m-warm:#e0862f;font:13px/1.6 var(--sans,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif);color:var(--m-ink);padding:4px 2px 24px}
.map *{box-sizing:border-box}
.map-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.map input,.map select,.map textarea,.map button{font:inherit;color:inherit;background:var(--m-card);border:1px solid var(--m-line);border-radius:var(--radius-sm,6px);padding:5px 9px;outline:none}
.map input:focus,.map select:focus,.map textarea:focus{border-color:var(--m-accent)}
.map textarea{resize:vertical;min-height:52px;width:100%;line-height:1.5}
.map button{cursor:pointer;transition:background .12s,border-color .12s}
.map button:hover{border-color:var(--m-accent)}
.map button:focus-visible{outline:2px solid var(--m-accent);outline-offset:2px}
.map input,.map select{max-width:100%;min-width:0}
.map-card-name,.map-pick-meta{overflow-wrap:anywhere}
.map-btn-primary{background:var(--m-accent);border-color:var(--m-accent);color:#fff;font-weight:600}
.map-btn-primary:hover{filter:brightness(1.06)}
.map-btn-primary[disabled]{opacity:.55;cursor:default;filter:none}
.map-btn-danger{color:#d9534f;border-color:color-mix(in srgb,#d9534f 40%,var(--m-line))}
.map-dim{color:var(--m-dim)}
.map-sec{font-weight:600;margin:14px 0 7px;font-size:12px;letter-spacing:.04em;color:var(--m-dim)}
.map-sec:first-child{margin-top:2px}
.map-stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px;padding:9px 12px;border:1px solid var(--m-line);border-radius:var(--radius-sm,6px);background:var(--m-card)}
.map-stat b{display:block;font-size:17px;font-weight:600;line-height:1.25}
.map-stat span{font-size:11.5px;color:var(--m-dim)}

/* 卡片墙 */
.map-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(216px,100%),1fr));gap:9px;align-items:start}
.map-cell{display:flex;flex-direction:column;min-width:0}
/* 展开的那一格跨满整行：详情太窄会被挤成一条，读起来比原来更难受。 */
.map-cell-open{grid-column:1/-1}
.map-card{border:1px solid var(--m-line);border-radius:var(--radius-sm,6px);background:var(--m-card);cursor:pointer;transition:border-color .12s,background .12s;overflow:hidden;display:flex;flex-direction:column}
.map-card:hover{border-color:var(--m-accent)}
.map-card:focus-visible{outline:2px solid var(--m-accent);outline-offset:2px}
.map-card-active{border-color:var(--m-accent);background:color-mix(in srgb,var(--m-accent) 7%,var(--m-card));border-bottom-left-radius:0;border-bottom-right-radius:0}
.map-card-home{border-left:3px solid var(--m-accent)}
.map-card-freq{border-left:3px solid var(--m-warm)}
.map-thumb{display:block;width:100%;height:118px;object-fit:cover;background:var(--m-soft);border-bottom:1px solid var(--m-line)}
.map-card-body{padding:8px 11px 9px}
.map-card-head{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.map-card-name{font-weight:600;font-size:13.5px}
.map-card-arrow{font-size:11px;color:var(--m-dim);width:11px;text-align:center;flex:none}
.map-card-active .map-card-arrow{color:var(--m-accent)}
.map-card-desc{font-size:12px;color:var(--m-dim);margin-top:4px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.map-card-desc-empty{font-style:italic}
.map-card-foot{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;font-size:11.5px;color:var(--m-dim)}
.map-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.map-chip{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--m-line);background:var(--m-soft);color:var(--m-dim)}
.map-chip-on{color:var(--m-ink);border-color:var(--m-accent);background:color-mix(in srgb,var(--m-accent) 14%,transparent)}
.map-chip-warm{color:var(--m-ink);border-color:var(--m-warm);background:color-mix(in srgb,var(--m-warm) 14%,transparent)}
.map-chip-scene{color:var(--m-ink);border-color:var(--m-accent);background:color-mix(in srgb,var(--m-accent) 10%,transparent);font-size:11px}

/* 详情 */
.map-detail{border:1px solid var(--m-accent);border-top:none;border-radius:0 0 var(--radius-sm,6px) var(--radius-sm,6px);padding:10px 13px 12px;background:var(--m-card)}
.map-detail-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
.map-detail h4{margin:0;font-size:14px}
.map-detail p{margin:0 0 6px;font-size:12.5px}
.map-field{margin-bottom:8px}
.map-field label{display:block;font-size:11.5px;color:var(--m-dim);margin-bottom:3px}
.map-field-row{display:flex;gap:8px;flex-wrap:wrap}
.map-field-row>*{flex:1;min-width:min(130px,100%)}
.map-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;padding-top:9px;border-top:1px solid var(--m-line)}
.map-scene{font-size:12px;padding:5px 9px;border-radius:var(--radius-sm,6px);background:var(--m-soft);border:1px solid var(--m-line);margin:8px 0 0}
.map-scene b{font-weight:600}
.map-locked{font-size:11.5px;color:var(--m-dim);margin-top:5px}
.map-note{font-size:11.5px;color:var(--m-dim);margin-top:5px;line-height:1.5}
.map-import-item{border-top:1px solid var(--m-line);padding:8px 0;overflow-wrap:anywhere}
.map-import-item .map-bar{margin-bottom:2px}
.map-import-diff summary{cursor:pointer;color:var(--m-dim);font-size:12px}
.map-import-diff .map-note{white-space:pre-wrap;max-height:180px;overflow:auto}

.map-empty{padding:22px 12px;text-align:center;color:var(--m-dim);font-size:12.5px}
.map-err{border:1px solid #d9534f;border-radius:var(--radius-sm,6px);padding:10px 12px;color:#d9534f;background:color-mix(in srgb,#d9534f 10%,transparent);font-size:12.5px}
.map-msg{font-size:12px;padding:6px 10px;border-radius:var(--radius-sm,6px);margin-bottom:9px}
.map-msg-ok{border:1px solid var(--m-accent);background:color-mix(in srgb,var(--m-accent) 10%,transparent)}
.map-msg-bad{border:1px solid #d9534f;color:#d9534f;background:color-mix(in srgb,#d9534f 10%,transparent)}

/* 预设勾选表：点了地形先勾，不直接全加 */
.map-picker{border:1px solid var(--m-accent);border-radius:var(--radius-sm,6px);padding:10px 12px;margin-bottom:12px;background:var(--m-card)}
.map-picker-head{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;margin-bottom:8px}
.map-picker-head strong{font-size:13.5px}
.map-picker-head span{font-size:11.5px}
.map-pick-list{display:flex;flex-direction:column;gap:2px}
.map-pick{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border:1px solid transparent;border-radius:var(--radius-sm,6px);cursor:pointer}
.map-pick:hover{background:var(--m-soft)}
.map-pick:focus-visible{outline:2px solid var(--m-accent);outline-offset:1px}
/* 勾的记号自己画——不依赖原生 checkbox 的样子（真机上它没反馈，看着像没选中） */
.map-pick-glyph{flex:none;width:16px;text-align:center;font-size:13px;line-height:1.2;color:var(--m-dim)}
.map-pick-name{font-weight:600;font-size:12.5px;flex:none;min-width:72px;color:var(--m-dim)}
.map-pick-meta{font-size:11.5px;color:var(--m-dim)}
/* 选中：整行高亮 + 记号变绿加粗，扫一眼就知道勾了哪些 */
.map-pick-on{border-color:color-mix(in srgb,var(--m-accent) 45%,transparent);background:color-mix(in srgb,var(--m-accent) 9%,transparent)}
.map-pick-on .map-pick-glyph{color:var(--m-accent);font-weight:700}
.map-pick-on .map-pick-name{color:var(--m-ink);font-weight:700}
.map-pick-on .map-pick-meta{color:var(--m-ink)}
.map-pick-done{opacity:.5;cursor:default}
.map-pick-done:hover{background:transparent}
/* 「已经勾了哪几处」的摘要 */
.map-picked{font-size:11.5px;color:var(--m-dim);padding:5px 9px;margin:8px 0 6px;border-radius:var(--radius-sm,6px);background:var(--m-soft);border:1px solid var(--m-line);line-height:1.5}
.map-picked-on{color:var(--m-ink);border-color:color-mix(in srgb,var(--m-accent) 40%,var(--m-line))}

/* 地形：一排按钮（替代原先的 <select>，见 renderHead 里的注释） */
.map-terrains{display:flex;gap:6px;flex-wrap:wrap}
.map-terrain{border-radius:999px!important;padding:4px 11px!important;font-size:12.5px;white-space:nowrap}
.map-terrain-on{border-color:var(--m-accent)!important;background:color-mix(in srgb,var(--m-accent) 14%,var(--m-card))!important;font-weight:600}
`;

/** 面板自己的文案（服务端 config.js 的 panelText 另存一份，改文案时两处一起改）。 */
const T = {
  zh: {
    // 显示名：和 src/config.js 的 LABEL、package.json 的 cortico.displayName 必须一致
    // （`node tools/check-name.mjs` 钉住）。客户端 bundle 不 import 服务端模块，只能另存一份。
    title: '鱼的小世界',
    statsTotal: '处地方',
    statsCover: '张图',
    statsFreq: '处常去',
    terrain: '地形',
    terrainNone: '还没选地形',
    terrainPickHint: '＋ 选一套地形…',
    terrainNow: '当前',
    pickTitle: '挑要加哪几处',
    pickedLabel: '已勾 ',
    pickedNone: '还没勾任何一处——点下面的名字就能勾上。',
    pickAll: '全选',
    pickNone: '全不选',
    addOpen: '加一处',
    addCancel: '取消',
    addName: '叫什么',
    addKind: '归类',
    addDesc: '一句话描写（空间、陈设、配色、光线，不写她在干什么）',
    addStyle: '一句画风（以后出图都带上）',
    addSubmit: '加进去',
    emptyTitle: '小地图还是空的',
    emptyHint: '选一套地形、勾上要的那几处，就有空地方了，只改文字就行。',
    secFreq: '★ 常去',
    secHome: '家',
    secAround: '周围',
    secTravel: '旅行',
    noDesc: '还没写描写',
    detailDesc: '描写',
    detailStyle: '画风',
    detailAliases: '别名（逗号分开）',
    detailTags: '标签（逗号分开）',
    tagQuery: '查询标签',
    tagFilter: '筛选标签',
    allTags: '全部标签',
    cardsView: '卡片视图',
    relationsView: '关系视图',
    noRelations: '尚无关联，可在详情中添加。',
    missingTarget: '目标已不存在',
    completeness: '完整度（可选，不影响保存）',
    detailScene: '生图 scene 正名（主人知道库里有什么才填）',
    detailSceneEmpty: '留空就好——素材库里没有这处就不填，绝不编一个名字',
    detailFunVenue: '娱乐时间里最接近这处的那一个（想去逛才有得填）',
    detailFunVenueEmpty: '留空就好——填了才可能提「想真去逛去哪」，绝不替她编一个场所名',
    save: '存一下',
    frequentOn: '标成常去',
    frequentOff: '取消常去',
    upload: '传一张图',
    reupload: '换一张图',
    clearCover: '清空图',
    remove: '删掉这处',
    removeConfirm: '真的要删掉这处地方？描写和图都会没。',
    busy: '稍等…',
    saved: '存好了',
    uploaded: '图传上去了',
    cleared: '图清掉了',
    removed: '删掉了',
    noImage: '还在传…',
    sceneNone: '素材库里没有这处，生图时不用填 scene',
    bootNoRun: '小地图还没启动',
    uploadTooBig: '这张图太大了（上限 8 MiB）',
    uploadBadType: '只认 png / jpg / webp / gif',
    loadFail: '面板加载失败',
    renderFail: '画面刷新失败',
    retry: '重新载入',
    refresh: '刷新',
    refreshHint: '界面停在旧状态时点这个，不用重开 Coo',
  },
  en: {
    title: 'Little World',
    statsTotal: 'places',
    statsCover: 'photos',
    statsFreq: 'frequent',
    terrain: 'Terrain',
    terrainNone: 'no terrain yet',
    terrainPickHint: '+ Pick a terrain…',
    terrainNow: 'current',
    pickTitle: 'Pick the ones to add',
    pickedLabel: 'Selected ',
    pickedNone: 'Nothing selected yet — click a name below to tick it.',
    pickAll: 'Select all',
    pickNone: 'Select none',
    addOpen: 'Add a place',
    addCancel: 'Cancel',
    addName: 'Name',
    addKind: 'Kind',
    addDesc: 'One line of description (space, furnishings, colours, light — not what she is doing)',
    addStyle: 'One style line (kept for every future image)',
    addSubmit: 'Add it',
    emptyTitle: 'The little map is still empty',
    emptyHint: 'Pick a terrain, tick the ones you want, and you get empty places; just fill in the words.',
    secFreq: '★ Frequent',
    secHome: 'Home',
    secAround: 'Around',
    secTravel: 'Travel',
    noDesc: 'no description yet',
    detailDesc: 'Description',
    detailStyle: 'Style',
    detailAliases: 'Aliases (comma separated)',
     detailTags: 'Tags (comma separated)',
     tagQuery: 'Search tags',
     tagFilter: 'Filter tags',
     allTags: 'All tags',
     cardsView: 'Cards',
     relationsView: 'Relations',
     noRelations: 'No relations yet; add one in the details.',
     missingTarget: 'Target no longer exists',
     completeness: 'Completeness (optional; does not block saving)',
    detailScene: 'Image scene name (only if the owner knows the library has it)',
    detailSceneEmpty: 'Leave empty — if the library does not have this place, do not fill it and never invent a name',
    detailFunVenue: 'The nearest place in Fun time (only if she might really go)',
    detailFunVenueEmpty: 'Leave empty — fill it only if you want the visit hint, and never invent a venue name',
    save: 'Save',
    frequentOn: 'Mark as frequent',
    frequentOff: 'Unmark frequent',
    upload: 'Upload a photo',
    reupload: 'Replace photo',
    clearCover: 'Clear photo',
    remove: 'Delete this place',
    removeConfirm: 'Really delete this place? Its description and photo will be gone.',
    busy: 'Working…',
    saved: 'Saved',
    uploaded: 'Photo uploaded',
    cleared: 'Photo cleared',
    removed: 'Deleted',
    noImage: 'loading…',
    sceneNone: 'The library has no scene for this place, so leave scene empty',
    bootNoRun: 'The little map is not running',
    uploadTooBig: 'That image is too big (8 MiB max)',
    uploadBadType: 'Only png / jpg / webp / gif',
    loadFail: 'Panel failed to load',
    renderFail: 'This panel failed to redraw',
    retry: 'Reload',
    refresh: 'Refresh',
    refreshHint: 'Use this when the panel looks stuck; no need to restart Coo',
  },
};

/** 小工具：建元素 + 设属性，省掉一屏 createElement。 */
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'style') Object.assign(n.style, v);
      else n.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.appendChild(typeof kid === 'string' || typeof kid === 'number'
      ? document.createTextNode(String(kid)) : kid);
  }
  return n;
}

/** 只注入一次样式（同一 root 反复 mount 时别叠 <style>）。 */
function ensureStyle(root) {
  if (root.querySelector('style.map-style')) return;
  root.appendChild(el('style', { class: 'map-style', text: CSS }));
}

/**
 * 顶层容器。
 *
 * `aria-label` 用显示名：面板在宿主里可能被读屏/辅助工具取到，
 * 也让「这个名字到底有没有进产物」有据可查（tools/check-name.mjs 查的就是它）。
 */
function shell(root, title = '') {
  ensureStyle(root);
  const box = el('div', { class: 'map', ...(title ? { 'aria-label': title } : {}) });
  root.appendChild(box);
  return box;
}

const KIND_LABEL = { home: '家', frequent: '常去的', around: '周围', travel: '旅行' };

/** 从 data URL 猜 mime（面板只在选择文件时用一次）。 */
function mimeOf(file) {
  const t = String(file?.type ?? '');
  return /^image\/(png|jpeg|webp|gif)$/.test(t) ? t : '';
}

/** 把 File 读成 data URL。用 FileReader：宿主是浏览器，不引 node 的东西。 */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ''));
    fr.onerror = () => reject(fr.error ?? new Error('读不出来'));
    fr.readAsDataURL(file);
  });
}

/** 确认框：宿主不提供 ctx.confirm（feed-world 用的是 window.confirm），所以两条都试。 */
async function askConfirm(ctx, message) {
  if (typeof ctx?.confirm === 'function') {
    try { return Boolean(await ctx.confirm(message)); } catch { /* 落到 window 那条 */ }
  }
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return window.confirm(message);
  }
  // 都没有（极简宿主 / 测试桩）：不拦——但这个按钮删的是主人自己建的地方，
  // 所以这里宁可让操作失败也不静默删掉，交给服务端报错。
  return true;
}

function mountPlaces(ctx) {
  const root = ctx.root;
  const language = ctx.language === 'en' ? 'en' : 'zh';
  const t = T[language];

  const state = {
    data: null,
    expanded: null,
    query: '',
    filter: 'all',
    tagQuery: '',
    tagFilter: '',
    view: 'cards',
    draftsLoaded: false,
    restoredDrafts: null,
    draftTimer: null,
    adding: false,
    busy: '',
    message: null,
    // 勾选表：选了哪套地形、勾了哪些骨架 id。
    // `pickedFor` 记住上次是哪套，换地形就重置勾选（默认全选「还没加进来的」）。
    terrainPick: '',
    picked: null,
    pickedFor: '',
    // 每处的图片 data URL 缓存：只在第一次展开/首次渲染时取一次，
    // 免得一分钟刷新一次就把每张图重新 base64 一遍。
    covers: new Map(),
    drafts: new Map(),
    withDescriptions: false,
    loadVersion: 0,
    pending: new Set(),
    conflicts: new Map(),
    baseRevisions: new Map(),
  };

  root.replaceChildren();
  const box = shell(root, t.title);
  const head = el('div');
  const body = el('div');
  box.appendChild(head);
  box.appendChild(body);

  const setMessage = (text, ok = true) => {
    state.message = text ? { text, ok } : null;
  };

  const call = async (method, args) => {
    const mutating = method !== 'list' && method !== 'cover';
    const key = `${method}:${args?.[0]?.id ?? ''}`;
    if (mutating) {
      if (state.pending.has(key)) throw new Error(t.busy);
      state.pending.add(key);
      ++state.loadVersion;
    }
    try {
      const r = await ctx.invoke(method, args ?? []);
      if (r && r.ok === false) {
        const error = new Error(r.error ?? (r.conflict ? '地点已被其他操作修改，请处理冲突后再保存' : '返回不正常'));
        error.conflict = r.conflict;
        error.current = r.current;
        throw error;
      }
      return r;
    } finally {
      if (mutating) {
        state.pending.delete(key);
        ++state.loadVersion;
      }
    }
  };

  // Keep only changed fields; untouched fields can follow fresh server data.
  const forms = new Map();
  const persistDrafts = () => {
    if (!state.draftsLoaded) return;
    if (state.draftTimer) clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(() => {
      const drafts = [...state.drafts].map(([id, fields]) => ({ id, fields }));
      Promise.resolve(ctx.invoke('saveDrafts', [{ drafts }])).catch(() => {});
    }, 350);
  };
  function applyDrafts(drafts) {
    state.drafts.clear();
    for (const item of drafts ?? []) if (item && typeof item.id === 'string' && item.fields && typeof item.fields === 'object') state.drafts.set(item.id, { ...item.fields });
    state.draftsLoaded = true;
    state.restoredDrafts = [...state.drafts.keys()];
  }
  function captureDraft(key) {
    const form = forms.get(key);
    if (!form) return;
    const draft = { ...state.drafts.get(key) };
    for (const [field, node] of Object.entries(form.nodes)) {
      if (node.value !== form.values[field]) draft[field] = node.value;
      form.values[field] = node.value;
    }
    if (Object.keys(draft).length) state.drafts.set(key, draft);
    persistDrafts();
  }
  function bindDraft(key, nodes) {
    const draft = state.restoredDrafts?.includes(key) ? {} : (state.drafts.get(key) ?? {});
    const values = {};
    for (const [field, node] of Object.entries(nodes)) {
      if (Object.hasOwn(draft, field)) node.value = draft[field];
      values[field] = node.value;
      const capture = () => captureDraft(key);
      node.addEventListener('input', capture);
      node.addEventListener('change', capture);
    }
    forms.set(key, { nodes, values });
  }
  function clearSavedDraft(key, submitted) {
    captureDraft(key);
    const draft = { ...state.drafts.get(key) };
    for (const [field, value] of Object.entries(submitted)) {
      if (draft[field] === value) delete draft[field];
    }
    if (Object.keys(draft).length) state.drafts.set(key, draft);
    else state.drafts.delete(key);
    persistDrafts();
  }
  const formValues = (key) => {
    captureDraft(key);
    return { ...forms.get(key)?.values };
  };
  function clearAllDrafts() {
    forms.clear();
    state.drafts.clear();
    state.restoredDrafts = null;
    if (state.draftTimer) clearTimeout(state.draftTimer);
    state.draftTimer = null;
    state.draftsLoaded = false;
  }

  /** 取/缓一处地方的图。失败就当没图——面板不能因为一张图挂掉。 */
  const coverOf = async (id) => {
    if (state.covers.has(id)) return state.covers.get(id);
    const version = state.loadVersion;
    try {
      const r = await call('cover', [{ id }]);
      if (version !== state.loadVersion || ctx.signal?.aborted) return '';
      const url = r?.dataUrl ?? '';
      state.covers.set(id, url);
      return url;
    } catch {
      if (version !== state.loadVersion || ctx.signal?.aborted) return '';
      state.covers.set(id, '');
      return '';
    }
  };

  // -------------------------------------------------------------------------
  // 顶部：统计 + 地形选择 + 加一处
  // -------------------------------------------------------------------------

  let activeTransfer = null;
  function transferControls() {
    // Redraws must not replace the locked controls while an import is writing.
    if (activeTransfer?.writing) return activeTransfer.panel;
    const panel = el('div', { class: 'map-picker map-transfer' });
    const transfer = { panel, writing: false };
    activeTransfer = transfer;
    const status = el('div');
    const fileInput = el('input', { type: 'file', accept: 'application/json,.json', 'aria-label': '导入 JSON' });
    const mode = el('select', { 'aria-label': '导入模式' },
      el('option', { value: 'skip', text: '相同地点跳过' }),
      el('option', { value: 'merge', text: '合并更新（本地优先，只补空白）' }),
      el('option', { value: 'overwrite', text: '相同地点覆盖' }));
    mode.value = 'merge';
    let bundle = null;
    let decisions = null;
    let preview = null;
    let previewItems = [];
    let previewVersion = 0;
    let readVersion = 0;
    const isActive = () => activeTransfer === transfer && !ctx.signal?.aborted;
    const invalidatePreview = () => {
      ++previewVersion;
      preview = null;
      importButton.disabled = true;
      status.replaceChildren();
    };
    const showError = (err) => {
      invalidatePreview();
      status.replaceChildren(el('div', { class: 'map-err', text: String(err?.message ?? err) }));
    };
    const makePreview = async () => {
      if (!isActive() || transfer.writing) return;
      invalidatePreview();
      if (!bundle) return;
      const version = previewVersion;
      const captured = { bundle, mode: mode.value, ...(decisions ? { decisions: decisions.map((item) => ({ ...item })) } : {}) };
      status.replaceChildren(el('div', { class: 'map-note', text: '正在预览…' }));
      try {
        const result = await ctx.invoke('previewImport', [captured]);
        if (!isActive() || version !== previewVersion) return;
        const response = Array.isArray(result) ? result[0] : result;
        if (response?.ok === false) throw new Error(response.error ?? '预览失败');
        if (!response || typeof response !== 'object') throw new Error('预览结果格式不正确');
        const summary = response.summary ?? response;
        preview = { ...captured, expectedRevision: response.expectedRevision };
        previewItems = Array.isArray(response.items) ? response.items : [];
        const labels = { added: '新增', updated: '更新', skipped: '跳过', conflicts: '冲突', warnings: '提醒' };
        const counts = Object.keys(labels);
        const details = counts.map((key) => `${labels[key]}: ${Array.isArray(summary[key]) ? summary[key].length : (summary[key] ?? 0)}`);
        status.replaceChildren(
          el('div', { class: 'map-note', text: details.join(' · ') }),
          el('div', { class: 'map-note', text: captured.decisions
            ? '按逐项选择处理，未勾选的地点跳过；合并以本地优先，只补空白，覆盖会替换该地点内容。请查看最终取舍，确认后才会写入。'
            : captured.mode === 'merge'
              ? '合并更新以本地优先，只补空白，冲突保留本地内容；同 id 异名跳过，已有图片永不覆盖。不新增地点，不改变常去状态或当前住所。新地点可勾选或选择“导入新地点”。确认后才会写入。'
              : '确认后才会写入。名称相同但地点标识不同的记录会跳过，请查看冲突说明。' }),
          ...counts.filter((key) => Array.isArray(summary[key]) && summary[key].length).map((key) =>
            el('div', { class: 'map-note', text: `${labels[key]}: ${summary[key].map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('；')}` })));
        const fieldLabels = { id: '地点标识', name: '名称', desc: '描写', style: '画风', kind: '归类', tags: '标签', aliases: '别名', scene: '场景', funVenue: '娱乐地点', frequent: '常去', cover: '图片', homeId: '当前住所', terrain: '地形', relations: '地点关联', createdAt: '创建时间', updatedAt: '更新时间' };
        const valueText = (value) => value === null || value === undefined || value === '' ? '（空）' : typeof value === 'boolean' ? (value ? '是' : '否') : typeof value === 'object' ? JSON.stringify(value) : String(value);
        // Each re-preview captures a complete decision list; absent/unchecked items never add places.
        const choices = new Map(previewItems.map((item) => [item.id, {
          selected: item.action === 'added' || item.action === 'updated',
          mode: item.mode === 'skip' ? 'skip' : (item.mode ?? captured.mode),
        }]));
        const updateChoice = (id, selected, itemMode) => {
          if (!isActive() || transfer.writing || version !== previewVersion) return;
          choices.set(id, { selected, mode: itemMode });
          decisions = previewItems.map((item) => {
            const choice = choices.get(item.id);
            return { id: item.id, mode: choice.selected ? choice.mode : 'skip' };
          });
          void makePreview();
        };
        for (const item of previewItems) {
          const choice = choices.get(item.id);
          const checkbox = el('input', { type: 'checkbox', 'aria-label': `选择导入：${item.name}` });
          checkbox.checked = choice.selected;
          const handling = el('select', { 'aria-label': `处理方式：${item.name}` },
            el('option', { value: 'skip', text: '跳过' }),
            el('option', { value: 'merge', text: '合并（本地优先）' }),
            el('option', { value: 'overwrite', text: item.localName ? '覆盖' : '导入新地点' }));
          handling.value = choice.mode;
          checkbox.addEventListener('change', () => updateChoice(item.id, checkbox.checked,
            checkbox.checked && !item.localName ? 'overwrite' : checkbox.checked && handling.value === 'skip' ? (captured.mode === 'skip' ? 'merge' : captured.mode) : handling.value));
          handling.addEventListener('change', () => updateChoice(item.id, handling.value !== 'skip', handling.value));
          const row = el('div', { class: 'map-import-item' },
            el('div', { class: 'map-bar' }, checkbox, el('span', { text: `${item.name}${item.localName && item.localName !== item.name ? `（本地：${item.localName}）` : ''} · ${labels[item.action] ?? item.action}` }), handling));
          const diff = el('details', { class: 'map-import-diff' }, el('summary', { text: '查看差异与最终取舍' }));
          for (const conflict of item.conflicts ?? []) diff.appendChild(el('div', { class: 'map-note', text: `冲突：${conflict}` }));
          for (const change of item.changes ?? []) diff.appendChild(el('div', { class: 'map-note', text: `${fieldLabels[change.field] ?? change.field}${change.changed ? '（将修改）' : '（保留）'}：本地 ${valueText(change.local)}；备份 ${valueText(change.incoming)}；最终 ${valueText(change.result)}` }));
          row.appendChild(diff);
          status.appendChild(row);
        }
        importButton.disabled = false;
      } catch (err) {
        if (isActive() && version === previewVersion) showError(err);
      }
    };

    const importButton = el('button', {
      class: 'map-import-button map-btn-primary', type: 'button', disabled: 'disabled', text: '确认导入',
      onclick: async () => {
        if (!isActive() || !preview || transfer.writing) return;
        const submitted = preview;
        transfer.writing = true;
        fileInput.disabled = true;
        mode.disabled = true;
        recoveryButton.disabled = true;
        ++recoveryVersion;
        recoveryPreview = null;
        recoveryStatus.replaceChildren();
        invalidatePreview();
        status.replaceChildren(el('div', { class: 'map-note', text: '正在导入…' }));
        try {
          await call('import', [submitted]);
          bundle = null;
          fileInput.value = '';
          state.covers.clear();
          setMessage('导入成功', true);
          await load();
          status.replaceChildren(el('div', { class: 'map-note', text: '导入成功' }));
        } catch (err) {
          if (isActive()) showError(err);
        } finally {
          transfer.writing = false;
          fileInput.disabled = false;
          mode.disabled = false;
          if (isActive()) await readRecovery();
        }
      },
    });
    const recoveryStatus = el('div');
    let recoveryVersion = 0;
    let recoveryPreview = null;
    const recoveryButton = el('button', { type: 'button', text: '预览恢复上次导入前', disabled: 'disabled', onclick: async () => {
      if (!isActive() || transfer.writing) return;
      const version = ++recoveryVersion;
      recoveryPreview = null;
      recoveryStatus.replaceChildren(el('div', { class: 'map-note', text: '正在预览恢复…' }));
      try {
        const response = await ctx.invoke('previewRestore', []);
        if (!isActive() || version !== recoveryVersion) return;
        if (!response || response.ok === false) throw new Error(response?.error ?? '恢复预览失败');
        recoveryPreview = { expectedRevision: response.expectedRevision };
        const summary = response.summary;
        const confirmRestore = el('button', { type: 'button', class: 'map-btn-danger', text: '确认恢复导入前状态', onclick: async () => {
          if (!isActive() || transfer.writing || !recoveryPreview || version !== recoveryVersion) return;
          const submitted = { ...recoveryPreview };
          recoveryPreview = null;
          ++recoveryVersion;
          transfer.writing = true;
          confirmRestore.disabled = true;
          recoveryButton.disabled = true;
          fileInput.disabled = true;
          mode.disabled = true;
          ++readVersion;
          invalidatePreview();
          try {
            await call('restore', [submitted]);
            bundle = null;
            decisions = null;
            fileInput.value = '';
            state.covers.clear();
            setMessage('已恢复到最近一次导入前', true);
            await load();
            recoveryStatus.replaceChildren(el('div', { class: 'map-note', text: '恢复成功' }));
          } catch (err) {
            if (isActive()) recoveryStatus.replaceChildren(el('div', { class: 'map-err', text: String(err?.message ?? err) }));
          } finally {
            transfer.writing = false;
            fileInput.disabled = false;
            mode.disabled = false;
            if (isActive()) await readRecovery();
          }
        } });
        recoveryStatus.replaceChildren(
          el('div', { class: 'map-note', text: `恢复影响：${summary.beforeCount} 处 → ${summary.afterCount} 处；移除：${summary.removed.join('、') || '无'}；恢复：${summary.restored.join('、') || '无'}。确认后才会恢复。` }), confirmRestore);
      } catch (err) {
        if (isActive() && version === recoveryVersion) recoveryStatus.replaceChildren(el('div', { class: 'map-err', text: String(err?.message ?? err) }));
      }
    } });
    const recoveryInfo = el('div', { class: 'map-note', text: '正在读取恢复点…' });
    const readRecovery = async () => {
      const version = ++recoveryVersion;
      recoveryPreview = null;
      try {
        const info = await ctx.invoke('recoveryInfo', []);
        if (!isActive() || version !== recoveryVersion || transfer.writing) return;
        if (!info || info.ok === false) throw new Error(info?.error ?? '无法读取恢复点');
        recoveryButton.disabled = !info.available || info.canRestore === false;
        recoveryInfo.textContent = info.available
          ? `最近一次导入前恢复点${info.createdAt ? `（${info.createdAt}）` : ''}${info.total !== undefined ? `，${info.total} 处地点` : ''}。${info.canRestore === false ? `${info.reason ?? '导入后存在编辑，无法一键恢复'}。可先导出当前备份。` : '先预览影响，再明确确认恢复；导入后如有编辑将无法一键恢复，可导出当前备份。'}`
          : '暂无导入恢复点。成功导入后会保留最近一次导入前恢复点。';
      } catch (err) {
        if (isActive() && version === recoveryVersion) {
          recoveryButton.disabled = true;
          recoveryInfo.textContent = String(err?.message ?? err);
        }
      }
    };
    fileInput.addEventListener('change', async () => {
      if (!isActive() || transfer.writing) return;
      const version = ++readVersion;
      bundle = null;
      decisions = null;
      invalidatePreview();
      const file = fileInput.files?.[0];
      if (!file) return;
      if (file.size > 64 * 1024 * 1024) { showError(new Error('导入文件不能超过 64 MiB')); return; }
      status.replaceChildren(el('div', { class: 'map-note', text: '正在读取文件…' }));
      try {
        const text = typeof file.text === 'function' ? await file.text() : await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
          reader.readAsText(file);
        });
        if (!isActive() || version !== readVersion) return;
        bundle = JSON.parse(text);
        await makePreview();
      } catch (err) {
        if (isActive() && version === readVersion) showError(err);
      }
    });
    fileInput.addEventListener('cancel', () => {
      if (!isActive() || transfer.writing) return;
      ++readVersion;
      bundle = null;
      decisions = null;
      invalidatePreview();
    });
    mode.addEventListener('change', () => { decisions = null; void makePreview(); });
    panel.appendChild(el('div', { class: 'map-bar' },
      el('button', { type: 'button', text: '导出 JSON', onclick: async () => {
        try {
          const result = await ctx.invoke('export', []);
          if (result && result.ok === false) throw new Error(result.error ?? '导出失败');
          const payload = result?.bundle ?? result;
          const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
          const link = el('a', { href: url, download: 'map-world.json' });
          link.click();
          ctx.timeout?.(() => URL.revokeObjectURL(url), 1000);
          status.replaceChildren(el('div', { class: 'map-note', text: '已导出' }));
        } catch (err) { showError(err); }
      } }), fileInput, mode, importButton));
    panel.appendChild(status);
    panel.appendChild(recoveryInfo);
    panel.appendChild(recoveryButton);
    panel.appendChild(recoveryStatus);
    void readRecovery();
    return panel;
  }

  function renderHead() {
    const d = state.data;
    captureDraft('new');
    forms.delete('new');
    head.replaceChildren();
    if (d.storageWarning) head.appendChild(el('div', { class: 'map-msg map-msg-bad', text: d.storageWarning }));
    if (state.message) {
      head.appendChild(el('div', { class: `map-msg ${state.message.ok ? 'map-msg-ok' : 'map-msg-bad'}`, text: state.message.text }));
    }
    if (state.restoredDrafts?.length) {
      head.appendChild(el('div', { class: 'map-msg map-msg-bad' },
        el('span', { text: `检测到 ${state.restoredDrafts.length} 份未保存草稿。` }),
        el('button', { type: 'button', text: '恢复草稿', onclick: () => { state.restoredDrafts = null; state.expanded = [...state.drafts.keys()].find((id) => id !== 'new') ?? null; state.adding = state.drafts.has('new'); render(); } }),
        el('button', { type: 'button', text: '丢弃草稿', onclick: async () => { clearAllDrafts(); await ctx.invoke('saveDrafts', [{ drafts: [] }]); state.draftsLoaded = true; render(); } })));
    }

    head.appendChild(el('div', { class: 'map-stats' },
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.total) }), el('span', { text: t.statsTotal })),
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.withCover) }), el('span', { text: t.statsCover })),
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.frequent) }), el('span', { text: t.statsFreq }))));

    const bar = el('div', { class: 'map-bar' });

    // 地形：**一排按钮**，不用 <select>。
    //
    // 为什么换掉下拉（2026-11-15 两次真机反馈「点不动」）：
    //   ① 占位项的文字原本是「当前地形名」，值是空串——看着像已选中，点它什么都不发生；
    //   ② 更关键：`<select>` 依赖 `change`/`input` 事件，在内嵌 webview 里并不可靠，
    //      出过「选了没反应」后完全无从排查。按钮的 `click` 没有这层不确定性。
    // 现在每套地形是一个明确的按钮，点一下就是「我要加这一套」。
    const terrainRow = el('div', { class: 'map-terrains' });
    for (const x of d.terrains) {
      const partial = x.skeletons?.some((s) => s.exists) ? ' ·部分已加' : '';
      const active = state.terrainPick === x.id;
      terrainRow.appendChild(el('button', {
        type: 'button',
        class: active ? 'map-terrain map-terrain-on' : 'map-terrain',
        title: `${x.label}：${x.count} 处${partial}${x.note ? ' · ' + x.note : ''}`,
        text: `${active ? '▾' : '＋'} ${x.label}`,
        onclick: () => { chooseTerrain(x.id); },
      }));
    }
    bar.appendChild(terrainRow);

    if (d.terrainLabel) {
      bar.appendChild(el('span', { class: 'map-chip', text: `${t.terrainNow}：${d.terrainLabel}` }));
    }

    bar.appendChild(el('button', {
      class: state.adding ? '' : 'map-btn-primary',
      type: 'button',
      text: state.adding ? t.addCancel : t.addOpen,
      onclick: () => { state.adding = !state.adding; render(); },
    }));

    // 手动刷新：万一界面停在旧状态（宿主没刷新、或我们某次渲染出错），
    // 不用重开 Coo 也能自愈。这类「点不动」最后多半是这个救回来的。
    bar.appendChild(el('button', {
      type: 'button',
      text: t.refresh,
      title: t.refreshHint,
      onclick: () => { state.terrainPick = ''; state.picked = null; state.message = null; void load(); },
    }));

    head.appendChild(bar);

    const search = el('input', {
      type: 'search', placeholder: '搜索名称、别名、地形', 'aria-label': '搜索名称、别名、地形',
      value: state.query ?? '',
      oninput: (ev) => { state.query = ev.target.value; renderBody(); },
    });
    const filter = el('select', { 'aria-label': '筛选地点', onchange: (ev) => { state.filter = ev.target.value; renderBody(); } },
      el('option', { value: 'all', text: '全部' }),
      el('option', { value: 'noDesc', text: '缺描写' }),
      el('option', { value: 'noCover', text: '缺图' }),
      el('option', { value: 'frequent', text: '常去' }));
    filter.value = state.filter ?? 'all';
    const tagSearch = el('input', { type: 'search', placeholder: t.tagQuery, 'aria-label': t.tagQuery,
      value: state.tagQuery ?? '', oninput: (ev) => { state.tagQuery = ev.target.value; renderBody(); } });
    const allTags = [...new Set(d.places.flatMap((p) => Array.isArray(p.tags) ? p.tags : []))].sort((a, b) => a.localeCompare(b));
    const tagFilter = el('select', { class: 'map-tag-filter', 'aria-label': t.tagFilter, onchange: (ev) => { state.tagFilter = ev.target.value; renderBody(); } },
      el('option', { value: '', text: t.allTags }), ...allTags.map((tag) => el('option', { value: tag, text: tag })));
    tagFilter.value = state.tagFilter ?? '';
    const view = el('select', { class: 'map-view', 'aria-label': '视图', onchange: (ev) => { state.view = ev.target.value; renderBody(); } },
      el('option', { value: 'cards', text: t.cardsView }), el('option', { value: 'relations', text: t.relationsView }));
    view.value = state.view ?? 'cards';
    head.appendChild(el('div', { class: 'map-bar' }, search, filter, tagSearch, tagFilter, view));
    head.appendChild(transferControls());

    if (state.terrainPick) head.appendChild(picker(state.terrainPick));
    if (state.adding) head.appendChild(addForm());
  }

  /**
   * 选了一套地形。
   *
   * 空值**不改动**任何状态——不能因为它把已经展开的勾选表收掉。
   */
  function chooseTerrain(id) {
    const next = typeof id === 'string' ? id.trim() : '';
    if (!next) return;
    state.terrainPick = next;
    state.picked = null; // 换地形就重置勾选（默认全选，见 picker）
    render();
  }

  /**
   * 预设勾选表：**点了地形不等于全加**，先让你勾。
   *
   * 默认全选（2026-11-15 定），已经有的那几处置灰、不可勾——重复点不会变成两份。
   * 一条都不勾时「加进去」按钮置灰，不会静默什么都不做。
   */
  function picker(terrainId) {
    const d = state.data;
    const t2 = d.terrains.find((x) => x.id === terrainId);
    if (!t2) return el('div');
    // 服务端没给骨架（老版本 / 老面板配新端口）时，别把 null.filter 抛到 render 里去，
    // 那会让整个面板变成「点不动」。给一句能读懂的话。
    const skeletons = Array.isArray(t2.skeletons) ? t2.skeletons : null;
    if (!skeletons) {
      return el('div', { class: 'map-err', text: '这一版面板读不到预设清单（服务端版本对不上？）——重启 Coo 再试。' });
    }

    // 这套已经全在图上：直接说清楚，不给一张全是灰的、点不动的表。
    const pending = skeletons.filter((s) => !s.exists);
    if (!pending.length) {
      return el('div', { class: 'map-picker' },
        el('div', { class: 'map-picker-head' },
          el('strong', { text: `${t2.label}：都已在图上` }),
          el('span', { class: 'map-dim', text: '要加别的地方就换一套地形，或者点「加一处」自己写。' })),
        el('div', { class: 'map-pick-list' },
          skeletons.map((s) => el('label', { class: 'map-pick map-pick-done' },
            el('span', { class: 'map-pick-name', text: s.name }),
            el('span', { class: 'map-pick-meta', text: `［${s.kindLabel}］· 已经有了` })))),
        el('div', { class: 'map-actions' },
          el('button', {
            type: 'button',
            text: t.addCancel,
            onclick: () => { state.terrainPick = ''; state.picked = null; render(); },
          })));
    }

    // 换地形时重置：默认全选「还没加进来的」那几处。
    if (!state.picked || state.pickedFor !== terrainId) {
      state.pickedFor = terrainId;
      state.picked = new Set(pending.map((s) => s.id));
    }
    const picked = state.picked;

    /** 勾/取消一处，然后**整块重画**——让「看到的样子」永远等于 picked 里的事实。 */
    const toggle = (id) => {
      if (picked.has(id)) picked.delete(id); else picked.add(id);
      render();
    };

    // 选中的那几处，用来写摘要和画勾。
    const pickedNames = pending.filter((s) => picked.has(s.id)).map((s) => s.name);

    const rows = skeletons.map((s) => {
      const already = s.exists;
      const on = !already && picked.has(s.id);
      const glyph = already ? '·' : (on ? '✓' : '○');
      const alias = s.aliases.length ? `（也叫 ${s.aliases.slice(0, 3).join('、')}）` : '';
      const fun = s.funVenue ? ` · 娱乐时间里最接近「${s.funVenue}」` : '';
      const cls = ['map-pick'];
      if (already) cls.push('map-pick-done');
      else if (on) cls.push('map-pick-on');
      return el('div', {
        class: cls.join(' '),
        role: already ? null : 'button',
        tabindex: already ? null : '0',
        'aria-pressed': already ? null : (on ? 'true' : 'false'),
        onclick: already ? null : () => toggle(s.id),
        onkeydown: already ? null : (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
            ev.preventDefault?.();
            toggle(s.id);
          }
        },
      },
      // 勾的记号自己画：不依赖原生 checkbox 的样子（真机上它没反馈，看着像没选中）。
      el('span', { class: 'map-pick-glyph', text: glyph }),
      el('span', { class: 'map-pick-name', text: s.name }),
      el('span', { class: 'map-pick-meta', text: `${alias}［${s.kindLabel}］${fun}${already ? ' · 已经有了' : ''}` }));
    });

    // 摘要：一眼看出「已经勾了哪几处」。没有它，勾没勾全看不出来。
    const summary = pickedNames.length
      ? `${t.pickedLabel}${pickedNames.length} 处：${pickedNames.join('、')}`
      : t.pickedNone;

    const countLabel = el('span', { text: `${t.addSubmit}（${picked.size} 处）` });
    const submit = el('button', {
      class: 'map-btn-primary',
      type: 'button',
      disabled: picked.size === 0 ? 'disabled' : null,
      onclick: async () => {
        if (submit.disabled) return;
        const ids = [...picked];
        submit.disabled = true;
        submit.textContent = t.busy;
        try {
          const r = await call('terrain', [{ id: terrainId, ids, withDescriptions: state.withDescriptions }]);
          if (state.terrainPick === terrainId && state.picked === picked) {
            state.terrainPick = '';
            state.picked = null;
          }
          setMessage(r.added?.length ? `加了：${r.added.join('、')}` : '这几处本来就在地图里了', true);
          await load();
        } catch (err) {
          setMessage(String(err?.message ?? err), false);
          render();
        }
      },
    });
    submit.appendChild(countLabel);

    return el('div', { class: 'map-picker' },
      el('div', { class: 'map-picker-head' },
        el('strong', { text: `${t.pickTitle}：${t2.label}` }),
        el('span', { class: 'map-dim', text: t2.note })),
      // 摘要放在列表**上面**：先说「现在勾了哪几处」，再看清单。
      el('div', { class: pickedNames.length ? 'map-picked map-picked-on' : 'map-picked', text: summary }),
      el('label', { class: 'map-note' },
        el('input', { type: 'checkbox', checked: state.withDescriptions,
          'aria-label': language === 'en' ? 'Use example descriptions' : '使用示例描写',
          onchange: (ev) => { state.withDescriptions = Boolean(ev.target.checked); } }),
        language === 'en' ? ' Use example descriptions' : ' 使用示例描写'),
      el('div', { class: 'map-pick-list' }, rows),
      el('div', { class: 'map-actions' },
        submit,
        el('button', {
          type: 'button',
          text: t.pickAll,
          onclick: () => {
            state.picked = new Set(pending.map((s) => s.id));
            render();
          },
        }),
        el('button', {
          type: 'button',
          text: t.pickNone,
          onclick: () => { state.picked = new Set(); render(); },
        }),
        el('button', {
          type: 'button',
          text: t.addCancel,
          onclick: () => { state.terrainPick = ''; state.picked = null; render(); },
        })));
  }

  /** 「加一处」表单：**没有坐标输入框**——这插件没有坐标。 */
  function addForm() {
    const name = el('input', { placeholder: t.addName, 'aria-label': t.addName });
    const kind = el('select', { 'aria-label': t.addKind },
      el('option', { value: 'around', text: KIND_LABEL.around }),
      el('option', { value: 'home', text: KIND_LABEL.home }),
      el('option', { value: 'frequent', text: KIND_LABEL.frequent }));
    const desc = el('textarea', { placeholder: t.addDesc, 'aria-label': t.addDesc });
    kind.value = 'around';
    const style = el('input', { placeholder: t.addStyle, 'aria-label': t.addStyle });
    bindDraft('new', { name, kind, desc, style });
    const submit = el('button', {
      class: 'map-btn-primary',
      type: 'button',
      text: t.addSubmit,
      onclick: async () => {
        if (submit.disabled) return;
        const n = String(name.value ?? '').trim();
        if (!n) { name.focus?.(); return; }
        submit.disabled = true;
        submit.textContent = t.busy;
        try {
          const submitted = formValues('new');
          await call('add', [{ ...submitted, name: n }]);
          clearSavedDraft('new', submitted);
          forms.delete('new');
          state.adding = state.drafts.has('new');
          setMessage(t.saved, true);
          await load();
        } catch (err) {
          setMessage(String(err?.message ?? err), false);
          submit.disabled = false;
          submit.textContent = t.addSubmit;
          renderHead();
        }
      },
    });
    return el('div', { class: 'map-detail', style: { marginBottom: '12px' } },
      el('div', { class: 'map-field' }, el('label', { text: t.addName }), name),
      el('div', { class: 'map-field-row' },
        el('div', { class: 'map-field' }, el('label', { text: t.addKind }), kind)),
      el('div', { class: 'map-field' }, el('label', { text: t.addDesc }), desc),
      el('div', { class: 'map-field' }, el('label', { text: t.addStyle }), style),
      el('div', { class: 'map-actions' }, submit));
  }

  // -------------------------------------------------------------------------
  // 卡片墙
  // -------------------------------------------------------------------------

  function renderBody() {
    const d = state.data;
    for (const key of forms.keys()) if (key !== 'new') captureDraft(key);
    for (const key of [...forms.keys()]) if (key !== 'new') forms.delete(key);
    body.replaceChildren();
    if (!d.places.length) {
      body.appendChild(el('div', { class: 'map-empty' },
        el('strong', { text: t.emptyTitle }), el('div', { text: t.emptyHint })));
      return;
    }
    const query = String(state.query ?? '').trim().toLocaleLowerCase();
    const selected = d.places.filter((p) => {
      const terrain = [p.terrain, p.terrainLabel, d.terrainLabel].filter(Boolean).join(' ');
      const tags = Array.isArray(p.tags) ? p.tags : [];
      const text = [p.name, ...(p.aliases ?? []), p.kindLabel, terrain, ...tags].filter(Boolean).join(' ').toLocaleLowerCase();
      if (query && !text.includes(query)) return false;
      const tagQuery = String(state.tagQuery ?? '').trim().toLocaleLowerCase();
      if (tagQuery && !tags.some((tag) => tag.toLocaleLowerCase().includes(tagQuery))) return false;
      if (state.tagFilter && !tags.includes(state.tagFilter)) return false;
      switch (state.filter ?? 'all') {
        case 'noDesc': return !String(p.desc ?? '').trim();
        case 'noCover': return !p.hasCover;
        case 'frequent': return Boolean(p.frequent);
        default: return true;
      }
    });
    if (!selected.length) {
      body.appendChild(el('div', { class: 'map-empty', text: '没有符合条件的地点' }));
      return;
    }
    if (state.view === 'relations') {
      renderRelations(selected);
      return;
    }
    // 「常去」单独提一段（不管 kind），其余按 家 → 周围 分组。
    // 这只是展示顺序，不是位置关系——这里没有连线。
    const freq = selected.filter((p) => p.frequent);
    const rest = selected.filter((p) => !p.frequent);
    section(t.secFreq, freq);
    section(t.secHome, rest.filter((p) => p.kind === 'home'));
    section(t.secAround, rest.filter((p) => p.kind !== 'home' && p.kind !== 'travel'));
    section(t.secTravel, rest.filter((p) => p.kind === 'travel'));
  }

  function section(title, items) {
    if (!items.length) return;
    body.appendChild(el('div', { class: 'map-sec', text: title }));
    body.appendChild(el('div', { class: 'map-grid' }, items.map(cell)));
  }

  function renderRelations(items) {
    const byId = new Map(state.data.places.map((place) => [place.id, place]));
    const rows = [];
    for (const place of items) {
      const relations = Array.isArray(place.relations) ? place.relations : [];
      for (const relation of relations) {
        const target = byId.get(relation.placeId);
        rows.push(el('div', { class: 'map-relation-row' },
          el('strong', { text: place.name }),
          el('span', { text: ' → ' }),
          el('strong', { text: target?.name ?? t.missingTarget }),
          relation.note ? el('span', { class: 'map-dim', text: `：${relation.note}` }) : null));
      }
    }
    body.appendChild(rows.length ? el('div', { class: 'map-relations-view' }, rows) : el('div', { class: 'map-empty', text: t.noRelations }));
  }

  /** 一格里画卡；展开时它后面紧跟一条详情，并且这一格跨满整行。 */
  function cell(p) {
    const open = state.expanded === p.id;
    const wrap = el('div', { class: open ? 'map-cell map-cell-open' : 'map-cell' });
    wrap.appendChild(card(p));
    if (open) wrap.appendChild(detail(p));
    return wrap;
  }

  function completeness(p) {
    const checks = [Boolean(String(p.desc ?? '').trim()), Boolean(String(p.effectiveStyle ?? p.style ?? '').trim()), Boolean(p.hasCover), Array.isArray(p.tags) && p.tags.length > 0, Array.isArray(p.relations) && p.relations.length > 0];
    return `${checks.filter(Boolean).length}/${checks.length}`;
  }

  function linkStatus(p, key) {
    const en = language === 'en';
    const label = key === 'imggen' ? (en ? 'Images' : '生图') : (en ? 'Fun' : '娱乐');
    let status;
    if (state.data.wanted?.[key] === false) status = en ? 'off' : '关';
    else if (!state.data.installed?.[key]) status = en ? 'not enabled' : '未启用';
    else if (!(key === 'imggen' ? p.scene : p.funVenue)) status = key === 'imggen' ? (en ? 'no scene entered' : '未填场景，不用填 scene') : (en ? 'no venue entered' : '未填场所');
    else if (key === 'imggen' ? p.canMentionImggen : p.canMentionFun) status = en ? 'entered · hint available' : '已填可提示';
    else status = en ? 'hint unavailable' : '暂不可提示';
    return `${label}：${status}`;
  }

  function card(p) {
    const cls = ['map-card'];
    if (p.kind === 'home') cls.push('map-card-home');
    else if (p.frequent) cls.push('map-card-freq');
    if (state.expanded === p.id) cls.push('map-card-active');

    // 缩略图：缓存里有就同步画，没有就在后面补（不阻塞整面墙渲染）。
    const url = state.covers.get(p.id);
    let thumb = null;
    if (p.hasCover) {
      thumb = url
        ? el('img', { class: 'map-thumb', src: url, alt: p.name, loading: 'lazy' })
        : el('div', { class: 'map-thumb', 'aria-label': t.noImage });
      if (!url) {
        void coverOf(p.id).then((u) => {
          if (!u) return;
          const img = el('img', { class: 'map-thumb', src: u, alt: p.name, loading: 'lazy' });
          if (thumb?.parentNode) thumb.parentNode.replaceChild(img, thumb);
        });
      }
    }

    const descCls = p.desc ? 'map-card-desc' : 'map-card-desc map-card-desc-empty';
    return el('div', {
      class: cls.join(' '),
      role: 'button',
      tabindex: '0',
      'aria-expanded': state.expanded === p.id ? 'true' : 'false',
      onclick: () => toggle(p.id),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault?.();
          toggle(p.id);
        }
      },
    },
    thumb,
    el('div', { class: 'map-card-body' },
      el('div', { class: 'map-card-head' },
        el('span', { class: 'map-card-name', text: p.name }),
        el('span', { class: 'map-card-arrow', text: state.expanded === p.id ? '⌃' : '⌄' })),
      el('div', { class: descCls, text: p.desc || t.noDesc }),
      el('div', { class: 'map-card-completeness', text: `${t.completeness}：${completeness(p)}` }),
      el('div', { class: 'map-chips' }, ...(Array.isArray(p.tags) ? p.tags.map((tag) => el('span', { class: 'map-chip', text: tag })) : [])),
      el('div', { class: 'map-card-foot' },
        el('span', { class: 'map-chip', text: p.kindLabel }),
        state.data.homeId === p.id ? el('span', { class: 'map-chip map-chip-on', text: '当前住所' }) : null,
        p.frequent ? el('span', { class: 'map-chip map-chip-warm', text: '★' }) : null,
        p.hasCover ? el('span', { class: 'map-chip', text: '📷' }) : null,
        el('span', { class: 'map-link-status', text: linkStatus(p, 'imggen') }),
        el('span', { class: 'map-link-status', text: linkStatus(p, 'fun') }),
        // 只有在「三条全满足」时服务端才给 canMentionImggen=true，面板才显示这个 chip。
        p.canMentionImggen ? el('span', { class: 'map-chip map-chip-scene', text: `scene：${p.scene}` }) : null)));
  }

  function toggle(id) {
    const wasOpen = state.expanded === id;
    state.expanded = wasOpen ? null : id;
    renderBody();
    if (!wasOpen) {
      const active = body.querySelector('.map-card-active');
      const target = active?.parentNode ?? active;
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  function detail(p) {
    const nameIn = el('input', { value: p.name, 'aria-label': 'name' });
    const descIn = el('textarea', { 'aria-label': t.detailDesc });
    descIn.value = p.desc;
    const styleIn = el('input', { value: p.style, 'aria-label': t.detailStyle,
      placeholder: p.effectiveStyle ? `${language === 'en' ? 'Empty inherits world style' : '留空继承世界画风'}：${p.effectiveStyle}` : '' });
    const aliasIn = el('input', { value: p.aliases.join('、'), 'aria-label': t.detailAliases });
    const tagsIn = el('input', { value: (p.tags ?? []).join('、'), 'aria-label': t.detailTags });
    const kindSel = el('select', { 'aria-label': 'kind' },
      el('option', { value: 'home', text: KIND_LABEL.home }),
      el('option', { value: 'frequent', text: KIND_LABEL.frequent }),
      el('option', { value: 'around', text: KIND_LABEL.around }),
      el('option', { value: 'travel', text: KIND_LABEL.travel }));
    kindSel.value = p.kind;
    // scene 输入框：留空就是「不提」。这里**不给任何建议值**——编一个名字等于害她填错。
    const sceneIn = el('input', { value: p.scene, placeholder: t.detailSceneEmpty, 'aria-label': t.detailScene });
    // funVenue 同理：留空就是「不提去哪逛」，绝不预填一个场所名。
    const funIn = el('input', { value: p.funVenue ?? '', placeholder: t.detailFunVenueEmpty, 'aria-label': t.detailFunVenue });
    const relationsJson = el('input', { type: 'hidden', name: 'relationsJson' });
    const relationRows = (p.relations ?? []).map((r) => ({ placeId: r.placeId, note: r.note }));
    const relationList = el('div', { class: 'map-relations' });
    const availableTargets = state.data.places.filter((x) => x.id !== p.id);
    const syncRelations = () => { relationsJson.value = JSON.stringify(relationRows); };
    const redrawRelations = () => {
      relationList.replaceChildren();
      syncRelations();
      for (const row of relationRows) {
        const select = el('select', { 'aria-label': '关联地点' },
          el('option', { value: '', text: '选择关联地点' }),
          ...availableTargets.map((target) => el('option', { value: target.id, text: `${target.name} · ${target.terrainLabel || target.kindLabel} · ${target.id}` })));
        select.value = row.placeId;
        const note = el('input', { value: row.note, maxLength: 80, placeholder: '例如：窗边能看见溪面', 'aria-label': '关联说明' });
        const remove = el('button', { type: 'button', text: '删除关联', onclick: () => { const index = relationRows.indexOf(row); if (index >= 0) relationRows.splice(index, 1); redrawRelations(); captureDraft(p.id); } });
        select.addEventListener('change', () => { row.placeId = select.value; syncRelations(); captureDraft(p.id); });
        note.addEventListener('input', () => { row.note = note.value; syncRelations(); captureDraft(p.id); });
        relationList.appendChild(el('div', { class: 'map-field-row' }, select, note, remove));
      }
    };
    const addRelation = el('button', { type: 'button', text: '添加关联', onclick: () => { if (relationRows.length >= 8) return; relationRows.push({ placeId: '', note: '' }); redrawRelations(); captureDraft(p.id); } });
    redrawRelations();

    if (!state.baseRevisions.has(p.id) || !state.drafts.has(p.id)) state.baseRevisions.set(p.id, p.revision);
    bindDraft(p.id, { name: nameIn, desc: descIn, style: styleIn, aliases: aliasIn, tags: tagsIn, kind: kindSel, scene: sceneIn, funVenue: funIn, relationsJson });
    try {
      const savedRelations = JSON.parse(relationsJson.value || '[]');
      if (Array.isArray(savedRelations) && (savedRelations.length || Object.hasOwn(state.drafts.get(p.id) ?? {}, 'relationsJson'))) {
        relationRows.splice(0, relationRows.length, ...savedRelations.filter((r) => r && typeof r.placeId === 'string' && typeof r.note === 'string').slice(0, 8));
        redrawRelations();
      }
    } catch { relationsJson.value = JSON.stringify(relationRows); }

    const saveBtn = el('button', {
      class: 'map-btn-primary',
      type: 'button',
      text: t.save,
      onclick: async () => {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        saveBtn.textContent = t.busy;
        try {
          const submitted = formValues(p.id);
          let relations;
          try { relations = JSON.parse(submitted.relationsJson || '[]'); } catch { relations = null; }
          const seenTargets = new Set();
          const invalidRelations = !Array.isArray(relations) || relations.length > 8 || relations.some((r) => {
            if (!r || typeof r.placeId !== 'string' || !r.placeId.trim() || typeof r.note !== 'string' || !r.note.trim() || r.note.length > 80 || seenTargets.has(r.placeId)) return true;
            seenTargets.add(r.placeId);
            return !availableTargets.some((target) => target.id === r.placeId);
          });
          if (invalidRelations) {
            setMessage('地点关联需填写目标和说明，目标不能重复，最多 8 条。', false);
            saveBtn.disabled = false;
            saveBtn.textContent = t.save;
            render();
            return;
          }
          await call('edit', [{
            id: p.id,
            expectedRevision: state.baseRevisions.get(p.id),
            name: String(nameIn.value ?? '').trim(),
            desc: descIn.value,
            style: String(styleIn.value ?? '').trim(),
            aliases: String(aliasIn.value ?? '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean),
            tags: String(tagsIn.value ?? '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean),
            kind: kindSel.value,
            scene: String(sceneIn.value ?? '').trim(),
            funVenue: String(funIn.value ?? '').trim(),
            relations,
          }]);
          clearSavedDraft(p.id, submitted);
          state.conflicts.delete(p.id);
          state.baseRevisions.delete(p.id);
          forms.delete(p.id);
          state.covers.delete(p.id);
          setMessage(t.saved, true);
          await load();
        } catch (err) {
          if (err.conflict && err.current) state.conflicts.set(p.id, err.current);
          setMessage(String(err?.message ?? err), false);
          saveBtn.disabled = false;
          saveBtn.textContent = t.save;
          render();
        }
      },
    });

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif',
      style: { display: 'none' },
      onchange: async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { setMessage(t.uploadTooBig, false); render(); return; }
        if (!mimeOf(file)) { setMessage(t.uploadBadType, false); render(); return; }
        setMessage(t.busy, true);
        renderHead();
        try {
          const dataUrl = await readAsDataUrl(file);
          await call('upload', [{ id: p.id, data: dataUrl }]);
          state.covers.delete(p.id);
          setMessage(t.uploaded, true);
          await load();
        } catch (err) {
          setMessage(String(err?.message ?? err), false);
          render();
        }
      },
    });

    const actions = el('div', { class: 'map-actions' },
      saveBtn,
      p.kind === 'home' ? el('button', {
        type: 'button',
        text: state.data.homeId === p.id ? '当前住所' : '设为当前住所',
        onclick: async () => { try { await call('setHome', [{ id: p.id }]); await load(); } catch (err) { setMessage(String(err?.message ?? err), false); render(); } },
      }) : null,
      el('button', {
        type: 'button',
        text: p.frequent ? t.frequentOff : t.frequentOn,
        onclick: async () => {
          try {
            await call('frequent', [{ id: p.id, on: !p.frequent }]);
            await load();
          } catch (err) {
            setMessage(String(err?.message ?? err), false);
            render();
          }
        },
      }),
      el('button', {
        type: 'button',
        text: p.hasCover ? t.reupload : t.upload,
        onclick: () => fileInput.click?.(),
      }),
      p.hasCover
        ? el('button', {
          type: 'button',
          text: t.clearCover,
          onclick: async () => {
            try {
              await call('clearCover', [{ id: p.id }]);
              state.covers.set(p.id, '');
              setMessage(t.cleared, true);
              await load();
            } catch (err) {
              setMessage(String(err?.message ?? err), false);
              render();
            }
          },
        })
        : null,
      el('button', {
        class: 'map-btn-danger',
        type: 'button',
        text: t.remove,
        onclick: async () => {
          // 删是不可逆的（描写和图一起没），先问一句。
          if (!(await askConfirm(ctx, t.removeConfirm))) return;
          try {
            await call('remove', [{ id: p.id }]);
            if (state.expanded === p.id) state.expanded = null;
            state.drafts.delete(p.id);
              Promise.resolve(ctx.invoke('removeDraft', [{ id: p.id }])).catch(() => {});
            forms.delete(p.id);
            state.covers.delete(p.id);
            setMessage(t.removed, true);
            await load();
          } catch (err) {
            setMessage(String(err?.message ?? err), false);
            render();
          }
        },
      }),
      fileInput);

    return el('div', { class: 'map-detail' },
      el('div', { class: 'map-detail-top' }, el('h4', { text: `${p.name}${p.terrain ? ` · ${p.terrain}` : ''}` }),
        el('button', {
          type: 'button',
          class: 'map-dim',
          text: '×',
          title: '收起',
          onclick: (ev) => {
            ev?.stopPropagation?.();
            state.expanded = null;
            renderBody();
          },
        })),
      state.conflicts.has(p.id) ? el('div', { class: 'map-msg map-msg-bad' },
        el('div', { text: `当前已保存内容：${state.conflicts.get(p.id).desc || '（无描写）'}。你的草稿仍保留。` }),
        el('button', { type: 'button', text: '载入当前版本', onclick: () => { forms.delete(p.id); state.drafts.delete(p.id); state.conflicts.delete(p.id); state.baseRevisions.delete(p.id); persistDrafts(); void load(); } }),
        el('button', { type: 'button', text: '保留草稿，确认覆盖', onclick: () => { state.baseRevisions.set(p.id, state.conflicts.get(p.id).revision); state.conflicts.delete(p.id); setMessage('已确认保留草稿，请再点保存；若记录再次变化会重新提示冲突。'); render(); } })) : null,
      el('div', { class: 'map-field' }, el('label', { text: '名字' }), nameIn),
      el('div', { class: 'map-field-row' },
        el('div', { class: 'map-field' }, el('label', { text: '归类' }), kindSel)),
      p.kind === 'home' ? el('div', { class: 'map-actions' }, el('span', { text: state.data.homeId === p.id ? '当前住所' : '住所候选' }), el('button', { type: 'button', text: state.data.homeId === p.id ? '当前住所' : '设为当前住所', onclick: async () => { const r = await call('setHome', [{ id: p.id }]); if (r.ok) await load(); } })) : null,
      el('div', { class: 'map-field' }, el('label', { text: t.detailDesc }), descIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailStyle }), styleIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailAliases }), aliasIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailTags }), tagsIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailScene }), sceneIn),
      // 三条全满足才提示 scene；否则明说「不用填」——不指向不存在的库。
      el('div', { class: 'map-scene' },
        p.canMentionImggen
          ? el('span', {}, '生图时 ', el('b', { text: `scene 填「${p.scene}」` }))
          : el('span', { text: linkStatus(p, 'imggen') })),
      el('div', { class: 'map-field' }, el('label', { text: t.detailFunVenue }), funIn),
      el('div', { class: 'map-field' }, el('label', { text: '地点关联' }), el('div', { class: 'map-note', text: '只写语境，不写方位或远近。' }), relationsJson, relationList, addRelation),
      // 旅游那类才有意义：三条全满足才提「想去逛去哪」。
      el('div', { class: 'map-scene' },
          p.canMentionFun
            ? el('span', {}, '想真去逛：', el('b', { text: `fun_go 填「${p.funVenue}」` }), '（娱乐时间里最接近这处的一处，不是同一个地方）')
            : el('span', { text: linkStatus(p, 'fun') })),
      p.hasCover ? el('div', { class: 'map-locked', text: '有图就锁着，不会自己变；要换先清空。' }) : null,
      actions);
  }

  // -------------------------------------------------------------------------
  // 取数
  // -------------------------------------------------------------------------

  /**
   * 重画整块面板。
   *
   * **一次渲染失败绝不能让面板变成「点不动」**——那正是 2026-11-15 真机反馈的样子：
   * 界面上还是上一帧，点什么都没反应，也没有任何提示。所以这里兜一层：
   * 出错就把原因画出来（能照着修），而不是静默留在死界面上。
   */
  function render() {
    if (!state.data) return;
    try {
      if (root.querySelector('.map') !== box) {
        root.replaceChildren();
        ensureStyle(root);
        root.appendChild(box);
      }
      renderHead();
      renderBody();
    } catch (err) {
      root.replaceChildren();
      ensureStyle(root);
      const b = shell(root, t.title);
      b.appendChild(el('div', { class: 'map-err', text: `${t.renderFail}：${err?.message ?? String(err)}` }));
      b.appendChild(el('div', { class: 'map-note', text: '面板已停在这一帧，下面是重新载入。' }));
      b.appendChild(el('div', { class: 'map-actions' },
        el('button', {
          class: 'map-btn-primary',
          type: 'button',
          text: t.retry,
          onclick: () => { void load(); },
        })));
    }
  }

  const load = async () => {
    const version = ++state.loadVersion;
    try {
      const d = await call('list');
      if (version !== state.loadVersion || ctx.signal?.aborted || state.pending.size) return;
      state.data = d;
      if (!state.draftsLoaded) {
        const saved = await ctx.invoke('drafts', []);
        applyDrafts(Array.isArray(saved) ? saved : saved?.drafts ?? []);
      }
      // 展开着的那一处如果被删了，收起详情。
      if (state.expanded && !d.places.some((p) => p.id === state.expanded)) state.expanded = null;

      // 勾选状态要跟着数据走：删掉一处之后它又变回「可以再加」，
      // 而旧的 picked 里可能还留着一个已经不存在的 id（或者反过来）。
      // 不重新对齐的话，勾选表会出现「勾了不生效 / 按钮莫名灰着」的假死。
      if (state.picked) {
        const terrain = d.terrains.find((x) => x.id === state.pickedFor);
        if (!terrain || !Array.isArray(terrain.skeletons)) {
          state.picked = null;
          state.pickedFor = '';
        } else {
          const pending = new Set(terrain.skeletons.filter((s) => !s.exists).map((s) => s.id));
          for (const id of [...state.picked]) if (!pending.has(id)) state.picked.delete(id);
        }
      }
      // 勾选表指向的那套地形要是没了，也收起来。
      if (state.terrainPick && !d.terrains.some((x) => x.id === state.terrainPick)) state.terrainPick = '';

      render();
    } catch (err) {
      if (version !== state.loadVersion || ctx.signal?.aborted) return;
      if (state.data) {
        setMessage(`${t.loadFail}：${err?.message ?? String(err)}`, false);
        render();
        return;
      }
      root.replaceChildren();
      ensureStyle(root);
      const b = shell(root, t.title);
      b.appendChild(el('div', { class: 'map-err', text: `${t.loadFail}：${err?.message ?? String(err)}` }));
      b.appendChild(el('button', { type: 'button', text: t.retry, onclick: () => { void load(); } }));
    }
  };

  void load();
  // 地点是主人手改的，不会自己变；一分钟刷一次足够，也不会打断正在填的字。
  // `ctx.interval` 可选：老宿主没有这个方法（feed-world 也是这么防的），
  // 没有就不自动刷——面板本身照样能手动用，不该因为少一个方法就整片白。
  ctx.interval?.(() => { void load(); }, 60000);

  return { refresh: load };
}

export default {
  panels: {
    places: { mount: mountPlaces },
  },
};
