import type { Server, ServerResponse } from 'node:http';
import { type MonoTypeOperatorFunction, ReplaySubject, takeUntil } from 'rxjs';

/**
 * How an apiserver stops (main.ts): on SIGTERM it lets go of its callers before it lets go of anything they need.
 *
 *   1. Both listeners stop accepting, the public one (PORT) and the link gateway's (RUNNER_LINK_INTERNAL_PORT). A
 *      caller that connects now is refused, which nginx and the link gateway both treat as "try another apiserver"
 *      for any request, a POST too: nothing was sent (docs/self-hosting.md, "Several apiservers").
 *      But first each listener takes in what has already reached it (`settle`): the connections the kernel has
 *      accepted that the event loop has not, and the requests sent on a connection that it has not read yet. Closing a
 *      listener resets the connections still in its accept queue, and closing an idle connection with a request unread
 *      on it resets that connection, after the caller sent its request, so that nginx answers a POST 502 rather than
 *      send it again. Under load the event loop is behind by hundreds of milliseconds, and both happened: the staging
 *      drill of 2026-11-11 (grace30-r2, host load 34 to 45) had 7 POSTs reset that way. So a stop goes on taking in
 *      connections and reading requests until one turn of the event loop has brought none, and only then closes.
 *   2. The session streams and the control-plane stream end (`untilStopping`), cleanly, so that each client opens
 *      its stream again, on another apiserver, from the last stored event it had (`sinceSeq`). The long polls end
 *      the same way, with the answer they give when their wait runs out (`isStopping`, `pauseUnlessStopping`): the
 *      approval long poll says PENDING, and its reader asks again at once, now of another apiserver; a merge's
 *      `waitSeconds` says TIMED_OUT, the merge still queued.
 *   3. Requests in flight are answered, for up to DRAIN_MS. Each answer from here on says `Connection: close`, and
 *      the connection is closed once it is sent, so a caller never sends another request on it. An idle connection
 *      is closed at once (Node's `server.close()`). Without this a connection busy when the stop began would stay
 *      open after its answer for keepAliveTimeout, 120 s (idle-connections.ts), and hold the stop up.
 *   4. A request still unanswered after DRAIN_MS is cut, and its connection closed.
 *   5. Then Nest's shutdown hooks stop the background work and close NATS, the LISTEN client, the leader's lock and
 *      the database: Nest runs every onModuleDestroy before it closes the HTTP server, which is why steps 1 to 4 are
 *      done here first.
 *   6. The process stays, its listeners closed, until LINGER_MS after the stop began, and then exits. While it is
 *      there its address refuses connections at once, and the web gateway and the link gateway move on to another
 *      apiserver and pass this one over (nginx for 10 s, the link gateway for 5 s). Once it has exited, its address
 *      answers nothing: a caller that still has it, as nginx does until it next looks the name up (10 s), waits out
 *      its connect timeout first (2 s), and measured on the staging stack (2026-11-11), nine session streams opening
 *      again a second after an apiserver had stopped in 12 ms got 504s that way. Waiting covers the clients that
 *      open their stream again after it ended: the web app after 2 to 2.5 s.
 *
 * All of it ends within STOP_MS, inside the apiserver's stop grace period: docker-compose.yml sets 30 s for it (the
 * account owner's decision of 2026-11-11, card 34vneMIw93BkO20LqQJnS), after which `docker stop` and Compose SIGKILL it.
 * A stop that has not ended by STOP_MS exits 1 rather than wait for that. STOP_MS counts from when this process gets the
 * signal, which on a loaded host is a while after `docker stop` sent it (2 s in grace30-r2), so it leaves the grace
 * period 5 s (graceful-stop.spec.ts holds it). The shutdown hooks after the drain took up to 1.4 s there, so they get 2 s.
 * The requests an apiserver answers take milliseconds. Of the few that wait on purpose, the approval long poll and a
 * merge's `waitSeconds` end at the stop (step 2). The Cursor key check waits up to 25 s for a runner's answer, which it
 * cannot give early: one that began more than about 2 s before the stop is answered, and one that began later is cut,
 * and the person who asked is told the key could not be checked and asks again.
 */
export const DRAIN_MS = 23_000;
export const LINGER_MS = 4_000;
export const STOP_MS = 25_000;
/** How long a stop goes on taking in connections and requests that had already reached it, at most (`settle`). */
export const SETTLE_MAX_MS = 1_000;

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
   * Takes in what has already reached the listener (graceful-stop.ts, step 1), then stops accepting, answers what is in
   * flight with `Connection: close` and closes each connection once its answer is sent. Resolves when no connection is
   * left, or at `deadline` (epoch ms), cutting what is still open; it says how many requests were cut.
   */
  drain(deadline: number): Promise<number>;
}

/** One turn of the event loop: resolves in the check phase of the next one, so after one whole poll phase. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function drainable(server: Server): DrainableServer {
  const open = new Set<ServerResponse>();
  let draining = false;
  // Connections taken in and requests read: `settle` closes once a turn of the event loop has brought neither.
  let arrivals = 0;
  server.prependListener('connection', () => {
    arrivals += 1;
  });
  // What has reached this listener and not yet the event loop: connections in the accept queue, requests unread on a
  // connection. Each turn of the event loop takes in what the kernel holds; one that brings nothing means none is left.
  const settle = async (until: number) => {
    await turn(); // the rest of the turn the stop began in
    for (let seen = -1; seen !== arrivals && Date.now() < until; ) {
      seen = arrivals;
      await turn();
    }
  };
  // After the stop began, a connection whose answer went out before it could be told to close (its headers were
  // already sent: a stream, or a download) is idle once that answer ends; close it then rather than after
  // keepAliveTimeout. Not while the stop is still taking in what reached it: an idle connection then may have a request
  // unread on it, and the listener's own close below closes the idle ones.
  let settled = false;
  const closeIdleSoon = () => setImmediate(() => settled && server.closeIdleConnections());
  server.prependListener('request', (_req, res: ServerResponse) => {
    arrivals += 1;
    open.add(res);
    res.once('close', () => open.delete(res));
    if (draining) {
      res.setHeader('Connection', 'close');
      res.once('finish', closeIdleSoon);
    }
  });
  return {
    inFlight: () => open.size,
    async drain(deadline) {
      draining = true;
      for (const res of open) {
        if (!res.headersSent) res.setHeader('Connection', 'close');
        res.once('finish', closeIdleSoon);
      }
      await settle(Math.min(deadline, Date.now() + SETTLE_MAX_MS));
      settled = true;
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

let stopped = false;

/** Whether the stop has begun: a request that waits on purpose answers now with what it would say when its wait ran out. */
export function isStopping(): boolean {
  return stopped;
}

/** Waits `ms`, or less: until the stop begins. */
export function pauseUnlessStopping(ms: number): Promise<void> {
  if (stopped) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const sub = stopping.subscribe(done);
    function done() {
      clearTimeout(timer);
      sub?.unsubscribe();
      resolve();
    }
  });
}

/** Ends every stream that `untilStopping` follows, and every wait in `pauseUnlessStopping`. */
export function endStreams(): void {
  stopped = true;
  stopping.next();
}
