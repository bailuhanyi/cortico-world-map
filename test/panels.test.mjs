/**
 * 面板的冒烟测试。
 *
 * 用测试挂载 Coo 实际加载的 `dist/webui.js`，覆盖容易藏错误的地方：
 * 服务端声明了面板但客户端没导出，宿主里点进去就是一片空白，不会报错。
 *
 * 这里用一个够用的极简 DOM 桩，把面板真挂一遍，喂真实的 `invoke()`，断言：
 * 往 ctx.root 里写了东西、内容来自服务端数据、有图的卡显示 <img>（base64 data URL）、
 * 没图的卡显示文字描写、点卡片先阅读再编辑、编辑里**没有坐标输入框**、坏数据有错误卡。
 *
 * 不用 `node --test`：受限沙箱里它要 spawn 子进程会被 EPERM 挡住。
 */
import { test, report } from './harness.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../src/config.js';
import { MapWorld } from '../src/world.js';

// ---------------------------------------------------------------------------
// 极简 DOM
// ---------------------------------------------------------------------------

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.className = '';
    this._text = '';
    this.style = {};
    this.attributes = {};
    this._listeners = {};
    // 真 DOM 的 <input>/<select>/<textarea> 一律有 value。桩里不给的话，
    // 面板里 `input.value.trim()` 会炸，而那是面板的正常写法。
    this.value = '';
    this.placeholder = '';
    this.disabled = false;
    this.parentNode = null;
    this.title = '';
    this.src = '';
  }

  get children() { return this.childNodes.filter((child) => child.tagName !== '#TEXT'); }

  get textContent() {
    if (this.childNodes.length) return this.childNodes.map((c) => c.textContent).join('');
    return this._text;
  }

  set textContent(v) {
    this.childNodes = [];
    this._text = v === null || v === undefined ? '' : String(v);
  }

  appendChild(node) {
    this.childNodes.push(node);
    node.parentNode = this;
    this._text = '';
    return node;
  }

  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this._text = '';
    for (const n of nodes) this.appendChild(n);
  }

  replaceChild(next, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) return old;
    this.childNodes[i] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }

  get classList() {
    const self = this;
    return {
      add: (...names) => {
        const set = new Set(self.className.split(' ').filter(Boolean));
        for (const n of names) set.add(n);
        self.className = [...set].join(' ');
      },
      remove: (...names) => {
        const drop = new Set(names);
        self.className = self.className.split(' ').filter((n) => n && !drop.has(n)).join(' ');
      },
      contains: (n) => self.className.split(' ').includes(n),
    };
  }

  setAttribute(k, v) {
    this.attributes[k] = v;
    if (k === 'class') this.className = v;
    if (k === 'value') this.value = v;
    if (k === 'placeholder') this.placeholder = v;
    if (k === 'src') this.src = v;
    if (k === 'title') this.title = v;
    // 真 DOM 里这两个属性会同步到同名 property（`<input disabled>` 就是 disabled=true），
    // 桩里不同步的话，面板里 `box.disabled` 永远是 false，测出来是假绿。
    if (k === 'disabled') this.disabled = v !== null && v !== undefined && v !== false;
    if (k === 'checked') this.checked = v !== null && v !== undefined && v !== false;
  }

  getAttribute(k) { return this.attributes[k]; }

  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'disabled') this.disabled = false;
    if (k === 'checked') this.checked = false;
  }

  addEventListener(type, fn) {
    (this._listeners[type] ??= []).push(fn);
  }

  focus() { globalThis.document.activeElement = this; }
  click() { this.fire('click'); }

  fire(type = 'click', extra = null) {
    const ev = { type, target: this, ...(extra ?? {}) };
    for (const fn of this._listeners[type] ?? []) fn(ev);
    const prop = this[`on${type}`];
    if (typeof prop === 'function') prop(ev);
  }

  *walk() {
    yield this;
    for (const c of this.childNodes) yield* c.walk();
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  querySelectorAll(sel) {
    const isClass = sel.startsWith('.');
    const isTag = !isClass && !sel.startsWith('style');
    const cls = isClass ? sel.slice(1).split('.').filter(Boolean) : [];
    return [...this.walk()].filter((n) => {
      if (n === this) return false;
      if (isTag) return n.tagName === sel.toUpperCase();
      return cls.every((c) => n.classList.contains(c));
    });
  }

  findAll(pred) { return [...this.walk()].filter(pred); }
}

globalThis.document = {
  createElement: (tag) => new Node(tag),
  createTextNode: (t) => Object.assign(new Node('#text'), { _text: String(t) }),
  activeElement: null,
};

