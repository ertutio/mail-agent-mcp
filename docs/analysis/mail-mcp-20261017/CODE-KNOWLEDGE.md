# 面向 agent 的行为证据

所有 `src/...:行号` 指向固定副本 `work/mail-agent-understand-20261017`，版本 `524e1b34c89ebe2834a27b948371227f142d346d`；对应Git tree与公开 main `96f8864...` 一致。Windows archive部分文本为CRLF，校验逐文件确认原字节或CRLF→LF后匹配Git blob，行号不受影响。部署文件/进程使用独立证据表，不能用这里的行号推断内存版本。

143 个文件均分类；41 个生产 TypeScript 模块均有职责、内部依赖及阅读深度。确定性工具输出：140 文件有结构结果，0 个不可读；`install.ps1`、CSS、HTML 无可用结构解析器，已读源码补充角色，不伪造 AST。211 条内部 import；架构分 13 层。机器图谱当前 237 节点、321 边；显著顶层函数/类来自插件解析器，类内方法名保留在类节点。

**阅读深度**：大文件按关键行为段人工追踪，其他模块可能仅结构/表面阅读；精确范围见 `knowledge/coverage.json`。测试标题/导入索引证明测试存在，不证明断言覆盖目标，也不证明本轮执行。原始 `callGraph` 是语法调用表达式，未进行全程序绑定；图中手工 `calls` 是已读的选定文件级调用，完整方法调用解析未完成。图结构校验不代表业务行为正确。

## E01：MCP 暴露与输入

入口 `src/index.ts:26-53` 创建 `McpServer`、resolver/服务，`src/tools/index.ts:136-180 registerTools` 组装工具。先经过 `createFilteredServer:111-133`，白名单优先于只读开关，直接 send/reply/forward 始终被封禁；再通过 `guardedDeletion` 包装 email/spam 的五个删除入口。accountTools 只有 list/connect/disconnect/test，没有账户写入 MCP handler。

核心：SDK `registerTool` 接受 Zod schema，handler 解析账户名/ID后调用 service，最后返回 JSON 文本；异常可能直接抛给 SDK，某些 handler 自带 success/partial，二者不可当成统一错误契约。很多旧测试直接调用 handler 绕过 schema；新输入回归至少各做一次 schema/SDK 边界检查。

副作用边界：删除 preview 只收集 UID；confirm_delete 才调用 bulkDelete。safe-send preview 只冻结内容；confirm_send 才调用 SMTP。移动、旗标、草稿创建、文件夹创建、垃圾名单更改没有相同的两阶段预览协议。工具 annotations 只是提示，不是强制授权层；R1 保留为可信人类审批设计问题。下载工具虽在 17-tool 只读集合，仍可能写附件目录，不能称“主机文件系统只读”。

失败/恢复：白名单外工具缺席；未知配置名只写 stderr；草稿/删除预览仅内存，进程重启后未知 ID 不自动恢复。当前运行客户端可见工具集合未在本轮重新 tools/list，见基线缺口。

## E02：任意数量账户与全局搜索

`src/tools/unified-search-tools.ts:34-145 unifiedSearchTools` → `AccountManager.getAllAccounts/resolveAccountId` → `listFolders`/`selectSearchFolders` → `ImapService.searchEmailPage` → top-K/账户覆盖结果。默认选择所有配置账户；三是并发上限，不是账户数量限制。现有测试含 25 账户，但本轮未重跑整套。

`src/services/imap-service.ts:489-527 searchEmailPage` 在 folder lock 内读 SELECT 元数据，必要时 STATUS；校验 UIDVALIDITY 和 cursor 上界，UID SEARCH 最多 10 万候选，最多 FETCH 200 条，下一页 `beforeUid` 取已选最低 UID 减一。缺 UIDNEXT 时从真实过滤 UID 建首轮，不造上界；稀疏 UID 不逐号遍历。SA-08 的修复和 21 条合成回归保留，不能重新登记待修。

