import { Controller, Get, Header, Optional, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatForbidden } from '../auth/pat-scope.decorator';
import { renderDbConflictMetrics } from '../common/db-conflict-metrics';
import { renderHttpRequestMetrics } from '../common/http-request-metrics';
import { PrismaService } from '../prisma/prisma.service';
import { renderRunEventSeqConflictMetrics } from '../runner-api/run-event-seq-conflicts';
import { renderCodexResetMetrics } from '../runners/codex-reset-metrics';
import { renderWatchMetrics } from '../watches/watch-metrics';
import { renderWikiModelMetrics } from '../wiki/wiki-model-metrics';
import { renderFleetMetrics } from './fleet-metrics';

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
@PatForbidden('NO_SCOPE')
@Controller('metrics')
export class MetricsController {
  /** Absent only where a module boots this controller without a database; the Watch gauges are then not read. */
  constructor(@Optional() private readonly prisma?: PrismaService) {}

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
  async read(): Promise<string> {
    return renderMetrics(this.prisma);
  }
}

/**
 * The whole body, as this route and the internal listener Prometheus scrapes (metrics-listener.ts) both serve it.
 * The Watch gauges and the wiki's System model are the parts read from the database, on every scrape
 * (watches/watch-metrics.ts, wiki/wiki-model-metrics.ts); the runner, session and task gauges are read from it at most
 * once per FLEET_GAUGES_TTL_MS (fleet-metrics.ts).
 */
export async function renderMetrics(prisma?: PrismaService): Promise<string> {
  return renderDbConflictMetrics() + renderCodexResetMetrics() + renderRunEventSeqConflictMetrics()
    + renderHttpRequestMetrics()
    + (await renderWatchMetrics(prisma))
    + (await renderWikiModelMetrics(prisma))
    + (await renderFleetMetrics(prisma));
}
