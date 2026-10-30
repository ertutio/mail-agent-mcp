import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyClaudeConfigUpdate, type ClaudeConfigIo } from '../src/utils/claude-config.js';

// T31 / ENG-02: the setup flow must never replace an unreadable or corrupt
// Claude Desktop config with an empty object. Case IDs:
//   T31-ENOENT-INIT — a missing file is initialized with just our entry
//   T31-BAD-JSON-PRESERVED — corrupt JSON fails and the original bytes stay
//   T31-UNREADABLE-PRESERVED — a refused read fails and the original stays
//   T31-PRESERVES-OTHERS — other mcpServers entries survive the update
//   T31-SAME-NAME-CHOICE — a differing same-name entry replaces only on consent
//   T31-ATOMIC-REPLACE — the write goes through temp+rename, never in place

const ENTRY = { command: 'node', args: ['C:\\synth\\dist\\index.js'] };

const tempConfigDir = (): string => join(tmpdir(), 't31-' + Math.random().toString(36).slice(2));

const realIo = (): ClaudeConfigIo => ({
  readFile: (p, e) => fs.readFile(p, e),
  writeFile: (p, d, o) => fs.writeFile(p, d, o),
  rename: (f, t) => fs.rename(f, t),
  mkdir: (dir, o) => fs.mkdir(dir, o),
});

describe('T31: Claude Desktop config safe write', () => {
  it('T31-ENOENT-INIT: a missing config is initialized with just our entry', async () => {
    const dir = tempConfigDir();
    const configPath = join(dir, 'claude_desktop_config.json');
    const result = await applyClaudeConfigUpdate(configPath, 'imap', ENTRY, { io: realIo() });
    expect(result).toEqual({ updated: true, created: true });
    const stored = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(stored.mcpServers.imap).toEqual(ENTRY);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('T31-BAD-JSON-PRESERVED: corrupt JSON is never overwritten', async () => {
    const dir = tempConfigDir();
    const configPath = join(dir, 'claude_desktop_config.json');
    await fs.mkdir(dir, { recursive: true });
    const original = '{ "mcpServers": { broken';
    await fs.writeFile(configPath, original);
    await expect(
      applyClaudeConfigUpdate(configPath, 'imap', ENTRY, { io: realIo() })
    ).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(configPath, 'utf-8')).toBe(original);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('T31-UNREADABLE-PRESERVED: a refused read is never overwritten', async () => {
    const dir = tempConfigDir();
    const configPath = join(dir, 'claude_desktop_config.json');
    await fs.mkdir(dir, { recursive: true });
    const original = '{ "mcpServers": {} }';
    await fs.writeFile(configPath, original);
    const io: ClaudeConfigIo = {
      ...realIo(),
      readFile: vi.fn(async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }),
    };
    await expect(
      applyClaudeConfigUpdate(configPath, 'imap', ENTRY, { io })
    ).rejects.toThrow(/could not be read/);
    expect(await fs.readFile(configPath, 'utf-8')).toBe(original);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('T31-PRESERVES-OTHERS: other MCP servers survive the update', async () => {
    const dir = tempConfigDir();
    const configPath = join(dir, 'claude_desktop_config.json');
    await fs.mkdir(dir, { recursive: true });
    const existing = {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\data'] },
        imap: { command: 'node', args: ['OLD'] },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
    const result = await applyClaudeConfigUpdate(configPath, 'imap', ENTRY, {
      io: realIo(),
      confirmOverwrite: async () => true,
    });
    expect(result.updated).toBe(true);
    const stored = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(stored.mcpServers.filesystem).toEqual(existing.mcpServers.filesystem);
    expect(stored.mcpServers.imap).toEqual(ENTRY);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('T31-SAME-NAME-CHOICE: a differing entry replaces only on explicit consent', async () => {
    const dir = tempConfigDir();
    const configPath = join(dir, 'claude_desktop_config.json');
    await fs.mkdir(dir, { recursive: true });
    const existing = { mcpServers: { imap: { command: 'node', args: ['OLD'] } } };
    await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
    const before = await fs.readFile(configPath, 'utf-8');

    // Declined: bytes unchanged.
    const declined = await applyClaudeConfigUpdate(configPath, 'imap', ENTRY, {
      io: realIo(),
      confirmOverwrite: async () => false,
    });
    expect(declined.updated).toBe(false);
    expect(declined.skipped).toBe(true);
    expect(await fs.readFile(configPath, 'utf-8')).toBe(before);

    // Approved: replaced.
    const approved = await applyClaudeConfigUpdate(configPath, 'imap', ENTRY, {
      io: realIo(),
      confirmOverwrite: async () => true,
    });
    expect(approved.updated).toBe(true);
    const stored = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(stored.mcpServers.imap).toEqual(ENTRY);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('T31-ATOMIC-REPLACE: the write lands via a temp file and rename', async () => {
    const dir = tempConfigDir();
    const configPath = join(dir, 'claude_desktop_config.json');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2));
    const rename = vi.fn(async (from: string, to: string) => fs.rename(from, to));
    const writeFile = vi.fn(async (p: string, d: string, o: { flag: 'wx' }) => fs.writeFile(p, d, o));
    const io: ClaudeConfigIo = { ...realIo(), rename, writeFile };
    await applyClaudeConfigUpdate(configPath, 'imap', ENTRY, { io });
    expect(rename).toHaveBeenCalledOnce();
    const [from, to] = rename.mock.calls[0]!;
    expect(to).toBe(configPath);
    expect(from).toMatch(/\.tmp$/);
    expect(from).not.toBe(configPath);
    const stored = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(stored.mcpServers.imap).toEqual(ENTRY);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
