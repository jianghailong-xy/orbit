import type { IncomingMessage, ServerResponse } from 'node:http';

import { isHeldRoute } from './held-routes';

/**
 * How long the API takes to answer, per endpoint, in a histogram Prometheus reads (docs/self-hosting.md, "Monitoring").
 *
 * WHERE IT IS MEASURED
 * --------------------
 * Express middleware, first in main.ts, recording on the response's `finish`: the moment the last byte of the answer
 * was handed to the socket. Not an interceptor, because an interceptor runs before the status is decided — the
 * framework writes it after every interceptor has returned, and for a request about to be a 500 after the exception
 * filter has run (slow-request.interceptor.ts says the same) — and a latency per status class needs the status that
 * was sent. The clock starts when the request reaches the app, so it covers the body parsers, the guards, the handler,
 * the mappers and the filters: the time the caller waited for the answer, less the network.
 *
 * A request whose client went away before its answer was written never finishes, and is not observed. The gateway's
 * access log has it, as a 499.
 *
 * WHAT IT LEAVES OUT
 * ------------------
 * The routes that hold a request open on purpose (common/held-routes.ts): the SSE streams, the approval wait and the
 * model gateways. Each would put its holding time into the histogram, which would then measure people and models, not
 * the server. The browser viewer's WebSocket never reaches this middleware: an upgrade is answered on the server's
 * `upgrade` event, outside the app.
 *
 * THE LABELS (the registry rules of common/db-conflict-metrics.ts)
 * ----------------------------------------------------------------
 *  - `route` is the TEMPLATE Express matched, global prefix included (`/api/sessions/:id`), never the URL: a URL carries
 *    ids and, in its query, the SSE and attachment tokens. Templates are written in the controllers, so the set is
 *    closed by the code. A request no route matched, answered by Nest's not-found handler, is `unmatched`, whatever its
 *    path; a template that fails the shape test is `other`.
 *  - `method` is the method class: one of the seven methods the API serves, or `other`.
 *  - `status` is the status class: `2xx` to `5xx`, or `other` for anything outside them.
 *  - Past {@link HTTP_MAX_SERIES} label tuples, anything new is counted in one `overflow` series.
 */

/** Past this many label tuples, the histogram folds anything new into one `overflow` series. */
export const HTTP_MAX_SERIES = 1024;

/**
 * Upper bounds, in seconds. Dense where an answer goes from instant to noticeable (the slow-request line is at 0.5 s),
 * and ending where every answer is already a problem.
 */
export const HTTP_DURATION_BUCKETS_SECONDS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** A template as Express spells one: segments, `:params` and the `{*wildcard}` syntax. No quote, backslash or space. */
const ROUTE = /^\/[A-Za-z0-9/:._{}*-]*$/;
const ROUTE_MAX = 128;

type Labels = { route: string; method: string; status: string };

interface Series {
  labels: Labels;
  /** Per bucket, not cumulative: rendering adds them up. The last slot is past the largest bound. */
  counts: number[];
  sum: number;
  count: number;
}

const series = new Map<string, Series>();

/**
 * The route Nest's not-found handler is, under the global prefix: `router.all('*path')` on a router of its own
 * (@nestjs/platform-express `setNotFoundHandler`). A request that reaches it matched no route of the API.
 */
const NOT_FOUND_ROUTE = '*path';

function routeLabel(route: unknown): string {
  if (typeof route !== 'string' || route === NOT_FOUND_ROUTE) return 'unmatched';
  return route.length <= ROUTE_MAX && ROUTE.test(route) ? route : 'other';
}

function statusLabel(status: number): string {
  return Number.isInteger(status) && status >= 200 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other';
}

/** One answered request, as `finish` saw it. */
export interface HttpRequestSample {
  /** `req.route.path`: the matched template, or undefined when no route matched. */
  route: string | undefined;
  method: string | undefined;
  status: number;
  durationSeconds: number;
}

/** Count one answered request, unless its route holds by design. */
export function recordHttpRequest(sample: HttpRequestSample): void {
  if (typeof sample.route === 'string' && isHeldRoute(sample.route)) return;
  let labels: Labels = {
    route: routeLabel(sample.route),
    method: sample.method && METHODS.has(sample.method) ? sample.method : 'other',
    status: statusLabel(sample.status),
  };
  let key = `${labels.method} ${labels.route} ${labels.status}`;
  if (!series.has(key) && series.size >= HTTP_MAX_SERIES) {
    labels = { route: 'overflow', method: 'overflow', status: 'overflow' };
    key = 'overflow';
  }
  let one = series.get(key);
  if (!one) {
    one = { labels, counts: new Array<number>(HTTP_DURATION_BUCKETS_SECONDS.length + 1).fill(0), sum: 0, count: 0 };
    series.set(key, one);
  }
  const at = HTTP_DURATION_BUCKETS_SECONDS.findIndex((bound) => sample.durationSeconds <= bound);
  one.counts[at === -1 ? HTTP_DURATION_BUCKETS_SECONDS.length : at] += 1;
  one.sum += sample.durationSeconds;
  one.count += 1;
}

/** The middleware main.ts mounts first: starts the clock, and records the request when its answer has been written. */
export function httpRequestMetrics(
  req: IncomingMessage & { route?: { path?: unknown } },
  res: ServerResponse,
  next: () => void,
): void {
  const startedAt = process.hrtime.bigint();
  res.once('finish', () => {
    recordHttpRequest({
      // Read at `finish`, not now: Express sets it only once a route has matched.
      route: req.route?.path as string | undefined,
      method: req.method,
      status: res.statusCode,
      durationSeconds: Number(process.hrtime.bigint() - startedAt) / 1e9,
    });
  });
  next();
}

/** Every series, for a test that has to assert on one number. */
export function httpRequestMetricsSnapshot(): Array<{ labels: Labels; count: number; sum: number }> {
  return [...series.values()].map((one) => ({ labels: { ...one.labels }, count: one.count, sum: one.sum }));
}

/** Empty the registry. For tests; nothing in the server calls it. */
export function resetHttpRequestMetrics(): void {
  series.clear();
}

const NAME = 'orbit_http_request_duration_seconds';

/** Every label value has passed a shape test or comes from a closed set, so there is nothing to escape. */
function render(labels: Labels, le?: string): string {
  const pairs = [`route="${labels.route}"`, `method="${labels.method}"`, `status="${labels.status}"`];
  if (le !== undefined) pairs.push(`le="${le}"`);
  return `{${pairs.join(',')}}`;
}

/** The histogram in Prometheus text exposition format. */
export function renderHttpRequestMetrics(): string {
  const lines = [
    `# HELP ${NAME} Time from a request reaching the app to its answer being written, by route template, method and status class. Routes that hold by design are not observed.`,
    `# TYPE ${NAME} histogram`,
  ];
  for (const one of series.values()) {
    let cumulative = 0;
    HTTP_DURATION_BUCKETS_SECONDS.forEach((bound, index) => {
      cumulative += one.counts[index];
      lines.push(`${NAME}_bucket${render(one.labels, String(bound))} ${cumulative}`);
    });
    lines.push(`${NAME}_bucket${render(one.labels, '+Inf')} ${one.count}`);
    lines.push(`${NAME}_sum${render(one.labels)} ${one.sum}`);
    lines.push(`${NAME}_count${render(one.labels)} ${one.count}`);
  }
  return `${lines.join('\n')}\n`;
}
