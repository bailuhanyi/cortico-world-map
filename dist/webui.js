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
.map-detail,.map-reading{border:1px solid var(--m-accent);border-top:none;border-radius:0 0 var(--radius-sm,6px) var(--radius-sm,6px);padding:10px 13px 12px;background:var(--m-card)}
.map-detail-top{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
.map-detail h4{margin:0;font-size:14px}
.map-detail p,.map-reading p{margin:0 0 6px;font-size:12.5px}
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

/* 常用筛选：一排圆角按钮，和地形按钮同一套手感（不用 <select> 的老理由仍然成立） */
.map-quick-filters{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 8px}
.map-qf{border-radius:999px!important;padding:3px 10px!important;font-size:12px}
.map-qf-on{border-color:var(--m-accent)!important;background:color-mix(in srgb,var(--m-accent) 12%,var(--m-card))!important;font-weight:600}
/* 批量管理：勾上的卡片自己看得出被勾了（真机复选框没反馈，靠边框和底色） */
.map-batch{align-items:center}
.map-card-select{cursor:pointer}
.map-card-selected{border-color:var(--m-accent)!important;background:color-mix(in srgb,var(--m-accent) 7%,var(--m-card))!important}
/* 地点册 */
.map-toolbar,.map-filter-row,.map-view{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.map-toolbar{margin-bottom:10px}
.map-toolbar input[type=search]{flex:1 1 210px;min-height:34px}
.map-filter-row{margin-bottom:12px}
.map-filter-row .map-quick-filters{margin:0}
.map-view{gap:3px;background:var(--m-soft);padding:3px;border-radius:8px}
.map-view button{border-color:transparent}
.map-view button[aria-pressed=true]{border-color:var(--m-line);font-weight:600}
.map-manage{border:1px solid var(--m-line);border-radius:10px;background:var(--m-soft);padding:12px;margin:0 0 14px}
.map-results{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0;color:var(--m-dim);font-size:12px}
.map-results-count{margin-inline-end:auto}
.map-home-banner{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);align-items:center;border:1px solid var(--m-line);border-radius:14px;background:color-mix(in srgb,var(--m-accent) 8%,var(--m-card));overflow:hidden;margin:4px 0 16px}
.map-home-text{grid-template-columns:1fr}
.map-home-art{min-width:0;align-self:stretch}
.map-home-art .map-thumb{height:100%;min-height:145px;max-height:215px;aspect-ratio:16/10;border:0;border-radius:0}
.map-home-copy{padding:16px;min-width:0}
.map-home-copy h3,.map-reading h3{margin:0 0 6px;font-size:clamp(17px,4vw,23px);line-height:1.3;overflow-wrap:anywhere}
.map-home-copy .map-card-desc{margin:6px 0 10px;-webkit-line-clamp:2}
.map-home-label{color:var(--m-dim);margin-bottom:4px;font-size:12px}
.map-grid{gap:12px}
.map-card{border-radius:10px}
.map-card-active{border-bottom-left-radius:0;border-bottom-right-radius:0}
.map-thumb{height:auto;aspect-ratio:16/9}
.map-card-text{background:color-mix(in srgb,var(--m-accent) 5%,var(--m-card))}
.map-card-body{padding:10px 12px 12px}
.map-card-desc{-webkit-line-clamp:2;overflow-wrap:anywhere}
.map-card .map-chip{overflow-wrap:anywhere}
.map-reading{padding:14px 16px 16px}
.map-reading-cover{display:block;width:100%;max-height:320px;object-fit:contain;background:var(--m-soft);border-radius:8px;margin:8px 0 12px}
.map-reading-text{white-space:pre-wrap;overflow-wrap:anywhere}
.map-reading-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.map-standalone{border:1px solid var(--m-line);border-radius:10px;margin-bottom:14px;overflow:hidden}
.map-standalone>.map-detail,.map-standalone>.map-reading{border:0}
.map-edit-options{margin:12px 0;padding:8px 10px;border:1px solid var(--m-line);border-radius:8px}
.map-edit-options summary,.map-reading summary{cursor:pointer;color:var(--m-dim)}
.map-edit-options[open]>summary{margin-bottom:9px}
.map-results .map-chip{max-width:100%;overflow-wrap:anywhere}
.map-relation-row{padding:7px 0;border-bottom:1px solid var(--m-line);overflow-wrap:anywhere}
.map-relation-row:last-child{border-bottom:0}
.map-relation-link{margin-inline:4px}
.map{container:little-world / inline-size}
.map-filter-extra{display:flex;flex-wrap:wrap;gap:8px}
.map-filter-extra[hidden]{display:none}
.map-card-body{display:grid;align-content:start;gap:5px}
.map-card-body .map-chips,.map-card-body .map-card-desc{margin-top:0}
.map-card-text .map-card-body{padding-block:16px}
.map-original-trigger{display:block;width:100%;padding:0!important;border:0!important;background:transparent!important}
.map-original-trigger .map-reading-cover{margin-inline:auto}
.map-original{max-width:min(96vw,1100px);max-height:95vh;overflow:auto;margin:0 auto 12px;padding:10px;border:1px solid var(--m-line);border-radius:10px;background:var(--m-card);color:var(--m-ink)}
.map-original[open]{margin:auto}
.map-original::backdrop{background:rgb(0 0 0 / .58)}
.map-original img{display:block;max-width:100%;max-height:78vh;object-fit:contain;width:auto;height:auto;margin:8px auto 0;border-radius:6px}
.map-focus-settings{flex-basis:100%;margin-top:6px}
.map-focus-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:10px;margin:8px 0}
.map-focus-grid figure{min-width:0;margin:0}
.map-focus-grid figcaption{font-size:12px;color:var(--m-dim);margin-bottom:4px}
.map-focus-preview{position:relative;display:block;width:100%;overflow:hidden;border-radius:8px;background:var(--m-soft);touch-action:none;cursor:crosshair}
.map-focus-preview img{display:block;width:100%;object-fit:cover;pointer-events:none}
.map-focus-original{width:fit-content;max-width:100%;margin-inline:auto}
.map-focus-original img{width:auto;max-width:100%;max-height:210px;object-fit:contain}
.map-focus-preview span{position:absolute;width:16px;height:16px;transform:translate(-50%,-50%);border:2px solid white;box-shadow:0 0 0 1px rgb(0 0 0 / .6);border-radius:50%;pointer-events:none}
.map-focus-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.map-focus-controls label{display:flex;align-items:center;gap:5px}
.map-edit-conflicts{display:grid;gap:8px}
.map-edit-conflict{padding:8px 10px;border:1px solid color-mix(in srgb,#d9534f 45%,var(--m-line));border-radius:8px;background:color-mix(in srgb,#d9534f 5%,transparent)}
.map-edit-conflict strong{display:block;margin-bottom:3px;color:var(--m-ink)}
.map-edit-conflict button{margin:4px 6px 0 0}
.map-edit-conflict .map-field{margin-bottom:3px;font-size:12px}
/* 第二轮地点册视觉：状态统一、类型弱着色、管理/浏览分区 */
.map-kind-home{--m-kind:var(--accent,#00a870)}
.map-kind-frequent{--m-kind:#d99232}
.map-kind-around{--m-kind:#7f8c98}
.map-kind-travel{--m-kind:#7a6ac8}
.map-card{border-top:2px solid color-mix(in srgb,var(--m-kind,var(--m-line)) 72%,transparent)}
.map-card-home{border-left:3px solid var(--m-kind)!important}
.map-card-freq{border-left:3px solid var(--m-kind)!important}
.map-card .map-statuses{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}
.map-status{font-size:11px;line-height:1.35;padding:2px 7px;border-radius:999px;border:1px solid color-mix(in srgb,var(--m-kind,var(--m-line)) 45%,var(--m-line));background:color-mix(in srgb,var(--m-kind,var(--m-card)) 10%,var(--m-card));color:var(--m-dim);white-space:nowrap}
.map-status-kind{color:var(--m-ink);font-weight:600}
.map-status-warn{--m-kind:#d99232}
.map-status-link{--m-kind:var(--m-accent)}
.map-cover-empty{display:flex;align-items:center;justify-content:center;min-height:104px;aspect-ratio:16/9;background:linear-gradient(135deg,color-mix(in srgb,var(--m-kind,#88939b) 10%,var(--m-card)),color-mix(in srgb,var(--m-kind,#88939b) 3%,var(--m-soft)));color:var(--m-dim);font-size:12px;letter-spacing:.02em}
.map-cover-empty::before{content:'✦';font-size:18px;margin-inline-end:7px;opacity:.58}
.map-home-art .map-cover-empty{height:100%;min-height:145px;aspect-ratio:auto}
.map-filter-extra,.map-sort-row,.map-saved-views,.map-resource-list{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.map-sort-row{flex-basis:100%;margin-top:3px}
.map-sort-row label{font-size:12px;color:var(--m-dim)}
.map-saved-views{padding:7px 0 2px;flex-basis:100%}
.map-saved-view{border-radius:999px!important;font-size:11.5px!important;padding:3px 9px!important}
.map-saved-view-active{border-color:var(--m-accent)!important;background:color-mix(in srgb,var(--m-accent) 12%,var(--m-card))!important;font-weight:600}
.map-breadcrumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:0 0 10px;padding:5px 2px;color:var(--m-dim);font-size:12px}
.map-breadcrumbs button{border:0;background:transparent;padding:2px 4px;color:var(--m-accent);cursor:pointer}
.map-breadcrumbs span{color:var(--m-dim)}
.map-resource{padding:8px 10px;border:1px solid var(--m-line);border-radius:8px;background:var(--m-card);min-width:min(100%,260px);flex:1 1 260px}
.map-resource-name{font-weight:600;overflow-wrap:anywhere}
.map-resource-meta{color:var(--m-dim);font-size:11.5px}
.map-resource-unref{--m-kind:#d99232}
.map-resource-missing{--m-kind:#d9534f}
.map-zone-browse{position:relative}
.map-zone-edit{background:color-mix(in srgb,var(--m-accent) 3%,transparent);border-radius:10px;padding:3px}
.map-zone-manage{background:color-mix(in srgb,var(--foreground,#1b1a1e) 3%,transparent);border:1px solid var(--m-line);border-radius:10px;padding:10px;margin-bottom:12px}
.map-focus-frame{position:absolute;inset:0;border:2px dashed var(--m-accent);outline:1px solid var(--m-card);pointer-events:none;border-radius:2px;visibility:hidden}
.map-focus-frame-1{border-style:dotted;border-color:var(--m-warm)}
.map-home-art{align-self:center;aspect-ratio:16/10}
.map-home-art .map-thumb{height:auto;min-height:0;max-height:none;aspect-ratio:16/10}
.map-resource-name input{margin-inline-end:6px}
.map-card .map-card-body{background:color-mix(in srgb,var(--m-kind,var(--m-card)) 4%,var(--m-card))}
.map-statuses{display:flex;gap:5px;flex-wrap:wrap}
.map-status{white-space:normal;overflow-wrap:anywhere}
.map-card .map-card-desc{min-height:3.2em}
.map-recent-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.map-recent-row .map-saved-views{flex-basis:auto;max-width:100%}
.map-resource-missing{border-color:color-mix(in srgb,var(--m-kind) 50%,var(--m-line))}
.map-focus-preview{isolation:isolate}
.map-focus-preview .map-focus-frame{z-index:2}
@media(max-width:420px){.map-sort-row select{flex:1 1 150px}.map-resource{flex-basis:100%}.map-focus-grid{grid-template-columns:1fr}}
@container little-world (max-width:460px){
  .map-home-banner{grid-template-columns:1fr}
  .map-home-art .map-thumb{height:auto;min-height:0}
  .map-home-copy,.map-reading{padding:12px}
  .map-toolbar input[type=search]{flex-basis:100%}
  .map-filter-row .map-quick-filters,.map-filter-extra{flex-basis:100%}
  .map-grid{grid-template-columns:1fr}
}
@media(max-width:420px){.map-home-banner{grid-template-columns:1fr}.map-home-art .map-thumb{height:auto;min-height:0}.map-toolbar input[type=search]{flex-basis:100%}}
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
    search: '搜索名称、别名、标签、地形', manage: '管理', addPreset: '添加预设',
    edit: '编辑', read: '返回阅读', close: '收起', backPlace: '返回上一处',
    currentHome: '当前住所', viewHome: '查看住所', reset: '清除筛选', noResults: '没有符合条件的地点',
    filterLabel: '筛选地点', relationLabel: '地点关联',
    sortLabel: '排序', sortKind: '默认分组', sortUpdated: '最近编辑', sortViewed: '最近查看',
    sortName: '名称', sortFrequent: '常去优先', sortCover: '有图优先', sortCompleteness: '完整度',
    recentViewed: '最近查看', recentEdited: '最近编辑', savedViews: '我的视图', saveView: '保存当前视图',
    viewName: '视图名称', applyView: '应用', removeView: '删除视图', deleteViewConfirm: '删除这个已保存视图？', viewSaved: '视图已保存',
    inspectCovers: '检查图片', coverInventory: '图片资源检查', coverNoRefs: '没有发现引用', coverUsed: '已引用', coverMissing: '文件缺失',
    cleanCandidates: '无引用图片（需手动核查）', coverCleanupBlocked: '不会自动删除图片；请先保留数据目录副本并自行核查备份与恢复点。',
    relationTrail: '浏览路径', currentPlace: '当前地点', resetCoverFocus: '恢复居中', presetFocus: '焦点预设',
    focusTop: '主体靠上', focusCenter: '居中', focusBottom: '主体靠下', focusRule: '裁切范围',
    noCoverLabel: '还没有封面', recentlyViewedLabel: '最近看过', recentlyEditedLabel: '最近编辑过',
    coverOldWarning: '旧图片可能仍被备份、恢复点或撤销引用，请不要只凭“无引用”结果删除。',
    options: '联动设置',
    resultCount: (total, count) => `共 ${total} 处 · 当前显示 ${count} 处`,
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
    // 批量管理
    batchOpen: '批量管理',
    batchDone: '完成选择',
    batchAll: '全选当前筛选',
    batchNone: '清空选择',
    batchTagAdd: '加标签',
    batchTagRemove: '移除标签',
    batchFrequentOn: '标记常去',
    batchFrequentOff: '取消常去',
    batchKind: '改归类',
    batchTagPlaceholder: '标签（最多 8 个，每处）',
    batchEmpty: '先勾选要处理的地点',
    batchDoneMsg: '批量改好了',
    // 删除撤销
    undoRemoved: '删掉了',
    undoButton: '撤销',
    undoHint: '10 秒内可撤销；期间改动别处会失效。',
    undoOk: '撤销了，地点回来了',
    quickFilters: '常用筛选',
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
     search: 'Search names, aliases, tags and terrain', manage: 'Manage', addPreset: 'Add presets',
     edit: 'Edit', read: 'Back to reading', close: 'Close', backPlace: 'Back to previous place',
     currentHome: 'Current home', viewHome: 'View home', reset: 'Clear filters', noResults: 'No matching places',
     filterLabel: 'Filter places', relationLabel: 'Place relations', options: 'Link settings',
     sortLabel: 'Sort', sortKind: 'Default groups', sortUpdated: 'Recently edited', sortViewed: 'Recently viewed',
     sortName: 'Name', sortFrequent: 'Frequent first', sortCover: 'With photo first', sortCompleteness: 'Completeness',
     recentViewed: 'Recently viewed', recentEdited: 'Recently edited', savedViews: 'Saved views', saveView: 'Save current view',
     viewName: 'View name', applyView: 'Apply', removeView: 'Delete view', deleteViewConfirm: 'Delete this saved view?', viewSaved: 'View saved',
     inspectCovers: 'Inspect photos', coverInventory: 'Photo inventory', coverNoRefs: 'No references found', coverUsed: 'Referenced', coverMissing: 'File missing',
     cleanCandidates: 'No-reference candidates (review required)', coverCleanupBlocked: 'Photos are never deleted automatically. Keep a copy of the data folder and review backups and recovery snapshots yourself.',
     relationTrail: 'Browsing path', currentPlace: 'Current place', resetCoverFocus: 'Center focus', presetFocus: 'Focus presets',
     focusTop: 'Subject near top', focusCenter: 'Center', focusBottom: 'Subject near bottom', focusRule: 'Crop area',
     noCoverLabel: 'No cover yet', recentlyViewedLabel: 'Recently viewed', recentlyEditedLabel: 'Recently edited',
     coverOldWarning: 'Older photos may still be referenced by backups, recovery snapshots or undo; do not delete based only on the no-reference result.',
     resultCount: (total, count) => `${count} of ${total} places`,
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
    batchOpen: 'Select multiple',
    batchDone: 'Done selecting',
    batchAll: 'Select filtered',
    batchNone: 'Clear selection',
    batchTagAdd: 'Add tag',
    batchTagRemove: 'Remove tag',
    batchFrequentOn: 'Mark frequent',
    batchFrequentOff: 'Unmark frequent',
    batchKind: 'Change kind',
    batchTagPlaceholder: 'Tag (8 per place max)',
    batchEmpty: 'Tick the places you want to change first',
    batchDoneMsg: 'Changes applied',
    undoRemoved: 'Deleted',
    undoButton: 'Undo',
    undoHint: 'Undo within 10 seconds; changing another place cancels it.',
    undoOk: 'Undone — the place is back',
    quickFilters: 'Quick filters',
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
    editing: false,
    detached: false,
    trail: [],
    managing: false,
    tagFilter: '',
    filtersOpen: false,
    view: 'cards',
    sort: 'kind',
    savedViews: [],
    pinned: [],
    recentViewed: [],
    recentEdited: [],
    prefsLoaded: false,
    prefsTimer: null,
    savingView: false,
    coverInventory: null,
    coverSelected: new Set(),
    coverArchives: [],
    resourcesBusy: false,
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
    openOptions: new Set(),
    baseRevisions: new Map(),
    baseValues: new Map(),
    // 批量管理：进入后卡片点击 = 勾选，不再是展开。
    batchMode: false,
    selectedIds: new Set(),
    // 撤销牌：服务端给的 10 秒窗口，`undoTimer` 只负责到点把提示收掉。
    undo: null,
    undoTimer: null,
  };

  root.replaceChildren();
  const box = shell(root, t.title);
  const head = el('div', { class: 'map-zone-manage-head' });
  const body = el('div', { class: 'map-zone-browse' });
  box.appendChild(head);
  box.appendChild(body);

  const setMessage = (text, ok = true) => {
    state.message = text ? { text, ok } : null;
  };

  const prefsSnapshot = () => ({
    version: 1,
    savedViews: state.savedViews.map((view) => ({ ...view })),
    pinned: [...state.pinned],
    recentViewed: [...state.recentViewed],
    recentEdited: [...state.recentEdited],
  });
  const applyPrefs = (prefs) => {
    if (!prefs || prefs.version !== 1) return;
    state.savedViews = Array.isArray(prefs.savedViews) ? prefs.savedViews.map((view) => ({ ...view })) : [];
    state.pinned = Array.isArray(prefs.pinned) ? [...prefs.pinned] : [];
    state.recentViewed = Array.isArray(prefs.recentViewed) ? [...new Set(prefs.recentViewed)] : [];
    state.recentEdited = Array.isArray(prefs.recentEdited) ? [...new Set(prefs.recentEdited)] : [];
  };
  const persistPrefs = () => {
    if (!state.prefsLoaded) return;
    if (state.prefsTimer) clearTimeout(state.prefsTimer);
    state.prefsTimer = setTimeout(() => {
      const prefs = prefsSnapshot();
      Promise.resolve(ctx.invoke('savePanelPrefs', [{ prefs }])).then((result) => {
        if (result?.ok === false) throw new Error(result.error ?? '偏好保存失败');
      }).catch((err) => {
        setMessage(`${language === 'en' ? 'Preferences were not saved' : '面板偏好未保存'}：${err?.message ?? err}`, false);
        if (state.data && !ctx.signal?.aborted) renderHead();
      });
    }, 250);
  };
  const touchRecent = (key, id) => {
    if (!id || !state.data?.places?.some((place) => place.id === id)) return;
    state[key] = [id, ...state[key].filter((item) => item !== id)].slice(0, 12);
    refreshRecentStrips();
    persistPrefs();
  };
  const loadPrefs = async () => {
    try {
      const result = await ctx.invoke('getPanelPrefs', []);
      if (result?.ok !== false) applyPrefs(result?.prefs);
    } catch { /* older host: browser session still works */ }
    state.prefsLoaded = true;
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
      if (mutating && ['edit', 'upload', 'clearCover', 'coverFocus', 'frequent', 'batchEdit', 'setHome', 'add', 'terrain'].includes(method)) {
        const editedId = args?.[0]?.id ?? r?.place?.id;
        if (editedId) touchRecent('recentEdited', String(editedId));
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
      const drafts = [...state.drafts].map(([id, fields]) => ({ id, fields,
        ...(state.baseValues.has(id) ? { base: { revision: state.baseRevisions.get(id), fields: state.baseValues.get(id) } } : {}),
      }));
      Promise.resolve(ctx.invoke('saveDrafts', [{ drafts }])).catch(() => {});
    }, 350);
  };
  function applyDrafts(drafts) {
    state.drafts.clear();
    state.baseValues.clear();
    state.baseRevisions.clear();
    for (const item of drafts ?? []) {
      if (!item || typeof item.id !== 'string' || !item.fields || typeof item.fields !== 'object') continue;
      state.drafts.set(item.id, { ...item.fields });
      if (item.base?.fields && typeof item.base.fields === 'object' && typeof item.base.revision === 'string') {
        state.baseValues.set(item.id, { ...item.base.fields });
        state.baseRevisions.set(item.id, item.base.revision);
      }
    }
    state.draftsLoaded = true;
    state.restoredDrafts = [...state.drafts.keys()];
  }
  function captureDraft(key) {
    const form = forms.get(key);
    if (!form) return;
    const draft = { ...state.drafts.get(key) };
    for (const [field, node] of Object.entries(form.nodes)) {
      if (node.value !== form.values[field]) {
        if (!state.pending.has(`edit:${key}`) && state.baseValues.has(key) && sameEditValue(field, node.value, state.baseValues.get(key)[field])) delete draft[field];
        else draft[field] = node.value;
      }
      form.values[field] = node.value;
    }
    if (Object.keys(draft).length) state.drafts.set(key, draft);
    else state.drafts.delete(key);
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
  const placeEditValues = (place) => ({
    name: place.name ?? '', desc: place.desc ?? '', style: place.style ?? '',
    aliases: (place.aliases ?? []).join('、'), tags: (place.tags ?? []).join('、'),
    kind: place.kind ?? '', scene: place.scene ?? '', funVenue: place.funVenue ?? '',
    relationsJson: JSON.stringify((place.relations ?? []).map(({ placeId, note }) => ({ placeId, note }))),
  });
  function sameEditValue(field, left, right) {
    const comparable = (value) => {
      if (field === 'aliases' || field === 'tags') return JSON.stringify([...new Set(String(value ?? '').split(/[、,，]/).map((part) => part.trim()).filter(Boolean))]);
      if (field === 'relationsJson') {
        try {
          const rows = JSON.parse(value || '[]');
          if (Array.isArray(rows)) return JSON.stringify(rows.map((row) => ({ placeId: String(row?.placeId ?? '').trim(), note: String(row?.note ?? '').trim() })));
        } catch { /* Invalid input remains a distinct draft until validation. */ }
      }
      return String(value ?? '').trim();
    };
    return comparable(left) === comparable(right);
  }
  function editPayload(id, values) {
    return {
      id, expectedRevision: state.baseRevisions.get(id),
      name: String(values.name ?? '').trim(), desc: values.desc,
      style: String(values.style ?? '').trim(),
      aliases: String(values.aliases ?? '').split(/[、,，]/).map((part) => part.trim()).filter(Boolean),
      tags: String(values.tags ?? '').split(/[、,，]/).map((part) => part.trim()).filter(Boolean),
      kind: values.kind, scene: String(values.scene ?? '').trim(), funVenue: String(values.funVenue ?? '').trim(),
      relations: JSON.parse(values.relationsJson || '[]'),
    };
  }
  function storeRebasedDraft(id, current, values, advanceBase = true) {
    const currentValues = placeEditValues(current);
    const draft = {};
    for (const field of Object.keys(currentValues)) {
      if (!sameEditValue(field, values[field], currentValues[field])) draft[field] = values[field];
    }
    if (Object.keys(draft).length) state.drafts.set(id, draft);
    else state.drafts.delete(id);
    if (advanceBase) {
      state.baseValues.set(id, currentValues);
      state.baseRevisions.set(id, current.revision);
    }
    const index = state.data.places.findIndex((place) => place.id === id);
    if (index >= 0) state.data.places[index] = { ...state.data.places[index], ...current };
    forms.delete(id);
    persistDrafts();
    return { ...currentValues, ...draft };
  }
  function mergeEditConflict(id, current) {
    captureDraft(id);
    const base = state.baseValues.get(id) ?? placeEditValues(current);
    const mine = { ...base, ...state.drafts.get(id) };
    const saved = placeEditValues(current);
    const merged = {};
    const fields = [];
    for (const field of Object.keys(saved)) {
      const localChanged = !sameEditValue(field, mine[field], base[field]);
      const remoteChanged = !sameEditValue(field, saved[field], base[field]);
      merged[field] = localChanged ? mine[field] : saved[field];
      if (localChanged && remoteChanged && !sameEditValue(field, mine[field], saved[field])) fields.push({ field, base: base[field], mine: mine[field], current: saved[field] });
    }
    if (fields.length) state.conflicts.set(id, { current, fields });
    else state.conflicts.delete(id);
    const values = storeRebasedDraft(id, current, merged, !fields.length);
    return { values, fields };
  }
  function resolveEditConflict(id, field, useCurrent) {
    const conflict = state.conflicts.get(id);
    if (!conflict) return;
    const values = formValues(id);
    const selected = field ? conflict.fields.filter((entry) => entry.field === field) : conflict.fields;
    for (const entry of selected) {
      if (useCurrent) values[entry.field] = entry.current;
    }
    conflict.fields = conflict.fields.filter((entry) => !selected.includes(entry));
    if (!conflict.fields.length) state.conflicts.delete(id);
    storeRebasedDraft(id, conflict.current, values, !conflict.fields.length);
    setMessage(language === 'en' ? 'Choices kept in your draft. Save again; newer changes will be checked.' : '选择已保留在草稿中，请再保存；若记录再次变化会重新比较。');
    render();
  }
  function editConflictPanel(id) {
    const conflict = state.conflicts.get(id);
    if (!conflict) return null;
    const labels = { name: language === 'en' ? 'Name' : '名字', desc: t.detailDesc, style: t.detailStyle, aliases: t.detailAliases,
      tags: t.detailTags, kind: language === 'en' ? 'Kind' : '归类', scene: t.detailScene, funVenue: t.detailFunVenue, relationsJson: t.relationLabel };
    const shown = (value) => String(value ?? '') || (language === 'en' ? '(empty)' : '（空）');
    return el('div', { class: 'map-msg map-msg-bad map-edit-conflicts', role: 'alert' },
      el('div', { text: language === 'en' ? 'Only these fields changed differently. Other edits have been merged; your draft is preserved.' : '只有以下字段双方改成了不同内容，需要逐项选择；其他改动已自动合并，草稿仍保留。' }),
      ...conflict.fields.map((entry) => el('div', { class: 'map-field map-edit-conflict', 'data-field': entry.field },
        el('strong', { text: labels[entry.field] }),
        el('div', { text: `${language === 'en' ? 'Base' : '原始内容'}：${shown(entry.base)}` }),
        el('div', { text: `${language === 'en' ? 'My draft' : '我的草稿'}：${shown(forms.get(id)?.nodes[entry.field]?.value ?? entry.mine)}` }),
        el('div', { text: `${language === 'en' ? 'Current saved' : '当前已保存'}：${shown(entry.current)}` }),
        el('button', { type: 'button', text: language === 'en' ? `Keep mine: ${labels[entry.field]}` : `保留我的：${labels[entry.field]}`, onclick: () => resolveEditConflict(id, entry.field, false) }),
        el('button', { type: 'button', text: language === 'en' ? `Use current: ${labels[entry.field]}` : `采用当前：${labels[entry.field]}`, onclick: () => resolveEditConflict(id, entry.field, true) }))),
      el('div', { class: 'map-note', text: language === 'en' ? 'The following actions apply only to the remaining conflicting fields.' : '以下操作仅处理尚未选择的冲突字段，其他已合并的改动会保留。' }),
      el('button', { type: 'button', text: '载入当前版本', onclick: () => resolveEditConflict(id, null, true) }),
      el('button', { type: 'button', text: '保留草稿，确认覆盖', onclick: () => resolveEditConflict(id, null, false) }));
  }
  function clearAllDrafts() {
    forms.clear();
    state.drafts.clear();
    state.baseValues.clear();
    state.baseRevisions.clear();
    state.conflicts.clear();
    state.restoredDrafts = null;
    if (state.draftTimer) clearTimeout(state.draftTimer);
    state.draftTimer = null;
    state.draftsLoaded = false;
  }

  /** 同一轮里，住所横幅、卡片和详情共享一份封面请求。 */
  const coverRequests = new Map();
  function coverOf(id) {
    if (state.covers.has(id)) return Promise.resolve(state.covers.get(id));
    const version = state.loadVersion;
    const pending = coverRequests.get(id);
    if (pending?.version === version) return pending.promise;
    const request = {
      version,
      promise: call('cover', [{ id }]).then((result) => result?.dataUrl ?? '', () => '').then((url) => {
        if (version !== state.loadVersion || ctx.signal?.aborted) return '';
        state.covers.set(id, url);
        return url;
      }).finally(() => {
        if (coverRequests.get(id) === request) coverRequests.delete(id);
      }),
    };
    coverRequests.set(id, request);
    return request.promise;
  }

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

  function sortLabel(sort) {
    return { kind: t.sortKind, updated: t.sortUpdated, viewed: t.sortViewed, name: t.sortName,
      frequent: t.sortFrequent, cover: t.sortCover, completeness: t.sortCompleteness }[sort] ?? t.sortKind;
  }

  function sortPlaces(items) {
    const copy = [...items];
    const recentIndex = (id, list) => { const index = list.indexOf(id); return index < 0 ? 999 : index; };
    if (state.sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
    if (state.sort === 'frequent') return copy.sort((a, b) => Number(b.frequent) - Number(a.frequent) || a.name.localeCompare(b.name));
    if (state.sort === 'cover') return copy.sort((a, b) => Number(b.hasCover) - Number(a.hasCover) || a.name.localeCompare(b.name));
    if (state.sort === 'completeness') return copy.sort((a, b) => completeness(b).localeCompare(completeness(a), undefined, { numeric: true }) || a.name.localeCompare(b.name));
    if (state.sort === 'viewed') return copy.sort((a, b) => recentIndex(a.id, state.recentViewed) - recentIndex(b.id, state.recentViewed) || a.name.localeCompare(b.name));
    if (state.sort === 'updated') return copy.sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0) || recentIndex(a.id, state.recentEdited) - recentIndex(b.id, state.recentEdited) || a.name.localeCompare(b.name));
    return copy;
  }

  function saveCurrentView() {
    state.savingView = true;
    state.pendingViewName = '';
    render();
  }

  function viewObject(name) {
    return { id: `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name,
      query: state.query, filter: state.filter, tagFilter: state.tagFilter, view: state.view, sort: state.sort };
  }

  function savedViewsBar() {
    const row = el('div', { class: 'map-saved-views', 'aria-label': t.savedViews });
    row.appendChild(el('span', { class: 'map-dim', text: `${t.savedViews}：` }));
    for (const saved of state.savedViews) {
      const active = ['query', 'filter', 'tagFilter', 'sort', 'view'].every((key) => saved[key] === state[key]);
      row.appendChild(el('button', {
        type: 'button', class: active ? 'map-saved-view map-saved-view-active' : 'map-saved-view', text: saved.name,
        'aria-pressed': String(active), title: `${saved.query || saved.name} · ${sortLabel(saved.sort)}`,
        onclick: () => { Object.assign(state, { query: saved.query, filter: saved.filter, tagFilter: saved.tagFilter, view: saved.view, sort: saved.sort }); render(); },
      }));
      row.appendChild(el('button', { type: 'button', class: 'map-dim', text: '×', title: t.removeView, 'aria-label': `${t.removeView}: ${saved.name}`,
        onclick: async () => {
          if (!(await askConfirm(ctx, t.deleteViewConfirm))) return;
          state.savedViews = state.savedViews.filter((item) => item.id !== saved.id); persistPrefs(); render();
        } }));
    }
    if (state.savingView) {
      const input = el('input', { type: 'text', placeholder: t.viewName, 'aria-label': t.viewName, value: state.pendingViewName,
        oninput: (event) => { state.pendingViewName = event.target.value; } });
      row.appendChild(input);
      row.appendChild(el('button', { type: 'button', text: t.saveView, onclick: () => {
        const name = String(state.pendingViewName || '').trim();
        if (!name) { input.focus?.(); return; }
        if (Array.from(name).length > 40 || state.savedViews.length >= 8 || state.query.length > 160) {
          setMessage(language === 'en' ? 'Use a name of at most 40 characters, a search of at most 160, and at most 8 views.' : '名称最多 40 字、搜索最多 160 字，最多保存 8 个视图。', false);
          render(); return;
        }
        state.savedViews = [...state.savedViews, viewObject(name)];
        state.savingView = false; state.pendingViewName = ''; persistPrefs(); setMessage(t.viewSaved, true); render();
      } }));
      row.appendChild(el('button', { type: 'button', text: t.addCancel, onclick: () => { state.savingView = false; render(); } }));
    } else row.appendChild(el('button', { type: 'button', class: 'map-saved-view', text: t.saveView, onclick: saveCurrentView }));
    return row;
  }

  function sortPlacesByModified() {
    const rank = (id) => { const value = state.recentEdited.indexOf(id); return value < 0 ? 999 : value; };
    return [...state.data.places].filter((p) => p.modifiedAt > 0 || state.recentEdited.includes(p.id))
      .sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0) || rank(a.id) - rank(b.id)).map((p) => p.id);
  }

  function recentStrip(key, label, className) {
    const ids = (key === 'recentEdited' ? sortPlacesByModified() : state[key]).filter((id) => state.data.places.some((place) => place.id === id)).slice(0, 5);
    if (!ids.length) return null;
    return el('div', { class: `map-saved-views ${className}`, 'aria-label': label },
      el('span', { class: 'map-dim', text: `${label}：` }),
      ...ids.map((id) => {
        const place = state.data.places.find((item) => item.id === id);
        return el('button', { type: 'button', class: 'map-saved-view', text: place?.name ?? id, onclick: () => openPlace(id, { detached: true }) });
      }));
  }

  function refreshRecentStrips() {
    const area = head.querySelector('.map-recent-row');
    if (!area || !state.data) return;
    const viewed = recentStrip('recentViewed', t.recentViewed, 'map-recent-viewed');
    const edited = recentStrip('recentEdited', t.recentEdited, 'map-recent-edited');
    area.replaceChildren(...[viewed, edited].filter(Boolean));
  }

  function coverInventoryPanel() {
    const inventory = state.coverInventory;
    if (!inventory) return null;
    const en = language === 'en';
    const blocked = Boolean(state.resourcesBusy || inventory.warnings?.length || inventory.missing?.length || !inventory.revision);
    const panel = el('div', { class: 'map-resource-list', 'aria-label': t.coverInventory });
    const names = Object.fromEntries(state.data.places.map((p) => [p.id, p.name]));
    const sourceLabels = en ? {} : { current: '当前地点', saved: '最近保存', undo: '删除撤销', disk: '本地记录', backup: '上一版备份', recovery: '导入恢复点', corrupt: '损坏记录副本' };
    const refsText = (refs) => refs.map((ref) => `${names[ref.placeId] || ref.placeId || (en ? 'unknown' : '未知')} (${sourceLabels[ref.source] || ref.source})`).join('、');
    for (const file of inventory.files ?? []) {
      const refs = file.references ?? [];
      const canSelect = !blocked && file.archiveable && !refs.length;
      const checkbox = canSelect ? el('input', {
        type: 'checkbox', checked: state.coverSelected.has(file.filename), 'aria-label': `${en ? 'Archive' : '归档'} ${file.filename}`,
        onchange: (event) => {
          if (event.target.checked) state.coverSelected.add(file.filename);
          else state.coverSelected.delete(file.filename);
          renderHead();
        },
      }) : null;
      panel.appendChild(el('div', { class: refs.length ? 'map-resource' : 'map-resource map-resource-unref' },
        el('div', { class: 'map-resource-name' }, checkbox, file.filename),
        el('div', { class: 'map-resource-meta', text: `${Math.ceil(file.bytes / 1024)} KiB · ${refs.length ? `${t.coverUsed} ${refs.length}` : t.coverNoRefs}` }),
        refs.length ? el('div', { class: 'map-resource-meta', text: refsText(refs) }) : null));
    }
    for (const missing of inventory.missing ?? []) panel.appendChild(el('div', { class: 'map-resource map-resource-missing' },
      el('div', { class: 'map-resource-name', text: missing.filename }),
      el('div', { class: 'map-resource-meta', text: t.coverMissing }),
      el('div', { class: 'map-resource-meta', text: refsText(missing.references ?? []) })));
    if (inventory.warnings?.length) panel.appendChild(el('div', { class: 'map-note', text: inventory.warnings.map((warning) => `${warning.source}: ${warning.code}`).join(' · ') }));
    if (!(inventory.files?.length || inventory.missing?.length)) panel.appendChild(el('div', { class: 'map-note', text: en ? 'No photo files found.' : '没有图片文件。' }));
    const total = (inventory.files ?? []).reduce((sum, file) => sum + file.bytes, 0);
    panel.appendChild(el('div', { class: 'map-note', text: `${inventory.files?.length || 0} ${en ? 'files' : '个文件'} · ${(total / 1048576).toFixed(2)} MiB` }));
    panel.appendChild(el('div', { class: 'map-note', text: en
      ? 'Archive moves only selected photos with no known references. Photos stay recoverable and still use disk space. External backups are outside this check.'
      : '只将勾选且未发现引用的图片移入可恢复归档，不永久删除，也不释放磁盘空间。检查范围不含数据目录外的手动备份。' }));
    const selected = [...state.coverSelected].filter((name) => inventory.files.some((file) => file.filename === name && file.archiveable));
    panel.appendChild(el('button', {
      type: 'button', text: en ? `Archive selected (${selected.length})` : `归档所选图片（${selected.length}）`,
      disabled: blocked || !selected.length,
      onclick: async () => {
        if (blocked || !selected.length || state.resourcesBusy) return;
        const message = `${en ? 'Move these files into a recoverable archive?' : '将以下文件移入可恢复归档？'}\n${selected.join('\n')}`;
        if (!(await askConfirm(ctx, message)) || state.resourcesBusy) return;
        state.resourcesBusy = true;
        renderHead();
        try {
          await call('archiveCovers', [{ filenames: selected, expectedRevision: inventory.revision }]);
          setMessage(en ? 'Photos archived; restore them below when needed.' : '图片已归档，可在下方恢复。');
          await inspectCovers();
        } catch (err) { setMessage(String(err?.message ?? err), false); }
        finally { state.resourcesBusy = false; renderHead(); }
      },
    }));
    for (const archive of state.coverArchives) {
      if (archive.status === 'restored') continue;
      panel.appendChild(el('div', { class: 'map-resource map-cover-archive' },
        el('div', { class: 'map-resource-name', text: `${en ? 'Archive' : '归档'} · ${archive.createdAt}` }),
        el('div', { class: 'map-resource-meta', text: (archive.files ?? []).map((file) => file.filename).join('、') }),
        el('button', { type: 'button', text: en ? 'Restore archive' : '恢复归档', disabled: state.resourcesBusy,
          onclick: async () => {
            if (state.resourcesBusy || !(await askConfirm(ctx, en ? 'Restore these photos? Existing files will not be overwritten.' : '恢复这些图片？已有文件不会被覆盖。'))) return;
            state.resourcesBusy = true; renderHead();
            try {
              await call('restoreCoverArchive', [{ id: archive.id }]);
              setMessage(en ? 'Archive restored' : '归档已恢复');
              await inspectCovers();
            } catch (err) { setMessage(String(err?.message ?? err), false); }
            finally { state.resourcesBusy = false; renderHead(); }
          } })));
    }
    return panel;
  }

  async function inspectCovers() {
    try {
      const [result, archiveResult] = await Promise.all([ctx.invoke('inspectCovers', []), ctx.invoke('listCoverArchives', [])]);
      if (result?.ok === false) throw new Error(result.error ?? t.loadFail);
      if (archiveResult?.ok === false) throw new Error(archiveResult.error ?? t.loadFail);
      state.coverInventory = result;
      state.coverArchives = archiveResult?.archives ?? [];
      state.coverSelected.clear();
      if (state.data) renderHead();
    } catch (err) { setMessage(String(err?.message ?? err), false); if (state.data) renderHead(); }
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
        el('button', { type: 'button', text: '恢复草稿', onclick: () => { state.restoredDrafts = null; state.expanded = [...state.drafts.keys()].find((id) => id !== 'new') ?? null; state.editing = Boolean(state.expanded); state.detached = state.editing; state.trail = []; state.adding = state.drafts.has('new'); render(); } }),
        el('button', { type: 'button', text: '丢弃草稿', onclick: async () => { clearAllDrafts(); await ctx.invoke('saveDrafts', [{ drafts: [] }]); state.draftsLoaded = true; render(); } })));
    }

    const toolbar = el('div', { class: 'map-toolbar' });
    const filterRow = el('div', { class: 'map-filter-row' });
    const search = el('input', {
      type: 'search', placeholder: t.search, 'aria-label': t.search,
      value: state.query,
      oninput: (ev) => { state.query = ev.target.value; renderBody(); },
    });
    const refreshFilters = () => { drawFilters(); renderBody(); };
    const changeFilter = (value) => { state.filter = value; refreshFilters(); };
    toolbar.appendChild(search);
    const views = el('div', { class: 'map-view', role: 'group', 'aria-label': language === 'en' ? 'View' : '视图' });
    for (const [value, label] of [['cards', t.cardsView], ['relations', t.relationsView]]) {
      views.appendChild(el('button', {
        type: 'button', text: label, 'aria-pressed': String(state.view === value),
        disabled: state.batchMode && value === 'relations',
        onclick: () => {
          state.view = value;
          for (const button of views.children) button.setAttribute('aria-pressed', String(button.textContent === label));
          renderBody();
        },
      }));
    }
    toolbar.appendChild(views);
    toolbar.appendChild(el('button', {
      class: state.adding ? '' : 'map-btn-primary', type: 'button',
      text: state.adding ? t.addCancel : t.addOpen,
      onclick: () => { state.adding = !state.adding; render(); },
    }));
    toolbar.appendChild(el('button', {
      type: 'button', text: t.manage, 'aria-expanded': String(state.managing), 'aria-controls': 'little-world-management',
      disabled: Boolean(activeTransfer?.writing),
      onclick: () => {
        if (activeTransfer?.writing) return;
        state.managing = !state.managing;
        if (!state.managing) {
          activeTransfer = null;
          state.batchMode = false;
          state.selectedIds.clear();
        }
        render();
      },
    }));
    head.appendChild(toolbar);

    function drawFilters() {
      const en = language === 'en';
      const filterValues = [
        ['all', en ? 'All' : '全部'], ['frequent', en ? 'Frequent' : '常去'],
        ['hasCover', en ? 'With photo' : '有图'], ['noDesc', en ? 'Missing description' : '缺描写'],
        ['noCover', en ? 'Missing photo' : '缺图'], ['noRelation', en ? 'No relations' : '缺关系'],
      ];
      const quickFilters = el('div', { class: 'map-quick-filters', role: 'group', 'aria-label': t.quickFilters },
        ...filterValues.slice(0, 4).map(([value, label]) => el('button', {
          type: 'button', class: state.filter === value ? 'map-qf map-qf-on' : 'map-qf',
          'aria-pressed': String(state.filter === value), text: label,
          onclick: () => changeFilter(value),
        })));
      const filter = el('select', { 'aria-label': t.filterLabel, onchange: (ev) => changeFilter(ev.target.value) },
        ...filterValues.map(([value, label]) => el('option', { value, text: label })));
      filter.value = state.filter;
      const allTags = [...new Set(d.places.flatMap((p) => p.tags ?? []))].sort((a, b) => a.localeCompare(b));
      const tagFilter = el('select', {
        class: 'map-tag-filter', 'aria-label': t.tagFilter,
        onchange: (ev) => { state.tagFilter = ev.target.value; renderBody(); },
      }, el('option', { value: '', text: t.allTags }), ...allTags.map((tag) => el('option', { value: tag, text: tag })));
      tagFilter.value = state.tagFilter;
      const sortValues = [
        ['kind', t.sortKind], ['updated', t.sortUpdated], ['viewed', t.sortViewed],
        ['name', t.sortName], ['frequent', t.sortFrequent], ['cover', t.sortCover], ['completeness', t.sortCompleteness],
      ];
      const sortSelect = el('select', { 'aria-label': t.sortLabel, onchange: (event) => { state.sort = event.target.value; renderBody(); } },
        ...sortValues.map(([value, label]) => el('option', { value, text: label })));
      sortSelect.value = state.sort;
      const sortRow = el('div', { class: 'map-sort-row' }, el('label', { text: `${t.sortLabel}：` }), sortSelect);
      const extra = el('div', { class: 'map-filter-extra', id: 'little-world-extra-filters', hidden: !state.filtersOpen }, filter, tagFilter, sortRow, savedViewsBar());
      const toggle = el('button', {
        type: 'button', text: en ? 'More filters' : '更多筛选',
        'aria-controls': 'little-world-extra-filters', 'aria-expanded': String(state.filtersOpen),
        onclick: () => {
          state.filtersOpen = !state.filtersOpen;
          toggle.setAttribute('aria-expanded', String(state.filtersOpen));
          if (state.filtersOpen) extra.removeAttribute('hidden');
          else extra.setAttribute('hidden', '');
        },
      });
      filterRow.replaceChildren(quickFilters, toggle, extra);
    }
    drawFilters();
    head.appendChild(filterRow);
    head.appendChild(el('div', { class: 'map-recent-row' }));
    refreshRecentStrips();
    if (state.managing) head.appendChild(management(d));
    if (state.undo) head.appendChild(undoBar());
    if (state.adding) head.appendChild(addForm());
  }

  function management(d) {
    const panel = el('section', { class: 'map-manage map-zone-manage', id: 'little-world-management', 'aria-label': t.manage });
    panel.appendChild(el('div', { class: 'map-stats' },
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.total) }), el('span', { text: t.statsTotal })),
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.withCover) }), el('span', { text: t.statsCover })),
      el('div', { class: 'map-stat' }, el('b', { text: String(d.summary.frequent) }), el('span', { text: t.statsFreq }))));

    const terrainRow = el('div', { class: 'map-terrains', role: 'group', 'aria-label': t.addPreset });
    for (const terrain of d.terrains) {
      const active = state.terrainPick === terrain.id;
      terrainRow.appendChild(el('button', {
        type: 'button', class: active ? 'map-terrain map-terrain-on' : 'map-terrain',
        'aria-expanded': String(active), text: `${active ? '▾' : '＋'} ${terrain.label}`,
        title: terrain.note ?? '', onclick: () => chooseTerrain(terrain.id),
      }));
    }
    panel.appendChild(el('div', { class: 'map-bar' }, terrainRow,
      el('button', {
        type: 'button', 'aria-pressed': String(state.batchMode), text: state.batchMode ? t.batchDone : t.batchOpen,
        onclick: () => {
          state.batchMode = !state.batchMode;
          state.selectedIds.clear();
          if (state.batchMode) state.view = 'cards';
          render();
        },
      }),
      el('button', {
        type: 'button', text: t.refresh, title: t.refreshHint,
        onclick: () => { state.terrainPick = ''; state.picked = null; state.message = null; void load(); },
      })));
    if (state.terrainPick) panel.appendChild(picker(state.terrainPick));
    if (state.batchMode) panel.appendChild(batchToolbar());
    panel.appendChild(el('div', { class: 'map-bar' },
      el('button', { type: 'button', text: t.inspectCovers, onclick: () => { void inspectCovers(); } }),
      state.coverInventory ? el('button', { type: 'button', text: t.close, onclick: () => { state.coverInventory = null; render(); } }) : null));
    if (state.coverInventory) panel.appendChild(coverInventoryPanel());
    panel.appendChild(transferControls());
    return panel;
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

  /** 批量模式下点卡片 = 勾选/取消，不展开详情。 */
  function toggleSelect(id) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    render();
  }

  /**
   * 批量改：勾选的 id + 要改的那几项交给服务端。
   *
   * 规则不在这里重算：哪处标签会超、哪处已经不在了，都由服务端逐处判定并回报
   * （`skipped` 带原因），面板只负责说清「改了几处、跳过几处、为什么」。
   */
  async function batchApply(patch) {
    if (!state.selectedIds.size) {
      setMessage(t.batchEmpty, false);
      render();
      return;
    }
    try {
      const r = await call('batchEdit', [{ ids: [...state.selectedIds], ...patch }]);
      const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
      const why = skipped ? `（跳过 ${skipped} 处：${r.skipped[0].reason}）` : '';
      setMessage(`${t.batchDoneMsg}：${r.updated} 处${why}`, true);
      state.batchMode = false;
      state.selectedIds.clear();
      await load();
    } catch (err) {
      setMessage(String(err?.message ?? err), false);
      render();
    }
  }

  function batchToolbar() {
    const en = language === 'en';
    const count = state.selectedIds.size;
    const tagIn = el('input', { type: 'search', placeholder: t.batchTagPlaceholder, 'aria-label': t.batchTagPlaceholder });
    const kindSel = el('select', { 'aria-label': t.batchKind },
      el('option', { value: 'home', text: en ? 'Home' : '家' }),
      el('option', { value: 'frequent', text: en ? 'Frequent' : '常去的' }),
      el('option', { value: 'around', text: en ? 'Around' : '周围' }),
      el('option', { value: 'travel', text: en ? 'Travel' : '旅行' }));
    const takeTag = () => String(tagIn.value ?? '').trim();
    return el('div', { class: 'map-bar map-batch' },
      el('span', { class: 'map-chip', text: `${en ? 'Selected' : '已选'} ${count}${en ? '' : ' 处'}` }),
      el('button', { type: 'button', text: t.batchAll, onclick: () => { for (const p of filteredPlaces()) state.selectedIds.add(p.id); render(); } }),
      el('button', { type: 'button', text: t.batchNone, onclick: () => { state.selectedIds.clear(); render(); } }),
      tagIn,
      el('button', { type: 'button', text: t.batchTagAdd, onclick: () => { const tag = takeTag(); if (tag) void batchApply({ addTags: [tag] }); } }),
      el('button', { type: 'button', text: t.batchTagRemove, onclick: () => { const tag = takeTag(); if (tag) void batchApply({ removeTags: [tag] }); } }),
      el('button', { type: 'button', text: t.batchFrequentOn, onclick: () => { void batchApply({ frequent: true }); } }),
      el('button', { type: 'button', text: t.batchFrequentOff, onclick: () => { void batchApply({ frequent: false }); } }),
      kindSel,
      el('button', { type: 'button', text: t.batchKind, onclick: () => { void batchApply({ kind: kindSel.value }); } }));
  }

  function clearUndoTimer() {
    if (state.undoTimer) clearTimeout(state.undoTimer);
    state.undoTimer = null;
  }

  /**
   * 到点把撤销提示收掉。
   *
   * 服务端那边同一个 token 也在这时候失效，界面上不该继续摆一个按了必然失败的按钮。
   */
  function scheduleUndoClear() {
    clearUndoTimer();
    if (!state.undo) return;
    const left = Math.max(0, Number(state.undo.remainingMs ?? 0));
    state.undoTimer = setTimeout(() => {
      state.undo = null;
      state.undoTimer = null;
      if (state.data) render();
    }, left + 50);
    // 浏览器里没有 unref；Node 里（测试）别让这个 10 秒的定时器把进程多按住。
    state.undoTimer?.unref?.();
  }

  function undoBar() {
    const u = state.undo;
    return el('div', { class: 'map-msg map-msg-ok' },
      el('span', { text: `${t.undoRemoved}「${u.name}」` }),
      el('button', {
        type: 'button',
        class: 'map-btn-primary',
        text: t.undoButton,
        onclick: async () => {
          try {
            await call('undoRemove', [{ token: u.token }]);
            state.undo = null;
            clearUndoTimer();
            setMessage(t.undoOk, true);
            await load();
          } catch (err) {
            state.undo = null;
            clearUndoTimer();
            setMessage(String(err?.message ?? err), false);
            render();
          }
        },
      }),
      el('span', { class: 'map-note', text: t.undoHint }));
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
    return el('div', { class: 'map-detail map-zone-edit', style: { marginBottom: '12px' } },
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

  /**
   * 当前筛选命中的地点。
   *
   * 抽成一个函数是因为「全选当前筛选」和卡片墙必须用**同一套**判据——
   * 各写一份的话，界面上选中的和实际批量改的会悄悄对不上。
   */
  function filteredPlaces() {
    const words = state.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return state.data.places.filter((p) => {
      const tags = p.tags ?? [];
      const hay = [p.name, ...(p.aliases ?? []), p.kindLabel, p.terrain, p.terrainLabel, ...tags]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      if (!words.every((word) => hay.includes(word))) return false;
      if (state.tagFilter && !tags.includes(state.tagFilter)) return false;
      switch (state.filter) {
        case 'noDesc': return !String(p.desc ?? '').trim();
        case 'noCover': return !p.hasCover;
        case 'hasCover': return Boolean(p.hasCover);
        case 'noRelation': return Boolean(p.completeness?.orphan ?? !(p.relations?.length));
        case 'frequent': return Boolean(p.frequent || p.kind === 'frequent');
        default: return true;
      }
    });
  }

  function resultSummary(total, count) {
    const row = el('div', { class: 'map-results' }, el('span', {
      class: 'map-results-count', role: 'status', text: t.resultCount(total, count),
    }));
    const removeFilter = (label, clear) => el('button', {
      type: 'button', class: 'map-chip', text: `${label} ×`,
      'aria-label': `${t.reset}: ${label}`, onclick: () => { clear(); render(); },
    });
    if (state.query.trim()) row.appendChild(removeFilter(state.query.trim(), () => { state.query = ''; }));
    if (state.tagFilter) row.appendChild(removeFilter(state.tagFilter, () => { state.tagFilter = ''; }));
    if (state.filter !== 'all') {
      const labels = language === 'en'
        ? { frequent: 'Frequent', hasCover: 'With photo', noCover: 'Missing photo', noDesc: 'Missing description', noRelation: 'No relations' }
        : { frequent: '常去', hasCover: '有图', noCover: '缺图', noDesc: '缺描写', noRelation: '缺关系' };
      row.appendChild(removeFilter(labels[state.filter], () => { state.filter = 'all'; }));
    }
    if (state.filter !== 'all' || state.tagFilter || state.query.trim()) row.appendChild(el('button', {
      type: 'button', text: t.reset,
      onclick: () => { state.query = ''; state.tagFilter = ''; state.filter = 'all'; render(); },
    }));
    return row;
  }

  const focusPosition = ({ x = 50, y = 50 } = {}) => `${x}% ${y}%`;

  function coverImage(p, className) {
    if (!p.hasCover) return null;
    const image = (src) => el('img', {
      class: className, src, alt: p.name, loading: 'lazy',
      style: className === 'map-thumb' ? { objectPosition: focusPosition(p.coverFocus) } : null,
    });
    const cached = state.covers.get(p.id);
    if (cached) return image(cached);
    if (state.covers.has(p.id)) return null;
    const placeholder = el('div', { class: className, 'aria-hidden': 'true' });
    void coverOf(p.id).then((url) => {
      if (url && placeholder.parentNode) placeholder.parentNode.replaceChild(image(url), placeholder);
    });
    return placeholder;
  }

  function coverOrEmpty(p, className) {
    return p.hasCover ? coverImage(p, className) : el('div', { class: `map-cover-empty ${className}`, text: t.noCoverLabel, 'aria-label': t.noCoverLabel });
  }

  function originalCover(p) {
    const preview = coverImage(p, 'map-reading-cover');
    if (!preview) return null;
    const label = language === 'en' ? 'View full image' : '查看原图';
    const dialog = el('dialog', { class: 'map-original', 'aria-label': label });
    const trigger = el('button', {
      type: 'button', class: 'map-original-trigger', 'aria-label': label, title: label,
      onclick: async () => {
        const src = await coverOf(p.id);
        if (!src || trigger.isConnected === false || dialog.hasAttribute?.('open')) return;
        dialog.replaceChildren(close, el('img', { src, alt: p.name }));
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        close.focus?.();
      },
    }, preview);
    const close = el('button', {
      type: 'button', text: language === 'en' ? 'Close image' : '关闭原图',
      onclick: () => {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
        trigger.focus?.({ preventScroll: true });
      },
    });
    return el('div', {}, trigger, dialog);
  }

  function coverFocusSettings(p) {
    const en = language === 'en';
    const start = p.coverFocus ?? { x: 50, y: 50 };
    const draft = { ...start };
    const position = (value) => Math.round(Math.min(100, Math.max(0, value)));
    let pointerId;
    const point = (event) => {
      const box = preview.getBoundingClientRect?.();
      if (!box?.width || !box?.height) return;
      setFocus((event.clientX - box.left) / box.width * 100, (event.clientY - box.top) / box.height * 100);
    };
    const marker = el('span', { 'aria-hidden': 'true' });
    const original = el('img', { alt: p.name });
    const crops = ['16 / 10', '16 / 9'].map((aspectRatio) => el('img', { alt: '', style: { aspectRatio } }));
    const frames = [16 / 10, 16 / 9].map((ratio, index) => el('div', {
      class: `map-focus-frame map-focus-frame-${index}`, 'aria-label': `${t.focusRule} ${index === 0 ? '16:10' : '16:9'}`,
      title: `${index === 0 ? (en ? 'Banner' : '横幅') : (en ? 'Card' : '卡片')} ${index === 0 ? '16:10' : '16:9'}`,
    }));
    function drawFrames() {
      const aspect = original.naturalWidth / original.naturalHeight;
      if (!Number.isFinite(aspect) || aspect <= 0) return;
      [16 / 10, 16 / 9].forEach((ratio, index) => {
        const width = Math.min(1, ratio / aspect);
        const height = Math.min(1, aspect / ratio);
        Object.assign(frames[index].style, {
          width: `${width * 100}%`, height: `${height * 100}%`, visibility: 'visible',
          left: `${draft.x * (1 - width)}%`, top: `${draft.y * (1 - height)}%`, right: 'auto', bottom: 'auto',
        });
      });
    }
    original.addEventListener('load', drawFrames);
    const preview = el('div', {
      class: 'map-focus-preview map-focus-original',
      onpointerdown: (event) => {
        if (event.button !== 0 || !original.src) return;
        pointerId = event.pointerId;
        preview.setPointerCapture?.(pointerId);
        point(event);
      },
      onpointermove: (event) => { if (pointerId !== undefined && event.pointerId === pointerId) point(event); },
      onpointerup: () => { pointerId = undefined; }, onpointercancel: () => { pointerId = undefined; },
      onlostpointercapture: () => { pointerId = undefined; },
    }, original, ...frames, marker);
    const ranges = ['x', 'y'].map((axis) => el('input', {
      type: 'range', min: '0', max: '100', value: String(draft[axis]),
      oninput: (event) => setFocus(axis === 'x' ? Number(event.target.value) : draft.x, axis === 'y' ? Number(event.target.value) : draft.y),
    }));
    function setFocus(x, y) {
      draft.x = position(x);
      draft.y = position(y);
      marker.style.left = `${draft.x}%`;
      marker.style.top = `${draft.y}%`;
      ranges[0].value = String(draft.x);
      ranges[1].value = String(draft.y);
      for (const image of crops) image.style.objectPosition = focusPosition(draft);
      drawFrames();
    }
    setFocus(start.x, start.y);
    const status = el('span', { role: 'status', class: 'map-note' });
    const save = el('button', {
      type: 'button', text: en ? 'Save focus' : '保存焦点', disabled: true,
      onclick: async () => {
        if (save.disabled) return;
        save.disabled = true;
        status.textContent = '';
        try {
          await call('coverFocus', [{ id: p.id, x: draft.x, y: draft.y, expectedCover: p.cover, expectedRevision: p.revision }]);
          setMessage(en ? 'Cover focus saved' : '封面焦点已保存');
          await load();
        } catch (err) {
          status.textContent = String(err?.message ?? err);
          save.disabled = false;
        }
      },
    });
    const settings = el('details', { class: 'map-focus-settings', ontoggle: () => {
      if (!settings.open || original.getAttribute('src')) return;
      void coverOf(p.id).then((src) => {
        if (!src) { status.textContent = en ? 'Image unavailable' : '封面无法读取'; return; }
        original.setAttribute('src', src);
        for (const image of crops) image.setAttribute('src', src);
        save.disabled = false;
      });
    } },
      el('summary', { text: en ? 'Adjust cover focus' : '调整封面焦点' }),
      el('p', { class: 'map-note', text: en ? 'Drag the marker on the original or use the sliders.' : '在原图上拖动焦点，也可以用滑块微调。' }),
      el('div', { class: 'map-focus-grid' },
        el('figure', {}, el('figcaption', { text: en ? 'Original' : '原图' }), preview),
        ...crops.map((image, index) => el('figure', {},
          el('figcaption', { text: index === 0 ? (en ? 'Home banner' : '住所横幅') : (en ? 'Place card' : '地点卡片') }),
          el('div', { class: 'map-focus-preview', style: { cursor: 'default', touchAction: 'auto' } }, image)))),
      el('div', { class: 'map-focus-controls', 'aria-label': t.presetFocus },
        ...[[t.focusTop, 50, 15], [t.focusCenter, 50, 50], [t.focusBottom, 50, 85],
          [en ? 'Left subject' : '主体靠左', 15, 50], [en ? 'Right subject' : '主体靠右', 85, 50]]
          .map(([label, x, y]) => el('button', { type: 'button', text: label, onclick: () => setFocus(x, y) })),
        el('button', { type: 'button', text: en ? 'Restore saved focus' : '恢复已保存焦点', onclick: () => setFocus(start.x, start.y) })),
      el('div', { class: 'map-focus-controls' },
        el('label', {}, en ? 'Horizontal' : '水平', ranges[0]),
        el('label', {}, en ? 'Vertical' : '垂直', ranges[1]),
        el('button', { type: 'button', text: en ? 'Center' : '居中', onclick: () => setFocus(50, 50) }), save, status));
    return settings;
  }

  function homeBanner(p) {
    const art = coverOrEmpty(p, 'map-thumb');
    return el('section', { class: art ? 'map-home-banner' : 'map-home-banner map-home-text' },
      art ? el('div', { class: 'map-home-art' }, art) : null,
      el('div', { class: 'map-home-copy' },
        el('div', { class: 'map-home-label', text: t.currentHome }),
        el('h3', { text: p.name }),
        p.desc ? el('p', { class: 'map-card-desc', text: p.desc }) : null,
        el('button', { type: 'button', text: t.viewHome, onclick: () => openPlace(p.id, { detached: true }) })));
  }

  function renderBreadcrumbs(current) {
    const path = [...state.trail.map((entry, trailIndex) => ({ id: entry.id, trailIndex })), { id: current?.id }].filter(({ id }) => id);
    return el('nav', { class: 'map-breadcrumbs', 'aria-label': t.relationTrail },
      el('span', { text: `${t.relationTrail}：` }),
      ...path.map(({ id, trailIndex }, index) => {
        const place = state.data.places.find((item) => item.id === id);
        const isCurrent = index === path.length - 1;
        return el('span', {}, index ? el('span', { text: ' / ', 'aria-hidden': 'true' }) : null,
          isCurrent ? el('strong', { text: place?.name ?? id }) : el('button', { type: 'button', text: place?.name ?? id,
            onclick: () => {
              state.trail = state.trail.slice(0, trailIndex);
              state.expanded = id;
              state.detached = true;
              state.editing = false;
              renderBody();
              focusDetail();
            } }));
      }));
  }

  function renderBody() {
    const d = state.data;
    for (const key of [...forms.keys()]) {
      if (key === 'new') continue;
      captureDraft(key);
      forms.delete(key);
    }
    relationAnchors.clear();
    body.replaceChildren();
    if (!d.places.length) {
      body.appendChild(el('div', { class: 'map-empty' },
        el('strong', { text: t.emptyTitle }), el('div', { text: t.emptyHint }),
        el('button', { type: 'button', text: t.addPreset, onclick: () => { state.managing = true; render(); } })));
      return;
    }
    const sorted = sortPlaces(filteredPlaces());
    const selected = [...sorted.filter((p) => state.pinned.includes(p.id)), ...sorted.filter((p) => !state.pinned.includes(p.id))];
    const home = d.places.find((p) => p.id === d.homeId);
    const expanded = d.places.find((p) => p.id === state.expanded);
    const standalone = !state.batchMode && expanded && (state.detached || state.view === 'relations' || !selected.some((p) => p.id === expanded.id));
    if (home && !state.batchMode && state.view === 'cards') body.appendChild(homeBanner(home));
    if (state.trail.length) body.appendChild(renderBreadcrumbs(expanded));
    if (standalone) body.appendChild(el('div', { class: 'map-standalone' }, state.editing ? detail(expanded) : reading(expanded)));
    body.appendChild(resultSummary(d.places.length, selected.length));
    if (!selected.length) {
      body.appendChild(el('div', { class: 'map-empty', text: t.noResults }));
      return;
    }
    if (state.view === 'relations') {
      renderRelations(selected);
      return;
    }
    if (state.sort !== 'kind') {
      section(sortLabel(state.sort), selected, Boolean(standalone));
      return;
    }
    const pinned = selected.filter((p) => state.pinned.includes(p.id));
    section(language === 'en' ? 'Pinned' : '置顶', pinned, Boolean(standalone));
    const ordinary = selected.filter((p) => !state.pinned.includes(p.id));
    const isFrequent = (p) => p.frequent || p.kind === 'frequent';
    const freq = ordinary.filter(isFrequent);
    const rest = ordinary.filter((p) => !isFrequent(p));
    section(t.secFreq, freq, Boolean(standalone));
    section(t.secHome, rest.filter((p) => p.kind === 'home'), Boolean(standalone));
    section(t.secAround, rest.filter((p) => p.kind !== 'home' && p.kind !== 'travel'), Boolean(standalone));
    section(t.secTravel, rest.filter((p) => p.kind === 'travel'), Boolean(standalone));
  }

  function section(title, items, standalone) {
    if (!items.length) return;
    body.appendChild(el('h3', { class: 'map-sec', text: title }));
    body.appendChild(el('div', { class: 'map-grid' }, items.map((p) => cell(p, !standalone && !state.batchMode && state.expanded === p.id))));
  }

  const relationAnchors = new Map();

  function relationLink(target, key) {
    if (!target) return el('span', { class: 'map-dim', text: t.missingTarget });
    const context = target.terrainLabel || target.kindLabel;
    const anchor = JSON.stringify(key);
    const button = el('button', {
      type: 'button', class: 'map-relation-link', text: target.name,
      title: `${target.name} · ${context} · ${target.id}`,
      onclick: () => openPlace(target.id, { detached: true, origin: bookmarkRelation(anchor, button) }),
    });
    relationAnchors.set(anchor, button);
    return button;
  }

  function renderRelations(items) {
    const byId = new Map(state.data.places.map((p) => [p.id, p]));
    const rows = [];
    for (const place of items) {
      for (const relation of place.relations ?? []) {
        const target = byId.get(relation.placeId);
        rows.push(el('div', { class: 'map-relation-row' },
          relationLink(place, ['list', 'source', place.id, relation.placeId]),
          el('span', { text: ' → ', 'aria-hidden': 'true' }),
          relationLink(target, ['list', 'target', place.id, relation.placeId]),
          relation.note ? el('span', { class: 'map-dim', text: `：${relation.note}` }) : null));
      }
    }
    body.appendChild(rows.length ? el('div', { class: 'map-relations-view' }, rows) : el('div', { class: 'map-empty', text: t.noRelations }));
  }

  function cell(p, open) {
    const wrap = el('div', { class: open ? 'map-cell map-cell-open' : 'map-cell' });
    wrap.appendChild(card(p, open));
    if (open) wrap.appendChild(state.editing ? detail(p) : reading(p));
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

  function card(p, open) {
    const cls = ['map-card', `map-kind-${p.kind === 'home' ? 'home' : p.frequent ? 'frequent' : p.kind || 'around'}`];
    if (p.kind === 'home') cls.push('map-card-home');
    else if (p.frequent) cls.push('map-card-freq');
    if (!p.hasCover) cls.push('map-card-text');
    if (open) cls.push('map-card-active');
    const picked = state.selectedIds.has(p.id);
    if (state.batchMode) {
      cls.push('map-card-select');
      if (picked) cls.push('map-card-selected');
    }
    const tags = (p.tags ?? []).slice(0, 2);
    return el('div', {
      class: cls.join(' '), role: state.batchMode ? 'checkbox' : 'button', tabindex: '0',
      'aria-checked': state.batchMode ? String(picked) : null,
      'aria-expanded': state.batchMode ? null : String(open),
      onclick: () => activateCard(p.id, open),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault?.();
          activateCard(p.id, open);
        }
      },
    },
    state.batchMode ? el('span', { class: 'map-pick-glyph', text: picked ? '☑' : '☐' }) : null,
    coverOrEmpty(p, 'map-thumb'),
    el('div', { class: 'map-card-body' },
      el('div', { class: 'map-card-head' },
        el('span', { class: 'map-card-name', text: p.name }),
        el('span', { class: 'map-card-arrow', 'aria-hidden': 'true', text: open ? '⌃' : '⌄' })),
      el('div', { class: 'map-statuses' },
        el('span', { class: 'map-status map-status-kind', text: p.kindLabel }),
        state.data.homeId === p.id ? el('span', { class: 'map-status map-status-link', text: t.currentHome }) : null,
        p.frequent ? el('span', { class: 'map-status', text: '★' }) : null,
        p.hasCover ? el('span', { class: 'map-status', text: '📷' }) : el('span', { class: 'map-status map-status-warn', text: t.noCoverLabel })),
      el('div', { class: p.desc ? 'map-card-desc' : 'map-card-desc map-card-desc-empty', text: p.desc || t.noDesc }),
      tags.length ? el('div', { class: 'map-chips' }, ...tags.map((tag) => el('span', { class: 'map-chip', text: tag }))) : null));
  }

  function focusDetail(selector = '.map-reading h3') {
    const target = body.querySelector(selector);
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  }

  function bookmarkRelation(anchor, button) {
    const scroll = [];
    const scroller = button.ownerDocument?.scrollingElement;
    for (let node = button; node; node = node.parentNode ?? node.host) {
      // 只保留重绘后仍存在的容器。面板正文的子元素会被替换。
      if (node === body || node === box || node === root || node === scroller || node.contains?.(box)) {
        if (Number.isFinite(node.scrollTop)) scroll.push({ node, top: node.scrollTop, left: node.scrollLeft });
      }
    }
    return { id: state.expanded, detached: state.detached, editing: state.editing, anchor, scroll };
  }

  function openPlace(id, { detached = false, origin = null } = {}) {
    state.trail = origin ? [...state.trail, origin] : [];
    state.expanded = id;
    state.detached = detached;
    state.editing = false;
    touchRecent('recentViewed', id);
    renderBody();
    focusDetail();
  }

  function backPlace() {
    const previous = state.trail.pop();
    if (!previous) { closePlace(); return; }
    state.expanded = state.data.places.some((p) => p.id === previous.id) ? previous.id : null;
    state.detached = previous.detached;
    state.editing = Boolean(state.expanded && previous.editing);
    renderBody();
    const anchor = relationAnchors.get(previous.anchor);
    if (!anchor) { focusDetail(); return; }
    anchor.focus?.({ preventScroll: true });
    for (const { node, top, left } of previous.scroll) {
      node.scrollTop = top;
      if (Number.isFinite(left)) node.scrollLeft = left;
    }
    if (!previous.scroll.length) anchor.scrollIntoView?.({ block: 'nearest' });
  }

  function closePlace() {
    state.expanded = null;
    state.editing = false;
    state.detached = false;
    state.trail = [];
    renderBody();
  }

  function activateCard(id, open) {
    if (state.batchMode) toggleSelect(id);
    else if (open) closePlace();
    else openPlace(id);
  }

  function reading(p) {
    const relationRows = (relations, direction) => relations.map(({ place, note }) =>
      el('div', { class: 'map-relation-row' },
        relationLink(place, ['reading', direction, p.id, place?.id]),
        note ? el('span', { text: note }) : null));
    const byId = new Map(state.data.places.map((place) => [place.id, place]));
    const relations = relationRows((p.relations ?? []).map((relation) => ({
      place: byId.get(relation.placeId), note: relation.note,
    })), 'outgoing');
    const mentions = relationRows(state.data.places.flatMap((place) => (place.relations ?? [])
      .filter((relation) => relation.placeId === p.id).map(({ note }) => ({ place, note }))), 'incoming');
    const mentionLabel = language === 'en' ? 'Mentioned by' : '被哪些地点提到';
    const heading = `${p.name}${p.terrainLabel ? ` · ${p.terrainLabel}` : ''}`;
    return el('article', { class: 'map-reading' },
      el('div', { class: 'map-detail-top' },
        el('h3', { text: heading, tabindex: '-1' }),
        el('div', { class: 'map-reading-actions' },
          el('button', { type: 'button', text: state.pinned.includes(p.id) ? (language === 'en' ? 'Unpin' : '取消置顶') : (language === 'en' ? 'Pin for browsing' : '置顶浏览'),
            onclick: () => { state.pinned = state.pinned.includes(p.id) ? state.pinned.filter((id) => id !== p.id) : [p.id, ...state.pinned]; persistPrefs(); renderBody(); } }),
          state.trail.length ? el('button', { type: 'button', text: t.backPlace, onclick: backPlace }) : null,
          el('button', { type: 'button', text: t.edit, onclick: () => { state.editing = true; renderBody(); focusDetail('.map-edit-heading'); } }),
          el('button', { type: 'button', text: t.close, onclick: closePlace }))),
      originalCover(p),
      el('p', { class: 'map-reading-text', text: p.desc || t.noDesc }),
      (p.effectiveStyle || p.style) ? el('p', { class: 'map-note' }, el('strong', { text: t.detailStyle }), ' · ', p.effectiveStyle || p.style) : null,
      p.tags?.length ? el('div', { class: 'map-chips' }, ...p.tags.map((tag) => el('span', { class: 'map-chip', text: tag }))) : null,
      relations.length ? el('section', { 'aria-label': t.relationLabel }, el('h4', { class: 'map-sec', text: t.relationLabel }), ...relations) : null,
      mentions.length ? el('section', { 'aria-label': mentionLabel }, el('h4', { class: 'map-sec', text: mentionLabel }), ...mentions) : null,
      el('details', { class: 'map-note' },
        el('summary', { text: t.options }),
        el('div', { class: 'map-statuses' },
          el('span', { class: 'map-status map-status-kind', text: `${t.completeness}：${completeness(p)}` }),
          el('span', { class: 'map-status', text: linkStatus(p, 'imggen') }),
          el('span', { class: 'map-status', text: linkStatus(p, 'fun') })),
        p.canMentionImggen ? el('div', { class: 'map-chip-scene', text: `scene：${p.scene}` }) : null,
        p.canMentionFun ? el('div', { text: language === 'en'
          ? `fun_go: ${p.funVenue} (a similar venue in Fun time)`
          : `fun_go 填「${p.funVenue}」（娱乐时间里最接近这处的一处）` }) : null));
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

    if (!state.baseValues.has(p.id) || (!state.drafts.has(p.id) && !state.conflicts.has(p.id))) {
      state.baseRevisions.set(p.id, p.revision);
      state.baseValues.set(p.id, placeEditValues(p));
    }
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
      disabled: state.pending.has(`edit:${p.id}`) || state.conflicts.has(p.id),
      onclick: async () => {
        if (saveBtn.disabled || state.pending.has(`edit:${p.id}`) || state.conflicts.has(p.id)) return;
        saveBtn.disabled = true;
        saveBtn.textContent = t.busy;
        try {
          let submitted = formValues(p.id);
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
          for (let attempt = 0; ; ++attempt) {
            try {
              await call('edit', [editPayload(p.id, submitted)]);
              break;
            } catch (err) {
              if (!err.conflict || !err.current) throw err;
              const merged = mergeEditConflict(p.id, err.current);
              submitted = merged.values;
              if (merged.fields.length || attempt >= 1) {
                setMessage(merged.fields.length
                  ? (language === 'en' ? 'Choose a value for each conflicting field before saving.' : '请为每个冲突字段选择要保留的内容，再保存。')
                  : (language === 'en' ? 'Newer changes were merged into your draft. Please save again.' : '最新改动已合并到草稿，请再保存一次。'), false);
                render();
                return;
              }
              // One guarded retry handles disjoint/same-value edits without asking for choices.
              render();
            }
          }
          clearSavedDraft(p.id, submitted);
          state.conflicts.delete(p.id);
          state.baseRevisions.delete(p.id);
          state.baseValues.delete(p.id);
          forms.delete(p.id);
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
            const r = await call('remove', [{ id: p.id }]);
            // 服务端给的回执里带一张 10 秒的撤销牌，直接摆到面板上。
            state.undo = r?.undo ?? null;
            if (state.expanded === p.id) state.expanded = null;
            state.drafts.delete(p.id);
              Promise.resolve(ctx.invoke('removeDraft', [{ id: p.id }])).catch(() => {});
            forms.delete(p.id);
            state.covers.delete(p.id);
            setMessage(t.removed, true);
            await load();
            scheduleUndoClear();
          } catch (err) {
            setMessage(String(err?.message ?? err), false);
            render();
          }
        },
      }),
      fileInput);

    return el('div', { class: 'map-detail map-zone-edit' },
      el('div', { class: 'map-detail-top' },
        el('h4', { class: 'map-edit-heading', tabindex: '-1', text: `${p.name}${p.terrainLabel ? ` · ${p.terrainLabel}` : ''}` }),
        el('button', { type: 'button', text: t.read, onclick: () => { state.editing = false; renderBody(); focusDetail(); } })),
      editConflictPanel(p.id),
      el('div', { class: 'map-field' }, el('label', { text: '名字' }), nameIn),
      el('div', { class: 'map-field-row' },
        el('div', { class: 'map-field' }, el('label', { text: '归类' }), kindSel)),
      p.kind === 'home' ? el('div', { class: 'map-actions' }, el('span', { text: state.data.homeId === p.id ? '当前住所' : '住所候选' }), el('button', { type: 'button', text: state.data.homeId === p.id ? '当前住所' : '设为当前住所', onclick: async () => { const r = await call('setHome', [{ id: p.id }]); if (r.ok) await load(); } })) : null,
      el('div', { class: 'map-field' }, el('label', { text: t.detailDesc }), descIn),
      el('div', { class: 'map-field' }, el('label', { text: t.detailTags }), tagsIn),
      el('div', { class: 'map-field' }, el('label', { text: t.relationLabel }), el('div', { class: 'map-note', text: '只写语境，不写方位或远近。' }), relationsJson, relationList, addRelation),
      el('details', {
        class: 'map-edit-options', open: state.openOptions.has(p.id),
        ontoggle: (event) => {
          const options = event.currentTarget;
          if (!options.isConnected) return;
          if (options.open) state.openOptions.add(p.id);
          else state.openOptions.delete(p.id);
        },
      },
        el('summary', { text: language === 'en' ? 'Style, aliases and links' : '画风、别名和联动' }),
        el('div', { class: 'map-field' }, el('label', { text: t.detailStyle }), styleIn),
        el('div', { class: 'map-field' }, el('label', { text: t.detailAliases }), aliasIn),
        el('div', { class: 'map-field' }, el('label', { text: t.detailScene }), sceneIn),
        el('div', { class: 'map-scene' }, p.canMentionImggen
          ? el('span', {}, '生图时 ', el('b', { text: `scene 填「${p.scene}」` }))
          : el('span', { text: linkStatus(p, 'imggen') })),
        el('div', { class: 'map-field' }, el('label', { text: t.detailFunVenue }), funIn),
        el('div', { class: 'map-scene' }, p.canMentionFun
          ? el('span', {}, '想真去逛：', el('b', { text: `fun_go 填「${p.funVenue}」` }), '（娱乐时间里最接近这处的一处，不是同一个地方）')
          : el('span', { text: linkStatus(p, 'fun') }))),
      p.hasCover ? coverFocusSettings(p) : null,
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
      if (!state.prefsLoaded) await loadPrefs();
      if (version !== state.loadVersion || ctx.signal?.aborted) return;
      const validIds = new Set(d.places.map((place) => place.id));
      state.recentViewed = state.recentViewed.filter((id) => validIds.has(id));
      state.recentEdited = state.recentEdited.filter((id) => validIds.has(id));
      // 撤销牌以服务端为准：过期了、被新的删除替换了，都从 `list` 里读回来。
      state.undo = d.undo ?? null;
      scheduleUndoClear();
      if (!state.draftsLoaded) {
        const saved = await ctx.invoke('drafts', []);
        applyDrafts(Array.isArray(saved) ? saved : saved?.drafts ?? []);
      }
      // 展开着的那一处如果被删了，收起详情。
      if (state.expanded && !d.places.some((p) => p.id === state.expanded)) state.expanded = null;
      // 勾选名单里已经不存在的 id 要清掉，否则批量改会整批被服务端拒绝。
      for (const id of [...state.selectedIds]) if (!d.places.some((p) => p.id === id)) state.selectedIds.delete(id);

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
  ctx.interval?.(() => {
    if (body.querySelector('.map-original[open]') || body.querySelector('.map-focus-settings[open]')) return;
    void load();
  }, 60000);

  return { refresh: load };
}

export default {
  panels: {
    places: { mount: mountPlaces },
  },
};
