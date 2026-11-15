# 鱼的小世界（cortico-world-map）

> 包名 `cortico-world-map`、world id **`map`**、显示名 **「鱼的小世界」**（2026-11-15 定稿，英文 `Little World`）。
> 需求文档：`MAP-小地图插件-方案.md`。

给 Coo（Coopanion）桌宠一张**「周围的地图」**：家在哪、常去哪儿、附近有什么。

每一处地方只有**文字**——空间、陈设、配色、光线、氛围——外加一句固定的画风锚点，所以同一个地方反复看、反复画都是同一副样子。画面可以**完全靠主人自己上传一张本地图**：装不装别的插件都能用，零成本、画风全由主人定。

## 它刻意没有的东西

**没有路线、没有坐标、没有距离、也没有导航。**

一处地方就是「它长什么样」，不是「怎么走到它」。日程里写去哪是「鱼的每一天」的事，这里只提供「那个地方是什么样子」——所以「森林里的鱼出去上班」这种割裂从根上不会发生：库里列的是「家 / 溪边 / 老橡树」，她自然不会凭空写「公司 / 地铁」。

这条不是「这一版先不做」：`place` 里不许有任何 geo 字段，`test/places.test.mjs` 和 `tools/check-isolation.mjs` 各钉了一道守门断言。

## 装

先把 Coo **完全退出**，然后：

```powershell
# 预演
powershell -ExecutionPolicy Bypass -File .\install.ps1 -CooRoot "E:\Coopanion" -DryRun

# 真装
powershell -ExecutionPolicy Bypass -File .\install.ps1 -CooRoot "E:\Coopanion"
```

装完重启 Coo，面板 → 世界 →「鱼的小世界」应为 `active`，配置页 5 项。

装上之后 `<数据目录>/../config.json` 里会有 `worlds.map.enabled = true`——**「鱼的每一天」那边的 `maplink` 就靠这一个字段**判断要不要在「自己的时间」里加一行（见下）。

## 开箱：五套预设地形

装上之后进面板选一套，**展开勾选表挑要哪几处**（默认全选、已有的置灰），主人只改文字、传图：

| 地形 | id | 预置地点 |
| --- | --- | --- |
| 林间 | `forest` | 家（树洞/小木屋）、老橡树、溪边、蘑菇坡、林间空地 |
| 小区 | `neighborhood` | 家、楼下长椅、便利店门口、小花园、单元楼道 |
| 江边 | `riverside` | 家、江堤台阶、旧码头、芦苇滩、江边石墩 |
| 山脚 | `foothill` | 家、上山口、山泉、半坡亭、碎石坡 |
| 旅行 | `travel` | 海边小镇、雪山客栈、古城老街、温泉旅馆、林间营地 |

**选地形不等于全加**：点了地形会先出勾选表，勾上哪几处才加哪几处。已有的那几处置灰、不能重复勾；全不勾时「加进去」是灰的，不会静默什么都不做。

**换地形只追加，不删已有地点**——所以「林间」写好的描写，切到「江边」之后还在，两套并存（id 带地形前缀，`forest-home` / `riverside-home`，不撞）。

### 旅行那几处

远方地名，只说「那儿长什么样」。**没有几天、没有怎么去、没有第几天**——那是她日程的事，不是地图的事。

每处预置一个「娱乐时间里最接近的那一处」：

| 地点 | 最接近的 |
| --- | --- |
| 海边小镇 | 江边 |
| 雪山客栈 | 爬山 |
| 古城老街 | 旧货市场 |
| 温泉旅馆 | 澡堂 |
| 林间营地 | 公园 |

为什么不是直接用娱乐时间那二十个正名：它的场所库里**没有**「海边小镇」「雪山」这种词，直接让她 `fun_go` 填这几个字，那边会回「没听说过这处」——正是红线禁的「指向不存在的东西」。所以递的是**最接近的一处**，回执会明说「不是同一个地方，别把『江边』说成『海边小镇』」。

## 两种画面来源

### 来源 A：本地图片（主人上传）—— 可完全独立

面板里每处地方有「传一张图」。图落 `<数据目录>/map/covers/<id>.<ext>`，面板走 `ctx.invoke('cover', {id})` 拿 **base64 data URL** 显示。

- 只认 **png / jpg / webp / gif**，上限 **8 MiB**，按**文件头魔数**校验，**不信扩展名**（从别处拖进来一个改名成 `.png` 的文件会被当场拒掉）。
- 扩展名按魔数定，不听你传的那个。
- 不装任何别的插件也能完整使用。

### 来源 B：生图工作室联动 —— 可选，装了才提

**那句「发图时 scene 填 X」只在三条全满足时才出现**：

