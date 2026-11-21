/**
 * Unit tests for oauth-callback-listener.ts
 * Tests OAuth callback server - caller is responsible for port availability via get-port
 */

import '../../lib/env-loader.ts';
import http from 'node:http';
import { OAuthCallbackListener } from '@mcp-z/client';
import assert from 'assert';
import getPort from 'get-port';
import { listenOnFreePort } from '../../lib/listen-on-free-port.ts';

describe('unit/auth/oauth-callback-listener', () => {
  it('should start on provided port', async () => {
    const port = await getPort({ host: 'localhost' });
    const listener = new OAuthCallbackListener({ port });

    await listener.start();
    assert.strictEqual(listener.getCallbackUrl(), `http://localhost:${port}/callback`);

    await listener.stop();
  });

  it('should fail fast when port is already in use', async () => {
    // Block the port on the host the listener binds
    const blockingServer = http.createServer();
    const port = await listenOnFreePort(blockingServer, 'localhost');

    try {
      const listener = new OAuthCallbackListener({ port });

      await assert.rejects(
        listener.start(),
        (error: Error) => {
          assert.ok(error.message.includes('EADDRINUSE') || error.message.includes('address already in use'));
          return true;
        },
        'Should fail fast when port is in use'
      );
    } finally {
      blockingServer.close();
    }
  });

  it('should handle callback with auth code', async () => {
    const port = await getPort({ host: 'localhost' });
    const listener = new OAuthCallbackListener({ port });

    await listener.start();

    // Simulate OAuth redirect with auth code
    const callbackPromise = listener.waitForCallback(5000);

    // Send callback request
    const response = await fetch(`http://localhost:${port}/callback?code=test_code_123&state=test_state&iss=https%3A%2F%2Fissuer.example.com`);
    assert.strictEqual(response.status, 200);

    const result = await callbackPromise;
    assert.strictEqual(result.code, 'test_code_123');
    assert.strictEqual(result.state, 'test_state');
    assert.strictEqual(result.iss, 'https://issuer.example.com');

    await listener.stop();
  });

  it('should handle callback with error', async () => {
    const port = await getPort({ host: 'localhost' });
    const listener = new OAuthCallbackListener({ port });

    await listener.start();

    const callbackPromise = listener.waitForCallback(5000);
    // Rejection is asserted below, after the callback that causes it.
    callbackPromise.catch(() => {});

    // Send callback request with error
    const response = await fetch(`http://localhost:${port}/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    assert.strictEqual(response.status, 400);
    const body = await response.text();
    assert.ok(body.includes('The authorization provider returned an error.'));
    assert.ok(!body.includes('<script>alert(1)</script>'));

    await assert.rejects(callbackPromise, (error: Error) => {
      assert.ok(error.message.includes('access_denied'));
      assert.ok(error.message.includes('<script>alert(1)</script>'));
      return true;
    });

    await listener.stop();
  });

  it('binds a port the system assigns when none is given', async () => {
    const listener = new OAuthCallbackListener({ host: '127.0.0.1' });
    await listener.start();
    try {
      const match = /^http:\/\/127\.0\.0\.1:(\d+)\/callback$/.exec(listener.getCallbackUrl());
      assert.ok(match, listener.getCallbackUrl());
      assert.ok(Number(match[1]) > 0);

      const callback = listener.waitForCallback();
      const response = await fetch(`${listener.getCallbackUrl()}?code=x`);
      assert.strictEqual(response.status, 200);
      assert.strictEqual((await callback).code, 'x');
    } finally {
      await listener.stop();
    }
  });

  it('names the port when it is already in use', async () => {
    const blockingServer = http.createServer();
    const port = await listenOnFreePort(blockingServer, '127.0.0.1');
    try {
      const listener = new OAuthCallbackListener({ port, host: '127.0.0.1' });

      await assert.rejects(listener.start(), (error: Error) => {
        assert.strictEqual(error.message, `Sign-in callback port 127.0.0.1:${port} is already in use (EADDRINUSE)`);
        assert.strictEqual((error as NodeJS.ErrnoException).code, 'EADDRINUSE');
        assert.strictEqual((error.cause as NodeJS.ErrnoException | undefined)?.code, 'EADDRINUSE');
        return true;
      });
    } finally {
      await new Promise<void>((resolve) => blockingServer.close(() => resolve()));
    }
  });

  it('should timeout when no callback received', async () => {
    const port = await getPort({ host: 'localhost' });
    const listener = new OAuthCallbackListener({ port });

    await listener.start();

    await assert.rejects(
      listener.waitForCallback(100), // Short timeout
      (error: Error) => {
        assert.ok(error.message.includes('timeout') || error.message.includes('Timeout'));
        return true;
      }
    );

    await listener.stop();
  });
});
