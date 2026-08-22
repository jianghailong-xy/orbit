import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { renderDbConflictMetrics } from '../common/db-conflict-metrics';

/**
 * Where the database-conflict counters are read from.
 *
 * Behind the ordinary bearer token, like every other route: an operator scrapes it with the token
 * they already have, and there is no second secret to distribute, rotate or leak. That is a
 * deliberate trade — a scraper needs a long-lived token — and it is the cheaper side of it, because
 * the alternative is a new credential whose whole job is to protect numbers that name no user, no
 * session, no task and no row.
 *
 * The body is bounded by construction. `common/db-conflict-metrics.ts` admits label values only
 * from closed unions and shape tests and caps the number of series, so this cannot become a
 * dump of anything a caller sent, however the server is used.
 */
@UseGuards(JwtAuthGuard)
@Controller('metrics')
export class MetricsController {
  /**
   * The counters, in Prometheus text exposition format.
   *
   * `version=0.0.4` is what a scraper content-negotiates for and what `promtool` parses. Express
   * re-serializes the type and puts its own `charset` first, which is why the test matches the
   * parameters rather than the whole string: a scraper parses them too.
   */
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  @Header('Cache-Control', 'no-store')
  read(): string {
    return renderDbConflictMetrics();
  }
}