1. 配置 `mapImggenOn` 开着；
2. 小地图读到 `worlds.imggen.enabled === true`（**只读 config 这一个布尔字段**，不调它的工具、不读它的素材库）；
3. 这一处地方的 `scene` 非空（也就是主人真把库里的正名填进来了）。

**缺任意一条，那句话整段不出现**，并且回执里连 `imggen_draw` / `scene` 这个词都不会出现——绝不指向一个不存在的工具或场景名。有测试逐条钉住（`test/world.test.mjs` 的「三道条件」一组）。

`scene` 是**字符串，不是读库**：本插件不读 `imggen-library`，只把「该填哪个名字」递到她嘴边，填参数是她自己做的。

## 画风固定 = 每处一句 style + 有图就锁死

1. **每处地方一句 `style`**：出图提示词里固定带上，同一处地方不同次出图同风格。
2. **一旦有 `cover` 就锁死，不自动重生**：要换得主人手动点「清空图」，再传一张新的。常去的地方因此永不漂。
3. `mapStyleRef`（整图样式参考）**这一版只留字段不实现**——空着就是各地点用自己的 `style`。

## 六个工具

| 工具 | 作用 |
| --- | --- |
| `map_places` | 列出地点（家 / 常去 / 周围 / 旅行），`frequent` 排前；可 `kind` 筛 |
| `map_look` | 看某一处：文字描写 + `style` + 有没有图；三条全满足才递「发图填哪个 scene」，旅游处还会递「想真去逛去哪」 |
| `map_add` | 加一处：只填**文字**（name/aliases/kind/desc/style/scene/funVenue），没有坐标可填 |
| `map_edit` | 改文字 / 置顶「常去」/ 改 `style` / 改 `scene` / 改 `funVenue`；只动传进来的那几项 |
| `map_cover` | 换本地图或清空；受「锁死」约束 |
| `map_view` | 整张小地图（按家 / 常去 / 周围 / 旅行分组铺开，纯展示，**不带路线连线、不带行程**） |

**这个 World 不推任何事件**（`describe.events` 是空数组、`start()` 里没有定时器）。什么时候看地图，由「鱼的每一天」那边的一行提示顺手一提，或者她自己调 `map_places`。

## 配置（5 项，默认都开，热改）

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `mapOn` | `true` | 总开关。关掉=不往提示词注入地点清单，工具与面板还在 |
| `mapImggenOn` | `true` | 可选联动开关。关掉=纯文字+本地图，绝不提 `imggen_draw` |
| `mapFeastOn` | `true` | 「鱼的每一天」联动。关掉=一个字都不提 `feast_life_plan` / `feast_life_now` |
| `mapFunOn` | `true` | 「娱乐时间」联动。关掉=不提 `fun_go` / `fun_places` |
| `mapStyleRef` | 空 | 整图样式参考。**这一版只留字段不实现** |

三个联动开关**都是「开关 + 装没装 + 这处有没有名字」三条全满足才提**，缺一条整段不出现：

| 联动 | 开关 | 还要读到 | 还要 |
| --- | --- | --- | --- |
| 生图 | `mapImggenOn` | `worlds.imggen.enabled === true` | 该处 `scene` 非空 |
| 鱼的每一天 | `mapFeastOn` | `worlds.feast.enabled === true` | 有地点 |
| 娱乐时间 | `mapFunOn` | `worlds.fun.enabled === true` | 该处 `funVenue` 非空 |

> 宿主的 `/api/config` 读落盘段、**不合并 defaults**，所以插件自己 `#ensureConfigSection` 补齐（照 `fun-world/src/world.js` 那段，`enabled` 跳过、不覆盖已有值），否则界面会显示成 `false`。

## 它和别的 World 是怎么联动的

**不调别的 World 的工具、不读别人的状态或日程文件**（World 契约的红线）。联动只借两样东西：

1. **读 config 一个布尔字段**：`worlds.imggen.enabled`，判断能不能提生图。read 配置文件不算 World 间依赖（和 `feed-world/src/life/funlink.js` 读 `worlds.fun.enabled` 同一套）。
2. **提示词各写一句指向对方**：本插件 `ENV_PROMPT.md` 里指向 `feast_life_plan` / `feast_life_now`，以及（可选）`imggen_draw`。

```
鱼的小世界 ──「写日程用地点正名」──→ 鱼的每一天（一句提示词，不调工具）
鱼的每一天 ──「lifeFreeMenu 列 map_*」──→ 鱼的小世界（maplink，归另一个会话）
鱼的小世界 ──「可选：发图填地点正名」──→ 生图工作室（三条全满足才提）
鱼的每一天 ──（0.7.1 已有）──────────→ 生图工作室
```

### 给「鱼的每一天」那个会话的契约（`maplink`，本插件不实现）

