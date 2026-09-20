import { Client, type Transport } from '@modelcontextprotocol/client';
import assert from 'assert';
import { connectTransport } from '../../../src/connection/connect-client.ts';
import { withDeadline } from '../../lib/with-deadline.ts';

describe('unit/connection/connectTransport', () => {
  it('should preserve client cleanup errors when cancellation closes the transport', async () => {
    const abortError = new Error('connection cancelled');
    const cleanupError = new Error('transport close failed');
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const transport: Transport = {
      start: async () => {
        signalStarted();
        await new Promise<void>(() => {});
      },
      send: async () => {},
      close: async () => {
        throw cleanupError;
      },
    };
    const client = new Client({ name: 'cleanup-test', version: '1.0.0' }, { capabilities: {} });
    const controller = new AbortController();
    const connecting = connectTransport(client, transport, controller.signal);
    await started;
    controller.abort(abortError);

    await assert.rejects(connecting, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.cause, abortError);
      assert.deepStrictEqual(error.errors, [abortError, cleanupError]);
      return true;
    });
  });

  it('should report client cleanup that does not settle within its bound', async () => {
    const abortError = new Error('connection cancelled');
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const transport: Transport = {
      start: async () => {
        signalStarted();
        await new Promise<void>(() => {});
      },
      send: async () => {},
      close: async () => new Promise<void>(() => {}),
    };
    const client = new Client({ name: 'cleanup-timeout-test', version: '1.0.0' }, { capabilities: {} });
    const controller = new AbortController();
    const connecting = connectTransport(client, transport, controller.signal);
    await started;
    controller.abort(abortError);

    await assert.rejects(withDeadline(connecting, 6000), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.strictEqual(error.cause, abortError);
      assert.strictEqual(error.errors.length, 2);
      assert.match(String(error.errors[1]), /Client cleanup did not complete within 5000ms/);
      return true;
    });
  });
});
