/**
 * TDD tests for transport close() behavior
 *
 * These tests verify that close() properly waits for process/socket close.
 * Issue: https://github.com/modelcontextprotocol/typescript-sdk/issues/271
 * Fix: https://github.com/modelcontextprotocol/typescript-sdk/pull/818
 *
 * The SDK v1.24.3+ StdioClientTransport.close() now properly:
 * 1. Closes stdin to signal graceful shutdown
 * 2. Waits for process exit with timeout
 * 3. Falls back to SIGTERM then SIGKILL if needed
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'assert';
import type { ChildProcess } from 'child_process';

describe('StdioClientTransport close() behavior (SDK fix verification)', () => {
  it('should wait for process to exit before close() resolves', async () => {
    // Spawn a simple process that exits on stdin close
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['test/lib/servers/minimal-stdio.mjs'],
    });

    await transport.start();

    // Track timing
    const closeStart = Date.now();
    let processExited = false;

    // Access internal process to verify behavior
    const internal = transport as unknown as { _process?: ChildProcess };
    const proc = internal._process;
    assert.ok(proc, 'Transport should have spawned process');

    proc.on('exit', () => {
      processExited = true;
    });

    // Close the transport - this should wait for process exit
    await transport.close();
    const closeEnd = Date.now();

    // Verify process has exited by the time close() returns
    // Give a small buffer for event propagation
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(processExited, 'Process should have exited before close() resolved');

    // close() should complete in reasonable time (SDK uses 2s timeout)
    const duration = closeEnd - closeStart;
    assert.ok(duration < 3000, `close() took too long: ${duration}ms`);
  });

  it('should handle already-exited process gracefully', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['-e', 'process.exit(0)'], // Exits immediately
    });

    await transport.start();

    // Wait for process to exit on its own
    await new Promise((r) => setTimeout(r, 100));

    // close() should not hang or throw
    await transport.close();
  });

  it('should terminate hung process with SIGKILL after timeout', async () => {
    // Create a process that ignores SIGTERM
    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        '-e',
        `
        process.on('SIGTERM', () => { /* ignore */ });
        process.stdin.resume(); // Keep alive
        setInterval(() => {}, 10000);
      `,
      ],
    });

    await transport.start();

    const internal = transport as unknown as { _process?: ChildProcess };
    const proc = internal._process;
    assert.ok(proc, 'Transport should have spawned process');

    const closeStart = Date.now();
    await transport.close();
    const duration = Date.now() - closeStart;

    // Should complete within SDK's timeout (2s SIGTERM + 2s SIGKILL = ~4s max)
    assert.ok(duration < 5000, `close() should complete within timeout, took ${duration}ms`);

    // Process should be terminated
    assert.ok(proc.killed || proc.exitCode !== null, 'Process should be terminated');
  });

  it('should not leave zombie processes', async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['test/lib/servers/minimal-stdio.mjs'],
    });

    await transport.start();

    const internal = transport as unknown as { _process?: ChildProcess };
    const pid = internal._process?.pid;
    assert.ok(pid, 'Should have process PID');

    await transport.close();

    // Wait a bit for OS close
    await new Promise((r) => setTimeout(r, 100));

    // Verify process is gone - trying to signal it should fail
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      // If we get here, process still exists (zombie)
      assert.fail('Process should not exist after close()');
    } catch (err) {
      // ESRCH means "no such process" - this is expected
      assert.ok((err as NodeJS.ErrnoException).code === 'ESRCH', 'Process should be fully terminated');
    }
  });
});
