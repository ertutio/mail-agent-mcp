# 生产模块索引

基线 `524e1b34c89ebe2834a27b948371227f142d346d`，与远端 main Git tree 完全一致。内部依赖为 Understand Anything 确定性提取；外部包见源文件及 lock。阅读深度精确记录在 coverage.json。

| 模块 | 职责 | 内部依赖 | 实际阅读深度 |
| --- | --- | --- | --- |
| `src/credentials/account-auth.ts` | 读取 SecretHandle、校验精确 vault target/provider 端点，生成 IMAP/SMTP 认证配置。 | `src/credentials/credential-backend.ts`, `src/types/index.ts` | full |
| `src/credentials/account-enrollment.ts` | provider 注册的 vault 写入、可选验证、账户提交与回滚事务。 | `src/credentials/credential-backend.ts`, `src/services/account-manager.ts`, `src/types/index.ts` | full |
| `src/credentials/credential-backend.ts` | SecretHandle/后端契约与新/旧 target 命名规则。 | 无项目内 import（仍可能调用 npm/系统） | structural+surface |
| `src/credentials/credential-rotation.ts` | 凭据替换/验证/回滚；尚无跨进程账户版本重验。 | `src/credentials/credential-backend.ts` | full |
| `src/credentials/gmail-oauth-loopback.ts` | 回环 PKCE 浏览器授权、回调、授权码换令牌与清理。 | `src/credentials/proxy-fetch.ts` | targeted:1-165,245-329;surface:callback handler |
| `src/credentials/gmail-token-exchange.ts` | refresh token 换 access token、网络错误分类和代理生命周期。 | `src/credentials/credential-backend.ts`, `src/credentials/proxy-fetch.ts`, `src/types/index.ts` | full |
| `src/credentials/proxy-fetch.ts` | 标准 env 代理或 Gmail 强制 dispatcher 的 HTTP fetch 封装与 close。 | `src/utils/gmail-proxy.ts` | full |
| `src/credentials/windows-credential-backend.ts` | Koffi WinCred 适配与 SecretHandle 零化；本轮未访问系统凭据。 | `src/credentials/credential-backend.ts` | targeted:1-85;structural+surface:remaining |
| `src/enroll.ts` | 可信本地 CLI 收集输入，提供 QQ/网易/Gmail 注册与 QQ/Gmail 修复。 | `src/credentials/account-auth.ts`, `src/credentials/account-enrollment.ts`, `src/credentials/credential-backend.ts`, `src/credentials/credential-rotation.ts`, `src/credentials/gmail-oauth-loopback.ts`, `src/credentials/gmail-token-exchange.ts`, `src/credentials/windows-credential-backend.ts`, `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/types/index.ts` | targeted:75-88,141-360 |
| `src/index.ts` | 组装 stdio MCP、账户/凭据解析器及 IMAP/SMTP 服务，注册工具。 | `src/credentials/account-auth.ts`, `src/credentials/gmail-token-exchange.ts`, `src/credentials/windows-credential-backend.ts`, `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/services/smtp-service.ts`, `src/services/spam-service.ts`, `src/tools/index.ts` | full |
| `src/providers/email-providers.ts` | 设置页服务商端点/能力提示目录与 email/host 查询；不是实际认证策略。 | 无项目内 import（仍可能调用 npm/系统） | structural+surface |
| `src/services/account-manager.ts` | 隔离目录账户存储、加密/env 覆盖、选择、跨进程写事务与 provider 持久化约束。 | `src/credentials/account-auth.ts`, `src/credentials/credential-backend.ts`, `src/types/index.ts`, `src/utils/account-store-lock.ts`, `src/utils/env-credentials.ts` | targeted:1-310,364-483,503-568;surface:311-363 |
| `src/services/html-to-markdown.ts` | 清洗 HTML 并转换 Markdown，规范正文空白。 | 无项目内 import（仍可能调用 npm/系统） | structural+surface |
| `src/services/imap-service.ts` | IMAP 连接缓存/重连、锁、UID 查询、MIME 读取、旗标、移动删除和 APPEND 共用实现。 | `src/credentials/account-auth.ts`, `src/services/account-manager.ts`, `src/services/html-to-markdown.ts`, `src/types/index.ts`, `src/utils/env-credentials.ts`, `src/utils/mail-proxy.ts`, `src/utils/mail-resource-limits.ts`, `src/utils/pdf-preview.ts` | targeted:1-541,677-875,912-941,989-1085,1118-1370,1538-1783;surface:remaining |
| `src/services/safe-send-service.ts` | 内存草稿冻结、容量/TTL、单次确认及 ambiguous 禁止重发状态机。 | `src/types/index.ts`, `src/utils/mail-resource-limits.ts` | full |
| `src/services/smtp-service.ts` | 按账户缓存 transporter，TLS/代理/认证，独立 MIME 编译和 SMTP 提交。 | `src/credentials/account-auth.ts`, `src/types/index.ts`, `src/utils/array-input.ts`, `src/utils/env-credentials.ts`, `src/utils/mail-proxy.ts`, `src/utils/mail-resource-limits.ts` | full |
| `src/services/spam-service.ts` | 确定性域/头启发式、白名单优先及域统计；不执行运行时模型判断。 | 无项目内 import（仍可能调用 npm/系统） | targeted:118-239,252-391;surface:constants and list mutators |
| `src/setup.ts` | 设置页启动与可选 Claude Desktop 配置写入；路径/覆盖问题仍在。 | `src/web/server.ts` | full |
| `src/tools/account-tools.ts` | 只读账户列表、连接/断开、既存账户连接测试。 | `src/services/account-manager.ts`, `src/services/imap-service.ts` | full |
| `src/tools/email-tools.ts` | 搜索/读取/附件、旗标、移动、删除候选、草稿及已封禁旧发送处理器。 | `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/services/smtp-service.ts`, `src/types/index.ts`, `src/utils/array-input.ts`, `src/utils/attachment-root.ts`, `src/utils/default-bcc.ts`, `src/utils/search-folders.ts` | targeted:1-135,165-380,386-592,766-1018,1071-1133;surface:remaining |
| `src/tools/folder-tools.ts` | 文件夹列表/状态/创建与未读统计；状态 SELECT 绕锁、统计错误归零待修。 | `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/types/index.ts` | full |
| `src/tools/guarded-delete-tools.ts` | 截获五个删除入口，冻结 UIDVALIDITY/UID/永久性，确认后统一 bulkDelete。 | `src/services/imap-service.ts` | full |
| `src/tools/index.ts` | 统一工具白名单、只读集合、直接发送封禁和删除代理装配。 | `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/services/smtp-service.ts`, `src/services/spam-service.ts`, `src/tools/account-tools.ts`, `src/tools/email-tools.ts`, `src/tools/folder-tools.ts`, `src/tools/guarded-delete-tools.ts`, `src/tools/safe-send-tools.ts`, `src/tools/spam-tools.ts`, `src/tools/unified-search-tools.ts` | full |
| `src/tools/safe-send-tools.ts` | 新信/回复/转发预览物化附件，确认触发 SMTP，Sent 副本 best effort。 | `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/services/safe-send-service.ts`, `src/services/smtp-service.ts`, `src/types/index.ts`, `src/utils/attachment-root.ts`, `src/utils/mail-resource-limits.ts` | full |
| `src/tools/spam-tools.ts` | 本地垃圾特征、域统计/名单管理及经删除代理包装的垃圾/域删除。 | `src/services/imap-service.ts`, `src/services/spam-service.ts` | targeted:92-178,308-378;surface:other registrations |
| `src/tools/unified-search-tools.ts` | 选择任意数量账户，最多三账户并发、逐文件夹 UID 分页、全局 top-K 与覆盖/续查反馈。 | `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/types/index.ts`, `src/utils/search-folders.ts` | full |
| `src/types/index.ts` | 账户认证、邮件/附件、查询和 Sent 回执类型；无账户 revision/稳定附件 part。 | 无项目内 import（仍可能调用 npm/系统） | full |
| `src/types/turndown-plugin-gfm.d.ts` | Turndown GFM 插件的本地 TypeScript 声明。 | 无项目内 import（仍可能调用 npm/系统） | structural |
| `src/utils/account-store-lock.ts` | 文件 wx 锁串行化跨进程账户写入，5 秒超时，异常退出需人工判定陈旧锁。 | 无项目内 import（仍可能调用 npm/系统） | full |
| `src/utils/array-input.ts` | 恢复客户端序列化数组的兼容输入。 | 无项目内 import（仍可能调用 npm/系统） | structural+surface |
| `src/utils/attachment-root.ts` | 附件读写 realpath 边界和 link/junction 检查。 | 无项目内 import（仍可能调用 npm/系统） | full |
| `src/utils/default-bcc.ts` | 默认与显式 BCC 的裸地址去重；safe-send 另有局部实现，属于调用者核对点。 | 无项目内 import（仍可能调用 npm/系统） | full |
| `src/utils/env-credentials.ts` | 账户名到 env key 的映射和空凭据拒绝；不读取系统 vault。 | `src/types/index.ts` | full |
| `src/utils/gmail-proxy.ts` | Gmail 专用/标准代理与 Windows loopback 回退，缺代理拒绝。 | `src/utils/windows-system-proxy.ts` | full |
| `src/utils/mail-proxy.ts` | QQ/网易直连、Gmail 强制代理、其他 provider 的通用代理策略。 | `src/credentials/proxy-fetch.ts`, `src/utils/gmail-proxy.ts` | full |
| `src/utils/mail-resource-limits.ts` | 25 MiB MIME/附件、正文/数量上限及有界文件物化。 | 无项目内 import（仍可能调用 npm/系统） | full |
| `src/utils/pdf-preview.ts` | 限制输入/页面/输出/并发的 PDF 子进程和 5 秒终止。 | 无项目内 import（仍可能调用 npm/系统） | full |
| `src/utils/search-folders.ts` | 按 selectable、SPECIAL-USE/名称过滤 Trash/Spam/Drafts 等文件夹。 | `src/types/index.ts` | full |
| `src/utils/windows-system-proxy.ts` | 只读 Windows 代理设置并仅接受启用的 loopback 地址。 | 无项目内 import（仍可能调用 npm/系统） | full |
| `src/web/enrollment-router.ts` | 严格 provider 输入、注册互斥与 Gmail 异步 job 状态；202 不代表已注册。 | `src/credentials/account-enrollment.ts`, `src/credentials/gmail-oauth-loopback.ts`, `src/services/account-manager.ts` | full |
| `src/web/server.ts` | 私有设置会话、同源/Host 防护、账户 CRUD/测试、HTTP 生命周期。 | `src/credentials/account-auth.ts`, `src/credentials/account-enrollment.ts`, `src/credentials/credential-backend.ts`, `src/credentials/gmail-oauth-loopback.ts`, `src/credentials/gmail-token-exchange.ts`, `src/credentials/windows-credential-backend.ts`, `src/providers/email-providers.ts`, `src/services/account-manager.ts`, `src/services/imap-service.ts`, `src/types/index.ts`, `src/web/enrollment-router.ts` | targeted:1-140,175-375,405-470;surface:remaining |
