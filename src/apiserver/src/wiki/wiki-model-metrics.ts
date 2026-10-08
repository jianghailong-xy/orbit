import { Logger } from '@nestjs/common';
import { WIKI_SYSTEM_MODEL_ERROR_KINDS, WIKI_SYSTEM_MODEL_READ_STATES } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { WikiSystemModelReads } from './wiki-system-model';

/**
 * The wiki's System model and its request queue on GET /api/metrics (design §5.2, contract `systemModel.metrics`
 * and `modelQueue.metrics`).
 *
 * The model is called from the wiki-worker, which serves no port, so nothing here is counted in this process:
 * every number is read from the database when the endpoint is read, as the Watch gauges are, and every replica
 * answers the same. Three parts:
 *   - the model's state and the worker's heartbeat, from the row the worker writes (wiki_model_status);
 *   - the calls by outcome and how long they ran (wiki_model_request's settled rows);
 *   - the queue itself: how deep it is, how many calls are in flight, the wait and the run time of settled
 *     calls (p50/p95), the tokens they spent, and the failures by HTTP status.
 * Every label value comes from a closed set, never from a row, and the status label is the only one read
 * from a row (it is a status code, which is what the series is about).
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

/** One quantile observation set: `count` calls, with their p50 and p95, sum and count in seconds. */
export interface WikiModelQuantiles {
  p50: number | null;
  p95: number | null;
  sum: number;
  count: number;
}

/** The request queue as its rows stand (contract `modelQueue.metrics`). */
export interface WikiModelQueueStats {
  /** Queued requests: what is waiting for a slot. */
  depth: number;
  /** Running requests whose lease has not expired: what is in flight right now. */
  inFlight: number;
  /**
   * The calls by how each request's last attempt ended: a succeeded row is `succeeded`, a failed row its
   * error's class, and a request that failed and was requeued counts under that failure's class until it
   * succeeds or the wait limit ends it.
   */
  calls: Record<WikiModelCallOutcome, number>;
  /** How long settled calls waited in the queue (enqueued_at → started_at). */
  wait: WikiModelQuantiles;
  /** How long settled calls ran (started_at → ended_at). */
  run: WikiModelQuantiles;
  /** The answer's tokens, summed over succeeded calls. */
  tokens: { input: number; output: number };
  /** Failed calls by the HTTP status that refused them; `none` for a failure with no answer (a connection). */
  errors: ReadonlyArray<{ status: string; count: number }>;
}

export const NO_WIKI_MODEL_QUEUE_STATS: WikiModelQueueStats = {
  depth: 0,
  inFlight: 0,
  calls: { succeeded: 0, retryable: 0, unauthorized: 0, other: 0 },
  wait: { p50: null, p95: null, sum: 0, count: 0 },
  run: { p50: null, p95: null, sum: 0, count: 0 },
  tokens: { input: 0, output: 0 },
  errors: [],
};

