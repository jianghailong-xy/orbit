import type { Server } from 'node:http';

/**
 * How long an apiserver holds an HTTP connection that is idle between two requests. Both of its listeners, the public
 * one (main.ts) and the link gateway's (runner-api/runner-link-call.ts), are given these timeouts before they take
 * their first connection.
 *
 * WHY THE CALLER MUST LET GO FIRST. Either side of a kept-alive connection may close it once it is idle. A caller that
 * closes it never sends on it again. A server that closes it can meet a request the caller has just sent, which
 * reaches a closed socket and is answered with a reset. nginx does not send a POST again, so its caller gets a 502.
 * The link gateway sends an idempotent call again (counted `lost`) and leaves any other to the runner to send again.
 * So the apiserver holds an idle connection longer than any caller does. At Node's default of 5 s, C2b's judged hour
 * (2026-10-31) lost 6 POST /api/runner/link-token calls to 502s and sent 28 heartbeats again, all to this race.
 *
 * The callers, and how long each keeps an idle connection (idle-connections.spec.ts fails unless this is longer):
 *   - the web gateway's nginx, 60 s. Since nginx 1.29.7 it keeps connections to the apiserver alive with no
 *     `keepalive` directive, closing an idle one after the upstream default `keepalive_timeout 60s`. With one
 *     apiserver it proxies without an `upstream` block, so there is nowhere to set a shorter value.
 *   - the link gateway, 90 s: its backends' `IdleConnTimeout` (src/link-gateway/backend.go). Its revocation and mode
 *     reads use Go's default transport, also 90 s.
 * So keepAliveTimeout is 120 s. A caller added later must let go sooner too (docs/self-hosting.md, "Several
 * apiservers").
 *
 * headersTimeout (125 s) and requestTimeout (300 s, Node's default) stay above keepAliveTimeout. On Node 26 neither
 * timer runs while a connection waits between requests: both start again at the next request's first byte
 * (idle-connections.spec.ts holds an idle connection past both). Kept above it, neither could close an idle connection
 * before keepAliveTimeout does, were it ever to count that wait.
 *
 * Stopping takes no longer. An apiserver closes no listener when it stops: a SIGTERM ends the process at once, and
 * `docker stop` ends its container with SIGKILL after the grace period, since the image's `sh` is PID 1 and ignores
 * SIGTERM. Its idle connections end with it. A `server.close()` would close the idle ones at once too, but a
 * connection answering a request when close() is called stays open after its answer for up to keepAliveTimeout. A
 * graceful stop added later must close those itself.
 */
export function holdIdleConnections(server: Server): Server {
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.requestTimeout = 300_000;
  return server;
}
