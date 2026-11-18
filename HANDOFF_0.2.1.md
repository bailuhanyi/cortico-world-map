# 鱼的小世界交接文档：导入保护修复完成

更新时间：2026-11-18
工作目录：`E:\deep seek\map-world`
包名：`cortico-world-map`；World id：`map`；显示名：鱼的小世界。

## 当前状态

导入本地优先修复已完成并通过五套测试与 npm run verify。用户明确表示 0.2.0 已发布，指定下一版为 0.2.1；当前 package.json 为 0.2.1。用户是否已经发布 0.2.1 尚未核实，本会话没有执行 npm publish 或 git commit。

修复候选包单独保存为：

`releases/local-first/cortico-world-map-0.2.1.tgz`

- 约 106.4 kB，15 个文件。
- npm pack shasum：`c4357ecf731d071100fcfc8bb05196bce26e8a9c`。
- 根目录同名 tgz 是旧包，未覆盖，不包含本次完整修复。不要误拿根目录旧包发布。
- 若 0.2.1 已发布，必须改新版本后再打包，不能重复发布同版本。未确认前不要宣称候选包可以直接上 npm。

本文件取代之前“修复尚未完成”的交接状态。旧 HANDOFF_0.5.0.md 仅供历史参考。

## 用户需求与两个不同操作

用户担心自建地点在“更新”后被覆盖。

**升级插件**：已检查 install.ps1，替换扩展代码位于 `data/extensions/vendor/cortico-world-map`，用户地点位于 `<dataDir>/map/state.json`，图片位于 `<dataDir>/map/covers`，草稿位于 `<dataDir>/map/drafts.json`。保持原数据目录的正常脚本升级不会替换这些用户文件，升级无需导入备份。只做源码级核验与重启回归，未验证真实宿主市场安装流程。

**导入备份**：会根据模式修改数据，已有初版 merge 确实存在覆盖风险。本次已改成保守的本地优先规则。

## 已实现的合并规则

界面选项：“合并更新（本地优先，只补空白）”，RPC 模式值仍为 merge。

- 仅处理本地已有的同 id、同名地点，不新增、不删除地点。
- 同 id 名称不同整条跳过，预览列出冲突，不凭 id 猜测身份。
- 已有文字、画风、别名、标签、关系和图片保留；差异在预览中说明。
- 本地空白字段才采纳备份非空值；原始备份缺失字段不会被归一化默认值误填。
- 布尔 false 是有效选择；常去状态、分类与当前住所保持本地。
- 标签、别名、关系是整体字段：非空本地数组保留，不合并或替换其中条目；空数组可补充有效备份内容。
- 本地无图片可补图，已有图片永不因文件名相同而替换。
- 图片写入队列显式跟踪采纳的来源，不再按本地 cover 文件名查备份图片。
- 关系按最终本地目标核验，允许备份指向本地独有目标；排除缺失和同 id 异名的歧义目标。
- 原 skip 与 overwrite 模式保留；overwrite 仍会按用户明确选择替换同 id 地点，不能把“不覆盖”保证套用于它。

局限：同 id 同名仍不等于跨世界身份已得到证明。本次没有新增跨世界唯一身份系统；保守策略保证已有内容不被替换，空白仍可能被补充。空白也无法区分“从未填写”与“用户主动清空”，因此补空白只在用户明确选择 merge 并确认时发生。

## 预览与确认保护

`dist/webui.js` 的 transferControls：

- 文件读取与预览使用独立序号；旧成功和旧失败响应不会覆盖新选择。
- 换文件、取消、清空、超大文件、解析失败、切模式，立即使旧预览失效。
- 确认使用预览捕获的 bundle、mode、expectedRevision。
- 写入期间禁用文件和模式，阻止重复提交；重绘复用锁定控件。
- 成功清理图片缓存并刷新数据。

`src/world.js`：expectedRevision 改为对 `[state, bundle, mode]` 求摘要，绑定预览状态、文件和模式。任一改变要求重新预览；不再仅检查 state。RPC 字段名不变，但旧面板拿到的旧预览不能沿用。

## 测试与验证结果

最新完整验证：

| 测试 | 结果 |
| --- | --- |
| places | 24/24 |
| state | 47/47 |
| world | 79/79 |
| transfer | 14/14 |
| panels | 52/52 |
| npm run verify | 通过 |

合计 216 项测试通过。新增/调整测试覆盖：本地已有字段与 false 保留、旧备份缺字段、同 id 异名、图片同名不同内容、本地无图补图、本地独有关联目标、输入不变、预览内容/模式变化拒绝、快速切换与旧响应、取消/错误、写入锁，以及导入旧备份后重启保留自建地点、图片、草稿和后来修改。

测试日志为根目录 `.test-*-local-first.log` 与 `.verify-local-first.log`。它们不进入 npm 包。

## 已完成的省 token 方案

- 常驻：地点总数、当前住所、最多五处常去名称和 id；住所不重复占常去名额。
- 不常驻完整描写、别名、标签、关系、画风或具体 scene。
- map_places 默认 page=1、limit=10，最多20；先筛选后分页；all:true 全列匹配索引。
- map_look 按需详情，map_view 保留分组概览与60字描写摘要。
- 固定模板曾测得1322→554字符（约减少58%），不是实际 token 计费测量。
- 生图与日程联动仍按原条件开关，改为按需查询正名和场景。

## 关键文件与本次修改

- src/transfer.js：本地优先、原始字段存在性、图片来源、关系目标、当前住所保留。
- src/world.js：预览绑定文件/模式/状态。
- dist/webui.js：预览和文件读取竞态、锁定控件、成功缓存刷新、说明。
- test/transfer.test.mjs、test/world.test.mjs、test/panels.test.mjs：对应回归。
- README.md、CHANGELOG.md、PUBLISHING.md：同步本地优先说明。
- describe.json 由 tools/make-describe.mjs 生成；本次未改模型工具 schema，已通过一致性校验。

## 工作区与发布注意

工作区有大量此前未提交改动；src/transfer.js、test/transfer.test.mjs 等为未跟踪文件，不能把整个 git diff 都当作本次修复。保留现有 `.npm-cache/`、`.recovery-020/` 和历史 tgz；没有做清理或提交。

文档仍有历史内部版本标题 0.3.0/0.4.0，以及 PUBLISHING 的 mapStyleRef 起始版本旧说法；这不是本次修复范围，下一次发布整理时需要核对真实发布记录。

Node >=22；此前环境 v24.14.1。UTF-8 编辑中文，避免未经编码保护的 Set-Content。受限环境逐个运行测试，不用 node --test。npm 缓存使用工作区 `.npm-cache`，不要绕过文件沙箱。

Hindsight 查询曾报401，最近报 ECONNREFUSED 127.0.0.1:9077，未成功读写记忆，不要假称已捕获。

复验命令：

```powershell
cd "E:\deep seek\map-world"
npm run verify
node test/places.test.mjs
node test/state.test.mjs
node test/world.test.mjs
node test/transfer.test.mjs
node test/panels.test.mjs
npm pack --ignore-scripts --cache .npm-cache --pack-destination releases/local-first
```

发布前确认0.2.1是否已发布；若已发布，调整版本与说明后重新打包。发布需用户自己在终端执行。本会话未安装到真实 Coo，不能声称截图对应宿主界面已更新。

## 产品边界

无坐标、方向/距离字段、路线/导航/行程推断；不自动生成关系或反向关系，不读取其他 World 状态或素材库。标签只用于整理，完整度非强制，不催用户补齐。保持 World id map 与 worlds.map 宿主契约。
