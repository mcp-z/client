const assert = require('assert');
const { createServerRegistry, decorateClient, probeAuthCapabilities, resolvePath, validateServers } = require('@mcp-z/client');

describe('exports .cjs', () => {
  it('named exports resolve', () => {
    for (const fn of [createServerRegistry, decorateClient, probeAuthCapabilities, resolvePath, validateServers]) assert.equal(typeof fn, 'function');
  });
});
