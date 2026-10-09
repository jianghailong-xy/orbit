import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { WIKI_MODEL_QUEUE, type WikiSystemModelErrorKind } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { stripNul } from '../runner-api/strip-nul';
import { wikiStoredModelText, wikiTextBase64, wikiTextFromStored, wikiTextIsStorable } from './wiki-stored-text';

/**
 * The `wiki_model_request` table: the queue every wiki model call goes through (migration 0401, contract
 * `modelQueue`, design §5.2).
 *
 * THE REQUEST IS THE BREAKPOINT
 * `(job_id, step, unit, attempt)` is unique: enqueuing a call that already has a row meets that row
 * (`enqueueWikiModelRequest` returns it), and waiting on it (`whenSettled`) hands back the answer a
 * succeeded row holds or waits for the one still in flight — so a pipeline that replays, after its worker
 * died or its job was retried, reuses what answered. Nothing is issued twice for one unit, which is what
 * makes the restart specs' "each write happens once" true.
 *
 * THE CLAIM
 * One scheduler claims in a transaction that starts with an advisory lock (so every scheduler in the
 * deployment serializes here), counts the running rows whose lease has not expired, and takes at most
 * ORBIT_WIKI_MODEL_CONCURRENCY minus that count — by priority descending, then enqueued_at, SKIP LOCKED,
 * each row under a new lease generation. However many workers run, that many requests are in flight at
 * once and no more, and a job never has more than WIKI_MODEL_QUEUE.maxInFlightPerJob of them.
 *
 * THE LEASE
 * A running row holds lease_owner, lease_generation and lease_deadline_at together (the CHECK holds that
 * both ways). The executor renews while the call runs and writes the text received so far back with the
 * renewal, so a lease that runs out means the process holding it stopped: the sweep puts the row back to
 * queued with the lost attempt counted and the partial KEPT, and the next claim re-issues the call with
 * what had arrived. Every settle is a compare-and-set on the generation, so a takeover's generation is not
 * the dead worker's and its late write settles nothing.
 *
 * WHAT PAUSES THE QUEUE
 * Nothing here reads the model's state — the executor does, before it claims (wiki-model-queue.service.ts):
 * while the state is down or auth_failed, requests stay queued, and a request that waits past its step's
 * limit (`failWikiModelRequestsPastWaitLimit`) fails, which is the job's to read as an infra failure.
 */

/**
 * The advisory lock every scheduler's claim takes, so that "count the running rows, then take the
 * difference" is one decision across processes. The first number is the wiki's model queue's namespace;
 * nothing else in the tree takes it.
 */
export const WIKI_MODEL_QUEUE_LOCK_NAMESPACE = 7711001;
export const WIKI_MODEL_QUEUE_LOCK_KEY = 1;

/** One model call, exactly as it is sent: the queue's `request` column and the client's call, minus the budget. */
export interface WikiModelRequestCall {
  system: string;
  prompt: string;
  maxTokens: number;
}

/** The digest a row keeps of its call, so the same unit twice can be told from a different call under one key. */
export function wikiModelRequestSha256(call: WikiModelRequestCall): string {
  return createHash('sha256')
    .update(JSON.stringify({ system: call.system, prompt: call.prompt, maxTokens: call.maxTokens }))
    .digest('hex');
}

/**
 * The call as the `request` column keeps it (contract `modelQueue.requestEncoding`): as it is, or — when its
 * system or its prompt has a U+0000, which jsonb cannot hold — both as their UTF-8 bytes in base64, with
 * `encoding: 'base64'` saying so. A prompt carries the repository's text (a code piece is a file's lines), and a
 * source file can have a NUL: the call the model is sent is the one the pipeline made, byte for byte, as the
 * runner path's is. The digest is the call's, not the column's.
 */
