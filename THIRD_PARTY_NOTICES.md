# 第三方来源与许可

## DeepSeek Harness

- 来源：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
- 使用版本：DSH `0.2.1-rc.2`。
- 涉及内容：`web/icons.js` 中的原生思考图标与鲸尾路径，以及 `web/native-whale.css` 中的 RunningWhaleTail APNG。构建结果也包含这些内容。
- 上游版权：Copyright (c) 2026 DeepSeek。
- 许可：MIT，原文保存在 [third_party/DeepSeek-Harness-LICENSE](third_party/DeepSeek-Harness-LICENSE)。

DeepSeek Harness 的名称和图标用于说明宿主集成。本项目由社区维护，不是 DeepSeek 官方插件。

## dsh-cost-meter 可选补丁

`integrations/dsh-cost-meter/auxiliary-billing.patch` 针对 [Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) 的指定提交提供辅助调用记账适配。补丁不包含该项目的完整源码。应用后仍须保留 dsh-cost-meter 自身的许可和版权声明；适用基线及构建方法见该目录的 README。

## JeV Decision API

JeV 是外部服务，不随本仓库分发。API 的使用受[官方服务条款](https://decision.vllm-sr.ai/terms)约束；本项目的 MIT 许可不替代该服务的条款。