/** 等条件成立，而不是「等 0 毫秒若干次」——固定次数是竞态。 */
async function waitFor(check, what = '条件', timeoutMs = 2000) {
  const start = performance.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() - start > timeoutMs) throw new Error(`等 ${what} 超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 通过用户可见的控件打开阅读、编辑和管理。 */
const button = (root, text) => root.findAll((n) => n.tagName === 'BUTTON' && n.textContent === text)[0];
const card = (root, name) => root.querySelectorAll('.map-card')
  .find((n) => n.querySelector('.map-card-name')?.textContent === name);
const cardNames = (root) => root.querySelectorAll('.map-card-name').map((n) => n.textContent);
const field = (root, label) => root.findAll((n) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName) && n.getAttribute('aria-label') === label)[0];
const searchLabel = '搜索名称、别名、标签、地形';

function type(node, value) { node.value = value; node.fire('input'); }

function readPlace(root, name) {
  const placeCard = card(root, name);
  assert.ok(placeCard, `找不到「${name}」的卡片`);
  placeCard.fire('click');
  const reading = root.querySelector('.map-reading');
  assert.ok(reading, `点击「${name}」后应打开阅读`);
  return reading;
}

function openPlace(root, name) {
  const reading = readPlace(root, name);
  const edit = button(reading, '编辑');
  assert.ok(edit, '阅读应提供「编辑」按钮');
  edit.fire('click');
  const detail = root.querySelector('.map-detail');
  assert.ok(detail, '点击「编辑」后应打开表单');
  return detail;
}

function openManagement(root) {
  if (!button(root, '刷新')) {
    const manage = button(root, '管理');
    assert.ok(manage, '应提供「管理」按钮');
    manage.fire('click');
  }
  assert.ok(button(root, '刷新'), '打开管理后应看到「刷新」');
}

/**
 * 点「加某一套地形」的按钮。
 *
 * 地形控件 2026-11-15 从 `<select>` 换成了一排按钮（下拉在真机上两次「点不动」），
 * 所以测试也走按钮——和用户真点的路径一致。
 */
function pickTerrain(root, label) {
  openManagement(root);
  const btn = root.querySelectorAll('.map-terrain')
    .find((b) => b.textContent.replace(/^[＋▾]\s*/, '').trim() === label);
  if (!btn) {
    throw new Error(`找不到地形按钮「${label}」；现有: ${root.querySelectorAll('.map-terrain').map((b) => b.textContent).join(' / ')}`);
  }
  btn.fire('click');
  return btn;
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const intervalBox = { list: [] };
let seq = 0;
const run = `${process.pid}-${Date.now().toString(36)}`;

/** 一张真 PNG 的最小字节（够过魔数）。 */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(24, 3)]);
/** 完整的 1 × 1 PNG，供无引用图片归档与逐字节恢复校验。 */
const INVENTORY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function mountPanels({ language = 'zh', failList = false, cfg = {}, imggen = false, feast = false, fun = false, terrain = 'forest', withCover = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), `map-panels-${run}-${seq += 1}-`));
  const dataDir = join(root, 'data', 'home', 'companion');
  await mkdir(dataDir, { recursive: true });
  // 三个联动各写一个 enabled，决定那些句子能不能出现
  await writeFile(join(dataDir, '..', 'config.json'), JSON.stringify({
    worlds: {
      imggen: { enabled: imggen },
      feast: { enabled: feast },
      fun: { enabled: fun },
    },
  }), 'utf8');

  const world = new MapWorld({
    cfg: { ...DEFAULTS, enabled: true, ...cfg },
    dataDir,
    timezone: 'Asia/Shanghai',
    now: () => Date.parse('2026-11-15T14:00:00+08:00'),
    persist: () => {},
  });
  await world.start({ log: { info() {}, warn() {} } });
  const decl = world.webUi(language);
  const tool = (n) => world.tools().find((t) => t.name === n).handler;

  // 建地形 / 写一处 / 传一张图
  await decl.invoke('places', 'terrain', [{ id: terrain }]);
  await tool('map_edit')({ place: '溪边', desc: '一条很浅的溪，石头是青的', style: '水彩，青灰' });
  await tool('map_edit')({ place: '老橡树', desc: '树皮裂成一块一块' });
  if (withCover) {
    const up = await decl.invoke('places', 'upload', [{ id: 'forest-creek', data: `data:image/png;base64,${PNG.toString('base64')}` }]);
    assert.equal(up.ok, true, up.error);
  }

  const bundle = await import('../dist/webui.js?' + Math.random());
  const domRoot = new Node('div');
  intervalBox.list.length = 0;
  const invocations = [];
  const ctx = {
    pageId: 'world:map',
    panelId: 'places',
    language,
    root: domRoot,
    signal: { aborted: false },
    timeout() { return { dispose() {} }; },
    interval(fn, ms) {
      const entry = { fn, ms, disposed: false };
      intervalBox.list.push(entry);
      return { dispose() { entry.disposed = true; } };
    },
    async invoke(method, args) {
      const record = { method, args };
      invocations.push(record);
      if (failList && method === 'list') throw new Error('boom');
      const result = await decl.invoke(ctx.panelId, method, args ?? []);
      record.result = result;
      return result;
    },
  };

  async function mount(id = 'places') {
    ctx.panelId = id;
    domRoot.replaceChildren();
    invocations.length = 0;
    await bundle.default.panels[id].mount(ctx);
    return domRoot;
  }

  return { world, bundle, decl, mount, root: domRoot, invocations, intervals: intervalBox.list, dataDir, tool, ctx };
}

// ---------------------------------------------------------------------------
// bundle 形状
// ---------------------------------------------------------------------------

test('bundle 形状对：面板 id 与服务端声明一一对上，mount 是函数', async () => {
  const b = await import('../dist/webui.js');
  const { decl } = await mountPanels();
  const declared = decl.panels.map((p) => p.id).sort();
  assert.deepEqual(Object.keys(b.default.panels).sort(), declared,
    `客户端导出的 ${Object.keys(b.default.panels).sort().join('、')} 与服务端声明的 ${declared.join('、')} 对不上`);
  assert.equal(typeof b.default.panels.places.mount, 'function');
  // 服务端只声明一个面板
  assert.equal(declared.length, 1);
});

test('服务端面板声明带 getMethods，且声明的方法真的能调', async () => {
  const { decl } = await mountPanels();
  const p = decl.panels[0];
  assert.ok(p.title && p.description, '缺标题或说明');
  assert.ok(Array.isArray(p.getMethods) && p.getMethods.length);
  for (const m of p.getMethods) {
    const r = await decl.invoke(p.id, m, []);
    assert.equal(r.ok, true, `${p.id}.${m} 失败了：${r.error}`);
  }
});

// ---------------------------------------------------------------------------
// 卡片墙
// ---------------------------------------------------------------------------

test('把每处地方都画成一张卡（有图有描写）', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  const names = root.querySelectorAll('.map-card-name').map((n) => n.textContent);
  for (const n of ['家', '老橡树', '溪边', '蘑菇坡', '林间空地']) {
    assert.ok(names.includes(n), `缺 ${n}`);
  }
  const creek = root.querySelectorAll('.map-card')
    .find((c) => c.querySelector('.map-card-name').textContent === '溪边');
  assert.ok(creek.textContent.includes('一条很浅的溪'), '有描写的卡要显示描写');
  assert.ok(creek.textContent.includes('还没图') === false);
});

test('没写描写的卡显示「还没写描写」而不是空白', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  const home = root.querySelectorAll('.map-card')
    .find((c) => c.querySelector('.map-card-name').textContent === '家');
  assert.ok(home.textContent.includes('还没写描写'), home.textContent);
});

test('有 cover 的卡显示 <img>，src 是 base64 data URL（走 ctx.invoke cover）', async () => {
  const { mount, invocations } = await mountPanels({ withCover: true });
  const root = await mount();
  await waitFor(() => root.querySelector('.map-thumb[src^="data:image/png;base64,"]')
    ?? root.querySelectorAll('.map-thumb').find((n) => n.src?.startsWith('data:image/png;base64,')), '缩略图出来');
  const imgs = root.querySelectorAll('img').filter((n) => n.src.startsWith('data:image/png;base64,'));
  assert.ok(imgs.length >= 1, '该有一张 base64 缩略图');
  assert.ok(invocations.some((r) => r.method === 'cover'), '缩略图要经 ctx.invoke(cover) 拿，不直接读盘');
  // 没图的那几张不该有 img
  const cards = root.querySelectorAll('.map-card');
  const creek = cards.find((c) => c.querySelector('.map-card-name').textContent === '溪边');
  assert.ok(creek.querySelector('img'), '溪边有图，该有 <img>');
  const oak = cards.find((c) => c.querySelector('.map-card-name').textContent === '老橡树');
  assert.equal(oak.querySelector('img'), null, '老橡树没图，不该有 <img>');
});

test('点卡片先阅读，「编辑」才打开表单，可返回阅读再收起', async () => {
  const { mount, invocations } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  const reading = readPlace(root, '溪边');
  assert.match(reading.textContent, /溪边/);
  assert.match(reading.textContent, /一条很浅的溪，石头是青的/);
  assert.match(reading.textContent, /水彩，青灰/);
  assert.equal(root.querySelector('.map-detail'), null);
  for (const tag of ['input', 'textarea', 'select']) assert.equal(reading.querySelector(tag), null);
  for (const action of ['存一下', '删掉这处', '清空图', '标成常去']) assert.equal(button(reading, action), undefined);

  button(reading, '编辑').fire('click');
  const detail = root.querySelector('.map-detail');
  assert.ok(detail, '点击编辑后才出现表单');
  assert.equal(field(detail, '描写').value, '一条很浅的溪，石头是青的');
  type(field(detail, '描写'), '只写在编辑草稿里');

  button(detail, '返回阅读').fire('click');
  assert.equal(root.querySelector('.map-detail'), null);
  const returned = root.querySelector('.map-reading');
  assert.match(returned.textContent, /一条很浅的溪，石头是青的/);
  assert.doesNotMatch(returned.textContent, /只写在编辑草稿里/);
  button(returned, '编辑').fire('click');
  assert.equal(field(root.querySelector('.map-detail'), '描写').value, '只写在编辑草稿里');
  button(root.querySelector('.map-detail'), '返回阅读').fire('click');
  button(root.querySelector('.map-reading'), '收起').fire('click');
  assert.equal(root.querySelector('.map-reading'), null);
  assert.equal(root.querySelector('.map-detail'), null);
  assert.equal(invocations.some((r) => r.method === 'edit'), false, '浏览及返回不能保存修改');
});

test('详情里的输入控件里没有坐标/路线输入框（红线）', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  const detail = openPlace(root, '家');
  const labels = detail.querySelectorAll('label').map((l) => l.textContent).join(' ');
  assert.ok(!/坐标|经度|纬度|路线|距离|远近|导航/.test(labels), `不该有坐标类输入框：${labels}`);
  // input 的 aria-label 也不许有
  const aria = detail.querySelectorAll('input').map((i) => i.getAttribute('aria-label') ?? '').join(' ');
  assert.ok(!/lat|lng|coord|route|distance/i.test(aria));
});

test('选地形不直接加：先出勾选表，勾着才加', async () => {
  const { mount, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  openManagement(root);
  // 五套地形都是一排按钮（不是下拉——下拉在真机上两次「点不动」）
  const labels = root.querySelectorAll('.map-terrain').map((b) => b.textContent.replace(/^[＋▾]\s*/, '').trim());
  for (const label of ['林间', '小区', '江边', '山脚', '旅行']) {
    assert.ok(labels.includes(label), `缺地形按钮「${label}」：${labels.join(',')}`);
  }

  // 点一套「还没加过」的地形：应当出勾选表，而不是立刻加进去
  pickTerrain(root, '江边');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '出现勾选表');
  assert.equal(root.querySelectorAll('.map-card').length, 5, '还没点「加进去」之前一处都不该加');

  // 默认全选（2026-11-15 定）。勾的记号是行自己的 class + ✓，不是原生 checkbox。
  const rows = () => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelectorAll('.map-pick')
    .filter((r) => !r.classList.contains('map-pick-done'));
  assert.equal(rows().length, 5, '勾选表该列出这套的 5 处');
  assert.equal(rows().filter((r) => r.classList.contains('map-pick-on')).length, 5, '默认应当全选');
  // ✓ 看得见：每行的记号都是 ✓ 而不是 ○
  assert.ok(rows().every((r) => r.querySelector('.map-pick-glyph').textContent === '✓'), '选中的行该有 ✓');

  // 摘要要说清勾了哪几处
  const summary = root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelector('.map-picked');
  assert.ok(summary.textContent.includes('5 处'), `摘要该报数量：${summary.textContent}`);
  assert.ok(summary.textContent.includes('江边石墩'), `摘要该列出名字：${summary.textContent}`);

  // 点两下取消（点整行，不是点复选框）
  rows()[1].fire('click');
  await waitFor(() => rows().filter((r) => r.classList.contains('map-pick-on')).length === 4, '取消一处后剩 4');
  root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelectorAll('.map-pick').find((r) => r.querySelector('.map-pick-name').textContent === '旧码头').fire('click');
  await waitFor(() => rows().filter((r) => r.classList.contains('map-pick-on')).length === 3, '取消两处后剩 3');
  // 摘要跟着变
  assert.ok(root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelector('.map-picked').textContent.includes('3 处'),
    '摘要该跟着变成 3 处');

  const submit = root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).findAll((n) => n.tagName === 'BUTTON' && /加进去/.test(n.textContent))[0];
  assert.ok(submit, '该有「加进去」按钮');
  submit.fire('click');

  await waitFor(() => root.querySelectorAll('.map-card').length === 8, '只加了勾上的 3 处');
  const data = await decl.invoke('places', 'list', []);
  const ids = data.places.map((p) => p.id).sort();
  assert.ok(ids.includes('riverside-home'), '勾了的家要加进去');
  assert.ok(!ids.includes('riverside-levee-steps'), '没勾的那处不该出现');
  // 原来写好的描写还在
  assert.equal(data.places.find((p) => p.id === 'forest-creek').desc, '一条很浅的溪，石头是青的');
});

test('勾选表：一套已经全加完时，明说「都已在图上」而不是给一张点不动的灰表', async () => {
  // 2026-11-15 真机反馈「点不动」：原来这时勾选表全是灰的、按钮禁用，
  // 看着跟坏了一样。现在直接说清楚，只留一个「取消」。
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  pickTerrain(root, '林间'); // 这一套已经全加过了
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '出现勾选表');

  const picker = root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer'));
  assert.ok(picker.textContent.includes('都已在图上'), `该明说全加完了：${picker.textContent.slice(0, 80)}`);
  // 没有可勾的行（不给点不动的东西）
  assert.equal(picker.querySelectorAll('.map-pick-on').length, 0, '都已经有了就不该再有可勾的行');
  // 只留一个能用的「取消」
  const btns = picker.findAll((n) => n.tagName === 'BUTTON');
  assert.equal(btns.length, 1, '只该剩一个按钮');
  assert.equal(btns[0].textContent, '取消');
  assert.notEqual(btns[0].disabled, true, '「取消」必须是可点的');
});

test('管理默认收起，展开才显示地形、刷新、批量与导入，收起后保留浏览状态', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  const manage = () => button(root, '管理');
  const assertClosed = () => {
    assert.equal(manage().getAttribute('aria-expanded'), 'false');
    assert.equal(root.querySelectorAll('.map-terrain').length, 0);
    assert.equal(button(root, '刷新'), undefined);
    assert.equal(button(root, '批量管理'), undefined);
    assert.equal(field(root, '导入 JSON'), undefined);
    assert.ok(button(root, '加一处'), '新增入口应始终可用');
  };
  assertClosed();
  type(field(root, searchLabel), '溪边');
  readPlace(root, '溪边');
  manage().fire('click');
  assert.equal(manage().getAttribute('aria-expanded'), 'true');
  assert.equal(root.querySelectorAll('.map-terrain').length, 5);
  assert.ok(button(root, '刷新'));
  assert.ok(button(root, '批量管理'));
  assert.ok(field(root, '导入 JSON'));
  assert.ok(button(root, '加一处'));
  manage().fire('click');
  assertClosed();
  assert.equal(field(root, searchLabel).value, '溪边');
  assert.deepEqual(cardNames(root), ['溪边']);
  assert.match(root.querySelector('.map-reading').textContent, /一条很浅的溪/);
});

test('地形是一排按钮，不是下拉（下拉在真机上两次「点不动」）', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  openManagement(root);
  assert.equal(root.querySelector('.map-terrains').querySelector('select'), null, '地形选择不该有 <select>');
  assert.equal(root.querySelectorAll('.map-terrain').length, 5, '该有 5 个地形按钮');
  // 当前地形用一个小标签显示，而不是塞进按钮里假装已选中
  assert.ok(root.textContent.includes('当前'), '该有「当前：林间」这样的标签');

  // 有手动刷新按钮：界面停在旧状态时不用重开 Coo
  const refresh = root.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '刷新')[0];
  assert.ok(refresh, '该有「刷新」按钮');
  assert.equal(refresh.disabled, false);
});

test('点当前那套地形的按钮会切换收起，不会卡死', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  pickTerrain(root, '江边');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '先出勾选表');
  // 再点另一个地形：勾选表应当切到那一套，而不是没反应
  pickTerrain(root, '山脚');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '切到山脚');
  assert.ok(root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).textContent.includes('山脚'), '勾选表该切到山脚');
});

test('勾选表：全选 / 全不选按钮', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  pickTerrain(root, '山脚');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '出现勾选表');

  const onRows = () => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelectorAll('.map-pick-on');
  const btn = (label) => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer'))
    .findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0];

  btn('全不选').fire('click');
  await waitFor(() => onRows().length === 0, '全不选之后一个都不勾');
  // 一条都没勾时：摘要明说、按钮禁用（不给出一个点了没用的按钮）
  assert.ok(root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelector('.map-picked').textContent.includes('还没勾'),
    '全不选时摘要该说「还没勾」');
  const submit0 = root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).findAll((n) => n.tagName === 'BUTTON' && /加进去/.test(n.textContent))[0];
  assert.equal(submit0.disabled, true, '一处都没勾时「加进去」该禁用');

  btn('全选').fire('click');
  await waitFor(() => onRows().length === 5, '全选之后全勾');
});

// ---------------------------------------------------------------------------
// 出图那句：三条全满足才在阅读里出现
// ---------------------------------------------------------------------------

test('scene 提示只在三条全满足时出现，并移到阅读详情', async () => {
  for (const [options, enabled] of [
    [{ imggen: true }, true],
    [{ imggen: false }, false],
    [{ imggen: true, cfg: { mapImggenOn: false } }, false],
  ]) {
    const { mount, tool } = await mountPanels(options);
    await tool('map_edit')({ place: '溪边', scene: '溪边场景' });
    const root = await mount();
    await waitFor(() => cardNames(root).length === 5);
    assert.equal(root.querySelectorAll('.map-chip-scene').length, 0, '卡片应保持简洁');

    const reading = readPlace(root, '溪边');
    const chips = reading.querySelectorAll('.map-chip-scene');
    assert.equal(chips.length, enabled ? 1 : 0);
    if (enabled) assert.match(chips[0].textContent, /溪边场景/);
    else assert.doesNotMatch(reading.textContent, /溪边场景|imggen_draw/);
  }
});

test('详情里明说「库里没有这处就不用填 scene」，绝不指向不存在的场景', async () => {
  const { mount } = await mountPanels({ imggen: true });
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  openPlace(root, '溪边');
  const detail = root.querySelector('.map-detail');
  assert.ok(detail.textContent.includes('不用填'), `该明说不用填：${detail.textContent.slice(-160)}`);
  // 溪边没有 scene，界面绝不能写「scene 填「溪边」」
  assert.ok(!detail.textContent.includes('scene 填「溪边」'), '没登记场景就不许编一个');
});

// ---------------------------------------------------------------------------
// 交互：改 / 传 / 清空 / 标常去
// ---------------------------------------------------------------------------

test('在详情里改描写并保存，卡片跟着变', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  openPlace(root, '溪边');

  const ta = root.querySelector('.map-detail').querySelectorAll('textarea')[0];
  ta.value = '水很浅，底下全是圆石头';
  const saveBtn = root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '存一下')[0];
  assert.ok(saveBtn, '该有保存按钮');
  saveBtn.fire('click');

  await waitFor(() => {
    const card = root.querySelectorAll('.map-card')
      .find((c) => c.querySelector('.map-card-name')?.textContent === '溪边');
    return card?.textContent.includes('水很浅');
  }, '卡片上显示新描写');
});

test('地点关联草稿切卡刷新可恢复，增删目标、保存及清空一致', async () => {
  const { mount, ctx, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  const relationBox = () => root.querySelector('.map-relations');
  const relationSelects = () => relationBox()?.querySelectorAll('select') ?? [];
  const relationNotes = () => relationBox()?.querySelectorAll('input') ?? [];
  openPlace(root, '溪边');
  button(root, '添加关联').fire('click');
  assert.equal(relationSelects().length, 1);
  relationSelects()[0].value = 'forest-old-oak';
  relationSelects()[0].fire('change');
  type(relationNotes()[0], '树影落在溪面');
  openPlace(root, '老橡树');
  openPlace(root, '溪边');
  assert.equal(relationSelects()[0].value, 'forest-old-oak');
  assert.equal(relationNotes()[0].value, '树影落在溪面');
  openManagement(root);
  button(root, '刷新').fire('click');
  await waitFor(() => relationNotes()[0]?.value === '树影落在溪面');
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('存好了'));
  const saved = await decl.invoke('places', 'list', []);
  assert.deepEqual(saved.places.find((p) => p.id === 'forest-creek').relations, [{ placeId: 'forest-old-oak', note: '树影落在溪面' }]);

  await waitFor(() => button(root, '存一下'));
  button(root, '添加关联').fire('click');
  const remove = root.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '删除关联')[1];
  remove.fire('click');
  assert.equal(relationSelects().length, 1, '删除新加的空行不应清掉已保存目标');
  relationSelects()[0].value = '';
  relationSelects()[0].fire('change');
  type(relationNotes()[0], '');
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('目标和说明'));
  assert.deepEqual((await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek').relations, [{ placeId: 'forest-old-oak', note: '树影落在溪面' }]);
});

test('关系保存期间继续编辑不丢，删除全部关联可保存为空数组', async () => {
  const { mount, ctx, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  openPlace(root, '溪边');
  button(root, '添加关联').fire('click');
  const target = field(root, '关联地点');
  target.value = 'forest-old-oak'; target.fire('change');
  type(field(root, '关联说明'), '提交的树影');
  const invoke = ctx.invoke;
  let release;
  ctx.invoke = async (method, args) => {
    if (method === 'edit') await new Promise((resolve) => { release = resolve; });
    return invoke(method, args);
  };
  button(root, '存一下').fire('click');
  await waitFor(() => release);
  type(field(root, '关联说明'), '保存中继续写的树影');
  release();
  await waitFor(() => button(root, '存一下'));
  assert.equal(field(root, '关联说明').value, '保存中继续写的树影');
  assert.equal((await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek').relations[0].note, '提交的树影');
  ctx.invoke = invoke;
  button(root, '删除关联').fire('click');
  assert.equal(root.querySelector('.map-relations').querySelectorAll('select').length, 0);
  openPlace(root, '老橡树'); openPlace(root, '溪边');
  assert.equal(root.querySelector('.map-relations').querySelectorAll('select').length, 0, '空数组草稿也应覆盖已有关系');
  button(root, '存一下').fire('click');
  await waitFor(() => button(root, '存一下'));
  assert.deepEqual((await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek').relations, []);
});

test('关系草稿重挂后明确恢复或丢弃，删除的目标不会被草稿静默保存', async () => {
  const { mount, decl, tool } = await mountPanels();
  const relations = [{ placeId: 'forest-old-oak', note: '树影落在溪面' }];
  const saved = await decl.invoke('places', 'saveDrafts', [{ drafts: [{ id: 'forest-creek', fields: { relationsJson: JSON.stringify(relations) } }] }]);
  assert.equal(saved.ok, true, saved.error);
  const root = await mount();
  await waitFor(() => button(root, '恢复草稿'));
  button(root, '恢复草稿').fire('click');
  assert.equal(field(root, '关联地点').value, 'forest-old-oak');
  assert.equal(field(root, '关联说明').value, '树影落在溪面');
  await decl.invoke('places', 'remove', [{ id: 'forest-old-oak' }]);
  openManagement(root);
  button(root, '刷新').fire('click');
  await waitFor(() => root.querySelectorAll('.map-card').length === 4);
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('目标和说明'));
  assert.deepEqual((await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek').relations, []);
  await mount();
  await waitFor(() => button(root, '丢弃草稿'));
  button(root, '丢弃草稿').fire('click');
  await waitFor(() => !button(root, '丢弃草稿'));
  openPlace(root, '溪边');
  assert.equal(root.querySelector('.map-relations').querySelectorAll('select').length, 0);
});

test('标成常去之后，卡片出现在「常去」那一段', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  openPlace(root, '溪边');
  const btn = root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '标成常去')[0];
  assert.ok(btn, '该有「标成常去」按钮');
  btn.fire('click');
  await waitFor(() => {
    const secs = root.querySelectorAll('.map-sec').map((n) => n.textContent);
    return secs.some((s) => s.includes('常去'));
  }, '出现「★ 常去」那一段');
});

test('清空图之后卡片不再有 <img>', async () => {
  const { mount } = await mountPanels({ withCover: true });
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  await waitFor(() => root.querySelectorAll('img').length >= 1, '先有图');
  openPlace(root, '溪边');
  const btn = root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '清空图')[0];
  assert.ok(btn, '有图时该有「清空图」');
  btn.fire('click');
  await waitFor(() => root.querySelectorAll('img').length === 0, '图清掉之后没有 <img>');
});

test('加一处：填名字点「加进去」，墙上多一张卡', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  const addBtn = root.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '加一处')[0];
  assert.ok(addBtn, '该有「加一处」');
  addBtn.fire('click');
  await waitFor(() => root.querySelectorAll('input').some((i) => i.placeholder === '叫什么'), '出现加地方的输入框');

  const nameIn = root.querySelectorAll('input').find((i) => i.placeholder === '叫什么');
  nameIn.value = '旧码头';
  const submit = root.findAll((n) => n.tagName === 'BUTTON' && n.textContent === '加进去')[0];
  submit.fire('click');

  await waitFor(() => root.querySelectorAll('.map-card').length === 6, '变成 6 张卡');
  assert.ok(root.querySelectorAll('.map-card-name').some((n) => n.textContent === '旧码头'));
});

// ---------------------------------------------------------------------------
// 空态 / 错误
// ---------------------------------------------------------------------------

test('删掉一处要先问一句，且能真的删掉', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  // 桩里没有 window.confirm：先确认「不问就删」这条不成立——面板必须调 window.confirm。
  const calls = [];
  globalThis.window = { confirm: (m) => { calls.push(m); return true; } };
  try {
    openPlace(root, '蘑菇坡');
    const del = root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '删掉这处')[0];
    assert.ok(del, '该有「删掉这处」');
    del.fire('click');
    await waitFor(() => root.querySelectorAll('.map-card').length === 4, '删掉之后剩 4 张');
    assert.equal(calls.length, 1, '该问且只问一次');
    assert.ok(calls[0].includes('删掉'), `问的话要说明删什么：${calls[0]}`);
    assert.ok(!root.querySelectorAll('.map-card-name').some((n) => n.textContent === '蘑菇坡'));
  } finally {
    delete globalThis.window;
  }
});

test('删掉时点了「取消」就什么都不删', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  globalThis.window = { confirm: () => false };
  try {
    openPlace(root, '蘑菇坡');
    root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '删掉这处')[0].fire('click');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(root.querySelectorAll('.map-card').length, 5, '取消之后一张都不该少');
  } finally {
    delete globalThis.window;
  }
});

test('旅行那几处单独成一段，且详情里带「最接近的那处」', async () => {
  const { mount, tool } = await mountPanels();
  await tool('map_add')({ name: '海边小镇', kind: '旅行', desc: '白墙、窄巷、风里有盐味' });
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 6, '画出 6 张卡');

  const secs = root.querySelectorAll('.map-sec').map((n) => n.textContent);
  assert.ok(secs.includes('旅行'), `该有「旅行」那一段：${secs.join(',')}`);

  const detail = openPlace(root, '海边小镇');
  // funVenue 输入框要在（可填、可清空）
  const funIn = detail.querySelectorAll('input').find((i) => (i.getAttribute('aria-label') ?? '').includes('娱乐时间'));
  assert.ok(funIn, '该有 funVenue 输入框');
  assert.equal(funIn.value, '', '没填就不该预置一个场所名');
});

test('详情里填了 funVenue 且装着娱乐时间 → 显示「fun_go 填哪一处」', async () => {
  const { mount, tool } = await mountPanels({ fun: true });
  await tool('map_add')({ name: '海边小镇', kind: '旅行', desc: '白墙窄巷', funVenue: '江边' });
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 6, '画出 6 张卡');
  const detail = openPlace(root, '海边小镇');
  assert.ok(detail.textContent.includes('fun_go'), `该提示 fun_go：${detail.textContent.slice(-200)}`);
  assert.ok(detail.textContent.includes('江边'));
  assert.ok(detail.textContent.includes('最接近'), '要标明是最接近的一处');
});

test('没装娱乐时间或开关关掉 → 详情里不提 fun_go', async () => {
  for (const opts of [{ fun: false }, { fun: true, cfg: { mapFunOn: false } }]) {
    const { mount, tool } = await mountPanels(opts);
    await tool('map_add')({ name: '海边小镇', kind: '旅行', desc: '白墙窄巷', funVenue: '江边' });
    const root = await mount();
    await waitFor(() => root.querySelectorAll('.map-card').length === 6, '画出 6 张卡');
    const text = openPlace(root, '海边小镇').textContent;
    assert.ok(!text.includes('fun_go'), `不该出现 fun_go：${text.slice(-200)}`);
  }
});

test('删除一处之后，地形下拉仍然能用（会出勾选表）', async () => {
  // 2026-11-15 真机反馈：删掉一处之后，下拉就「点不动」了。
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  // 删掉「蘑菇坡」
  globalThis.window = { confirm: () => true };
  try {
    openPlace(root, '蘑菇坡');
    root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '删掉这处')[0].fire('click');
    await waitFor(() => root.querySelectorAll('.map-card').length === 4, '删掉之后剩 4 张');
  } finally {
    delete globalThis.window;
  }

  // 删除之后，地形按钮应当照常工作
  openManagement(root);
  const btns = root.querySelectorAll('.map-terrain');
  assert.equal(btns.length, 5, '删除之后地形按钮还在');
  assert.ok(btns.every((b) => b.disabled !== true), '删除之后按钮都不该被禁用');
  pickTerrain(root, '山脚');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '删除之后仍能出勾选表');
});

test('删除一处之后，「加一处」仍然能用', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  globalThis.window = { confirm: () => true };
  try {
    openPlace(root, '蘑菇坡');
    root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '删掉这处')[0].fire('click');
    await waitFor(() => root.querySelectorAll('.map-card').length === 4, '删掉之后剩 4 张');
  } finally {
    delete globalThis.window;
  }

  const addBtn = root.findAll((n) => n.tagName === 'BUTTON' && /加一处|取消/.test(n.textContent))[0];
  assert.ok(addBtn, '删除之后「加一处」还在');
  addBtn.fire('click');
  await waitFor(() => root.querySelectorAll('input').some((i) => i.placeholder === '叫什么'), '删除之后仍能出加地方的表单');
});

test('勾选表开着的时候删掉一处，勾选表仍然能用', async () => {
  // 这条钉的是 state.picked / pickedFor 的陈旧状态：删除会改 exists，
  // 如果 picker 不重新按 exists 初始化，就会出现「勾了也不生效、按钮灰着」的假死。
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  // 先开一个勾选表（江边，5 处都没加）
  pickTerrain(root, '江边');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '先出勾选表');

  // 再把「蘑菇坡」删掉
  globalThis.window = { confirm: () => true };
  try {
    openPlace(root, '蘑菇坡');
    root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '删掉这处')[0].fire('click');
    await waitFor(() => root.querySelectorAll('.map-card').length === 4, '删掉之后剩 4 张');
  } finally {
    delete globalThis.window;
  }

  // 勾选表应该还在，而且按钮可点
  const picker = root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer'));
  assert.ok(picker, '删除之后勾选表还该在');
  const submit = picker.findAll((n) => n.tagName === 'BUTTON' && /加进去/.test(n.textContent))[0];
  assert.ok(submit, '勾选表里该有「加进去」');
  assert.notEqual(submit.disabled, true, `默认全选，按钮该可点（实际 disabled=${submit.disabled}）`);
});

test('守门断言：按钮上的处数必须等于「看起来勾着的行数」（不能写 5 处却一个没勾）', async () => {
  // 2026-11-15 真机截图：五个框全空着，按钮却写「加进去（5 处）」——完全没法判断。
  // 这条把「看到的」和「实际会加的」钉死成同一个数。
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  const check = (label) => {
    const picker = root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer'));
    assert.ok(picker, `「${label}」时该有勾选表`);
    const on = picker.querySelectorAll('.map-pick-on').length;
    const btn = picker.findAll((n) => n.tagName === 'BUTTON' && /加进去/.test(n.textContent))[0];
    const n = Number((/（(\d+) 处）/.exec(btn.textContent) ?? [])[1]);
    assert.equal(n, on, `「${label}」时按钮写 ${n} 处，但看着勾着的是 ${on} 行`);
    // 摘要里的数字也得是同一个
    const m = Number((/(\d+) 处/.exec(picker.querySelector('.map-picked').textContent) ?? [])[1] ?? 0);
    assert.equal(m, on, `「${label}」时摘要写 ${m} 处，但看着勾着的是 ${on} 行`);
    return on;
  };

  pickTerrain(root, '江边');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '出勾选表');
  assert.equal(check('默认'), 5, '默认该是 5 处且 5 行亮着');

  // 逐行点掉，每一步都要自洽
  for (const want of [4, 3, 2, 1, 0]) {
    const rows = root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelectorAll('.map-pick-on');
    rows[0].fire('click');
    await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelectorAll('.map-pick-on').length === want,
      `点掉一行后剩 ${want}`);
    assert.equal(check(`剩 ${want}`), want);
  }
});

test('summary：没勾时明说「还没勾」，勾了就列出名字', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  pickTerrain(root, '山脚');
  await waitFor(() => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')), '出勾选表');

  const summary = () => root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelector('.map-picked').textContent;
  assert.ok(summary().includes('5 处'), summary());
  for (const name of ['家', '上山口', '山泉', '半坡亭', '碎石坡']) {
    assert.ok(summary().includes(name), `摘要该列出「${name}」：${summary()}`);
  }

  // 全不选 → 明确说还没勾
  root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).findAll((n) => n.tagName === 'BUTTON' && n.textContent === '全不选')[0].fire('click');
  await waitFor(() => summary().includes('还没勾'), '全不选后摘要该说还没勾');

  // 点一行 → 摘要只列那一处
  root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).querySelectorAll('.map-pick').find((r) => r.querySelector('.map-pick-name').textContent === '山泉').fire('click');
  await waitFor(() => summary().includes('山泉'), '点了「山泉」摘要该列出来');
  assert.ok(!summary().includes('半坡亭'), `没勾的不该出现在摘要里：${summary()}`);
});

test('空地图：给的是「选一套地形」的引导，不是空白', async () => {
  const root = await mkdtemp(join(tmpdir(), `map-empty-${run}-`));
  const dataDir = join(root, 'data', 'home', 'companion');
  await mkdir(dataDir, { recursive: true });
  const world = new MapWorld({ cfg: { ...DEFAULTS, enabled: true }, dataDir, timezone: 'Asia/Shanghai', persist: () => {} });
  await world.start({ log: { info() {}, warn() {} } });
  const decl = world.webUi('zh');
  const b = await import('../dist/webui.js?' + Math.random());
  const domRoot = new Node('div');
  const ctx = {
    pageId: 'world:map', panelId: 'places', language: 'zh', root: domRoot,
    signal: { aborted: false },
    timeout() { return { dispose() {} }; },
    interval() { return { dispose() {} }; },
    async invoke(method, args) { return decl.invoke('places', method, args ?? []); },
  };
  await b.default.panels.places.mount(ctx);
  await waitFor(() => domRoot.querySelector('.map-empty'), '画出空态');
  const emptyText = domRoot.querySelector('.map-empty').textContent;
  assert.ok(emptyText.includes('还是空的'), emptyText);
  assert.ok(emptyText.includes('地形'), `该引导选地形：${emptyText}`);
});

test('list 失败时有错误卡，不抛到面板外面', async () => {
  const { mount } = await mountPanels({ failList: true });
  const root = await mount();
  await waitFor(() => root.querySelector('.map-err'), '画出错误卡');
  assert.ok(root.querySelector('.map-err').textContent.includes('面板加载失败'));
});

test('面板每分钟刷一次，且返回 refresh', async () => {
  const { bundle, decl, root } = await mountPanels();
  void bundle;
  const domRoot = new Node('div');
  const intervals = [];
  const ctx = {
    pageId: 'world:map', panelId: 'places', language: 'zh', root: domRoot,
    signal: { aborted: false },
    timeout() { return { dispose() {} }; },
    interval(fn, ms) { intervals.push({ fn, ms }); return { dispose() {} }; },
    async invoke(method, args) { return decl.invoke('places', method, args ?? []); },
  };
  const ret = await bundle.default.panels.places.mount(ctx);
  assert.equal(typeof ret.refresh, 'function');
  assert.equal(intervals.length, 1, '该只挂一个 interval');
  assert.equal(intervals[0].ms, 60000);
  void root;
});

test('老宿主没有 ctx.interval 也能挂起来（不整片白）', async () => {
  const { bundle, decl } = await mountPanels();
  const domRoot = new Node('div');
  const ctx = {
    pageId: 'world:map', panelId: 'places', language: 'zh', root: domRoot,
    signal: { aborted: false },
    // 故意不给 interval
    timeout() { return { dispose() {} }; },
    async invoke(method, args) { return decl.invoke('places', method, args ?? []); },
  };
  await bundle.default.panels.places.mount(ctx);
  await waitFor(() => domRoot.querySelectorAll('.map-card').length === 5, '没有 interval 也画出卡片');
  assert.equal(domRoot.querySelector('.map-err'), null, '不该掉进错误卡');
});

test('英文界面也能挂起来（label 走英文文案）', async () => {
  const { mount } = await mountPanels({ language: 'en' });
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  assert.ok(root.textContent.includes('places') || root.textContent.includes('Around'), root.textContent.slice(0, 120));
});

// Draft regressions exercise redraws, failed requests and out-of-order responses.

test('草稿按地点独立：切换、自动刷新和失败重绘保留全部输入，成功后清理', async () => {
  const { mount, ctx, intervals, tool } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  openPlace(root, '溪边');
  type(field(root, 'name'), '溪边草稿');
  type(field(root, '描写'), '未存溪边');
  type(field(root, '别名（逗号分开）'), '浅溪,小溪');
  type(field(root, 'kind'), 'travel');
  openPlace(root, '老橡树');
  type(field(root, '描写'), '未存橡树');
  openPlace(root, '溪边');
  assert.equal(field(root, 'name').value, '溪边草稿');
  assert.equal(field(root, 'kind').value, 'travel');
  intervals[0].fn();
  await waitFor(() => field(root, '描写')?.value === '未存溪边');
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => method === 'edit' ? { ok: false, error: '保存失败' } : invoke(method, args);
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('保存失败'));
  assert.equal(field(root, '描写').value, '未存溪边');
  assert.equal(field(root, '别名（逗号分开）').value, '浅溪,小溪');
  ctx.invoke = invoke;
  button(root, '存一下').fire('click');
  await waitFor(() => root.querySelectorAll('.map-card-name').some((n) => n.textContent === '溪边草稿'));
  await tool('map_edit')({ place: '溪边草稿', desc: '服务端后续修改' });
  openManagement(root);
  button(root, '刷新').fire('click');
  await waitFor(() => field(root, '描写')?.value === '服务端后续修改');
  openPlace(root, '老橡树');
  assert.equal(field(root, '描写').value, '未存橡树');
});

test('新增草稿跨取消、刷新和失败保留，保存成功清空', async () => {
  const { mount, ctx } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  button(root, '加一处').fire('click');
  type(field(root, '叫什么'), '草稿码头');
  type(field(root, '一句话描写（空间、陈设、配色、光线，不写她在干什么）'), '木头栏杆');
  button(root, '取消').fire('click');
  button(root, '加一处').fire('click');
  assert.equal(field(root, '叫什么').value, '草稿码头');
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => method === 'add' ? { ok: false, error: '新增失败' } : invoke(method, args);
  button(root, '加进去').fire('click');
  await waitFor(() => root.textContent.includes('新增失败'));
  assert.equal(field(root, '叫什么').value, '草稿码头');
  ctx.invoke = invoke;
  openManagement(root);
  button(root, '刷新').fire('click');
  await waitFor(() => field(root, '叫什么')?.value === '草稿码头');
  button(root, '加进去').fire('click');
  await waitFor(() => root.querySelectorAll('.map-card').length === 6);
  button(root, '加一处').fire('click');
  assert.equal(field(root, '叫什么').value, '');
});

test('旧list成功或失败均不能覆盖新响应，保存期间继续输入仍保留', async () => {
  const { bundle, decl } = await mountPanels();
  const root = new Node('div');
  const pending = [];
  let deferred = false;
  let releaseEdit;
  const ctx = { root, language: 'zh', signal: { aborted: false },
    async invoke(method, args) {
      if (method === 'list' && deferred) return new Promise((resolve, reject) => pending.push({ resolve, reject }));
      if (method === 'edit') await new Promise((resolve) => { releaseEdit = resolve; });
      return decl.invoke('places', method, args ?? []);
    } };
  const panel = bundle.default.panels.places.mount(ctx);
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  const data = await decl.invoke('places', 'list', []);
  deferred = true;
  const older = panel.refresh();
  const newer = panel.refresh();
  const fresh = structuredClone(data);
  fresh.places[0].name = '最新名字';
  pending[1].resolve(fresh);
  await newer;
  pending[0].resolve(data);
  await older;
  assert.ok(root.textContent.includes('最新名字'));
  const oldFailure = panel.refresh();
  const latest = panel.refresh();
  pending[3].resolve(fresh);
  await latest;
  pending[2].reject(new Error('过期错误'));
  await oldFailure;
  assert.ok(!root.textContent.includes('过期错误'));
  deferred = false;
  openPlace(root, '溪边');
  type(field(root, '描写'), '提交的版本');
  button(root, '存一下').fire('click');
  await waitFor(() => releaseEdit);
  type(field(root, '描写'), '请求期间继续写');
  releaseEdit();
  await waitFor(() => root.textContent.includes('存好了'));
  assert.equal(field(root, '描写').value, '请求期间继续写');
});

test('加载失败和渲染失败后重试，草稿仍可恢复并继续编辑', async () => {
  const { mount, ctx, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  openPlace(root, '溪边');
  type(field(root, '描写'), '错误之后也要留下');
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => {
    if (method === 'list') throw new Error('临时断线');
    return invoke(method, args);
  };
  openManagement(root);
  button(root, '刷新').fire('click');
  await waitFor(() => root.textContent.includes('临时断线'));
  assert.equal(field(root, '描写').value, '错误之后也要留下');
  const data = await decl.invoke('places', 'list', []);
  ctx.invoke = async (method, args) => method === 'list' ? { ...data, summary: null } : invoke(method, args);
  openManagement(root);
  button(root, '刷新').fire('click');
  await waitFor(() => root.textContent.includes('画面刷新失败'));
  ctx.invoke = invoke;
  button(root, '重新载入').fire('click');
  await waitFor(() => field(root, '描写')?.value === '错误之后也要留下');
  type(field(root, '描写'), '恢复后继续写');
  openPlace(root, '老橡树');
  openPlace(root, '溪边');
  assert.equal(field(root, '描写').value, '恢复后继续写');
});

test('完整度和联动状态移到阅读，区分关、未启用、未填及可提示', async () => {
  for (const [opts, expected, scene] of [
    [{ imggen: true, cfg: { mapImggenOn: false } }, '生图：关'],
    [{ imggen: false }, '生图：未启用'],
    [{ imggen: true }, '生图：未填场景'],
    [{ imggen: true }, '生图：已填可提示', '主人填写的场景'],
  ]) {
    const { mount, tool } = await mountPanels(opts);
    if (scene) await tool('map_edit')({ place: '溪边', scene });
    const root = await mount();
    await waitFor(() => cardNames(root).length === 5);
    for (const tile of root.querySelectorAll('.map-card')) {
      assert.doesNotMatch(tile.textContent, /完整度|生图：|娱乐：/);
    }
    const reading = readPlace(root, '溪边');
    assert.match(reading.textContent, /完整度.*\d\/5/);
    assert.ok(reading.textContent.includes(expected), expected);
    assert.doesNotMatch(reading.textContent, /素材库里没有这处/);
  }
});

test('示例描写开关默认关闭，勾选后terrain传boolean且重绘保留', async () => {
  const { mount, invocations } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  pickTerrain(root, '江边');
  assert.equal(Boolean(field(root, '使用示例描写').checked), false);
  const toggle = field(root, '使用示例描写');
  toggle.checked = true;
  toggle.fire('change');
  button(root, '全不选').fire('click');
  assert.equal(field(root, '使用示例描写').checked, true);
  button(root, '全选').fire('click');
  root.querySelectorAll('.map-picker').find((n) => !n.classList.contains('map-transfer')).findAll((n) => n.tagName === 'BUTTON' && /加进去/.test(n.textContent))[0].fire('click');
  await waitFor(() => invocations.some((r) => r.method === 'terrain'));
  assert.equal(invocations.find((r) => r.method === 'terrain').args[0].withDescriptions, true);
});

test('一个搜索框匹配名称、别名、标签和地形，仍可叠加精确标签与状态筛选', async () => {
  const { mount, tool } = await mountPanels();
  await tool('map_edit')({ place: '溪边', aliases: ['浅溪'], tags: ['水边'] });
  await tool('map_edit')({ place: '老橡树', tags: ['水边树荫'] });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);

  const search = () => field(root, searchLabel);
  const count = () => root.querySelector('.map-results-count').textContent;
  assert.equal(root.querySelectorAll('input').filter((n) => n.getAttribute('type') === 'search').length, 1);
  for (const query of ['溪边', '浅溪']) {
    type(search(), query);
    assert.deepEqual(cardNames(root), ['溪边']);
  }
  type(search(), '林间');
  assert.equal(cardNames(root).length, 5, '按地形搜索');
  type(search(), '水边');
  assert.deepEqual(cardNames(root).sort(), ['老橡树', '溪边'].sort());
  assert.match(count(), /当前显示 2 处/);

  const tags = field(root, '筛选标签');
  assert.equal(tags.tagName, 'SELECT');
  tags.value = '水边'; tags.fire('change');
  assert.deepEqual(cardNames(root), ['溪边'], '精确标签筛选应排除包含相同字样的其他标签');
  assert.match(count(), /当前显示 1 处/);

  const filter = field(root, '筛选地点');
  filter.value = 'noDesc'; filter.fire('change');
  assert.deepEqual(cardNames(root), []);
  assert.match(count(), /当前显示 0 处/);
  button(root, '清除筛选').fire('click');
  assert.equal(search().value, '');
  assert.equal(field(root, '筛选标签').value, '');
  assert.equal(field(root, '筛选地点').value, 'all');
  assert.equal(cardNames(root).length, 5);
  assert.match(count(), /当前显示 5 处/);
});

test('住所候选的设为当前住所按钮实际调用 setHome 并更新状态', async () => {
  const { mount, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  openPlace(root, '家');
  await waitFor(() => root.querySelector('.map-detail'));
  const before = root.textContent;
  button(root, '设为当前住所').fire('click');
  await waitFor(() => root.textContent !== before && root.textContent.includes('当前住所'));
  const result = await decl.invoke('places', 'list', []);
  assert.equal(result.homeId, 'forest-home');
});

test('住所横幅能打开阅读，且住所卡片照常参与筛选和计数', async () => {
  const { mount, decl, tool } = await mountPanels();
  await tool('map_edit')({ place: '家', desc: '窗台边有一盏灯' });
  assert.equal((await decl.invoke('places', 'setHome', [{ id: 'forest-home' }])).ok, true);
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);

  const banner = root.querySelector('.map-home-banner');
  assert.ok(banner, '设置当前住所后应出现横幅');
  assert.match(banner.textContent, /窗台边有一盏灯/);
  assert.equal(cardNames(root).filter((name) => name === '家').length, 1);
  button(banner, '查看住所').fire('click');
  const reading = root.querySelector('.map-reading');
  assert.match(reading.textContent, /窗台边有一盏灯/);
  assert.equal(root.querySelector('.map-detail'), null);
  button(reading, '收起').fire('click');
  type(field(root, searchLabel), '家');
  assert.deepEqual(cardNames(root), ['家']);
  assert.match(root.querySelector('.map-results-count').textContent, /当前显示 1 处/);
  type(field(root, searchLabel), '溪边');
  assert.deepEqual(cardNames(root), ['溪边']);
});

test('关系入口从卡片或关系视图打开目标，放在结果之前并保留筛选', async () => {
  const { mount, tool } = await mountPanels();
  await tool('map_edit')({ place: '溪边', tags: ['水边'], relations: [{ placeId: 'forest-old-oak', note: '树影落在溪面' }] });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  type(field(root, searchLabel), '溪边');
  const tags = field(root, '筛选标签');
  tags.value = '水边'; tags.fire('change');
  const read = () => root.querySelector('.map-reading');
  const count = () => root.querySelector('.map-results-count');
  const checkTarget = () => {
    assert.match(read().querySelector('h3').textContent, /老橡树/);
    assert.match(read().textContent, /树皮裂成一块一块/);
    assert.match(read().textContent, /被哪些地点提到.*溪边.*树影落在溪面/);
    assert.equal(root.querySelector('.map-detail'), null);
    const order = [...root.walk()];
    assert.ok(order.indexOf(read()) < order.indexOf(count()), '目标阅读应显示在结果之前');
    assert.equal(field(root, searchLabel).value, '溪边');
    assert.equal(field(root, '筛选标签').value, '水边');
    assert.match(count().textContent, /当前显示 1 处/);
  };

  root.scrollTop = 145;
  button(readPlace(root, '溪边'), '老橡树').fire('click');
  assert.deepEqual(cardNames(root), ['溪边']);
  checkTarget();
  root.scrollTop = 24;
  button(read(), '返回上一处').fire('click');
  assert.match(read().querySelector('h3').textContent, /溪边/);
  assert.equal(globalThis.document.activeElement, button(read(), '老橡树'));
  assert.equal(root.scrollTop, 145);
  button(read(), '收起').fire('click');

  const view = () => root.querySelector('.map-view');
  assert.equal(view().querySelector('select'), null, '视图切换使用按钮');
  assert.equal(button(view(), '卡片视图').getAttribute('aria-pressed'), 'true');
  button(view(), '关系视图').fire('click');
  assert.equal(button(view(), '关系视图').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(cardNames(root), []);
  const relations = root.querySelector('.map-relations-view');
  assert.match(relations.textContent, /树影落在溪面/);
  button(relations, '老橡树').fire('click');
  checkTarget();
  button(read(), '返回上一处').fire('click');
  assert.equal(read(), null);
  assert.equal(globalThis.document.activeElement, button(root.querySelector('.map-relations-view'), '老橡树'));
  assert.equal(button(view(), '关系视图').getAttribute('aria-pressed'), 'true');
  button(view(), '卡片视图').fire('click');
  assert.deepEqual(cardNames(root), ['溪边']);
});

test('封面可查看原图，焦点调整同时更新两种预览并写入卡片', async () => {
  const { mount, decl } = await mountPanels({ withCover: true });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  const read = readPlace(root, '溪边');
  const trigger = read.querySelector('.map-original-trigger');
  trigger.fire('click');
  const dialog = read.querySelector('dialog');
  await waitFor(() => dialog.querySelector('img'));
  assert.match(dialog.querySelector('img').src, /^data:image\/png;base64,/);
  button(dialog, '关闭原图').fire('click');
  assert.equal(globalThis.document.activeElement, trigger);
  button(read, '编辑').fire('click');
  const settings = root.querySelector('.map-focus-settings');
  settings.open = true;
  settings.fire('toggle');
  const save = button(settings, '保存焦点');
  await waitFor(() => !save.disabled);
  const [original, banner, card] = settings.querySelectorAll('img');
  assert.equal(banner.src, original.src);
  assert.equal(card.src, original.src);
  const preview = settings.querySelector('.map-focus-preview');
  assert.ok(preview.querySelector('.map-focus-frame'), '原图预览应显示裁切矩形');
  original.naturalWidth = 100;
  original.naturalHeight = 200;
  original.fire('load');
  const [bannerFrame, cardFrame] = preview.querySelectorAll('.map-focus-frame');
  assert.equal(bannerFrame.style.width, '100%');
  assert.equal(bannerFrame.style.height, '31.25%');
  assert.equal(cardFrame.style.height, '28.125%');
  button(settings, '主体靠上').fire('click');
  assert.equal(banner.style.objectPosition, '50% 15%');
  assert.ok(Math.abs(parseFloat(bannerFrame.style.top) - 10.3125) < 0.0001);
  button(settings, '恢复已保存焦点').fire('click');
  assert.equal(banner.style.objectPosition, '50% 50%');
  const css = root.querySelectorAll('style').map((style) => style.textContent).join('\n');
  assert.match(css, /\.map-focus-frame\{[^}]*\binset:/, '裁切框应覆盖预览内的矩形区域');
  assert.match(css, /\.map-focus-frame\{[^}]*\bpointer-events\s*:\s*none/, '裁切框不能拦截拖动');
  preview.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 });
  preview.fire('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: 50 });
  preview.fire('pointermove', { pointerId: 1, clientX: 60, clientY: 90 });
  preview.fire('pointerup', { pointerId: 1 });
  assert.equal(banner.style.objectPosition, '25% 70%');
  assert.equal(card.style.objectPosition, '25% 70%');
  save.fire('click');
  await waitFor(() => root.textContent.includes('封面焦点已保存'));
  const list = await decl.invoke('places', 'list', []);
  assert.deepEqual(list.places.find((p) => p.id === 'forest-creek').coverFocus, { x: 25, y: 70 });
  const creek = root.querySelectorAll('.map-card').find((c) => c.querySelector('.map-card-name').textContent === '溪边');
  assert.equal(creek.querySelector('img').style.objectPosition, '25% 70%');
});

test('更多筛选可折叠，并在切快捷筛选后保留展开状态', async () => {
  const { mount } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  const toggle = () => button(root, '更多筛选');
  const extra = () => root.querySelector('.map-filter-extra');
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.notEqual(extra().getAttribute('hidden'), undefined);
  toggle().fire('click');
  assert.equal(extra().getAttribute('hidden'), undefined);
  button(root, '缺描写').fire('click');
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(extra().getAttribute('hidden'), undefined);
  toggle().fire('click');
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
});

test('编辑冲突保留草稿并允许载入当前版本', async () => {
  const { mount, ctx, tool } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  openPlace(root, '溪边');
  type(field(root, '描写'), '我的未保存版本');
  await tool('map_edit')({ place: '溪边', desc: '服务器的新版本' });
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('载入当前版本'));
  assert.equal(field(root, '描写').value, '我的未保存版本');
  button(root, '载入当前版本').fire('click');
  await waitFor(() => field(root, '描写')?.value === '服务器的新版本');
  assert.ok(!root.textContent.includes('载入当前版本'));
  void ctx;
});

test('三方比较自动合并不同字段并使用当前版本重试保存', async () => {
  const { mount, decl, ctx, tool } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openPlace(root, '溪边');
  type(field(root, '描写'), '我的新描写');
  await tool('map_edit')({ place: '溪边', tags: ['远端标签'], scene: '远端场景' });
  const calls = [];
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => {
    const result = await invoke(method, args);
    if (method === 'edit') calls.push({ args: structuredClone(args), result });
    return result;
  };
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('存好了'));
  assert.equal(calls.length, 2, '不同字段只需自动重试，不需要用户选覆盖');
  assert.equal(calls[0].result.conflict, true);
  assert.equal(calls[1].args[0].expectedRevision, calls[0].result.current.revision);
  const place = (await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek');
  assert.equal(place.desc, '我的新描写');
  assert.deepEqual(place.tags, ['远端标签']);
  assert.equal(place.scene, '远端场景');
  assert.equal(root.querySelector('.map-edit-conflicts'), null);
});

test('三方比较仅对双方不同的字段逐项选择并保留其他改动', async () => {
  const { mount, decl, tool } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openPlace(root, '溪边');
  type(field(root, '描写'), '我的描写');
  type(field(root, '画风'), '我的画风');
  await tool('map_edit')({ place: '溪边', desc: '当前描写', tags: ['当前标签'] });
  button(root, '存一下').fire('click');
  await waitFor(() => root.querySelector('.map-edit-conflict'));
  assert.deepEqual(root.querySelectorAll('.map-edit-conflict').map((row) => row.getAttribute('data-field')), ['desc']);
  assert.equal(field(root, '画风').value, '我的画风');
  assert.equal(field(root, '标签（逗号分开）').value, '当前标签');
  button(root, '采用当前：描写').fire('click');
  assert.equal(root.querySelector('.map-edit-conflicts'), null);
  assert.equal(field(root, '描写').value, '当前描写');
  assert.equal(field(root, '画风').value, '我的画风');
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('存好了'));
  const place = (await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek');
  assert.equal(place.desc, '当前描写');
  assert.equal(place.style, '我的画风');
  assert.deepEqual(place.tags, ['当前标签']);
});

test('逐项选择后仍用版本守卫，旧批量按钮只覆盖冲突字段', async () => {
  const { mount, decl, ctx, tool } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openPlace(root, '溪边');
  type(field(root, '描写'), '我的描写');
  type(field(root, '画风'), '我的画风');
  await tool('map_edit')({ place: '溪边', desc: '当前描写', style: '当前画风', tags: ['当前标签'] });
  let saves = 0;
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => { if (method === 'edit') ++saves; return invoke(method, args); };
  button(root, '存一下').fire('click');
  await waitFor(() => root.querySelectorAll('.map-edit-conflict').length === 2);
  button(root, '存一下').fire('click');
  assert.equal(saves, 1, '冲突未选完之前不能保存');
  button(root, '保留我的：描写').fire('click');
  assert.deepEqual(root.querySelectorAll('.map-edit-conflict').map((row) => row.getAttribute('data-field')), ['style']);
  button(root, '采用当前：画风').fire('click');
  await tool('map_edit')({ place: '溪边', desc: '又更新的描写', tags: ['又更新的标签'] });
  button(root, '存一下').fire('click');
  await waitFor(() => root.querySelector('.map-edit-conflict'));
  assert.equal(saves, 2);
  assert.deepEqual(root.querySelectorAll('.map-edit-conflict').map((row) => row.getAttribute('data-field')), ['desc']);
  button(root, '保留草稿，确认覆盖').fire('click');
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('存好了'));
  const place = (await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek');
  assert.equal(place.desc, '我的描写');
  assert.equal(place.style, '当前画风');
  assert.deepEqual(place.tags, ['又更新的标签']);
});

test('相同字段相同结果不冲突，改回原值视为未修改', async () => {
  const { mount, decl, tool } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openPlace(root, '溪边');
  const originalStyle = field(root, '画风').value;
  type(field(root, '描写'), '双方相同描写');
  type(field(root, '画风'), '临时画风');
  type(field(root, '画风'), originalStyle);
  await tool('map_edit')({ place: '溪边', desc: '双方相同描写', style: '远端画风' });
  button(root, '存一下').fire('click');
  await waitFor(() => root.textContent.includes('存好了'));
  assert.equal(root.querySelector('.map-edit-conflicts'), null);
  const place = (await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek');
  assert.equal(place.desc, '双方相同描写');
  assert.equal(place.style, '远端画风');
});

test('恢复含原始版本的草稿后仍按原始值比较冲突', async () => {
  const { mount, decl, tool } = await mountPanels();
  const original = (await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek');
  const fields = {
    name: original.name, desc: original.desc, style: original.style, aliases: original.aliases.join('、'),
    tags: original.tags.join('、'), kind: original.kind, scene: original.scene, funVenue: original.funVenue,
    relationsJson: JSON.stringify(original.relations),
  };
  await decl.invoke('places', 'saveDrafts', [{ drafts: [{ id: original.id, fields: { desc: '恢复的描写', style: '恢复的画风' }, base: { revision: original.revision, fields } }] }]);
  await tool('map_edit')({ place: '溪边', desc: '恢复前远端描写', tags: ['恢复前标签'] });
  const root = await mount();
  await waitFor(() => button(root, '恢复草稿'));
  button(root, '恢复草稿').fire('click');
  await waitFor(() => field(root, '描写')?.value === '恢复的描写');
  button(root, '存一下').fire('click');
  await waitFor(() => root.querySelector('.map-edit-conflict'));
  assert.deepEqual(root.querySelectorAll('.map-edit-conflict').map((row) => row.getAttribute('data-field')), ['desc']);
  button(root, '载入当前版本').fire('click');
  assert.equal(field(root, '描写').value, '恢复前远端描写');
  assert.equal(field(root, '画风').value, '恢复的画风', '载入当前只处理冲突字段');
  assert.equal(field(root, '标签（逗号分开）').value, '恢复前标签');
});

test('未解决冲突持久化原始版本，重挂不能跳过字段选择', async () => {
  const { mount, decl, ctx, tool } = await mountPanels();
  const original = (await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek');
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  let persisted;
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => {
    const result = await invoke(method, args);
    if (method === 'saveDrafts') persisted = structuredClone(args[0].drafts);
    return result;
  };
  openPlace(root, '溪边');
  type(field(root, '描写'), '未解决的描写');
  await tool('map_edit')({ place: '溪边', desc: '当前保存描写' });
  button(root, '存一下').fire('click');
  await waitFor(() => root.querySelector('.map-edit-conflict'));
  await waitFor(() => persisted?.some((draft) => draft.id === original.id));
  const draft = persisted.find((entry) => entry.id === original.id);
  assert.equal(draft.base.revision, original.revision);
  assert.equal(draft.base.fields.desc, original.desc);
  assert.equal(draft.fields.desc, '未解决的描写');
  const remount = await mount();
  await waitFor(() => button(remount, '恢复草稿'));
  button(remount, '恢复草稿').fire('click');
  await waitFor(() => field(remount, '描写')?.value === '未解决的描写');
  button(remount, '存一下').fire('click');
  await waitFor(() => remount.querySelector('.map-edit-conflict'));
  assert.equal((await decl.invoke('places', 'list', [])).places.find((p) => p.id === original.id).desc, '当前保存描写');
});

test('保存请求期间改回原始值仍作为新草稿保留', async () => {
  const { mount, ctx, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openPlace(root, '溪边');
  const original = field(root, '描写').value;
  type(field(root, '描写'), '本次提交描写');
  let release;
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => {
    if (method === 'edit') await new Promise((resolve) => { release = resolve; });
    return invoke(method, args);
  };
  button(root, '存一下').fire('click');
  await waitFor(() => release);
  type(field(root, '描写'), original);
  release();
  await waitFor(() => root.textContent.includes('存好了'));
  assert.equal(field(root, '描写').value, original);
  assert.equal((await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-creek').desc, '本次提交描写');
});

test('草稿经后端 saveDrafts 预置后重挂可恢复或丢弃', async () => {
  const { mount, decl, dataDir } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  assert.equal((await decl.invoke('places', 'saveDrafts', [{ drafts: [{ id: 'forest-creek', fields: { desc: '重挂恢复的草稿' } }] }])).ok, true);

  const remount = await mount();
  await waitFor(() => remount.textContent.includes('恢复草稿'));
  button(remount, '恢复草稿').fire('click');
  await waitFor(() => field(remount, '描写')?.value === '重挂恢复的草稿');

  await decl.invoke('places', 'saveDrafts', [{ drafts: [{ id: 'forest-creek', fields: { desc: '待丢弃' } }] }]);
  const again = await mount();
  await waitFor(() => again.textContent.includes('丢弃草稿'));
  button(again, '丢弃草稿').fire('click');
  await waitFor(() => !again.textContent.includes('恢复草稿'));
  assert.deepEqual((await decl.invoke('places', 'drafts', [])).drafts, []);
  void dataDir;
});

test('导入文件经预览后需明确确认才会导入', async () => {
  const { mount, ctx, decl, tool } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  await tool('map_add')({ name: '外来地点', kind: 'nearby', desc: '导入测试地点' });
  const bundle = (await decl.invoke('places', 'export', [])).bundle;
  const importedPlace = (await decl.invoke('places', 'list', [])).places.find((p) => p.name === '外来地点');
  assert.ok(importedPlace);
  assert.equal((await decl.invoke('places', 'remove', [{ id: importedPlace.id }])).ok, true);

  const calls = [];
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => {
    calls.push(method);
    return invoke(method, args);
  };
  openManagement(root);
  field(root, '导入模式').value = 'skip';
  const fileInput = field(root, '导入 JSON');
  fileInput.files = [{ size: 12, async text() { return JSON.stringify(bundle); } }];
  fileInput.fire('change');
  await waitFor(() => calls.includes('previewImport') || root.textContent.includes('地点必须') || root.querySelector('.map-err'), '预览完成或错误');
  assert.ok(calls.includes('previewImport'), root.querySelector('.map-err')?.textContent ?? root.textContent.slice(-400));
  assert.ok(root.textContent.includes('确认后才会写入'), root.textContent.slice(-300));
  const confirm = button(root, '确认导入');
  assert.ok(confirm, '预览后应显示明确的导入确认按钮');
  assert.ok(!calls.includes('import'), '预览阶段不能静默导入');
  button(root, '确认导入').fire('click');
  await waitFor(() => calls.includes('import') && root.textContent.includes('导入成功'), '明确确认后导入');
  assert.ok(root.querySelectorAll('.map-card-name').some((n) => n.textContent === '外来地点'));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flushEvents = () => new Promise((resolve) => setImmediate(resolve));
function selectImportFile(root, bundle) {
  const input = field(root, '导入 JSON');
  input.files = [{ size: 12, text: async () => JSON.stringify(bundle) }];
  input.fire('change');
  return input;
}

// These tests mount the shipped panel and use the actual world import methods.
test('合并导入成功只补空白，保留本地内容、同名图片、常去及住所，成功刷新', async () => {
  const { mount, ctx, decl, tool, invocations, intervals } = await mountPanels({ withCover: true });
  await tool('map_edit')({ place: '溪边', tags: ['本地标签'], frequent: true });
  assert.equal((await decl.invoke('places', 'setHome', [{ id: 'forest-home' }])).ok, true);
  const original = (await decl.invoke('places', 'export', [])).bundle;
  const backup = structuredClone(original);
  const creek = backup.state.places.find((p) => p.id === 'forest-creek');
  creek.desc = '备份描写'; creek.style = '备份画风'; creek.tags = ['备份标签']; creek.frequent = false;
  creek.scene = '补入的场景';
  const changedPng = Buffer.from(PNG); changedPng[changedPng.length - 1] = 9;
  backup.covers[creek.cover] = `data:image/png;base64,${changedPng.toString('base64')}`;
  backup.state.places.find((p) => p.id === 'forest-old-oak').name = '备份异名橡树';
  backup.state.places.find((p) => p.id === 'forest-home').desc = '补入的住所描写';
  backup.state.places.push({ ...creek, id: 'new-backup-place', name: '不应新增的地点', cover: '' });
  backup.state.homeId = '';
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5);
  openManagement(root);
  const mode = field(root, '导入模式');
  mode.value = 'merge'; mode.fire('change');
  const file = selectImportFile(root, backup);
  const confirm = button(root, '确认导入');
  await waitFor(() => !confirm.disabled, '合并预览完成');
  assert.match(root.querySelector('.map-transfer').textContent, /本地优先.*只补空白.*冲突保留/);
  assert.match(root.querySelector('.map-transfer').textContent, /已有图片永不覆盖/);
  assert.match(root.querySelector('.map-transfer').textContent, /备份异名橡树/);
  assert.equal(invocations.filter((r) => r.method === 'import').length, 0);
  const gate = deferred();
  const invoke = ctx.invoke;
  let writes = 0;
  ctx.invoke = async (method, args) => {
    if (method === 'import') { ++writes; await gate.promise; }
    return invoke(method, args);
  };
  confirm.fire('click'); confirm.fire('click');
  assert.equal(writes, 1);
  assert.equal(file.disabled, true); assert.equal(mode.disabled, true); assert.equal(confirm.disabled, true);
  intervals[0].fn();
  await flushEvents();
  assert.equal(field(root, '导入 JSON'), file, '写入中刷新不能生成可用的新文件控件');
  gate.resolve();
  await waitFor(() => root.textContent.includes('导入成功') && !file.disabled, '导入成功并刷新');
  assert.equal(writes, 1);
  const after = (await decl.invoke('places', 'export', [])).bundle;
  const saved = after.state.places.find((p) => p.id === creek.id);
  const local = original.state.places.find((p) => p.id === creek.id);
  for (const key of ['name', 'desc', 'style', 'tags', 'frequent', 'cover']) assert.deepEqual(saved[key], local[key], key);
  assert.equal(saved.scene, '补入的场景');
  assert.equal(after.covers[saved.cover], original.covers[local.cover]);
  assert.equal(after.state.homeId, original.state.homeId);
  assert.equal(after.state.places.length, original.state.places.length);
  assert.equal(after.state.places.find((p) => p.id === 'forest-old-oak').name, '老橡树');
  assert.ok(root.querySelectorAll('.map-card').some((card) => card.textContent.includes('补入的住所描写')));
  assert.equal(confirm.disabled, true, '成功后不能重复提交旧预览');
});

test('导入模式快切允许并发预览，忽略旧成功和旧错误，只提交预览捕获的参数', async () => {
  const { mount, ctx, decl, invocations } = await mountPanels();
  const backup = (await decl.invoke('places', 'export', [])).bundle;
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  const invoke = ctx.invoke;
  const requests = [];
  ctx.invoke = async (method, args) => {
    if (method !== 'previewImport') return invoke(method, args);
    const gate = deferred();
    requests.push({ args, gate });
    await gate.promise;
    return invoke(method, args);
  };
  field(root, '导入模式').value = 'skip';
  selectImportFile(root, backup);
  await waitFor(() => requests.length === 1);
  const mode = field(root, '导入模式');
  const confirm = button(root, '确认导入');
  for (const value of ['overwrite', 'merge']) {
    mode.value = value; mode.fire('change');
    assert.equal(confirm.disabled, true);
    confirm.fire('click');
  }
  assert.deepEqual(requests.map((r) => r.args[0].mode), ['skip', 'overwrite', 'merge']);
  requests[2].gate.resolve();
  await waitFor(() => !confirm.disabled);
  const latest = root.querySelector('.map-transfer').textContent;
  requests[0].gate.resolve();
  requests[1].gate.reject(new Error('旧模式错误'));
  await waitFor(() => invocations.some((r) => r.method === 'previewImport' && r.args[0].mode === 'skip' && r.result), '旧预览实际返回');
  await flushEvents();
  assert.equal(root.querySelector('.map-transfer').textContent, latest);
  assert.equal(confirm.disabled, false);
  // A control value changed without a change event must never change the approved payload.
  mode.value = 'overwrite';
  confirm.fire('click');
  await waitFor(() => root.textContent.includes('导入成功'));
  const submitted = invocations.find((r) => r.method === 'import').args[0];
  assert.equal(submitted.mode, 'merge');
  assert.deepEqual(submitted.bundle, backup);
  assert.equal(submitted.expectedRevision, invocations.find((r) => r.method === 'previewImport' && r.args[0].mode === 'merge').result.expectedRevision);
});

test('切文件立即作废预览，旧预览和慢文件读取均不能覆盖最新文件', async () => {
  const { mount, ctx, decl, invocations } = await mountPanels();
  const backup = (await decl.invoke('places', 'export', [])).bundle;
  const latest = structuredClone(backup);
  latest.state.places.find((p) => p.id === 'forest-home').desc = '最新文件';
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  const invoke = ctx.invoke;
  const oldPreview = deferred();
  let delayPreview = true;
  ctx.invoke = async (method, args) => {
    if (method === 'previewImport' && delayPreview) { delayPreview = false; await oldPreview.promise; }
    return invoke(method, args);
  };
  const input = selectImportFile(root, backup);
  await waitFor(() => !delayPreview);
  const slowFile = deferred();
  input.files = [{ size: 12, text: () => slowFile.promise }]; input.fire('change');
  const confirm = button(root, '确认导入');
  assert.equal(confirm.disabled, true);
  oldPreview.resolve();
  await waitFor(() => invocations.some((r) => r.method === 'previewImport' && r.result), '旧文件预览实际返回');
  await flushEvents();
  assert.equal(confirm.disabled, true, '旧文件预览返回不能批准正在读取的新文件');
  selectImportFile(root, latest);
  await waitFor(() => !confirm.disabled);
  slowFile.resolve(JSON.stringify(backup));
  await flushEvents();
  assert.equal(invocations.filter((r) => r.method === 'previewImport').length, 2, '慢文件不得再触发预览');
  confirm.fire('click');
  await waitFor(() => root.textContent.includes('导入成功'));
  assert.deepEqual(invocations.find((r) => r.method === 'import').args[0].bundle, latest);
});

test('文件取消、清空、读取失败及过大文件立即作废预览，旧读取错误不影响新文件', async () => {
  const { mount, decl, invocations } = await mountPanels();
  const backup = (await decl.invoke('places', 'export', [])).bundle;
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  const input = field(root, '导入 JSON');
  const confirm = button(root, '确认导入');
  for (const action of ['cancel', 'empty', 'broken', 'oversize']) {
    selectImportFile(root, backup);
    await waitFor(() => !confirm.disabled);
    if (action === 'cancel') input.fire('cancel');
    else {
      input.files = action === 'empty' ? [] : [{ size: action === 'oversize' ? 65 * 1024 * 1024 : 12, text: async () => '{invalid' }];
      input.fire('change');
    }
    assert.equal(confirm.disabled, true, action);
    confirm.fire('click');
    await flushEvents();
    const mode = field(root, '导入模式'); mode.value = 'merge'; mode.fire('change');
    await flushEvents();
    assert.equal(confirm.disabled, true, `${action} 后切模式不能复用旧文件`);
  }
  const stale = deferred();
  input.files = [{ size: 12, text: () => stale.promise }]; input.fire('change');
  selectImportFile(root, backup);
  await waitFor(() => !confirm.disabled);
  stale.reject(new Error('旧文件读取失败'));
  await flushEvents();
  assert.equal(confirm.disabled, false);
  assert.ok(!root.textContent.includes('旧文件读取失败'));
  const cancelled = deferred();
  input.files = [{ size: 12, text: () => cancelled.promise }]; input.fire('change');
  input.fire('cancel');
  cancelled.resolve(JSON.stringify(backup));
  await flushEvents();
  assert.equal(confirm.disabled, true, '取消后慢文件完成也不能恢复预览');
  assert.equal(invocations.filter((r) => r.method === 'import').length, 0);
});

test('当前预览或写入失败后确认失效，写入结束恢复文件和模式控件', async () => {
  const { mount, ctx, decl, invocations } = await mountPanels();
  const backup = (await decl.invoke('places', 'export', [])).bundle;
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  const input = selectImportFile(root, backup);
  const confirm = button(root, '确认导入');
  await waitFor(() => !confirm.disabled);
  const invoke = ctx.invoke;
  ctx.invoke = async (method, args) => method === 'previewImport' ? { ok: false, error: '当前预览失败' } : invoke(method, args);
  const mode = field(root, '导入模式'); mode.value = 'merge'; mode.fire('change');
  assert.equal(confirm.disabled, true);
  await waitFor(() => root.textContent.includes('当前预览失败'));
  confirm.fire('click');
  assert.equal(invocations.filter((r) => r.method === 'import').length, 0);
  const gate = deferred();
  let writes = 0;
  ctx.invoke = async (method, args) => {
    if (method === 'import') { ++writes; await gate.promise; return { ok: false, error: '写入失败' }; }
    return invoke(method, args);
  };
  mode.fire('change');
  await waitFor(() => !confirm.disabled);
  confirm.fire('click'); confirm.fire('click');
  assert.equal(input.disabled, true); assert.equal(mode.disabled, true);
  gate.resolve();
  await waitFor(() => root.textContent.includes('写入失败'));
  assert.equal(input.disabled, false); assert.equal(mode.disabled, false); assert.equal(confirm.disabled, true);
  confirm.fire('click');
  assert.equal(writes, 1);
});

test('逐项预览展示中文差异，默认安全合并，新地点可勾选导入且完整 decisions 随确认快照提交', async () => {
  const { mount, decl, invocations } = await mountPanels();
  const original = (await decl.invoke('places', 'export', [])).bundle;
  const backup = structuredClone(original);
  const creek = backup.state.places.find((p) => p.id === 'forest-creek');
  creek.desc = '<img src=x onerror=alert(1)>备份描写';
  creek.scene = '逐项场景';
  backup.state.places.push({ ...creek, id: 'manual-new-place', name: '手动新地点', cover: '' });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  assert.equal(field(root, '导入模式').value, 'merge');
  selectImportFile(root, backup);
  const confirm = button(root, '确认导入');
  await waitFor(() => !confirm.disabled);
  const first = invocations.filter((r) => r.method === 'previewImport').at(-1);
  assert.equal(Object.hasOwn(first.args[0], 'decisions'), false, '初次预览保持全局模式契约');
  assert.equal(field(root, '选择导入：手动新地点').checked, false);
  assert.equal(field(root, '选择导入：溪边').checked, true);
  assert.ok(root.querySelectorAll('.map-import-diff').length === backup.state.places.length);
  const diff = root.querySelector('.map-transfer').textContent;
  assert.match(diff, /描写（保留）.*本地 一条很浅的溪.*备份 <img.*最终 一条很浅的溪/);
  assert.match(diff, /场景（将修改）.*最终 逐项场景/);
  assert.equal(root.querySelectorAll('img').length, 0, '备份文字不能作为 HTML 插入');
  const checkbox = field(root, '选择导入：手动新地点');
  checkbox.checked = true; checkbox.fire('change');
  assert.equal(confirm.disabled, true);
  await waitFor(() => !confirm.disabled);
  const selected = invocations.filter((r) => r.method === 'previewImport').at(-1);
  assert.equal(selected.args[0].decisions.length, backup.state.places.length);
  assert.equal(selected.args[0].decisions.find((d) => d.id === 'manual-new-place').mode, 'overwrite');
  assert.equal(field(root, '选择导入：手动新地点').checked, true);
  const handling = field(root, '处理方式：溪边');
  handling.value = 'overwrite'; handling.fire('change');
  await waitFor(() => !confirm.disabled);
  const approved = invocations.filter((r) => r.method === 'previewImport').at(-1);
  assert.match(root.querySelector('.map-transfer').textContent, /描写（将修改）.*最终 <img/);
  // Changing DOM properties without events must not alter the approved snapshot.
  field(root, '处理方式：溪边').value = 'skip';
  confirm.fire('click');
  await waitFor(() => root.textContent.includes('导入成功'));
  const submitted = invocations.find((r) => r.method === 'import').args[0];
  assert.deepEqual(submitted.decisions, approved.args[0].decisions);
  assert.equal(submitted.expectedRevision, approved.result.expectedRevision);
  const after = (await decl.invoke('places', 'export', [])).bundle;
  assert.ok(after.state.places.some((p) => p.id === 'manual-new-place'));
  assert.equal(after.state.places.find((p) => p.id === creek.id).desc, creek.desc);
});

test('逐项取消发送 skip 不新增，切全局模式清除 decisions，旧逐项预览不能批准确认', async () => {
  const { mount, ctx, decl, invocations } = await mountPanels();
  const backup = (await decl.invoke('places', 'export', [])).bundle;
  backup.state.places.push({ ...backup.state.places[0], id: 'must-skip-new', name: '取消的新地点', cover: '' });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  const mode = field(root, '导入模式'); mode.value = 'overwrite';
  selectImportFile(root, backup);
  const confirm = button(root, '确认导入');
  await waitFor(() => !confirm.disabled);
  const checkbox = field(root, '选择导入：取消的新地点');
  assert.equal(checkbox.checked, true);
  checkbox.checked = false; checkbox.fire('change');
  await waitFor(() => !confirm.disabled);
  const deselected = invocations.filter((r) => r.method === 'previewImport').at(-1);
  assert.equal(deselected.args[0].decisions.find((d) => d.id === 'must-skip-new').mode, 'skip');
  assert.equal(deselected.result.items.find((i) => i.id === 'must-skip-new').action, 'skipped');
  const invoke = ctx.invoke;
  const gate = deferred();
  ctx.invoke = async (method, args) => {
    if (method === 'previewImport' && args[0].decisions) await gate.promise;
    return invoke(method, args);
  };
  const select = field(root, '处理方式：取消的新地点');
  select.value = 'overwrite'; select.fire('change');
  assert.equal(confirm.disabled, true);
  mode.value = 'merge'; mode.fire('change');
  await waitFor(() => !confirm.disabled);
  const latestText = root.querySelector('.map-transfer').textContent;
  assert.equal(Object.hasOwn(invocations.filter((r) => r.method === 'previewImport').at(-1).args[0], 'decisions'), false);
  gate.resolve();
  await waitFor(() => invocations.filter((r) => r.method === 'previewImport').length === 4);
  await flushEvents();
  assert.equal(root.querySelector('.map-transfer').textContent, latestText);
  confirm.fire('click');
  await waitFor(() => root.textContent.includes('导入成功'));
  assert.equal(Object.hasOwn(invocations.find((r) => r.method === 'import').args[0], 'decisions'), false);
  assert.equal((await decl.invoke('places', 'list', [])).places.some((p) => p.id === 'must-skip-new'), false);
});

test('恢复入口挂载读取状态，导入后先预览影响再确认，写入锁与刷新清图缓存', async () => {
  const { mount, ctx, decl, invocations, intervals } = await mountPanels({ withCover: true });
  const original = (await decl.invoke('places', 'export', [])).bundle;
  const backup = structuredClone(original);
  backup.state.places.find((p) => p.id === 'forest-creek').desc = '准备恢复的覆盖描写';
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  await waitFor(() => root.textContent.includes('暂无导入恢复点'));
  assert.equal(invocations.filter((r) => r.method === 'recoveryInfo').length, 1);
  assert.equal(invocations.filter((r) => r.method === 'restore').length, 0);
  const mode = field(root, '导入模式'); mode.value = 'overwrite';
  const file = selectImportFile(root, backup);
  await waitFor(() => !button(root, '确认导入').disabled);
  button(root, '确认导入').fire('click');
  await waitFor(() => root.textContent.includes('导入成功') && !button(root, '预览恢复上次导入前').disabled);
  const coverCalls = invocations.filter((r) => r.method === 'cover').length;
  button(root, '预览恢复上次导入前').fire('click');
  await waitFor(() => button(root, '确认恢复导入前状态'));
  assert.match(root.textContent, /恢复影响：5 处 → 5 处/);
  assert.match(root.textContent, /恢复：.*溪边/);
  assert.equal(invocations.filter((r) => r.method === 'restore').length, 0);
  const approved = invocations.find((r) => r.method === 'previewRestore').result;
  const invoke = ctx.invoke;
  const gate = deferred(); let writes = 0;
  ctx.invoke = async (method, args) => {
    if (method === 'restore') { ++writes; await gate.promise; }
    return invoke(method, args);
  };
  const confirm = button(root, '确认恢复导入前状态');
  confirm.fire('click'); confirm.fire('click');
  assert.equal(writes, 1);
  assert.equal(file.disabled, true); assert.equal(mode.disabled, true);
  intervals[0].fn(); await flushEvents();
  assert.equal(field(root, '导入 JSON'), file);
  gate.resolve();
  await waitFor(() => root.textContent.includes('恢复成功') && !file.disabled);
  assert.deepEqual(invocations.find((r) => r.method === 'restore').args, [{ expectedRevision: approved.expectedRevision }]);
  const restored = (await decl.invoke('places', 'export', [])).bundle;
  assert.equal(restored.state.places.find((p) => p.id === 'forest-creek').desc, original.state.places.find((p) => p.id === 'forest-creek').desc);
  await waitFor(() => invocations.filter((r) => r.method === 'cover').length > coverCalls, '恢复刷新图片缓存');
});

test('恢复预览后的后续编辑被服务端拒绝，失败保留本地表单，刷新显示不可一键恢复', async () => {
  const { mount, decl, tool, invocations } = await mountPanels();
  const backup = (await decl.invoke('places', 'export', [])).bundle;
  backup.state.places.find((p) => p.id === 'forest-home').desc = '导入住所描写';
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  selectImportFile(root, backup);
  await waitFor(() => !button(root, '确认导入').disabled);
  button(root, '确认导入').fire('click');
  await waitFor(() => root.textContent.includes('导入成功') && !button(root, '预览恢复上次导入前').disabled);
  openPlace(root, '溪边');
  type(field(root, '描写'), '恢复失败也保留我的未保存表单');
  button(root, '预览恢复上次导入前').fire('click');
  await waitFor(() => button(root, '确认恢复导入前状态'));
  await tool('map_edit')({ place: '老橡树', desc: '导入后的独立编辑' });
  button(root, '确认恢复导入前状态').fire('click');
  await waitFor(() => root.querySelector('.map-transfer').querySelector('.map-err'));
  assert.equal(invocations.find((r) => r.method === 'restore').result.ok, false);
  assert.equal(field(root, '描写').value, '恢复失败也保留我的未保存表单');
  assert.equal((await decl.invoke('places', 'list', [])).places.find((p) => p.id === 'forest-old-oak').desc, '导入后的独立编辑');
  await waitFor(() => root.textContent.includes('可先导出当前备份'));
  assert.equal(button(root, '预览恢复上次导入前').disabled, true);
  assert.equal(button(root, '确认恢复导入前状态'), undefined);
});

// ---------------------------------------------------------------------------
// 面板三项增强：常用筛选 / 批量管理 / 删除撤销
// ---------------------------------------------------------------------------

test('常用筛选：一点就切，条件不用每次重新组', async () => {
  const { mount, tool } = await mountPanels({ withCover: true });
  await tool('map_edit')({ place: '溪边', frequent: true });
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  const qf = (label) => root.querySelectorAll('.map-qf').find((b) => b.textContent === label);
  for (const label of ['全部', '常去', '有图', '缺描写']) assert.ok(qf(label), `该有「${label}」快捷筛选`);
  assert.equal(qf('全部').getAttribute('aria-pressed'), 'true', '默认停在「全部」');

  qf('有图').fire('click');
  await waitFor(() => root.querySelectorAll('.map-card').length === 1, '只剩有图那一张');
  assert.equal(qf('有图').getAttribute('aria-pressed'), 'true', '点过的那颗要高亮');

  qf('缺描写').fire('click');
  await waitFor(() => root.querySelectorAll('.map-card').length === 3, '缺描写的三张');

  qf('常去').fire('click');
  await waitFor(() => root.querySelectorAll('.map-card').length === 1, '常去那一张');

  qf('全部').fire('click');
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '回到全部五张');
});

test('批量管理：多选两处，一次加同一个标签', async () => {
  const { mount, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');

  openManagement(root);
  button(root, '批量管理').fire('click');
  await waitFor(() => root.querySelector('.map-batch'), '出现批量工具条');
  const cards = root.querySelectorAll('.map-card');
  cards[0].fire('click');
  cards[1].fire('click');
  await waitFor(() => root.querySelectorAll('.map-card-selected').length === 2, '选中两处');

  root.querySelector('.map-batch').querySelectorAll('input')[0].value = '水边';
  button(root, '加标签').fire('click');
  await waitFor(() => !root.querySelector('.map-batch'), '改完退出批量模式');
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '回到五张卡');

  const list = (await decl.invoke('places', 'list', [])).places;
  assert.equal(list.filter((p) => p.tags.includes('水边')).length, 2, '勾选的那两处该都有这个标签');
});

test('删掉之后出现撤销条，点一下地点就回来', async () => {
  const { mount, decl } = await mountPanels();
  const root = await mount();
  await waitFor(() => root.querySelectorAll('.map-card').length === 5, '画出 5 张卡');
  globalThis.window = { confirm: () => true };
  try {
    openPlace(root, '蘑菇坡');
    root.querySelector('.map-detail').findAll((n) => n.tagName === 'BUTTON' && n.textContent === '删掉这处')[0].fire('click');
    await waitFor(() => root.querySelectorAll('.map-card').length === 4, '删掉之后剩 4 张');
    await waitFor(() => root.textContent.includes('10 秒内可撤销'), '出现撤销条');
    assert.ok(root.textContent.includes('蘑菇坡'), '撤销条要说清删的是哪一处');

    button(root, '撤销').fire('click');
    await waitFor(() => root.querySelectorAll('.map-card').length === 5, '撤销之后回到 5 张');
    const list = (await decl.invoke('places', 'list', [])).places;
    assert.ok(list.some((p) => p.name === '蘑菇坡'), '撤销后服务端也该有这一处');
    assert.ok(!root.textContent.includes('10 秒内可撤销'), '撤销完提示要收掉');
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// 地点册：已保存的筛选、排序、最近查看、浏览路径与封面盘点
// ---------------------------------------------------------------------------

function choose(control, value) {
  assert.ok(control, `找不到值为 ${value} 的选择控件`);
  control.value = value;
  control.fire('change');
}

const browseSort = (root) => field(root, '排序');

test('命名视图重挂后可加载全部筛选与视图设置，删除后不再出现', async () => {
  const { mount, tool, invocations, ctx } = await mountPanels({ withCover: true });
  await tool('map_edit')({ place: '溪边', tags: ['水边'], relations: [{ placeId: 'forest-old-oak', note: '保存视图里的关联' }] });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  button(root, '更多筛选').fire('click');
  type(field(root, searchLabel), '溪边');
  choose(field(root, '筛选标签'), '水边');
  choose(field(root, '筛选地点'), 'hasCover');
  choose(browseSort(root), 'name');
  button(root, '关系视图').fire('click');

  button(root, '保存当前视图').fire('click');
  type(field(root, '视图名称'), '溪边照片与关联');
  button(root, '保存当前视图').fire('click');
  await waitFor(() => invocations.some(({ method, result }) => method === 'savePanelPrefs' && result?.ok));

  await mount();
  await waitFor(() => cardNames(root).length === 5);
  button(root, '更多筛选').fire('click');
  const savedView = () => root.querySelector('.map-filter-extra')?.querySelectorAll('.map-saved-view')
    .find((node) => node.textContent === '溪边照片与关联');
  await waitFor(savedView, '重挂后显示已保存的视图名称');
  assert.equal(field(root, searchLabel).value, '');
  assert.equal(button(root, '卡片视图').getAttribute('aria-pressed'), 'true');
  savedView().fire('click');
  await waitFor(() => root.querySelector('.map-relations-view')?.textContent.includes('保存视图里的关联'));
  assert.equal(field(root, searchLabel).value, '溪边');
  assert.equal(field(root, '筛选标签').value, '水边');
  assert.equal(field(root, '筛选地点').value, 'hasCover');
  assert.equal(browseSort(root).value, 'name');
  assert.equal(button(root, '关系视图').getAttribute('aria-pressed'), 'true');

  let acceptRemoval = false;
  const confirmations = [];
  ctx.confirm = (message) => { confirmations.push(message); return acceptRemoval; };
  const deleteButton = () => root.querySelector('.map-filter-extra').querySelectorAll('button')
    .find((node) => [node.getAttribute('aria-label'), node.title, node.textContent].includes('删除视图'));
  deleteButton().fire('click');
  await flushEvents();
  assert.equal(confirmations.length, 1);
  assert.ok(savedView(), '取消后保留已保存的视图');
  assert.equal(invocations.some(({ method }) => method === 'savePanelPrefs'), false);

  acceptRemoval = true;
  deleteButton().fire('click');
  await waitFor(() => invocations.some(({ method, result }) => method === 'savePanelPrefs' && result?.ok && result.prefs.savedViews.length === 0));
  await mount();
  await waitFor(() => cardNames(root).length === 5);
  button(root, '更多筛选').fire('click');
  assert.equal(savedView(), undefined);
});

test('排序支持类型分组、名称、常去、有图、完整度、最近编辑与最近查看', async () => {
  const { mount, decl, tool } = await mountPanels();
  const sortingTag = '排序夹具';
  await tool('map_add')({ name: 'Alpha', kind: 'travel', tags: [sortingTag] });
  await tool('map_add')({ name: 'Bravo', kind: 'around', tags: [sortingTag], frequent: true });
  await tool('map_add')({ name: 'Charlie', kind: 'around', tags: [sortingTag] });
  await tool('map_add')({ name: 'Delta', kind: 'home', tags: [sortingTag] });
  const { places } = await decl.invoke('places', 'list', []);
  const id = (name) => places.find((place) => place.name === name).id;
  await tool('map_edit')({ place: 'Delta', desc: '较完整的地点', style: '油彩', relations: [{ placeId: id('Alpha'), note: '关联测试' }] });
  const upload = await decl.invoke('places', 'upload', [{ id: id('Charlie'), data: `data:image/png;base64,${PNG.toString('base64')}` }]);
  assert.equal(upload.ok, true, upload.error);
  const root = await mount();
  await waitFor(() => cardNames(root).length === 9);
  button(root, '更多筛选').fire('click');
  choose(field(root, '筛选标签'), sortingTag);

  const checkSort = (mode, first) => {
    assert.ok(browseSort(root).querySelectorAll('option').some((option) => option.value === mode), mode);
    choose(browseSort(root), mode);
    assert.equal(cardNames(root)[0], first, mode);
    assert.deepEqual(cardNames(root).slice().sort(), ['Alpha', 'Bravo', 'Charlie', 'Delta'], mode);
  };
  checkSort('kind', 'Bravo');
  assert.deepEqual(cardNames(root), ['Bravo', 'Delta', 'Charlie', 'Alpha']);
  assert.equal(root.querySelectorAll('.map-sec').length, 4);
  checkSort('name', 'Alpha');
  assert.deepEqual(cardNames(root), ['Alpha', 'Bravo', 'Charlie', 'Delta']);
  checkSort('frequent', 'Bravo');
  checkSort('cover', 'Charlie');
  checkSort('completeness', 'Delta');

  for (const name of ['Delta', 'Alpha']) {
    const detail = openPlace(root, name);
    type(field(detail, '描写'), `编辑 ${name}`);
    button(detail, '存一下').fire('click');
    await waitFor(() => card(root, name)?.textContent.includes(`编辑 ${name}`));
  }
  readPlace(root, 'Charlie');
  checkSort('updated', 'Alpha');
  assert.deepEqual(cardNames(root), ['Alpha', 'Delta', 'Bravo', 'Charlie']);
  checkSort('viewed', 'Charlie');
  assert.deepEqual(cardNames(root).slice(0, 3), ['Charlie', 'Alpha', 'Delta']);
});

test('阅读可置顶和取消置顶，重挂保留偏好且置顶优先于名称和类型排序', async () => {
  const { mount, decl, tool, invocations } = await mountPanels();
  for (const name of ['Alpha', 'Zulu']) await tool('map_add')({ name, kind: 'travel', tags: ['置顶夹具'] });
  const placesBefore = (await decl.invoke('places', 'list', [])).places;
  const pinnedId = placesBefore.find(({ name }) => name === 'Zulu').id;
  const root = await mount();
  await waitFor(() => cardNames(root).length === 7);
  button(root, '更多筛选').fire('click');
  choose(field(root, '筛选标签'), '置顶夹具');
  choose(browseSort(root), 'name');
  assert.deepEqual(cardNames(root), ['Alpha', 'Zulu']);

  const reading = readPlace(root, 'Zulu');
  assert.equal(button(reading, '取消置顶'), undefined);
  button(reading, '置顶浏览').fire('click');
  assert.ok(button(root.querySelector('.map-reading'), '取消置顶'));
  assert.deepEqual(cardNames(root), ['Zulu', 'Alpha'], '置顶应优先于名称排序');
  choose(browseSort(root), 'kind');
  assert.deepEqual(cardNames(root), ['Zulu', 'Alpha']);
  assert.equal(root.querySelector('.map-sec').textContent, '置顶');
  await waitFor(() => invocations.some(({ method, result }) => method === 'savePanelPrefs' && result?.ok
    && result.prefs.pinned.join(',') === pinnedId), '置顶偏好保存');

  await mount();
  await waitFor(() => cardNames(root).length === 7);
  assert.equal(cardNames(root)[0], 'Zulu', '重挂后置顶旅行地点仍应排在住所和周围之前');
  assert.equal(root.querySelector('.map-sec').textContent, '置顶');
  const restoredReading = readPlace(root, 'Zulu');
  assert.equal(button(restoredReading, '置顶浏览'), undefined);
  button(restoredReading, '取消置顶').fire('click');
  assert.ok(button(root.querySelector('.map-reading'), '置顶浏览'));
  assert.ok(root.querySelectorAll('.map-sec').every(({ textContent }) => textContent !== '置顶'));
  await waitFor(() => invocations.some(({ method, result }) => method === 'savePanelPrefs' && result?.ok
    && result.prefs.pinned.length === 0), '取消置顶偏好保存');

  await mount();
  await waitFor(() => cardNames(root).length === 7);
  button(root, '更多筛选').fire('click');
  choose(field(root, '筛选标签'), '置顶夹具');
  choose(browseSort(root), 'name');
  assert.deepEqual(cardNames(root), ['Alpha', 'Zulu'], '取消置顶重挂后恢复普通名称排序');
  assert.ok(button(readPlace(root, 'Zulu'), '置顶浏览'));
  assert.deepEqual((await decl.invoke('places', 'list', [])).places, placesBefore, '浏览置顶不能修改地点内容或常去状态');
});

test('缺关系筛选只保留既无入站又无出站关联的地点，并可切回全部', async () => {
  const { mount, tool } = await mountPanels();
  await tool('map_edit')({ place: '溪边', relations: [{ placeId: 'forest-old-oak', note: '只有溪边设置了关联' }] });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  const allNames = cardNames(root).slice().sort();
  button(root, '更多筛选').fire('click');
  const filter = field(root, '筛选地点');
  assert.equal(filter.querySelectorAll('option').find(({ value }) => value === 'noRelation')?.textContent, '缺关系');
  choose(filter, 'noRelation');
  assert.deepEqual(cardNames(root).slice().sort(), allNames.filter((name) => !['溪边', '老橡树'].includes(name)));
  assert.equal(card(root, '老橡树'), undefined, '只有入站关联的地点也不属于孤立地点');
  assert.match(root.querySelector('.map-results-count').textContent, /当前显示 3 处/);
  choose(field(root, '筛选地点'), 'all');
  assert.deepEqual(cardNames(root).slice().sort(), allNames);
});

test('最近查看按访问顺序去重，重新挂载仍可从列表打开地点', async () => {
  const { mount, invocations } = await mountPanels();
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  for (const name of ['溪边', '老橡树', '溪边']) {
    const reading = readPlace(root, name);
    button(reading, '收起').fire('click');
  }
  const expected = ['forest-creek', 'forest-old-oak'];
  await waitFor(() => invocations.some(({ method, result }) => method === 'savePanelPrefs' && result?.ok
    && result.prefs.recentViewed.join(',') === expected.join(',')), '最近查看写入偏好');

  await mount();
  const recentStrip = await waitFor(() => root.querySelector('.map-recent-viewed'), '重挂后显示最近查看');
  assert.deepEqual(recentStrip.querySelectorAll('button').map((node) => node.textContent), ['溪边', '老橡树']);
  button(recentStrip, '老橡树').fire('click');
  assert.match(root.querySelector('.map-reading').querySelector('h3').textContent, /老橡树/);
});

test('关系浏览路径可跳到任一上级，并保留筛选、排序与关系视图', async () => {
  const { mount, tool } = await mountPanels();
  for (const [place, placeId] of [
    ['溪边', 'forest-old-oak'],
    ['老橡树', 'forest-mushroom-slope'],
    ['蘑菇坡', 'forest-clearing'],
  ]) {
    await tool('map_edit')({ place, tags: ['关系路径'], relations: [{ placeId, note: `${place}的关联` }] });
  }
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  button(root, '更多筛选').fire('click');
  type(field(root, searchLabel), '溪边');
  choose(field(root, '筛选标签'), '关系路径');
  choose(field(root, '筛选地点'), 'noCover');
  choose(browseSort(root), 'name');
  button(root, '关系视图').fire('click');

  const reading = () => root.querySelector('.map-reading');
  const breadcrumb = () => root.querySelector('.map-breadcrumbs');
  const relationLink = (scope, name) => scope.querySelectorAll('.map-relation-link').find((node) => node.textContent === name);
  const expectReading = (name) => assert.equal(reading().querySelector('h3').textContent.split(' · ')[0], name);
  const checkContext = () => {
    assert.equal(field(root, searchLabel).value, '溪边');
    assert.equal(field(root, '筛选标签').value, '关系路径');
    assert.equal(field(root, '筛选地点').value, 'noCover');
    assert.equal(browseSort(root).value, 'name');
    assert.equal(button(root, '关系视图').getAttribute('aria-pressed'), 'true');
    assert.match(root.querySelector('.map-results-count').textContent, /当前显示 1 处/);
  };
  relationLink(root.querySelector('.map-relations-view'), '溪边').fire('click');
  for (const name of ['老橡树', '蘑菇坡', '林间空地']) relationLink(reading(), name).fire('click');
  expectReading('林间空地');
  for (const parent of ['溪边', '老橡树', '蘑菇坡']) assert.ok(button(breadcrumb(), parent), parent);
  checkContext();

  button(breadcrumb(), '老橡树').fire('click');
  expectReading('老橡树');
  assert.equal(button(breadcrumb(), '蘑菇坡'), undefined, '跳回上级应会移除后续路径');
  checkContext();
  button(breadcrumb(), '溪边').fire('click');
  expectReading('溪边');
  checkContext();
});

test('封面盘点区分已引用、无引用和缺失，保留当前及历史图片文件', async () => {
  const { mount, decl, world, invocations } = await mountPanels({ withCover: true });
  const used = (await decl.invoke('places', 'list', [])).places.find(({ id }) => id === 'forest-creek').cover;
  const historical = 'historical.png';
  const unreferenced = 'unreferenced.png';
  const missing = 'missing.png';
  const coversDir = world.coversDir();
  for (const filename of [historical, unreferenced]) await writeFile(join(coversDir, filename), PNG);
  await writeFile(`${world.stateFile()}.bak`, JSON.stringify({ places: [
    { id: 'past-place', cover: historical }, { id: 'missing-place', cover: missing },
  ] }));
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  assert.equal(button(root, '检查图片'), undefined);
  openManagement(root);
  button(root, '检查图片').fire('click');

  await waitFor(() => root.querySelectorAll('.map-resource').length === 4, '显示所有封面资源状态');
  const resource = (filename) => root.querySelectorAll('.map-resource').find((row) => row.textContent.includes(filename));
  assert.match(resource(used).textContent, /已引用/);
  assert.match(resource(historical).textContent, /已引用/);
  assert.match(resource(unreferenced).textContent, /没有发现引用/);
  assert.match(resource(missing).textContent, /文件缺失/);
  assert.match(root.querySelector('.map-zone-manage').textContent, /备份|恢复点/);
  assert.equal(invocations.filter(({ method }) => method === 'inspectCovers').length, 1);
  assert.equal(root.querySelectorAll('.map-resource').flatMap((row) => row.querySelectorAll('input')).length, 0);
  assert.ok(root.querySelector('.map-zone-manage').querySelectorAll('button').every((node) => !/删除|清理/.test(node.textContent)));
  for (const filename of [used, historical, unreferenced]) assert.deepEqual(await readFile(join(coversDir, filename)), PNG, filename);
  await assert.rejects(readFile(join(coversDir, missing)), { code: 'ENOENT' });
});

test('无缺失和警告的无引用 PNG 可勾选归档，确认取消不写盘，确认后可逐字节恢复', async () => {
  const { mount, decl, world, invocations, ctx } = await mountPanels({ withCover: true });
  const placesBefore = (await decl.invoke('places', 'list', [])).places;
  const used = placesBefore.find(({ id }) => id === 'forest-creek').cover;
  const unreferenced = 'ready-to-archive.png';
  const coversDir = world.coversDir();
  await writeFile(join(coversDir, unreferenced), INVENTORY_PNG);
  let acceptArchive = false;
  const confirmations = [];
  ctx.confirm = (message) => { confirmations.push(message); return acceptArchive; };
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  button(root, '检查图片').fire('click');
  await waitFor(() => field(root, `归档 ${unreferenced}`), '无引用图片出现归档复选框');
  const inspection = invocations.find(({ method, result }) => method === 'inspectCovers' && result?.ok).result;
  assert.deepEqual(inspection.missing, []);
  assert.deepEqual(inspection.warnings, []);
  assert.equal(inspection.files.find(({ filename }) => filename === unreferenced).archiveable, true);
  assert.equal(field(root, `归档 ${used}`), undefined, '当前引用图片不能被勾选');
  const checkbox = field(root, `归档 ${unreferenced}`);
  assert.equal(checkbox.getAttribute('type'), 'checkbox');
  assert.equal(checkbox.disabled, false);
  assert.equal(button(root, '归档所选图片（0）').disabled, true);
  checkbox.checked = true;
  checkbox.fire('change');
  assert.equal(button(root, '归档所选图片（1）').disabled, false);

  button(root, '归档所选图片（1）').fire('click');
  await flushEvents();
  assert.equal(confirmations.length, 1, '归档之前必须明确确认');
  assert.match(confirmations[0], /可恢复归档/);
  assert.ok(confirmations[0].includes(unreferenced), '确认框列明要移动的文件');
  assert.equal(invocations.some(({ method }) => method === 'archiveCovers'), false, '取消确认不能调用归档接口');
  assert.deepEqual(await readFile(join(coversDir, unreferenced)), INVENTORY_PNG);
  assert.deepEqual((await decl.invoke('places', 'listCoverArchives', [])).archives, []);
  assert.equal(field(root, `归档 ${unreferenced}`).checked, true, '取消后保留勾选，允许重新确认');

  acceptArchive = true;
  button(root, '归档所选图片（1）').fire('click');
  await waitFor(() => button(root, '恢复归档') && !button(root, '恢复归档').disabled, '成功归档后出现恢复按钮');
  const archiveCalls = invocations.filter(({ method }) => method === 'archiveCovers');
  assert.equal(archiveCalls.length, 1);
  assert.deepEqual(archiveCalls[0].args, [{ filenames: [unreferenced], expectedRevision: inspection.revision }]);
  assert.equal(archiveCalls[0].result.ok, true, archiveCalls[0].result.error);
  assert.equal(confirmations.length, 2);
  const archive = archiveCalls[0].result.archive;
  assert.deepEqual(archive.files.map(({ filename }) => filename), [unreferenced]);
  await assert.rejects(readFile(join(coversDir, unreferenced)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(coversDir, '..', 'cover-archive', archive.id, unreferenced)), INVENTORY_PNG);
  assert.deepEqual(await readFile(join(coversDir, used)), PNG, '归档不触碰当前使用的图片');
  assert.deepEqual((await decl.invoke('places', 'list', [])).places, placesBefore, '归档不能改写地点或当前图片引用');

  button(root, '恢复归档').fire('click');
  await waitFor(() => invocations.some(({ method, result }) => method === 'restoreCoverArchive' && result?.ok)
    && field(root, `归档 ${unreferenced}`) && !button(root, '恢复归档'), '恢复成功并重新盘点');
  const restores = invocations.filter(({ method }) => method === 'restoreCoverArchive');
  assert.equal(restores.length, 1);
  assert.deepEqual(restores[0].args, [{ id: archive.id }]);
  assert.equal(confirmations.length, 3, '恢复也需明确确认');
  assert.match(confirmations[2], /恢复这些图片/);
  assert.deepEqual(await readFile(join(coversDir, unreferenced)), INVENTORY_PNG, '恢复后图片字节完全相同');
  assert.deepEqual(await readFile(join(coversDir, used)), PNG);
  assert.deepEqual((await decl.invoke('places', 'list', [])).places, placesBefore, '恢复不改变当前图片引用');
  assert.equal((await decl.invoke('places', 'listCoverArchives', [])).archives.find(({ id }) => id === archive.id).status, 'restored');
});

test('盘点后另一次保存使归档版本过期，面板显示错误且所有文件和当前引用不变', async () => {
  const { mount, decl, world, tool, invocations, ctx } = await mountPanels({ withCover: true });
  const used = (await decl.invoke('places', 'list', [])).places.find(({ id }) => id === 'forest-creek').cover;
  const unreferenced = 'stale-inventory.png';
  const coversDir = world.coversDir();
  await writeFile(join(coversDir, unreferenced), INVENTORY_PNG);
  const confirmations = [];
  ctx.confirm = (message) => { confirmations.push(message); return true; };
  const root = await mount();
  await waitFor(() => cardNames(root).length === 5);
  openManagement(root);
  button(root, '检查图片').fire('click');
  const checkbox = await waitFor(() => field(root, `归档 ${unreferenced}`));
  const inspection = invocations.find(({ method, result }) => method === 'inspectCovers' && result?.ok).result;
  assert.deepEqual(inspection.missing, []);
  assert.deepEqual(inspection.warnings, []);
  checkbox.checked = true;
  checkbox.fire('change');

  await tool('map_edit')({ place: '老橡树', desc: '盘点后从另一入口保存的新描写' });
  const placesAfterWrite = (await decl.invoke('places', 'list', [])).places;
  assert.equal(placesAfterWrite.find(({ id }) => id === 'forest-old-oak').desc, '盘点后从另一入口保存的新描写');
  const currentInspection = await decl.invoke('places', 'inspectCovers', []);
  assert.notEqual(currentInspection.revision, inspection.revision, '真实的另一笔写入使旧盘点失效');
  button(root, '归档所选图片（1）').fire('click');
  const error = await waitFor(() => root.querySelector('.map-msg-bad'), '归档失败显示错误');
  const archiveCalls = invocations.filter(({ method }) => method === 'archiveCovers');
  assert.equal(archiveCalls.length, 1);
  assert.equal(archiveCalls[0].args[0].expectedRevision, inspection.revision, '提交旧盘点版本，不能悄悄刷新后继续归档');
  assert.equal(archiveCalls[0].result.ok, false);
  assert.match(archiveCalls[0].result.error, /已变化.*重新盘点/);
  assert.equal(error.textContent, archiveCalls[0].result.error);
  assert.equal(confirmations.length, 1);
  assert.deepEqual(await readFile(join(coversDir, unreferenced)), INVENTORY_PNG, '失败后待归档图片保持原位原字节');
  assert.deepEqual(await readFile(join(coversDir, used)), PNG, '失败后当前图片保持原位原字节');
  assert.deepEqual((await decl.invoke('places', 'list', [])).places, placesAfterWrite, '归档失败不能回滚或改写其他入口的新保存');
  assert.deepEqual((await decl.invoke('places', 'listCoverArchives', [])).archives, []);
  assert.equal(invocations.some(({ method }) => method === 'restoreCoverArchive'), false);
  assert.equal(button(root, '恢复归档'), undefined, '失败不能展示一份并不存在的成功归档');
});

test('卡片和阅读使用统一状态标签，区分类型、无封面与浏览管理区域', async () => {
  const { mount, tool } = await mountPanels({ withCover: true });
  await tool('map_edit')({ place: '老橡树', frequent: true });
  await tool('map_add')({ name: '海边小镇', kind: 'travel' });
  const root = await mount();
  await waitFor(() => cardNames(root).length === 6);
  await waitFor(() => card(root, '溪边').querySelector('img')?.src.startsWith('data:image/png'));

  for (const [name, kind] of [['家', 'home'], ['溪边', 'around'], ['老橡树', 'frequent'], ['海边小镇', 'travel']]) {
    const tile = card(root, name);
    assert.ok(tile.classList.contains(`map-kind-${kind}`), name);
    assert.ok(tile.querySelector('.map-status.map-status-kind')?.textContent.trim(), name);
  }
  const noCover = card(root, '老橡树').querySelector('.map-cover-empty');
  assert.ok(noCover?.textContent.trim(), '无封面的占位有可见文案');
  assert.equal(card(root, '老橡树').querySelector('img'), null);
  assert.equal(card(root, '溪边').querySelector('.map-cover-empty'), null);
  const browse = root.querySelector('.map-zone-browse');
  assert.ok(browse && card(browse, '溪边'), '卡片在浏览区域');
  assert.equal(root.querySelector('.map-zone-manage'), null);

  const reading = readPlace(root, '溪边');
  assert.ok(reading.querySelectorAll('.map-status').some((chip) => /完整度/.test(chip.textContent)));
  openManagement(root);
  const manage = root.querySelector('.map-zone-manage');
  assert.ok(manage && button(manage, '刷新') && field(manage, '导入 JSON'), '管理操作在独立区域');
  assert.ok(root.querySelector('.map-zone-browse').querySelector('.map-reading'), '展开管理保留阅读');
});

await report();
