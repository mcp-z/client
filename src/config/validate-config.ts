import { Ajv, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import * as fs from 'fs';
import moduleRoot from 'module-root-sync';
import * as path from 'path';
import * as url from 'url';

// Import ajv-formats (CommonJS module - use createRequire for ESM compatibility)
const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));
const packageRoot = moduleRoot(__dirname);

/**
 * Validation result for servers configuration
 */
export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  warnings?: string[];
}

// Module-level cache for schema and validator
let schemaCache: object | null = null;
let validatorCache: ReturnType<Ajv['compile']> | null = null;

/**
 * Get servers schema (loads once from bundled file, then caches)
 */
function getSchema(): object {
  if (schemaCache) {
    return schemaCache;
  }

  const schemaPath = path.join(packageRoot, 'schemas/servers.schema.json');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Servers schema not found at: ${schemaPath}`);
  }

  schemaCache = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
  return schemaCache;
}

/**
 * Get compiled AJV validator (creates once, then caches)
 */
function getValidator(): ReturnType<Ajv['compile']> {
  if (validatorCache) {
    return validatorCache;
  }

  const schema = getSchema();
  const ajv = new Ajv({
    allErrors: true,
    verbose: true,
    strictSchema: false, // Allow non-standard keywords like "example"
  });

  // Add format validators (uri, email, etc.)
  addFormats(ajv);

  validatorCache = ajv.compile(schema);
  return validatorCache;
}

/**
 * Validate servers configuration against JSON Schema
 *
 * @param servers - Servers configuration object to validate (map of server names to configs)
 * @returns ValidationResult with valid flag, errors, and warnings
 */
export function validateServers(servers: unknown): ValidationResult {
  try {
    const validate = getValidator();
    const valid = validate(servers);

    if (!valid) {
      const errors =
        validate.errors?.map((e: ErrorObject) => {
          const path = e.instancePath || '(root)';
          return `${path}: ${e.message}`;
        }) || [];

      return { valid: false, errors };
    }

    const warnings: string[] = [];
    return { valid: true, warnings };
  } catch (err) {
    return {
      valid: false,
      errors: [`Configuration validation failed: ${(err as Error).message}`],
    };
  }
}
