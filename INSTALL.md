# GitHub 安装包 / GitHub installation

这是 `ertutio/mail-agent-mcp` 的预构建 Node.js 程序，MCP 标识为
`io.github.ertutio/mail-agent-mcp`。需要 Node.js **22.12 或更新版本**和 npm。
QQ、网易和 Gmail 的安全账号注册目前要求 Windows 10/11 的凭据管理器。
安装依赖需要联网；包内不含 Node.js、`node_modules` 或个人账号配置。

## Windows

1. 从 [v0.1.0 Release](https://github.com/ertutio/mail-agent-mcp/releases/tag/v0.1.0)
   下载 `mail-agent-mcp-0.1.0.zip` 和 `SHA256SUMS.txt`。
   用 `Get-FileHash .\mail-agent-mcp-0.1.0.zip -Algorithm SHA256` 核对校验值，
   然后解压到固定目录，例如 `C:\Tools\mail-agent-mcp-0.1.0`。
2. 在解压后的、含有 `package.json` 的目录打开 PowerShell，运行：

   ```powershell
   npm ci --omit=dev
   node dist/enroll.js --help
   ```

   包内已包含 `dist`，无需构建。安装包没有源码安装脚本或开发依赖。
3. 要配置真实账号时，运行 `node dist/setup.js --skip-claude`，按本机浏览器向导操作。
   [中文说明](README.md)涵盖服务商、代理及安全发送。账号授权材料只在本机输入。
4. 在 MCP 客户端添加 stdio 服务，使用实际的绝对路径：

   ```json
   {
     "mcpServers": {
       "mail-agent-mcp": {
         "command": "node",
         "args": ["C:/Tools/mail-agent-mcp-0.1.0/dist/index.js"]
       }
     }
   }
   ```

   如果客户端找不到 Node.js，将 `command` 改为本机 `node.exe` 的绝对路径。
   客户端配置完成后重启对应 MCP 服务。

升级时安装到新目录并更新客户端路径。已有 `.imap-mcp`、`IMAP_MCP_*` 环境变量及
系统凭据目标保持兼容，无需因项目改名删除或复制账号凭据。请保留上游 MIT 许可证。
本版本只发布到 GitHub，未发布 npm 或 MCP Registry。

## English

Install Node.js **22.12+** and npm. Download the ZIP and `SHA256SUMS.txt` from the
[GitHub release](https://github.com/ertutio/mail-agent-mcp/releases/tag/v0.1.0),
verify the ZIP with `Get-FileHash` (or `sha256sum`), and extract it to a permanent
directory. In the directory containing `package.json`, run:

```sh
npm ci --omit=dev
node dist/enroll.js --help
```

The ZIP includes compiled `dist` files and web resources. Dependency installation
requires network access; Node.js and dependencies are not bundled. No build step
is needed. Hardened QQ/NetEase/Gmail enrollment requires Windows Credential
Manager. When ready to configure an account locally, run
`node dist/setup.js --skip-claude` and follow the browser wizard.

Configure your MCP client with `node` and the absolute path to `dist/index.js`, as
shown above. Use an absolute Node executable path if the client cannot resolve
`node`. Existing configuration and credential target names remain compatible.
See [README.en.md](README.en.md) for providers, proxies, and safe sending.

This GitHub-only release is not published to npm or MCP Registry. Release checks
use isolated profiles and synthetic inputs; they do not constitute real-provider
account or mailbox acceptance (T36).
