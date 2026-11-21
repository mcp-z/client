import type { Server } from 'http';
import type { AddressInfo } from 'net';

/** Binds the server to port 0 on the named host and returns the OS-assigned port once it is listening. */
export async function listenOnFreePort(server: Server, host: string): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
