export function installHttpShutdown(app, mcpServer, getHttpServer, name) {
  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      const failures = [];
      const httpServer = getHttpServer();
      const httpClose = new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      try {
        await mcpServer.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        httpServer.closeAllConnections();
        await httpClose;
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, `${name} failed to close all HTTP resources`);
    })();
    return shutdownPromise;
  };
  const reportFailure = (error) => {
    console.error(`[${name}] shutdown failed:`, error);
    process.exitCode = 1;
  };

  app.post('/__mcpz/shutdown', (_request, response) => {
    response.status(202).end('stopping', () => {
      void shutdown().catch(reportFailure);
    });
  });

  return () => {
    void shutdown().catch(reportFailure);
  };
}
