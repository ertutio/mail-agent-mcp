# Mail Agent MCP：进度与续接

执行规则及 T01–T37 完成标准见[总计划](development-roadmap.md)，证据要求见[验收约定](../acceptance.md)。保存点更新本文件，不再为每轮制造一份平行路线。

## 当前游标

| 字段 | 当前记录 |
| --- | --- |
| 总任务状态 | `in_progress`：T01 已实现并开 PR 等评审，循环继续 |
| 代码基线 | `main@96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca`（2026-10-30 核对未变）；实施分支从该基线拉出 |
| 原计划来源 | [PR #3](https://github.com/ertutio/mail-agent-mcp/pull/3)，head `eee1daf88b52d4969f96c117dc93219b6dd5c7f3`，2026-10-17；计划未合并不等于其中修复已实现 |
| 当前检查点 / 子项 | C5 / T23（MAIL-04，独立）；T01–T09、T16、T18–T19、T22、T24、T28–T32、T37 review_pending |
| next_action | T23：核对 reply-to 与地址模型（MAIL-04/E09：To整串/漏CC与Reply-To）；用多收件人原始消息复现「Reply-To 缺失/CC遗漏/包含自身/重复」FAIL，再实现结构化地址（Reply-To 优先、完整 To/Cc、排自身、去重）并以合成 MIME 金样断言。 |
| 本子项通过条件 | Reply-To 优先、完整 To/Cc、排自身、去重；合成 MIME 金样断言。 |
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
| T37 / review_pending | imap_delete_by_domain 在预览/冻结前按解析地址做二次精确域匹配（显示名文本绝不参与，子域保持排除）；预览与冻结集合同源 | `fix/t37-domain-candidates` @ `d4753be`，[PR #10](https://github.com/ertutio/mail-agent-mcp/pull/10)，父PR #9（堆叠链 #7→#8→#9→#10） | 反例（候选含精确/后缀相似域/显示名陷阱/显示名+精确地址）：修复前冻结并删除全部 4 条（FAIL）；修复后仅 2 条精确域命中进入预览与确认，确认不重搜索。既有 frozen-confirmation 用例不受影响。全量 679 passed/1 skipped（account-runtime-removal 首跑临时目录竞争，重跑均绿）；lint/build/check:secrets/diff --check 通过 | 评审等待中；域规范化（IDN/punycode）未处理，小写精确比较。next：T06（游标已更新） |
| T06 / review_pending | imap_download_attachment 迁移到共享 extractPdfPreview 隔离 worker（预算/截止/忙碌同预览入口），文本按 MAX_BODY_CHARS 截断，失败显式 textContentUnavailable | `fix/t06-pdf-isolated-download` @ `bd3a28e`，[PR #11](https://github.com/ertutio/mail-agent-mcp/pull/11)，独立基线 main@96f8864 | 反例（vi.mock 记录进程内 pdf-parse 导入）：修复前下载发生进程内导入且失败无原因（E09 复现，FAIL）；修复后零进程内导入、超预算/损坏 PDF 显式报因并保存。既有端到端提取与 worker 预算用例经 worker 路径通过。全量 665 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；响应新增可选 textContentTruncated/textContentUnavailable（附加字段）。Windows 子进程实境按 T35/T36 另行验证。next：T07（游标已更新） |
| T07 / review_pending | 新增 validateAccountCandidate 纯校验/规范化（三白名单、类型、null 拒绝/空串占位兼容、默认值、auth 结构）；addAccount 前置校验、updateAccount 校验合并候选，非法候选零存储写入 | `fix/t07-account-candidate-schema` @ `040f1ae`，[PR #12](https://github.com/ertutio/mail-agent-mcp/pull/12)，独立基线 main@96f8864 | 反例（fs mock 断言零写入）：修复前 evilExtra/字符串端口被持久化、未知更新字段到达存储（FAIL）；修复后按名拒绝且零写入，setup API 形状与 enroll 候选兼容通过。全量 672 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；addAccount/updateAccount 对非法候选从静默接受变为拒绝（兼容变化）。T08 接 HTTP，T11 做 revision。next：T08（游标已更新） |
| T08 / review_pending | setup API 账户 POST/PUT 的 HTTP 层验收：非法候选 400 且存储字节不变（写入前拒绝）、未知请求字段不入存储、SEC-01 会话门 403 保持、合法注册端到端通过 | `fix/t08-http-candidate-gate` @ `2ca230c`，[PR #13](https://github.com/ertutio/mail-agent-mcp/pull/13)，父PR #12（堆叠 T07→T08） | 用 main manager 跑同一测试：非法候选被持久化、PUT 改变存储（FAIL，4 例）；用 T07 接线后 5 例全过（真实 manager+临时配置+真实 HTTP）。全量 677 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；纯测试变更无行为改动。next：T16 独立提前（游标已更新），T09 排 #12→#13 链后 |
| T16 / review_pending | CLI 注册（qq/gmail/netease 全系）注入登录验证：dependencies.authenticateOnly 或真实 ImapService 登录；失败走 persist 回滚，零持久、不报 enrolled | `fix/t16-cli-enroll-verify` @ `2b9f371`，[PR #14](https://github.com/ertutio/mail-agent-mcp/pull/14)，独立基线 main@96f8864 | 反例（真实临时配置目录+注入 mock）：修复前验证从未被调用、坏凭据仍报 enrolled（FAIL）；修复后验证调用一次、失败回滚（vault delete、无存储文件）、成功恰好提交一个账户。netease-cli fixture 同步注入 mock 验证并按后端布尔契约建模。全量 665 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；行为变化（安全收紧）：CLI 注册错误授权码即失败回滚。真实服务商登录 NOT RUN。next：T19 独立（游标已更新），T09 排 #12→#13 链后 |
| T19 / review_pending | OAuth body 纳入截止与预算：loopback token timer 覆盖 body 全消费（成功/错误），readBoundedJson 64KB 流式预算（OAuthBodyBudgetError 即时中断）；refresh 保持整调用 timer 并接入预算 | `fix/t19-oauth-body-budgets` @ `27ea25d`，[PR #15](https://github.com/ertutio/mail-agent-mcp/pull/15)，独立基线 main@96f8864 | 反例（真实流式 Response+注入 fetch，drip mock 遵约 signal 以 AbortError 切断）：修复前 drip-fed 成功/错误 body 拖过截止（4s harness 截止，FAIL）、2MB body 被接受；修复后按截止报 timed out、错误按状态码、超限显式预算错误。全量 667 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；新增错误信息 "OAuth response body exceeded 65536 bytes"。真实 Google 端点 NOT RUN。next：T18（游标已更新），T09 排 #12→#13 链后 |
| T18 / review_pending | /api/test-connection 的 disconnect 移入 finally；testConnection 的 logout 移入 finally 并带硬关回退；首错不被清理遮蔽，容忍性 STATUS 语义保持 | `fix/t18-owner-cleanup` @ `4426f06`，[PR #16](https://github.com/ertutio/mail-agent-mcp/pull/16)，独立基线 main@96f8864 | 反例：修复前 LIST/STATUS 失败跳过 logout、web 端 test-<id> 连接泄漏（FAIL，3 例）；修复后均结束连接、LIST 错误浮出、logout 失败回退硬关。全量 666 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；index shutdown 接线按计划先明确范围再接入，未捆绑。next：T28（游标已更新），T09 排 #12→#13 链后 |
| T28 / review_pending | 共享 search-input 校验：严格 YYYY-MM-DD+真实日历、since 严格早于 before、每 folder limit 1..5000；imap_search_emails/imap_bulk_delete_by_search/统一搜索三入口一致 | `fix/t28-search-input-validation` @ `36ec618`，[PR #17](https://github.com/ertutio/mail-agent-mcp/pull/17)，独立基线 main@96f8864 | 反例（5 例，断言 service 零调用）：修复前假日历/垃圾日期/无序范围/越界 limit 全部到达服务或静默空结果（FAIL）；修复后网络前拒绝且统一搜索测试经共享解析器保持绿色。全量 667 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；limit schema 新增 int/min/max 约束（正确性收紧）。UID 参数扩展另定范围。next：T31（游标已更新），T09 排 #12→#13 链后 |
| T31 / review_pending | 配置更新提取到 applyClaudeConfigUpdate：仅 ENOENT 初始化、坏 JSON/拒读保留原字节、候选形态校验、其他 mcpServers 保留、同名差异条目 y/N 确认、临时+rename 原子替换 | `fix/t31-config-safe-write` @ `a74901f`，[PR #18](https://github.com/ertutio/mail-agent-mcp/pull/18)，独立基线 main@96f8864 | tests/claude-config.test.ts 6 例（真实临时文件+注入 I/O 拒读）：全部固定新契约；旧行为（坏 JSON 被空对象覆盖，E10）经原实现逐行核对确认后由新路径消除。全量 668 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；setup 流程坏配置从静默替换变为失败+指引、同名新增确认（行为变化）。next：T32（游标已更新），T09 排 #12→#13 链后 |
| T32 / review_pending | setup 注册路径改为 resolveBundledServerPath(import.meta.url)（dist/setup.js 旁的 index.js），手动提示同步 | `fix/t32-install-paths` @ `96cb354`，[PR #19](https://github.com/ertutio/mail-agent-mcp/pull/19)，独立基线 main@96f8864 | tests/install-path-resolution.test.ts 3 例：模块相对解析（平台形状）+ 真实 stdio initialize 握手（OS 临时目录 cwd + 临时配置，~1.7s 应答）证明任意 cwd 隔离初始化。全量 665 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；从非根目录运行安装器时注册路径由错变对（行为变化）。T36 部署验收独立门控。next：T30（游标已更新），T09 排 #12→#13 链后 |
| T30 / review_pending | 两处 append 站点核实 outcome：Sent 未确认返回 saved:false+append_failed（调用方既有 warning 不重发），appendMessage 返回 false（草稿调用者既有判断抛错） | `fix/t30-append-result-contract` @ `68ff632`，[PR #20](https://github.com/ertutio/mail-agent-mcp/pull/20)，独立基线 main@96f8864 | 反例（6 例）：修复前 false/undefined 产生 saved:true/true（FAIL，4 例）；修复后报告未保存，确认结果回归通过。sent-save fixture 默认值改为真实库成功形态。全量 668 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；未确认 APPEND 不再报成功（正确性收紧）。真实服务器 false 可达条件 NOT RUN。next：T29（游标已更新），T09 排 #12→#13 链后 |
| T29 / review_pending | 新增 getFolderUnseenStatus（命名 STATUS unseen，缺失/畸形/失败→显式 unknownReason）；imap_get_unread_count 改为 STATUS 计数，unknown 文件夹排除出 totalUnread 并列入 unknownFolders + complete 标志 | `fix/t29-unread-semantics` @ `e77e0c7`，[PR #21](https://github.com/ertutio/mail-agent-mcp/pull/21)，独立基线 main@96f8864 | 反例（4 例 handler 级）：修复前驱动元数据搜索且失败记 0（FAIL）；修复后零 searchEmails 调用、12000 未读如实报告、失败文件夹显式 unknown。全量 666 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；byFolder 不再含 0 占位（附加 complete/unknownFolders）。真实服务器省略 UNSEEN NOT RUN。next：T22（游标已更新） |
| T22 / review_pending | sendEmail 冻结单一 MIME：composeRaw 字节经显式 envelope（to+cc+bcc）提交，同一 raw 归 Sent 副本；compose 失败整体失败；实证 raw 无 Bcc 头 | `fix/t22-frozen-mime` @ `8be6422`，[PR #22](https://github.com/ertutio/mail-agent-mcp/pull/22)，独立基线 main@96f8864 | 反例（3 例 mock transporter）：修复前 transport 收 mail options 无 raw、compose 失败静默跳过（FAIL）；修复后 raw 即提交字节且 messageId 锚定其 Message-ID，envelope 全覆盖而 raw 无密送地址，超限整体失败零调用。全量 665 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；compose 失败从静默跳过变为整体失败（行为变化）。T21/T23/T24 相邻独立。next：T24（游标已更新） |
| T24 / review_pending | 转发 HTML 视图镜像 text 视图：转义附言 + 转义转发头块 + 原始 htmlContent 原样（cid 保留）；无 HTML 原件不产 HTML 部分 | `fix/t24-forward-views` @ `6eb73f7`，[PR #23](https://github.com/ertutio/mail-agent-mcp/pull/23)，独立基线 main@96f8864 | 反例（5 例）：修复前 HTML 缺附言/头、hostile 无转义（FAIL，3 例）；修复后齐备且 <script> 转义、中文保留、cid 原样、纯文本原件无 HTML 部分。全量 667 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；HTML 视图内容变化（正确性收紧）。next：T09 或 T23（游标已更新） |
| T09 / review_pending | loadAccountsSync 载入校验（JSON数组+string id）与失效语义：任何失败先清空内存账户；ENOENT=空、其余错误读取显式拒绝；strict 写前拒绝保持原字节；构造容忍启动（浏览器 setup 恢复路径可用） | `fix/t09-store-load` @ `4b10e4b`，[PR #24](https://github.com/ertutio/mail-agent-mcp/pull/24)，父PR #13（堆叠 #12→#13→#24） | 反例（5 例 mocked fs）：修复前删存储后旧账户可见、损坏静默服务旧数据、addAccount 覆盖损坏字节、删除后新增复活旧记录（FAIL）；修复后全按契约。全量 682 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；损坏/拒读存储上的读取从静默变为显式错误（行为变化）。next：T23（游标已更新） |

每个子项保留：基线与修复SHA、具体用例/输入、缺陷前FAIL/修复后PASS、相邻回归、精确副作用/零副作用断言、命令或run URL、环境/fixture、报告位置、失败/跳过/缓存/未执行、接口/兼容变化。进度只放必要摘要，凭据、真实邮件和完整日志不入文档。

每个阻塞保留：所缺条件、累计失败次数与假设、已试结果、解除条件、谁需决定什么、可继续的独立项。PR待评审时继续就绪项；发生硬中断先保存未提交改动及运行检查状态，恢复后核对再续接。
