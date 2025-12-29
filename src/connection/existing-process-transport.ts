/**
 * existing-process-transport.ts
 *
 * MCP transport that wraps an existing child process for stdio communication.
 * Used when connecting to servers already spawned by initServers().
 */

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ChildProcess } from 'child_process';

/**
 * Transport that communicates with an existing child process via stdio.
 * Does NOT spawn a new process - uses the one provided.
 */
export class ExistingProcessTransport implements Transport {
  private _process: ChildProcess;
  private _readBuffer: ReadBuffer;
  private _dataHandler: ((chunk: Buffer) => void) | null = null;
  private _errorHandler: ((error: Error) => void) | null = null;

  // Transport interface callbacks
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

  /**
   * Start the transport - sets up stdio listeners on existing process.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Listen for process events
      this._process.on('error', (error) => {
        this.onerror?.(error);
        reject(error);
      });

      this._process.on('close', () => {
        this.onclose?.();
      });

      // Create and save data handler for close
      this._dataHandler = (chunk: Buffer) => {
        this._readBuffer.append(chunk);
        this.processReadBuffer();
      };

      // Create and save error handler for close
      this._errorHandler = (error: Error) => {
        this.onerror?.(error);
      };

      // Listen for stdout data (MCP messages)
      this._process.stdout?.on('data', this._dataHandler);
      this._process.stdout?.on('error', this._errorHandler);
      this._process.stdin?.on('error', this._errorHandler);

      // Process is already running - resolve immediately
      resolve();
    });
  }

  /**
   * Process buffered messages from stdout.
   */
  private processReadBuffer(): void {
    while (true) {
      try {
        const message = this._readBuffer.readMessage();
        if (message === null) {
          break;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  }

  /**
   * Close the transport - close without killing the shared process.
   * The process is managed by the cluster and may have other active connections.
   */
  async close(): Promise<void> {
    if (this._dataHandler) {
      this._process.stdout?.off('data', this._dataHandler);
      this._dataHandler = null;
    }

    if (this._errorHandler) {
      this._process.stdout?.off('error', this._errorHandler);
      this._process.stdin?.off('error', this._errorHandler);
      this._errorHandler = null;
    }

    this._readBuffer.clear();
  }

  /**
   * Send a message to the server via stdin.
   */
  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._process.stdin) {
        reject(new Error('stdin is not available'));
        return;
      }

      const json = serializeMessage(message);

      if (this._process.stdin.write(json)) {
        resolve();
      } else {
        this._process.stdin.once('drain', resolve);
      }
    });
  }
}
