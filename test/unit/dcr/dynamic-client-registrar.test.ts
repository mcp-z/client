/**
 * Unit tests for dynamic-client-registrar.ts
 * Tests RFC 7591 Dynamic Client Registration
 */

import { DynamicClientRegistrar } from '@mcp-z/client';
import assert from 'assert';
import { startDcrTestServer } from '../../lib/servers/dcr-test-server.mjs';

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

  // These calls provide the registration endpoint directly (this test *is*
  // the trusted caller, analogous to dcr-authenticator.ts computing
  // allowLoopback from a loopback baseUrl it is itself connected to), so
  // they pass { allowLoopback: true } explicitly - the default is false so
  // that a caller which forgets this (e.g. because registrationEndpoint came
  // from an untrusted server's AS metadata) fails closed. See the SSRF test
  // below and discovery-fetch.test.ts for the refusal case.
  it('should register client successfully', async () => {
    const credentials = await registrar.registerClient('http://localhost:9998/oauth/register', { allowLoopback: true });

    assert.ok(credentials.clientId);
    assert.ok(credentials.clientSecret);
    assert.strictEqual(credentials.clientId.startsWith('client_'), true);
    assert.strictEqual(credentials.clientSecret.startsWith('secret_'), true);
  });

  it('should accept custom client name', async () => {
    const credentials = await registrar.registerClient('http://localhost:9998/oauth/register', {
      clientName: 'test-client',
      allowLoopback: true,
    });

    assert.ok(credentials.clientId);
    assert.ok(credentials.clientSecret);
  });

  it('should accept custom redirect URIs', async () => {
    const credentials = await registrar.registerClient('http://localhost:9998/oauth/register', {
      redirectUri: 'http://localhost:8080/callback',
      allowLoopback: true,
    });

    assert.ok(credentials.clientId);
    assert.ok(credentials.clientSecret);
  });

  it('should handle network errors', async () => {
    await assert.rejects(
      async () => {
        await registrar.registerClient('http://localhost:8888/oauth/register', { allowLoopback: true });
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
        await registrar.registerClient('http://localhost:9998/invalid', { allowLoopback: true });
      },
      (error: Error) => {
        assert.ok(error.message.includes('DCR registration failed'));
        assert.ok(error.message.includes('404'));
        return true;
      }
    );
  });

  it('should refuse to POST to a loopback registration_endpoint with no allowLoopback grant (SSRF)', async () => {
    // This is the dangerous case the loopback-trust design exists for:
    // registrationEndpoint is typically sourced from a remote server's AS
    // metadata. A malicious/compromised server returning
    // registration_endpoint: "http://localhost:9998/oauth/register" must not
    // get this request sent, even though something happens to be listening.
    await assert.rejects(registrar.registerClient('http://localhost:9998/oauth/register'), (error: Error) => {
      assert.ok(error.message.includes('trusted loopback origin'), error.message);
      return true;
    });
  });
});
