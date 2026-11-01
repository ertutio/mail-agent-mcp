# T33 依赖维护证据（2026-11-01）

授权：本轮用户明确授权扩展 T33 维护范围至生产与开发依赖的全部已知漏洞。方法约束：兼容修复版本优先，必要时调整直接依赖与调用点；不盲跑 `audit fix --force`、不降级到过时版本、不以忽略公告/删除必要功能/降低门槛清零。

## 基线（main@80106c736f4d，实际 lockfile）

- 生产 `npm audit --omit=dev`：**5 moderate** —— nodemailer 10.1.0 命中 3 条 addressparser 公告（GHSA-8c8m-p3m8-cjg8 嵌套注释提前闭合、GHSA-m943-m63m-w62w 引号串/注释内 `;` 提前结束地址组、GHSA-85x2-q946-cp5h 引号 local part 内 `>` 提前结束 angle-addr）；mailparser 3.9.38 因内部 nodemailer 连带；qs 6.16.0（GHSA-6pq8-jhm2-2vcw，arrayFormat comma 非函数 toString 崩溃）。
- 全量 `npm audit`：**10 moderate** —— 上述之外：@vitest/mocker ≤4.1.11 两条公告（GHSA-82fw-gwwq-j7x9 路径穿越/任意文件读、GHSA-qxg6-89mg-rqv8 未认证手动 mock 注册注入）波及 vitest/@vitest/coverage-v8 4.1.10；fast-uri 3.1.8（GHSA-333x-w4r6-6crp 后缀引用 scheme 注入）；nodemon 3.1.14 → minimatch 10.2.5 < 11.0.1（GHSA-g3hv-75wg-m249 globparts 放大）。

## 逐项处置

| 公告/链 | 修复 | 依据 |
| --- | --- | --- |
| nodemailer 3 条 addressparser 公告 | 直接依赖 `10.1.0` → `10.3.1`（保持精确 pin 惯例） | 官方修复版本；`npm view nodemailer version` |
| mailparser 连带 | `^3.9.11` → `^3.14.1` | mailparser 3.14.1 自身即依赖 `nodemailer@10.3.1`，升级链自然闭合，无 override |
| qs GHSA-6pq8-jhm2-2vcw | lockfile 内 6.16.0 → 6.17.1（`npm audit fix` 非 force） | body-parser 2.4.0 声明 `^6.16.1`，范围含修复版 |
| @vitest/mocker 两条（vitest/coverage-v8 连带） | dev `^4.1.8` → `^4.1.12`（显式，未 force） | 修复版在既有 `^4.1.8` 语义化范围内 |
| fast-uri GHSA-333x-w4r6-6crp | lockfile 内升级（`npm audit fix` 非 force，ajv 传递链） | 上游修复版 |
| nodemon → minimatch GHSA-g3hv-75wg-m249 | **删除未使用的 devDependency nodemon** | 全仓无任何脚本/文档执行路径引用 nodemon（`dev` 脚本本用 `tsx watch`）；docs/plans/audit-remediation-2026-10-15.md B11 与 docs/analysis/mail-mcp-20261017/dependency-evidence.md 早已记录"删除或替代未使用 nodemon 链"，本轮授权覆盖。minimatch 漏洞随之离开依赖树 |

## 结果

- `npm audit --omit=dev`：**found 0 vulnerabilities**
- `npm audit`：**found 0 vulnerabilities**
- 未使用 `--force`；未降级任何包；未添加 audit 忽略项/override；未降低门禁阈值。

## 升级后验证

- 全量套件：91 files / **929 passed + 1 skipped**（nodemailer 10.3.1 + mailparser 3.14.1 下的地址解析、回复/转发、Bcc、冻结 MIME（真实 streamTransport）、SMTP 收据与不自动重发全部保留）。
- 重点回归：default-bcc / forward-views / reply-addresses / safe-send-mime-integration / smtp-frozen-mime / smtp-receipts 合计 36 passed。
- 新增 `tests/addressparser-hardening.test.ts`：三条公告向量经生产入口 `mailboxAddresses`（nodemailer addressparser）钉住修复语义——注释片段不得成为收件人；引号内 `;`/`>` 保持单收件人不拆分。
- `@types/nodemailer` `^8.0.1` → `^8.0.2`（无 peer 约束），`tsc --noEmit --skipLibCheck` 通过；`node build.mjs` 通过；启动 smoke：`node dist/enroll.js`（stdin EOF）干净进入提示并退出 0。
- coverage：statements 83.64% / branches 75.41% / functions 85.56% / lines 86.47%（≥ 既有基线 83.21/74.69/85.47/86.15）。

## 残留与可行方案

- 无已知未修复漏洞项。nodemon 移除后如未来需要文件监听重启，用 `tsx watch`（已是 `dev` 脚本现状）。
- npm 公告为时间点数据：合并前应重新运行生产/全量 audit 复核（实施日公告可能更新）。
