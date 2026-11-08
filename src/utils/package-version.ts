import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

/**
 * B6: the application version comes from the package manifest belonging to
 * the RUNNING module (the same module-relative rule as resolveBundledServerPath),
 * so /api/health and the MCP serverInfo report the installed version from one
 * source — independent of the process working directory, and in sync when a
 * release changes the version. Returns 'unknown' rather than a guessed number
 * when no manifest can be bound to the running module.
 */
export function resolvePackageVersion(moduleFileUrl: string): string {
  let dir = path.dirname(fileURLToPath(moduleFileUrl));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === '@ertutio/mail-agent-mcp' && typeof manifest.version === 'string' && manifest.version) {
        return manifest.version;
      }
    } catch {
      // no readable manifest here — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}
