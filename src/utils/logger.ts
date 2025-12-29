/**
 * Sanitized logger with log level filtering
 * Provides credential redaction and verbosity control for all log output
 */

import type { SpawnMetadata } from '../connection/types.ts';
import { sanitizeForLogging } from './sanitizer.ts';

/**
 * Log level for filtering output
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Logger interface - subset of Console
 */
export type Logger = Pick<Console, 'info' | 'error' | 'warn' | 'debug'>;

// Log level hierarchy (higher number = more important)
const levels: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// Default to 'warn' - quiet library, only show warnings and errors
let currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'warn';

/**
 * Check if a log should be output based on current level
 */
function shouldLog(level: keyof Omit<typeof levels, 'silent'>): boolean {
  return levels[level] >= levels[currentLevel];
}

/**
 * Set the global log level
 * Users can call this to control library verbosity
 *
 * @param level - Log level: 'debug' (all), 'info', 'warn', 'error', 'silent' (none)
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Get current log level
 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/**
 * Create a sanitized logger with log level filtering
 */
function createSanitizedLogger(): Logger {
  const createLogMethod = (consoleMethod: 'info' | 'warn' | 'error' | 'debug') => {
    return (message: string, ...args: unknown[]) => {
      // Check if this log level should be output
      if (!shouldLog(consoleMethod)) {
        return;
      }

      const metadata = args.length > 0 && typeof args[0] === 'object' ? (args[0] as SpawnMetadata) : {};
      const { message: clean, meta: cleanMeta } = sanitizeForLogging(message, metadata);
      if (Object.keys(cleanMeta).length > 0) {
        console[consoleMethod](clean, cleanMeta);
      } else {
        console[consoleMethod](clean);
      }
    };
  };

  return {
    info: createLogMethod('info'),
    warn: createLogMethod('warn'),
    error: createLogMethod('error'),
    debug: createLogMethod('debug'),
  };
}

// Singleton instance - shared across all operations
export const logger = createSanitizedLogger();
