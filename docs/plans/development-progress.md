# Mail Agent MCP：进度与续接

执行规则及 T01–T37 完成标准见[总计划](development-roadmap.md)，证据要求见[验收约定](../acceptance.md)。保存点更新本文件，不再为每轮制造一份平行路线。

## 当前游标

北京时间 2026-10-31 夜至 2026-11-01 早。以下是今晚准备状态，尚未执行本队列；“ready”不是已修复或已验收。总任务保持 `in_progress`。

| 字段 | 当前记录 |
| --- | --- |
| 已接受代码基线 | `main@7467a0c68eecb0f1873166770e63eba8b2633255`；[PR #37](https://github.com/ertutio/mail-agent-mcp/pull/37) 已合并。开工先核远端后续提交，保留其他执行者的修改。 |
| 已验候选 / CI | `1bfc513545eebb934120af04e96f96cb1ad13ba7`；[run 41177399857](https://github.com/ertutio/mail-agent-mcp/actions/runs/41177399857) 的 Ubuntu Node22/24 所需步骤全通过；合并树与候选树相同。 |
| 本地证据 | 260 suites，875 PASS、0 FAIL、1 Windows 下 POSIX owner-permission 平台 skip；coverage statements 83.21%、branches 74.69%、functions 85.47%、lines 86.15%。合成 junction 测试使用当时获准环境完成，不能据此自动提升今晚权限。build/lint/secrets/diff/pack 与 high 阈值两类 audit 通过；生产 5 / 全量 10 moderate 受影响节点仍保留，不称零漏洞。 |
| 已关闭的旧队列 | 已审 24 个来源 PR 全部关闭，审计 head 均为 main 祖先；13 显示 merged、11 通过整合 PR 的关闭引用关闭，不能把后者写成 GitHub 逐 PR merged。不重做旧“14 项待合并”或 #29–#36。 |
| ,n�عL | ,�n:�h��vϰ
��ˡ�T25 l�� revision+UIDVALIDITY+per-fetch њ fail-closeda06f181	T17 �g/�e/��h store lock 2L + GateRejection Q�b7bfb6c	T20 �!��` transportverify ;S�U���T20R � createTransporter �n36226eb		/ head CI �coverage e �����Yh�c� PR comment |
| �Z next_action | 	* PR#40/#41/#42	head G+ round-5 ��ޔ� CII���y͌vT27PR #39		
n�n��(��G�'2�v T35 3��T33/T34/T36 ���� |
| 夜间交付状态 | 候选保持 `review_pending`，独立审计覆盖与运行结果齐全后供次日复核；不自动合并、部署、发布或真实邮箱验证。 |

## 今晚就绪队列

每个行为单元沿用[总计划执行循环](development-roadmap.md#持续执行循环)。一项目同时一个生产行为单元，允许对冻结候选独立只读审计；两个项目可并行。同一共享文件由一个执行者维护，不把文件冲突伪装成技术阻塞。

| 顺序 / 状态 | 工作与依赖 | 本次可检查的完成条件 |
| --- | --- | --- |
| 1 / ready：T27 发现失败续查 | T26 身份/范围契约已交付，先接通现有 cursor 表示，不另造不兼容分页协议。 | 初次 LIST/发现 throw、timeout、取消均明确区分；可恢复失败留下有界 continuation，续查可成功；重试/页数/时间预算有限且跨续页不重置成无限循环。保留账户来源、覆盖及 partial，成功账户不丢不重复从头搜；pending 范围、revision/UIDVALIDITY 与旧游标兼容按实际协议验证，已移除/改身份账户拒绝旧定位。服务恢复、持续失败和预算耗尽都有真实 handler/service 证据。 |
| 2 / ready：T25 附件 part 身份与一次物化 | 依赖已交付 T11，沿用实际 MIME 解析、附件根和冻结发送流程。 | 合成 MIME 同名不同字节、无名、顺序变化和 CID 不按第一同名误取；以稳定 part 身份定位并核对实际字节。账户 revision/UIDVALIDITY 变化拒绝旧定位；预览→确认沿用同一已物化字节，不二次下载替换。超限/失败/取消的暂存清理与附件根安全保持；不擅自扩大附件产品协议。 |
| 3 / ready：T17 凭据事务 | 依赖 T09/T11；先检查现有锁、revision、enrollment catch 与精确 vault target，不另起全库事务框架。 | repair/register/remove 在写前按实际跨进程协议重验 id/target/revision；网络等待有界，过期操作不能覆盖新成功或复活已移除秘密。受控双进程/现有等效锁层 gate 覆盖旧 repair 晚败、新 repair 成功、remove 交错与写盘失败；vault/内存/磁盘一致并保留当前回滚 catch 的耐久时点。只在隔离 fake vault/temp store 验证，真实 WinCred 不运行。 |
| 4 / blocked_by_T17：T20 剩余集成 | 当前 SMTP 每次重新取 auth/建 transport、提交边界 revision 已交付；T17 稳定后验其剩余部分。 | 不重写现有无缓存实现；验证配置轮换、同 target 凭据更新、OAuth 到期/刷新与并发在实际发送边界消费正确身份。旧失败不污染新凭据；只在明确零 SMTP 副作用时允许新预览，accepted/unknown 从不自动重发；每次 transport 只清自己的拥有物。 |
| 持续 / T35 | 每个共享接口稳定点，不等待全路线结束。 | 受影响定点/相邻测试后按 acceptance 完成必要本地 coverage、准确 SHA 的 Node22/24 CI 及质量门禁；复用有效证据，不每个小提交重跑整套。若环境/权限受限，准确标未执行并转独立工作。 |

本队列是优先级，只有真实技术前置才阻塞后继。T27 或 T25 卡住时，另一个可继续；T17 若涉及未确定的共享回滚协议，先保存决策问题，不让 T20 绕过它。当前项目没有独立就绪实现时，整理证据、补明确缺失测试或转另一项目；不制造新的范围来消耗额度。

## 保留门控与阻塞登记

| 范围 | 今晚状态 / 解除条件 |
| --- | --- |
| T33 扩展依赖维护 | `awaiting_human`；生产 5 / 全量 10 moderate 是本轮快照，实施时重查公告。原高危最小修复授权不扩为任意升级；不 audit fix、不降阈值。 |
| T34 fork 身份 | `awaiting_human`；维护者决定 npm/server namespace、署名及兼容策略后才统一改名。 |
| T36 实际部署 | `awaiting_human`；实际安装/进程/代表调用需候选与单独部署授权，普通夜间不替换安装、不重启 MCP、不操作真实邮箱或 WinCred。 |
| 同一卡点两次有效修正仍失败 | 保存问题 ID、两次假设/提交/真实结果，转独立高阶只读咨询；不可用则只阻塞此路径。咨询后一次定向修正仍失败，等待具体用户决定；计数跨代理/会话/夜晚保留。修复前预期 FAIL 与工具未执行断言单列，不算产品修正失败。 |

## 晨间交接模板（执行时填写）

当前各项均 `NOT_RUN`，不是已经发生的夜间成果。每完成单元维护一行；无待办决定时 next_action 写具体行为，而不是泛化“继续”。

| T / 断言与状态 | 分支 / exact SHA / PR 与父依赖 | 有效反例→修复结果、相邻/CI run、skip/cache | 独立审计范围 / 遗留 | 失败计数 / 回退 / next_action |
| --- | --- | --- | --- | --- |
| T27 / DONE（review_pending） | [fix/t27-discovery-resume](https://github.com/ertutio/mail-agent-mcp/tree/fix/t27-discovery-resume) @ `52dfc6cdcb2d95af1c3a5938681ae7e25989e920`；PR #39。基础 a6bc690（pass 计数）+ 99b6365/52dfc6c（T27E/T27G 证据）。 | 反例：持续失败的 listFolders 驱动链式 cursor 续查无限重试 → 修复：cursor 内 `pass` 计数 + `MAX_SEARCH_PASSES=5`，超限在联网前抛预算耗尽。T27G 经真实 handler 断言计数逐 pass 递增并终止。分支全套 87 files / 886 passed + 1 skip；[CI run 41212467560](https://github.com/ertutio/mail-agent-mcp/actions/runs/41212467560) Node22/24 绿。 | 已独立审计：cursor schema 的 pass 字段兼容旧游标（缺省 0，可续一次后被界住）、预算错误在 listFolders 之前抛出、账户发现失败/timeout/取消三态区分回归保留。遗留：pass 上限 5 为固定常量，不可配置（有意保守）。 | 0 次有效修正失败；无回退。next_action：等待维护者按 PR #39 comment 重验合并；合并后 T35 复用其 CI 证据。 |
| T25 / DONEreview_pending	 | [fix/t25-attachment-part-identity](https://github.com/ertutio/mail-agent-mcp/tree/fix/t25-attachment-part-identity) @ `a06f181`718fc44 {�� + a06f181 ��eQ	PR #4092cd61b��� partIndex	� 67fb6edrevision/UIDVALIDITY њ	� 718fc44 � a06f181 | ͋l�+$* report.pdf ���$�W�l��  undefined �� UIDVALIDITY/revision � �EmailContent :&��� uidValiditymaterializeOriginalAttachments �L8� revision + �!��(��;S revision + fail-closedUIDVALIDITY :1s��	E2E� ImapService�MIME	��/UIDVALIDITY ���/������L=0��� per-fetch ��U�	/confirm �}892 testscoverage 83.36/74.91/85.64/86.27[CI run 41221488469](https://github.com/ertutio/mail-agent-mcp/actions/runs/41221488469) � | �ˡ�PASSH1/H2 ���Y�c	+CID �.��92cd61b M�		STATUS H� fetchOne �z�*�O}�w uidValidity e����H re-list �� | 0 !	H�c1%�� next_actionI���	 PR #40 round-5 comment ͌v |
| T17 / DONEreview_pending	 | [fix/t17-repair-transactions](https://github.com/ertutio/mail-agent-mcp/tree/fix/t17-repair-transactions) @ `b7bfb6c`2919e79 ��eQ + b7bfb6c scanner ��	PR #4133bbe9drollback CAS	� fac4d24store lock O	� 2919e79 � b7bfb6c | ͋remove �Z%� A ;� ���:�	� �writeGuard 4L:8� id/target/revision	+ �g��h�e � + CredentialGateRejection :R^���E���	' major�g��/��/<R^	G1 T17L-NEWER-REPAIR-BEFORE-GUARDEQUAL-VALUE-NEWER-REPAIR�� RED	GMAIL-REMOVE-WINSgmail �*�lK�	�O888 testscoverage 83.37/74.91/85.45/86.26[CI run 41221946993](https://github.com/ertutio/mail-agent-mcp/actions/runs/41221946993) � | �ˡ�PASS-WITH-RESERVATIONS � 	 major ���Y�c	��� 5s �P1%:ڞ CredentialRollbackError	revision ABA �UUID+���	enrollment �Q� verify�	�('^'	 | 0 !	H�c1%�� next_actionI���	 PR #41 round-5 comment ͌v |
| T20 / DONEreview_pending	 | [fix/t20-smtp-revision](https://github.com/ertutio/mail-agent-mcp/tree/fix/t20-smtp-revision) @ `36226eb`160bc63 $ bug � + 36226eb �� H1a	PR #42 | ͋revision �s�(�� transportrevision pre-await �U�H� A Z0�{�� B �vФ � ��d close ���!��`v( finally �>	+ verify ��U + ;S&7�U�gsetAccountManager ��	T20R p� createTransporterŧ6 transport/auth	INFLIGHT-NOT-CLOSED/STALE-AUTH-ABORTS ( dd096377 � REDSTALE-SNAPSHOT-LATE-ENTRY ( 160bc63 REDmessageIdOf *�I(ReferenceError � unknown	� service �V�d880 testscoverage 83.28/74.85/85.34/86.19[CI run 41220630214](https://github.com/ertutio/mail-agent-mcp/actions/runs/41220630214) � | �ˡ�APPROVEH1a ���Y�c	disconnect/verifySmtpConnection �\(���(�	composeRaw ��1 safe-send checkRevision ��y��H�$B�� | 0 !	H�c1%�� next_actionI���	 PR #42 round-5 comment ͌v |

结束或硬中断时另列：未提交文件及所有者、运行中 CI/进程和恢复方式、计划 ref/head、最后一个冻结候选、所有 blocker 的精确解除条件。已验待复核、未验证、阻塞分开；测试原始日志保留在无秘密的可追溯位置，不把环境错误、skip 或静态审计写成 PASS。

## 历史记录（以下均非当前执行游标）

下文完整保留 2026-10-17 至 10-31 补修前后的当时快照。其旧 next_action、待合并数量、静态缺陷判断、moderate 数量和初始队列均已由本文件上方当前游标覆盖；用于追踪原断言，不再指挥今晚从 T07 或旧 PR 链重新实施。

<a id="2026-10-31-补修轮14-个暂缓-pr-全部处理"></a>

## 历史：2026-10-31 补修轮（14 个暂缓 PR 全部处理）

全部 14 个暂缓 PR 已 rebase 至 main@0e3c47b（含 T02/T03/T04/T06/T30/T31/T32 集成与依赖修复），按夜间续接表逐项补修并 force-with-lease 推回原分支；每项均含针对评审条件的新反例（先 FAIL 后 PASS）与全量本地门禁。每分支全量 697–720 passed / 1 skipped（claude-config 单次 Windows 临时目录 flake 隔离重跑通过，历史已记录）。

| 顺序 / PR / T | 补修内容 / 新增用例 |
| --- | --- |
| #12 / T07 | SMTP 子候选同契约（null 拒绝、secure 默认 true、port 465/587 派生）；name/host/user/email/sentFolder 修剪进持久化与返回值；返回值改为「解密后的落盘记录」；存储密文不再按明文预算重校验（T07R 6 例） |
| #13 / T08 | rebase 到补修后父链；T08R-LEGAL-NORMALIZED：未修剪合法候选经真实 HTTP 落盘为规范化值（6 例） |
| #24 / T09 | rebase 到补修后父链；契约不变（ENOENT 清空/损坏拒读显式失败/不复活），T09 5 例在新链重跑通过 |
| #5 / T01 | STATUS 与旗标快照改到同一锁内（getFolderStatusSnapshot），folder_status 不再混两时点；T01R-CONSISTENT-SNAPSHOT（交错中 UIDVALIDITY/计数/flags 突变后全字段一致）+ T01R-READ-FAIL-RELEASES-LOCK；mock 补 capabilities 兼容已合并 T03/T04 门禁 |
| #9 / T05 | 非 Trash 单条 MOVE false/undefined 拒绝（回归钉住）；分块部分 uidMap 只计确认 UIDs（T05R 4 例）；分块 fixture 修正 |
| #10 / T37 | addressDomain 取最后一个尖括号 token——显示名 decoy（`"Bob <decoy@…>" <real@…>`）不再误选（T37R-DECOY-DISPLAY-NAME） |
| #17 / T28 | 空串作为已提供日期被三入口网络前拒绝（`!== undefined` 语义，T28R 2 例）；与已合并 T06 的 import 冲突解决 |
| #16 / T18 | disconnect 的 logout 失败回退硬 close；T18R-DOUBLE-FAIL-CLOSE（LIST+logout 双失败仍硬关、首错保留）+ T18R-DISCONNECT-CLOSE；mock 绑定 close |
| #21 / T29 | 连接/认证失败不再中止整个 sweep：该 folder 记 unknown、已取得计数保留（T29R-CONNECTION-FAIL-KEEPS-COUNTS）；ensureConnected 移入逐 folder catch |
| #22 / T22 | T22R-REAL-STREAM：真实 nodemailer streamTransport（无网络）验证冻结 raw 逐字节提交（LF 改写归一化后）、Message-ID 一致、envelope 全覆盖、raw 无 Bcc |
| #25 / T23 | T23R-REAL-MIME：真实 mailparser 解析合成 MIME（Reply-To+2To+2Cc）后 reply-all 展开正确、排自身、去重、线程头保持 |
| #23 / T24 | T24R-REAL-HTML-ONLY：真实 mailparser HTML-only MIME 双视图均含附言/头/原正文，cid 保留；mock 建模服务侧 html→markdown 文本转换 |
| #14 / T16 | T16R-NETEASE-FAIL-ROLLBACK + T16R-GMAIL-FAIL-ROLLBACK：两入口验证失败同样 vault 回滚、零持久、不报 enrolled；gmail enroll 路径补 runGmailOAuth 注入缝 |
| #15 / T19 | T19R-REFRESH-BODY-DEADLINE：refresh 路径 drip body 滴流同样受总 deadline 约束（AbortError 映射为 timed out，不再伪装 invalid JSON） |

<a id="2026-10-30-夜间续接"></a>

## 历史：2026-10-30 夜间续接

[PR #26](https://github.com/ertutio/mail-agent-mcp/pull/26) 已合并至远端 main `0560ade2202f6fb49f23ee20b149d4b16ef075a7`，9 项通过范围已交付；高危 audit 已清，仍有生产 5 / 全量 8 moderate。源码 CI [41012567518](https://github.com/ertutio/mail-agent-mcp/actions/runs/41012567518) 和最终 CI [41013455268](https://github.com/ertutio/mail-agent-mcp/actions/runs/41013455268) 的 Node22/24 全门禁均 PASS。以下分类是本次审查快照，不是后续修复已执行：8 FAIL、4 PARTIAL、2 BLOCKED。历史证据、失败修正计数与下方逐项证据继续保留。

开始前核对远端 main 实际 SHA、工作区 dirty 状态、现有分支与代理/文件所有权。记录时本地 main/tracking 仍为 `96f8864fa5fb88d0d28e921ced7b8e8ad644d7ca`，Git 443 不可达；候选 `e14f8c0` 的 tree 与合并后 main 一致，但 commit 不等同。优先正常 fetch；不可达时用 GitHub API 严格核对 main commit、tree 与 parent，并确保工作基线真实对应远端；不可从旧 main 开工，也不可强制 reset 或覆盖他人改动。若无法建立可靠基线，保留现场并报告。

| 顺序 / PR / T / 当前分类 | 通过条件（先以当前源码和历史记录定位入口及测试） |
| --- | --- |
| 第一批 #12 / T07 / FAIL | SMTP 缺字段/null/default 合同一致，验证后的规范化候选实际持久化且返回与磁盘一致；非法 add/update 零写。 |
| 第一批 #13 / T08 / BLOCKED | 接通已修 T07，真实 manager + 临时配置的 HTTP POST/PUT 非法候选 400 且存储字节不变，合法路径与 SEC-01 会话门回归。 |
| 第一批 #24 / T09 / BLOCKED | 接通已修父链；ENOENT 清空且不复活，损坏/拒读明确失败并保持原字节，恢复后可读。 |
| 第二批 #5 / T01 / PARTIAL | 受控交错改变 UIDVALIDITY、计数和 flags，folder_status 返回同一稳定快照；read/flags/move/delete 锁及失败释放回归。 |
| 第二批 #9 / T05 / FAIL | 非 Trash 单条 MOVE false/undefined 和分块部分 uidMap 不虚报完成；确认、未知、异常及进度计数对应实际副作用。 |
| 第二批 #10 / T37 / FAIL | 显示名 `<decoy@example.test>` 与真实异域地址不可误选；结构化地址的精确域/相似域/子域反例，预览和冻结集合一致且确认不重搜。 |
| 独立 #17 / T28 / FAIL | 空串作为已提供日期被三入口在网络前拒绝；合法日期、范围、limit 与搜索/删除回归。 |
| 独立 #16 / T18 / FAIL | LIST 与 logout 双失败时真实 close 被调用、首错保留；stop 与其他拥有者清理回归。 |
| 独立 #21 / T29 / FAIL | 一夹成功后连接/认证失败时保留已取得计数并标 unknown、complete:false；大邮箱与缺失 STATUS 回归。 |
| 邮件 #22 / T22 / FAIL | 真实 Nodemailer streamTransport、无网络：返回 ID、冻结 raw 头与 Sent 副本一致，To/Cc/Bcc envelope 正确且 raw 无 Bcc；compose 失败零发送。 |
| 邮件 #25 / T23 / FAIL | 真实 mailparser MIME 的结构化 Reply-To/To/Cc 展开；reply-all 不漏人、排自身、去重，线程头及回退保持。 |
| 邮件 #23 / T24 / PARTIAL | 真实 HTML-only MIME 转发的 text/HTML 两视图均含原正文、附言和头；转义、中文及 CID 回归。 |
| 补证 #14 / T16 / PARTIAL | 网易和 Gmail 新注册认证失败分别用合成数据验证 vault 回滚及账户零写；QQ 和成功路径回归。 |
| 补证 #15 / T19 / PARTIAL | refresh headers 到达后成功/错误 body 的 AbortSignal 滴流受同一总 deadline 约束；字节预算、loopback 与 refresh 既有回归。 |

第一批按 #12→#13→#24 的父链推进；可显式记录堆叠并继续开发，不因等待父 PR 合并停工，但未通过的祖先不得随子项进入 main。第二批按 T01→T05→T37 推进；独立 ready 项可并行或在依赖等待时推进，邮件与补证各按实际依赖和文件所有权安排。定位入口与既有测试先查下方历史条目、`docs/acceptance.md` 和当前源码；历史测试通过不代表以上新增断言已运行。

执行每项：受控反例 FAIL → 最小修复 → 定点 PASS 与相邻回归 → 记录确切 SHA、用例、结果和未测项并保存/开 PR → 继续下一 ready 项。复用仍适用的成功证据，仅相关源码、依赖、配置、环境或输入变化时重跑受影响检查；稳定集成按验收约定执行。只用 mock、localhost、隔离临时配置和合成数据。14 项解除后继续原 T01–T37 队列中的 ready 工作；T33 扩展维护、T34 身份及 T36 部署保留原门控。提交/推送/开 PR 以用户给执行者的启动指令及已有授权为准；本文不新增合并、部署、npm 发布或真实邮箱授权。

<a id="2026-10-30-依赖修复与合并续接"></a>

## 历史：2026-10-30 依赖修复与合并续接

维护者本轮明确授权使用 Terra 修复上一轮依赖阻断并在验收通过后合并候选 PR #26；T33 开发依赖排除仅在本次高危修复所需范围解除。不扩大到暂缓的 14 个功能 PR，T34/T36 和真实邮箱、部署、发布边界保留。以下记录本轮实际验收证据；最终 CI 与合并结果见上方夜间续接，历史记录保留。

| 项目 | 当前结果 |
| --- | --- |
| 修复基线 | PR #26 / `a5653ca4b3e8623be4c03c4961e919a58eefb091`；上一轮 Node22/24 CI [41008759422](https://github.com/ertutio/mail-agent-mcp/actions/runs/41008759422) 测试、构建等通过，生产 audit 失败，全量 audit/pack 跳过。 |
| 依赖修复 | `PASS（高危审计）`：Terra 更新 body-parser 2.3.0→2.4.0、undici 7.30.0→7.30.1、zod 4.4.3→4.6.7；间接 Vite 8.1.4→8.3.5，连同其 rolldown/lightningcss 开发链更新。生产与全量 audit 均 exit 0、0 high / 0 critical，分别保留 5 / 8 moderate；不降低 high 门禁，也不将中危记为已修。 |
| 兼容性与复用 | 官方 npm 包元数据与锁文件：body-parser 要求 Node>=18，undici>=20.18.1，Vite/rolldown 要求 ^20.19.0 或 >=22.12.0；Zod 未声明 Node 引擎。所选版本声明兼容项目最低 Node22.12；主要包 MIT，开发间接 Lightning CSS MPL-2.0。升级沿用既有依赖和接口，未新增运行时模型请求。schema、web JSON、代理 OAuth fetch 与测试工具链由完整回归验证，声明兼容不代替最低版本实测。 |
| 本地验证 | 从 lock 执行 npm ci 成功且安装前后 lock SHA256 相同；build、完整 coverage、lint、secrets（192 files）、pack dry-run 通过。693 passed / 1 skipped tests；Lines 82.24%、Branches 70.56%。普通沙箱因 node_modules mkdir、junction/symlink 的 EPERM 未完成检查，使用工作区 TEMP/TMP 及必要权限后完整通过；未跳过目标断言。两项 high audit 的同版本成功证据复用。 |
| 格式检查 | 原索引的两个 package 文件均为全 CRLF，新行被普通 git diff --check 报 trailing whitespace；仅统一为 LF 保持 JSON 解析值不变，普通 git diff --check 已补查通过。该规范化会增加文本差异行数，依赖实际变化以上表为准。 |
| 新 CI / 合并 | `PASS（源码门禁）`：[run 41012567518](https://github.com/ertutio/mail-agent-mcp/actions/runs/41012567518)，head `3ea1a9b466d5ce6bbcc996c5f855bb297288f34e`，Node22/24 的安装、测试、构建、产物、lint、diff、secrets、生产 audit、全量 audit、pack 全部 success，无所需步骤跳过。此后仅补本文与路线图；最终文档 head 的 Node22/24 全门禁 [run 41013455268](https://github.com/ertutio/mail-agent-mcp/actions/runs/41013455268) PASS，PR #26 已合并。最低 Node22.12、WinCred 和真实服务商未在本轮验证，T36 保持独立。 |

<a id="2026-10-30-集中验收"></a>

## 历史：2026-10-30 集中验收

以下保留上一轮依赖修复前的验收快照；当前依赖与合并状态以上方续接记录为准。

本轮审查每个 PR 相对其真实 base 的差异。#3 的历史分析保留，#4 的持续计划为当前入口；#18/#19 的 setup 冲突同时保留安全原子更新和模块相对路径。合并范围与尚未通过的 T 编号分开记录，不因 PR 已提交而改写为完成。

| 范围 | 本轮状态 / 证据 |
| --- | --- |
| 集成候选 | `BLOCKED（T35）`：源码候选 `0ba339e80227335f8d9b9920ee512ffa57985097` 包含 #3、#4、#6、#7、#8、#11、#18、#19、#20；共 9 项候选、14 项暂缓。生产/全量 audit 未通过，尚未合并 main。#7→#8 保留原堆叠关系；其余阻断分支不纳入候选祖先。 |
| 本地质量门禁 | 源码 `0ba339e80227335f8d9b9920ee512ffa57985097`：build、lint、release secrets（192 files）、working/origin-main diff-check、pack dry-run（13 files）通过；最终 coverage exit 0：71 passed / 1 skipped files，693 passed / 1 skipped tests。Statements 79.40% (2837/3573)、Branches 70.56% (1949/2762)、Functions 82.00% (492/600)、Lines 82.24% (2524/3069)。 |
| 验证环境与复用 | 首次 Vite 缓存因系统 TEMP rename EPERM 未执行测试，改用 workspace TEMP/TMP。随后三条 attachment-root junction 用例在沙箱受 EPERM 阻止，提升权限定点重跑 10/10；最终 coverage 在可写临时目录和必要权限下完整执行。移除 #22 后 SMTP 28/28 与 build 重跑；其余无关证据复用。临时环境失败未作为产品失败，也未用跳过替代目标断言。 |
| T32 安装路径补证 | `PASS（隔离握手）`：真实构建 dist/index.js 从临时任意 cwd、新建 IMAP_MCP_CONFIG_DIR 成功 initialize，protocol 2024-11-05、serverInfo mail-agent-mcp 0.1.1；仅生成测试 .key，无账户。结束时未收到 shutdown 响应；探针已终止子进程，此项只验证 initialize。 |
| 依赖审计 | `FAIL`：生产 8 个受影响包节点（5 moderate / 3 high），undici 7.30.0、zod 4.4.3 含高危（公告范围分别 7.0.0–7.30.0、<4.6.6）；全量 12 个（8 moderate / 4 high），另含 Vite 8.1.4 开发链高危（范围 8.0.0–8.1.5）。普通 fixAvailable 不能充当修复后证据；Nodemailer 的 moderate 建议 force 到 10.3.1，超出当前声明范围，未执行。两个 package 文件相对 main 未变，但既有缺陷仍是门禁失败。 |
| 公告定位 | [undici GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685)、[zod GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)、[Vite GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) 为当前 audit 中的代表定位，非完整公告数；完整输出和可达性须随依赖修复复核，不能把受影响包节点数当作独立漏洞数。 |
| CI | `FAIL（首轮）`：[run 41007167287](https://github.com/ertutio/mail-agent-mcp/actions/runs/41007167287)，精确 SHA e84d085307e105a100bd95f2d7fe6d89ed9fb4ae；Ubuntu Node22/24 均在 install-path-resolution.test.ts 的固定 Windows 路径断言失败，后续 build/lint/audit/pack 被跳过，不能拿本地成功代替。 |
| CI 夹具补正 | 只将 tests/install-path-resolution.test.ts 的 C:/synth 固定路径改为当前平台的绝对 distDir，经 pathToFileURL 生成模块 URL，并完整断言同目录 index.js；不跳过 Linux、不改业务源码或依赖。本地定点及补正后准确 SHA 的 Node22/24 CI 结果附[候选 PR #26](https://github.com/ertutio/mail-agent-mcp/pull/26)，旧失败保留。生产代码仍为上述 0ba339e，其他有效证据复用。 |
| 独立审计 | `PASS（读取覆盖）`：未参与实现的 DeepSeek 只读审计 review/read、仅 Read、空写入清单；21 个 PR 差异的 35 块均实际读取且无失败，审计 session `1824a5e0-4e3a-4bac-ae48-606576364c09`。报告不是产品测试，所提问题逐项核源码；rev2 capability 大小写疑虑被当前 imapflow/lib/tools.js 的特殊归一化规则推翻，未采纳。 |
| 成本边界 | 外部审计耗时 144.125 秒；CLI 报告 USD 1.63894（costBasis=unknown，未核对实际账单），input 129076 / output 23320 / cache-read 821120 tokens。Codex 开发协作费用未知；产品运行时未新增模型请求。 |
| 安全删除集成 | `PARTIAL`：T03/T04 能力门禁可独立审查；T01/T05 未完整通过，不能宣称 C0 联合安全删除验收关闭。 |
| 运行与发布 | `NOT_RUN`：没有替换现有安装、重启 MCP、真实邮箱/WinCred 操作或 npm/MCP Registry 发布。T36 保留独立验收。 |

| 暂缓 PR / T | 具体原因、证据及解除条件 |
| --- | --- |
| #5 / T01 | `PARTIAL`：SELECT 锁旁路已修正，但 folder_status 仍先 STATUS 后单独 SELECT，counts 与 flags 可来自不同时点；与总计划稳定状态要求不符。合成 gate 在两次读取间改变 UIDVALIDITY/计数/flags，验证最终快照一致并保留 read/flags/move/delete 锁回归后重验。 |
| #9 / T05 | `FAIL`：deleteEmail 非 Trash 分支仍丢弃 messageMove 的 false/undefined；bulkDelete 收到仅覆盖部分 UID 的 truthy uidMap 仍计整个 chunk。补单条 MOVE 未确认与分块部分确认反例，未知结果不冒充完成、不提示安全重试。 |
| #10 / T37 | `FAIL`：正则取第一个尖括号地址，显示名 `Offer <decoy@example.test>`、实际地址 `actual@other.test` 被格式化后错误命中 example.test。实际 spamTools+guardedDeletion 合成探针冻结 UID [77]，证明误选；改用结构化地址/可靠解析后验证精确集合、预览与确认不重搜。 |
| #12 / T07 | `FAIL`：validateSmtp 对缺 port/secure 返回 undefined（非空断言只影响 TS）；updateAccount 验证候选后仍持久化原始 updates。补缺字段/null/默认值持久化及零写断言。 |
| #13 / T08、#24 / T09 | `BLOCKED`：分别堆叠在 #12、#13 上；各自差异未发现同等级确定缺陷，但不能为合入后代而带入未通过的 T07。修正父分支并复验 HTTP gate/存储加载。 |
| #14 / T16 | `PARTIAL / NOT_RUN`：QQ 新注册验证失败回滚有测试；网易/Gmail 新注册认证失败时 vault 回滚、账户零写尚无当前证据，Gmail repair 不替代新注册。源码未发现确定回归；补两 provider 的合成失败路径后重验，不以真实登录补普通开发证据。 |
| #15 / T19 | `PARTIAL / NOT_RUN`：loopback 成功/错误滴流截止、refresh 请求超时及两种 body 字节上限已有测试；refresh headers 到达后成功/错误 body 的总截止未覆盖。补 AbortSignal 约束的滴流金样，断言同一 deadline 包含完整 body 后重验。 |
| #16 / T18 | `FAIL`：Web finally 调 disconnect，而 disconnect 在 logout 抛错后只删除连接 map、不调用 close；LIST 错误虽保留，socket 可能泄漏。补 LIST+logout 双失败真实 close 断言及 stop 拥有者清理。 |
| #17 / T28 | `FAIL`：三入口 truthy 日期判断使已提供的空字符串跳过解析，日期范围可能变宽；显式 !== undefined 检查并验证搜索/删除网络前拒绝。 |
| #21 / T29 | `FAIL`：getFolderUnseenStatus 的 ensureConnected 位于 try 外，重连/认证失败使整次统计抛错，丢失已取得的部分结果；覆盖成功一夹后重连失败并返回 unknown/complete:false。 |
| #22 / T22 | `FAIL`：真实 SmtpService.sendEmail + Nodemailer 10.1.0 streamTransport（buffer:true，无网络）得到 info.messageId/服务返回 ID 与冻结 raw 及 transport 邮件头 ID 不一致；mock 自行从 raw 构造返回值掩盖此差异。Envelope 五个 To/Cc/Bcc 地址齐全且 raw 无 Bcc；探针 newline:unix 仅使 CRLF→LF，归一后字节相等，不作为生产字节漂移证据。明确设置冻结 Message-ID 或从冻结 MIME 返回真实 ID，并用真实 transport 断言返回/头/Sent 一致后重验。 |
| #23 / T24 | `PARTIAL`：新增 HTML 转义与附言有效，但原 HTML-only 邮件的 text 视图仍无原正文；属于既有问题，仍未满足 T24 明确金样要求。用真实 HTML-only MIME 检查两视图正文/附言/头完整；CID 字符串保持不等于 T25 part 端到端通过。 |
| #25 / T23 | `FAIL`：mailparser 的 AddressObject.text 通常把多人拼成一个字符串；extractEmail 只识别第一个地址，自己在首位时整组被丢弃，否则可能保留自己/重复。应由结构化 value 扁平化真实 Reply-To/To/Cc，并用真实 MIME 验证不漏人/排自身/去重。 |

本轮没有对上述阻断尝试产品修正，失败修正计数为 0；现有 PR 的反例与修复记录另行保留，不因这次审查重置已有排障历史。

<a id="已交付与证据边界"></a>

## 历史：已交付与证据边界

- PR #1/#2 已合并。原 SA-08 跨账户分页、SEC-01 `/api` 保护已修复：保留回归，不再排待修；T26/T27 与 T08 修改时复用/补验其相邻断言。
- 当前代码已有 Gmail OAuth、QQ/Windows Credential Manager、安全附件根、账号选择、发送/回复/转发预览及 literal `confirmed:true` 的 imap_confirm_send。旧直接发信工具不注册，继续保留现有安全边界。
- safe-send 已有进程内 pending/sending/sent/ambiguous/expired、TTL、活动草稿与附件上限，进程内并发/重复确认保护；执行异常进入 ambiguous，不自动重试。它不证明人类在场、不提供跨进程持久幂等，也不等于账户/凭据revision绑定已完成。
- 已冻结 accountId 和邮件内容/附件字节，不等于冻结执行时同ID账户的身份/端点/发送策略。T11–T13 仍需完成；游标N-02/T26、APPEND N-03/T30不能由预览状态或Sent warning替代。
- SMTP接受、Sent保存和最终投递是不同事实；T21/T22/T30分别验收。普通开发不得真实发信来填证据。
- 原路线的 662 通过/1 跳过、81.93% coverage 是 2026-10-17 同源码tree的历史结果，本计划未重跑；历史全量audit失败也不是当前查询，更不能写零漏洞。保存原开发依赖排除，T33未经解除不自动修复/升级。
- 历史磁盘overlay/注册/版本号不证明当前进程加载版本或本轮MCP调用成功。T36仍待独立授权和实际运行证据。

<a id="初始就绪队列"></a>

## 历史：初始就绪队列

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

<a id="范围与验证缺口"></a>

## 历史：范围与验证缺口

| 项 | 当前结论 / 下一步 |
| --- | --- |
| N-01 | 预览revision契约未由进程内草稿状态解决；发送有历史mock证据，删除同ID/相同UIDVALIDITY是条件风险。接入T11–T13，不重复计为另一SA-01修复。 |
| N-02 | 游标账户/版本/范围绑定为T26独立契约；T27有限恢复不能替代它。 |
| N-03 | APPEND false的草稿与Sent语义在T30核对；不把历史mock当真实服务商时序复现。 |
| V-01/V-02 | 当前运行进程、实际MCP调用、服务商差异、WinCred、最低Node和跨平台等按变更列待验证；mock/Ubuntu CI不能充当这些证据。 |
| R1–R5/F1–F8 | 按总计划原表保留风险/延期；可信审批、跨平台vault、全文索引、新provider等不自动扩入实现。 |

<a id="历史提交回执不代表本轮验收"></a>

## 历史：历史提交回执（不代表本轮验收）

以下保留各实现 PR 提交时的原始回执与当时游标。当前状态以上方 2026-10-30 集中验收为准，历史 PASS/test 数字不覆盖本轮 FAIL、BLOCKED 或 NOT_RUN。

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
| T23 / review_pending | EmailContent 增 cc；reply 处理器 Reply-To 优先、reply-all 覆盖 Reply-To+To+Cc（排自身/按裸地址去重、显示名保留）、线程头不变 | `fix/t23-reply-addresses` @ `2b8548c`，[PR #25](https://github.com/ertutio/mail-agent-mcp/pull/25)，独立基线 main@96f8864 | 反例（5 例 composer 结构断言）：修复前 Reply-To 被忽略、reply-all 漏 Cc（FAIL，2 例）；修复后全按契约，无 Reply-To 回退/去重/线程头回归通过。全量 667 passed/1 skipped；lint/build/check:secrets/diff --check 通过 | 评审等待中；带 Reply-To 的消息回复地址变化（正确性收紧）。next：T25（游标已更新） |

每个子项保留：基线与修复SHA、具体用例/输入、缺陷前FAIL/修复后PASS、相邻回归、精确副作用/零副作用断言、命令或run URL、环境/fixture、报告位置、失败/跳过/缓存/未执行、接口/兼容变化。进度只放必要摘要，凭据、真实邮件和完整日志不入文档。

每个阻塞保留：所缺条件、累计失败次数与假设、已试结果、解除条件、谁需决定什么、可继续的独立项。PR待评审时继续就绪项；发生硬中断先保存未提交改动及运行检查状态，恢复后核对再续接。
