import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WIKI_JOB, type WikiJobFailureKind } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import type { PrismaService } from '../prisma/prisma.service';
import { stripNul } from '../runner-api/strip-nul';
import { cutRunes } from './wiki-import-extract';

/**
 * The `wiki_job` table (migration 0401, contract `jobs`, design §5.1).
 *
 * THE CLAIM
 * A claim moves due queued jobs to running under a fresh lease generation, in one statement that skips what
 * another claim holds (`FOR UPDATE SKIP LOCKED`), at most one job per space
 * (`wiki_job_space_running_key` is the same rule in the database, for two schedulers that read the table at
 * once) and only kinds this build runs. Every write that settles the job afterwards is a compare-and-set on
 * that generation, so a worker whose lease ran out and was taken over settles nothing: the takeover's
 * generation is not its own.
 *
 * THE ORDER
 * A space runs its jobs in its own order: the highest priority first, then the longest-waiting — with one exception,
 * the owner's decision of 2026-10-10 (maintenance first, an articles job yields one round at most). An `articles` job
 * that has never been claimed waits for its space's round: the first `maintain` job made after it, until that round
 * has ended, every attempt and backoff of it included. On the canary each round's end queued an articles job that ran
 * for an hour and a half, and the next round, queued moments later, waited behind it (61e91611, an hour and 47
 * minutes). It yields that one round alone: a maintain job made after the round finds it ahead in first-come order,
 * so it is never starved. A job claimed before — handed back, put back for infra, parked on a repository operation —
 * has had its turn and yields to nothing, and nothing running is touched. Priorities are not changed for this: a
 * job's calls carry its priority into the deployment's model queue, where a lower one would rank the articles behind
 * every other space's calls, and `wiki_job_counts_chk` holds every priority at 0 or above.
 * Across spaces nothing moves. A space keeps the place in the deployment's line its first job by priority and first
 * come gives it, whichever of its jobs takes that place (`wikiJobQueueSql`; the jobs read's `ahead` counts by it).
 *
 * THE LEASE
 * A running row holds lease_owner, lease_generation and lease_deadline_at together (`wiki_job_lease_chk`
 * holds that both ways), and every settle clears them. A lease that runs out is not lost work: the sweep
 * puts the row back to queued with the lost attempt counted and a backoff, and the next claim — this
 * process's or another's — takes it from the start, where the request rows it already made answer the
 * replay (see wiki-model-queue.ts). A worker that is stopped hands its jobs back itself instead
 * (`releaseWikiJobLease`): queued at once and nothing counted, so a deploy costs a job no attempt (the owner's
 * decision of 2026-10-09), and the sweep only ever meets a lease nobody handed back — a worker that died.
 *
 * WHO RUNS
 * `owners` is the claim's account filter: null for every account (`server`), the canary list under `canary`,
 * and the empty array under `runner` — a worker started with the default claims nothing at all.
 *
 * THE RETRY LIMIT
 * An infra failure puts the job back in the queue, but not for ever (contract `jobs.retry.limit`): the attempt
 * that makes WIKI_JOB.maxAttempts ends it failed, and so does the attempt that makes
 * WIKI_JOB.unexpectedMaxAttempts when it failed with an error the build did not expect. Before the limit, a
 * docs_build job whose writer failed an assertion was put back every time its space was free (2026-10-09).
 * The executor ends the attempt it settles; a job the lease sweep or a repository wait put back at the limit
 * is never claimed again, and the next pass ends it. Either way what waits on the job (its calls, its
 * repository operations, its run or plan job) is settled in the same transaction.
 */

/** One claimed job, with the generation every later write must still match. */
export interface ClaimedWikiJob {
  id: string;
  ownerId: string;
  spaceId: string;
  kind: string;
  input: Record<string, unknown>;
  priority: number;
  attempts: number;
  leaseGeneration: string;
}

export interface ClaimWikiJobsInput {
  /** The lease holder, a uuid; also what the row's lease_owner says while it runs. */
  workerId: string;
  /** The kinds this build runs: a job of a kind no build here runs stays queued for the phase that adds it. */
  kinds: readonly string[];
  /** The accounts this worker may claim for; null is every account, [] is none. */
  owners: readonly string[] | null;
  limit: number;
  leaseMs?: number;
}

