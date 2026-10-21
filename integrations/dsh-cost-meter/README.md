# dsh-cost-meter 兼容说明

本插件可独立显示 JeV、轻量摘要的用量和费用。要让这些调用进入 cost-meter 的统一账本，宿主的 `costMeter` 服务还需提供辅助调用接口；插件界面会显示是否已接入，不能只根据版本号判断兼容性。

## 需要的接口

| 接口 | 职责 |
| --- | --- |
| `withAuxiliaryBilling(createStream)` | 为独立模型流建立计费范围，避开普通模型流的全局计费钩子 |
| `recordAuxiliaryUsage(record)` | 按请求 ID 幂等记录辅助回执 |
| `getAuxiliaryUsage(sessionId)` | 查询当前历史周期的辅助调用统计 |
| `getPriceCatalog()` | 提供轻量调用的价格目录 |

JeV 使用用途 `jev-decision`，轻量摘要使用 `jev-summary`。协议版本为 `1`，回执包含插件标识、请求 UUID、会话、时间、用途、模型、Token、结果和费用来源，不携带原始段落或 Key。主插件适配入口为 `src/cost-integration.js`。

JeV 按当前官方免费服务记录费用 0；轻量调用使用请求当时的价格目录。缺少用量或价格时保留未知。断线后的记录先保存在本地队列，重新连接后去重提交。

## 可选补丁

[auxiliary-billing.patch](auxiliary-billing.patch) 针对以下**唯一基线**：

- 仓库：[Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)。
- 提交：`993bc1bde48017a4a1de43ddcd49cdee14e6bcf8`。
- 基线包版本见该提交的 `package.json`；这是该源码基线上的适配，不能仅根据 npm 包版本判断接口是否存在。

补丁包含辅助日志、历史恢复、去重、模型费用与轮次费用接入，以及「插件辅助调用」统计界面和专项检查。它不会自动安装或修改用户已有的 cost-meter。

维护者可以在独立目录中应用：

```powershell
git clone https://github.com/Han-1413141/dsh-cost-meter.git dsh-cost-meter-jev
cd dsh-cost-meter-jev
git checkout 993bc1bde48017a4a1de43ddcd49cdee14e6bcf8
git apply --check ../dsh-dev-thinkout/integrations/dsh-cost-meter/auxiliary-billing.patch
git apply ../dsh-dev-thinkout/integrations/dsh-cost-meter/auxiliary-billing.patch
npm ci
npm run build
node test/auxiliary-usage.mjs
node test/verify.mjs
npm pack
```

示例假定两个项目目录相邻；按实际下载位置替换补丁路径。其他源码版本需要人工合并，不能直接跳过 `git apply --check`。安装生成的包后，在进度设置中确认「已接入 dsh-cost-meter」，再到会话费用详情查看辅助调用。

## 计费边界

`withAuxiliaryBilling` 必须覆盖模型流的实际创建、迭代和清理，之后再提交一次辅助回执。只追加一条费用但保留原全局计费钩子，会重复计算。

回执使用独立日志并参与历史回放和清空周期。重复提交、重启恢复及乱序完成都必须按 UUID 去重；用户清空历史后，不应从旧回执恢复已清除的金额。

该补丁曾通过辅助记账专项检查及成本插件完整检查；主插件的 GitHub CI 不等于重新验证 cost-meter 的全部依赖与宿主界面。适配代码继续遵循 dsh-cost-meter 原许可。
