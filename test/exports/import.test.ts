import { createServerRegistry, decorateClient, probeAuthCapabilities, resolvePath, validateServers } from '@mcp-z/client';
import assert from 'assert';

describe('exports .ts', () => {
  it('named exports resolve', () => {
    for (const fn of [createServerRegistry, decorateClient, probeAuthCapabilities, resolvePath, validateServers]) assert.equal(typeof fn, 'function');
  });
});
