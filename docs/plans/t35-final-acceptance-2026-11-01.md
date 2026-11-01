# T35 最终集成验收记录（2026-11-01）

## 验收对象与前置

- **验收 SHA：main@`5079f1b9e40b`**（PR #43 merge commit；工作树干净，`git status` 无未提交项）。
- 前置确认：PR #43 已合并（用户授权后执行）；#39–#43 五个 merge commit 均为 main 祖先（`git merge-base --is-ancestor` 逐一验证）：#41→`8418f0e`、#39→`74a8a58`、#40→`a71e761`、#42→`80106c7`、#43→`5079f1b`。夜间 T27/T25/T17/T20 + T33 依赖维护全部包含。
- 环境边界：全部检查使用模拟服务、localhost、假凭据与临时配置（`IMAP_MCP_CONFIG_DIR` 隔离）；未操作真实邮箱或 WinCred，未部署/发布/自动合并；T36 保持未执行。

## acceptance.md 集中门禁（9 项，逐条实跑）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run build` | Build complete!（dist/enroll.js、dist/index.js、dist/setup.js、dist/web/server.js 等产物生成） |
| 2 | `npm test` | 91 files / **929 passed + 1 skipped**，0 FAIL |
| 3 | `npm run lint` | 通过（tsc --noEmit --skipLibCheck；@types/nodemailer 8.0.2 对 nodemailer 10.3.1） |
| 4 | `git diff --check` | 干净（工作树无变更） |
| 5 | `npm run test:coverage` | statements 83.64% / branches 75.41% / functions 85.56% / lines 86.47%（≥ 既有基线 83.21/74.69/85.47/86.15） |
| 6 | `npm run check:secrets` | 通过（218 个 release-candidate 文件） |
| 7 | `npm audit --omit=dev`（另加 `--audit-level=high`） | **found 0 vulnerabilities**（两级别均 0，exit 0） |
| 8 | `npm audit`（另加 `--audit-level=high`） | **found 0 vulnerabilities**（两级别均 0，exit 0） |
| 9 | `npm pack --dry-run` | mail-agent-mcp-0.1.1.tgz：13 files / 957.9 kB；含 dist/enroll.js、dist/index.js、dist/setup.js、dist/web/server.js、README、SECURITY.md、docs/agent-integration.md |

## Node22/24 CI

- 该验收 SHA 的全套 CI：[run 41265016397](https://github.com/ertutio/mail-agent-mcp/actions/runs/41265016397)（workflow_dispatch @ main `5079f1b`，Ubuntu Node 22.x/24.x：依赖安装、test、build、产物、lint、diff、secrets、生产/全量 audit、pack）**全部通过**。
- 本 coverage 为本地实跑，不是 CI 步骤的替代证据（acceptance.md 第 50 行约定）。

## 重点互操作确认（定点套件在验收树上合并运行，77 passed / 0 FAIL）

| 行为 | 套件（case 数） |
| --- | --- |
| 凭据轮换（写边界重验、锁内快照/回滚、generation 归属、remove 不复活、同值不剥夺） | credential-rotation + enroll-repair-lease（真实 store lock + fake vault journal） |
| SMTP 并发与不自动重发 | smtp-receipts（T20R 真实 createTransporter + T21 收据契约） |
| 附件身份与冻结字节 | attachment-part-selection（T25E/T25R 真实 MIME）+ smtp-frozen-mime（真实 streamTransport） |
| 有限搜索续查 | unified-search（T26 身份绑定 + T27 pass 预算） |
| 依赖升级后邮件解析 | addressparser-hardening（三条公告向量经生产入口）+ safe-send-mime-integration（真实 mailparser） |

## 启动脚本 smoke

- `node dist/enroll.js`（stdin EOF）：干净进入交互提示并退出 0。
- `node dist/web/server.js`：127.0.0.1:3000 监听，HTTP 200（浏览器安装会话正常启动；本地临时日志不进入任何验收记录）。

## 复用与跳过

- 复用：四支夜间 PR 各自的独立只读复审结论（T25 PASS、T17 三轮→APPROVE、T20 APPROVE、T33 APPROVE）与 RED→GREEN 证据（源码未再变更，仍适用）。
- 跳过/未执行：T36 部署验收（人工门控，保持未执行）；Windows/WinCred 与真实服务商环境（acceptance.md 规定按影响另行验证，本轮无授权）；skipped 1 例为 Windows 下 POSIX owner-permission 平台 skip（与既往一致）。
- 无回归：全部门禁一次通过，无新增修复、无源码变更（本验收仅含文档记录）。
