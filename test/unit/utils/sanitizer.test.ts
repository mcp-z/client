import assert from 'assert';
import type { SpawnMetadata } from '../../../src/connection/types.ts';
import { sanitizeForLogging } from '../../../src/utils/sanitizer.ts';

describe('sanitizeForLogging', () => {
  describe('message redaction', () => {
    it('should redact key= patterns', () => {
      const message = 'Connecting with key=abc123def456';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      assert.strictEqual(result.message, 'Connecting with key=[REDACTED]');
    });

    it('should redact secret= patterns', () => {
      const message = 'Using secret=supersecretvalue123';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      assert.strictEqual(result.message, 'Using secret=[REDACTED]');
    });

    it('should redact token= patterns', () => {
      const message = 'Auth token=bearer_xyz789';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      assert.strictEqual(result.message, 'Auth token=[REDACTED]');
    });

    it('should redact password= patterns', () => {
      const message = 'Login password=mySecureP@ssw0rd';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      assert.strictEqual(result.message, 'Login password=[REDACTED]');
    });

    it('should redact auth= patterns', () => {
      const message = 'Header auth=Basic_abc123';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      assert.strictEqual(result.message, 'Header auth=[REDACTED]');
    });

    it('should redact colon delimiter patterns', () => {
      const message = 'Config key:secretvalue token:anothertoken';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      // Regex replaces entire pattern including delimiter
      assert.strictEqual(result.message, 'Config key=[REDACTED] token=[REDACTED]');
    });

    it('should be case-insensitive', () => {
      const message = 'Values KEY=test SECRET=data TOKEN=val PASSWORD=pwd';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      // Replacement text is lowercase in the regex
      assert.strictEqual(result.message, 'Values key=[REDACTED] secret=[REDACTED] token=[REDACTED] password=[REDACTED]');
    });

    it('should handle multiple credential patterns in one message', () => {
      const message = 'Server started key=abc secret=def token=ghi password=jkl auth=mno';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      assert.strictEqual(result.message, 'Server started key=[REDACTED] secret=[REDACTED] token=[REDACTED] password=[REDACTED] auth=[REDACTED]');
    });

    it('should not redact when pattern is part of larger word', () => {
      const message = 'keyword=test secretary=test tokenize=test';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      // The pattern /key[=:]\S+/ looks for literal "key=" not "keyword="
      assert.strictEqual(result.message, 'keyword=test secretary=test tokenize=test');
    });

    it('should preserve non-sensitive content', () => {
      const message = 'Server running on port 3000 with config file /etc/app.json';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      assert.strictEqual(result.message, message); // Unchanged
    });
  });

  describe('environment variable redaction', () => {
    it('should redact env vars with "key" in name', () => {
      const meta: SpawnMetadata = {
        env: {
          API_KEY: 'secret123',
          DATABASE_KEY: 'dbpass456',
          NORMAL_VAR: 'safe',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env?.API_KEY, '[REDACTED]');
      assert.strictEqual(result.meta.env?.DATABASE_KEY, '[REDACTED]');
      assert.strictEqual(result.meta.env?.NORMAL_VAR, 'safe');
    });

    it('should redact env vars with "secret" in name', () => {
      const meta: SpawnMetadata = {
        env: {
          CLIENT_SECRET: 'secret123',
          MY_SECRET_TOKEN: 'token456',
          PUBLIC_URL: 'https://example.com',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env?.CLIENT_SECRET, '[REDACTED]');
      assert.strictEqual(result.meta.env?.MY_SECRET_TOKEN, '[REDACTED]');
      assert.strictEqual(result.meta.env?.PUBLIC_URL, 'https://example.com');
    });

    it('should redact env vars with "token" in name', () => {
      const meta: SpawnMetadata = {
        env: {
          ACCESS_TOKEN: 'token123',
          OAUTH_TOKEN: 'oauth456',
          TIMEOUT: '5000',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env?.ACCESS_TOKEN, '[REDACTED]');
      assert.strictEqual(result.meta.env?.OAUTH_TOKEN, '[REDACTED]');
      assert.strictEqual(result.meta.env?.TIMEOUT, '5000');
    });

    it('should redact env vars with "password" in name', () => {
      const meta: SpawnMetadata = {
        env: {
          DB_PASSWORD: 'dbpass123',
          USER_PASSWORD: 'userpass456',
          PORT: '8080',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env?.DB_PASSWORD, '[REDACTED]');
      assert.strictEqual(result.meta.env?.USER_PASSWORD, '[REDACTED]');
      assert.strictEqual(result.meta.env?.PORT, '8080');
    });

    it('should redact env vars with "auth" in name', () => {
      const meta: SpawnMetadata = {
        env: {
          AUTH_HEADER: 'Bearer xyz',
          OAUTH_CLIENT_ID: 'client123',
          PATH: '/usr/bin',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env?.AUTH_HEADER, '[REDACTED]');
      assert.strictEqual(result.meta.env?.OAUTH_CLIENT_ID, '[REDACTED]');
      assert.strictEqual(result.meta.env?.PATH, '/usr/bin');
    });

    it('should redact env vars with "credential" in name', () => {
      const meta: SpawnMetadata = {
        env: {
          AWS_CREDENTIALS: 'aws123',
          GOOGLE_CREDENTIALS: 'google456',
          NODE_ENV: 'production',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env?.AWS_CREDENTIALS, '[REDACTED]');
      assert.strictEqual(result.meta.env?.GOOGLE_CREDENTIALS, '[REDACTED]');
      assert.strictEqual(result.meta.env?.NODE_ENV, 'production');
    });

    it('should be case-insensitive for env var names', () => {
      const meta: SpawnMetadata = {
        env: {
          api_key: 'lower123',
          CLIENT_SECRET: 'upper456',
          Access_Token: 'mixed789',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env?.api_key, '[REDACTED]');
      assert.strictEqual(result.meta.env?.CLIENT_SECRET, '[REDACTED]');
      assert.strictEqual(result.meta.env?.Access_Token, '[REDACTED]');
    });

    it('should handle missing env object', () => {
      const meta: SpawnMetadata = {
        command: 'node',
        args: ['server.js'],
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.env, undefined);
    });

    it('should handle empty env object', () => {
      const meta: SpawnMetadata = {
        env: {},
      };

      const result = sanitizeForLogging('message', meta);

      assert.deepStrictEqual(result.meta.env, {});
    });
  });

  describe('metadata cloning', () => {
    it('should not modify original metadata object', () => {
      const originalMeta: SpawnMetadata = {
        env: {
          API_KEY: 'secret123',
          PUBLIC_VAR: 'safe',
        },
        command: 'node',
        args: ['--key=test'],
      };

      const originalMetaCopy = JSON.parse(JSON.stringify(originalMeta));

      sanitizeForLogging('message', originalMeta);

      // Original should be unchanged
      assert.deepStrictEqual(originalMeta, originalMetaCopy);
      assert.strictEqual(originalMeta.env?.API_KEY, 'secret123');
    });

    it('should deeply clone nested objects', () => {
      const meta: SpawnMetadata = {
        env: {
          API_KEY: 'secret',
        },
      };

      const result = sanitizeForLogging('message', meta);

      // Modify sanitized version shouldn't affect original
      if (result.meta.env) {
        result.meta.env.NEW_VAR = 'added';
      }

      assert.strictEqual(meta.env?.NEW_VAR, undefined);
    });
  });

  describe('edge cases', () => {
    it('should handle empty message', () => {
      const result = sanitizeForLogging('', {});

      assert.strictEqual(result.message, '');
    });

    it('should handle credentials in URLs', () => {
      const message = 'Connecting to https://user:password=abc@example.com/api';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      // Should redact the password= part
      assert.ok(result.message.includes('[REDACTED]'));
      assert.ok(!result.message.includes('password=abc'));
    });

    it('should preserve metadata fields other than env', () => {
      const meta: SpawnMetadata = {
        command: 'node',
        args: ['server.js', '--port=3000'],
        cwd: '/app',
        pid: 12345,
        env: {
          API_KEY: 'secret',
        },
      };

      const result = sanitizeForLogging('message', meta);

      assert.strictEqual(result.meta.command, 'node');
      assert.deepStrictEqual(result.meta.args, ['server.js', '--port=3000']);
      assert.strictEqual(result.meta.cwd, '/app');
      assert.strictEqual(result.meta.pid, 12345);
    });

    it('should not match patterns with space after delimiter', () => {
      const message = 'Login key= secretvalue123 token =anothertoken';
      const meta: SpawnMetadata = {};

      const result = sanitizeForLogging(message, meta);

      // The pattern requires non-whitespace immediately after delimiter, so 'key= value' won't match
      // But 'key=value' would match
      assert.strictEqual(result.message, 'Login key= secretvalue123 token =anothertoken');
    });
  });
});
