/**
 * Search implementation for MCP capability discovery
 *
 * Provides text-based search across tools, prompts, and resources
 * from connected MCP servers.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { PromptArgument } from '../connection/types.ts';
import type { CapabilityIndex, CapabilityType, IndexedCapability, IndexedPrompt, IndexedResource, IndexedTool, SearchField, SearchOptions, SearchResponse, SearchResult } from './types.ts';

export type CapabilityClient = Pick<Client, 'listTools' | 'listPrompts' | 'listResources'>;

const DEFAULT_LIMIT = 20;
const DEFAULT_THRESHOLD = 0;
const DEFAULT_TYPES: CapabilityType[] = ['tool', 'prompt', 'resource'];
const DEFAULT_SEARCH_FIELDS: SearchField[] = ['name', 'description', 'schema'];

/**
 * Extract searchable text from a JSON Schema's property descriptions
 */
function extractSchemaText(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return '';
  }

  const schema = inputSchema as {
    properties?: Record<string, { description?: string; name?: string }>;
    description?: string;
  };

  const parts: string[] = [];

  // Add schema-level description if present
  if (schema.description) {
    parts.push(schema.description);
  }

  // Add property names and descriptions
  if (schema.properties) {
    for (const [propName, prop] of Object.entries(schema.properties)) {
      parts.push(propName);
      if (prop && typeof prop === 'object' && prop.description) {
        parts.push(prop.description);
      }
    }
  }

  return parts.join(' ');
}

/**
 * Extract searchable text from prompt arguments
 */
function extractArgumentsText(args: PromptArgument[] | undefined): string {
  if (!args || !Array.isArray(args)) {
    return '';
  }

  return args
    .map((arg) => {
      const parts = [arg.name];
      if (arg.description) {
        parts.push(arg.description);
      }
      return parts.join(' ');
    })
    .join(' ');
}

/**
 * Build an index of capabilities from connected MCP clients
 */
export async function buildCapabilityIndex(clients: Map<string, CapabilityClient>): Promise<CapabilityIndex> {
  const capabilities: IndexedCapability[] = [];
  const servers: string[] = [];

  for (const [serverName, client] of clients) {
    servers.push(serverName);

    // Fetch all capabilities in parallel, handling errors gracefully
    const [toolsResult, promptsResult, resourcesResult] = await Promise.all([client.listTools().catch(() => null), client.listPrompts().catch(() => null), client.listResources().catch(() => null)]);

    // Index tools
    if (toolsResult?.tools) {
      for (const tool of toolsResult.tools) {
        capabilities.push({
          type: 'tool',
          server: serverName,
          name: tool.name,
          description: tool.description,
          schemaText: extractSchemaText(tool.inputSchema),
        } satisfies IndexedTool);
      }
    }

    // Index prompts
    if (promptsResult?.prompts) {
      for (const prompt of promptsResult.prompts) {
        capabilities.push({
          type: 'prompt',
          server: serverName,
          name: prompt.name,
          description: prompt.description,
          argumentsText: extractArgumentsText(prompt.arguments as PromptArgument[] | undefined),
          arguments: prompt.arguments as PromptArgument[] | undefined,
        } satisfies IndexedPrompt);
      }
    }

    // Index resources
    if (resourcesResult?.resources) {
      for (const resource of resourcesResult.resources) {
        capabilities.push({
          type: 'resource',
          server: serverName,
          name: resource.name,
          description: resource.description,
          uri: resource.uri,
          mimeType: resource.mimeType,
        } satisfies IndexedResource);
      }
    }
  }

  return {
    capabilities,
    servers,
    indexedAt: new Date(),
  };
}

/**
 * Calculate relevance score and matched fields for a capability against a query
 */
