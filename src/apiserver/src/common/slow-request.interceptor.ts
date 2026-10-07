import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, finalize } from 'rxjs';

/**
 * One line per request the server spent a noticeable time on.
 *
 * The question this exists to answer is "which endpoint is slow", and until this line nothing
 * answered it directly. The apiserver's logs carry application events — a sweep's counts, an
 * exception's stack — and no request at all; the gateway in front of it logs the path, the status
 * and the bytes with no timings either (nginx's `$request_time` was added beside this, in
 * gateway/nginx.conf). Answering it on 2026-10-07 meant a harness inside the container replaying
 * the hot statements against pg_stat_statements — a reader looking at a page that feels slow
 * cannot do that, and should not have to.
 *
 * The TAIL, not an access log. The gateway is the access log; a line per request here would be
 * several a second of noise in the file operators read. {@link SLOW_REQUEST_MS} is where the
 * request is slow to a person rather than to a stopwatch — on this deployment the pollers that a
 * client waits on sit at 200–700 ms, so the line names them the day they are the problem.
 *
 * WHAT IT DELIBERATELY LEAVES OUT
 * ===============================
 * The status: it is read here before the response is written (the framework writes it after every
 * interceptor has returned), and for a request about to be a 500 it is read before the exception
 * filter runs — a wrong status on a slow line is worse than no status, and a failure already has a
 * line of its own, with its stack. The user, and the ids in the path: the metrics registry refuses
 * the same labels for the same reason (common/db-conflict-metrics.ts) — one series per session is
 * not telemetry, it is a copy of the table. The route is the TEMPLATE (`/api/sessions/:id`), as
 * the conflict boundary's own line logs it, so lines group and no id or query string reaches the
 * file.
 */
const SLOW_REQUEST_MS = 500;

/**
 * Routes that are supposed to hold, and are therefore not timed at all.
 *
 *  - The runner door's four long polls sit on a 25 s deadline waiting for work
 *    (common/transaction-retry.ts's poll budget): the session claim, the per-session inbox, the
 *    wake poll, and the approval a live turn blocks on. Each is "slow" by construction, so a line
 *    about one would say nothing; what would be worth knowing is one that never ended, and that is
 *    a runner-side question.
 *  - The two SSE streams stay open for as long as what they stream — a transcript, a user's
 *    control-plane events.
 */
const HELD_ROUTES = new Set([
  '/api/runner/sessions/claim',
  '/api/runner/wake',
  '/api/runner/sessions/:id/inbox',
  '/api/runner/sessions/:id/approvals/:approvalId',
  '/api/events',
  '/api/sessions/:id/events',
]);

@Injectable()
export class SlowRequestInterceptor implements NestInterceptor {
  private readonly log = new Logger(SlowRequestInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ method?: string; route?: { path?: string } }>();
    const route = request?.route?.path;
    if (typeof route !== 'string' || HELD_ROUTES.has(route)) return next.handle();

    const startedAt = Date.now();
    return next.handle().pipe(
      // finalize and not tap: a request the client abandoned is unsubscribed rather than
      // completed, and one that ran for four seconds before the browser gave up is exactly the
      // line worth having.
      finalize(() => {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs < SLOW_REQUEST_MS) return;
        this.log.warn(`${request?.method ?? '?'} ${route} ${elapsedMs}ms`);
      }),
    );
  }
}
