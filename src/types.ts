/**
 * MCP Configuration Types
 *
 * Auto-generated from schemas/servers.schema.json
 */

// Re-export all generated types
export type { MCPServers, McpServerEntry, StartConfig } from '../schemas/servers.d.ts';

/**
 * Transport type for server configuration
 * Standard MCP transport types matching Claude Code's schemas
 */
export type TransportType = 'stdio' | 'http' | 'sse-ide' | 'ws-ide' | 'sdk';