副作用：元数据读取，无旗标修改调用；结果每封附 `accountId/accountName/folder/uid`。本工具 date 优先 INTERNALDATE；普通搜索部分路径优先 envelope date，跨工具时间语义需在相关任务验收中明确。不是所有可返回 location 都含 UIDVALIDITY，后续写操作必须重新冻结并校验。

失败/取消：每账户默认 15 秒、整体 40 秒，每文件夹最多 25 页；定时器调用 account 级 `abortConnection`。已取得局部结果保留，账户有 ok/partial/failed/timeout、foldersSearched/Errored/Pending。普通文件夹异常可生成续查；**LIST 发现异常**进入外层非 timeout catch，没有 placeholder，失败账户可能从后续 cursors 消失（SA-04，已模拟）。认证前尚未登记 pending 的取消缺口见 SA-03。

恢复：调用者携原过滤/limit 和 cursors 继续，只能把每次输出视为已扫描范围的 top-K，再跨次合并排序。`totalFound` 是本次已处理匹配数，不是最终快照总量；`truncated` 不是“还有完整结果页”的保证。`partial:false,cursors:[]` 仍可能只返回 limit 条，不是全部邮件导出。大扫描未完成时首屏不是全局最终 top-K；邮箱改变时也不是事务快照。新计划要求把这些语义写到恢复回归，不据此声称所有结果均可穷尽返回。

## E03：账户身份、游标和连接状态

`src/services/account-manager.ts:390-417 resolveAccountId`：显式 ID 优先，名称精确匹配；无选择且仅一账户才默认。添加/更新检查名称唯一，移除重建可复用名称。名称不是稳定身份；ID 也不代表连接配置版本。

`src/services/imap-service.ts:180-339 connect/ensureConnected`：已连接只按 ID 命中；ensureConnected 虽读最新 configuredAccount，但仅检查存在，重连取 `state.account`。配置、身份或凭据变化未使旧连接失效（SA-01）。只有完成后 connections 缓存，pendingConnections 不共享 Promise（SA-02）。token resolve 在 pending 登记前，abort 看不到此阶段（SA-03）。每次成功重连重置计数，不能把 maxReconnectAttempts=3 解读成全进程重试预算。

`src/tools/unified-search-tools.ts:10,38,57-73,87-94,140`：cursor 用 accountName/folder/beforeUid/uidValidity/filterKey；filterKey 包含查询/limit/文件夹开关，不含账户集合、账户 ID、配置 revision。模拟修改账户名仍通过相同 filterKey。**N-02 是身份/范围的条件风险，无越权结论**：同名替换或版本变化可能误续查；客户端本来就能访问已配置账户。UIDVALIDITY 是邮箱内重建标识，不是跨服务器或跨账户唯一身份。修复需定义 v2 cursor 兼容/过期策略，优先稳定 ID+非秘密 revision，不为此自动加入签名/数据库。

恢复：账户移除会 abort 并拒绝；store 文件删除/损坏却可能继续使用旧缓存（SA-07，E07），不能以单个 remove API 测试替代跨进程读取验证。图谱不记录账户资料、target 实例值或 secret hash。

## E04：文件夹锁与 UID 定位（下一轮）

`src/tools/folder-tools.ts:55-61 imap_folder_status` 先命名 STATUS，再 `selectFolder`；`src/services/imap-service.ts:368-370 selectFolder` 裸调用 `mailboxOpen`。读取/旗标/移动/删除主体使用 getMailboxLock，但裸 SELECT 不排队。IMAP UID 命令的目标是“当前被选邮箱”，不是传入工具时的文件夹字符串。

`probes.mts` 受控闸门复用了实际 `bulkDelete/selectFolder`：A 持 INBOX 锁并停在 STATUS，B 裸 SELECT Archive，随后 A 的 messageMove 实际选中 Archive，仍报告 deleted=1。mock 没有真实服务器；它证明当前调用/锁约定允许该交错，不是邮件已被删除的记录。

