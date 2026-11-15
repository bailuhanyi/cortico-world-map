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
.map-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:9px;align-items:start}
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
.map-field-row>*{flex:1;min-width:130px}
.map-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px;padding-top:9px;border-top:1px solid var(--m-line)}
.map-scene{font-size:12px;padding:5px 9px;border-radius:var(--radius-sm,6px);background:var(--m-soft);border:1px solid var(--m-line);margin:8px 0 0}
.map-scene b{font-weight:600}
.map-locked{font-size:11.5px;color:var(--m-dim);margin-top:5px}
.map-note{font-size:11.5px;color:var(--m-dim);margin-top:5px;line-height:1.5}

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
.map-pick{display:flex;gap:8px;align-items:baseline;padding:4px 6px;border-radius:var(--radius-sm,6px);cursor:pointer}
.map-pick:hover{background:var(--m-soft)}
.map-pick input{margin:0;flex:none;cursor:pointer}
.map-pick-name{font-weight:600;font-size:12.5px;flex:none;min-width:72px}
.map-pick-meta{font-size:11.5px;color:var(--m-dim)}
.map-pick-done{opacity:.55;cursor:default}
.map-pick-done:hover{background:transparent}
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
    const r = await ctx.invoke(method, args ?? []);
    if (r && r.ok === false) throw new Error(r.error ?? '返回不正常');
    return r;
  };

  /** 取/缓一处地方的图。失败就当没图——面板不能因为一张图挂掉。 */
  const coverOf = async (id) => {
    if (state.covers.has(id)) return state.covers.get(id);
    try {
      const r = await call('cover', [{ id }]);
      const url = r?.dataUrl ?? '';
      state.covers.set(id, url);
      return url;
    } catch {
      state.covers.set(id, '');
      return '';
    }
  };

  // -------------------------------------------------------------------------
  // 顶部：统计 + 地形选择 + 加一处
  // -------------------------------------------------------------------------

  function renderHead() {
    const d = state.data;
    head.replaceChildren();
    if (state.message) {
      head.appendChild(el('div', { class: `map-msg ${state.message.ok ? 'map-msg-ok' : 'map-msg-bad'}`, text: state.message.text }));
    }

    head.appendChild(el('div', { class: 'map-stats' },
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.total) }), el('span', { text: t.statsTotal })),
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.withCover) }), el('span', { text: t.statsCover })),
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.frequent) }), el('span', { text: t.statsFreq }))));

    const bar = el('div', { class: 'map-bar' });

    // 地形：选中后**展开勾选表**，不直接全加（主人挑哪几处就加哪几处）。
    //
    // 两个坑（2026-11-15 真机反馈「点不动」）：
    //   1. 占位选项的文字原本是「当前地形名」，于是下拉里显示「山脚」——
    //      看着像已经选中了山脚，其实它的值是空串，点它什么都不会发生。
    //      现在占位项写成一句**动作**（「＋ 选一套地形…」），当前地形另用一个小标签显示。
    //   2. 选了一套**已经全加完**的地形时，勾选表里全是灰的、按钮禁用——也像「点不动」。
    //      现在那种情况直接告诉她「这套已经都在图上了」，而不是给一张点不动的表。
    const pick = el('select', {
      title: t.terrain,
      onchange: () => { chooseTerrain(pick.value); },
      // 有些内嵌 webview 对 select 只发 input 不发 change，两个都挂上（重复触发无害）。
      oninput: () => { chooseTerrain(pick.value); },
    },
    el('option', { value: '', text: t.terrainPickHint }),
    d.terrains.map((x) => el('option', {
      value: x.id,
      text: `${x.label}（${x.count} 处${x.skeletons?.some((s) => s.exists) ? '，部分已加' : ''}）`,
    })));
    pick.value = state.terrainPick ?? '';
    bar.appendChild(pick);

    if (d.terrainLabel) {
      bar.appendChild(el('span', { class: 'map-chip', text: `${t.terrainNow}：${d.terrainLabel}` }));
    }

    bar.appendChild(el('button', {
      class: state.adding ? '' : 'map-btn-primary',
      type: 'button',
      text: state.adding ? t.addCancel : t.addOpen,
      onclick: () => { state.adding = !state.adding; render(); },
    }));

    head.appendChild(bar);

    if (state.terrainPick) head.appendChild(picker(state.terrainPick));
    if (state.adding) head.appendChild(addForm());
  }

  /**
   * 选了一套地形。
   *
   * 空值（占位项）**不改动**任何状态——不能因为它把已经展开的勾选表收掉，
   * 否则用户点一下「选一套地形…」就看起来什么都没发生。
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

    const rows = skeletons.map((s) => {
      const already = s.exists;
      const box = el('input', {
        type: 'checkbox',
        checked: already ? null : (picked.has(s.id) ? 'checked' : null),
        disabled: already ? 'disabled' : null,
        onchange: () => {
          if (already) return;
          if (box.checked) picked.add(s.id); else picked.delete(s.id);
          countLabel.textContent = `${t.addSubmit}（${picked.size} 处）`;
          submit.disabled = picked.size === 0;
        },
      });
      box.checked = !already && picked.has(s.id);
      const alias = s.aliases.length ? `（也叫 ${s.aliases.slice(0, 3).join('、')}）` : '';
      const fun = s.funVenue ? ` · 娱乐时间里最接近「${s.funVenue}」` : '';
      return el('label', { class: already ? 'map-pick map-pick-done' : 'map-pick' },
        box,
        el('span', { class: 'map-pick-name', text: s.name }),
        el('span', { class: 'map-pick-meta', text: `${alias}［${s.kindLabel}］${fun}${already ? ' · 已经有了' : ''}` }));
    });

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
          const r = await call('terrain', [{ id: terrainId, ids }]);
          state.terrainPick = '';
          state.picked = null;
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
    const style = el('input', { placeholder: t.addStyle, 'aria-label': t.addStyle });
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
          await call('add', [{ name: n, kind: kind.value, desc: desc.value, style: style.value }]);
          state.adding = false;
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
    body.replaceChildren();
    if (!d.places.length) {
      body.appendChild(el('div', { class: 'map-empty' },
        el('strong', { text: t.emptyTitle }), el('div', { text: t.emptyHint })));
      return;
    }
    // 「常去」单独提一段（不管 kind），其余按 家 → 周围 分组。
    // 这只是展示顺序，不是位置关系——这里没有连线。
    const freq = d.places.filter((p) => p.frequent);
    const rest = d.places.filter((p) => !p.frequent);
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

  /** 一格里画卡；展开时它后面紧跟一条详情，并且这一格跨满整行。 */
  function cell(p) {
    const open = state.expanded === p.id;
    const wrap = el('div', { class: open ? 'map-cell map-cell-open' : 'map-cell' });
    wrap.appendChild(card(p));
    if (open) wrap.appendChild(detail(p));
    return wrap;
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
      el('div', { class: 'map-card-foot' },
        el('span', { class: 'map-chip', text: p.kindLabel }),
        p.frequent ? el('span', { class: 'map-chip map-chip-warm', text: '★' }) : null,
        p.hasCover ? el('span', { class: 'map-chip', text: '📷' }) : null,
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
    const styleIn = el('input', { value: p.style, 'aria-label': t.detailStyle });
    const aliasIn = el('input', { value: p.aliases.join('、'), 'aria-label': t.detailAliases });
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

    const saveBtn = el('button', {
      class: 'map-btn-primary',
      type: 'button',
      text: t.save,
      onclick: async () => {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        saveBtn.textContent = t.busy;
        try {
          await call('edit', [{
            id: p.id,
            name: String(nameIn.value ?? '').trim(),
            desc: descIn.value,
            style: String(styleIn.value ?? '').trim(),
            aliases: String(aliasIn.value ?? '').split(/[、,，]/).map((x) => x.trim()).filter(Boolean),
            kind: kindSel.value,
            scene: String(sceneIn.value ?? '').trim(),
            funVenue: String(funIn.value ?? '').trim(),
          }]);
          state.covers.delete(p.id);
          setMessage(t.saved, true);
          await load();
        } catch (err) {
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
            state.expanded = null;
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
      el('div', { class: 'map-detail-top' }, el('h4', { text: p.name }),
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
      el('div', { class: 'map-field' }, el('label', { text: '名字' }), nameIn),
      el('div', { class: 'map-field-row' },
        el('div', { class: 'map-field' }, el('label', { text: '归类' }), kindSel)),
      el('div', { class: 'map-field' }, el('label', { text: t.detailDesc }), descIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailStyle }), styleIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailAliases }), aliasIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailScene }), sceneIn),
      // 三条全满足才提示 scene；否则明说「不用填」——不指向不存在的库。
      el('div', { class: 'map-scene' },
        p.canMentionImggen
          ? el('span', {}, '生图时 ', el('b', { text: `scene 填「${p.scene}」` }))
          : el('span', { text: t.sceneNone })),
      el('div', { class: 'map-field' }, el('label', { text: t.detailFunVenue }), funIn),
      // 旅游那类才有意义：三条全满足才提「想去逛去哪」。
      p.hasFunVenue
        ? el('div', { class: 'map-scene' },
          p.canMentionFun
            ? el('span', {}, '想真去逛：', el('b', { text: `fun_go 填「${p.funVenue}」` }), '（娱乐时间里最接近这处的一处，不是同一个地方）')
            : el('span', { text: '装着娱乐时间并开着「跟娱乐时间对齐」时，这里会告诉她去哪逛。' }))
        : null,
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
    try {
      const d = await call('list');
      state.data = d;
      // 展开着的那一处如果被删了，收起详情。
      if (state.expanded && !d.places.some((p) => p.id === state.expanded)) state.expanded = null;
      render();
    } catch (err) {
      root.replaceChildren();
      ensureStyle(root);
      const b = shell(root, t.title);
      b.appendChild(el('div', { class: 'map-err', text: `${t.loadFail}：${err?.message ?? String(err)}` }));
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
