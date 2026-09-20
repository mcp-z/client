/**
 * existing-process-transport.ts
 *
 * MCP transport that wraps an existing child process for stdio communication.
 * Used when connecting to already-started processes.
 */

import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/client';
import type { ChildProcess } from 'child_process';

/**
 * Transport that communicates with an existing child process via stdio.
 * Closing the transport releases only its listeners; process ownership stays with the registry.
 */
export class ExistingProcessTransport implements Transport {
  private readonly _process: ChildProcess;
  private readonly _readBuffer: ReadBuffer;
  private _dataHandler: ((chunk: Buffer) => void) | null = null;
  private _stdinErrorHandler: ((error: Error) => void) | null = null;
  private _stdoutErrorHandler: ((error: Error) => void) | null = null;
  private _stdinCloseHandler: (() => void) | null = null;
  private _processErrorHandler: ((error: Error) => void) | null = null;
  private _processCloseHandler: (() => void) | null = null;
  private _started = false;
  private _closed = false;
  private readonly _pendingSends = new Set<(error: Error) => void>();
  private _pendingWrites = 0;
  private _stdinErrorObserved = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(process: ChildProcess) {
    if (!process.stdin || !process.stdout) {
      throw new Error('Child process must have stdin and stdout pipes');
    }

    this._process = process;
    this._readBuffer = new ReadBuffer();
  }

  async start(): Promise<void> {
    if (this._closed) throw new Error('Transport is closed');
    if (this._started) return;

    const { stdin, stdout } = this._process;
    if (!stdin || !stdout) throw new Error('Child process must have stdin and stdout pipes');
    if (this._process.exitCode !== null || this._process.signalCode !== null) {
      this.finish();
      throw new Error('Cannot start transport because the child process has already exited');
    }

    this._started = true;
    this._dataHandler = (chunk: Buffer) => {
      this._readBuffer.append(chunk);
      this.processReadBuffer();
    };
    this._stdinErrorHandler = (error: Error) => {
      this._stdinErrorObserved = true;
      this.retainStdinErrorListenerUntilClose();
      this.finish(error);
    };
    this._stdoutErrorHandler = (error: Error) => this.finish(error);
    this._processErrorHandler = (error: Error) => this.finish(error);
    this._processCloseHandler = () => this.finish();

    stdout.on('data', this._dataHandler);
    stdout.on('error', this._stdoutErrorHandler);
    stdin.on('error', this._stdinErrorHandler);
    this._process.on('error', this._processErrorHandler);
    this._process.on('close', this._processCloseHandler);
  }

  private processReadBuffer(): void {
    while (!this._closed) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private detachListeners(): void {
    const { stdout } = this._process;
    if (this._dataHandler) stdout?.off('data', this._dataHandler);
    if (this._stdoutErrorHandler) stdout?.off('error', this._stdoutErrorHandler);
    this._stdoutErrorHandler = null;
    if (this._processErrorHandler) this._process.off('error', this._processErrorHandler);
    if (this._processCloseHandler) this._process.off('close', this._processCloseHandler);
    this._dataHandler = null;
    this._processErrorHandler = null;
    this._processCloseHandler = null;
    this.detachPendingWriteErrorListener();
  }

  private detachPendingWriteErrorListener(): void {
    const stdin = this._process.stdin;
    if (!this._closed || this._pendingWrites > 0 || !this._stdinErrorHandler) return;

    if (this._stdinErrorObserved) {
      this.retainStdinErrorListenerUntilClose();
      return;
    }

    stdin?.off('error', this._stdinErrorHandler);
    if (this._stdinCloseHandler) stdin?.off('close', this._stdinCloseHandler);
    this._stdinErrorHandler = null;
    this._stdinCloseHandler = null;
  }

  private retainStdinErrorListenerUntilClose(): void {
    const stdin = this._process.stdin;
    const errorHandler = this._stdinErrorHandler;
    if (!stdin || !errorHandler) return;
    if (stdin.closed) {
      stdin.off('error', errorHandler);
      this._stdinErrorHandler = null;
      return;
    }
    if (this._stdinCloseHandler) return;

    this._stdinCloseHandler = () => {
      stdin.off('error', errorHandler);
      this._stdinErrorHandler = null;
      this._stdinCloseHandler = null;
    };
    stdin.once('close', this._stdinCloseHandler);
  }

  private finish(error?: Error): void {
    if (this._closed) return;
    this._closed = true;
    this.detachListeners();
    this._readBuffer.clear();

    for (const reject of this._pendingSends) reject(error ?? new Error('Transport is closed'));
    this._pendingSends.clear();

    try {
      if (error) this.onerror?.(error);
    } finally {
      this.onclose?.();
    }
  }

  async close(): Promise<void> {
    this.finish();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this._closed) throw new Error('Transport is closed');
    const stdin = this._process.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error('Child process stdin is not writable');

    const json = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        this._pendingSends.delete(rejectPending);
        if (error) reject(error);
        else resolve();
      };
      const rejectPending = (error: Error) => settle(error);
      this._pendingSends.add(rejectPending);
      this._pendingWrites += 1;

      try {
        stdin.write(json, (error) => {
          this._pendingWrites -= 1;
          if (error) {
            this._stdinErrorObserved = true;
            this.retainStdinErrorListenerUntilClose();
            if (this._closed) settle(error);
            else this.finish(error);
          } else {
            settle();
          }
          this.detachPendingWriteErrorListener();
        });
      } catch (error) {
        this._pendingWrites -= 1;
        settle(error instanceof Error ? error : new Error(String(error)));
        this.detachPendingWriteErrorListener();
      }
    });
  }
}
