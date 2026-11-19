/**
 * Unit tests for dcr-authenticator.ts
 * Tests token management with Keyv storage
 */

import '../../lib/env-loader.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthCapabilities, TokenSet } from '@mcp-z/client';
import { DcrAuthenticator } from '@mcp-z/client';
import assert from 'assert';
import fs from 'fs';
import { safeRmSync } from 'fs-remove-compat';
import getPort from 'get-port';
import Keyv from 'keyv';
import { KeyvFile } from 'keyv-file';
import path from 'path';

describe('unit/auth/dcr-authenticator', () => {
  it('should use custom token store when provided', () => {
    const customStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore: customStore, redirectUri: 'http://localhost:3000/callback' });

    assert.ok(authenticator);
  });

  it('should delete tokens for a base URL', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback' });

    // Manually add tokens to store
    const testTokens: TokenSet = {
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() + 3600000,
      clientId: 'test_client',
      clientSecret: 'test_secret',
    };

    await tokenStore.set('tokens:https://issuer.example.com:http://example.com', testTokens);
    await tokenStore.set('tokens:https://issuer.example.com:http://other.example.com', testTokens);

    await authenticator.deleteTokens('http://example.com');

    assert.strictEqual(await tokenStore.get('tokens:https://issuer.example.com:http://example.com'), undefined);
    assert.ok(await tokenStore.get('tokens:https://issuer.example.com:http://other.example.com'), 'other resources are left alone');
  });

  it('should delete self-hosted DCR tokens for a base URL', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback' });

    const testTokens: TokenSet = {
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() + 3600000,
    };

    await tokenStore.set('dcr-tokens:https://issuer.example.com:http://example.com', testTokens);
    await tokenStore.set('dcr-tokens:https://issuer.example.com:http://other.example.com', testTokens);

    await authenticator.deleteTokens('http://example.com');

    assert.strictEqual(await tokenStore.get('dcr-tokens:https://issuer.example.com:http://example.com'), undefined);
    assert.ok(await tokenStore.get('dcr-tokens:https://issuer.example.com:http://other.example.com'), 'other resources are left alone');
  });

  it('should delete both token families, across every issuer, in one call', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback' });

    const testTokens: TokenSet = {
      accessToken: 'test_access_token',
      refreshToken: 'test_refresh_token',
      expiresAt: Date.now() + 3600000,
    };

    // One server reached through two issuers, holding both an external and a
    // self-hosted DCR credential. Deleting per-family or per-issuer leaves a
    // usable credential behind, which is the failure this pins.
    await tokenStore.set('tokens:https://issuer-a.example.com:http://example.com', testTokens);
    await tokenStore.set('dcr-tokens:https://issuer-a.example.com:http://example.com', testTokens);
    await tokenStore.set('tokens:https://issuer-b.example.com:http://example.com', testTokens);
    await tokenStore.set('dcr-tokens:https://issuer-b.example.com:http://example.com', testTokens);
    await tokenStore.set('tokens:https://issuer-a.example.com:http://other.example.com', testTokens);

    await authenticator.deleteTokens('http://example.com');

    for (const key of ['tokens:https://issuer-a.example.com:http://example.com', 'dcr-tokens:https://issuer-a.example.com:http://example.com', 'tokens:https://issuer-b.example.com:http://example.com', 'dcr-tokens:https://issuer-b.example.com:http://example.com']) {
      assert.strictEqual(await tokenStore.get(key), undefined, `${key} should have been deleted`);
    }
    assert.ok(await tokenStore.get('tokens:https://issuer-a.example.com:http://other.example.com'), 'other resources are left alone');
  });

  // Credentials are keyed and stamped by issuer, so a resource whose
  // authorization server changes gets a fresh authorization rather than the
  // previous server's tokens (SEP-2352). Each case below stores a credential
  // for ISSUER_A and then discovers capabilities that carry no endpoints, so
  // "did it reuse the stored credential?" is answered by whether the call
  // returns the token or falls through to the missing-endpoints failure.
  const ISSUER_A = 'https://issuer-a.example.com';
  const ISSUER_B = 'https://issuer-b.example.com';
  const RESOURCE = 'https://resource.example.com';
  const STORED_KEY = `tokens:${ISSUER_A}:${RESOURCE}`;

  function storedTokens(issuer?: string): TokenSet {
    const tokens: TokenSet = {
      accessToken: 'stored_access_token',
      refreshToken: 'stored_refresh_token',
      expiresAt: Date.now() + 3600000,
      clientId: 'stored_client',
      clientSecret: 'stored_secret',
    };
    if (issuer) tokens.issuer = issuer;
    return tokens;
  }

  it('should reuse a credential stored for the discovered issuer', async () => {
    const tokenStore = new Keyv();
    await tokenStore.set(STORED_KEY, storedTokens(ISSUER_A));
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    const tokens = await authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true, issuer: ISSUER_A });

    assert.strictEqual(tokens.accessToken, 'stored_access_token');
  });

  it('should never present a stored credential to a different authorization server', async () => {
    const tokenStore = new Keyv();
    await tokenStore.set(STORED_KEY, storedTokens(ISSUER_A));
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    await assert.rejects(authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true, issuer: ISSUER_B }), (error: Error) => {
      assert.ok(error.message.includes('does not provide required OAuth endpoints'), error.message);
      return true;
    });

    assert.ok(await tokenStore.get(STORED_KEY), "issuer A's credential is untouched, not handed to issuer B");
  });

  it('should discard a stored credential that carries no issuer', async () => {
    const tokenStore = new Keyv();
    await tokenStore.set(STORED_KEY, storedTokens());
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    await assert.rejects(authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true, issuer: ISSUER_A }), (error: Error) => {
      assert.ok(error.message.includes('does not provide required OAuth endpoints'), error.message);
      return true;
    });

    assert.strictEqual(await tokenStore.get(STORED_KEY), undefined, 'unbound credential is discarded, not reused');
  });

  it('should refuse to authenticate against an authorization server that advertises no issuer', async () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    await assert.rejects(authenticator.ensureAuthenticated(RESOURCE, { supportsDcr: true }), (error: Error) => {
      assert.ok(error.message.includes('has no issuer'), error.message);
      return true;
    });
  });

  describe('self-hosted token verification', () => {
    const SELF_ISSUER = 'http://localhost';
    const caps = (base: string): AuthCapabilities => ({ supportsDcr: true, issuer: SELF_ISSUER, registrationEndpoint: `${base}/oauth/register`, authorizationEndpoint: `${base}/oauth/authorize`, tokenEndpoint: `${base}/oauth/token` });

    async function withVerifyServer(status: number, run: (base: string) => Promise<void>): Promise<void> {
      const server = http.createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }

    function storedKey(base: string): string {
      return `dcr-tokens:${SELF_ISSUER}:${base}`;
    }

    async function seed(base: string): Promise<Keyv> {
      const tokenStore = new Keyv();
      await tokenStore.set(storedKey(base), { accessToken: 'stored_access_token', refreshToken: 'stored_refresh_token', expiresAt: Date.now() + 3600000, clientId: 'c', issuer: SELF_ISSUER } satisfies TokenSet);
      return tokenStore;
    }

    it('should keep the stored token and reject when the verify request fails to connect', async () => {
      const port = await getPort({ host: '127.0.0.1' });
      const base = `http://127.0.0.1:${port}`;
      const tokenStore = await seed(base);
      const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

      await assert.rejects(authenticator.ensureAuthenticated(base, caps(base)));

      assert.ok(await tokenStore.get(storedKey(base)), 'a network failure must not delete the stored sign-in');
    });

    it('should keep the stored token and rethrow the abort when the verify request is aborted in flight', async () => {
      let requestSeen!: () => void;
      const seen = new Promise<void>((resolve) => (requestSeen = resolve));
      const server = http.createServer(() => requestSeen()); // never answers
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        const tokenStore = await seed(base);
        const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });
        const controller = new AbortController();
        const reason = new Error('cancelled');

        const pending = authenticator.ensureAuthenticated(base, caps(base), controller.signal);
        await seen;
        controller.abort(reason);

        await assert.rejects(pending, (error: unknown) => error === reason);
        assert.ok(await tokenStore.get(storedKey(base)), 'an abort must not delete the stored sign-in');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('should delete the stored token when the server answers that it is invalid', async () => {
      await withVerifyServer(401, async (base) => {
        const tokenStore = await seed(base);
        const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

        await assert.rejects(authenticator.ensureAuthenticated(base, { supportsDcr: true, issuer: SELF_ISSUER }), /does not provide required OAuth endpoints/);

        assert.strictEqual(await tokenStore.get(storedKey(base)), undefined);
      });
    });
  });

  it('should support headless mode', () => {
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({
      tokenStore,
      redirectUri: 'http://localhost:3000/callback',
      headless: true,
    });

    assert.ok(authenticator);
  });

  it('should refuse DCR registration when a public server points registration_endpoint at loopback (SSRF)', async () => {
    // This is the exact attack the loopback-trust design exists to stop:
    // baseUrl is a public server (never itself fetched by ensureAuthenticated
    // for the external/non-self-hosted path - only used as a trust signal
    // and a token-store key), and its AS metadata (represented here by
    // `capabilities`, as if already discovered) points registration_endpoint
    // at a loopback service the operator did not intend to expose. Because
    // baseUrl is public, allowLoopback is computed as false, and the POST
    // must be refused before any request is sent - regardless of whether
    // anything happens to be listening on that port.
    const tokenStore = new Keyv();
    const authenticator = new DcrAuthenticator({ tokenStore, redirectUri: 'http://localhost:3000/callback', headless: true });

    const maliciousCapabilities: AuthCapabilities = {
      supportsDcr: true,
      issuer: 'http://localhost:9998',
      registrationEndpoint: 'http://localhost:9998/oauth/register',
      authorizationEndpoint: 'http://localhost:9998/oauth/authorize',
      tokenEndpoint: 'http://localhost:9998/oauth/token',
    };

    await assert.rejects(authenticator.ensureAuthenticated('https://public.example.com/mcp', maliciousCapabilities), (error: Error) => {
      assert.ok(error.message.includes('trusted loopback origin'), error.message);
      return true;
    });
  });
  describe('default store shared by several processes', () => {
    const ISSUER = 'https://issuer.example.com';
    const R1 = 'https://one.example.com/mcp';
    const R2 = 'https://two.example.com/mcp';
    const R3 = 'https://three.example.com/mcp';
    const key = (resource: string) => `tokens:${ISSUER}:${resource}`;
    const redirectUri = 'http://localhost:3000/callback';
    const originalCwd = process.cwd();
    let workDir: string;

    const storeFile = () => path.join(process.cwd(), '.mcp-z', 'tokens.json');
    const signIn = (resource: string): TokenSet => ({ accessToken: `access-${resource}`, refreshToken: 'refresh', expiresAt: Date.now() + 3600000, issuer: ISSUER });

    // Writes the file the way the previous release did, through keyv-file.
    async function seed(...resources: string[]): Promise<void> {
      fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
      const writer = new Keyv({ store: new KeyvFile({ filename: storeFile() }) });
      for (const resource of resources) await writer.set(key(resource), signIn(resource));
    }

    beforeEach(() => {
      fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
      workDir = fs.mkdtempSync(path.join(path.resolve('.tmp'), 'shared-'));
      process.chdir(workDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      safeRmSync(workDir, { recursive: true, force: true });
    });

    it('reads sign-ins written by the previous release (keyv-file format)', async () => {
      await seed(R1);
      const authenticator = new DcrAuthenticator({ redirectUri, headless: true });

      const tokens = await authenticator.ensureAuthenticated(R1, { supportsDcr: true, issuer: ISSUER });

      assert.strictEqual(tokens.accessToken, `access-${R1}`);
    });

    it('rejects naming the file and leaves it untouched when the default file is damaged', async () => {
      fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
      const damaged = '{"cache": [["tokens:x", {"value": ';
      fs.writeFileSync(storeFile(), damaged);
      const authenticator = new DcrAuthenticator({ redirectUri, headless: true });

      await assert.rejects(authenticator.deleteTokens(R1), (error: Error) => {
        assert.ok(error.message.includes(storeFile()), error.message);
        return true;
      });
      await assert.rejects(authenticator.ensureAuthenticated(R1, { supportsDcr: true, issuer: ISSUER }), (error: Error) => error.message.includes(storeFile()));

      assert.strictEqual(fs.readFileSync(storeFile(), 'utf8'), damaged);
    });

    it("keeps each other's changes when two authenticators write to one directory", async () => {
      await seed(R1, R2, R3);
      const a = new DcrAuthenticator({ redirectUri });
      const b = new DcrAuthenticator({ redirectUri });

      await a.deleteTokens(R1);
      await b.deleteTokens(R2);

      const reader = new Keyv({ store: new KeyvFile({ filename: storeFile() }) });
      assert.strictEqual(await reader.get(key(R1)), undefined, "a's delete survives b's write");
      assert.strictEqual(await reader.get(key(R2)), undefined, "b's delete is saved");
      assert.ok(await reader.get(key(R3)), 'untouched sign-in is kept');
    });

    it("sees the other authenticator's change without reopening", async () => {
      await seed(R1, R2);
      const a = new DcrAuthenticator({ redirectUri, headless: true });
      const b = new DcrAuthenticator({ redirectUri, headless: true });
      const capabilities: AuthCapabilities = { supportsDcr: true, issuer: ISSUER };

      assert.strictEqual((await b.ensureAuthenticated(R1, capabilities)).accessToken, `access-${R1}`);
      assert.strictEqual((await a.ensureAuthenticated(R2, capabilities)).accessToken, `access-${R2}`);

      await a.deleteTokens(R1);
      await assert.rejects(b.ensureAuthenticated(R1, capabilities), /does not provide required OAuth endpoints/, "b sees a's delete");

      await b.deleteTokens(R2);
      await assert.rejects(a.ensureAuthenticated(R2, capabilities), /does not provide required OAuth endpoints/, "a sees b's delete");
    });
  });

  describe('default store written by keyv 5', () => {
    const storeFile = () => path.join(workDir, '.mcp-z', 'tokens.json');
    const debugLogger = (messages: string[]) => ({ debug: (m: string) => messages.push(m), info() {}, warn() {}, error() {} }) as unknown as import('@mcp-z/client').Logger;

    const fixture = path.resolve('test/unit/dcr/fixtures/keyv5-client-tokens.json');
    const originalCwd = process.cwd();
    let workDir: string;

    beforeEach(() => {
      fs.mkdirSync(path.resolve('.tmp'), { recursive: true });
      workDir = fs.mkdtempSync(path.join(path.resolve('.tmp'), 'keyv5-'));
      fs.mkdirSync(path.join(workDir, '.mcp-z'), { recursive: true });
      fs.copyFileSync(fixture, path.join(workDir, '.mcp-z', 'tokens.json'));
      process.chdir(workDir);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('moves saved sign-ins to keyv 6 keys, so deleteTokens finds the old token', async () => {
      const authenticator = new DcrAuthenticator({ redirectUri: 'http://localhost:3000/callback' });
      await authenticator.deleteTokens('https://dummy.example/mcp');

      const reader = new Keyv({ store: new KeyvFile({ filename: path.join(workDir, '.mcp-z', 'tokens.json') }) });
      assert.strictEqual(await reader.get('dcr-tokens:https://dummy.example/mcp'), undefined, 'deleted by deleteTokens');
      const kept = (await reader.get('tokens:https://other.example/mcp')) as TokenSet | undefined;
      assert.strictEqual(kept?.accessToken, 'other_access', 'untouched entry readable under its keyv 6 key');
    });
    it('migrates through ensureAuthenticated before discovery fails', async () => {
      const authenticator = new DcrAuthenticator({ redirectUri: 'http://localhost:3000/callback', headless: true });
      const capabilities: AuthCapabilities = {
        supportsDcr: true,
        issuer: 'http://localhost:9998',
        registrationEndpoint: 'http://localhost:9998/oauth/register',
        authorizationEndpoint: 'http://localhost:9998/oauth/authorize',
        tokenEndpoint: 'http://localhost:9998/oauth/token',
      } as AuthCapabilities;
      await assert.rejects(authenticator.ensureAuthenticated('http://127.0.0.1:9/mcp', capabilities));

      const keys = (JSON.parse(fs.readFileSync(storeFile(), 'utf8')).cache as [string, unknown][]).map(([key]) => key);
      assert.ok(keys.includes('dcr-tokens:https://dummy.example/mcp'), keys.join());
      assert.ok(!keys.some((key) => key.startsWith('keyv:')), keys.join());
    });

    it('migrates once when three first calls run concurrently', async () => {
      const messages: string[] = [];
      const authenticator = new DcrAuthenticator({ redirectUri: 'http://localhost:3000/callback', logger: debugLogger(messages) });
      await Promise.all([authenticator.deleteTokens('https://x.example/mcp'), authenticator.deleteTokens('https://y.example/mcp'), authenticator.deleteTokens('https://z.example/mcp')]);

      assert.strictEqual(messages.filter((m) => m.startsWith('Moved ')).length, 1, messages.join('\n'));
    });

    it('retries opening the store on the next call after a failure', async () => {
      const messages: string[] = [];
      fs.writeFileSync(storeFile(), '{"cache": [');
      const authenticator = new DcrAuthenticator({ redirectUri: 'http://localhost:3000/callback', logger: debugLogger(messages) });

      await assert.rejects(authenticator.deleteTokens('https://dummy.example/mcp'), (error: Error) => {
        assert.ok(error.message.includes(storeFile()), error.message);
        return true;
      });
      fs.copyFileSync(fixture, storeFile());
      await authenticator.deleteTokens('https://dummy.example/mcp');
      assert.ok(
        messages.some((m) => m.startsWith('Moved ')),
        'second call opened the store and migrated'
      );
    });
  });
});
