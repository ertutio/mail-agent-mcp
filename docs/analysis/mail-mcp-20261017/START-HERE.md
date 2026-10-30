# Mail MCP：单轮领取入口

先读本文件，再读 [当前正式路线图](../../plans/development-roadmap.md) 的“下一轮 T01”。路线图规定领取顺序；具体实施仍由维护者逐轮选择。每次由维护者选定 **一个**任务；完成该任务和必要验收后交接并停止，建议下一项，等待选择。验收失败只处理本任务内原因；前置契约失效或范围扩大时报告，不自动转做下一项。

推荐先领 **T01：MAIL-01，关闭 folder_status 绕过邮箱锁的路径**。当前代码的受控模拟已观察到：持有 INBOX 锁的 UID7 操作被并发 SELECT 切换到 Archive。T01 不包含 TLS、连接池、删除能力升级或部署。

代码分析基线：Git 固定版本 `524e1b34c89ebe2834a27b948371227f142d346d`；整棵 Git tree 与远端 main `96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca` 相同。源码位置以仓库根目录为准，历史行号以分析基线为准。以后领取任务时先比对当前版本与该任务相关的 diff，不因换轮次重扫全库。

## 按问题取上下文

| 本次领取的问题 | 必读范围 | 验证入口 |
| --- | --- | --- |
| T01 / 邮箱锁、UID 写操作 | [行为链 E04/E05](CODE-KNOWLEDGE.md)；`src/tools/folder-tools.ts`、`ImapService.selectFolder/getFolderStatus` 及相关 UID 调用者 | 路线图 T01 的闸门回归；现有 `folder-tools-status`、`guarded-delete`、move 测试 |
| 账户版本、缓存、预览身份 | E03/E05/E06；账户 schema/事务、IMAP/SMTP 缓存与发送/删除预览 | T11–T15、T17/T20；按所领任务读，不同时实施 |
| 搜索、排序、分页、partial | E02/E03；`unified-search-tools`、`searchEmailPage`、`search-folders` | T26–T29；保留 SA-08 合成回归 |
| OAuth、代理、凭据注册/修复 | E07/E08；调用入口与 resolver/持久化一起读 | T02/T16–T20；仅模拟/本地协议服务 |
| 发送、草稿、Sent、附件 | E06/E09；安全发送和实际 SMTP/APPEND 共用层 | T06/T21–T25/T30；字节/收件人/副作用回归 |
| 安装、依赖、部署 | E10；[版本证据](baseline-deployment.md)，再读相关 release 文档 | T31–T36；后续部署单独授权 |

定位未知模块时查 [模块索引](MODULE-INDEX.md)。需要机器检索时查本目录 `knowledge/module-index.json`、`knowledge/knowledge-graph.json`；需要判断覆盖可信度时查 `knowledge/coverage.json` 与 [证据台账](EVIDENCE.md)。图谱是检索索引；不要求每轮加载整图、全库源码或两份审计 JSON。

## 每轮执行与回执

1. 确认领取 ID、当前分支/SHA/相关脏改、任务前置已满足；保留他人改动。
2. 读任务入口、直接调用者和现有相邻测试；先形成能暴露缺陷的反例，再最小修改。
3. 一个主要实现者；按适用 AGENTS 分工。共享可写文件只有一个写入者，跨接口先完成契约批。不默认启用多代理审查，不重复已经有效的检查。
4. 定点回归提供开发反馈。稳定集成点再做 T35 所列必需检查；提交、推送、PR、合并、部署和真实账户验证沿用本轮明确授权范围，各自需要对应授权。
5. 回执写实际改动/接口、FAIL→PASS、相邻回归、副作用、有效证据、未覆盖项和建议下一项，**随后停止**。失败、跳过、未执行分别列示。

原分析轮次未修改产品源码、配置、账户或凭据；本次发布只新增文档和分析产物，不实施修复、部署或重启。真实邮箱及当前 MCP 代表性调用未执行。独立复核是一次开发协作 API 调用；产品代码的正常/重试/回退路径没有新增 LLM 请求。费用与覆盖边界见 EVIDENCE。
