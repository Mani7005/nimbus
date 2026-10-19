import type { IncomingMessage, Server, ServerResponse } from "http";

export type ClosableServer = Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections" | "on" | "off">;

/**
 * Stops accepting connections and resolves once in-flight requests have finished. Idle keep-alive connections are
 * closed as soon as they become idle, and requests still arriving on open connections are told to close them. If
 * requests are still running after timeoutMs, every remaining connection is destroyed and the promise rejects.
 */
export function closeHttpServer(server: ClosableServer, timeoutMs: number, idleSweepMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const markClosing = (_req: IncomingMessage, res: ServerResponse) => res.setHeader("Connection", "close");

    const sweep = setInterval(() => server.closeIdleConnections(), idleSweepMs);
    const deadline = setTimeout(() => {
      timedOut = true;
      server.closeAllConnections();
    }, timeoutMs);

    server.on("request", markClosing);
    server.close((error) => {
      clearInterval(sweep);
      clearTimeout(deadline);
      server.off("request", markClosing);
      if (timedOut) reject(new Error(`in-flight requests did not finish within ${timeoutMs}ms; remaining connections were closed`));
      else if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
