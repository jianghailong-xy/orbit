import { Injectable, NotFoundException } from '@nestjs/common';
import {
  WIKI_JOBS_READ,
  type WikiJobCallCounts,
  type WikiJobCallView,
  type WikiJobFailureKind,
  type WikiJobKind,
  type WikiJobProgressView,
  type WikiJobState,
  type WikiJobView,
  type WikiJobWaitingFor,
  type WikiJobsRead,
  type WikiModelRequestState,
  type WikiSystemModelErrorKind,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A space's server runs, as Activity's Runs card and a run's page read them (contract `jobs.read`, design §2.2 and
 * §5.2): the newest `WIKI_JOBS_READ.jobs` rows of `wiki_job`, each with where it stands — the pipeline's step and
 * count, its calls counted by state, the tokens they reported, and while it waits how many runs or calls the
 * deployment takes before it — and its newest `WIKI_JOBS_READ.callsPerJob` calls as a log.
 *
 * A call is its metadata alone: step, unit, attempt, state, when it was queued, started and ended, its tokens, its
 * HTTP status and its error. Neither the call (system prompt, prompt) nor what came back (answer, partial) is read
 * here, and nothing in a job's or a call's row names the System model's address or key (contract
 * `systemModel.request.errors`: the queue's words name neither).
 *
 * The positions are the queues' own orders, across every space and account of the deployment, as the claims take
 * them: a job's `priority DESC, created_at, id` (`jobs.lease.claim`), a call's `priority DESC, enqueued_at, id`
 * (`modelQueue.concurrency.claim`). Only a count of what is ahead leaves here — never whose it is.
 *
 * The owner's alone: another account's space is the plain 404. A read — nothing here writes.
 */
@Injectable()
export class WikiJobReads {
  constructor(private readonly prisma: PrismaService) {}

  async read(ownerId: string, spaceId: string): Promise<WikiJobsRead> {
    const space = await this.prisma.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { id: true } });
    if (!space) throw new NotFoundException('no such wiki space');

    const jobs = await this.prisma.$queryRaw<JobRow[]>`
      SELECT j."id", j."kind", j."state", j."waiting_for" AS "waitingFor", j."priority", j."attempts",
             j."created_at" AS "createdAt", j."updated_at" AS "updatedAt", j."started_at" AS "startedAt",
             j."ended_at" AS "endedAt", j."next_attempt_at" AS "nextAttemptAt", j."failure_kind" AS "failureKind",
             j."error", j."progress",
             CASE WHEN j."state" = 'queued' THEN (
               SELECT count(*)::int FROM "wiki_job" q
               WHERE q."state" = 'queued'
                 AND (q."priority" > j."priority"
                   OR (q."priority" = j."priority" AND (q."created_at", q."id") < (j."created_at", j."id")))
             ) END AS "ahead"
      FROM "wiki_job" j
      WHERE j."owner_id" = ${ownerId}::uuid AND j."space_id" = ${spaceId}::uuid
      ORDER BY j."created_at" DESC, j."id" DESC
      LIMIT ${WIKI_JOBS_READ.jobs}`;
    if (jobs.length === 0) return { spaceId, jobs: [] };
    const ids = jobs.map((job) => job.id);

    const counted = await this.prisma.$queryRaw<CountRow[]>`
      SELECT r."job_id" AS "jobId",
             count(*)::int AS "total",
             (count(*) FILTER (WHERE r."state" = 'queued'))::int AS "queued",
             (count(*) FILTER (WHERE r."state" = 'running'))::int AS "running",
             (count(*) FILTER (WHERE r."state" = 'succeeded'))::int AS "succeeded",
             (count(*) FILTER (WHERE r."state" = 'failed'))::int AS "failed",
             (count(*) FILTER (WHERE r."state" = 'cancelled'))::int AS "cancelled",
             COALESCE(sum(r."input_tokens"), 0)::int AS "inputTokens",
             COALESCE(sum(r."output_tokens"), 0)::int AS "outputTokens"
      FROM "wiki_model_request" r
      WHERE r."job_id" = ANY(${ids}::uuid[]) AND r."owner_id" = ${ownerId}::uuid
      GROUP BY r."job_id"`;

    // Of each job's queued calls, the one the queue reaches first, and how many queued calls sort before it.
    const next = await this.prisma.$queryRaw<NextRow[]>`
      SELECT DISTINCT ON (r."job_id") r."job_id" AS "jobId", r."enqueued_at" AS "enqueuedAt",
             (SELECT count(*)::int FROM "wiki_model_request" q
               WHERE q."state" = 'queued'
                 AND (q."priority" > r."priority"
                   OR (q."priority" = r."priority" AND (q."enqueued_at", q."id") < (r."enqueued_at", r."id")))) AS "ahead"
      FROM "wiki_model_request" r
      WHERE r."job_id" = ANY(${ids}::uuid[]) AND r."owner_id" = ${ownerId}::uuid AND r."state" = 'queued'
      ORDER BY r."job_id", r."priority" DESC, r."enqueued_at", r."id"`;

    // Each job's newest calls, by when they were queued; a queued one with its place in the deployment's queue.
    const calls = await this.prisma.$queryRaw<CallRow[]>`
      SELECT t."id", t."jobId", t."step", t."unit", t."attempt", t."attempts", t."state", t."enqueuedAt",
             t."startedAt", t."endedAt", t."inputTokens", t."outputTokens", t."httpStatus", t."error", t."errorKind",
             CASE WHEN t."state" = 'queued' THEN (
               SELECT count(*)::int FROM "wiki_model_request" q
               WHERE q."state" = 'queued'
                 AND (q."priority" > t."priority"
                   OR (q."priority" = t."priority" AND (q."enqueued_at", q."id") < (t."enqueuedAt", t."id")))
             ) END AS "ahead"
      FROM (
        SELECT r."id", r."job_id" AS "jobId", r."step", r."unit", r."attempt", r."attempts", r."state", r."priority",
               r."enqueued_at" AS "enqueuedAt", r."started_at" AS "startedAt", r."ended_at" AS "endedAt",
               r."input_tokens" AS "inputTokens", r."output_tokens" AS "outputTokens", r."http_status" AS "httpStatus",
               r."error", r."error_kind" AS "errorKind",
               row_number() OVER (PARTITION BY r."job_id" ORDER BY r."enqueued_at" DESC, r."id" DESC) AS "newest"
        FROM "wiki_model_request" r
        WHERE r."job_id" = ANY(${ids}::uuid[]) AND r."owner_id" = ${ownerId}::uuid
      ) t
      WHERE t."newest" <= ${WIKI_JOBS_READ.callsPerJob}
      ORDER BY t."jobId", t."enqueuedAt", t."id"`;

    const countsOf = new Map(counted.map((row) => [row.jobId, row]));
    const nextOf = new Map(next.map((row) => [row.jobId, row]));
    const callsOf = new Map<string, WikiJobCallView[]>();
    for (const row of calls) {
      const list = callsOf.get(row.jobId) ?? [];
      list.push(callView(row));
      callsOf.set(row.jobId, list);
    }
    return {
      spaceId,
      jobs: jobs.map((job): WikiJobView => {
        const count = countsOf.get(job.id);
        const first = nextOf.get(job.id);
        return {
          id: job.id,
          kind: job.kind as WikiJobKind,
          state: job.state as WikiJobState,
          waitingFor: (job.waitingFor as WikiJobWaitingFor | null) ?? null,
          priority: job.priority,
          attempts: job.attempts,
          createdAt: job.createdAt.toISOString(),
          updatedAt: job.updatedAt.toISOString(),
          startedAt: job.startedAt?.toISOString() ?? null,
          endedAt: job.endedAt?.toISOString() ?? null,
          nextAttemptAt: job.nextAttemptAt?.toISOString() ?? null,
          failureKind: (job.failureKind as WikiJobFailureKind | null) ?? null,
          error: job.error,
          ahead: job.ahead ?? null,
          progress: wikiJobProgressView(job.progress),
          calls: count ? countsView(count) : NO_CALLS,
          nextCall: first ? { ahead: first.ahead, enqueuedAt: first.enqueuedAt.toISOString() } : null,
          requests: callsOf.get(job.id) ?? [],
        };
      }),
    };
  }
}