/**
 * The queued jobs of the accounts `owners` names (null is every account) and of the kinds `kinds` names, each with
 * whether it waits for its space's round (THE ORDER above): `dueOnly` keeps the ones a claim could take now — due,
 * under the retry limit — and `spaceId` keeps one space's. It is what the claim picks each space's job from, and
 * what the jobs read (wiki/wiki-job-reads.ts) reads a space's places by, so that Activity's `ahead` and the claim
 * cannot disagree about which job goes first.
 */
export function wikiJobQueueSql(input: {
  kinds: readonly string[];
  owners: readonly string[] | null;
  dueOnly: boolean;
  spaceId?: string;
}): Prisma.Sql {
  const kinds = input.kinds as string[];
  const owners = input.owners as string[] | null;
  return Prisma.sql`
    SELECT q."id", q."space_id", q."priority", q."created_at",
           -- An articles job never claimed waits while its round has not ended: the first maintain job of its space
           -- made after it, of a kind this build runs and no lower a priority, short of the retry limit.
           (q."kind" = 'articles' AND q."started_at" IS NULL AND EXISTS (
              SELECT 1 FROM "wiki_job" m
              WHERE m."space_id" = q."space_id" AND m."kind" = 'maintain'
                AND (m."created_at", m."id") > (q."created_at", q."id")
                AND NOT EXISTS (
                  SELECT 1 FROM "wiki_job" e
                  WHERE e."space_id" = q."space_id" AND e."kind" = 'maintain'
                    AND (e."created_at", e."id") > (q."created_at", q."id")
                    AND (e."created_at", e."id") < (m."created_at", m."id")
                )
                AND m."state" IN ('queued', 'running', 'waiting')
                AND m."attempts" < ${WIKI_JOB.maxAttempts}
                AND m."kind" = ANY(${kinds}::text[])
                AND m."priority" >= q."priority"
           )) AS "waits"
    FROM "wiki_job" q
    WHERE q."state" = 'queued'
      ${input.dueOnly
        // A job at the retry limit is never run again: the pass ends it (endWikiJobsPastRetryLimit).
        ? Prisma.sql`AND (q."next_attempt_at" IS NULL OR q."next_attempt_at" <= now()) AND q."attempts" < ${WIKI_JOB.maxAttempts}`
        : Prisma.empty}
      AND q."kind" = ANY(${kinds}::text[])
      AND (${owners}::uuid[] IS NULL OR q."owner_id" = ANY(${owners}::uuid[]))
      ${input.spaceId ? Prisma.sql`AND q."space_id" = ${input.spaceId}::uuid` : Prisma.empty}`;
}

/**
 * Claim up to `limit` due queued jobs, each under a new lease generation: each free space's next job in its own order
 * (THE ORDER above), the spaces taken by their places in the line — the owner's first and then the longest-waiting. A
 * space whose job is already running is skipped; a job another claim is holding is passed over rather than waited for.
 * Two claims of one space's last two jobs can read "no running job" at the same time — that is what the partial unique
 * index refuses, and the loser is answered with an empty claim rather than an error: its pass has simply taken nothing.
 */
