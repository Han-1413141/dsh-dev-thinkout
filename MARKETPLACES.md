# 发布与市场收录

更新日期：2026-10-23。

公开项目名为 **dsh-jev-thinkout**，npm 包名和内部插件标识为 **dsh-jev-progress**。介绍以 **JeV 思维链外显**为主：将长思考中的任务规划、执行进展和阶段小结呈现为聊天正文，保持主模型上下文不变。

## 已发布

| 渠道 | 版本 | 结果 |
| --- | --- | --- |
| [GitHub Release](https://github.com/Han-1413141/dsh-jev-thinkout/releases/tag/v0.5.5) | 0.5.5 | 已发布，可下载 `.tgz` 与 `SHA256SUMS` |
| [npm](https://www.npmjs.com/package/dsh-jev-progress) | 0.5.5 | 已公开，已核对 registry 元数据和实际下载包 |

```shell
dsh plugin --profile desktop add dsh-jev-progress@0.5.5
```

GitHub Release 与 npm 的安装包逐字节一致，SHA-256 为：

```text
cf4cfe638c5f426fe7c6163c91dd6cc2c7ebdbbd9ecdb603c282292af1b0699b
```

0.5.5 包含 macOS 与 Windows 图标统一：摘要标识、流程状态、并行符号、箭头及控制按钮使用固定 SVG；蓝色鲸尾共用原生动画资源。100 项业务检查及 [macOS、Windows、Linux 的六组 CI](https://github.com/Han-1413141/dsh-jev-thinkout/actions/runs/39900972681) 通过。本地 Windows Chrome 已复看，macOS 的 DSH 窗口尚未实机复看。

## 收录申请

下表记录实际提交结果。提交申请、预检通过、维护者合并和网站正式展示是不同阶段。

| 渠道 | 申请记录 | 当前状态 |
| --- | --- | --- |
| awesome-dsh-plugin / dsh-market 社区目录 | [PR #8844](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/8844) | 目录 CI 和收录门槛检查均已通过，等待维护者合并 |
| dshplugin.app | [申请 #442](https://github.com/vbarter/dsh-plugin-registry/issues/442) · [审核 PR #443](https://github.com/vbarter/dsh-plugin-registry/pull/443) | Manifest 预检通过，已生成审核 PR，等待合并 |
| HackSing 插件目录 | [申请 #338](https://github.com/HackSing/dsh-plugins/issues/338) | 已提交，等待处理 |
| Open Plugin Market / dshopen.org | [申请 #56](https://github.com/polang233/dsh-plugin-index/issues/56) | 已提交 npm 包、用途、兼容信息和对照截图，等待处理 |
| DSH Market / dshplugin.io | [申请 #37](https://github.com/tjsdyy/dshplugin/issues/37) | 已通过网站指向的 GitHub 通道提交，等待处理 |
| DSH Marketplace | [申请 #20](https://github.com/DshMarketPlace/awesome-dsh-plugin/issues/20) | 已提交收录请求，并如实说明当前尚未满足其常规标签发现的十次提交门槛 |
| DSH Plugin Store | [官方投稿方式](https://dshpluginstore.com/submit) | 已向官方投稿邮箱发送收录申请，并核对已发送邮件，等待回复 |
| dshfind | [官方收录规则](https://github.com/hikariming/dshfind#submit-your-plugin) · [本项目标签](https://github.com/Han-1413141/dsh-jev-thinkout) | 已添加 `dsh-plugin` 和 `deepseek-harness` 标签，等待定时发现；尚未确认正式收录 |

dshfind 的公开规则是通过 `dsh-plugin` 标签每日发现新仓库，不需要先发 Issue；经历两次同步仍未出现时，再提交异常反馈。因此本次采用其自动发现流程，没有提前发送重复催收请求。

DSH Marketplace 的独立精选清单与其完整目录、awesome-dsh-plugin 社区目录是不同的收录流程；本次没有将提交请求写成已获精选或已经上架。

## 展示资料

- [安装插件 / 未安装插件的效果对比](README.md#效果对照)。
- [截图清单](screenshots.json)：两张原图按“安装后、未安装”排序，供支持此约定的市场读取。
- [使用指南](docs/user-guide.md)：JeV Key 获取和导入、摘要方式、外观、费用及数据去向。
- [更新记录](CHANGELOG.md)。

申请中已披露 JeV 与翻译、轻量摘要涉及外部服务，轻量调用可能产生费用；没有将收录、CI 或包完整性检查描述为安全认证。
