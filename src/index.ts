/**
 * @mcp-z/client - MCP Client Library
 */

// Config types (from schema)
export type { McpServerEntry, StartConfig } from '../schemas/servers.d.ts';
// Auth - OAuth utilities
export { probeAuthCapabilities } from './auth/capability-discovery.ts';
export type { AuthCapabilities, CallbackResult, OAuthCallbackListenerOptions, OAuthFlowOptions, TokenSet } from './auth/index.ts';
export { InteractiveOAuthFlow } from './auth/interactive-oauth-flow.ts';
export { OAuthCallbackListener } from './auth/oauth-callback-listener.ts';
// Client helpers and lightweight overloads
export { decorateClient, type ManagedClient, type PromptArguments, type WrappedCallToolReturn, type WrappedGetPromptReturn, type WrappedReadResourceReturn } from './client-helpers.ts';
// Config - Configuration validation
export { type ValidationResult, validateServers } from './config/validate-config.ts';
// Connection - MCP client connection utilities (internal helpers exposed for advanced use)
export type { JsonValue, PromptArgument, ToolArguments } from './connection/types.ts';
// DCR - Dynamic Client Registration utilities
export { DcrAuthenticator } from './dcr/dcr-authenticator.ts';
export { DynamicClientRegistrar } from './dcr/dynamic-client-registrar.ts';
export type { ClientCredentials, DcrAuthenticatorOptions, DcrRegistrationOptions } from './dcr/index.ts';
export {
  type JsonValidator,
  type NativeCallToolResponse,
  type NativeGetPromptResponse,
  type NativeReadResourceResponse,
  PromptResponseError,
  PromptResponseWrapper,
  ResourceResponseError,
  ResourceResponseWrapper,
  ToolResponseError,
  ToolResponseWrapper,
} from './response-wrappers.ts';
export type { CapabilityClient, CapabilityIndex, CapabilityType, IndexedCapability, IndexedPrompt, IndexedResource, IndexedTool, SearchField, SearchOptions, SearchResponse, SearchResult } from './search/index.ts';
// Search - Capability discovery
export { buildCapabilityIndex, search, searchCapabilities } from './search/index.ts';
// Spawn - Server registry (v3 API)
export { type CloseResult, type CreateServerRegistryOptions, createServerRegistry, type Dialect, type ServerRegistry, type ServersConfig } from './spawn/spawn-servers.ts';
export type { TransportType } from './types.ts';
// Utils - Shared utilities
export { getLogLevel, type Logger, type LogLevel, logger, setLogLevel } from './utils/logger.ts';
export { resolveArgsPaths, resolvePath } from './utils/path-utils.ts';