/**
 * A pipeline's `progress` (contract `jobs.progress`) as one step and, when it counts, done of total. A pipeline that
 * writes `done` and `total` is read as it wrote them; the import's own shape (`import.server.progress`: notes, read,
 * failed) counts the notes it has read or given up on against the notes it was handed.
 */
export function wikiJobProgressView(progress: unknown): WikiJobProgressView | null {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
  const raw = progress as Record<string, unknown>;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  const step = typeof raw.step === 'string' && raw.step.trim() !== '' ? raw.step : null;
  let done = count(raw.done);
  let total = count(raw.total);
  if (done === null && total === null && count(raw.notes) !== null) {
    total = count(raw.notes);
    done = (count(raw.read) ?? 0) + (count(raw.failed) ?? 0);
  }
  if (step === null && done === null && total === null) return null;
  return { step, done, total };
}

const NO_CALLS: WikiJobCallCounts = {
  total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, inputTokens: 0, outputTokens: 0,
};

function countsView(row: CountRow): WikiJobCallCounts {
  return {
    total: row.total,
    queued: row.queued,
    running: row.running,
    succeeded: row.succeeded,
    failed: row.failed,
    cancelled: row.cancelled,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
  };
}

function callView(row: CallRow): WikiJobCallView {
  return {
    id: row.id,
    step: row.step,
    unit: row.unit,
    attempt: row.attempt,
    attempts: row.attempts,
    state: row.state as WikiModelRequestState,
    enqueuedAt: row.enqueuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    httpStatus: row.httpStatus,
    error: row.error,
    errorKind: (row.errorKind as WikiSystemModelErrorKind | null) ?? null,
    ahead: row.ahead ?? null,
  };
}

interface JobRow {
  id: string;
  kind: string;
  state: string;
  waitingFor: string | null;
  priority: number;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  nextAttemptAt: Date | null;
  failureKind: string | null;
  error: string | null;
  progress: unknown;
  ahead: number | null;
}

interface CountRow {
  jobId: string;
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  inputTokens: number;
  outputTokens: number;
}

interface NextRow {
  jobId: string;
  enqueuedAt: Date;
  ahead: number;
}

interface CallRow {
  id: string;
  jobId: string;
  step: string;
  unit: string;
  attempt: number;
  attempts: number;
  state: string;
  enqueuedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  inputTokens: number | null;
  outputTokens: number | null;
  httpStatus: number | null;
  error: string | null;
  errorKind: string | null;
  ahead: number | null;
}
