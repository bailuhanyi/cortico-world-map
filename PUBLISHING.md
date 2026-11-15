# 发布清单（cortico-world-map）

> 这一版 **0.1.0**，还没发。发布由主人自己在 PowerShell 里敲（`npm publish` 要真 TTY + 6 位 OTP，agent 做不了）。

## 发之前

```powershell
cd "E:\deep seek\map-world"

# 1) 全套测试（逐个跑，不用 node --test——受限沙箱里 spawn 子进程会 EPERM）
node test/places.test.mjs
node test/state.test.mjs
node test/world.test.mjs
node test/panels.test.mjs

# 2) 单独跑的自检
node tools/check-name.mjs        # 显示名三处一致
node tools/check-prompt.mjs      # 占位符对齐 + 不提生图也能读通
node tools/check-isolation.mjs   # 不依赖别的 World + 不带路线
node tools/smoke.mjs             # dry-mount 冒烟

# 3) describe.json 必须与代码一致
node tools/make-describe.mjs --check

# 4) install.ps1 的 BOM（前 3 字节必须是 239,187,191）
node tools/fix-ps1-bom.mjs install.ps1
```

或者一条 `npm run verify`（= 补 BOM + 显示名 + 提示词 + 隔离 + 冒烟 + describe 比对）。

## 发

`npm publish` 需要 **`danger-full-access` + 真 TTY + 6 位 OTP**，必须在主人自己的 PowerShell 里敲：

```powershell
cd "E:\deep seek\map-world"
npm pack --dry-run          # 先看会打进包里哪些文件
npm publish --otp 123456    # 换成你手机上的码
```

`files` 字段只收 `src / dist / assets / describe.json / CHANGELOG.md / README.md / PUBLISHING.md`——`test/` 和 `tools/` 不进包。

## 发之后验

```powershell
npm view cortico-world-map version        # 应回 0.1.0
npm view cortico-world-map dist-tags      # latest 应是 0.1.0
```

想让它进市场，开一个 `[同步] cortico-world-map` issue。

## 发之前必须确认的两件事

1. **显示名已定稿「鱼的小世界」**（英文 `Little World`，2026-11-15 主人拍板）。
   - 以后再改，三处一起改，缺一处界面与包里就对不上：`src/config.js` 的 `LABEL`、`package.json` 的 `cortico.displayName` + `locales.*.displayName`、`dist/webui.js` 里 `T.zh` / `T.en` 的 `title`。
   - `node tools/check-name.mjs` 会把不一致当场抓出来（也已进 `verify` 和 `prepublishOnly`）。
   - **英文名别带撇号**——`Fish's ...` 那次炸过 JS 单引号字符串，`node --check` 直接 `SyntaxError`。
2. **`mapStyleRef` 要不要真实现**（整图一张样式参考当所有地点出图的风格基准）。现在只有字段，不影响任何回执。

**`worlds.map` 段名不能改**：world id 必须是 `map`——「鱼的每一天」那边的 `maplink`（归另一个会话）只读 `worlds.map.enabled` 这一个字段。改了名就断了那条契约。

## 版本号

**当前 `0.1.1`**（0.1.0 已发布；0.1.1 是面板可用性修复，无数据格式变化，从 0.1.0 升上来不用迁移）。

改版本号要同时改：

- `package.json` 的 `version`
- `CHANGELOG.md` 加一节（市场按 `##` 标题里的版本号切段，**新的写最前面**）

**git 提交、发版仍等主人点头。**

## 常见坑

| 坑 | 说明 |
| --- | --- |
| 用 `node --test` | 受限沙箱里 spawn 子进程会 EPERM，必须 `node test/xxx.test.mjs` 逐个跑 |
| 用 `Set-Content` / `.NET` 静态调用改中文文件 | 会乱码。改中文一律用编辑工具或 Node `fs` |
| `install.ps1` 丢 BOM | PowerShell 5.1 会按 GBK 读中文，整个脚本乱码。`node tools/fix-ps1-bom.mjs` |
| 改了 `ENV_PROMPT.md` 忘了重跑 describe | `node tools/make-describe.mjs --check` 会报不一致 |
| 发之前没跑 `check-isolation` | 它挡的是「偷偷依赖别的 World」和「偷偷加路线」，两条都是认证会查的 |