export async function claimWikiJobs(prisma: PrismaService, input: ClaimWikiJobsInput): Promise<ClaimedWikiJob[]> {
  const lease = input.leaseMs ?? WIKI_JOB.leaseSeconds * 1000;
  try {
    return await prisma.$queryRaw<ClaimedWikiJob[]>`
      WITH "queue" AS (${wikiJobQueueSql({ kinds: input.kinds, owners: input.owners, dueOnly: true })}),
      "line" AS (
        SELECT q."id", q."waits",
               -- The job's turn in its space: priority, then first come, a job that waits for its round after the rest.
               row_number() OVER (PARTITION BY q."space_id" ORDER BY q."waits", q."priority" DESC, q."created_at", q."id") AS "turn",
               -- The space's place in the line: its first job by priority and first come, whichever of its jobs takes it.
               first_value(q."priority") OVER "head" AS "placePriority",
               first_value(q."created_at") OVER "head" AS "placeAt",
               first_value(q."id") OVER "head" AS "placeId"
        FROM "queue" q
        WINDOW "head" AS (PARTITION BY q."space_id" ORDER BY q."priority" DESC, q."created_at", q."id")
      )
      UPDATE "wiki_job" AS j
      SET "state" = 'running',
          "lease_owner" = ${input.workerId}::uuid,
          "lease_generation" = gen_random_uuid(),
          "lease_deadline_at" = now() + ${lease}::int * interval '1 millisecond',
          "started_at" = COALESCE(j."started_at", now()),
          "updated_at" = now()
      FROM (
        SELECT c."id" FROM "wiki_job" c
        JOIN "line" l ON l."id" = c."id"
        -- The space's next job, and only it: two schedulers therefore pick the same row and one of them skips it,
        -- rather than each taking a different job of one space and meeting the partial unique index. A space whose
        -- next job waits for its round takes nothing until the round is due.
        WHERE l."turn" = 1 AND NOT l."waits"
          -- Read again on the row the lock takes: a job another claim took meanwhile is no longer due.
          AND c."state" = 'queued'
          AND (c."next_attempt_at" IS NULL OR c."next_attempt_at" <= now())
          AND c."attempts" < ${WIKI_JOB.maxAttempts}
          -- No running job of this space: the space is free.
          AND NOT EXISTS (
            SELECT 1 FROM "wiki_job" r
            WHERE r."space_id" = c."space_id" AND r."state" = 'running' AND r."lease_deadline_at" > now()
          )
        ORDER BY l."placePriority" DESC, l."placeAt" ASC, l."placeId" ASC
        LIMIT ${input.limit}
        FOR UPDATE OF c SKIP LOCKED
      ) AS due
      WHERE j."id" = due."id"
      RETURNING j."id", j."owner_id" AS "ownerId", j."space_id" AS "spaceId", j."kind", j."input",
                j."priority", j."attempts", j."lease_generation" AS "leaseGeneration"`;
  } catch (error) {
    // The per-space partial unique index refused the claim: another worker took this space's running job
    // between this statement's predicate and its write. The claim is one statement, so the refusal rolls
    // all of it back — this pass took nothing, and the rows it wanted are still due on its next one.
    if ((error as { code?: string }).code === '23505') return [];
    throw error;
  }
}

