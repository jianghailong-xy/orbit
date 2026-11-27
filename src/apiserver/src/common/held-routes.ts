/**
 * The routes that hold a request open on purpose, which no clock of "how long did this request take" may read.
 *
 * A held request takes as long as what it waits for, so its duration says nothing about the server. Timed, it would
 * be the slowest line of every report: a slow-request line per transcript a person closed (slow-request.interceptor.ts)
 * and, in the request histogram (http-request-metrics.ts), a p95 that is the length of people's attention spans.
 *
 *  - The SSE streams stay open for as long as what they stream: a user's control-plane events, one session's
 *    transcript, and the three viewer streams (a share link's, its sessions', a guest's). Every `@Sse` route is here,
 *    and held-routes.spec.ts reads the controllers to keep it so.
 *  - The approval `orbit mcp`'s permission tool asks for sits on a 25 s deadline waiting for a person.
 *
 * Templates, with the global prefix, as Express names a matched route (`req.route.path`).
 */
export const HELD_ROUTES: ReadonlySet<string> = new Set([
  '/api/events',
  '/api/sessions/:id/events',
  '/api/shared/:token/stream',
  '/api/shared/:token/sessions/:sessionId/stream',
  '/api/guest-sessions/:id/stream',
  '/api/runner/sessions/:id/approvals/:approvalId',
]);

/**
 * The model gateways, by prefix: the pool gateway (`/api/gw/codex`) and the Anthropic one (`/api/gw/anthropic`)
 * forward a model's turn, streamed for as long as the model writes, under a wildcard route of their own.
 */
export const HELD_ROUTE_PREFIXES: readonly string[] = ['/api/gw/'];

/**
 * Whether a request on this route template holds by design. The browser viewer's WebSocket is not a route: an upgrade
 * is answered on the server's `upgrade` event and never reaches the app (managed-runners/browser-viewer.ts).
 */
export function isHeldRoute(route: string): boolean {
  return HELD_ROUTES.has(route) || HELD_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix));
}
