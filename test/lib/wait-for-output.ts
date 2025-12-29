/**
 * Wait for output polling utility for testing spawned processes.
 *
 * Polls a getter function until a regex pattern matches or timeout is reached.
 * Follows the waitFor{X} pattern used in the codebase (see src/lib/wait-for-port.ts).
 */

/**
 * Wait for process output to match a regex pattern.
 *
 * Polls the output getter function every 100ms until the regex matches
 * or the timeout is reached.
 *
 * @param getOutput - Function that returns the current output string
 * @param pattern - Regex pattern to match against output
 * @param timeout - Maximum time to wait in milliseconds (default: 8000)
 * @returns Promise that resolves when pattern matches
 * @throws Error if timeout is reached before pattern matches
 *
 * @example
 * const { child, getOut } = spawnProcess();
 * await waitForOutput(getOut, /server started/i, 10000);
 */
export async function waitForOutput(getOutput: () => string, pattern: RegExp, timeout = 8000): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const intervalId = setInterval(() => {
      try {
        if (pattern.test(getOutput())) {
          clearInterval(intervalId);
          resolve(true);
        } else if (Date.now() - start > timeout) {
          clearInterval(intervalId);
          reject(new Error(`Timed out waiting for output: ${pattern}`));
        }
      } catch (error) {
        clearInterval(intervalId);
        reject(error);
      }
    }, 100);
  });
}
