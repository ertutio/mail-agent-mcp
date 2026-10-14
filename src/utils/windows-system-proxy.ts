import { execFileSync } from 'node:child_process';

/** Only use an enabled loopback proxy; never log registry values or credentials. */
export function windowsLoopbackProxy(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const value = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$p = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; if ($p.ProxyEnable -eq 1) { [Console]::Write($p.ProxyServer) }"], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
    const parts = value.split(';');
    const part = parts.find(p => p.startsWith('https=')) || parts.find(p => !p.includes('=')) || parts.find(p => p.startsWith('http='));
    const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(part?.replace(/^https?=/, '').trim() ?? '');
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return undefined;
    return `http://${match[1]}:${match[2]}`;
  } catch { return undefined; }
}