export function wikiModelRequestStored(call: WikiModelRequestCall): Record<string, unknown> {
  if (wikiTextIsStorable(call.system) && wikiTextIsStorable(call.prompt)) {
    return { system: call.system, prompt: call.prompt, maxTokens: call.maxTokens };
  }
  return { system: wikiTextBase64(call.system), prompt: wikiTextBase64(call.prompt), maxTokens: call.maxTokens, encoding: 'base64' };
}

/** The call a `request` column keeps, read back to what the pipeline made. */
export function wikiModelRequestCallOf(stored: unknown): WikiModelRequestCall {
  const row = (stored ?? {}) as { system?: unknown; prompt?: unknown; maxTokens?: unknown; encoding?: unknown };
  const encoding = typeof row.encoding === 'string' ? row.encoding : 'text';
  return {
    system: wikiTextFromStored(String(row.system ?? ''), encoding),
    prompt: wikiTextFromStored(String(row.prompt ?? ''), encoding),
    maxTokens: Number(row.maxTokens),
  };
}

/**
 * The error text a request that waited past its step's limit is failed with. Its class is `other` (the
 * platform ran out of patience, not the call), and its prefix is what tells the job that this failure is
 * an infra one — the job's own handling, not the queue's.
 */
export const WIKI_MODEL_WAIT_LIMIT_ERROR = "the request waited past its step's limit";

/** Whether a failed request's error is the wait limit's. */
export function wikiModelRequestFailedOnWaitLimit(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.startsWith(WIKI_MODEL_WAIT_LIMIT_ERROR);
}

/** One claimed request, with the generation every later write must still match. */
export interface ClaimedWikiModelRequest {
  id: string;
  jobId: string;
  ownerId: string;
  spaceId: string;
  step: string;
  unit: string;
  attempt: number;
  attempts: number;
  priority: number;
  request: WikiModelRequestCall;
  requestSha256: string;
  partial: string | null;
  leaseGeneration: string;
}

export interface ClaimWikiModelRequestsInput {
  /** The lease holder, a uuid. */
  workerId: string;
  /** ORBIT_WIKI_MODEL_CONCURRENCY: requests in flight at once across every space, however many workers run. */
  concurrency: number;
  /** The accounts this worker may claim for; null is every account, [] is none. */
  owners: readonly string[] | null;
  /** The most to take in this claim, below the room the count leaves; the room is the hard one. */
  limit?: number;
  leaseMs?: number;
}

/**
 * Claim up to `limit` due requests, in the deployment's global order, while no more than `concurrency` are
 * in flight across every space (the count and the take are one transaction under the advisory lock).
 * Returns fewer — possibly none — when the queue is at its concurrency, when the rows due are another
 * scheduler's, or when they are backing off.
 */
