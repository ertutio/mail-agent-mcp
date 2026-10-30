import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Safe Claude Desktop config update (T31 / ENG-02).
 *
 * Contract:
 * - Only a missing file (ENOENT) starts from an empty config. A corrupt
 *   (non-JSON) or unreadable config is never overwritten — the helper fails
 *   with an actionable message and the original bytes stay untouched.
 * - The candidate is validated (object shape, mcpServers object) before any
 *   write; other MCP server entries are preserved.
 * - Replacing an existing same-name entry requires explicit user confirmation.
 * - The write is atomic: temp file + rename, so a crash never leaves a
 *   half-written config behind.
 */

export interface ClaudeServerEntry {
  command: string;
  args: string[];
}

export interface ClaudeConfigUpdateResult {
  updated: boolean;
  created: boolean;
  /** True when the same-name entry differed and the user declined the replace. */
  skipped?: boolean;
}

export interface ClaudeConfigIo {
  readFile: (path: string, encoding: 'utf-8') => Promise<string>;
  writeFile: (path: string, data: string, options: { flag: 'wx' }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dir: string, options: { recursive: true }) => Promise<string | undefined>;
}

interface ClaudeConfigResult {
  updated: boolean;
  created: boolean;
  skipped?: boolean;
}

const defaultIo: ClaudeConfigIo = {
  readFile: (p, encoding) => fs.readFile(p, encoding),
  writeFile: (p, data, options) => fs.writeFile(p, data, options),
  rename: (from, to) => fs.rename(from, to),
  mkdir: (dir, options) => fs.mkdir(dir, options),
};

export async function applyClaudeConfigUpdate(
  configPath: string,
  serverName: string,
  serverEntry: ClaudeServerEntry,
  options: {
    /** Resolves true when the user approves replacing a differing same-name entry. */
    confirmOverwrite?: (message: string) => Promise<boolean>;
    io?: ClaudeConfigIo;
  } = {},
): Promise<ClaudeConfigResult> {
  const io = options.io ?? defaultIo;
  await io.mkdir(path.dirname(configPath), { recursive: true });

  let config: unknown;
  let created = false;
  try {
    const raw = await io.readFile(configPath, 'utf-8');
    config = JSON.parse(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      config = {};
      created = true;
    } else if (error instanceof SyntaxError) {
      // Corrupt JSON: the user's original bytes must survive — fail instead
      // of "repairing" the config by replacing it with an empty object.
      throw new Error(
        `Existing Claude Desktop config at ${configPath} is not valid JSON; ` +
        'refusing to overwrite it. Fix or remove the file and rerun setup.',
        { cause: error },
      );
    } else {
      throw new Error(
        `Existing Claude Desktop config at ${configPath} could not be read (${code ?? 'unknown error'}); ` +
        'refusing to overwrite it. Fix the file permissions and rerun setup.',
        { cause: error },
      );
    }
  }

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(
      `Existing Claude Desktop config at ${configPath} is not a JSON object; refusing to modify it.`,
    );
  }
  const record = config as Record<string, unknown>;
  if (record.mcpServers !== undefined && (typeof record.mcpServers !== 'object' || record.mcpServers === null || Array.isArray(record.mcpServers))) {
    throw new Error(
      `Existing Claude Desktop config at ${configPath} has a non-object "mcpServers"; refusing to modify it.`,
    );
  }
  const servers = (record.mcpServers ?? {}) as Record<string, unknown>;

  const existing = servers[serverName];
  const differs =
    existing === undefined ||
    JSON.stringify(existing) !== JSON.stringify(serverEntry);
  if (existing !== undefined && differs) {
    const approved = options.confirmOverwrite
      ? await options.confirmOverwrite(
        `An existing "${serverName}" entry in ${configPath} differs from the new configuration. Replace it?`,
      )
      : false;
    if (!approved) {
      return { updated: false, created, skipped: true };
    }
  }
  if (!differs) {
    return { updated: false, created, skipped: true };
  }

  servers[serverName] = serverEntry;
  record.mcpServers = servers;

  // Atomic replace: write the candidate to a fresh temp file, then rename it
  // over the target so a crash never leaves a half-written config.
  const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
  await io.writeFile(temporary, JSON.stringify(record, null, 2), { flag: 'wx' });
  await io.rename(temporary, configPath);

  return { updated: true, created };
}
