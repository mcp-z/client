import * as http from 'node:http';
import * as https from 'node:https';

const [urlString] = process.argv.slice(2);

if (!urlString) {
  console.error('Expected the application-specific shutdown URL');
  process.exitCode = 2;
} else {
  try {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;
    const status = await new Promise((resolve, reject) => {
      const request = client.request(url, { method: 'POST', agent: false }, (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      });
      request.once('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('Shutdown request timed out')));
      request.end();
    });
    if (status !== 202) {
      throw new Error(`Shutdown endpoint returned HTTP ${status ?? 'unknown'}`);
    }
  } catch (error) {
    console.error(`Could not request application shutdown: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
