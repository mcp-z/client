/**
 * OAuth Callback Server for CLI Authentication
 * Listens for OAuth authorization callbacks and captures authorization code
 */

import http from 'node:http';
import { logger as defaultLogger, type Logger } from '../utils/logger.ts';
import type { CallbackResult } from './types.ts';

export interface OAuthCallbackListenerOptions {
  /** Port to listen on (required - use get-port package to find available port) */
  port: number;
  /** Optional logger for debug output (defaults to singleton logger) */
  logger?: Logger;
}

/**
 * OAuthCallbackListener handles OAuth redirect callbacks
 * Starts a temporary HTTP server to receive authorization code
 *
 * Note: Caller is responsible for finding an available port using get-port package
 */
export class OAuthCallbackListener {
  private server: http.Server | undefined;
  private resolveCallback?: (result: CallbackResult) => void;
  private rejectCallback?: (error: Error) => void;
  private timeout: NodeJS.Timeout | undefined;
  private port: number;
  private logger: Logger;

  constructor(options: OAuthCallbackListenerOptions) {
    this.port = options.port;
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Start the callback server
   * Fails fast if port is already in use - caller should use get-port to find available port
   */
  async start(): Promise<void> {
    await this.listen(this.port);
    this.logger.debug(`✅ Callback server listening on http://localhost:${this.port}/callback`);
  }

  /**
   * Listen on a specific port
   */
  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        reject(error);
      });

      this.server.listen(port, () => {
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '', `http://localhost:${this.port}`);

    if (url.pathname === '/callback') {
      this.handleCallback(url, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }

  /**
   * Handle OAuth callback
   */
  private handleCallback(url: URL, res: http.ServerResponse): void {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDescription = url.searchParams.get('error_description');

    // Handle OAuth errors
    if (error) {
      const errorMessage = errorDescription ? `${error}: ${errorDescription}` : error;

      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h1>Authorization Failed</h1>
            <p>${errorMessage}</p>
            <script>setTimeout(() => window.close(), 3000);</script>
          </body>
        </html>
      `);

      if (this.rejectCallback) {
        this.rejectCallback(new Error(errorMessage));
      }
      return;
    }

    // Validate code parameter
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h1>Invalid Callback</h1>
            <p>Missing authorization code</p>
            <script>setTimeout(() => window.close(), 3000);</script>
          </body>
        </html>
      `);

      if (this.rejectCallback) {
        this.rejectCallback(new Error('Missing authorization code'));
      }
      return;
    }

    // Success - send confirmation page
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body>
          <h1>Authorization Successful</h1>
          <p>You can close this window and return to the terminal.</p>
          <script>setTimeout(() => window.close(), 2000);</script>
        </body>
      </html>
    `);

    // Resolve the promise with authorization code
    if (this.resolveCallback) {
      const result: CallbackResult = { code };
      if (state) {
        result.state = state;
      }
      this.resolveCallback(result);
    }
  }

  /**
   * Wait for OAuth callback with timeout
   */
  async waitForCallback(timeoutMs = 300000): Promise<CallbackResult> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;

      // Set timeout to prevent hanging forever
      this.timeout = setTimeout(() => {
        reject(new Error(`Authorization timeout - no callback received within ${timeoutMs / 1000} seconds`));
        this.stop();
      }, timeoutMs);
    });
  }

  /**
   * Stop the callback server and close
   */
  async stop(): Promise<void> {
    // Clear the timeout
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }

    // Close the server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => {
          this.logger.debug('🔒 Callback server closed');
          resolve();
        });
      });
      this.server = undefined;
    }
  }

  /**
   * Get the callback URL for this server
   */
  getCallbackUrl(): string {
    if (!this.port) {
      throw new Error('Server not started - call start() first');
    }
    return `http://localhost:${this.port}/callback`;
  }
}
