# 开发与发布

## 环境

- 使用 Node.js 22 或 24 开发；宿主接入以 DSH `0.2.1-rc.2` 为当前基线。
- 本项目没有额外 npm 运行依赖，宿主提供 `llm`、`translator`、客户端连接和槽位。
- 单元检查不需要 JeV Key，不调用外部模型。

```powershell
git clone https://github.com/Han-1413141/dsh-jev-thinkout.git
cd dsh-jev-thinkout
npm ci --ignore-scripts
npm test
npm run build
npm run check:release
```

`web/` 是前端源文件，`scripts/build-client.mjs` 生成 `lib/client.js`。修改前端后重新构建，不能只修改生成文件。构建按 UTF-8 与 LF 输出；CI 同时检查源码、构建产物、包内容和版本一致性。

## 本地接入

先构建和打包：

```powershell
npm run build
npm pack --pack-destination .
```

然后安装生成的 `dsh-jev-progress-0.5.5.tgz`：

```powershell
dsh plugin --profile desktop add ./dsh-jev-progress-0.5.5.tgz
```

开发时可使用独立的 DSH profile，避免与日常配置混在一起。宿主读取 `cordis.patch.yml` 自动加载插件。缺少翻译服务时先加载 DSH 原生翻译插件；不要向主模型注入一段提示词来替代宿主事件接入。

## 默认配置

以下配置用于与已有插件条目合并，不要覆盖整个 DSH profile 文件：

```yaml
- id: jev-progress
  name: dsh-jev-progress
  config:
    enabled: true
    summaryMode: light
    appearance: whale
    summaryAppearance: plain
    showStatusBar: true
    flowDirection: horizontal
```

`summaryMode` 可选 `light`、`native`；`appearance` 可选 `whale`、`orbit`、`native`、`none`；`summaryAppearance` 可选 `plain`、`tagged`；`flowDirection` 可选 `horizontal`、`vertical`。这些是新会话默认值，已有会话优先恢复缓存中的选择。

`presets/visible.json` 与 `presets/hidden.json` 提供显示和隐藏底部进度的默认配置；`dsh-jev-progress/hidden` 导出默认隐藏入口。

## 提交范围

提交源码、检查、构建结果和用户文档。不要提交 `.local/`、会话日志、凭据、账本、本机绝对路径、独立示例项目或临时研究材料。测试中的输入使用合成文本。`docs/images/` 中的两张效果截图由使用者提供并授权公开，按原图保留，并在发布检查中逐项列入白名单。

涉及提示词或筛选条件的修改，应检查首段、中途结果、重复计划、实现细节、取消和晚到结果；不要用更多输出条数代替内容质量。涉及计费的修改，应区分未知金额、目录估算和真实实扣。

## 发布

1. 同步 `package.json` 与 `src/host.js` 的版本号，更新 `CHANGELOG.md` 和安装链接。
2. 执行 `npm test`、`npm run build`、`npm run check:release`，检查安装包白名单。
3. 提交、推送，等待 GitHub Actions 通过；确认远程检查对应当前提交。
4. 创建对应版本标签和 GitHub Release，附上 `.tgz` 与 SHA-256 文件；将同一份 `.tgz` 发布到 npm。
5. 从 Release 下载安装包并核对摘要与内容。

本项目同时通过 GitHub Release 与 npm 分发，使用同一份安装包。npm 包名及内部插件标识为 `dsh-jev-progress`，公开仓库名为 `dsh-jev-thinkout`。发布前确认 npm 登录身份，并使用 `npm publish <已核对的安装包.tgz> --access public`，不要重新打包后发布另一份内容。

当前自动化覆盖业务逻辑、取消与恢复、正文投影、流程关系、方向保存及费用接口。浏览器工具初始化失败的环境不能视为完成视觉验收；界面调整还需要实际 DSH 窗口复看。
