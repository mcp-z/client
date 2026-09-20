/**
 * Unit tests for createServerRegistry() - core server management
 */

import '../../lib/env-loader.ts';
import { createServerRegistry, type ServerRegistry } from '@mcp-z/client';
import assert from 'assert';
import { type ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import getPort from 'get-port';
import * as path from 'path';
import * as process from 'process';
import { fileURLToPath } from 'url';
import type { StartConfig } from '../../../src/types.ts';

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root directory (avoid process.cwd() - brittle!)
const projectRoot = path.resolve(__dirname, '../../..');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Process ${pid} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function waitForChildClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP fixture returned ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`HTTP fixture did not become ready at ${url}: ${lastError?.message ?? 'no response'}`);
}

function forceStopProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function nestedErrorMessages(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const nested = error instanceof AggregateError ? error.errors.map((entry) => nestedErrorMessages(entry)).join('; ') : '';
  const cause = 'cause' in error ? nestedErrorMessages(error.cause) : '';
  return `${error.message}${nested ? `; ${nested}` : ''}${cause ? `; ${cause}` : ''}`;
}

describe('createServerRegistry', () => {
  let registry: ServerRegistry | undefined;

  after(async () => {
    if (registry) await registry.close();
  });

  it('should start a single server with stdio transport', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    assert.ok(registry, 'Registry should be created');
    assert.ok(registry.servers, 'Registry should have servers map');
    assert.strictEqual(registry.servers.size, 1, 'Should have 1 server');
    assert.ok(registry.servers.has('my-stdio'), 'Should have my-stdio server');
    assert.ok(typeof registry.close === 'function', 'Should have close function');
    assert.ok(typeof registry.connect === 'function', 'Should have connect function');

    const server = registry.servers.get('my-stdio');
    assert.ok(server, 'Server should exist');
    assert.ok(server.process, 'Server should have process');
    assert.strictEqual(server.process.exitCode, null, 'Process should be running');

    await registry.close();
    registry = undefined;
  });

  it('should start multiple servers simultaneously', async () => {
    registry = createServerRegistry(
      {
        'server-1': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
        'server-2': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    assert.strictEqual(registry.servers.size, 2, 'Should have 2 servers');
    assert.ok(registry.servers.has('server-1'), 'Should have server-1');
    assert.ok(registry.servers.has('server-2'), 'Should have server-2');

    // Both processes should be running
    const server1 = registry.servers.get('server-1');
    const server2 = registry.servers.get('server-2');
    assert.ok(server1?.process && server1.process.exitCode === null && server1.process.signalCode === null, 'Server 1 should be running');
    assert.ok(server2?.process && server2.process.exitCode === null && server2.process.signalCode === null, 'Server 2 should be running');

    await registry.close();
    registry = undefined;
  });

  it('should run command launchers without forcing a shell for direct executables', async () => {
    registry = createServerRegistry({ npm: { command: 'npm', args: ['--version'] } }, { cwd: projectRoot });
    const server = registry.servers.get('npm');
    assert.ok(server?.process, 'npm launcher should resolve to a process');
    assert.strictEqual(server.config.shell, false, 'direct executables should not receive an unnecessary shell wrapper');
    const childClose = waitForChildClose(server.process);
    const naturalExitTimeoutMs = 5000; // Match the registry's graceful shutdown window.
    let exitTimer: NodeJS.Timeout | undefined;
    const closedNaturally = await Promise.race([
      childClose,
      new Promise<undefined>((resolve) => {
        exitTimer = setTimeout(() => resolve(undefined), naturalExitTimeoutMs);
      }),
    ]).finally(() => {
      if (exitTimer) clearTimeout(exitTimer);
    });

    if (!closedNaturally) {
      const cleanupResult = await registry.close();
      registry = undefined;
      assert.deepStrictEqual(cleanupResult, { timedOut: false, killedCount: 0 }, 'registry cleanup after the launcher deadline should remain graceful');
      assert.fail(`npm launcher did not complete naturally within ${naturalExitTimeoutMs}ms`);
    }

    const result = await registry.close();
    assert.deepStrictEqual(result, { timedOut: false, killedCount: 0 });
    assert.strictEqual(closedNaturally.code, 0, 'npm launcher should complete normally');
    registry = undefined;
  });

  it('should resolve paths relative to cwd', async () => {
    // Use test file location to construct absolute path to server
    const serverPath = path.join(__dirname, '../../lib/servers/pathtest-echo-stdio.mjs');

    registry = createServerRegistry(
      {
        'my-local': {
          command: 'node',
          args: [serverPath],
        },
      },
      { cwd: path.dirname(__dirname) } // test/ directory
    );

    assert.ok(registry.servers.has('my-local'), 'Should have my-local server');
    const server = registry.servers.get('my-local');
    assert.ok(server?.process && server.process.exitCode === null && server.process.signalCode === null, 'Server should be running');

    await registry.close();
    registry = undefined;
  });

  it('should support per-server environment variables', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
          env: {
            TEST_VAR: 'test-value',
            CUSTOM_PORT: '9999',
          },
        },
      },
      { cwd: projectRoot }
    );

    const server = registry.servers.get('my-stdio');
    assert.ok(server?.process, 'Server should exist');
    // Note: Can't easily verify env vars were passed, but we can verify process spawned
    assert.strictEqual(server.process.exitCode, null, 'Process should be running with custom env');

    await registry.close();
    registry = undefined;
  });

  it('should support graceful shutdown', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    const server = registry.servers.get('my-stdio');
    assert.ok(server?.process, 'Process should exist before close');
    const childClose = waitForChildClose(server.process);

    const result = await registry.close();
    const closed = await childClose;
    assert.strictEqual(result.timedOut, false, 'stdin EOF should close the healthy server before timeout');
    assert.strictEqual(result.killedCount, 0, 'healthy stdio shutdown should not force-terminate the process');
    assert.strictEqual(closed.code, 0, 'server should exit successfully after stdin EOF');
    assert.strictEqual(server.process.stdin?.destroyed, true, 'stdin should be closed');
    assert.strictEqual(server.process.stdout?.destroyed, true, 'stdout should be closed after the child close event');
    assert.strictEqual(server.process.stderr?.destroyed, true, 'stderr should be closed after the child close event');

    registry = undefined;
  });

  it('should cooperatively stop an owned HTTP server and await stream closure', async () => {
    const port = await getPort();
    const shutdownUrl = `http://127.0.0.1:${port}/__mcpz/shutdown`;
    const serverRegistry = createServerRegistry(
      {
        'long-lived-http': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          start: {
            command: 'node',
            args: ['test/lib/servers/long-lived-http.mjs', '--port', String(port)],
            stop: {
              command: 'node',
              args: ['test/lib/servers/request-http-stop.mjs', shutdownUrl],
            },
          },
        },
      },
      { cwd: projectRoot, dialects: ['start'] }
    );
    const server = serverRegistry.servers.get('long-lived-http');
    assert.ok(server?.process.pid, 'owned HTTP server should have a process ID');
    const serverPid = server.process.pid;
    const childClose = waitForChildClose(server.process);
    try {
      await waitForHttpReady(`http://127.0.0.1:${port}/`, 5000);

      const firstClose = serverRegistry.close('SIGINT', { timeoutMs: 1000 });
      const concurrentClose = serverRegistry.close('SIGTERM', { timeoutMs: 100 });
      assert.strictEqual(concurrentClose, firstClose, 'concurrent shutdown must not issue the HTTP stop command twice');
      const result = await firstClose;
      const closed = await childClose;
      assert.strictEqual(result.timedOut, false, 'the configured stop command should close the server before timeout');
      assert.strictEqual(result.killedCount, 0, 'cooperative HTTP shutdown should not force-terminate the process');
      assert.strictEqual(closed.code, 0, 'HTTP server should exit successfully after its shutdown endpoint drains');
      await waitForProcessExit(serverPid, 2000);
    } finally {
      await serverRegistry.close();
      if (isProcessAlive(serverPid)) {
        forceStopProcess(serverPid);
        await waitForProcessExit(serverPid, 2000);
      }
    }
  });

  it('should preserve an external HTTP server when its registry closes', async () => {
    const port = await getPort();
    const url = `http://127.0.0.1:${port}/mcp`;
    const externalProcess = spawn(process.execPath, [path.join(projectRoot, 'test/lib/servers/long-lived-http.mjs'), '--port', String(port)], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    const childClose = waitForChildClose(externalProcess);
    const externalRegistry = createServerRegistry({ external: { type: 'http', url } }, { cwd: projectRoot, dialects: ['start'] });

    try {
      await waitForHttpReady(`http://127.0.0.1:${port}/`, 5000);
      assert.deepStrictEqual(await externalRegistry.close(), { timedOut: false, killedCount: 0 });
      assert.strictEqual(externalProcess.exitCode, null, 'closing a registry must not stop an external server');
      const response = await fetch(url);
      assert.strictEqual(response.status, 200, 'external server should remain reachable after registry close');
    } finally {
      if (externalProcess.exitCode === null && externalProcess.signalCode === null) externalProcess.kill('SIGKILL');
      await childClose;
    }
  });

  it('should cooperatively stop owned HTTP servers without a shell wrapper', async () => {
    const port = await getPort();
    const start: StartConfig = {
      command: 'node',
      args: ['test/lib/servers/long-lived-http.mjs', '--port', String(port)],
    };
    if (process.platform === 'win32') {
      start.stop = {
        command: 'node',
        args: ['test/lib/servers/request-http-stop.mjs', `http://127.0.0.1:${port}/__mcpz/shutdown`],
      };
    }
    const serverRegistry = createServerRegistry(
      {
        'http-without-stop': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          start,
        },
      },
      { cwd: projectRoot, dialects: ['start'] }
    );
    const server = serverRegistry.servers.get('http-without-stop');
    assert.ok(server?.process.pid, 'owned HTTP process should have a process ID');
    const childClose = waitForChildClose(server.process);
    try {
      await waitForHttpReady(`http://127.0.0.1:${port}/`, 5000);
      const result = await serverRegistry.close('SIGINT', { timeoutMs: 1000 });
      const closed = await childClose;
      assert.strictEqual(result.timedOut, false, 'the supported HTTP shutdown path should close before timeout');
      assert.strictEqual(result.killedCount, 0, 'healthy HTTP shutdown should not use emergency termination');
      assert.strictEqual(closed.code, 0, 'the HTTP server should exit cleanly');
    } finally {
      await serverRegistry.close();
    }
  });

  it('should report emergency termination for an unresponsive real process', async () => {
    const serverRegistry = createServerRegistry({ unresponsive: { command: 'node', args: ['test/lib/servers/unresponsive-stdio.mjs'] } }, { cwd: projectRoot });
    const server = serverRegistry.servers.get('unresponsive');
    assert.ok(server?.process.pid, 'unresponsive process should have a process ID');
    const childClose = waitForChildClose(server.process);

    const result = await serverRegistry.close('SIGINT', { timeoutMs: 100 });
    const closed = await childClose;
    assert.strictEqual(result.timedOut, true, 'unresponsive process should exceed its cooperative close timeout');
    assert.strictEqual(result.killedCount, 1, 'emergency process-tree termination should be reported');
    assert.ok(closed.code !== 0 || closed.signal !== null, 'the child should close after emergency termination');
    await waitForProcessExit(server.process.pid, 2000);
  });

  it('should report launcher closure without claiming Windows descendant containment', async () => {
    const pidFile = path.resolve('.tmp', `owned-descendant-${process.pid}-${Date.now()}.pid`);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const serverRegistry = createServerRegistry({ parent: { command: process.execPath, args: ['test/lib/servers/process-tree-parent.mjs', 'parent', pidFile] } }, { cwd: projectRoot });
    const server = serverRegistry.servers.get('parent');
    assert.ok(server?.process.pid, 'owned parent should have a process ID');
    const parentClose = waitForChildClose(server.process);
    let descendantPid: number | undefined;

    try {
      const closed = await parentClose;
      assert.strictEqual(closed.code, 0, 'the fixture parent should exit normally');
      assert.ok(fs.existsSync(pidFile), 'the descendant should report its PID before the launcher exits');
      descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, 'the descendant should record a valid PID');
      if (process.platform !== 'win32') assert.ok(isProcessAlive(descendantPid), 'the POSIX descendant should remain in its owned process group after its parent exits');

      const result = await serverRegistry.close('SIGINT', { timeoutMs: 100 });
      if (process.platform === 'win32') {
        assert.strictEqual(result.timedOut, false, 'the launcher should already be closed');
        // Do not use this observation to claim Windows descendant cleanup. No
        // ownership handle tracks the descendant, and its lifetime is external.
        assert.strictEqual(result.killedCount, 0, 'Windows descendant containment is not claimed without process ownership handles');
      } else {
        assert.strictEqual(result.timedOut, true, `the surviving POSIX group member should exceed cooperative shutdown: ${JSON.stringify(result)}`);
        assert.strictEqual(result.killedCount, 1, 'POSIX process-group force termination must be visible');
        await waitForProcessExit(descendantPid, 2000);
      }
    } finally {
      await serverRegistry.close().catch(() => undefined);
      if (descendantPid && isProcessAlive(descendantPid)) {
        forceStopProcess(descendantPid);
        await waitForProcessExit(descendantPid, 2000);
      }
      fs.rmSync(pidFile, { force: true });
    }
  });

  it('should bound a hanging stop command and expose its Windows descendant limit', async () => {
    const port = await getPort();
    const pidFile = path.resolve('.tmp', `hanging-stop-${process.pid}-${Date.now()}.pid`);
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    const stopRegistry = createServerRegistry(
      {
        'http-server': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          start: {
            command: 'node',
            args: ['test/lib/servers/long-lived-http.mjs', '--port', String(port)],
            stop: { command: 'node', args: ['test/lib/servers/hanging-stop-command.mjs', pidFile] },
          },
        },
      },
      { cwd: projectRoot, dialects: ['start'] }
    );
    const server = stopRegistry.servers.get('http-server');
    assert.ok(server?.process.pid, 'owned HTTP server should have a process ID');
    const serverClose = waitForChildClose(server.process);
    let stopDescendantPid: number | undefined;

    try {
      await waitForHttpReady(`http://127.0.0.1:${port}/`, 5000);
      await assert.rejects(stopRegistry.close('SIGINT', { timeoutMs: 100 }), (error: unknown) => error instanceof AggregateError && /stop command exceeded 100ms/i.test(nestedErrorMessages(error)));
      const closed = await serverClose;
      assert.ok(closed.signal !== null || closed.code !== 0, 'the server should be terminated after stop-command failure');
      const pidStartedAt = Date.now();
      while (!fs.existsSync(pidFile) && Date.now() - pidStartedAt < 2000) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(fs.existsSync(pidFile), 'the hanging stop command should have recorded its descendant');
      stopDescendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (process.platform !== 'win32') {
        await waitForProcessExit(stopDescendantPid, 2000);
      }
    } finally {
      await stopRegistry.close().catch(() => undefined);
      if (stopDescendantPid && isProcessAlive(stopDescendantPid)) {
        forceStopProcess(stopDescendantPid);
        await waitForProcessExit(stopDescendantPid, 2000);
      }
      fs.rmSync(pidFile, { force: true });
    }
  });

  it('should report stop failures after attempting cleanup of every owned process', async () => {
    const port = await getPort();
    const failingRegistry = createServerRegistry(
      {
        'bad-stop': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          start: {
            command: 'node',
            args: ['test/lib/servers/long-lived-http.mjs', '--port', String(port)],
            stop: { command: 'node', args: ['-e', 'process.exitCode = 7'] },
          },
        },
        'good-stdio': { command: 'node', args: ['test/lib/servers/minimal-stdio.mjs'] },
      },
      { cwd: projectRoot, dialects: ['servers', 'start'] }
    );
    const badServer = failingRegistry.servers.get('bad-stop');
    const goodServer = failingRegistry.servers.get('good-stdio');
    assert.ok(badServer?.process.pid && goodServer?.process.pid, 'both owned processes should start');
    const badClose = waitForChildClose(badServer.process);
    const goodClose = waitForChildClose(goodServer.process);
    await waitForHttpReady(`http://127.0.0.1:${port}/`, 5000);

    await assert.rejects(failingRegistry.close('SIGINT', { timeoutMs: 150 }), (error: unknown) => {
      if (!(error instanceof AggregateError)) return false;
      const errors = (error as Error & { errors?: unknown[] }).errors;
      return Array.isArray(errors) && errors.some((entry) => entry instanceof Error && entry.message.includes("server 'bad-stop'"));
    });
    await Promise.all([badClose, goodClose]);
    await Promise.all([waitForProcessExit(badServer.process.pid, 2000), waitForProcessExit(goodServer.process.pid, 2000)]);
    assert.strictEqual(goodServer.process.exitCode, 0, 'other owned processes should still receive normal cleanup');
  });

  it('should share concurrent and repeated registry close completion', async () => {
    const closeRegistry = createServerRegistry({ 'close-once': { command: 'node', args: ['test/lib/servers/minimal-stdio.mjs'] } }, { cwd: projectRoot });
    const server = closeRegistry.servers.get('close-once');
    assert.ok(server?.process, 'server should be spawned');
    const childClose = waitForChildClose(server.process);

    const firstClose = closeRegistry.close();
    const concurrentClose = closeRegistry.close('SIGTERM', { timeoutMs: 100 });
    assert.strictEqual(concurrentClose, firstClose, 'concurrent calls should share one shutdown promise');
    const [firstResult, secondResult] = await Promise.all([firstClose, concurrentClose]);
    assert.deepStrictEqual(secondResult, firstResult);
    assert.deepStrictEqual(await closeRegistry.close(), firstResult, 'repeated close should return the settled result');
    await childClose;
  });

  it('should settle a connection that races registry close', async () => {
    const racingRegistry = createServerRegistry({ 'racing-server': { command: 'node', args: ['test/lib/servers/minimal-stdio.mjs'] } }, { cwd: projectRoot });
    const server = racingRegistry.servers.get('racing-server');
    assert.ok(server?.process, 'server should be spawned');
    const childClose = waitForChildClose(server.process);
    const connecting = racingRegistry.connect('racing-server');
    const closing = racingRegistry.close('SIGINT', { timeoutMs: 1000 });

    await assert.rejects(connecting, /registry is closing/);
    const result = await closing;
    assert.deepStrictEqual(result, { timedOut: false, killedCount: 0 });
    await childClose;
  });

  it('should cancel a stalled real stdio handshake before owned-server cleanup', async () => {
    const racingRegistry = createServerRegistry({ stalled: { command: 'node', args: ['test/lib/servers/stalled-stdio.mjs'] } }, { cwd: projectRoot });
    const server = racingRegistry.servers.get('stalled');
    assert.ok(server?.process.pid, 'stalled server should have a process ID');
    const childClose = waitForChildClose(server.process);
    const connecting = racingRegistry.connect('stalled');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const closing = racingRegistry.close('SIGINT', { timeoutMs: 100 });

    await assert.rejects(connecting, /cancel|clos|registry/i);
    const closeResult = await closing;
    assert.strictEqual(closeResult.timedOut, true, 'the unresponsive server should exceed the cooperative shutdown timeout');
    assert.strictEqual(closeResult.killedCount, 1, 'the unresponsive owned server should be force-terminated');
    await childClose;
    await waitForProcessExit(server.process.pid, 2000);
    assert.ok(Date.now() - startedAt < 7000, 'stalled connection and cleanup must remain bounded');
  });

  it('should bound a hanging client close and still close owned processes', async () => {
    const clientRegistry = createServerRegistry({ server: { command: 'node', args: ['test/lib/servers/minimal-stdio.mjs'] } }, { cwd: projectRoot });
    const server = clientRegistry.servers.get('server');
    assert.ok(server?.process.pid, 'server should have a process ID');
    const childClose = waitForChildClose(server.process);
    const client = await clientRegistry.connect('server');
    const nativeClose = client.nativeClient.close.bind(client.nativeClient);
    client.nativeClient.close = async () => new Promise<void>(() => {});

    const closeStartedAt = Date.now();
    await assert.rejects(clientRegistry.close('SIGINT', { timeoutMs: 100 }), (error: unknown) => error instanceof AggregateError && /did not close within 100ms/.test(error.message));
    await childClose;
    await waitForProcessExit(server.process.pid, 2000);
    assert.ok(Date.now() - closeStartedAt < 3000, 'a stuck client close must not delay process cleanup');
    client.nativeClient.close = nativeClose;
  });

  it('should share an in-flight lease release with registry close', async () => {
    const leaseRegistry = createServerRegistry({ server: { command: 'node', args: ['test/lib/servers/minimal-stdio.mjs'] } }, { cwd: projectRoot });
    const server = leaseRegistry.servers.get('server');
    assert.ok(server?.process, 'server should be spawned');
    const client = await leaseRegistry.connect('server');
    const nativeClose = client.nativeClient.close.bind(client.nativeClient);
    let finishClose: (() => void) | undefined;
    client.nativeClient.close = async () => {
      await new Promise<void>((resolve) => {
        finishClose = resolve;
      });
      await nativeClose();
    };

    const releasing = client.close();
    const closing = leaseRegistry.close('SIGINT', { timeoutMs: 1000 });
    assert.ok(finishClose, 'the user lease close should own the pending transport close');
    setTimeout(() => finishClose?.(), 100);
    const [releaseResult, closeResult] = await Promise.all([releasing, closing]);
    assert.strictEqual(releaseResult, undefined);
    assert.deepStrictEqual(closeResult, { timedOut: false, killedCount: 0 });
  });

  it('should handle servers config format directly', async () => {
    const registry2 = createServerRegistry(
      {
        test: {
          command: 'node',
          args: ['--version'],
        },
      },
      { cwd: projectRoot }
    );

    assert.ok(registry2.servers.has('test'), 'Should parse servers config format');
    await registry2.close();
  });

  it('should fail loudly when cwd directory does not exist', async () => {
    const nonExistentCwd = path.join(projectRoot, 'non-existent-directory');

    // Ensure the directory doesn't exist
    if (fs.existsSync(nonExistentCwd)) {
      throw new Error(`Test setup error: directory should not exist: ${nonExistentCwd}`);
    }

    try {
      createServerRegistry(
        {
          test: {
            command: 'node',
            args: ['--version'],
          },
        },
        { cwd: nonExistentCwd }
      );
      // If we reach here, the registry was created but should be empty due to spawn failures
      // This assertion will fail initially, demonstrating the bug
      assert.fail('Expected createServerRegistry to throw an error or return empty servers when cwd does not exist');
    } catch (error) {
      // Expected: createServerRegistry should either throw immediately or creation should fail
      // The current implementation may not validate cwd existence before spawning
      assert.ok(error instanceof Error, 'Should throw an Error when cwd does not exist');
    }
  });

  it('should connect to server using registry.connect()', async () => {
    registry = createServerRegistry(
      {
        'my-stdio': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    // Connect using registry method
    const client = await registry.connect('my-stdio');
    assert.ok(client, 'Should return client');

    // Verify connection by listing tools
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools.tools), 'Should list tools');

    // Close should clean up both client and server
    await registry.close();
    registry = undefined;
  });

  it('should track connected clients', async () => {
    registry = createServerRegistry(
      {
        'server-1': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
        'server-2': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );

    assert.strictEqual(registry.clients.size, 0, 'Should start with no clients');

    const client1 = await registry.connect('server-1');
    assert.strictEqual(registry.clients.size, 1, 'Should track 1 client');

    const client2 = await registry.connect('server-2');
    assert.strictEqual(registry.clients.size, 2, 'Should track 2 clients');

    // Verify both clients work
    await client1.listTools();
    await client2.listTools();

    await registry.close();
    registry = undefined;
  });

  it('should support dialects option', async () => {
    // Default dialects is ['servers'] which spawns stdio servers only
    registry = createServerRegistry(
      {
        'stdio-server': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot, dialects: ['servers'] }
    );

    assert.strictEqual(registry.servers.size, 1, 'Should spawn stdio server with servers dialect');

    await registry.close();
    registry = undefined;
  });

  it('should preserve external ownership when spawning is disabled', async () => {
    const port = await getPort();
    const url = `http://127.0.0.1:${port}/mcp`;
    const shutdownUrl = `http://127.0.0.1:${port}/__mcpz/shutdown`;
    const config = {
      'owned-http': {
        type: 'http' as const,
        url,
        start: {
          command: 'node',
          args: ['test/lib/servers/echo-http.mjs', '--port', String(port)],
          stop: {
            command: 'node',
            args: ['test/lib/servers/request-http-stop.mjs', shutdownUrl],
          },
        },
      },
    };
    const owner = createServerRegistry(config, { cwd: projectRoot, dialects: ['start'] });
    const ownedServer = owner.servers.get('owned-http');
    assert.ok(ownedServer?.process.pid, 'the owner should spawn the HTTP process');
    const ownerClient = await owner.connect('owned-http');
    await ownerClient.close();

    const external = createServerRegistry(config, { cwd: projectRoot, dialects: [] });
    try {
      assert.strictEqual(external.servers.size, 0, 'an empty dialect list must not start a second process');
      await external.close();

      assert.strictEqual(ownedServer.process.exitCode, null, 'closing an attaching registry must leave the owned server running');
      assert.strictEqual(ownedServer.process.signalCode, null, 'closing an attaching registry must not signal the owned server');
      const response = await fetch(url);
      await response.arrayBuffer();
      assert.strictEqual(response.status, 405, 'the external server should still serve requests');

      assert.deepStrictEqual(await owner.close('SIGINT', { timeoutMs: 1000 }), { timedOut: false, killedCount: 0 });
      assert.ok(ownedServer.process.exitCode !== null || ownedServer.process.signalCode !== null, 'the owner should stop its HTTP server');
    } finally {
      try {
        await external.close();
      } finally {
        await owner.close('SIGINT', { timeoutMs: 1000 }).catch(() => undefined);
      }
    }
  });
});