| 项 | 约定 |
| --- | --- |
| 新文件 | `feed-world/src/life/maplink.js` |
| 检测 | `readMapEnabled(dataDir)` 读 `<dataDir>/../config.json` 的 `worlds.map.enabled`（**只读这一个字段**） |
| 追加行 | `- 看看周围、去个常去的地方：map_places 看有哪些地方 → map_look 看这一处长什么样` |
| 去重 | 判据「这一行提到 `map_` 开头的工具」；只追加，从不改写 |
| 开关 | 新配置 `lifeFreeMapOn`（默认 `true`，归「她自己的时间」卡） |

本插件这边要做的事只有一件：**包名 `cortico-world-map`、world id `map`，装了启用后 `worlds.map.enabled` 就是 `true`**。已经做到了。

## 降级验收

| 情况 | 行为 |
| --- | --- |
| 没装生图工作室 / 挪走素材库 / 关掉 `mapImggenOn` | 文字 + 本地图全在，只是不出图那句提示；**绝不报错、绝不卸载** |
| `scene` 留空（库里没有这处） | 一个字都不提，绝不编一个场景名 |
| 没装「鱼的每一天」/ 关掉 `mapFeastOn` | 不提 `feast_life_*`；生图那句改成「按你这会儿真穿的那身填」 |
| 没装「娱乐时间」/ 关掉 `mapFunOn` / `funVenue` 留空 | 不提 `fun_*`，旅游那处只给文字和图 |
| 没装「鱼的每一天」 / 没装 `maplink` | 小地图照常完整可用，只是三方不对齐 |
| 状态文件坏 / config 坏 / 图被删 | 静默降级：回空库、回「没图」，不抛错 |
| 图片超过 8 MiB / 不是那四种 | 面板当场拒掉并说清楚，不影响别的 |

`envPromptVars()` 全程 `try/catch` 永不抛错（抛错会把 World 卸载）；`create()` 保持纯（有测试钉住「create 之后目录还是空的」）。

## 面板

装好启用在 Coo 的世界页签里能看到一张**地点卡片墙**：

- 有图的卡显示缩略图（base64 data URL），没图的显示那段文字描写；没写描写显示「还没写描写」。
- 点卡片展开：改名字 / 描写 / 画风 / 别名 / 归类 / `scene`，标「常去」，传图 / 换图 / 清空图，删掉这处。
- 顶上是统计、**一排地形按钮**（点一下出勾选表，勾哪几处才加哪几处）、「加一处」、「刷新」。
- **没有坐标输入框、没有路线、不按远近排序**——分组只是展示顺序，界面里没有一根连线。

## 校验怎么跑

```powershell
cd "E:\deep seek\map-world"
node test/places.test.mjs   # 五套地形 / geo 守门 / id 安全 / hasScene / hasFunVenue
node test/state.test.mjs    # 加改删传图 / 勾选式追加 / 换地形只追加 / cover 锁死
node test/world.test.mjs    # 六工具 / 三个 8 组真值表 / 静默降级 / 图片守门
node test/panels.test.mjs   # 卡片墙 / 勾选表 / base64 缩略图 / 无坐标输入框
node tools/check-name.mjs   # 显示名三处一致（config / package.json / 面板产物）
node tools/check-prompt.mjs # 占位符对齐 + 空块时不许出现任何外部工具名
node tools/check-isolation.mjs # 不依赖别的 World / 不带路线
node tools/smoke.mjs        # dry-mount 冒烟
node tools/make-describe.mjs --check
```

`npm run verify` = 补 BOM + 显示名 + 提示词自检 + 隔离审计 + 冒烟 + describe 比对。

## 还没定的事

- **`mapStyleRef` 要不要真实现**（整图一张样式参考当所有地点出图的风格基准）。现在只有字段，不影响任何回执。
- **要不要发 npm**（见 `PUBLISHING.md`）。
- 显示名已定稿「鱼的小世界」。以后要改，得同时动三处，缺一处界面与包里就对不上：`src/config.js` 的 `LABEL`、`package.json` 的 `cortico.displayName` + `locales.*.displayName`、`dist/webui.js` 里 `T.zh` / `T.en` 的 `title`。`node tools/check-name.mjs` 会当场抓到不一致。
- **英文名不带撇号**：`Fish's ...` 那次炸过 JS 单引号字符串，`node --check` 直接 `SyntaxError`。`check-name.mjs` 里也钉了这一条。

## 相关文档

- `MAP-小地图插件-方案.md` —— 本插件的定稿方案（§3 数据模型 / §4 画面来源 / §6 工具与配置 / §7 maplink 契约 / §10 红线）
- `FUN-联动方案.md` —— 联动骨架模板（方案 A / C / D 的出处）
- `IMGGEN-联动方案.md` —— 素材库结构、`entry.json` 字段、红线出处
- `HANDOFF-2026-11-15-0.7.4-改名与联动.md` —— 0.7.4 现状、`funlink.js` 的来历
