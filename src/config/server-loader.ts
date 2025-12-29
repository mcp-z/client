/**
 * Load server definitions from .mcp.json (data-driven)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Get package root: dist/esm/lib -> ../../../ or dist/cjs/lib -> ../../../
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '../../..');

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MCPConfiguration {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Load available servers from resources/.mcp.json
 */
export function loadAvailableServers(): MCPConfiguration {
  const configPath = path.join(packageRoot, 'resources/.mcp.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Server configuration not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(content) as MCPConfiguration;
}

/**
 * Get list of all available server names
 */
export function getAllServerNames(): string[] {
  const config = loadAvailableServers();
  return Object.keys(config.mcpServers);
}

/**
 * Parse comma-separated server list or "all"
 */
export function parseServerList(input: string): string[] {
  const allServers = getAllServerNames();

  if (input === 'all') {
    return allServers;
  }

  const requested = input.split(',').map((s) => s.trim());
  const invalid = requested.filter((s) => !allServers.includes(s));

  if (invalid.length > 0) {
    throw new Error(`Invalid server names: ${invalid.join(', ')}.\nAvailable: ${allServers.join(', ')}`);
  }

  return requested;
}

/**
 * Get server configuration by name
 */
export function getServerConfig(serverName: string): McpServerConfig {
  const config = loadAvailableServers();
  const serverConfig = config.mcpServers[serverName];

  if (!serverConfig) {
    throw new Error(`Unknown server: ${serverName}.\nAvailable: ${getAllServerNames().join(', ')}`);
  }

  return serverConfig;
}