interface QueueAggregateRow {
  depth: number;
  inFlight: number;
  succeeded: number;
  retryable: number;
  unauthorized: number;
  other: number;
  waitP50: number | null;
  waitP95: number | null;
  waitSum: number;
  waitCount: number;
  runP50: number | null;
  runP95: number | null;
  runSum: number;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Read the queue's numbers from its rows. One statement for everything but the status breakdown, which
 * needs its own group-by; both are reads of one table's summary indexes.
 */
export async function readWikiModelQueueStats(prisma: PrismaService): Promise<WikiModelQueueStats> {
  const [row] = await prisma.$queryRaw<QueueAggregateRow[]>`
    SELECT
      count(*) FILTER (WHERE "state" = 'queued')::int AS "depth",
      count(*) FILTER (WHERE "state" = 'running' AND "lease_deadline_at" > now())::int AS "inFlight",
      count(*) FILTER (WHERE "state" = 'succeeded')::int AS "succeeded",
      count(*) FILTER (WHERE "state" IN ('failed', 'queued', 'running') AND "error_kind" = 'retryable')::int AS "retryable",
      count(*) FILTER (WHERE "state" IN ('failed', 'queued', 'running') AND "error_kind" = 'unauthorized')::int AS "unauthorized",
      count(*) FILTER (WHERE "state" = 'failed' AND ("error_kind" IS NULL OR "error_kind" = 'other'))::int AS "other",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("started_at" - "enqueued_at")))
        FILTER (WHERE "started_at" IS NOT NULL AND "state" IN ('succeeded', 'failed')) AS "waitP50",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("started_at" - "enqueued_at")))
        FILTER (WHERE "started_at" IS NOT NULL AND "state" IN ('succeeded', 'failed')) AS "waitP95",
      coalesce(sum(EXTRACT(EPOCH FROM ("started_at" - "enqueued_at")))
        FILTER (WHERE "started_at" IS NOT NULL AND "state" IN ('succeeded', 'failed')), 0)::float8 AS "waitSum",
      count(*) FILTER (WHERE "started_at" IS NOT NULL AND "state" IN ('succeeded', 'failed'))::int AS "waitCount",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("ended_at" - "started_at")))
        FILTER (WHERE "ended_at" IS NOT NULL AND "started_at" IS NOT NULL) AS "runP50",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("ended_at" - "started_at")))
        FILTER (WHERE "ended_at" IS NOT NULL AND "started_at" IS NOT NULL) AS "runP95",
      coalesce(sum(EXTRACT(EPOCH FROM ("ended_at" - "started_at")))
        FILTER (WHERE "ended_at" IS NOT NULL AND "started_at" IS NOT NULL), 0)::float8 AS "runSum",
      count(*) FILTER (WHERE "ended_at" IS NOT NULL AND "started_at" IS NOT NULL)::int AS "runCount",
      coalesce(sum("input_tokens") FILTER (WHERE "state" = 'succeeded'), 0)::bigint AS "inputTokens",
      coalesce(sum("output_tokens") FILTER (WHERE "state" = 'succeeded'), 0)::bigint AS "outputTokens"
    FROM "wiki_model_request"`;
  const errors = await prisma.$queryRaw<Array<{ status: string; count: number }>>`
    SELECT coalesce("http_status"::text, 'none') AS "status", count(*)::int AS "count"
    FROM "wiki_model_request"
    WHERE "state" = 'failed'
    GROUP BY 1
    ORDER BY 1`;
  return {
    depth: row?.depth ?? 0,
    inFlight: row?.inFlight ?? 0,
    calls: {
      succeeded: row?.succeeded ?? 0,
      retryable: row?.retryable ?? 0,
      unauthorized: row?.unauthorized ?? 0,
      other: row?.other ?? 0,
    },
    wait: {
      p50: row?.waitP50 ?? null,
      p95: row?.waitP95 ?? null,
      sum: row?.waitSum ?? 0,
      count: row?.waitCount ?? 0,
    },
    run: {
      p50: row?.runP50 ?? null,
      p95: row?.runP95 ?? null,
      sum: row?.runSum ?? 0,
      count: row?.runCount ?? 0,
    },
    tokens: { input: Number(row?.inputTokens ?? 0), output: Number(row?.outputTokens ?? 0) },
    errors,
  };
}

const log = new Logger('WikiModelMetrics');

export async function renderWikiModelMetrics(
  prisma?: PrismaService,
  calls: WikiModelCallStats = NO_WIKI_MODEL_CALLS,
  now: Date = new Date(),
): Promise<string> {
  const lines: string[] = [];
  let queue: WikiModelQueueStats | undefined;
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
    try {
      queue = await readWikiModelQueueStats(prisma);
    } catch (error) {
      log.warn(`the request queue could not be read: ${error instanceof Error ? error.message : error}`);
    }
  }
  // The queue's own rows answer for the calls when they can be read; the caller's tally is what is left
  // when there is no database at all (a module booted without one, a scrape against a broken one).
  const callStats: WikiModelCallStats = queue
    ? { calls: queue.calls, duration: { p50: queue.run.p50, p95: queue.run.p95, sum: queue.run.sum, count: queue.run.count } }
    : calls;
  lines.push(
    '# HELP orbit_wiki_model_calls_total Calls to the System model that ended, by outcome: succeeded, retryable, unauthorized or other.',
    '# TYPE orbit_wiki_model_calls_total counter',
    ...WIKI_MODEL_CALL_OUTCOMES.map((outcome) => `orbit_wiki_model_calls_total{outcome="${outcome}"} ${callStats.calls[outcome]}`),
    '# HELP orbit_wiki_model_call_duration_seconds How long calls to the System model ran, from the request to the end of the stream.',
    '# TYPE orbit_wiki_model_call_duration_seconds summary',
    `orbit_wiki_model_call_duration_seconds{quantile="0.5"} ${callStats.duration.p50 ?? 'NaN'}`,
    `orbit_wiki_model_call_duration_seconds{quantile="0.95"} ${callStats.duration.p95 ?? 'NaN'}`,
    `orbit_wiki_model_call_duration_seconds_sum ${callStats.duration.sum}`,
    `orbit_wiki_model_call_duration_seconds_count ${callStats.duration.count}`,
  );
  const stats = queue ?? NO_WIKI_MODEL_QUEUE_STATS;
  lines.push(
    '# HELP orbit_wiki_model_queue_depth Requests waiting in the queue for a slot.',
    '# TYPE orbit_wiki_model_queue_depth gauge',
    `orbit_wiki_model_queue_depth ${stats.depth}`,
    '# HELP orbit_wiki_model_requests_in_flight Requests the queue has running right now, their lease unexpired.',
    '# TYPE orbit_wiki_model_requests_in_flight gauge',
    `orbit_wiki_model_requests_in_flight ${stats.inFlight}`,
    '# HELP orbit_wiki_model_request_wait_seconds How long settled calls waited in the queue before they started.',
    '# TYPE orbit_wiki_model_request_wait_seconds summary',
    `orbit_wiki_model_request_wait_seconds{quantile="0.5"} ${stats.wait.p50 ?? 'NaN'}`,
    `orbit_wiki_model_request_wait_seconds{quantile="0.95"} ${stats.wait.p95 ?? 'NaN'}`,
    `orbit_wiki_model_request_wait_seconds_sum ${stats.wait.sum}`,
    `orbit_wiki_model_request_wait_seconds_count ${stats.wait.count}`,
    '# HELP orbit_wiki_model_request_run_seconds How long settled calls ran, from their first byte to their last.',
    '# TYPE orbit_wiki_model_request_run_seconds summary',
    `orbit_wiki_model_request_run_seconds{quantile="0.5"} ${stats.run.p50 ?? 'NaN'}`,
    `orbit_wiki_model_request_run_seconds{quantile="0.95"} ${stats.run.p95 ?? 'NaN'}`,
    `orbit_wiki_model_request_run_seconds_sum ${stats.run.sum}`,
    `orbit_wiki_model_request_run_seconds_count ${stats.run.count}`,
    '# HELP orbit_wiki_model_request_tokens_total Tokens the queue\'s succeeded calls spent, by direction.',
    '# TYPE orbit_wiki_model_request_tokens_total counter',
    `orbit_wiki_model_request_tokens_total{direction="input"} ${stats.tokens.input}`,
    `orbit_wiki_model_request_tokens_total{direction="output"} ${stats.tokens.output}`,
    '# HELP orbit_wiki_model_request_errors_total Failed calls by the HTTP status that refused them; none for a failure with no answer.',
    '# TYPE orbit_wiki_model_request_errors_total counter',
    ...stats.errors.map((error) => `orbit_wiki_model_request_errors_total{status="${error.status.replace(/[^0-9a-z]/gi, '') || 'none'}"} ${error.count}`),
  );
  return `${lines.join('\n')}\n`;
}
