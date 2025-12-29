/**
 * Search module for MCP capability discovery
 */

export type { CapabilityClient } from './search.ts';
export { buildCapabilityIndex, search, searchCapabilities } from './search.ts';
export type {
  CapabilityIndex,
  CapabilityType,
  IndexedCapability,
  IndexedPrompt,
  IndexedResource,
  IndexedTool,
  SearchField,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from './types.ts';
