/* eslint-disable */
/* Auto-generated from schemas/servers.schema.json - DO NOT EDIT */

/**
 * Map of server names to their configurations. Compatible with Claude Code mcpServers and VS Code servers formats.
 */
export interface MCPServers {
  [k: string]: McpServerEntry;
}
/**
 * Configuration for a single MCP server. Transport type is determined by the 'type' field (defaults to 'stdio').
 */
export interface McpServerEntry {
  /**
   * Transport type. Defaults to 'stdio' if omitted.
   */
  type?: 'stdio' | 'http' | 'sse-ide' | 'ws-ide' | 'sdk';
  /**
   * Command to execute (stdio transport)
   */
  command?: string;
  /**
   * Command arguments (stdio transport)
   */
  args?: string[];
  /**
   * Environment variables
   */
  env?: {
    [k: string]: string;
  };
  /**
   * Working directory
   */
  cwd?: string;
  /**
   * Server URL (http, sse-ide, ws-ide transports)
   */
  url?: string;
  /**
   * HTTP headers (http transport)
   */
  headers?: {
    [k: string]: string;
  };
  /**
   * Helper command for dynamic header generation (http transport)
   */
  headersHelper?: string;
  /**
   * IDE identifier (sse-ide, ws-ide transports)
   */
  ideName?: string;
  /**
   * Authentication token (ws-ide transport)
   */
  authToken?: string;
  /**
   * Whether IDE is running on Windows (sse-ide, ws-ide transports)
   */
  ideRunningInWindows?: boolean;
  /**
   * SDK name identifier (sdk transport)
   */
  name?: string;
  start?: StartConfig;
}
/**
 * MCP-Z extension: Auto-start configuration for HTTP servers
 */
export interface StartConfig {
  /**
   * Command to start the server
   */
  command: string;
  /**
   * Command arguments
   */
  args?: string[];
  /**
   * Environment variables
   */
  env?: {
    [k: string]: string;
  };
  /**
   * Working directory
   */
  cwd?: string;
}
