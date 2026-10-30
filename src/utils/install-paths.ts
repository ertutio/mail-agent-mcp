import { fileURLToPath } from 'node:url';
import path from 'path';

/**
 * Resolves the bundled MCP server entry next to the running module
 * (T32 / ENG-03): dist/setup.js sits beside dist/index.js, so the registered
 * command points at the installation that is actually running — independent
 * of the process working directory the installer happened to start from.
 */
export function resolveBundledServerPath(moduleFileUrl: string, entryFile = 'index.js'): string {
  const moduleDir = path.dirname(fileURLToPath(moduleFileUrl));
  return path.join(moduleDir, entryFile);
}
