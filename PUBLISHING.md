# 发布清单（cortico-world-map）

当前准备发布 **0.3.0**。2026-11-19 核对 npm：latest 为 0.2.2，0.3.0 未占用。本次只提交和推送 Git，npm 由用户在自己的终端发布。

## 发布内容

地点册支持阅读与编辑分离、当前住所横幅、统一搜索、关系面包屑与原位返回、命名视图、最近查看/最近编辑、排序与手动置顶。图片增加焦点、真实裁切框、资源盘点和可恢复归档；冲突编辑按字段比较并保留草稿基线。

地点数据仍兼容 version 1，继续使用原宿主数据目录即可升级，不需要导入、覆盖或重置。面板偏好独立保存，归档保留图片，不释放磁盘空间。未新增键盘快捷键或真实地理导航。

## 发布前验证

```powershell
cd "E:\deep seek\map-world"
npm test
npm run verify
npm pack --dry-run --cache .npm-cache
```

五套测试共 **274 项**：places 26、state 50、world 100、transfer 17、panels 81。自检包括显示名、提示词、World 隔离、启动冒烟及 describe 一致性。真实 Coo 的视觉验收尚未完成，自动化通过不代表已在实际宿主试装。

## 发布

版本已设为 **0.3.0**，不要再运行 `npm version`。先确认目标版本仍未被占用：

```powershell
npm view cortico-world-map@0.3.0 version
# 首次发布前应报告目标不存在；若已有此版本，停止，不要重复发布。
npm publish --cache .npm-cache
```

在 npm 登录/浏览器授权或 OTP 提示出现时完成验证。若账户要求手动传码，可使用 `npm publish --cache .npm-cache --otp <手机上的6位验证码>`。不要使用恢复码作为 OTP。

`files` 收录 src、dist、assets、describe.json、更新日志和发布说明；测试、工具、本地缓存、运行时数据与旧 tgz 不进包。

## 发布后核对

```powershell
npm view cortico-world-map version
npm view cortico-world-map dist-tags
```

应看到 latest 为 **0.3.0**。市场同步如需发送 issue，由用户另行发起。

## 固定契约

显示名为「鱼的小世界」（Little World），world id 与配置段必须为 `map` / `worlds.map`。默认画风是文字，地点独立画风优先，不修改已有图片。不引入路线、坐标、距离或自动地点关系。
