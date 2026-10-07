import { Logger } from '@nestjs/common';
import { WIKI_SYSTEM_MODEL_ERROR_KINDS, WIKI_SYSTEM_MODEL_READ_STATES } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { WikiSystemModelReads } from './wiki-system-model';

/**
 * The wiki's System model on GET /api/metrics (design §5.2, contract `systemModel.metrics`).
 *
 * The model is called from the wiki-worker, which serves no port, so nothing here is counted in this process: every
 * number is read from the database when the endpoint is read, as the Watch gauges are, and every replica answers the
 * same. Two parts:
 *   - the model's state and the worker's heartbeat, from the row the worker writes (wiki_model_status);
 *   - the calls by outcome and how long they ran: their names, types and label sets are fixed here, and the request
 *     queue (wiki_model_request, the next phase), which keeps one row per call, fills them in. Until it does they
 *     read 0 calls and no observation — exactly what has gone through it.
 * Every label value comes from a closed set, never from a row.
 */

/** A call that ended: succeeded, or the class its error was given (contract `systemModel.request.errors`). */
export const WIKI_MODEL_CALL_OUTCOMES = ['succeeded', ...WIKI_SYSTEM_MODEL_ERROR_KINDS] as const;
export type WikiModelCallOutcome = (typeof WIKI_MODEL_CALL_OUTCOMES)[number];

/** The calls, as the request queue counts them. */
export interface WikiModelCallStats {
  calls: Record<WikiModelCallOutcome, number>;
  /** How long they ran, in seconds: the 0.5 and 0.95 quantiles (null with no observation), the sum and the count. */
  duration: { p50: number | null; p95: number | null; sum: number; count: number };
}

/** What the calls read before the request queue exists to count them: none. */
export const NO_WIKI_MODEL_CALLS: WikiModelCallStats = {
  calls: { succeeded: 0, retryable: 0, unauthorized: 0, other: 0 },
  duration: { p50: null, p95: null, sum: 0, count: 0 },
};

const log = new Logger('WikiModelMetrics');

export async function renderWikiModelMetrics(
  prisma?: PrismaService,
  calls: WikiModelCallStats = NO_WIKI_MODEL_CALLS,
  now: Date = new Date(),
): Promise<string> {
  const lines: string[] = [];
  if (prisma) {
    try {
      const status = await new WikiSystemModelReads(prisma).read(now);
      lines.push(
        '# HELP orbit_wiki_model_state The System model\'s state as GET /api/wiki/system-model answers it: 1 for that state, 0 for every other.',
        '# TYPE orbit_wiki_model_state gauge',
        ...WIKI_SYSTEM_MODEL_READ_STATES.map((state) => `orbit_wiki_model_state{state="${state}"} ${state === status.state ? 1 : 0}`),
        '# HELP orbit_wiki_worker_heartbeat_age_seconds Seconds since the wiki worker last wrote its heartbeat; absent while none has.',
        '# TYPE orbit_wiki_worker_heartbeat_age_seconds gauge',
      );
      if (status.workerSeenAt) {
        lines.push(`orbit_wiki_worker_heartbeat_age_seconds ${Math.max(0, (now.getTime() - Date.parse(status.workerSeenAt)) / 1000)}`);
      }
    } catch (error) {
      log.warn(`the System model's state could not be read: ${error instanceof Error ? error.message : error}`);
    }
  }
  lines.push(
    '# HELP orbit_wiki_model_calls_total Calls to the System model that ended, by outcome: succeeded, retryable, unauthorized or other.',
    '# TYPE orbit_wiki_model_calls_total counter',
    ...WIKI_MODEL_CALL_OUTCOMES.map((outcome) => `orbit_wiki_model_calls_total{outcome="${outcome}"} ${calls.calls[outcome]}`),
    '# HELP orbit_wiki_model_call_duration_seconds How long calls to the System model ran, from the request to the end of the stream.',
    '# TYPE orbit_wiki_model_call_duration_seconds summary',
    `orbit_wiki_model_call_duration_seconds{quantile="0.5"} ${calls.duration.p50 ?? 'NaN'}`,
    `orbit_wiki_model_call_duration_seconds{quantile="0.95"} ${calls.duration.p95 ?? 'NaN'}`,
    `orbit_wiki_model_call_duration_seconds_sum ${calls.duration.sum}`,
    `orbit_wiki_model_call_duration_seconds_count ${calls.duration.count}`,
  );
  return `${lines.join('\n')}\n`;
}
