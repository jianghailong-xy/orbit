import type { Server, ServerResponse } from 'node:http';
import { type MonoTypeOperatorFunction, ReplaySubject, takeUntil } from 'rxjs';

/**
 * How an apiserver stops (main.ts): on SIGTERM it lets go of its callers before it lets go of anything they need.
 *
 *   1. Both listeners stop accepting, the public one (PORT) and the link gateway's (RUNNER_LINK_INTERNAL_PORT). A
 *      caller that connects now is refused, which nginx and the link gateway both treat as "try another apiserver"
 *      for any request, a POST too: nothing was sent (docs/self-hosting.md, "Several apiservers").
 *   2. The session streams and the control-plane stream end (`untilStopping`), cleanly, so that each client opens
 *      its stream again, on another apiserver, from the last stored event it had (`sinceSeq`).
 *   3. Requests in flight are answered, for up to DRAIN_MS. Each answer from here on says `Connection: close`, and
 *      the connection is closed once it is sent, so a caller never sends another request on it. An idle connection
 *      is closed at once (Node's `server.close()`). Without this a connection busy when the stop began would stay
 *      open after its answer for keepAliveTimeout, 120 s (idle-connections.ts), and hold the stop up.
 *   4. A request still unanswered after DRAIN_MS is cut, and its connection closed.
 *   5. Then Nest's shutdown hooks stop the background work and close NATS, the LISTEN client, the leader's lock and
 *      the database: Nest runs every onModuleDestroy before it closes the HTTP server, which is why steps 1 to 4 are
 *      done here first.
 *
 * All of it ends within STOP_MS, inside the apiserver's stop grace period: docker-compose.yml sets none for it, so
 * `docker stop` and Compose give it Docker's default, 10 s, before SIGKILL. A stop that has not ended by STOP_MS exits
 * 1 rather than wait for that. The requests an apiserver answers take milliseconds; the few that wait on purpose (a
 * merge's `waitSeconds`, the approval long poll over HTTPS, the Cursor key check) are cut at DRAIN_MS, and their
 * callers ask again, as after any lost connection.
 */
export const DRAIN_MS = 6_000;
export const STOP_MS = 9_000;

const stopping = new ReplaySubject<void>(1);

/** Completes a stream when the apiserver starts to stop: Nest then ends the response the way a finished stream ends. */
export function untilStopping<T>(): MonoTypeOperatorFunction<T> {
  return takeUntil(stopping);
}

/** One listener's requests, from its first, so that a stop knows which are in flight. */
export interface DrainableServer {
  /** Requests whose answer has not yet been sent in full. */
  inFlight(): number;
  /**
   * Stops accepting, answers what is in flight with `Connection: close` and closes each connection once its answer is
   * sent. Resolves when no connection is left, or at `deadline` (epoch ms), cutting what is still open; it says how
   * many requests were cut.
   */
  drain(deadline: number): Promise<number>;
}

export function drainable(server: Server): DrainableServer {
  const open = new Set<ServerResponse>();
  let draining = false;
  // After the stop began, a connection whose answer went out before it could be told to close (its headers were
  // already sent: a stream, or a download) is idle once that answer ends; close it then rather than after
  // keepAliveTimeout.
  const closeIdleSoon = () => setImmediate(() => server.closeIdleConnections());
  server.prependListener('request', (_req, res: ServerResponse) => {
    open.add(res);
    res.once('close', () => open.delete(res));
    if (draining) {
      res.setHeader('Connection', 'close');
      res.once('finish', closeIdleSoon);
    }
  });
  return {
    inFlight: () => open.size,
    drain(deadline) {
      draining = true;
      for (const res of open) {
        if (!res.headersSent) res.setHeader('Connection', 'close');
        res.once('finish', closeIdleSoon);
      }
      return new Promise<number>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        // Stops accepting and closes every idle connection; calls back once the last connection has closed.
        server.close(() => {
          clearTimeout(timer);
          resolve(0);
        });
        timer = setTimeout(() => {
          const cut = open.size;
          server.closeAllConnections();
          resolve(cut);
        }, Math.max(0, deadline - Date.now()));
      });
    },
  };
}

/** Ends every stream that `untilStopping` follows. */
export function endStreams(): void {
  stopping.next();
}
