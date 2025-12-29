/**
 * Minimal log sanitization for spawn operations
 * Redacts credentials from environment variables and command arguments
 */

import type { SpawnMetadata } from '../connection/types.ts';

/**
 * Sanitize log messages and metadata to prevent credential leakage
 *
 * Redacts common credential patterns:
 * - key=value, secret=value, token=value, password=value
 * - Environment variables with sensitive names
 *
 * @param message - Log message to sanitize
 * @param obj - Metadata object to sanitize
 * @returns Sanitized message and metadata
 */
export function sanitizeForLogging(message: string, obj: SpawnMetadata): { message: string; meta: SpawnMetadata } {
  // Redact common credential patterns in message
  const cleanMessage = message
    .replace(/key[=:]\S+/gi, 'key=[REDACTED]')
    .replace(/secret[=:]\S+/gi, 'secret=[REDACTED]')
    .replace(/token[=:]\S+/gi, 'token=[REDACTED]')
    .replace(/password[=:]\S+/gi, 'password=[REDACTED]')
    .replace(/auth[=:]\S+/gi, 'auth=[REDACTED]');

  // Deep clone and redact sensitive env var keys
  const cleanMeta = JSON.parse(JSON.stringify(obj));

  // Redact sensitive environment variable values
  if (cleanMeta.env && typeof cleanMeta.env === 'object') {
    for (const envKey of Object.keys(cleanMeta.env)) {
      if (/key|secret|token|password|auth|credential/i.test(envKey)) {
        cleanMeta.env[envKey] = '[REDACTED]';
      }
    }
  }

  return { message: cleanMessage, meta: cleanMeta };
}

export function sanitizeForLoggingFormatter() {
  return {
    log: (obj: SpawnMetadata) => {
      const message = (obj.msg || obj.message || '') as string;
      const { message: clean, meta } = sanitizeForLogging(message, obj);
      return { ...meta, msg: clean };
    },
  };
}
