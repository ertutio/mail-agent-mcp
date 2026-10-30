import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { resolveBundledServerPath } from '../src/utils/install-paths.js';

// T32 / ENG-03: the installation must be locatable from the module itself —
// never from the process working directory — and the stdio server must
// initialize from an arbitrary cwd with an isolated temp config.
//   T32-MODULE-PATH — the bundled entry resolves next to the running module
//   T32-STDIO-ANY-CWD — a fresh stdio initialize handshake succeeds from an
//     arbitrary cwd with a temp IMAP_MCP_CONFIG_DIR

describe('T32: installation path resolution and stdio init (ENG-03)', () => {
  it('T32-MODULE-PATH: resolves index.js beside the given module URL', () => {
    const distDir = path.resolve(tmpdir(), 'synth', 'mail-agent-mcp', 'dist');
    const setupUrl = pathToFileURL(path.join(distDir, 'setup.js')).href;
    expect(resolveBundledServerPath(setupUrl)).toBe(
      path.join(distDir, 'index.js')
    );
  });

  it('T32-MODULE-PATH-POSIX: works for posix-style URLs too', () => {
    const setupUrl = pathToFileURL('/opt/mail-agent-mcp/dist/setup.js').href;
    // The function returns a host-shaped path (path.join); what matters is
    // that the entry lands in the same dist directory as the given module.
    const resolved = resolveBundledServerPath(setupUrl);
    expect(path.basename(resolved)).toBe('index.js');
    expect(path.basename(path.dirname(resolved))).toBe('dist');
  });

  it('T32-STDIO-ANY-CWD: the server answers an initialize handshake from an arbitrary cwd', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 't32-config-'));
    const serverSource = path.join(process.cwd(), 'src', 'index.ts');
    expect(existsSync(serverSource)).toBe(true);

    // Run from the OS temp directory — deliberately NOT the project cwd. The
    // tsx loader is referenced by absolute path because module resolution from
    // an arbitrary cwd cannot find the project's node_modules.
    const tsxLoader = pathToFileURL(path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const child = spawn(process.execPath, [
      '--import', tsxLoader,
      serverSource,
    ], {
      cwd: tmpdir(),
      env: { ...process.env, IMAP_MCP_CONFIG_DIR: configDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 't32-stdio-check', version: '0.0.0' },
      },
    };
    child.stdin!.write(JSON.stringify(initialize) + '\n');

    const sawInitializeResponse = await Promise.race([
      new Promise<boolean>((resolve) => {
        const timer = setInterval(() => {
          if (stdout.includes('"serverInfo"')) {
            clearInterval(timer);
            resolve(true);
          }
        }, 100);
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
    ]);

    child.kill();
    // Windows note: 'close' never fires while tsx's esbuild worker holds the
    // stdio pipes, so wait on process 'exit' with a bounded fallback.
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    rmSync(configDir, { recursive: true, force: true });

    if (!sawInitializeResponse) {
      throw new Error(`no initialize response within 20s; stderr: ${stderr.slice(0, 4000)}`);
    }
    expect(stdout).toContain('"serverInfo"');
  }, 30_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
