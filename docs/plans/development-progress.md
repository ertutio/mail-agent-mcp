# Mail Agent MCP：进度与续接

执行规则及 T01–T37 完成标准见[总计划](development-roadmap.md)，证据要求见[验收约定](../acceptance.md)。保存点更新本文件，不再为每轮制造一份平行路线。

## 当前游标

| 字段 | 当前记录 |
| --- | --- |
| 总任务状态 | `in_progress`：T01 已实现并开 PR 等评审，循环继续 |
| 代码基线 | `main@96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca`（2026-10-30 核对未变）；实施分支从该基线拉出 |
| 原计划来源 | [PR #3](https://github.com/ertutio/mail-agent-mcp/pull/3)，head `eee1daf88b52d4969f96c117dc93219b6dd5c7f3`，2026-10-17；计划未合并不等于其中修复已实现 |
| 当前检查点 / 子项 | C0 / T37（MAIL-07）；T01–T05 review_pending |
| next_action | T37：核对 imap_delete_by_domain 的候选集合构造（地址解析后按域匹配）；用显示名/相似域/子域反例复现「域子串冻结错误集合」FAIL，再实现解析后二次精确域匹配并冻结候选集合。 |
| 本子项通过条件 | 严格地址域/子域策略，预览不包含相似域；冻结集合正确；T01/T03/T04/T05 在安全删除集成点联合验收仍保留。 |
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
| T02 / review_pending | 三个 ImapFlow 构造点共用 `imapTransportPolicy`：tls→隐式 TLS；明文账户→`secure:false, doSTARTTLS:true` 必需 STARTTLS，失败于 authenticate 前关闭 | `fix/t02-starttls-policy` @ `93c3118`，[PR #6](https://github.com/ertutio/mail-agent-mcp/pull/6)，基线 main@96f8864 | 字节级（真实 imapflow + 合成 localhost 服务器，tests/imap-starttls-policy.test.ts）：修复前 STARTTLS 被拒场景凭据明文过线（authReachedWire=true，FAIL），修复后两场景（无 STARTTLS/被拒）线上零 LOGIN/AUTHENTICATE 字节且 connect 以 STARTTLS 错误失败；配置级 T02-POLICY-IMPLICIT/STARTTLS 固定三入口同策略。全量 666 passed/1 skipped；lint/build/check:secrets 通过；git diff --check 干净 | 评审等待中；兼容变化：tls:false 且服务器无 STARTTLS 时连接失败（安全收紧，bridge 完全无 STARTTLS 的例外按原计划留待单独决策）。完整 STARTTLS 升级成功路径未做字节级验证（库流程+配置级覆盖，见 PR #6）。next：T03（游标已更新） |
| T03 / review_pending | 三个写路径共用 `assertNativeMoveCapability`（含 IMAP4rev2 折叠语义）：moveEmail 在目的文件夹创建前、deleteEmail/bulkDelete 在首个分块前拒绝无 MOVE 服务器的移动；bulkDelete 循环内重连后复查 | `fix/t03-move-gate` @ `ce26d04`，[PR #7](https://github.com/ertutio/mail-agent-mcp/pull/7)，基线 main@96f8864 | 反例（capability map 去 MOVE）：修复前三例继续调用 messageMove（FAIL，库将走 COPY+EXPUNGE），修复后以 /MOVE/ 错误拒绝且零写调用；T03-MOVE-GATE-OK 固定有 MOVE 行为不变；T03-TRASH-UNAFFECTED 固定永久删除不受此门禁（归 T04）。全量 667 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；兼容变化：无 MOVE 服务器移动报错零改动（安全收紧）。与 T01 的合并顺序需协调：后合并方需在 folder-status-lock-concurrency.test.ts 的 mock 上补 capabilities。next：T04（游标已更新） |
| T04 / review_pending | 新增 `assertPermanentDeleteCapability`（与 T03 共用 `hasCapabilityCompat`，rev2 折叠语义）：deleteEmail/bulkDelete 的 Trash 内永久删除在打旗标前核实 UIDPLUS，首个分块前拒绝+循环内重连复查 | `fix/t04-uidplus-gate` @ `725b95c`，[PR #8](https://github.com/ertutio/mail-agent-mcp/pull/8)，父PR #7（堆叠），base fix/t03-move-gate | 反例（mock 按真实 expunge.js 语义，Trash 持 UID7=确认集合、UID9=集外已Deleted）：修复前永久删除 UID7 连带 EXPUNGE UID9（FAIL）；修复后两入口 /UIDPLUS/ 拒绝且零写、UID9 保留；T04-UIDPLUS-OK/T04-REV2-FOLDED 固定精确清除。T03-TRASH-UNAFFECTED fixture 相应补 UIDPLUS。全量 671 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；兼容变化：无 UIDPLUS 且非 rev2 服务器永久删除报错零改动（安全收紧）。服务端并发 EXPUNGE 竞态归 T05 范围。next：T05（游标已更新） |
| T05 / review_pending | bulkDelete 的 falsy 结果按「副作用未知」计入 failed/errors 不计 deleted，onProgress 仅确认分块触发；deleteEmail Trash 内未确认 EXPUNGE 抛错不再静默成功 | `fix/t05-delete-counts` @ `ccb7c96`，[PR #9](https://github.com/ertutio/mail-agent-mcp/pull/9)，父PR #8（堆叠链 #7→#8→#9），base fix/t04-uidplus-gate | 反例（合成返回值）：修复前 false/undefined 分块计为 deleted、deleteEmail 静默成功（FAIL）；修复后 deleted=0 且 failed/errors 可见未知；确认分块与抛错分块回归不变。bulk-delete 错误处理 fixture 原断言即旧行为，改为「确认+抛错」组合。全量 677 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；flagBatch 对 messageFlagsAdd 返回值的核实不在 T05 边界，如需可独立领取。next：T37（游标已更新） |

每个子项保留：基线与修复SHA、具体用例/输入、缺陷前FAIL/修复后PASS、相邻回归、精确副作用/零副作用断言、命令或run URL、环境/fixture、报告位置、失败/跳过/缓存/未执行、接口/兼容变化。进度只放必要摘要，凭据、真实邮件和完整日志不入文档。

每个阻塞保留：所缺条件、累计失败次数与假设、已试结果、解除条件、谁需决定什么、可继续的独立项。PR待评审时继续就绪项；发生硬中断先保存未提交改动及运行检查状态，恢复后核对再续接。
