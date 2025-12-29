/**
 * Path resolution utilities for cluster spawning.
 * Handles ~, relative paths, absolute paths, and special cases (URLs, npm packages, flags).
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Resolve a file path relative to a working directory.
 *
 * Handles three cases:
 * - `~` or `~/path` - Expands to home directory
 * - Absolute paths - Returns as-is
 * - Relative paths - Resolves relative to cwd
 *
 * @param filePath - The path to resolve
 * @param cwd - The working directory for resolving relative paths
 * @returns The resolved absolute path
 *
 * @example
 * resolvePath('~/config.json', '/unused')  // → '/home/user/config.json'
 * resolvePath('/absolute/path', '/unused') // → '/absolute/path'
 * resolvePath('./relative', '/base')       // → '/base/relative'
 */
export function resolvePath(filePath: string, cwd: string): string {
  // Expand ~ to home directory
  if (filePath === '~' || filePath.startsWith('~/')) {
    filePath = filePath.replace(/^~/, os.homedir());
  }

  // If absolute, return as-is
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  // Otherwise resolve relative to cwd
  return path.resolve(cwd, filePath);
}

/**
 * Resolve paths in command arguments array.
 *
 * Intelligently handles different argument types:
 * - Flags with paths: `--env-file=./path` → `--env-file=/absolute/path`
 * - Flags without paths: `--port=3000` → unchanged
 * - Command flags: `--verbose` → unchanged
 * - URLs: `http://example.com` → unchanged
 * - npm packages: `@scope/package` or `package-name` → unchanged
 * - Regular paths: `./script.js` → `/absolute/script.js`
 *
 * @param args - Array of command arguments
 * @param cwd - Working directory for resolving relative paths
 * @returns Array with paths resolved
 *
 * @example
 * resolveArgsPaths(['./bin/server.js', '--env-file=./config.env', '--port=3000'], '/home/user')
 * // → ['/home/user/bin/server.js', '--env-file=/home/user/config.env', '--port=3000']
 *
 * resolveArgsPaths(['@scope/package', 'https://example.com'], '/unused')
 * // → ['@scope/package', 'https://example.com'] (unchanged)
 */
export function resolveArgsPaths(args: string[], cwd: string): string[] {
  return args.map((arg) => {
    if (typeof arg !== 'string') {
      return arg;
    }

    // Check for flags with path values like --env-file=path, --config=path, etc.
    const flagMatch = arg.match(/^(--.+?)=(.+)$/);
    if (flagMatch) {
      const [, flag, value] = flagMatch;
      // Only resolve if the value looks like a path (contains ./ or ../ or / )
      if (value && value.includes('/')) {
        // Skip URLs in flag values
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
          return arg;
        }
        return `${flag}=${resolvePath(value, cwd)}`;
      }
      return arg; // Return as-is for non-path flag values like --port=3000
    }

    // Skip command-line flags, only resolve actual paths
    if (arg.startsWith('-')) {
      return arg; // Don't resolve command-line flags as paths
    }

    // Skip URLs (http://, https://, etc.)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(arg)) {
      return arg; // Return URLs as-is
    }

    // Skip npm package names (starting with @ or containing no path separators)
    if (arg.startsWith('@') || (!arg.includes('/') && !arg.includes('\\'))) {
      return arg; // Return npm package names as-is
    }

    // Regular arguments get resolved as paths
    return resolvePath(arg, cwd);
  });
}
