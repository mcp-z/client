/**
 * Unit tests for dynamic-client-registrar.ts
 * Tests RFC 7591 Dynamic Client Registration
 */

import assert from 'assert';
import { DynamicClientRegistrar } from '../../../src/dcr/dynamic-client-registrar.ts';
import { startDcrTestServer } from '../../lib/servers/dcr-test-server.ts';

describe('unit/auth/dynamic-client-registrar', () => {
  let dcrServer: Awaited<ReturnType<typeof startDcrTestServer>>;
  let registrar: DynamicClientRegistrar;

  before(async () => {
    dcrServer = await startDcrTestServer({
      port: 9998,
      baseUrl: 'http://localhost:9998',
    });
    registrar = new DynamicClientRegistrar();
  });

  after(async () => {
    await dcrServer.close();
  });

  it('should register client successfully', async () => {
    const credentials = await registrar.registerClient('http://localhost:9998/oauth/register');

    assert.ok(credentials.clientId);
    assert.ok(credentials.clientSecret);
    assert.strictEqual(credentials.clientId.startsWith('client_'), true);
    assert.strictEqual(credentials.clientSecret.startsWith('secret_'), true);
  });

  it('should accept custom client name', async () => {
    const credentials = await registrar.registerClient('http://localhost:9998/oauth/register', {
      clientName: 'test-client',
    });

    assert.ok(credentials.clientId);
    assert.ok(credentials.clientSecret);
  });

  it('should accept custom redirect URIs', async () => {
    const credentials = await registrar.registerClient('http://localhost:9998/oauth/register', {
      redirectUri: 'http://localhost:8080/callback',
    });

    assert.ok(credentials.clientId);
    assert.ok(credentials.clientSecret);
  });

  it('should handle network errors', async () => {
    await assert.rejects(
      async () => {
        await registrar.registerClient('http://localhost:8888/oauth/register');
      },
      (error: Error) => {
        // Network errors from fetch throw different messages (e.g., ECONNREFUSED)
        assert.ok(error instanceof Error);
        return true;
      }
    );
  });

  it('should handle 404 errors', async () => {
    await assert.rejects(
      async () => {
        await registrar.registerClient('http://localhost:9998/invalid');
      },
      (error: Error) => {
        assert.ok(error.message.includes('DCR registration failed'));
        assert.ok(error.message.includes('404'));
        return true;
      }
    );
  });
});
