import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { resolveArgsPaths, resolvePath } from '../../../src/utils/path-utils.ts';

describe('resolvePath', () => {
  it('should expand ~ to home directory', () => {
    const homeDir = os.homedir();

    assert.strictEqual(resolvePath('~', '/unused'), homeDir);
    assert.strictEqual(resolvePath('~/Documents', '/unused'), path.join(homeDir, 'Documents'));
    assert.strictEqual(resolvePath('~/Documents/file.txt', '/unused'), path.join(homeDir, 'Documents/file.txt'));
  });

  it('should not resolve ~ in middle of path', () => {
    assert.strictEqual(resolvePath('/some/path/~/test.txt', '/unused'), '/some/path/~/test.txt');
  });

  it('should preserve absolute paths', () => {
    assert.strictEqual(resolvePath('/absolute/path', '/unused'), '/absolute/path');
  });

  it('should resolve relative paths', () => {
    assert.strictEqual(resolvePath('regular/path', '/base'), path.resolve('/base', 'regular/path'));
    assert.strictEqual(resolvePath('./relative', '/base'), path.resolve('/base', './relative'));
  });
});

describe('resolveArgsPaths', () => {
  describe('npm package names', () => {
    it('should not resolve npm package names as file paths', () => {
      const args = ['@mcp-z/server', 'express', '@mcp-z/mcp-sheets', '--port', '3004', './local-file.js', '--env-file=./config.env'];
      const testDir = '/test/dir';

      const result = resolveArgsPaths(args, testDir);

      // Scoped package names should remain unchanged
      assert.strictEqual(result[0], '@mcp-z/server', 'Scoped packages should not be resolved as paths');
      assert.strictEqual(result[1], 'express', 'Regular packages should not be resolved as paths');
      assert.strictEqual(result[2], '@mcp-z/mcp-sheets', 'Scoped packages should remain unchanged');

      // Flags and flag values should remain unchanged
      assert.strictEqual(result[3], '--port', 'Flags should remain unchanged');
      assert.strictEqual(result[4], '3004', 'Flag values should remain unchanged');

      // But local files should still be resolved
      assert.ok(result[5]?.includes(testDir), 'Local files should be resolved');
      assert.ok(result[6]?.includes(testDir), 'Flag file paths should be resolved');
    });
  });

  describe('URL handling', () => {
    it('should not resolve URLs as file paths', () => {
      const args = ['http://localhost:3001/mcp', 'https://api.example.com/webhook', '@mcp-z/server', './local-file.js'];
      const testDir = '/test/dir';

      const result = resolveArgsPaths(args, testDir);

      // URLs should not be resolved as paths
      assert.strictEqual(result[0], 'http://localhost:3001/mcp', 'HTTP URLs should not be resolved as paths');
      assert.strictEqual(result[1], 'https://api.example.com/webhook', 'HTTPS URLs should not be resolved as paths');

      // npm packages should remain unchanged
      assert.strictEqual(result[2], '@mcp-z/server', 'npm packages should remain unchanged');

      // Local files should still be resolved
      assert.ok(result[3]?.includes(testDir), 'Local files should still be resolved');
    });

    it('should NOT resolve HTTP URLs in flag values as file paths', () => {
      const args = ['--config=http://example.com/config.json'];
      const cwd = '/home/user';

      const result = resolveArgsPaths(args, cwd);

      assert.strictEqual(result[0], '--config=http://example.com/config.json');
    });

    it('should NOT resolve HTTPS URLs in flag values as file paths', () => {
      const args = ['--api=https://api.example.com/v1'];
      const cwd = '/home/user';

      const result = resolveArgsPaths(args, cwd);

      assert.strictEqual(result[0], '--api=https://api.example.com/v1');
    });

    it('should NOT resolve WebSocket URLs in flag values as file paths', () => {
      const args = ['bin/server.js', '--port', '3000', '--url=ws://0.0.0.0:3000/mcp'];
      const cwd = '/Users/kevin/Dev/Projects/ai/mcp-z/servers/mcp-drive';

      const result = resolveArgsPaths(args, cwd);

      // First arg should be resolved as a path
      assert.strictEqual(result[0], '/Users/kevin/Dev/Projects/ai/mcp-z/servers/mcp-drive/bin/server.js');

      // Port flag should be unchanged
      assert.strictEqual(result[1], '--port');
      assert.strictEqual(result[2], '3000');

      // WebSocket URL should remain unchanged, not be converted to a file path
      assert.strictEqual(result[3], '--url=ws://0.0.0.0:3000/mcp', 'WebSocket URL should not be resolved as a file path');
    });
  });

  describe('file path resolution', () => {
    it('should still resolve actual file paths in flag values', () => {
      const args = ['--env-file=./config/.env', '--config=/absolute/path/config.json'];
      const cwd = '/home/user/project';

      const result = resolveArgsPaths(args, cwd);

      // Relative path should be resolved
      assert.strictEqual(result[0], '--env-file=/home/user/project/config/.env');

      // Absolute path should remain unchanged
      assert.strictEqual(result[1], '--config=/absolute/path/config.json');
    });
  });
});