所需契约：folder_status 的 counts、flags、permanentFlags、UID 元数据来自同一受锁保护的文件夹操作；命名 STATUS/SELECT 都要在业务锁协议内，finally 释放；计数来源保持 STATUS，不能改回 SELECT.exists 伪造 unseen/recent。读取、旗标、移动、删除的所有 SELECT 调用者一起检查。新方法可保持旧 selectFolder 的兼容外形，但不能返回解锁后仍可变的 client.mailbox 引用。失败不得阻塞队列；具体 T01 见路线图。

## E05：冻结删除、能力和结果

五入口 `imap_delete_email/bulk_delete/bulk_delete_by_search/delete_spam/delete_by_domain` 经 `src/tools/guarded-delete-tools.ts:15-72`：ALS 捕获选择，不执行写操作；搜索前后检查 UIDVALIDITY；再次检查、冻结 uids/永久性并返回 previewId。`confirm_delete:73-93` 只读冻结集合，先验 validity/trash，再调用 `ImapService.bulkDelete:1184-1258`。确认不是重跑搜索；有效边界必须保留。

状态：pending→executing→finished 删除预览；异常→ambiguous，禁止同 ID 再试。TTL 五分钟。没有账户 revision；同 ID 改端点且 UIDVALIDITY 碰巧一致时并不能证明仍是原邮箱（N-01 删除部分为条件推断，未做真实场景）。trash 检查在每 chunk 持锁之前/账户级，身份变化还需统一版本契约。

共享副作用：`deleteEmail:1160`、`bulkDelete:1184`、`moveEmail:1272` 都调用依赖 messageMove/messageDelete；不仅 confirm_delete 一个入口。锁定 imapflow **1.6.5**，`lib/commands/move.js:34-37` 的无 MOVE 回退 COPY 结果未检查就删除（MAIL-09a）；`expunge.js:24-36` 缺 UIDPLUS 会普通 EXPUNGE（MAIL-09b）。必须在任何 COPY/旗标/EXPUNGE 前决定能力策略，事后判断返回值不能撤销误删。

`bulkDelete:1227-1237` 未检查 false/undefined 即增加 deleted（MAIL-08）；throw 仅能说明本次失败/不确定，不能把整 chunk 自动称为从未修改。当前 chunk 失败后可能重连处理下一块，无通用精确完成账本。`moveEmail` 已检查 falsy，但挡不住依赖内部已发生副作用，且 batch error 挂在结果对象（类型未完整表达）。未来结果契约要区分未提交、已完成、部分/未知，不能只加 try/catch。

`src/tools/spam-tools.ts:308-359` 的按域候选由 IMAP FROM 子串直接取 UID（MAIL-07）；预览只是冻结该集合，并不保证分类正确。精确地址域复核应先于冻结，子域策略显式定义；垃圾启发式和 R4 另记，不能用“模型再判断”替代程序解析。

## E06：发送授权、SMTP 接受与 Sent

`safe-send-tools.ts:144-231`：三种预览构造 composer、物化附件，`SafeSendService.preview:154-179` 复制/冻结内容、容量/TTL。`confirm:194-241` 在执行前置 sending，共享 inFlight，异常 ambiguous；发出请求的唯一性限定本进程同 draftId，不是跨重启的持久 exactly-once。

执行器 `safe-send-tools.ts:137-142` **确认时重新 getAccount**；冻结 payload 只有 accountId/composer，无 revision。模拟在 preview 后修改同 ID 的 user/email，confirm 仍进入 mocked SMTP 并返回 sent（N-01）。可能采用新身份，也可能因 SMTP 缓存继续旧身份；不能假定重连自然解决。

`smtp-service.ts:14-43 createTransporter` 按 ID 缓存，认证只在首建 resolve；token 没有 expires/provision callback，密码/host 变更不失效（MAIL-12）。`sendEmail:158-178` 先 composeRaw，再 sendMail(mailOptions) 再编译；两份 Message-ID/MIME 不一致（MAIL-03）；只返回 messageId/raw，丢弃 accepted/rejected/rejectedErrors（MAIL-10）。SMTP resolve 只代表协议提交结果，不能叫最终收件箱送达。

