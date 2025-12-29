/**
 * Unit tests for oauth-callback-listener.ts
 * Tests OAuth callback server - caller is responsible for port availability via get-port
 */

import http from 'node:http';
import assert from 'assert';
import getPort from 'get-port';
import { OAuthCallbackListener } from '../../../src/auth/oauth-callback-listener.ts';

describe('unit/auth/oauth-callback-listener', () => {
  it('should start on provided port', async () => {
    const port = await getPort();
    const listener = new OAuthCallbackListener({ port });

    await listener.start();
    assert.strictEqual(listener.getCallbackUrl(), `http://localhost:${port}/callback`);

    await listener.stop();
  });

  it('should fail fast when port is already in use', async () => {
    const port = await getPort();

    // Block the port
    const blockingServer = http.createServer();
    await new Promise<void>((resolve) => {
      blockingServer.listen(port, () => resolve());
    });

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
    const port = await getPort();
    const listener = new OAuthCallbackListener({ port });

    await listener.start();

    // Simulate OAuth redirect with auth code
    const callbackPromise = listener.waitForCallback(5000);

    // Send callback request
    const response = await fetch(`http://localhost:${port}/callback?code=test_code_123&state=test_state`);
    assert.strictEqual(response.status, 200);

    const result = await callbackPromise;
    assert.strictEqual(result.code, 'test_code_123');
    assert.strictEqual(result.state, 'test_state');

    await listener.stop();
  });

  it('should handle callback with error', async () => {
    const port = await getPort();
    const listener = new OAuthCallbackListener({ port });

    await listener.start();

    const callbackPromise = listener.waitForCallback(5000);

    // Send callback request with error
    const response = await fetch(`http://localhost:${port}/callback?error=access_denied&error_description=User%20denied`);
    assert.strictEqual(response.status, 400);

    await assert.rejects(callbackPromise, (error: Error) => {
      assert.ok(error.message.includes('access_denied'));
      return true;
    });

    await listener.stop();
  });

  it('should timeout when no callback received', async () => {
    const port = await getPort();
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
