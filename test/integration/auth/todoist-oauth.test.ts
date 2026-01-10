/**
 * Integration tests for Todoist OAuth flow
 * Tests RFC 9728 + RFC 8414 discovery with real Todoist server
 */

import '../../lib/env-loader.ts';
import assert from 'assert';
import Keyv from 'keyv';
import { probeAuthCapabilities } from '../../../src/auth/capability-discovery.ts';
import { discoverAuthorizationServerMetadata, discoverProtectedResourceMetadata } from '../../../src/auth/rfc9728-discovery.ts';
import { connectMcpClient } from '../../../src/connection/connect-client.ts';
import type { ServersConfig } from '../../../src/index.ts';

// Check if manual mode is enabled (for OAuth flow tests only)
const MANUAL_MODE = process.env.TEST_INCLUDE_MANUAL === 'true';

describe('integration/auth/todoist-oauth', () => {
  // Discovery tests - no manual mode needed (just HTTP calls)
  describe('Discovery (Automated)', () => {
    describe('RFC 9728 Protected Resource Metadata', () => {
      it('should discover Todoist MCP resource metadata', async () => {
        const metadata = await discoverProtectedResourceMetadata('https://ai.todoist.net/mcp');

        assert.ok(metadata, 'Should discover metadata');
        assert.strictEqual(metadata.resource, 'https://ai.todoist.net/mcp');
        assert.ok(metadata.authorization_servers.length > 0, 'Should have at least one authorization server');
        assert.ok(metadata.authorization_servers.includes('https://todoist.com'), 'Should include todoist.com as authorization server');
        assert.ok(metadata.scopes_supported, 'Should have supported scopes');
        assert.ok(metadata.scopes_supported.includes('data:read_write'), 'Should support data:read_write scope');

        console.log('\n📋 Todoist Resource Metadata:');
        console.log(JSON.stringify(metadata, null, 2));
      });
    });

    describe('RFC 8414 Authorization Server Metadata', () => {
      it('should discover Todoist OAuth server metadata', async () => {
        const metadata = await discoverAuthorizationServerMetadata('https://todoist.com');

        assert.ok(metadata, 'Should discover metadata');
        assert.strictEqual(metadata.issuer, 'https://todoist.com');
        assert.ok(metadata.authorization_endpoint, 'Should have authorization endpoint');
        assert.ok(metadata.token_endpoint, 'Should have token endpoint');
        assert.ok(metadata.registration_endpoint, 'Should have registration endpoint (DCR support)');

        console.log('\n🔐 Todoist Authorization Server Metadata:');
        console.log(JSON.stringify(metadata, null, 2));
      });
    });

    describe('Full Discovery Chain (RFC 9728 → RFC 8414)', () => {
      it('should discover full Todoist OAuth capabilities via discovery chain', async () => {
        const capabilities = await probeAuthCapabilities('https://ai.todoist.net/mcp');

        assert.ok(capabilities, 'Should discover capabilities');
        assert.strictEqual(capabilities.supportsDcr, true, 'Should support DCR');
        assert.ok(capabilities.registrationEndpoint, 'Should have registration endpoint');
        assert.ok(capabilities.authorizationEndpoint, 'Should have authorization endpoint');
        assert.ok(capabilities.tokenEndpoint, 'Should have token endpoint');
        assert.ok(capabilities.scopes, 'Should have scopes');
        assert.ok(capabilities.scopes.includes('data:read_write'), 'Should include data:read_write scope');

        console.log('\n✅ Todoist OAuth Capabilities (via RFC 9728 → RFC 8414):');
        console.log(JSON.stringify(capabilities, null, 2));
      });

      it('should handle direct authorization server discovery as fallback', async () => {
        // Test fallback: if we query todoist.com directly (not ai.todoist.net/mcp)
        const capabilities = await probeAuthCapabilities('https://todoist.com');

        assert.ok(capabilities, 'Should discover capabilities via fallback');
        assert.strictEqual(capabilities.supportsDcr, true, 'Should support DCR');
        assert.ok(capabilities.registrationEndpoint, 'Should have registration endpoint');
      });
    });

    describe('Cross-Domain OAuth Discovery', () => {
      it('should correctly handle MCP at ai.todoist.net/mcp with OAuth at todoist.com', async () => {
        // This is the key test: resource server and auth server on different domains
        const mcpUrl = 'https://ai.todoist.net/mcp';

        // Step 1: Discover protected resource metadata
        const resourceMeta = await discoverProtectedResourceMetadata(mcpUrl);
        assert.ok(resourceMeta, 'Should find resource metadata');
        assert.strictEqual(resourceMeta.resource, mcpUrl);

        // Step 2: Extract authorization server
        const authServerUrl = resourceMeta.authorization_servers[0];
        assert.strictEqual(authServerUrl, 'https://todoist.com', 'Should point to todoist.com');

        // Step 3: Discover authorization server metadata
        const authServerMeta = await discoverAuthorizationServerMetadata(authServerUrl);
        assert.ok(authServerMeta, 'Should find auth server metadata');
        assert.ok(authServerMeta.registration_endpoint, 'Should support DCR');

        console.log('\n🌐 Cross-Domain OAuth Discovery Success:');
        console.log(`   Resource Server: ${new URL(mcpUrl).origin}`);
        console.log(`   Auth Server:     ${authServerUrl}`);
        console.log(`   Registration:    ${authServerMeta.registration_endpoint}`);
        console.log(`   Authorization:   ${authServerMeta.authorization_endpoint}`);
        console.log(`   Token:           ${authServerMeta.token_endpoint}`);
      });
    });

    describe('MCP Path Handling', () => {
      it('should correctly discover metadata for MCP endpoint with /mcp path', async () => {
        // Regression test: ensure we check origin first, not append to path
        const capabilities = await probeAuthCapabilities('https://ai.todoist.net/mcp');

        assert.strictEqual(capabilities.supportsDcr, true);
        assert.ok(capabilities.registrationEndpoint?.includes('todoist.com'), 'Registration endpoint should be on todoist.com domain');

        console.log('\n📍 MCP Path Handling:');
        console.log('   MCP Endpoint:    https://ai.todoist.net/mcp');
        if (capabilities.registrationEndpoint) {
          console.log(`   OAuth Domain:    ${new URL(capabilities.registrationEndpoint).origin}`);
        }
      });
    });
  }); // End Discovery (Automated)

  // Full OAuth flow tests - REQUIRES manual browser interaction
  describe('Full OAuth Flow (Manual - TEST_INCLUDE_MANUAL=true)', () => {
    before(function () {
      if (!MANUAL_MODE) {
        console.log('\n⚠️  Skipped: Set TEST_INCLUDE_MANUAL=true to run full OAuth flow tests\n');
        this.skip();
      }
    });

    it('should connect to Todoist via connectMcpClient with full DCR+OAuth flow', async function () {
      // This test proves the ENTIRE flow works end-to-end:
      // 1. RFC 9728 discovery (ai.todoist.net → todoist.com)
      // 2. DCR client registration
      // 3. Browser OAuth authorization (MANUAL - user clicks "Approve")
      // 4. PKCE token exchange
      // 5. MCP connection with Bearer token
      this.timeout(120000); // 2 minutes for user to complete OAuth

      const todoistConfig: ServersConfig = {
        todoist: {
          url: 'https://ai.todoist.net/mcp',
          type: 'http',
        },
      };

      console.log('\n🔍 Starting Todoist end-to-end OAuth flow...');
      console.log('   This will:');
      console.log('   1. Discover OAuth endpoints (RFC 9728 → RFC 8414)');
      console.log('   2. Register NEW client via DCR (every test run)');
      console.log('   3. Open browser for OAuth (you must approve)');
      console.log('   4. Exchange code with PKCE');
      console.log('   5. Connect to Todoist MCP server');

      // Use in-memory token store - forces full DCR + OAuth flow every test run
      // No persistence means we always test the complete flow (not just token reuse)
      const tokenStore = new Keyv();

      // Connect using our full OAuth flow
      const client = await connectMcpClient(todoistConfig, 'todoist', {
        dcrAuthenticator: { tokenStore },
      });

      // Verify we're actually connected
      assert.ok(client, 'Should return connected client');

      console.log('\n✅ Successfully connected to Todoist!');
      console.log('   End-to-end OAuth flow complete (RFC 9728 + DCR + PKCE)');

      // Test that we can actually call the MCP server
      const serverInfo = await client.getServerVersion();
      console.log(`   Server version: ${JSON.stringify(serverInfo)}`);

      // Cleanup
      await client.close();
    });
  });
});