`safe-send-tools.ts:93-128 saveSentBestEffort` + `imap-service.ts:1556-1628`：Sent 是次要 IMAP APPEND，单独十秒截止；失败转 warning，不重新发送 SMTP。SafeSend 先记 sent 后等待副本，第二次 confirm 可能较早返回 already_sent，二者不代表副本完成。保留此“不因副本失败重发”的保护。

**N-03**：`ImapService.appendToSentFolderInternal:1618-1619`、`appendMessage:1697-1705` 忽略 append 的 false，直接返回保存成功。锁定依赖 `imap-flow.js:3129-3130` 把未执行 APPEND 归一为 false（底层 append.js:16-19 的状态前置）；本轮 mock 两条路径均产生假成功。发生需连接/状态前置失效，未做真实网络时序验证。草稿调用者 `email-tools.ts:1114-1118` **已经检查** service 的 false，修复点首先是共用服务，不能误报“草稿 handler 从不检查”。审查另提示 composeRaw 失败而 SMTP 成功时 raw 缺失会静默跳过副本：静态条件风险归入 MAIL-03/T22，不新增一轮专项。

恢复：明确未开始提交的认证失败才可重建 transport；已接受/未知不得自动重发。部分拒收仅对被拒收人建立新预览；不能重发给已接受者。T21 的回执契约先明确这些状态，再按相同 frozen MIME 保持 BCC envelope 正确。

## E07：账户写入与凭据事务

`AccountManager.withStoreTransaction:54-62` → 文件 wx 锁 → strict reload → 内存 snapshot → action → saveAccounts 临时文件/rename。`loadAccountsSync:440-456` 只有成功 parse 后才 clear，ENOENT 及非 strict 错误保留旧 Map；parse 后迭代坏结构还可能留下部分 Map（SA-07）。写侧 strict 也忽略 ENOENT，因此删除文件后新增可能复活旧账号。

`web/server.ts:187-236,309-370` 的通用 POST/PUT 直接从 req.body 组装，缺候选运行时 schema；provider enrollment router 的 strict Zod 不能覆盖这些入口（BUG-SEC-06）。`updateAccountUnlocked:189-249` 在 save 后调用 decrypt 而非 decryptField：空历史凭据失败时磁盘已提交、内存 snapshot 回滚，响应报错（SA-06）。事务锁/atomic rename 不等于整个业务提交原子；返回对象构造、校验及 vault 提交点需在契约内。

`account-enrollment.ts:133-173 persist` 在 store transaction 下写 vault/可选 verify/账户提交，失败按 snapshot 回滚。浏览器传了 verify，CLI `src/enroll.ts:302-305` 未传（BUG-SEC-04），打印 enrolled 不代表网络验证。`enroll.ts:171-193,242-279` repair → `credential-rotation.ts:33-48` 使用新 secret/网络verify/旧值回滚，未参与同一跨进程协议（SEC-03），可与 remove 交错。文件锁不能靠在网络阶段无限持有来弥补；先定义提交时账号/target/revision 重验与冲突结果。

provider auth 必须精确 target 及端点，SecretHandle finally dispose；账号文件只保存 provider 的引用。legacy 通用密码仍 AES+同目录 key（R2），并非 OS vault。credential target 不变但值轮换时也必须改变非秘密 auth revision；仅 hash host/user/target 不能解决这个问题。日志/图谱不得存储 secret 或其摘要。

## E08：OAuth、路由、清理与进程

`AccountAuthResolver.resolve` → Gmail refresh exchange 或 WinCred → `buildImapAuth/buildSmtpAuth`。`mail-proxy.ts:29-39` 对 QQ/网易强制直连；Gmail 使用 `gmail-proxy.ts` 强制代理，HTTP token 与 mail transport 都不能回落直连；标准 env/Windows loopback 配置按优先级解析。`proxy-fetch.ts:62-80` 用专用 dispatcher 避免 NO_PROXY 绕开 Gmail；close 在 finally。provider 目录仅 UI 元数据，不是认证端点的实际授权源。

