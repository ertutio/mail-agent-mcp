import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePackageVersion } from '../src/utils/package-version.js';
import { WebUIServer } from '../src/web/server.js';
import type { AddressInfo } from 'node:net';

// B6: /api/health hardcoded 1.0.0 while package.json says 0.1.0. The version
// now comes from the package manifest of the running module (one source for
// the MCP serverInfo and the health endpoint), resolved module-relative so
// the process working directory cannot change the answer.

const repoPackageVersion = (): string => {
  const { createRequire } = require('node:module') as typeof import('node:module');
  return createRequire(import.meta.url)('../package.json').version as string;
};

describe('B6: resolvePackageVersion', () => {
  it('B6-REPO-MODULE: resolves the real package version from a module inside the package', () => {
    const version = resolvePackageVersion(import.meta.url);
    expect(version).toBe(repoPackageVersion());
    expect(version).not.toBe('1.0.0');
  });

  it('B6-SYNTHETIC-MANIFEST: a release bump is reflected verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b6-pkg-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@ertutio/mail-agent-mcp', version: '9.9.9' }));
    // A module one level below the manifest (like dist/ inside the package).
    const nested = join(dir, 'dist');
    mkdirSync(nested);
    const moduleFile = join(nested, 'server.js');
    writeFileSync(moduleFile, 'export {};\n');
    expect(resolvePackageVersion(pathToFileURL(moduleFile).href)).toBe('9.9.9');
  });

  it('B6-NO-MANIFEST: outside any package the answer is unknown, never a guess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b6-empty-'));
    const moduleFile = join(dir, 'server.js');
    writeFileSync(moduleFile, 'export {};\n');
    expect(resolvePackageVersion(pathToFileURL(moduleFile).href)).toBe('unknown');
  });
});

describe('B6: /api/health reports the installed package version', () => {
  it('B6-HEALTH-ENDPOINT: version matches package.json and is not the old hardcoded 1.0.0', async () => {
    const wizard = new WebUIServer(0, { accountManager: {} as any, imapService: {} as any });
    const app = wizard.getApp();
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const token = new URL(wizard.getSetupUrl()).hash.slice(1);
    const session = new URLSearchParams(token).get('session')!;
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`;
      const response = await fetch(url, { headers: { 'x-mail-agent-session': session } });
      expect(response.status).toBe(200);
      const body = await response.json() as { status: string; version: string };
      expect(body.status).toBe('ok');
      expect(body.version).toBe(repoPackageVersion());
      expect(body.version).not.toBe('1.0.0');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    }
  });
});
