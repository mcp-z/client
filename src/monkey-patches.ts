/**
 * Monkey patches for MCP SDK bugs
 *
 * These patches fix bugs in dependencies that haven't been fixed upstream yet.
 */

import { Protocol } from '@modelcontextprotocol/sdk/shared/protocol.js';

/**
 * FIX: Protocol.close() doesn't clear pending timeouts
 *
 * BUG: The MCP SDK's Protocol.close() only closes the transport but does NOT
 * clear pending timeouts from the internal _timeoutInfo Map. This causes Node.js
 * to hang until timeouts fire (default 60 seconds).
 *
 * PATCH: Wrap Protocol.close() to clear all pending timeouts before closing.
 *
 * TO TEST IF STILL NEEDED:
 * 1. Comment out this patch
 * 2. Run: npm run test:unit
 * 3. If tests hang ~60 seconds after completing, bug still exists
 * 4. If tests exit promptly, SDK is fixed and this can be removed
 *
 * UPSTREAM: https://github.com/modelcontextprotocol/typescript-sdk/issues/XXX
 */
const originalClose = Protocol.prototype.close;
Protocol.prototype.close = async function () {
  const self = this as unknown as { _timeoutInfo?: Map<unknown, { timeoutId: ReturnType<typeof setTimeout> }> };
  if (self._timeoutInfo) {
    for (const [, info] of self._timeoutInfo) {
      clearTimeout(info.timeoutId);
    }
    self._timeoutInfo.clear();
  }
  return originalClose.call(this);
};
