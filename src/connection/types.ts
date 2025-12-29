/**
 * Type definitions and type guards for CLI
 * Per project convention, all types and runtime validators in single file
 */

/**
 * JSON-serializable value type per MCP spec
 * Used for tool arguments and responses
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Tool arguments must be JSON-serializable
 */
export type ToolArguments = Record<string, JsonValue>;

/**
 * Spawn metadata for logging and sanitization
 */
export interface SpawnMetadata {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  pid?: number;
  [key: string]: JsonValue;
}

/**
 * MCP prompt argument structure
 * Explicit undefined for exactOptionalPropertyTypes compatibility
 */
export interface PromptArgument {
  name: string;
  description?: string | undefined;
  required?: boolean | undefined;
}

/**
 * Parsed MCP response structure
 */
export interface ParsedResponse {
  result?: JsonValue;
}

/**
 * Result object structure for error detection
 */
export interface ResultObject {
  type?: string;
  error?: string;
  message?: string;
}

// Type Guards (runtime validation functions)

/**
 * Type guard for JSON-serializable values
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return true;

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

/**
 * Type guard for parsed MCP response
 */
export function isParsedResponse(value: unknown): value is ParsedResponse {
  return typeof value === 'object' && value !== null && 'result' in value;
}

/**
 * Type guard for result object
 */
export function isResultObject(value: unknown): value is ResultObject {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (obj.type === undefined || typeof obj.type === 'string') && (obj.error === undefined || typeof obj.error === 'string') && (obj.message === undefined || typeof obj.message === 'string');
}
