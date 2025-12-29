/**
 * wait-for-http-ready.ts
 *
 * Utility for waiting for HTTP servers to become ready.
 */

/**
 * Wait for HTTP server to be ready by checking endpoint accessibility.
 * Used to handle HTTP servers that need time to start listening.
 *
 * @param url - URL to check for server readiness
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 30000)
 * @returns Promise that resolves when server is ready
 * @throws Error if server doesn't become ready within timeout
 */
export async function waitForHttpReady(url: string, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  const maxRetries = Math.ceil(timeoutMs / 100); // Check every 100ms

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Use HEAD request to check server is responding
      const response = await fetch(url, {
        method: 'HEAD',
        headers: { Connection: 'close' },
        signal: AbortSignal.timeout(500), // 500ms per attempt
      });

      // Server is responding if we get any HTTP status
      if (response.status >= 200 && response.status < 500) {
        return;
      }

      // Server error (5xx) - keep trying as it might still be starting
    } catch (_error) {
      // Connection refused, timeout, or network error
      // Server not ready yet, continue polling
      if (i === maxRetries - 1) {
        const elapsed = Date.now() - start;
        throw new Error(`HTTP server ${url} not ready after ${elapsed}ms`);
      }
    }

    // Wait before retry
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`HTTP server ${url} not ready after ${timeoutMs}ms`);
}
