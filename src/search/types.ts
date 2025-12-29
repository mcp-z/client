/**
 * Search types for MCP capability discovery
 *
 * Enables agents to discover tools, prompts, and resources without
 * loading full schemas into context.
 */

import type { PromptArgument } from '../connection/types.ts';

/**
 * Types of MCP capabilities that can be searched
 */
export type CapabilityType = 'tool' | 'prompt' | 'resource';

/**
 * Fields that can be searched within capabilities
 */
export type SearchField = 'name' | 'description' | 'schema' | 'server';

/**
 * Options for configuring search behavior
 */
export interface SearchOptions {
  /**
   * Filter to specific capability types
   * @default ['tool', 'prompt', 'resource']
   */
  types?: CapabilityType[];

  /**
   * Filter to specific servers by name
   * @default all servers in config
   */
  servers?: string[];

  /**
   * Which fields to search within
   * @default ['name', 'description', 'schema']
   */
  searchFields?: SearchField[];

  /**
   * Maximum number of results to return
   * @default 20
   */
  limit?: number;

  /**
   * Minimum relevance score (0-1) for results
   * @default 0
   */
  threshold?: number;
}

/**
 * A single search result representing a matched capability
 */
export interface SearchResult {
  /** The type of capability */
  type: CapabilityType;

  /** The server that provides this capability */
  server: string;

  /** The name of the capability */
  name: string;

  /** Human-readable description (may be truncated) */
  description: string | undefined;

  /** Which fields matched the search query */
  matchedOn: string[];

  /** Relevance score from 0 (low) to 1 (high) */
  score: number;
}

/**
 * Complete search response
 */
export interface SearchResponse {
  /** The original search query */
  query: string;

  /** Matching results, sorted by relevance */
  results: SearchResult[];

  /** Total number of matches before limit was applied */
  total: number;
}

/**
 * Internal representation of a tool for indexing
 */
export interface IndexedTool {
  type: 'tool';
  server: string;
  name: string;
  description: string | undefined;
  /** Flattened searchable text from inputSchema property descriptions */
  schemaText: string;
}

/**
 * Internal representation of a prompt for indexing
 */
export interface IndexedPrompt {
  type: 'prompt';
  server: string;
  name: string;
  description: string | undefined;
  /** Flattened searchable text from arguments */
  argumentsText: string;
  arguments: PromptArgument[] | undefined;
}

/**
 * Internal representation of a resource for indexing
 */
export interface IndexedResource {
  type: 'resource';
  server: string;
  name: string;
  description: string | undefined;
  uri: string;
  mimeType: string | undefined;
}

/**
 * Union of all indexed capability types
 */
export type IndexedCapability = IndexedTool | IndexedPrompt | IndexedResource;

/**
 * Index containing all capabilities from connected servers
 */
export interface CapabilityIndex {
  /** All indexed capabilities */
  capabilities: IndexedCapability[];

  /** Servers that were indexed */
  servers: string[];

  /** When the index was created */
  indexedAt: Date;
}
