# Mail MCP 基线与部署证据

采集时间：2026-10-17 05:33 UTC（上海时间 13:33）。本记录只做只读核查；没有启动或重启服务、调用 MCP 工具、读取账户/vault/邮件/token 内容、安装/更新包、运行测试、更新 Git 引用或写 GitHub。

## GitHub 版本、PR 与计划入口

gh 只读查询确认仓库 ertutio/mail-agent-mcp 为公开仓库。实时 main 是 96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca。本地 origin/main 仍停在 e47a74c6375c54a4af3b8e2e522262b4c156f3ef，而实时 main commit 对象不在本地；没有 fetch。

GitHub main 的完整递归 tree SHA 与本地固定分析快照 524e1b34c89ebe2834a27b948371227f142d346d 的 HEAD tree 都是 f1755af6f8c67d7d40ca22ea1da870e542e7d993。GitHub API 树未截断，167 个条目包含目录；本地 git ls-tree -r 有 146 个 blob。两者根 tree 相同，故当前快照所有跟踪文件一致。src、tests、package-lock.json、计划文件和 README 的对象 ID 也逐项一致。详细比较在 github-version-comparison.json。

所有 PR 状态查询只发现两个 PR：

- [PR #1](https://github.com/ertutio/mail-agent-mcp/pull/1) 于 2026-10-15 合并，merge commit 为 e47a74c…
- [PR #2](https://github.com/ertutio/mail-agent-mcp/pull/2) 于 2026-10-16 合并，head 为本地 524e1b3，merge commit 为实时 main 的 96f8864…该 PR 同时包含计划提交、SA-08 和 SEC-01 两项修复；未发现单独的计划 PR。

指定计划入口是 [docs/plans/audit-remediation-2026-10-15.md](https://github.com/ertutio/mail-agent-mcp/blob/524e1b34c89ebe2834a27b948371227f142d346d/docs/plans/audit-remediation-2026-10-15.md)。PR #2 正文记录交付、部署及合并结果，属于状态回执，不是另一份计划原文，所以没有复制 PR 正文。计划文件第 3 行仍写“尚未部署或合并”，第 27 行仍写“没有更新本机安装或合并主分支”；这些状态已被较新的 PR #2 正文和本机安装 marker 取代。SA-08 与 SEC-01 已完成，PR 正文称其余 30 项仍待处理。没有改写旧计划或仓库元数据。

## 本地源代码、安装目录、Codex 注册和运行进程

源仓库当前 HEAD 是 524e1b34…，开始时工作区干净。源 package.json 是 mail-agent-mcp@0.1.1。本机分发身份仍为 SinoEdwards/mail-agent-mcp 与 io.github.SinoEdwards/mail-agent-mcp；Git remote 仍是 ertutio/mail-agent-mcp.git。本轮没有调整这些身份字段。

安装目标是 <Codex tools>/mail-agent-mcp 下的本地 checkout overlay，不是已证实的 npm registry 安装。它的 Git HEAD 是旧的 detached commit aec136cf2217facaaeca41e8ff1710eabc8188c0，有 42 个已跟踪修改和 29 个未跟踪文件。其 local-install-version.json marker 记录源提交 524e1b34…、SA-08/SEC-01 已部署、安装产物匹配受测构建及账户配置未变；marker 最后写入时间为 2026-10-16 06:38:39 UTC。这里的 Git HEAD 不能当作当前实际部署版本，marker 和文件比对才记录覆盖部署来源。

当前磁盘比对结果：

| 产物 | 当前源代码与安装目录 |
| --- | --- |
| dist/index.js、dist/enroll.js、dist/setup.js、dist/web/server.js | 四个 SHA-256 完全相同；修改时间均为 2026-10-16 01:40 UTC |
| src（41 个文件）、public（3 个文件） | CRLF 归一为 LF 后内容一致；存在字节级换行差异 |
| src/services/imap-service.ts、src/web/server.ts | SHA-256 完全相同，分别为 875B44BC…、BEFAB330… |
| package-lock.json | SHA-256 完全相同：398A3829… |
| package.json | 两边均为 0.1.1，SHA-256 不同；唯一顶层差异是 files，安装版未列 README.en.md |

四个入口的 SHA-256 和其他完整文件摘要保存在 baseline-deployment.json。当前 launcher 文件 SHA-256 为 A591CCF5…。launcher 源码会从本地安装目录启动 dist/index.js，并配置完整 40-tool allowlist，属于可写 profile 的运行模式。

~/.codex/config.toml 中 [mcp_servers.mail-agent] 项已注册。白名单投影只记录 command=node.exe、1 个指向 launcher 的参数以及该配置段的环境变量键名（为空）；没有输出任何环境变量值。注册项本身不证明当前 transport 已连通。

2026-10-17 05:33 UTC 的窄范围进程查询发现 4 个 launcher 与 4 个 server 子进程；server 命令行指向安装目录 dist/index.js，启动时间为上海时间 13:17–13:29。进程启动晚于相关安装文件的最后修改时间，且当前安装版 dist 与源构建哈希一致，因此磁盘证据支持这些 server 从该安装版启动。没有检查进程内存、调用 tools/list 或做一次当前 MCP 调用，所以当前 transport 和当前工具响应仍未验证。历史 PR #2 正文也明确记载当时 Codex 会话的旧 transport 曾关闭；历史记录不替代本轮连通性证据。

当前 shell 的 Node.js 为 v24.20.0、npm 为 11.19.0；项目集成契约要求 Node.js 22.12 或更新版本。此版本查询不证明各 server 进程使用的 Node 二进制版本。

## 历史验证与现行验收边界

以下证据来自 2026-10-16 的 work/mail-agent-two-fixes-review-20261016/validation.txt 和 PR #2 正文，均为历史结果，不是本轮测试：

- SA-08 旧实现首轮 19 项用例中 14 失败、5 通过；最终分页套件 21 项通过。
- SEC-01 修复前 12 项中 10 失败、2 通过；修复后 12 项通过。两套定点用例合计 33 项通过。
- 最终回归 662 项通过、1 项跳过，行覆盖率 81.93%；类型检查、构建、146 文件秘密扫描、CRLF 空白检查和 package dry run 通过。
- 生产依赖审计为 0；全量依赖审计保留 6 个开发工具受影响条目（3 high、3 moderate），沿用 ENG-01 范围例外。
- 编译产物历史验证发现完整模式 40 tools、只读模式 17 tools、指定白名单 2 tools；设置 API 大小写变体无会话返回 403，合法会话返回 200，并检查了 no-store。
- 独立 DeepSeek 审查记录为超时且无可用结论，不计作通过。

本轮没有重跑测试、构建、打包、secret scan、依赖审计或 provider smoke。仓库没有 docs/acceptance.md。实际 release 文档 docs/release/release-workflow.md 明确工作流未启用；npm 与 MCP Registry 发布需要维护者单独批准。正式发布还要求 npm ci、测试、构建、lint、git diff --check、无秘密扫描、npm pack --dry-run、名称/版本一致性和严格 tag 校验。真实服务商 smoke 是单独的 clean-room 手工清单；本轮结果应保持 NOT RUN。

集成契约 docs/agent-integration.md 规定 stdio JSON-RPC、Node.js 22.12+，并以实时 tools/list 为能力清单权威来源。当前安装 launcher 是全工具、写能力模式；进程存在和文件哈希不能代替实时工具清单或调用成功证据。

## 后续路线图的基线处理

固定分析快照与实时 main 的全部 Git tree 内容相同，因此可基于 524e1b3 继续审查，不需切换或 fetch。后续路线图应把 SA-08/SEC-01 的“已部署并合并”状态作为当前事实，修订计划文件中第 3、27 行的过期回执；其余 30 项继续保持计划中的逐项授权与验收状态。保留目前远端、包名和 MCP Registry 身份，不在这份基线工作中更改。