export async function claimWikiModelRequests(
  prisma: PrismaService,
  input: ClaimWikiModelRequestsInput,
): Promise<ClaimedWikiModelRequest[]> {
  const lease = input.leaseMs ?? WIKI_MODEL_QUEUE.leaseSeconds * 1000;
  const perJob = WIKI_MODEL_QUEUE.maxInFlightPerJob;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WIKI_MODEL_QUEUE_LOCK_NAMESPACE}, ${WIKI_MODEL_QUEUE_LOCK_KEY})`;
    const [counted] = await tx.$queryRaw<Array<{ running: number }>>`
      SELECT count(*)::int AS "running"
      FROM "wiki_model_request"
      WHERE "state" = 'running' AND "lease_deadline_at" > now()`;
    const room = Math.min(input.limit ?? input.concurrency, input.concurrency) - counted.running;
    if (room <= 0) return [];
    const claimed = await tx.$queryRaw<Array<Omit<ClaimedWikiModelRequest, 'request'> & { request: unknown; partialEncoding: string }>>`
      UPDATE "wiki_model_request" AS r
      SET "state" = 'running',
          "lease_owner" = ${input.workerId}::uuid,
          "lease_generation" = gen_random_uuid(),
          "lease_deadline_at" = now() + ${lease}::int * interval '1 millisecond',
          "started_at" = COALESCE(r."started_at", now()),
          "updated_at" = now()
      FROM (
        SELECT c."id" FROM "wiki_model_request" c
        WHERE c."state" = 'queued'
          AND COALESCE(c."not_before", c."enqueued_at") <= now()
          AND (${input.owners as string[] | null}::uuid[] IS NULL OR c."owner_id" = ANY(${input.owners as string[] | null}::uuid[]))
          -- What this job already has in flight, plus the due requests of it that sort before this one:
          -- the first maxInFlightPerJob of them pass and the rest wait, so one claim cannot put more of
          -- one job in flight than the cap allows, whatever the deployment's concurrency is.
          AND (SELECT count(*) FROM "wiki_model_request" p
                WHERE p."job_id" = c."job_id" AND p."state" = 'running' AND p."lease_deadline_at" > now())
            + (SELECT count(*) FROM "wiki_model_request" q
                WHERE q."job_id" = c."job_id" AND q."state" = 'queued'
                  AND COALESCE(q."not_before", q."enqueued_at") <= now()
                  AND (q."priority" > c."priority"
                    OR (q."priority" = c."priority" AND (q."enqueued_at", q."id") < (c."enqueued_at", c."id"))))
            < ${perJob}
        ORDER BY c."priority" DESC, c."enqueued_at" ASC, c."id" ASC
        LIMIT ${room}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE r."id" = due."id"
      RETURNING r."id", r."job_id" AS "jobId", r."owner_id" AS "ownerId", r."space_id" AS "spaceId",
                r."step", r."unit", r."attempt", r."attempts", r."priority", r."request",
                r."request_sha256" AS "requestSha256", r."partial", r."partial_encoding" AS "partialEncoding",
                r."lease_generation" AS "leaseGeneration"`;
    return claimed.map(({ partialEncoding, ...row }) => ({
      ...row,
      request: wikiModelRequestCallOf(row.request),
      partial: row.partial === null ? null : wikiTextFromStored(row.partial, partialEncoding),
    }));
  });
}

/**
 * Write the text received so far back, renewing the lease with it, while the call is still the claim's.
 * Called on the partial interval, only when the text grew: the write-back and the renewal are one
 * statement because both are "this call is still running here".
 */
export async function writeWikiModelRequestPartial(
  prisma: PrismaService,
  input: { id: string; generation: string; partial: string; leaseMs?: number },
): Promise<boolean> {
  const lease = input.leaseMs ?? WIKI_MODEL_QUEUE.leaseSeconds * 1000;
  // Kept as the model sent it: a NUL copied out of a code piece makes it the text's bytes (answerEncoding).
  const partial = wikiStoredModelText(input.partial);
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_model_request"
    SET "partial" = ${partial.content},
        "partial_encoding" = ${partial.encoding},
        "lease_deadline_at" = now() + ${lease}::int * interval '1 millisecond',
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/** Extend a call's lease without writing anything else (the periodic renewal between partial write-backs). */
export async function renewWikiModelRequestLease(
  prisma: PrismaService,
  input: { id: string; generation: string; leaseMs?: number },
): Promise<boolean> {
  const lease = input.leaseMs ?? WIKI_MODEL_QUEUE.leaseSeconds * 1000;
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_model_request"
    SET "lease_deadline_at" = now() + ${lease}::int * interval '1 millisecond', "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/** What a settled call leaves on its row, beside the state itself; its error is a message, kept without any U+0000. */
export interface WikiModelRequestSettlement {
  answer?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  httpStatus?: number | null;
  error?: string | null;
  errorKind?: WikiSystemModelErrorKind | null;
}

/** Close a call that answered, while the claim is still the row's generation: the answer is written once. */
export async function succeedWikiModelRequest(
  prisma: PrismaService,
  input: { id: string; generation: string; answer: string; inputTokens?: number | null; outputTokens?: number | null; httpStatus?: number | null },
): Promise<boolean> {
  // The answer as the model sent it, a NUL and all (answerEncoding): the job parses what the runner path's would.
  const answer = wikiStoredModelText(input.answer);
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_model_request"
    SET "state" = 'succeeded',
        "answer" = ${answer.content},
        "answer_encoding" = ${answer.encoding},
        "input_tokens" = ${input.inputTokens ?? null},
        "output_tokens" = ${input.outputTokens ?? null},
        "http_status" = ${input.httpStatus ?? null},
        "error" = NULL,
        "error_kind" = NULL,
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "ended_at" = now(),
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/**
 * Put a retryable failure back in the queue: the row is queued again, its attempts one higher and its next
 * attempt on the backoff (WIKI_MODEL_QUEUE.retryBackoffSeconds — 0, 10, 30 seconds — spelled in the CASE
 * below against the attempts the row already made), with the error kept so the reason is readable while it
 * waits. A retry is never the answer's last word — the wait limit is what ends a request that keeps failing.
 */
export async function retryWikiModelRequest(
  prisma: PrismaService,
  input: { id: string; generation: string } & WikiModelRequestSettlement,
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_model_request"
    SET "state" = 'queued',
        "attempts" = "attempts" + 1,
        -- The CASE is cast: with every branch an untyped parameter PostgreSQL would resolve it to text.
        "not_before" = now() + (CASE WHEN "attempts" >= ${WIKI_MODEL_QUEUE.retryBackoffSeconds.length - 1}
            THEN ${WIKI_MODEL_QUEUE.retryBackoffSeconds[WIKI_MODEL_QUEUE.retryBackoffSeconds.length - 1]}
          WHEN "attempts" = 1 THEN ${WIKI_MODEL_QUEUE.retryBackoffSeconds[1]}
          ELSE ${WIKI_MODEL_QUEUE.retryBackoffSeconds[0]} END)::int * interval '1 second',
        "http_status" = ${input.httpStatus ?? null},
        "error" = ${input.error == null ? null : stripNul(input.error)},
        "error_kind" = ${input.errorKind ?? null},
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/** The failure ends the request: nothing is retried, and the job reads it and decides (§5.5 content). */
export async function failWikiModelRequest(
  prisma: PrismaService,
  input: { id: string; generation: string } & WikiModelRequestSettlement,
): Promise<boolean> {
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_model_request"
    SET "state" = 'failed',
        "http_status" = ${input.httpStatus ?? null},
        "error" = ${stripNul(input.error ?? 'the call failed')},
        "error_kind" = ${input.errorKind ?? 'other'},
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "ended_at" = now(),
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/**
 * The lease-expiry sweep (design §5.2): running rows whose lease ran out go back to queued, attempts one
 * higher, partial KEPT — the next claim re-issues the call and the executor hands the client what had
 * arrived. The generation stays with the row's next claim, so the dead holder's writes settle nothing.
 */
export async function reclaimExpiredWikiModelRequests(prisma: PrismaService, limit: number): Promise<string[]> {
  const reclaimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "wiki_model_request" AS r
    SET "state" = 'queued',
        "attempts" = r."attempts" + 1,
        "not_before" = NULL,
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "error" = 'LEASE_EXPIRED: the scheduler holding this call stopped before settling it',
        "error_kind" = 'retryable',
        "updated_at" = now()
    FROM (
      SELECT "id" FROM "wiki_model_request"
      WHERE "state" = 'running' AND "lease_deadline_at" <= now()
      ORDER BY "lease_deadline_at", "id"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) AS expired
    WHERE r."id" = expired."id"
    RETURNING r."id"`;
  return reclaimed.map((row) => row.id);
}

