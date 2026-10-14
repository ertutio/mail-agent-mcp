# Mail Agent MCP

[中文](README.md) | **English**

[![CI](https://github.com/ertutio/mail-agent-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ertutio/mail-agent-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.12](https://img.shields.io/badge/node-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
![Status: Public Preview](https://img.shields.io/badge/status-public_preview-orange.svg)

Mail Agent MCP is a local-first TypeScript stdio MCP server that gives AI agents a controlled interface for Gmail, QQ Mail, NetEase, and other IMAP accounts, including cross-account search, reading, organization, attachments, and preview-confirmed SMTP sending.

This fork targets users in mainland China: domestic mail connects directly, Gmail requires a proxy, and one search returns a unified list. Gmail uses OAuth 2.0; QQ and NetEase use client authorization codes/passwords. On Windows, provider secrets stay in Windows Credential Manager instead of account JSON.

Based on [SinoEdwards/mail-agent-mcp](https://github.com/SinoEdwards/mail-agent-mcp), with upstream attribution retained.

## What's new in this fork

- Unified search across arbitrary numbers of QQ, NetEase personal/enterprise, Gmail and generic accounts, with source-account provenance and explicit partial results.
- Secure NetEase 163/126/yeah.net and Hangzhou enterprise enrollment.
- Domestic IMAP/SMTP connects directly; Gmail OAuth, token refresh and mail require a proxy without direct fallback.
- Portable environment configuration and dynamic Windows loopback system-proxy detection, without user-specific ports or paths.
- Runtime dependency security updates, duplicate account-name protection, password double-encryption correction, and an accurate OAuth callback status message.

> Release status: v0.1.1 Public Preview / Beta. Install from this GitHub repository; the package is not published to npm or the MCP Registry.

## Features

- Gmail OAuth 2.0 installed-app enrollment with PKCE, state validation, refresh-token support, and sanitized provider errors.
- QQ Mail IMAP/SMTP enrollment with hidden authorization-code input and rollback-safe credential repair.
- NetEase secure enrollment and cross-account search with bounded concurrency.
- IMAP search, read, recent mail, folders, flags, keywords, move, guarded delete, drafts, and attachments.
- Four safe-send tools: preview send, reply, forward, then explicit confirmation.
- Read-only mode and explicit MCP tool allowlists.
- Attachment path confinement with a configurable local root.
- Local stdio transport; no hosted service and no telemetry in project code.

## Behavior after security hardening

- Deletion tools only return a frozen preview with message samples, UIDs, counts, and permanent-deletion status. After explicit user review, call `imap_confirm_delete` with `confirmed: true`; previews expire in five minutes and changed UIDVALIDITY blocks execution. Add the confirmation tool to explicit write-enabled allowlists.
- QQ/Gmail credentials are restricted to canonical provider hosts and secure ports; foreign endpoints and disabled certificate verification are rejected.
- The setup API requires a temporary session and an exact same origin. Use the private launch link printed in the terminal; tab reloads retain its session, but a restarted server requires a new link. Do not share the link.
- Raw-message processing is capped at 25 MiB, body output at 100,000 characters, attachments at 20 per message, and outbound attachment bytes at 25 MiB total. PDF previews use isolated parsing, capped at 256 KiB, 20 pages, and five seconds; excessive input is rejected or previews are omitted.
- Pending send previews are capped at 100 with 50 MiB retained attachment bytes; expired attachment copies are automatically cleared.
- Account mutations use a cross-process lock and atomic replacement. After an abnormal writer exit, remove a leftover `.accounts.lock` only after verifying no configuration writer remains; never remove an active writer's lock.
- Unified search obtains matching UID lists and fetches at most 200 message records per batch, with 25 batches per folder per pass; it does not walk empty UID gaps. Lists over 100,000 matches require narrower filters. When `partial` is true, resume with returned `cursors`, identical filters and the same result limit, then merge and sort results across passes. Coverage is incomplete until all cursors are exhausted.

## Supported providers

| Provider | Authentication | Receive | Send | Enrollment |
| --- | --- | --- | --- | --- |
| Gmail / Google Workspace | OAuth 2.0 desktop client, PKCE, refresh token | IMAP | SMTP OAuth2 | Windows CLI |
| QQ Mail | QQ authorization code | IMAP | SMTP | Windows CLI |
| NetEase 163 / 126 / yeah.net | Client authorization password | IMAP | SMTP | Windows CLI |
| NetEase enterprise (Hangzhou preset) | Client authorization password | IMAP | SMTP | Windows CLI |
| Other IMAP/SMTP providers | Legacy password/app-password account path | IMAP | SMTP | Legacy tools/web setup |

The hardened Credential Manager enrollment path is currently Windows-only. Generic-provider compatibility remains available, but its legacy password store is not equivalent to Windows Credential Manager; see Security model.

## MCP tools

The server exposes 43 tools in full mode. The stable public prefix is imap_.

- Accounts: imap_add_account, imap_update_account, imap_list_accounts, imap_remove_account, imap_connect, imap_disconnect, imap_test_account.
- Read/search: imap_search_all_accounts, imap_search_emails, imap_get_email, imap_get_latest_emails, imap_find_thread_messages, imap_find_email_by_message_id.
- Folders and state: imap_list_folders, imap_folder_status, imap_create_folder, imap_get_unread_count, mark/read, flags, keywords, move and guarded delete tools.
- Attachments and drafts: imap_upload_file, imap_download_attachment, imap_save_draft.
- Safe sending: imap_preview_send_email, imap_preview_reply_to_email, imap_preview_forward_email, imap_confirm_send.
- Spam helpers: inspection, domain lists, and explicitly enabled mutation tools.

imap_send_email, imap_reply_to_email, and imap_forward_email are legacy handlers and are never registered. Sending requires a server-side frozen preview and a separate imap_confirm_send call with confirmed: true. See docs/agent-integration.md for a machine-readable contract and read/write boundaries.

## Quick start

Requirements: Windows 10/11 and Node.js 22.12 or newer for hardened Gmail/QQ/NetEase enrollment.

1. Clone the repository and enter it:

   ```powershell
   git clone https://github.com/ertutio/mail-agent-mcp.git
   Set-Location mail-agent-mcp
   ```

2. Install locked dependencies and build:

   ```powershell
   npm ci
   npm run build
   ```

3. Check the enrollment commands:

   ```powershell
   node dist/enroll.js --help
   ```

4. Enroll at least one provider in an interactive PowerShell terminal:

   ```powershell
   node dist/enroll.js gmail
   node dist/enroll.js qq
   node dist/enroll.js 163
   node dist/enroll.js 126
   node dist/enroll.js yeah
   node dist/enroll.js netease-enterprise
   ```

5. Register the local build with Codex CLI:

   ```powershell
   codex mcp add --env IMAP_MCP_READ_ONLY=true mail-agent -- node "$PWD\dist\index.js"
   codex mcp list
   ```

For read-only discovery:

```powershell
codex mcp add --env IMAP_MCP_READ_ONLY=true mail-agent-readonly -- node "$PWD\dist\index.js"
```

For other MCP clients, configure a stdio server whose command is node and whose argument is the absolute path to dist/index.js. Enrollment and startup must use the same Windows user and IMAP_MCP_CONFIG_DIR (default ~/.imap-mcp). Reconnect after changing the build or launch environment. Do not copy author-specific paths.

For a stricter read-only profile, use this 13-tool allowlist, excluding downloads and account writes:

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

The built-in 17-tool read-only set additionally permits attachment downloads and three spam analysis/list tools. Without restrictions the server registers 43 tools, including state-changing operations.
## Unified search and NetEase setup

Configure any number of QQ, Gmail, NetEase personal, and NetEase enterprise accounts with unique names. Gmail keeps its existing OAuth flow. On Windows, add NetEase accounts in a trusted interactive terminal:

```powershell
node dist/enroll.js 163
node dist/enroll.js 126
node dist/enroll.js yeah
node dist/enroll.js netease-enterprise
```

Run the appropriate command once per account; several distinct accounts from the same provider are supported. Use unique local names such as personal-163 or work-mail; accepting the default uses the email address. Secrets are entered with hidden prompts and stored in Windows Credential Manager. Do not pass authorization codes in command-line arguments or MCP messages. Duplicate names and duplicate credential-backed identities are rejected.

The enterprise preset uses `imaphz.qiye.163.com:993` and `smtphz.qiye.163.com:994`, both implicit TLS. Personal hosts are imap.163.com/smtp.163.com, imap.126.com/smtp.126.com, and imap.yeah.net/smtp.yeah.net, using port 993 for IMAP and 465 for SMTP. These presets require the provider's client authorization password and enabled IMAP access. The enterprise preset is not universal across deployments; confirm endpoints with your provider. Server or TLS changes on a credential-backed NetEase account fail before the secret is read.

Use `imap_search_all_accounts` for requests such as “Search all my mailboxes for project emails from the past week and summarize them with the source mailbox indicated.” The assistant converts the request into `query`, date and sender filters. Omit `accountNames` to include all configured accounts, or supply exact names for a subset. Accounts are scheduled with up to three workers, with a 15-second per-account and 40-second overall deadline; additional accounts are queued, not excluded by a fixed account-count limit. A deadline can yield partial coverage, which is always reported.

Results are sorted newest first with a global limit (default 50, maximum 200). Each result includes `accountId`, `accountName`, `folder`, and `uid`; equal Message-IDs in separate mailboxes retain their provenance. Default cross-folder searches skip Trash, Spam and Drafts, including Chinese folder names. The `accounts` field reports successful folders, failed folders, timeouts, and known match counts. `partial` indicates incomplete coverage and `truncated` indicates the global result cap. `totalFound` counts matches in completed UID pages for the current pass, not the entire mailbox when coverage is partial.

Search results contain metadata only. Before summarizing full message content, use `imap_get_email` with each result's account/folder/UID. The new tool is available in mailbox-read-only mode; add `imap_search_all_accounts` to any explicit tool allowlist. Adding it does not enable sending or mailbox mutation. Reading work mail sends returned information to the connected AI client/model under that client's data policy.

## Gmail setup

1. In Google Cloud Console, create or select an OAuth project.
2. Configure the OAuth consent screen. In Testing mode, add the Gmail address as a test user; Google may reject users who are not listed.
3. Create an OAuth client of type Desktop app. Copy its client ID and matching client secret. A downloaded OAuth JSON provides installed.client_id and installed.client_secret; the command expects values, not a JSON file path.
4. Run node dist/enroll.js gmail in an interactive Windows terminal.
5. Enter the Gmail address, local account name, client ID, and client secret when prompted. The secret prompt is hidden.
6. Complete the browser consent flow. The callback binds to a random 127.0.0.1 port and the same redirect URI and PKCE verifier are used for token exchange.

The browser callback confirms receipt of authorization, not completed enrollment. Wait for `Gmail account enrolled` in the terminal; token exchange or local persistence can still fail. Browser and Node proxy settings may differ.

The refresh token and client secret are stored under provider/account-bound Windows Credential Manager targets. accounts.json stores only non-secret metadata and target references. Gmail never falls back to password authentication.

Reauthorization: run node dist/enroll.js gmail-repair ACCOUNT_ID_OR_NAME. It obtains a fresh refresh token through browser OAuth, verifies authentication without reading mail, and restores the previous credential if verification fails.

Common failures:

- OAuth test user rejected: add the account under OAuth consent-screen test users or publish the app according to Google's rules.
- client_secret_required: use the client secret belonging to the same Desktop client ID.
- invalid_grant: restart enrollment; authorization codes are single-use and expire.
- no refresh token: revoke the app grant if necessary, then rerun consent with offline access.
- token refresh fails: verify proxy connectivity, client configuration, and that the grant was not revoked.
- Credential Manager failure: run in the same Windows user session and do not paste secrets into command arguments.

## QQ Mail setup

1. Enable IMAP and SMTP in QQ Mail settings.
2. Generate a QQ Mail authorization code. Do not use the normal QQ password.
3. Run node dist/enroll.js qq in an interactive Windows terminal.
4. Enter the address, account name, and hidden authorization code.

Repair an existing credential-backed QQ account:

    node dist/enroll.js qq-repair

With multiple QQ accounts, select one by account ID, exact name, or email:

    node dist/enroll.js qq-repair ACCOUNT_ID_OR_NAME

Reauthorize Gmail through the browser without recreating account metadata:

    node dist/enroll.js gmail-repair ACCOUNT_ID_OR_NAME

Repair uses the account's exact Credential Manager targets, performs authentication-only verification, and restores the previous credential if verification fails. It does not read mail or test SMTP. Never pipe or pass a QQ authorization code, OAuth code, refresh token, or client secret on the command line.

## Generic IMAP/SMTP setup (legacy)

Providers without a supported secure enrollment preset use the inherited generic account path. From a built clone, start the local setup UI without changing an MCP client configuration:

    node dist/setup.js --skip-claude --no-open

Open the localhost URL printed by the command, enter the provider's IMAP/SMTP hosts, ports, TLS settings, username, and provider-issued password or app password, then stop the setup process. The UI binds only to 127.0.0.1: do not expose it through LAN binding, port forwarding, tunnels, or a reverse proxy. It is a local setup aid, not a remote administration panel. The `imap_add_account` and `imap_update_account` tools can also configure this path, but doing so sends credentials through the MCP client/model; the local setup UI or startup environment overrides are safer.

This compatibility path does not use Windows Credential Manager. Its password may be AES-encrypted in `~/.imap-mcp/accounts.json` with a key stored under the same directory, so an attacker who can read both files can recover it. Gmail, QQ and supported NetEase users should use `dist/enroll.js` instead.

## Proxy setup

Gmail authorization opens in the browser; the token endpoint request is made by Node. Prefer a dedicated HTTP/HTTPS proxy before enrollment or server startup (replace this placeholder endpoint):

```powershell
$env:IMAP_MCP_GMAIL_PROXY = "http://proxy.example.test:8080"
$env:NO_PROXY = "127.0.0.1,localhost"
```

Configure the MCP client's process environment too. Standard variables remain supported:

    $env:HTTPS_PROXY = "http://proxy-host:proxy-port"
    $env:HTTP_PROXY = "http://proxy-host:proxy-port"
    $env:NO_PROXY = "127.0.0.1,localhost"
    $env:IMAP_MCP_MAIL_PROXY = "http://proxy-host:proxy-port"

QQ and NetEase accounts (163, 126, yeah.net and enterprise) connect directly for IMAP and SMTP, even when a global mail or system proxy is configured. Credential-backed QQ/NetEase accounts with custom server names follow the same policy. Gmail OAuth, token refresh, IMAP and SMTP require a proxy and never silently fall back to a direct connection; `NO_PROXY`, including `*`, cannot bypass this Gmail policy.

Use `IMAP_MCP_GMAIL_PROXY` for a dedicated Gmail HTTP/HTTPS proxy. Otherwise OAuth uses `HTTPS_PROXY`/`HTTP_PROXY` (lowercase also supported), then `IMAP_MCP_MAIL_PROXY`; mail connections prefer `IMAP_MCP_MAIL_PROXY` before standard proxy variables. On Windows, when no explicit setting exists, the plugin detects the currently enabled loopback HTTP system proxy and its port. Remote authenticated proxies and PAC files are not imported automatically; configure an explicit URL instead. On Linux and macOS, set environment variables in the process that launches the plugin. No user-specific port or path is embedded in the plugin. OAuth needs HTTP/HTTPS; a SOCKS mail override alone cannot proxy token requests.

Other providers retain the existing generic proxy/NO_PROXY behavior. Keep 127.0.0.1 and localhost in NO_PROXY for the local browser callback. An unavailable or missing Gmail proxy produces a clear error; domestic mail continues to work independently. Do not commit credential-bearing proxy URLs; TLS validation remains enabled. Network-level VPN/TUN routing is outside this application policy.

## Configuration reference

Existing process environment values take precedence over values loaded from `.env`. Provider-bound Gmail/QQ/NetEase authentication uses Windows Credential Manager; generic password overrides below apply only to legacy accounts. A non-empty `IMAP_MCP_ENABLED_TOOLS` allowlist takes precedence over `IMAP_MCP_READ_ONLY`.

| Variable | Purpose |
| --- | --- |
| `IMAP_MCP_ENABLED_TOOLS` | Comma-separated MCP tool allowlist; names may omit the `imap_` prefix. |
| `IMAP_MCP_READ_ONLY` | Truthy values (`1`, `true`, `yes`, `on`) expose the 17-tool mailbox-read-only subset. |
| `IMAP_DOWNLOAD_DIR` | Root for uploaded and downloaded attachment files. |
| `IMAP_MCP_CONFIG_DIR` | Optional account-metadata directory override for isolated profiles and clean-room testing; defaults to `~/.imap-mcp`. |
| `IMAP_MAX_UPLOAD_SIZE` | Maximum decoded attachment upload size in bytes; default 25 MiB. |
| `IMAP_UPLOAD_TTL_MS` | Lifetime of uploaded temporary attachment files; default 24 hours. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Gmail OAuth/token HTTP proxy settings; lowercase variants are also accepted. |
| `IMAP_MCP_MAIL_PROXY` | HTTP CONNECT, HTTPS, or SOCKS mail proxy for Gmail/generic providers; domestic direct routing takes precedence. |
| `IMAP_MCP_GMAIL_PROXY` | Dedicated Gmail proxy, preferred over other settings; use HTTP/HTTPS to cover both OAuth and mail. Domestic mail always connects directly. |
| `IMAP_SEARCH_FOLDER_TIMEOUT_MS` | Per-folder cross-folder-search deadline; defaults to 10000 ms. |
| `IMAP_SEARCH_ALL_TIMEOUT_MS` | Overall cross-folder-search deadline, including folder discovery; defaults to 30000 ms. |
| `IMAP_MCP_ACCOUNT_<NAME>_IMAP_USERNAME` / `_IMAP_PASSWORD` | Startup-only generic IMAP credential overrides. `<NAME>` is the account name uppercased with non-alphanumeric characters replaced by `_`. |
| `IMAP_MCP_ACCOUNT_<NAME>_SMTP_USERNAME` / `_SMTP_PASSWORD` | Startup-only generic SMTP credential overrides using the same normalized name. |
| `IMAP_SPAM_DOMAINS`, `IMAP_WHITELIST_DOMAINS` | Comma-separated local spam and allowlist domain additions. |
| `PORT` | Port for the legacy local setup UI only; default 3000. |

`IPQUALITYSCORE_API_KEY` is referenced by a legacy internal reputation helper, but no currently registered MCP tool calls that helper. Setting it does not enable an advertised capability.

The two cross-folder deadline variables affect single-account search, not unified search's fixed 15-second per-account and 40-second overall deadlines.

## Security model

- Gmail refresh tokens/client secrets and QQ/NetEase authorization codes use Windows Credential Manager on the hardened provider path.
- New entries use the MailAgentMCP namespace. Exact legacy CodexLab targets remain readable for compatibility; arbitrary target references are rejected.
- Removing a provider-bound account deletes its bound Credential Manager entries transactionally; a persistence failure restores both account metadata and credentials when possible.
- accounts.json contains provider/account metadata and credential target references, not those provider secrets.
- The connected MCP client and model can receive email bodies returned by read tools. Review that client's data policy.
- Sending is preview-confirmed. Within one running server process, each frozen draft permits at most one send attempt; an ambiguous SMTP outcome is not retried automatically. Draft IDs and state are in memory and do not survive a restart. Delete, move, flag, folder, account, spam-mutation, and draft tools still modify state.
- Set IMAP_MCP_READ_ONLY=true for a 17-tool mailbox-read-only surface, or IMAP_MCP_ENABLED_TOOLS for an explicit allowlist. This mode is not filesystem-read-only: imap_download_attachment may save a file inside the attachment root.
- Attachment paths are confined to IMAP_DOWNLOAD_DIR or, by default, the current user's Downloads/imap-attachments directory.
- The legacy generic-provider account path may store an AES-encrypted password in ~/.imap-mcp/accounts.json with a colocated local key. This protects against casual plaintext disclosure, not an attacker who can read both files. Use hardened provider enrollment for Gmail, QQ and supported NetEase accounts.
- The server does not intentionally write mail bodies to persistent storage, but pending safe-send content remains in process memory and your MCP client may retain tool results.
- No claim of complete security is made. A malicious process running as the same OS user can access many of the same local resources.

See SECURITY.md for threat boundaries and responsible disclosure.

## Architecture

    MCP client
        |
        | stdio JSON-RPC
        v
    MCP tool registry
        |-- AccountManager + credential resolver
        |-- ImapService / SmtpService
        |-- SafeSendService
        |-- attachment-root boundary
        v
    Gmail, QQ, NetEase or generic IMAP/SMTP

Configuration metadata lives under ~/.imap-mcp. Provider secrets are resolved into memory only when needed.

## Troubleshooting

- node or npm fails: confirm node --version is at least 22.12 and use npm ci.
- mail-agent-enroll prompts instead of showing help: rebuild with npm run build.
- Gmail token endpoint cannot connect: set HTTP_PROXY/HTTPS_PROXY before launching, keep 127.0.0.1 in NO_PROXY, and verify the proxy accepts HTTPS CONNECT.
- Gmail IMAP/SMTP cannot connect while OAuth works: verify the proxy permits mail CONNECT ports; a dedicated HTTP/HTTPS `IMAP_MCP_GMAIL_PROXY` can cover OAuth and mail. QQ/NetEase always connect directly, so inspect their network access and authorization codes separately.
- Browser success, terminal failure: browser consent is only one stage; check the Node proxy and terminal error. The terminal enrollment result is authoritative.
- Certificate validation fails: inspect certificate chains and trusted roots. If your Node version supports `--use-system-ca`, it can use the system trust store. Never disable TLS verification.
- Unified search incomplete: inspect accounts, partial and truncated; narrow dates or account selection rather than treating timeout results as complete.
- QQ authentication fails: generate a new authorization code and run qq-repair, adding an account selector when more than one QQ account exists.
- Gmail authorization or refresh fails: run gmail-repair for the affected account; the command obtains a fresh refresh token through browser OAuth.
- Credential target mismatch: do not edit accounts.json or reuse another account's target. Re-enroll locally.
- Attachment path rejected: use a path inside IMAP_DOWNLOAD_DIR.
- MCP client sees no tools: run npm run build, use the absolute dist/index.js path, and inspect IMAP_MCP_READ_ONLY or IMAP_MCP_ENABLED_TOOLS.

## FAQ

### Does this upload my mailbox to a hosted service?

No hosted mail service is part of this repository. The local MCP process connects to the configured provider. Tool results are still sent to your chosen MCP client/model.

### Can I use Gmail app passwords?

Not on the hardened Gmail path. It requires OAuth 2.0 and intentionally disables password fallback.

### Can an agent send without confirmation?

No through registered production tools. It must preview, receive a draft ID, and call imap_confirm_send with confirmed: true.

### Does it support macOS or Linux?

The MCP server and generic IMAP features may run there, with explicit proxy environment variables, but hardened Gmail/QQ/NetEase enrollment currently requires Windows Credential Manager.

### Is the npm package available?

No. Version 0.1.1 is installed from [this fork](https://github.com/ertutio/mail-agent-mcp); npm and MCP Registry publishing remain separate future release decisions.

## Development and validation

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

The code update passed 589 tests (one skipped), covering 25-account mixed search, partial failures/timeouts and varied proxy configurations. Production dependency audit found no vulnerabilities; this does not certify development dependencies or the entire system as secure. Separate local read-only checks covered QQ, 163, 126, NetEase enterprise and Gmail, with successful five-account unified search. Other enterprise deployments and networks may differ. No personal credentials or mail content are included in the repository.

## Roadmap

- Cross-platform secure credential backends.
- Migrate the legacy generic IMAP/SMTP password store to system credential backends.
- Signed releases and provider smoke workflows that never expose real credentials to public CI.
- Additional provider adapters only when they add real security or usability value.

## Contributing

Read AGENTS.md and CONTRIBUTING.md when present. Keep tool schemas, descriptions, docs, and tests synchronized. Use mocks and localhost fixtures; never put real mailbox credentials in tests or issues.

## License

MIT. See LICENSE.