/** Extend a running job's lease, only while the row is still the generation the claim was given. */
export async function renewWikiJobLease(
  prisma: PrismaService,
  input: { id: string; generation: string; leaseMs?: number },
): Promise<boolean> {
  const lease = input.leaseMs ?? WIKI_JOB.leaseSeconds * 1000;
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_job"
    SET "lease_deadline_at" = now() + ${lease}::int * interval '1 millisecond', "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/**
 * The lease-expiry sweep: running jobs whose lease ran out go back to queued, the lost attempt counted and
 * the next try on the backoff (WIKI_JOB.retryBackoffSeconds, spelled in the CASE below). A job taken over
 * this way starts from the beginning; the requests it already made answer its replay (wiki-model-queue.ts).
 * These are the leases nobody handed back: the worker crashed, was killed, or died before its hand-back was
 * written. A worker that is stopped hands its jobs back itself (`releaseWikiJobLease`), and none reaches here.
 */
export async function reclaimExpiredWikiJobs(prisma: PrismaService, limit: number): Promise<string[]> {
  const reclaimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "wiki_job" AS j
    SET "state" = 'queued',
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "attempts" = j."attempts" + 1,
        "next_attempt_at" = now() + (CASE WHEN j."attempts" >= 2 THEN 30 WHEN j."attempts" = 1 THEN 10 ELSE 0 END)
          * interval '1 second',
        "failure_kind" = 'infra',
        "error" = 'LEASE_EXPIRED: the worker holding this job stopped before settling it',
        "updated_at" = now()
    FROM (
      SELECT "id" FROM "wiki_job"
      WHERE "state" = 'running' AND "lease_deadline_at" <= now()
      ORDER BY "lease_deadline_at", "id"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) AS expired
    WHERE j."id" = expired."id"
    RETURNING j."id"`;
  return reclaimed.map((row) => row.id);
}

/**
 * Where a running job's pipeline is (contract `jobs.progress`): its own step and counts, written under the
 * claim's generation so a holder whose lease was taken over writes nothing. False means a takeover holds it.
 *
 * A job's progress, report and error can quote what the model wrote, and each is written without any U+0000
 * (contract `jobs.serverWrites`), as everything a runner reports is (runner-api/strip-nul.ts): a NUL in one would
 * otherwise fail the very write that settles the job, and the job would be tried again until its retry limit.
 */
export async function writeWikiJobProgress(
  prisma: PrismaService,
  input: { id: string; generation: string; progress: Record<string, unknown> },
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_job"
    SET "progress" = ${JSON.stringify(stripNul(input.progress))}::jsonb, "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/** What a job that ran to its end reported. */
export interface WikiJobOutcomeReport {
  report?: Record<string, unknown> | null;
  progress?: Record<string, unknown> | null;
}

/** A job succeeded, while the claim is still the row's generation. False means a takeover holds it. */
export async function succeedWikiJob(
  prisma: PrismaService,
  input: { id: string; generation: string } & WikiJobOutcomeReport,
): Promise<boolean> {
  const report = input.report === undefined || input.report === null ? null : JSON.stringify(stripNul(input.report));
  const progress = input.progress === undefined || input.progress === null ? null : JSON.stringify(stripNul(input.progress));
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_job"
    SET "state" = 'succeeded',
        "report" = ${report}::jsonb,
        "progress" = ${progress}::jsonb,
        "error" = NULL,
        "failure_kind" = NULL,
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "ended_at" = now(),
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/**
 * The platform's failure (§5.5 infra): the job goes back to queued with the lost attempt counted and the
 * next try on the backoff, and keeps its reason for the health line. It does NOT end the job — an endpoint
 * that was away, a runner that was offline, a worker that restarted are all tried again.
 */
export async function requeueWikiJobForInfra(
  prisma: PrismaService,
  input: { id: string; generation: string; error: string },
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_job"
    SET "state" = 'queued',
        "attempts" = "attempts" + 1,
        -- The CASE is cast: with every branch an untyped parameter PostgreSQL would resolve it to text.
        "next_attempt_at" = now() + (CASE WHEN "attempts" >= 2 THEN ${WIKI_JOB.retryBackoffSeconds[2]}
          WHEN "attempts" = 1 THEN ${WIKI_JOB.retryBackoffSeconds[1]} ELSE ${WIKI_JOB.retryBackoffSeconds[0]} END)::int
          * interval '1 second',
        "failure_kind" = 'infra',
        "error" = ${stripNul(input.error)},
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "ended_at" = NULL,
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/** The work's own failure (§5.5 content): the job ends failed, and counts against the space's streak. */
export async function failWikiJobAsContent(
  prisma: PrismaService,
  input: { id: string; generation: string; error: string } & WikiJobOutcomeReport,
): Promise<boolean> {
  const report = input.report === undefined || input.report === null ? null : JSON.stringify(stripNul(input.report));
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_job"
    SET "state" = 'failed',
        "report" = ${report}::jsonb,
        "failure_kind" = 'content',
        "error" = ${stripNul(input.error)},
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "ended_at" = now(),
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/** A job ended for good, as the write that ended it returns it: what its rows are found by. */
interface EndedWikiJob {
  id: string;
  kind: string;
  input: unknown;
}

/**
 * What a job the retry limit ended says on its row, and on its run or plan job: how many attempts, and the last
 * one's error, within the 2,000 characters those rows keep of an error.
 */
export function wikiJobRetryLimitError(attempts: number, error: string, unexpected = false): string {
  return cutRunes(`Ended after ${attempts} attempts${unexpected ? ' (an error this build did not expect)' : ''}: ${error}`, 2000);
}

/**
 * End a job at the retry limit (contract `jobs.retry.limit`): failed, failure_kind infra, why on its row, and in
 * the same transaction everything that waits on it (`settleWikiJobRows`). `from` is the state the write expects
 * the row in. A running row under the claim's generation is the attempt that just failed, and that attempt is
 * counted here. A queued row already at the limit was put back by the lease sweep or a repository wait, which
 * counted the attempt then. A row that has moved on matches nothing, and nothing is written. Answers whether
 * the job was ended here.
 */
export async function endWikiJobAtRetryLimit(
  prisma: PrismaService,
  input: { id: string; from: { state: 'running'; generation: string } | { state: 'queued' }; error: string },
  now: Date = new Date(),
): Promise<boolean> {
  return new RetryLimitWriter(prisma).endAtRetryLimit({ ...input, error: stripNul(input.error) }, now);
}

/** The one writer of an end at the retry limit: a class only so that its retry is labelled like every other's. */
class RetryLimitWriter {
  private readonly logger = new Logger('WikiJobs');

  constructor(private readonly prisma: PrismaService) {}

  async endAtRetryLimit(
    input: { id: string; from: { state: 'running'; generation: string } | { state: 'queued' }; error: string },
    now: Date,
  ): Promise<boolean> {
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const ended = input.from.state === 'running'
          ? await tx.$queryRaw<EndedWikiJob[]>`
              UPDATE "wiki_job"
                 SET "state" = 'failed', "attempts" = "attempts" + 1, "failure_kind" = 'infra', "error" = ${input.error},
                     "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL,
                     "ended_at" = ${now}, "updated_at" = now()
               WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.from.generation}::uuid
              RETURNING "id", "kind", "input"`
          : await tx.$queryRaw<EndedWikiJob[]>`
              UPDATE "wiki_job"
                 SET "state" = 'failed', "failure_kind" = 'infra', "error" = ${input.error}, "ended_at" = ${now}, "updated_at" = now()
               WHERE "id" = ${input.id}::uuid AND "state" = 'queued' AND "attempts" >= ${WIKI_JOB.maxAttempts}
              RETURNING "id", "kind", "input"`;
        if (ended.length === 0) return false;
        await settleWikiJobRows(tx, ended[0], input.error, now);
        return true;
      },
      loggedRetry(this.logger, 'wiki.jobRetryLimit'),
    );
  }
}

/**
 * The queued jobs that reached the retry limit (contract `jobs.retry.limit`), of the accounts this worker serves
 * (`owners`, the claim's filter): each ended with its last error (`endWikiJobAtRetryLimit`). These are the jobs
 * the lease sweep or a repository wait put back with their last attempt counted. The claim never takes one, so
 * no job runs past the limit, whichever way its attempts were counted. Answers the jobs it ended.
 */
export async function endWikiJobsPastRetryLimit(prisma: PrismaService, owners: readonly string[] | null): Promise<string[]> {
  const due = await prisma.$queryRaw<Array<{ id: string; attempts: number; error: string | null }>>`
    SELECT "id", "attempts", "error" FROM "wiki_job"
     WHERE "state" = 'queued' AND "attempts" >= ${WIKI_JOB.maxAttempts}
       AND (${owners as string[] | null}::uuid[] IS NULL OR "owner_id" = ANY(${owners as string[] | null}::uuid[]))
     ORDER BY "updated_at", "id"
     LIMIT 50`;
  const ended: string[] = [];
  for (const job of due) {
    const error = wikiJobRetryLimitError(job.attempts, job.error ?? 'every attempt failed');
    if (await endWikiJobAtRetryLimit(prisma, { id: job.id, from: { state: 'queued' }, error })) ended.push(job.id);
  }
  return ended;
}

/**
 * What waits on a job that ended for good, settled in the transaction that ended it, and only when that end
 * matched: the rollback sweep's cancellation (wiki/wiki-executor-sweep.ts, contract `jobs.executor.rollback`) and
 * the retry limit's failure (`jobs.retry.limit`).
 *
 * Its model calls still queued or running are cancelled. A cancelled row's error, error_kind, partial and lease
 * columns must be NULL (the 0401 constraints), so a replayed job asks again from nothing. Its repository
 * operations still queued or running are cancelled too, so no runner works on a result nobody will read. Then
 * the one row its kind runs. A `maintain` job's run ends failed / infra with the reason: the failure is not the
 * pipeline's, so the space's streak is not touched, and the next run reads again what this one did not take in.
 * The plan job of a plan_draft, plan_revise or docs_build job ends failed with the reason. It still names its
 * wiki_job (a made or ended plan job names its maker, 0405), and the owner's next request makes a new one.
 */
export async function settleWikiJobRows(tx: Prisma.TransactionClient, job: EndedWikiJob, reason: string, now: Date): Promise<void> {
  await tx.$executeRaw`
    UPDATE "wiki_model_request"
       SET "state" = 'cancelled', "ended_at" = ${now}, "error" = NULL, "error_kind" = NULL, "partial" = NULL, "partial_encoding" = 'text',
           "not_before" = NULL, "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL, "updated_at" = now()
     WHERE "job_id" = ${job.id}::uuid AND "state" IN ('queued', 'running')`;
  await tx.$executeRaw`
    UPDATE "wiki_repo_op"
       SET "state" = 'cancelled', "ended_at" = ${now}, "error" = ${reason},
           "lease_owner" = NULL, "claimed_at" = NULL, "heartbeat_at" = NULL, "runner_id" = NULL, "updated_at" = now()
     WHERE "job_id" = ${job.id}::uuid AND "state" IN ('queued', 'running')`;
  const input = (job.input ?? {}) as { runId?: unknown; planJobId?: unknown };
  if (job.kind === 'maintain' && typeof input.runId === 'string') {
    await tx.$executeRaw`
      UPDATE "wiki_maintenance_run"
         SET "outcome" = 'failed', "failure_kind" = 'infra', "error" = ${reason}, "ended_at" = ${now}, "updated_at" = now()
       WHERE "id" = ${input.runId}::uuid AND "outcome" IS NULL`;
  }
  if ((job.kind === 'plan_draft' || job.kind === 'plan_revise' || job.kind === 'docs_build') && typeof input.planJobId === 'string') {
    await tx.wikiPlanJob.updateMany({
      where: { id: input.planJobId, state: 'made' },
      data: { state: 'ended', outcome: 'failed', endedAt: now, error: reason },
    });
  }
}

/**
 * What a job the worker's stop handed back says on its row (contract `jobs.lease.handBack`). It is no failure, so
 * the row's failure_kind is cleared with it, and it is not the sweep's LEASE_EXPIRED, which a lease nobody handed
 * back gets.
 */
export const WIKI_JOB_HANDED_BACK =
  'WORKER_STOPPED: the worker was stopped and handed this job back; the next one takes it over at once, without counting an attempt';

/**
 * Hand a running job back at shutdown (design §5.4, the owner's plan A; contract `jobs.lease.handBack`): back to
 * queued in this one write, its lease cleared, nothing scheduled and its attempts as they were — a deploy costs a job
 * no attempt (the owner's decision of 2026-10-09) — with why on its row. The next claim, the next process's first pass
 * or another worker's, takes it at once, in its space's own order: priority, then the longest-waiting. Its requests
 * are let go the queue's way (wiki-model-queue.ts) and met again by its replay; whatever the job had written stands.
 * A compare-and-set on the claim's generation, so only the attempt the stop cut short can be handed back: a job taken
 * over is not touched, and a worker that dies before this write leaves its lease to run out, which the sweep counts.
 */
export async function releaseWikiJobLease(prisma: PrismaService, input: { id: string; generation: string }): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_job"
    SET "state" = 'queued',
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "next_attempt_at" = NULL,
        "failure_kind" = NULL,
        "error" = ${WIKI_JOB_HANDED_BACK},
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/** Enqueue one job (contract `jobs.make`): what the pipelines will call when they run on the server (P3+). */
export async function enqueueWikiJob(
  prisma: PrismaService,
  input: { id: string; ownerId: string; spaceId: string; kind: string; input?: Record<string, unknown>; priority?: number },
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "wiki_job" ("id", "owner_id", "space_id", "kind", "input", "priority", "state")
    VALUES (${input.id}::uuid, ${input.ownerId}::uuid, ${input.spaceId}::uuid, ${input.kind},
            ${JSON.stringify(input.input ?? {})}::jsonb, ${input.priority ?? 0}, 'queued')
    ON CONFLICT ("id") DO NOTHING`;
}