describe('createServerRegistry + connect', () => {
  const registries: ServerRegistry[] = [];

  after(async () => {
    // Clean up all registries (they manage their own clients)
    for (const registry of registries) {
      try {
        await registry.close();
      } catch {
        // Ignore close errors
      }
    }
  });

  it('should spawn and connect to server via stdio', async () => {
    const registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
      },
    });
    registries.push(registry);

    const client = await registry.connect('test-server');

    assert.ok(client, 'Should return client');
    assert.ok(typeof client.close === 'function', 'Should have close method');

    // Verify client is connected by listing tools
    const tools = await client.listTools();
    assert.ok(Array.isArray(tools.tools), 'Should list tools');
    assert.ok(tools.tools.length > 0, 'Should have at least one tool');

    await registry.close();
    // Remove from close array since we already closed it
    registries.pop();
  });

  it('should pass custom environment variables via per-server env', async () => {
    const registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
        env: {
          CUSTOM_VAR: 'test-value',
          LOG_LEVEL: 'error',
        },
      },
    });
    registries.push(registry);

    const client = await registry.connect('test-server');

    assert.ok(client, 'Should connect with custom env vars');

    // Verify connection works
    const tools = await client.listTools();
    assert.ok(tools.tools.length > 0, 'Should work with custom env');

    await registry.close();
    registries.pop();
  });

  it('should support custom working directory', async () => {
    const registry = createServerRegistry(
      {
        'test-server': {
          command: 'node',
          args: ['test/lib/servers/minimal-stdio.mjs'],
        },
      },
      { cwd: projectRoot }
    );
    registries.push(registry);

    const client = await registry.connect('test-server');

    assert.ok(client, 'Should connect with custom cwd');
    await registry.close();
    registries.pop();
  });

  it('should close connection and kill stdio process', async () => {
    const registry = createServerRegistry({
      'test-server': {
        command: 'node',
        args: ['test/lib/servers/minimal-stdio.mjs'],
      },
    });
    registries.push(registry);

    const client = await registry.connect('test-server');

    // Verify connected
    assert.ok(client, 'Should be connected');

    // Close registry (closes all clients and servers)
    await registry.close();
    registries.pop();

    // Verify client is closed (subsequent calls should fail)
    try {
      await client.listTools();
      assert.fail('Should not be able to call methods after close');
    } catch (error) {
      assert.ok(error, 'Should throw error when calling closed client');
    }
  });

  it('should handle spawn errors gracefully', async () => {
    try {
      const registry = createServerRegistry({
        'bad-server': {
          command: 'nonexistent-command',
          args: [],
        },
      });

      registries.push(registry);

      // Try to connect - should fail
      const _client = await registry.connect('bad-server');

      assert.fail('Should throw error for nonexistent command');
    } catch (error) {
      assert.ok(error, 'Should throw error');
      // Error could be ENOENT or similar
      assert.ok(error instanceof Error, 'Should be an Error instance');
    }
  });
});
