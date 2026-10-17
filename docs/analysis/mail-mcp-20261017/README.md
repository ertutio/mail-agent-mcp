# Mail MCP 分析结果（2026-10-17）

后续开发先读 [当前正式路线图](../../plans/development-roadmap.md)，再读 [agent 阅读入口](START-HERE.md)。每轮只领取一个任务，完成验收后停止。本目录保留全部原分析结果的公开副本；它不是自动开发或部署授权。

## 按需读取

| 问题 | 入口 |
| --- | --- |
| 领取任务、推荐顺序、独立验收 | [正式路线图](../../plans/development-roadmap.md) |
| 模块和关键行为链 | [agent入口](START-HERE.md)、[模块索引](MODULE-INDEX.md)、[行为证据](CODE-KNOWLEDGE.md) |
| 代码图谱/覆盖的机器检索 | [graph](knowledge/knowledge-graph.json)、[module-index](knowledge/module-index.json)、[coverage](knowledge/coverage.json)、[test-index](knowledge/test-index.json) |
| 版本、安装/注册/进程差异 | [baseline-deployment](baseline-deployment.md)、[GitHub tree比较](github-version-comparison.json) |
| 验证类别、执行和未执行 | [EVIDENCE](EVIDENCE.md)、[五个模拟观察](probe-results.json) |
| 依赖与CI状态 | [dependency-evidence](dependency-evidence.md)、[audit响应](dependency-audit-current.json) |
| 独立复核输入/返回 | [review-task](review-task.md)、[review-result](review-result.json) |
| 全部文件对应关系与摘要 | [artifact-manifest](artifact-manifest.json) |

## 来源和发布处理

原始分析基线为 524e1b34c89ebe2834a27b948371227f142d346d，对应源码 tree 与 main 96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca 一致。源码/行号在历史基线定位；本目录未重复打包整个源码快照或 source.tar，因为其内容已由仓库 Git 版本保存。这两者是分析输入副本，不是遗漏的结果文件。

原结果目录全部文件和 Understand Anything 目录的全部文件均列入 manifest；包括临时结构输入/输出、指纹、图谱和覆盖，分别保存在本目录及 knowledge/。没有只选上传摘要。原 ROADMAP-PR-BODY.md 是归档草案，roadmap-index.json 是该草案的派生索引；当前任务顺序以正式路线图为准。

本机绝对路径已替换为 &lt;analysis-snapshot&gt;、&lt;worker-state&gt;、&lt;worker-env-file&gt;、&lt;isolated-review-session&gt;、&lt;claude-cli&gt; 或 &lt;local-path-redacted&gt;。这些标签不指向可读取的私人文件。保留会话结果/预算/费用报告以记录证据，未上传账户数据、邮件正文、凭据或令牌。manifest 同时记录原文件和公开副本 SHA-256，格式规范化、路径脱敏或链接调整会改变摘要；来源摘要只作本机原件对应校验。

脚本是历史分析辅助材料，不是新增产品代码、自动更新hook或CI步骤；它们保留历史目录布局假设，不能在当前检出直接执行来冒充重跑。复现时另建所需的固定版本副本，按任务范围重建路径和输入。所有原始 PASS/FAIL/NOT RUN 均保留原时间与含义；图结构校验通过不代表行为正确。
