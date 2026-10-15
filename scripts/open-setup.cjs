// Open a private localhost enrollment session in the OS default browser.
// Profile/proxy settings are inherited; no machine paths or ports are embedded.
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'dist', 'web', 'server.js');
if (!existsSync(entry)) throw new Error('Build Mail Agent MCP before opening setup.');
const args = process.allowedNodeEnvironmentFlags.has('--use-system-ca') ? ['--use-system-ca', entry] : [entry];
const child = spawn(process.execPath, args, {
  cwd: root, env: { ...process.env, PORT: '0' }, detached: true,
  stdio: 'ignore', windowsHide: true,
});
child.on('error', () => { console.error('Could not start the local setup server.'); process.exitCode = 1; });
child.unref();
