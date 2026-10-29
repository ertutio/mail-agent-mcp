# Mail Agent MCP：进度与续接

执行规则及 T01–T37 完成标准见[总计划](development-roadmap.md)，证据要求见[验收约定](../acceptance.md)。保存点更新本文件，不再为每轮制造一份平行路线。

## 当前游标

| 字段 | 当前记录 |
| --- | --- |
| 总任务状态 | `in_progress`：T01 已实现并开 PR 等评审，循环继续 |
| 代码基线 | `main@96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca`（2026-10-30 核对未变）；实施分支从该基线拉出 |
| 原计划来源 | [PR #3](https://github.com/ertutio/mail-agent-mcp/pull/3)，head `eee1daf88b52d4969f96c117dc93219b6dd5c7f3`，2026-10-17；计划未合并不等于其中修复已实现 |
| 当前检查点 / 子项 | C0 / T02（SEC-02）；T01 review_pending |
| next_action | T02：核对 imap-service.ts 三个 ImapFlow 构造点（connect/authenticateOnly/testConnection）与 buildImapAuth；用合成 localhost 服务器复现无 STARTTLS/拒绝/证书失败时认证字节被发送的 FAIL，再实现三入口统一的安全连接策略（implicit TLS/required STARTTLS 无明文降级），补三入口回归与 buildImapAuth 单测。 |
| 本子项通过条件 | 三个 IMAP 入口在无 STARTTLS/STARTTLS 拒绝/证书失败时认证字节为 0；bridge 例外（如有）单独决策并记录；既有 tls-host 回归保持。 |
| 全局阻塞 | 无已确认阻断所有核心实现的条件；T33/T34/T36各自有原门控，真实服务商验证另需明确授权 |

## 已交付与证据边界

- PR #1/#2 已合并。原 SA-08 跨账户分页、SEC-01 `/api` 保护已修复：保留回归，不再排待修；T26/T27 与 T08 修改时复用/补验其相邻断言。
- 当前代码已有 Gmail OAuth、QQ/Windows Credential Manager、安全附件根、账号选择、发送/回复/转发预览及 literal `confirmed:true` 的 imap_confirm_send。旧直接发信工具不注册，继续保留现有安全边界。
- safe-send 已有进程内 pending/sending/sent/ambiguous/expired、TTL、活动草稿与附件上限，进程内并发/重复确认保护；执行异常进入 ambiguous，不自动重试。它不证明人类在场、不提供跨进程持久幂等，也不等于账户/凭据revision绑定已完成。
- 已冻结 accountId 和邮件内容/附件字节，不等于冻结执行时同ID账户的身份/端点/发送策略。T11–T13 仍需完成；游标N-02/T26、APPEND N-03/T30不能由预览状态或Sent warning替代。
- SMTP接受、Sent保存和最终投递是不同事实；T21/T22/T30分别验收。普通开发不得真实发信来填证据。
- 原路线的 662 通过/1 跳过、81.93% coverage 是 2026-10-17 同源码tree的历史结果，本计划未重跑；历史全量audit失败也不是当前查询，更不能写零漏洞。保存原开发依赖排除，T33未经解除不自动修复/升级。
- 历史磁盘overlay/注册/版本号不证明当前进程加载版本或本轮MCP调用成功。T36仍待独立授权和实际运行证据。

## 初始就绪队列

子项状态：`ready / in_progress / verifying / review_pending / blocked / accepted`；总状态另有 `awaiting_human / complete`。表中的就绪准备范围不授权提前接通未定共享契约。一个检查点可拆为多个原 T 子项保存，每个原编号独立对账。

| 检查点 | 初始状态与依赖 |
| --- | --- |
| C0 / T01–T06、T37 | T01 ready；其余依原完成标准逐项推进。安全删除集成点联合验收T01/T03/T04/T05。 |
| C1 / T07–T13 | T07候选契约ready；T08–T11依T07；T12依T11，T13依T11/T12。 |
| C2 / T16/T17/T20/T21/T30/T26 | T16、T21、T30无真实技术前置；T17依T09/T11，T20依T11/T17，T26依T11。T16可在T02后提前。 |
| C3 / T14/T15/T18/T19 | T18/T19可独立；T14依T12，T15依T14。 |
| C4 / T27–T29 | T28/T29可独立；T27依T26，不能用失败恢复关闭游标身份。 |
| C5 / T22–T25 | T22–T24可独立，保留SMTP回执契约；T25依T11。 |
| C6 / T31/T32/T35 | T31/T32可独立；T35在受影响接口稳定时贯穿执行。 |
| C7 / T33/T34/T36 | blocked：分别等开发依赖范围决定、fork身份决定、候选通过T35及部署授权；其他核心工作继续。 |

## 范围与验证缺口

| 项 | 当前结论 / 下一步 |
| --- | --- |
| N-01 | 预览revision契约未由进程内草稿状态解决；发送有历史mock证据，删除同ID/相同UIDVALIDITY是条件风险。接入T11–T13，不重复计为另一SA-01修复。 |
| N-02 | 游标账户/版本/范围绑定为T26独立契约；T27有限恢复不能替代它。 |
| N-03 | APPEND false的草稿与Sent语义在T30核对；不把历史mock当真实服务商时序复现。 |
| V-01/V-02 | 当前运行进程、实际MCP调用、服务商差异、WinCred、最低Node和跨平台等按变更列待验证；mock/Ubuntu CI不能充当这些证据。 |
| R1–R5/F1–F8 | 按总计划原表保留风险/延期；可信审批、跨平台vault、全文索引、新provider等不自动扩入实现。 |

## 保存点记录格式

| T编号 / 状态 | 行为与提交 | 分支 / PR / 父PR | 实际验收证据 | 未完成 / 阻塞 / next_action |
| --- | --- | --- | --- | --- |
| 计划初始化 / ready | 文档重构，未修改业务 | 当前计划PR | 原编号/依赖保留及文档静态检查；产品检查未运行 | 启动实现后执行T01具体动作并更新游标。 |
| T01 / review_pending | `selectFolder` 改走 `getMailboxLock` 锁协议并返回稳定 `FolderSnapshot`（纯值+flags/permanentFlags数组副本）；handler 输出形状不变 | `fix/t01-folder-status-lock` @ `1a8f612`，[PR #5](https://github.com/ertutio/mail-agent-mcp/pull/5)，基线 main@96f8864 | 反例（同账户 INBOX/Archive 同UID 7 不同UIDVALIDITY，gate 暂停持锁后）：修复前 UID 命令 selection=Archive（FAIL），修复后保持 INBOX 且 B 等 `lock:released:INBOX` 后才 `select:Archive`；快照与活跃引用双向隔离；SELECT 失败不占锁、队列可继续。用例 `T01-LOCK-{READ,FLAGS,MOVE,DELETE}`、`T01-SNAPSHOT-01`、`T01-LOCK-FAIL-01`（tests/folder-status-lock-concurrency.test.ts）。lint/build/check:secrets 通过；全量 668 passed/1 skipped（browser-account-removal 首跑一次 ENOTEMPTY 临时目录竞争，单独重跑×2 与全量重跑均绿，与本改动无关）；folder-tools-status 7 例不变通过 | 评审等待中；接口变化：`selectFolder` 返回 `Promise<any>`→`Promise<FolderSnapshot>`，flags 由 Set 变数组副本，唯一生产调用者兼容。合并后跑受影响范围复验。next：T02（游标已更新） |

每个子项保留：基线与修复SHA、具体用例/输入、缺陷前FAIL/修复后PASS、相邻回归、精确副作用/零副作用断言、命令或run URL、环境/fixture、报告位置、失败/跳过/缓存/未执行、接口/兼容变化。进度只放必要摘要，凭据、真实邮件和完整日志不入文档。

每个阻塞保留：所缺条件、累计失败次数与假设、已试结果、解除条件、谁需决定什么、可继续的独立项。PR待评审时继续就绪项；发生硬中断先保存未提交改动及运行检查状态，恢复后核对再续接。