`gmail-oauth-loopback.ts:257-306` 的 tokenTimer 在 headers 后 finally 清除，再读成功/错误 body（BUG-SEC-05）。refresh `gmail-token-exchange.ts:132-178` 的 timer 已包住 json，不能误称同一 header-only bug；但两者都无 body 总字节上限。deadline/字节限制覆盖成功和错误体，不用 drip-feed 重置总截止。HTTP 202、浏览器 callback“已收到响应”、token 交换成功、登录验证、vault+account 提交、job success 是不同阶段；轮询 success 才是浏览器路径的完成反馈。

`authenticateOnly:1708-1736` 已有 finally logout，**不重新登记此已存在保护为缺失**；但 logout 失败时未保证 close，需计入 T18。`testConnection:1738-1782`、Web `test-connection:245-281` 的 LIST 失败未 finally 关闭（BUG-SEC-A1）；`WebUIServer.stop:430-437` 仅关 HTTP/监听器，不清理其 IMAP。`src/index.ts` 没有显式全面 shutdown 清理入口；作为生命周期覆盖缺口随 T18 定界，不据此直接宣称已发生泄漏。

SEC-01：`web/server.ts:93-118` 的 no-store 和 session 都挂载 `/api`，与 Express 匹配规则一致。该修复仍在，大小写绕过不再待修；通用 schema 缺口为独立 BUG-SEC-06。

## E09：正文、附件、多视图

read/search/latest/thread 共用 `ImapService.buildEmailContentFromSource:716-875`；MIME 源 25 MiB、正文 10 万字符、单封 20 附件；HTML 转换不引入 LLM。正文附 PDF preview 走 `utils/pdf-preview.ts` 子进程，256 KiB/20页/5秒/最多2并发/128MiB V8 old-space；不是整个进程 RSS 硬限制。

下载入口 `email-tools.ts:530-570` 直接主进程 PDFParse，绕过该隔离（MAIL-02），即使 MIME 总量受限也不能代表解压/解析工作量受限。输入/输出/超时/繁忙要有明确反馈，不能回退主进程重试。附件路径经 attachment-root realpath/link 检查，不在本轮另加新安全框架。

MIME 地址模型 `imap-service.ts:798-806` 可能把 To 整串放入单元素，`safe-send-tools.ts:65-85` replyRecipients 忽略 Reply-To/Cc（MAIL-04）。转发 `:218-224` 仅 text 加附言/header，HTML 原样（MAIL-05）。`getAttachmentContent:912-941` 用 filename/contentId find 第一份；safe-send 逐附件重取，两个同名无CID会复用第一份（MAIL-11）。稳定 part identity 要绑定 account/folder/UIDVALIDITY/UID，转发一次获取原 MIME，比较字节哈希及 CID，不能只测名称。

## E10：打包、注册、安装、验证

`build.mjs` 用 esbuild bundle 四个入口，npm dependencies external；dist 与依赖树共同构成可执行版本。package/server/index 大多报告 0.1.1，Web health 硬编码 1.0.0（`web/server.ts:418`），版本字符串不能独立证明加载 commit。版本可观察性先记部署证据缺口，T36 如需持久构建身份再定小契约，不自动增建运行时审查系统。

`setup.ts:44-70` 用 cwd 定位 dist，解析任何错误当空配置再覆盖（ENG-02/03）。安装脚本只 npm ci/build，不操作 MCP 配置。`scripts/open-setup.cjs` 只启动设置服务；**存在 launcher 不代表已注册，已注册不代表 transport 可用，进程存在不代表当前调用成功**。本轮不运行这些启动/配置脚本。

当前基线/安装叠加部署详见 baseline-deployment；旧 clone HEAD 与实际 dist 必须分开。本仓无 docs/acceptance.md，使用 AGENTS、CI、release 文档的适用要求；release workflow 仍禁用，不能从路线图推导发布许可。本轮只有解析/文档校验和五个模拟观察，产品 build/test/coverage/audit 未重新执行。历史成功仅在版本和输入可比时引用；最新依赖安全性/服务商兼容仍需实施日重新检查。