/**
 * The SQL for a step's wait limit, over the step column `column` (e.g. `c."step"`): the step's own limit
 * where the step is one the design gives a limit (WIKI_MODEL_QUEUE.waitLimitSeconds, by the step's own name
 * or one of its stages), the default otherwise. Built from the shared table so the query and
 * `wikiModelWaitLimitSeconds` cannot drift.
 */
function wikiModelWaitLimitSql(column: string): Prisma.Sql {
  const step = Prisma.raw(column);
  const whens = Object.entries(WIKI_MODEL_QUEUE.waitLimitSeconds).map(([key, seconds]) =>
    Prisma.sql`WHEN ${step} = ${key} OR ${step} LIKE ${`${key}\\_%`} THEN ${seconds}`);
  return Prisma.sql`(CASE ${Prisma.join(whens, ' ')} ELSE ${WIKI_MODEL_QUEUE.defaultWaitLimitSeconds} END)`;
}

/**
 * A queued request that has waited past its step's limit fails here (design §5.3): it has been waiting —
 * the model is down, or outages keep sending it back — for longer than the pipeline ever offered it. The
 * job that made it reads the failure (wikiModelRequestFailedOnWaitLimit) and fails as infra.
 */
export async function failWikiModelRequestsPastWaitLimit(
  prisma: PrismaService,
  input: { owners: readonly string[] | null; limit?: number },
): Promise<string[]> {
  const owners = input.owners as string[] | null;
  const failed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE "wiki_model_request" AS r
    SET "state" = 'failed',
        "error" = ${WIKI_MODEL_WAIT_LIMIT_ERROR} || ' (' || late."wait_limit"::text || ' s)',
        "error_kind" = 'other',
        "lease_owner" = NULL,
        "lease_generation" = NULL,
        "lease_deadline_at" = NULL,
        "ended_at" = now(),
        "updated_at" = now()
    FROM (
      SELECT c."id", ${wikiModelWaitLimitSql('c."step"')} AS "wait_limit"
      FROM "wiki_model_request" c
      WHERE c."state" = 'queued'
        AND (${owners}::uuid[] IS NULL OR c."owner_id" = ANY(${owners}::uuid[]))
        AND c."enqueued_at" <= now() - ${wikiModelWaitLimitSql('c."step"')}::int * interval '1 second'
      ORDER BY c."enqueued_at", c."id"
      LIMIT ${input.limit ?? 50}
      FOR UPDATE SKIP LOCKED
    ) AS late
    WHERE r."id" = late."id"
    RETURNING r."id"`;
  return failed.map((row) => row.id);
}

/**
 * Let go of a running call at shutdown (design §5.4, plan A): the partial is written back and the lease
 * deadline becomes now, in one statement, so the next process's sweep takes the row over at once and
 * re-issues the call with what had arrived. The call itself is aborted by the executor's own signal.
 * Ends nothing: state stays running until the takeover's generation rewrites it.
 */
export async function releaseWikiModelRequestLease(
  prisma: PrismaService,
  input: { id: string; generation: string; partial?: string | null },
): Promise<boolean> {
  const partial = input.partial == null ? null : wikiStoredModelText(input.partial);
  const updated = await prisma.$executeRaw`
    UPDATE "wiki_model_request"
    SET "partial" = COALESCE(${partial?.content ?? null}, "partial"),
        "partial_encoding" = COALESCE(${partial?.encoding ?? null}, "partial_encoding"),
        "lease_deadline_at" = now(),
        "updated_at" = now()
    WHERE "id" = ${input.id}::uuid AND "state" = 'running' AND "lease_generation" = ${input.generation}::uuid`;
  return updated > 0;
}

/**
 * The attempt a job's call of (step, unit) is made under: the unit's newest row, unless that row failed on its
 * wait limit — the one way a request ends that is the platform's and not the call's (design §5.3) — and then
 * the next. A job retried after the model was away meets its own failed row on every replay otherwise, and
 * never asks again however long the model has been back.
 */
export async function wikiModelRequestAttempt(
  prisma: PrismaService,
  input: { jobId: string; step: string; unit: string },
): Promise<number> {
  const [newest] = await prisma.$queryRaw<Array<{ attempt: number; state: string; error: string | null }>>`
    SELECT "attempt", "state", "error" FROM "wiki_model_request"
    WHERE "job_id" = ${input.jobId}::uuid AND "step" = ${input.step} AND "unit" = ${input.unit}
    ORDER BY "attempt" DESC
    LIMIT 1`;
  if (!newest) return 1;
  return newest.state === 'failed' && wikiModelRequestFailedOnWaitLimit(newest.error) ? newest.attempt + 1 : newest.attempt;
}

/** Enqueue one call (`job_id`, `step`, `unit`, `attempt` is its identity). A row already there is that row. */
export async function enqueueWikiModelRequest(
  prisma: PrismaService,
  input: {
    id: string;
    jobId: string;
    ownerId: string;
    spaceId: string;
    step: string;
    unit: string;
    attempt?: number;
    priority?: number;
    request: WikiModelRequestCall;
  },
): Promise<{ id: string; inserted: boolean }> {
  const sha = wikiModelRequestSha256(input.request);
  const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "wiki_model_request" ("id", "job_id", "owner_id", "space_id", "step", "unit", "attempt", "priority",
                                      "request", "request_sha256", "state")
    VALUES (${input.id}::uuid, ${input.jobId}::uuid, ${input.ownerId}::uuid, ${input.spaceId}::uuid,
            ${input.step}, ${input.unit}, ${input.attempt ?? 1}, ${input.priority ?? 0},
            ${JSON.stringify(wikiModelRequestStored(input.request))}::jsonb, ${sha}, 'queued')
    ON CONFLICT ("job_id", "step", "unit", "attempt") DO NOTHING
    RETURNING "id"`;
  if (inserted.length > 0) return { id: inserted[0].id, inserted: true };
  const existing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "wiki_model_request"
    WHERE "job_id" = ${input.jobId}::uuid AND "step" = ${input.step} AND "unit" = ${input.unit}
      AND "attempt" = ${input.attempt ?? 1}`;
  return { id: existing[0]?.id ?? input.id, inserted: false };
}

/** What a row looks like to whoever is waiting on it, and to the replay that asked for it. */
export interface WikiModelRequestRead {
  id: string;
  jobId: string;
  step: string;
  unit: string;
  attempt: number;
  attempts: number;
  state: string;
  answer: string | null;
  partial: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  httpStatus: number | null;
  error: string | null;
  errorKind: string | null;
  requestSha256: string;
  enqueuedAt: Date;
  notBefore: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
}

/** One request by its id, as its waiter re-reads it when the queue says something changed. */
export async function wikiModelRequestById(prisma: PrismaService, id: string): Promise<WikiModelRequestRead | null> {
  const rows = await prisma.$queryRaw<Array<WikiModelRequestRead & { answerEncoding: string; partialEncoding: string }>>`
    SELECT "id", "job_id" AS "jobId", "step", "unit", "attempt", "attempts", "state", "answer", "partial",
           "answer_encoding" AS "answerEncoding", "partial_encoding" AS "partialEncoding",
           "input_tokens" AS "inputTokens", "output_tokens" AS "outputTokens", "http_status" AS "httpStatus",
           "error", "error_kind" AS "errorKind", "request_sha256" AS "requestSha256",
           "enqueued_at" AS "enqueuedAt", "not_before" AS "notBefore", "started_at" AS "startedAt", "ended_at" AS "endedAt"
    FROM "wiki_model_request" WHERE "id" = ${id}::uuid`;
  const row = rows[0];
  if (!row) return null;
  // The answer and the partial read back to the text the model sent (answerEncoding).
  const { answerEncoding, partialEncoding, ...read } = row;
  return {
    ...read,
    answer: read.answer === null ? null : wikiTextFromStored(read.answer, answerEncoding),
    partial: read.partial === null ? null : wikiTextFromStored(read.partial, partialEncoding),
  };
}

/** The channel a settled request announces itself on; the worker LISTENs on it and polls as the fallback. */
export const WIKI_MODEL_REQUEST_CHANNEL = 'wiki_model_request';