function scoreCapability(capability: IndexedCapability, queryTerms: string[], searchFields: SearchField[]): { score: number; matchedOn: string[] } {
  const matchedOn: string[] = [];
  let totalScore = 0;

  // Weights for different match types
  const EXACT_NAME_WEIGHT = 1.0;
  const PARTIAL_NAME_WEIGHT = 0.8;
  const DESCRIPTION_WEIGHT = 0.6;
  const SCHEMA_WEIGHT = 0.4;
  const SERVER_WEIGHT = 0.3;

  const nameLower = capability.name.toLowerCase();
  const descLower = (capability.description || '').toLowerCase();
  const serverLower = capability.server.toLowerCase();

  // Get schema/arguments text based on type
  let schemaTextLower = '';
  if (capability.type === 'tool') {
    schemaTextLower = capability.schemaText.toLowerCase();
  } else if (capability.type === 'prompt') {
    schemaTextLower = capability.argumentsText.toLowerCase();
  } else if (capability.type === 'resource') {
    // For resources, include URI and mimeType in searchable text
    schemaTextLower = `${capability.uri} ${capability.mimeType || ''}`.toLowerCase();
  }

  for (const term of queryTerms) {
    const termLower = term.toLowerCase();

    // Check name matches
    if (searchFields.includes('name')) {
      if (nameLower === termLower) {
        totalScore += EXACT_NAME_WEIGHT;
        if (!matchedOn.includes('name')) matchedOn.push('name');
      } else if (nameLower.includes(termLower)) {
        totalScore += PARTIAL_NAME_WEIGHT;
        if (!matchedOn.includes('name')) matchedOn.push('name');
      }
    }

    // Check description matches
    if (searchFields.includes('description') && descLower.includes(termLower)) {
      totalScore += DESCRIPTION_WEIGHT;
      if (!matchedOn.includes('description')) matchedOn.push('description');
    }

    // Check schema/arguments matches
    if (searchFields.includes('schema') && schemaTextLower.includes(termLower)) {
      totalScore += SCHEMA_WEIGHT;
      const fieldName = capability.type === 'tool' ? 'inputSchema' : capability.type === 'prompt' ? 'arguments' : 'uri';
      if (!matchedOn.includes(fieldName)) matchedOn.push(fieldName);
    }

    // Check server name matches
    if (searchFields.includes('server') && serverLower.includes(termLower)) {
      totalScore += SERVER_WEIGHT;
      if (!matchedOn.includes('server')) matchedOn.push('server');
    }
  }

  // Normalize score to 0-1 range based on number of terms
  const normalizedScore = queryTerms.length > 0 ? Math.min(1, totalScore / queryTerms.length) : 0;

  return { score: normalizedScore, matchedOn };
}

/**
 * Search for capabilities matching a query string
 */
export function searchCapabilities(index: CapabilityIndex, query: string, options: SearchOptions = {}): SearchResponse {
  const { types = DEFAULT_TYPES, servers, searchFields = DEFAULT_SEARCH_FIELDS, limit = DEFAULT_LIMIT, threshold = DEFAULT_THRESHOLD } = options;

  // Tokenize query into search terms
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);

  // If empty query, return empty results
  if (queryTerms.length === 0) {
    return { query, results: [], total: 0 };
  }

  // Filter and score capabilities
  const scoredResults: Array<{ capability: IndexedCapability; score: number; matchedOn: string[] }> = [];

  for (const capability of index.capabilities) {
    // Filter by type
    if (!types.includes(capability.type)) {
      continue;
    }

    // Filter by server
    if (servers && servers.length > 0 && !servers.includes(capability.server)) {
      continue;
    }

    // Score the capability
    const { score, matchedOn } = scoreCapability(capability, queryTerms, searchFields);

    // Apply threshold filter
    if (score >= threshold && matchedOn.length > 0) {
      scoredResults.push({ capability, score, matchedOn });
    }
  }

  // Sort by score descending
  scoredResults.sort((a, b) => b.score - a.score);

  // Get total before limiting
  const total = scoredResults.length;

  // Apply limit and transform to SearchResult
  const results: SearchResult[] = scoredResults.slice(0, limit).map(({ capability, score, matchedOn }) => ({
    type: capability.type,
    server: capability.server,
    name: capability.name,
    description: capability.description,
    matchedOn,
    score,
  }));

  return { query, results, total };
}

/**
 * Convenience function to search directly from connected clients
 * Builds index and performs search in one call
 */
export async function search(clients: Map<string, CapabilityClient>, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const index = await buildCapabilityIndex(clients);
  return searchCapabilities(index, query, options);
}
