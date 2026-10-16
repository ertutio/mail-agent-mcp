# Mail Agent MCP

**中文** | [English](README.en.md)

[![CI](https://github.com/ertutio/mail-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ertutio/mail-agent-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.12](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

本地运行的邮件 MCP 服务，让支持 MCP 的 AI 客户端搜索、读取和汇总多个邮箱。这个 fork 重点支持中国大陆用户同时使用国内邮箱和需要代理访问的 Gmail：**国内邮箱直连，Gmail 走代理，一次搜索统一汇总。**

基于 [SinoEdwards/mail-agent-mcp](https://github.com/SinoEdwards/mail-agent-mcp) 开发，保留原项目的 OAuth、安全发送、附件边界和通用 IMAP 功能。

> 当前版本为 v0.1.1 Public Preview / Beta，请从本仓库源码安装。尚未发布到 npm 或 MCP Registry。安全邮箱注册使用 Windows 凭据管理器；macOS/Linux 尚未提供对应的安全凭据后端。

## 本次更新

- **多邮箱统一搜索**：同时接入多个 QQ、网易个人/企业邮箱和 Gmail，账号数量没有固定上限，结果保留来源账号。
- **网易安全注册**：支持 163、126、yeah.net 及网易企业邮箱杭州服务器预设，授权码存入 Windows 凭据管理器。
- **按服务商分流**：国内邮箱直连；Gmail 授权、令牌刷新及 IMAP/SMTP 必须走代理，失败不回退直连。
- **通用代理配置**：支持显式环境变量及 Windows 本地系统代理自动检测，不写死个人路径或代理端口。
- **安全与可靠性修复**：更新存在漏洞的运行时依赖，修复账号改名时重复加密密码的问题，阻止账号重名，纠正 OAuth 回调的过早成功提示。

## 安全修复后的使用变化

- 所有删除入口只生成冻结预览，返回邮件样本、UID、数量及是否永久删除。用户核对后调用 `imap_confirm_delete` 并传入 `confirmed: true`。5 分钟后预览失效，邮箱 UIDVALIDITY 变化时拒绝执行；明确的工具白名单需加入该确认工具。
- QQ/Gmail 凭据仅用于规范服务器及安全端口，禁止将凭据改发到其他服务器或关闭证书验证。
- 设置页 API 使用临时会话和精确同源校验；鉴权与业务路由共用匹配规则，`/API` 等大小写变体同样必须提供有效会话。请使用启动终端提供的私有链接；同一标签页可以刷新，服务重启后需打开新的私有链接。不要分享该链接。
- 原始邮件处理上限为 25 MiB，正文输出最多 10 万字符，单封附件最多 20 个，出站附件总计最多 25 MiB。PDF 文本预览限制为 256 KiB、前 20 页及 5 秒的隔离解析；超限时拒绝处理或省略预览。
- 待发送预览默认最多 100 个，保留的附件总量最多 50 MiB；过期附件自动清理。
- 账号保存使用跨进程锁和原子替换。若写入进程异常退出而遗留 `.accounts.lock`，确认没有配置进程在运行后再清理该锁；不要在其他进程正在写入时删除锁。
- 统一搜索先获取匹配 UID 列表，再按每批最多 200 封读取元数据，每个文件夹每次最多 25 批，不逐个遍历空 UID 间隙。UID 列表超过 10 万时需缩小过滤范围。`partial` 为真时，将返回的 `cursors` 连同相同过滤条件及结果上限用于续查；合并各次结果，再按时间排序。游标耗尽前不能把结果当作完整搜索。
- 网易等服务器未提供 `UIDNEXT` 时，分页改用实际匹配 UID 建立起点；有效 `UIDVALIDITY` 仍必需，变化时拒绝旧游标。查询过滤、每页数量和候选上限保持不变。

## 支持的邮箱

| 服务商 | 登录方式 | 注册命令参数 | 网络策略 |
| --- | --- | --- | --- |
| QQ 邮箱 | 客户端授权码 | `qq` | 直连 |
| 网易 163 | 客户端授权密码 | `163` | 直连 |
| 网易 126 | 客户端授权密码 | `126` | 直连 |
| 网易 yeah.net | 客户端授权密码 | `yeah` | 直连 |
| 网易企业邮箱（杭州预设） | 客户端授权密码 | `netease-enterprise` | 直连 |
| Gmail / Google Workspace | 桌面应用 OAuth 2.0 | `gmail` | 必须走代理 |
| 其他 IMAP/SMTP 服务商 | 旧版密码/应用密码配置 | 本地设置界面 | 保留通用代理配置行为 |

QQ、网易和 Gmail 的安全注册目前要求 Windows。其他服务商的旧版配置方式不等同于系统凭据库保护，详见安全说明。

## 快速开始

### 1. 安装并构建

需要 Node.js **22.12 或更新版本**、npm 和 Git。以下命令使用 PowerShell：

```powershell
git clone https://github.com/ertutio/mail-agent-mcp.git
Set-Location mail-agent-mcp
npm ci
npm run build
node dist/enroll.js --help
```

### 2. 注册邮箱

先在邮箱服务商处启用 IMAP/SMTP，并生成客户端授权码或授权密码。推荐打开本机默认浏览器中的中文账号设置页：

```powershell
node dist/setup.js --skip-claude
```

选择邮箱类型，填写邮箱、可选的本地名称及授权码。支持 QQ、163、126、yeah.net、网易杭州企业邮箱及 Gmail / Google Workspace；同一类型可连续添加多个账号。Gmail 可导入 Google Cloud 下载的 **桌面应用 OAuth JSON**，或手动填写 client ID / secret，然后在默认浏览器中完成 Google 授权。配置页会等待令牌交换、IMAP 登录验证和本地保存全部成功后再提示完成；授权回调本身不代表注册完成。导入文件在本机解析，秘密字段不会保存到浏览器存储或发送给聊天模型。

向导仅监听 IPv4 回环地址，使用随机可用端口和私有会话链接，拒绝其他网页跨域调用。页面不依赖外部字体或 CDN，闲置 15 分钟后服务自动关闭。已有账号显示在侧栏；登录失败会回滚新写入的凭据。国内邮箱直连、Gmail 使用代理，规则与 MCP 服务一致。浏览器设置与 MCP 服务必须使用同一账号目录；运行中的服务会在后续账号查询和操作时重新读取账号配置。

账号的新增和移除统一在本机浏览器中操作。侧栏点击“移除”，核对弹窗中的账号名称、邮箱地址并确认后，删除该账号的本机配置及对应系统凭据，**不会删除邮箱中的邮件或注销服务商账号**。账号已被其他窗口更改时，必须刷新列表后重新确认。凭据清理或保存失败时尝试回滚；可重新授权添加已移除的邮箱。

MCP 不再定义 `imap_add_account`、`imap_update_account`、`imap_remove_account`，任何白名单或完整模式均不能启用它们。Agent 只能查看、连接、断开和测试已有账号，不应向用户索取邮箱密码、授权码或 OAuth 密钥。维护用的本地 CLI 和启动环境变量仍保留，不通过聊天传递凭据。

也可保留终端方式，按邮箱类型执行：

```powershell
node dist/enroll.js qq
node dist/enroll.js 163
node dist/enroll.js 126
node dist/enroll.js yeah
node dist/enroll.js netease-enterprise
node dist/enroll.js gmail
```

每个账号执行一次；同一服务商可重复添加不同邮箱。`Account name` 是本地名称，例如 `personal-163`、`work-mail`、`gmail-personal`，应保持唯一。留空时采用邮箱地址作为默认名称。重复名称或同一服务商下重复的凭据身份会被拒绝。

授权码、客户端密钥和令牌不要放进聊天、命令参数、Git 仓库或日志。秘密字段通过隐藏输入接收，存入 Windows 凭据管理器；`accounts.json` 保存账号元数据和凭据引用。

网易预设均使用隐式 TLS：

| 类型 | IMAP（端口 993） | SMTP |
| --- | --- | --- |
| 163 | `imap.163.com` | `smtp.163.com:465` |
| 126 | `imap.126.com` | `smtp.126.com:465` |
| yeah.net | `imap.yeah.net` | `smtp.yeah.net:465` |
| 企业邮箱（杭州） | `imaphz.qiye.163.com` | `smtphz.qiye.163.com:994` |

企业邮箱预设不是所有网易企业部署的通用地址，请以服务商提供的地址为准。网易凭据绑定注册时的服务器、端口和 TLS 设置；修改这些设置会在读取秘密前被拒绝。

### 3. 接入 MCP 客户端

在客户端添加本地 stdio MCP 服务。将下面路径替换成你的实际安装路径；推荐使用这个 **13 工具只读白名单**：

```json
{
  "mcpServers": {
    "mail-agent": {
      "command": "node",
      "args": ["C:/path/to/mail-agent-mcp/dist/index.js"],
      "env": {
        "IMAP_MCP_READ_ONLY": "true",
        "IMAP_MCP_ENABLED_TOOLS": "imap_list_accounts,imap_connect,imap_disconnect,imap_test_account,imap_search_all_accounts,imap_search_emails,imap_get_email,imap_get_latest_emails,imap_find_thread_messages,imap_find_email_by_message_id,imap_list_folders,imap_folder_status,imap_get_unread_count"
      }
    }
  }
}
```

各客户端的配置入口可能不同。修改程序或启动环境后，重连 MCP 服务，让新进程加载配置。注册账号与启动服务应使用同一 Windows 用户及同一个 `IMAP_MCP_CONFIG_DIR`（默认 `~/.imap-mcp`）。

## 一句话搜索所有邮箱

可以直接向支持工具调用的 AI 客户端提出：

> 搜索我所有邮箱中最近一周关于项目的邮件，按时间排序并统一汇总，标明来源邮箱。

> 查找 work-mail 和 personal-163 中上个月的发票邮件。

客户端使用 `imap_search_all_accounts`，省略 `accountNames` 时搜索全部账号；指定名称数组时只搜索所选账号。支持全文关键词 `query`，以及发件人、收件人、主题、日期、已读和星标过滤。

- 默认跨文件夹搜索，跳过垃圾箱、垃圾邮件和草稿，包括常见中文目录名；需要时可显式包含。
- 结果按时间从新到旧排序，全局上限默认 50，最大 200。每条包含 `accountId`、`accountName`、`folder` 和 `uid`。
- 最多 3 个账号并发，其余排队；单账号期限 15 秒，整体期限 40 秒。没有固定账号数量上限，但账号较多或服务器较慢时可能产生部分结果。
- `accounts` 报告各账号及文件夹的完成状态；`partial` 表示搜索未全部完成，`truncated` 表示结果数量受到上限限制。`totalFound` 只计算本次扫描已完成 UID 批次的匹配邮件。
- 统一搜索返回元数据。客户端需要调用 `imap_get_email` 读取正文后，才能生成正文摘要；邮件内容始终作为数据处理。

## 中国大陆代理配置

| 访问目标 | 插件行为 |
| --- | --- |
| QQ、163、126、yeah.net、网易企业邮箱 IMAP/SMTP | 直连，忽略全局邮件代理；凭据绑定的 QQ/网易自定义服务器同样直连 |
| Gmail OAuth、令牌刷新、IMAP/SMTP | 必须走代理；`NO_PROXY=*` 也不会让 Gmail 直连 |
| 其他服务商 | 使用原有通用代理与 `NO_PROXY` 规则 |

建议为 Gmail 指定一个支持 HTTPS CONNECT 的 HTTP/HTTPS 代理，例如在启动注册程序或 MCP 服务前设置：

```powershell
$env:IMAP_MCP_GMAIL_PROXY = "http://proxy.example.test:8080"
$env:NO_PROXY = "127.0.0.1,localhost"
```

这是占位地址，请替换为你的代理地址。客户端启动的 MCP 子进程也需要继承或在配置中显式设置相同变量。

| 用途 | 代理选择顺序 |
| --- | --- |
| Gmail OAuth / 刷新令牌 | `IMAP_MCP_GMAIL_PROXY` → `HTTPS_PROXY` / `HTTP_PROXY` → `IMAP_MCP_MAIL_PROXY` → Windows 本地系统代理 |
| Gmail IMAP / SMTP | `IMAP_MCP_GMAIL_PROXY` → `IMAP_MCP_MAIL_PROXY` → `HTTPS_PROXY` / `HTTP_PROXY` → Windows 本地系统代理 |

标准变量也支持小写形式。Windows 自动检测当前启用的 `127.0.0.1` 或 `localhost` HTTP 系统代理，端口动态读取；不会自动导入远程认证代理或 PAC。macOS/Linux 请显式设置环境变量，安全邮箱注册仍受 Windows 凭据后端限制。

OAuth 需要 HTTP/HTTPS 代理；仅配置 SOCKS 邮件代理不能完成令牌交换。没有代理、代理配置无效或连接失败时，Gmail 明确报错，国内邮箱仍可独立工作。插件不关闭 TLS 验证，也不能改变 VPN/TUN 模式下的系统路由。

## Gmail OAuth 配置与修复

1. 在 Google Cloud 中创建 OAuth 桌面应用客户端，配置同意屏幕；测试模式下将自己的 Gmail 账号加入测试用户。
2. 运行 `node dist/setup.js --skip-claude`，选择 Gmail，填写邮箱并导入桌面应用 OAuth JSON。终端备选命令 `node dist/enroll.js gmail` 仍接收 `installed.client_id` 和 `installed.client_secret` 字段值，不接收文件路径。
3. 在浏览器完成授权。回调使用随机端口的 `127.0.0.1`，验证 state 并使用 PKCE。
4. 浏览器回调提示只表示收到授权响应。**以本机配置页提示“邮箱已验证并添加”为完成**；使用终端方式时，以 `Gmail account enrolled` 为完成。令牌交换、登录验证或凭据保存失败时不会显示注册成功。

Gmail 使用 OAuth，不支持在此安全流程中回退到邮箱密码或应用密码。重新授权已有账号：

```powershell
node dist/enroll.js gmail-repair ACCOUNT_ID_OR_NAME
```

QQ 授权码修复：

```powershell
node dist/enroll.js qq-repair ACCOUNT_ID_OR_NAME
```

修复流程验证认证，不读取邮件或测试 SMTP；验证失败时恢复原凭据。多个账号时使用 ID、准确名称或相应流程支持的邮箱地址选择。

## 工具权限与安全边界

未设置工具限制时，服务注册 **40 个工具**。`IMAP_MCP_READ_ONLY=true` 提供 **17 个邮箱只读工具**；显式 `IMAP_MCP_ENABLED_TOOLS` 白名单优先于这个开关。

| 模式 | 能力 |
| --- | --- |
| 上述推荐的 13 工具白名单 | 列出账号、连接测试、搜索与正文读取、会话定位、文件夹状态和未读数量 |
| 内置 17 工具只读集合 | 上述功能加附件下载及 3 个垃圾邮件分析/列表工具；附件下载会写入本地文件 |
| 完整模式 | 另含邮件状态修改、移动/受限删除、文件夹管理、草稿、上传及发送预览/确认 |

注册的发送工具必须先生成服务端冻结预览，再调用 `imap_confirm_send` 并明确确认。旧版直接发送、回复、转发处理器不注册。推荐白名单不开放发送、修改邮件、附件下载或通过聊天写入账号配置。

- Windows 凭据库保护 Gmail 令牌和客户端密钥、QQ/网易授权码；同一系统用户下的恶意进程仍可能访问相关资源。
- 读取结果会交给所连接的 MCP 客户端和 AI 模型，其保存和处理策略由该客户端决定。
- 附件文件操作限制在 `IMAP_DOWNLOAD_DIR` 范围内。
- 其他服务商可在本机设置页选择“其他 IMAP 邮箱”，使用 IMAP 993 / SMTP 465 与 TLS。此兼容路径可能将密码加密存入账号目录，密钥也在该目录；不等同于系统凭据库，不能防护同时读取两者的攻击者。QQ、网易和 Gmail 的预设使用系统凭据库。
- 移除凭据绑定的账号会删除关联凭据；持久化失败时尽可能恢复。勿手工复用其他账号的凭据引用。

详细边界见 [SECURITY.md](SECURITY.md)，工具契约见 [docs/agent-integration.md](docs/agent-integration.md)。

## 常用配置

| 变量 | 作用 |
| --- | --- |
| `IMAP_MCP_CONFIG_DIR` | 账号元数据目录，默认 `~/.imap-mcp`；注册和服务端需一致 |
| `IMAP_MCP_READ_ONLY` | 启用内置 17 工具邮箱只读集合 |
| `IMAP_MCP_ENABLED_TOOLS` | 逗号分隔工具白名单，优先于只读开关 |
| `IMAP_MCP_GMAIL_PROXY` | Gmail 专用代理，优先级最高 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 标准代理变量；国内邮箱直连，Gmail 不接受绕过规则 |
| `IMAP_MCP_MAIL_PROXY` | Gmail 及通用服务商的邮件代理；不覆盖国内邮箱直连规则 |
| `IMAP_DOWNLOAD_DIR` | 上传和下载附件的本地根目录 |
| `IMAP_MAX_UPLOAD_SIZE` / `IMAP_UPLOAD_TTL_MS` | 上传大小与临时文件存活时间，默认 25 MiB / 24 小时 |
| `IMAP_SEARCH_FOLDER_TIMEOUT_MS` / `IMAP_SEARCH_ALL_TIMEOUT_MS` | 单邮箱跨文件夹搜索期限，默认 10 秒 / 30 秒；不改变统一搜索的 15 秒 / 40 秒期限 |
| `IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME` / `_IMAP_PASSWORD` | 旧版通用账号的启动时凭据覆盖 |
| `IMAP_MCP_ACCOUNT_<NAME>_SMTP_USERNAME` / `_SMTP_PASSWORD` | 同上，适用于 SMTP |

现有进程环境优先于 `.env`。`<NAME>` 为账号名大写并将非字母数字字符替换为下划线。垃圾邮件配置及其他工具参数见集成文档；此项目没有默认托管邮件服务。

## 常见问题

- **浏览器成功，终端失败：** 浏览器和 Node.js 不一定使用同一代理。检查 Gmail 代理、client ID/secret 和终端错误；以终端注册结果为准。
- **Gmail 报代理缺失或令牌超时：** 设置 `IMAP_MCP_GMAIL_PROXY`，确认代理启用并允许 HTTPS CONNECT；修改后重启 MCP 进程。
- **国内邮箱认证失败：** 确认 IMAP 已启用并使用客户端授权码，而非普通登录密码；QQ 可使用 `qq-repair`。
- **证书验证失败：** 检查证书链及可信根证书。若当前 Node 支持 `--use-system-ca`，可在其启动参数中启用系统信任库；不要关闭 TLS 验证。
- **统一搜索只有部分结果：** 查看 `accounts`、`partial`、`truncated`；缩小日期范围或指定部分账号，不能把超时结果当作全部邮件。
- **看不到新工具：** 重建代码，检查白名单是否含 `imap_search_all_accounts`，然后重连 MCP 服务。

## 开发与验证

```powershell
npm run build
npm test
npm run lint
npm run test:coverage
npm run check:secrets
npm audit --omit=dev --audit-level=high
npm pack --dry-run
git diff --check
```

本批 SA-08 / SEC-01 修复通过 662 项测试（1 项跳过），覆盖缺少 UIDNEXT 的全局分页、API 会话大小写变体及原有搜索回归；行覆盖率 81.93%。生产依赖审计为 0 项，完整依赖审计仍有 6 个开发工具受影响包条目（3 high、3 moderate），归入暂缓的 ENG-01。本批仅使用合成数据和隔离环境，未连接真实邮箱或更新本机安装；历史服务商检查不能替代本批真实邮箱复测。

遵循 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)，测试使用模拟凭据和本地服务，不提交个人账号配置、日志或生成产物。未来工作包括跨平台安全凭据后端、旧版密码存储迁移和签名发布。

## 许可证

MIT，见 [LICENSE](LICENSE)。保留原项目及其上游贡献者署名。
