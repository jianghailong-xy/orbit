import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIKI_REPO_OPS,
  WIKI_REPO_OP_CAPABILITY,
  WIKI_REPO_OP_KINDS,
  WIKI_REPO_OP_RESULT_STATES,
  wikiMaintenanceSettings,
  type WikiRepoLook,
  type WikiRepoOpKind,
  type WikiRepoOpState,
} from '@orbit/shared';
// A value import, not a type one: `WikiRepoOps` is a provider, and Nest reads its constructor's
// parameter metadata out of the emitted JavaScript — a type-only import leaves that slot `Object` and the
// process refuses to boot (checked in the e2e stack, 2026-10-08).
import { PrismaService } from '../prisma/prisma.service';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { notifyRunnerWakeOnCommit } from '../realtime/runner-wake';

/**
 * The `wiki_repo_op` table and the space's snapshot cache (migration 0402, contract `repoOps`,
 * design §7).
 *
 * THE SERVER HOLDS NO REPOSITORY. Git's credentials are on the runners, so a pipeline that has to know
 * what the repository says writes a row here and waits: the machine the space's workspace runs on claims
 * it in the heartbeat response, reads its own checkout, and answers through the result route. Nothing in
 * this path creates a session, takes a concurrency slot, or touches a model.
 *
 * THE CLAIM IS THE SERIALISATION, as it is for the integration queue. A claim moves the row to running
 * under a fresh generation in one statement, so the row a heartbeat was handed is already this process's
 * and nobody else's; every write that settles it afterwards is a compare-and-set on (runner_id,
 * lease_owner, claim_generation), and a process whose claim was taken over settles nothing — it is told
 * 409 STALE_CLAIM and stops. A claim that has gone quiet (`heartbeat_at` older than
 * WIKI_REPO_OPS.staleSeconds) may be taken over by another process on the same machine, which is what a
 * machine being restarted mid-snapshot looks like.
 *
 * THE RESULT IS ALSO THE ANSWER. A kind's result is a JSON object small enough for one request body,
 * except a snapshot, which may not be: above WIKI_REPO_OPS.inlineBytes it travels in fragments staged
 * under the operation (wiki_repo_op_fragment) and is reassembled here — by its sha256 and its byte count
 * — before it becomes the space's snapshot. A snapshot that fails halfway therefore leaves the cache as
 * it was, and the staged fragments are dropped with the operation's settle.
 *
 * WHAT IS A SERVICE AND WHAT IS NOT. The three writes that own a transaction are methods of `WikiRepoOps`
 * below, so each retry is labelled the way every other retry in this tree is (db-write-inventory.ts). The
 * claim, the renewals and the waits are plain functions: they are single statements or read loops, they
 * open no transaction, and nothing about them is a service's.
 */

/** The channel a settled operation announces itself on; a waiting job LISTENs on it and polls as the fallback. */
export const WIKI_REPO_OP_CHANNEL = 'wiki_repo_op';

/** Why a repository operation could not be written. Each is a status code at the route. */
export type WikiRepoOpRefusal = 'STALE_CLAIM' | 'NOT_FOUND' | 'INVALID_RESULT';

export const WIKI_REPO_OP_REFUSAL_STATUS: Record<WikiRepoOpRefusal, number> = {
  STALE_CLAIM: 409,
  NOT_FOUND: 404,
  INVALID_RESULT: 400,
};

export class WikiRepoOpRefused extends Error {
  constructor(readonly refusal: WikiRepoOpRefusal, message?: string) {
    super(message ?? refusal);
    this.name = 'WikiRepoOpRefused';
  }
}

/** The workspace whose checkout an operation reads, as the enqueue resolved it. */
export interface WikiRepoOpTarget {
  workspaceId: string;
  runnerId: string | null;
  workDir: string | null;
}

/** One operation a heartbeat just claimed, in the shape the runner is handed. */
export interface WikiRepoOpClaim {
  id: string;
  kind: WikiRepoOpKind;
  claimGeneration: number;
  leaseOwner: string;
  workDir: string;
  repoUrlNorm: string | null;
  rootCommitSha: string | null;
  input: Record<string, unknown>;
}

/** What a heartbeat knows about the process asking for work. */
export interface WikiRepoOpDispatchHeartbeat {
  runnerId: string;
  /** Null for a heartbeat with no process identity: it is handed nothing. */
  leaseOwner: string | null;
  draining: boolean;
  capabilities: string[] | undefined;
}

/** What a settled operation says. Terminal states are the answer; the rest are still moving. */
export interface WikiRepoOpRead {
  id: string;
  jobId: string;
  spaceId: string;
  kind: string;
  state: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

/** The space's snapshot, header and payload: the index the pipelines query, reassembled. */
export interface WikiRepoSnapshotRead {
  sha: string;
  bytes: number;
  digest: string;
  fragments: number;
  index: string;
}

/** What the space's repository steps depend on, as the health line reads it. */
export interface WikiRepoReadiness {
  look: WikiRepoLook;
  /** The workspace the operations read, when one is named and still exists. */
  workspace: { id: string; workDir: string | null } | null;
  /** The machine that runs them, when the workspace names one. */
  runner: { id: string; name: string; version: string | null; capability: boolean; online: boolean } | null;
  /** Operations of this space that have not settled: what a reader is waiting on. */
  pending: number;
}

// ── the three writes that own a transaction ─────────────────────────────────────────────────────

/**
 * The repository operations' writes, as the door and the worker call them (contract `repoOps`, design §7).
 *
 * Three of them own a transaction — enqueuing an operation, staging a fragment, settling a result — and
 * each names itself at the retry (db-write-inventory.ts); the rest of the table's statements are the plain
 * functions below, which the door and the worker call directly. A class rather than three module functions
 * for exactly the reason `IntegrationJobRelay` is one: a retry is labelled at its call site through
 * `loggedRetry` with this class's own logger and a written-out operation name — which is what the metrics
 * and the runbook aggregate on, and what `db-conflict-metrics.spec.ts` reads out of this file.
 */
@Injectable()
export class WikiRepoOps {
  private readonly logger = new Logger(WikiRepoOps.name);

  constructor(private readonly prisma: PrismaService) {}

  /** §7 — the operations this heartbeat's process claimed; the claim itself is `claimWikiRepoOps`. */
  dispatch(heartbeat: WikiRepoOpDispatchHeartbeat): Promise<WikiRepoOpClaim[]> {
    return claimWikiRepoOps(this.prisma, heartbeat, this.logger);
  }

  /** §7 — a claimed operation's lease renewal; the statement is `renewWikiRepoOp`. */
  progress(input: { id: string; runnerId: string; leaseOwner: string; claimGeneration: number }): Promise<void> {
    return renewWikiRepoOp(this.prisma, input);
  }

  /**
   * Write one repository operation for a job, and wake the machine that will run it.
   *
   * The workspace is the job's own material rather than the caller's: the space's maintenance settings name
   * the workspace the repository is read from (design §2.2, "which workspace — that is, which runner — the
   * repository is read from"), and a caller may name another one explicitly. A space that names no
   * workspace, or one that is gone or has no working directory, is refused here: nothing would ever be
   * handed out, and a job waiting on it would wait out its whole limit to learn that. The job itself is
   * read first, and answered as NOT_FOUND when there is none — an operation is always some job's.
   */
  async enqueueWikiRepoOp(input: {
    id?: string;
    jobId: string;
    kind: WikiRepoOpKind;
    input?: Record<string, unknown>;
    /** Another workspace than the space's maintenance one; the caller knows which checkout it means. */
    workspaceId?: string;
  }): Promise<{ id: string; target: WikiRepoOpTarget }> {
    const id = input.id ?? randomUUID();
    const job = await this.prisma.wikiJob.findUnique({
      where: { id: input.jobId },
      select: { id: true, ownerId: true, spaceId: true, space: { select: { settings: true } } },
    });
    if (!job) {
      throw new WikiRepoOpRefused('NOT_FOUND', `no job ${input.jobId} to enqueue a repository operation for`);
    }
    const workspaceId = input.workspaceId ?? maintenanceWorkspaceOf(job.space.settings);
    if (!workspaceId) {
      throw new WikiRepoOpRefused('INVALID_RESULT', 'the space names no workspace to read its repository in');
    }
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId: job.ownerId },
      select: { id: true, runnerId: true, workDir: true },
    });
    if (!workspace || !workspace.workDir) {
      throw new WikiRepoOpRefused(
        'INVALID_RESULT',
        `the space's workspace ${workspaceId} has no working directory to read the repository in`,
      );
    }
    await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "wiki_repo_op" ("id", "job_id", "owner_id", "space_id", "workspace_id", "runner_id", "kind", "input", "state")
        VALUES (${id}::uuid, ${job.id}::uuid, ${job.ownerId}::uuid, ${job.spaceId}::uuid,
                ${workspace.id}::uuid, ${workspace.runnerId}::uuid, ${input.kind},
                ${JSON.stringify(input.input ?? {})}::jsonb, 'queued')
        ON CONFLICT ("id") DO NOTHING`;
      // The wake travels with the row (runner-wake.ts): a machine that beats before this commits would
      // find nothing and wait out the tick it was woken to skip.
      await notifyRunnerWakeOnCommit(tx, workspace.runnerId);
    }, loggedRetry(this.logger, 'wikiRepoOp.enqueue'));
    return { id, target: { workspaceId: workspace.id, runnerId: workspace.runnerId, workDir: workspace.workDir } };
  }

  /**
   * One fragment of a snapshot too large for one request body, staged under the operation.
   *
   * The fence is the claim's, and the staging row is an upsert keyed by (operation, ordinal), so a fragment
   * that was sent twice is one fragment — which is what makes the upload safe to retry. `total` travels
   * with every fragment so a count that disagrees with the reassembly is refused at the fragment rather
   * than at the end.
   */
  async storeWikiRepoOpFragment(input: {
    id: string;
    runnerId: string;
    leaseOwner: string;
    claimGeneration: number;
    index: number;
    total: number;
    sha: string;
    content: string;
  }): Promise<{ received: number }> {
    if (!Number.isInteger(input.index) || input.index < 0
      || !Number.isInteger(input.total) || input.total < 1 || input.index >= input.total) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `fragment ${input.index} of ${input.total}`);
    }
    if (typeof input.content !== 'string' || input.content === '') {
      throw new WikiRepoOpRefused('INVALID_RESULT', 'an empty fragment');
    }
    if (Buffer.byteLength(input.content, 'utf8') > WIKI_REPO_OPS.fragmentBytes) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `a fragment of more than ${WIKI_REPO_OPS.fragmentBytes} bytes`);
    }
    if (input.total > Math.ceil(WIKI_REPO_OPS.maxSnapshotBytes / WIKI_REPO_OPS.fragmentBytes) + 1) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `${input.total} fragments is more than a snapshot can be`);
    }
    if (!/^[0-9a-f]{40}$/.test(input.sha)) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `${input.sha} is not a commit`);
    }
    return withTransactionRetry(this.prisma, async (tx) => {
      const fenced = await tx.$executeRaw`
        UPDATE "wiki_repo_op"
           SET "heartbeat_at" = now(), "updated_at" = now()
         WHERE "id" = ${input.id}::uuid
           AND "runner_id" = ${input.runnerId}::uuid
           AND "state" = 'running'
           AND "lease_owner" = ${input.leaseOwner}::uuid
           AND "claim_generation" = ${input.claimGeneration}`;
      if (fenced === 0) throw new WikiRepoOpRefused('STALE_CLAIM');
      await tx.$executeRaw`
        INSERT INTO "wiki_repo_op_fragment" ("op_id", "ordinal", "content")
        VALUES (${input.id}::uuid, ${input.index}, ${input.content})
        ON CONFLICT ("op_id", "ordinal") DO UPDATE SET "content" = EXCLUDED."content"`;
      const [counted] = await tx.$queryRaw<Array<{ received: bigint }>>`
        SELECT count(*) AS "received" FROM "wiki_repo_op_fragment" WHERE "op_id" = ${input.id}::uuid`;
      return { received: Number(counted?.received ?? 0) };
    }, loggedRetry(this.logger, 'wikiRepoOp.storeFragment'));
  }

  /**
   * What one operation came to (§7): the state, and — for a snapshot — the payload, which is written into
   * the space's cache in the same transaction that settles the row.
   *
   * Everything is decided under the claim's generation. A result that arrives twice (a lost response) is
   * answered with the state the row already holds rather than refused, and a result from a claim that was
   * taken over meets STALE_CLAIM.
   */
  async applyWikiRepoOpResult(input: {
    id: string;
    runnerId?: string;
    /** The reporting runner's owner, so another account's operation is answered as one that does not exist. */
    ownerId?: string;
    body: {
      claimGeneration?: unknown;
      leaseOwner?: unknown;
      state?: unknown;
      result?: unknown;
      error?: unknown;
    };
  }): Promise<{ accepted: boolean; state: WikiRepoOpState }> {
    const state = String(input.body?.state ?? '');
    if (!WIKI_REPO_OP_RESULT_STATES.includes(state as never)) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `${state} is not a result`);
    }
    const error = typeof input.body?.error === 'string' ? input.body.error.trim() : '';
    if (state === 'failed' && error === '') {
      throw new WikiRepoOpRefused('INVALID_RESULT', 'a failed operation has to say why');
    }
    const result = input.body?.result;
    if (result != null && (typeof result !== 'object' || Array.isArray(result))) {
      throw new WikiRepoOpRefused('INVALID_RESULT', 'a result is an object');
    }

    return withTransactionRetry(this.prisma, async (tx) => {
      const row = await tx.wikiRepoOp.findFirst({
        where: { id: input.id, ...(input.ownerId != null ? { ownerId: input.ownerId } : {}) },
        select: {
          id: true, jobId: true, ownerId: true, spaceId: true, kind: true, state: true,
          runnerId: true, leaseOwner: true, claimGeneration: true,
        },
      });
      if (!row) throw new WikiRepoOpRefused('NOT_FOUND');
      if (row.state !== 'queued' && row.state !== 'running') {
        // Not a mistake the runner has to undo: a response that was lost is sent again, and the second copy
        // finds the operation already written down.
        return { accepted: false, state: row.state as WikiRepoOpState };
      }
      if (
        row.leaseOwner !== String(input.body?.leaseOwner ?? '')
        || row.claimGeneration !== Number(input.body?.claimGeneration ?? -1)
        || (input.runnerId != null && row.runnerId !== input.runnerId)
      ) {
        throw new WikiRepoOpRefused('STALE_CLAIM');
      }

      // The claim, as a compare-and-set rather than the read above: the read decided WHAT to write, this
      // statement decides whether this process may still write it. A takeover between the two flips zero
      // rows, and the whole transaction — including anything the snapshot below writes — is rolled back
      // with it.
      const settled = await tx.wikiRepoOp.updateMany({
        where: {
          id: row.id,
          state: 'running',
          leaseOwner: row.leaseOwner,
          claimGeneration: row.claimGeneration,
          ...(input.runnerId != null ? { runnerId: input.runnerId } : {}),
        },
        data: {
          state,
          result: (result ?? null) as Prisma.InputJsonValue,
          error: state === 'failed' ? error : null,
          leaseOwner: null,
          claimedAt: null,
          heartbeatAt: null,
          endedAt: new Date(),
        },
      });
      if (settled.count === 0) throw new WikiRepoOpRefused('STALE_CLAIM');

      if (state === 'succeeded') {
        const answer = await settleSnapshot(tx, row, result as Record<string, unknown> | null);
        // A snapshot answers with its shape, never the payload: the payload is the cache's, and echoing a
        // megabyte of it into the row would double the bytes for a reader that has to be told where it is
        // anyway.
        if (answer) {
          await tx.wikiRepoOp.update({ where: { id: row.id }, data: { result: answer as Prisma.InputJsonValue } });
        }
      }
      // The staging is the operation's: whatever it staged has either just become the space's snapshot or
      // is of no further use.
      await tx.wikiRepoOpFragment.deleteMany({ where: { opId: row.id } });
      await notifyRepoOpSettled(tx, row.id);
      return { accepted: true, state: state as WikiRepoOpState };
    }, loggedRetry(this.logger, 'wikiRepoOp.applyResult'));
  }
}

// ── claim ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The operations this heartbeat's process has just claimed (§7): at most WIKI_REPO_OPS.perHeartbeat,
 * oldest first, and only the ones whose workspace is this machine's.
 *
 * A process with no lease owner, a draining one, or one that has not declared `wiki-repo-op/v1` is handed
 * nothing — never an error, because an old runner is an ordinary state of a machine and the miss is not a
 * failure of the operation. The row stays queued, and the step that needs it waits (see the health line).
 */
export async function claimWikiRepoOps(
  prisma: PrismaService,
  heartbeat: WikiRepoOpDispatchHeartbeat,
  log?: { warn: (message: string) => void },
): Promise<WikiRepoOpClaim[]> {
  if (!heartbeat.leaseOwner || heartbeat.draining) return [];
  if (!heartbeat.capabilities?.includes(WIKI_REPO_OP_CAPABILITY)) return [];

  const claims: WikiRepoOpClaim[] = [];
  for (let i = 0; i < WIKI_REPO_OPS.perHeartbeat; i += 1) {
    const row = await claimOne(prisma, heartbeat.runnerId, heartbeat.leaseOwner).catch((error: unknown) => {
      log?.warn(`wiki repo op claim failed: ${(error as Error)?.message ?? String(error)}`);
      return null;
    });
    if (!row) break;
    claims.push(row);
  }
  return claims;
}

/**
 * Claim the oldest operation this machine can run, or take over one of its own whose claimer stopped
 * beating.
 *
 * `FOR UPDATE SKIP LOCKED` over the candidate, so two apiserver processes beating at the same moment do
 * not queue behind each other, and the write takes the row under a new generation in the same statement —
 * which is what makes the claim the serialisation rather than an agreement.
 */
async function claimOne(
  prisma: PrismaService,
  runnerId: string,
  leaseOwner: string,
): Promise<WikiRepoOpClaim | null> {
  const staleBefore = new Date(Date.now() - WIKI_REPO_OPS.staleSeconds * 1000);
  const rows = await prisma.$queryRaw<WikiRepoOpClaim[]>(Prisma.sql`
    WITH candidate AS (
      SELECT o."id"
        FROM "wiki_repo_op" o
        JOIN "workspace" w ON w."id" = o."workspace_id"
       WHERE w."runner_id" = ${runnerId}::uuid
         AND w."work_dir" IS NOT NULL
         AND (
           o."state" = 'queued'
           -- Or one this process may take over: claimed, and quiet for longer than the stale window. Its
           -- own live claims are excluded, so one heartbeat cannot re-claim what it was just handed.
           OR (o."state" = 'running'
               AND (o."heartbeat_at" IS NULL OR o."heartbeat_at" < ${staleBefore})
               AND o."lease_owner" IS DISTINCT FROM ${leaseOwner}::uuid)
         )
       ORDER BY o."created_at", o."id"
       FOR UPDATE SKIP LOCKED
       LIMIT 1
    )
    UPDATE "wiki_repo_op" o
       SET "state" = 'running',
           "claim_generation" = o."claim_generation" + 1,
           "lease_owner" = ${leaseOwner}::uuid,
           "runner_id" = ${runnerId}::uuid,
           "claimed_at" = now(),
           "heartbeat_at" = now(),
           "updated_at" = now()
      FROM candidate, "workspace" w
     WHERE o."id" = candidate."id"
       AND w."id" = o."workspace_id"
    RETURNING o."id" AS "id",
              o."kind" AS "kind",
              o."claim_generation" AS "claimGeneration",
              ${leaseOwner}::text AS "leaseOwner",
              w."work_dir" AS "workDir",
              -- Scalar subqueries rather than another join: the FROM list of an UPDATE cannot join ON a
              -- column of the table being updated (42P01), and a claim that raises is swallowed by the
              -- caller as a warning, which would read as a queue nobody ever picks up.
              (SELECT s."repo_url_norm" FROM "wiki_space" s WHERE s."id" = o."space_id") AS "repoUrlNorm",
              (SELECT s."root_commit_sha" FROM "wiki_space" s WHERE s."id" = o."space_id") AS "rootCommitSha",
              o."input" AS "input"
  `);
  const row = rows[0];
  if (!row) return null;
  return { ...row, kind: row.kind as WikiRepoOpKind, input: (row.input ?? {}) as Record<string, unknown> };
}

// ── the runner's renewals, and the job parked on an operation ───────────────────────────────────

/**
 * A heartbeat from the runner working on an operation: the lease renewal that keeps another process from
 * taking it over. A miss means the claim is no longer this process's, and the route says so.
 */
export async function renewWikiRepoOp(
  prisma: PrismaService,
  input: { id: string; runnerId: string; leaseOwner: string; claimGeneration: number },
): Promise<void> {
  const moved = await prisma.$executeRaw`
    UPDATE "wiki_repo_op"
       SET "heartbeat_at" = now(), "updated_at" = now()
     WHERE "id" = ${input.id}::uuid
       AND "runner_id" = ${input.runnerId}::uuid
       AND "state" = 'running'
       AND "lease_owner" = ${input.leaseOwner}::uuid
       AND "claim_generation" = ${input.claimGeneration}`;
  if (moved === 0) throw new WikiRepoOpRefused('STALE_CLAIM');
}

/** A succeeded snapshot: the payload becomes the space's snapshot, or the answer says the space already
 *  held this commit and nothing was built.
 *
 * Returns what the row's result is written with — for a snapshot that is its shape (sha, bytes, digest,
 * fragments), never the payload: the payload is the cache's, and echoing it into the row would double the
 * bytes for a reader that has to be told where it is anyway.
 */
async function settleSnapshot(
  tx: Prisma.TransactionClient,
  row: { id: string; spaceId: string; ownerId: string; kind: string },
  result: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (row.kind !== 'snapshot') return null;
  const sha = String(result?.sha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'a snapshot result names the commit it read');
  }
  if (result?.skipped === true) {
    // "The server already has this sha": the answer is only honest while that is true, so it is read here
    // rather than taken on the runner's word.
    const held = await tx.wikiRepoSnapshot.findUnique({
      where: { spaceId: row.spaceId },
      select: { sha: true },
    });
    if (held?.sha !== sha) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `no snapshot of ${sha} is held for this space`);
    }
    return { sha, skipped: true };
  }

  const inline = typeof result?.index === 'string' && result.index !== '' ? result.index : null;
  let payload: string;
  let fragments: number;
  if (inline !== null) {
    payload = inline;
    fragments = 1;
  } else {
    const staged = await tx.wikiRepoOpFragment.findMany({
      where: { opId: row.id },
      orderBy: { ordinal: 'asc' },
      select: { ordinal: true, content: true },
    });
    const total = Number(result?.fragments ?? 0);
    if (staged.length === 0 || staged.length !== total) {
      throw new WikiRepoOpRefused(
        'INVALID_RESULT',
        `a snapshot in fragments names how many there are: ${staged.length} staged, ${total} named`,
      );
    }
    if (staged.some((fragment, index) => fragment.ordinal !== index)) {
      throw new WikiRepoOpRefused('INVALID_RESULT', 'the staged fragments are not a run of 0..n');
    }
    payload = staged.map((fragment) => fragment.content).join('');
    fragments = staged.length;
  }

  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > WIKI_REPO_OPS.maxSnapshotBytes) {
    throw new WikiRepoOpRefused('INVALID_RESULT', `a snapshot of ${bytes} bytes is more than one may be`);
  }
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  if (result?.digest != null && String(result.digest) !== digest) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the snapshot does not hash as the result says it does');
  }
  if (result?.bytes != null && Number(result.bytes) !== bytes) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the snapshot is not as many bytes as the result says');
  }

  // One snapshot per space, replaced whole: the old header goes (its fragments with it, by the foreign
  // key) before the new one is written, in this transaction.
  await tx.wikiRepoSnapshot.deleteMany({ where: { spaceId: row.spaceId } });
  await tx.wikiRepoSnapshot.create({
    data: {
      spaceId: row.spaceId,
      ownerId: row.ownerId,
      sha,
      digest,
      sizeBytes: BigInt(bytes),
      fragmentCount: fragments,
    },
  });
  let ordinal = 0;
  for (const piece of splitSnapshot(payload)) {
    await tx.wikiRepoSnapshotFragment.create({
      data: { spaceId: row.spaceId, ordinal, content: piece },
    });
    ordinal += 1;
  }
  return { sha, bytes, digest, fragments };
}

/** A payload in storage-sized pieces: the same split a reader concatenates back by ordinal. */
function* splitSnapshot(payload: string): Generator<string> {
  const size = WIKI_REPO_OPS.fragmentBytes;
  if (Buffer.byteLength(payload, 'utf8') <= size) {
    yield payload;
    return;
  }
  // Cut on characters, sized by bytes: a chunk that would cross the limit ends before the character that
  // would cross it, so no fragment is ever over the limit and no character is ever cut in half.
  let start = 0;
  let used = 0;
  for (let i = 0; i < payload.length; i += 1) {
    const width = Buffer.byteLength(payload[i], 'utf8');
    if (used + width > size) {
      yield payload.slice(start, i);
      start = i;
      used = 0;
    }
    used += width;
  }
  yield payload.slice(start);
}

/** `SELECT pg_notify(...)`, from inside the transaction that settled the row: whoever waits is woken at COMMIT. */
async function notifyRepoOpSettled(tx: Prisma.TransactionClient, opId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${WIKI_REPO_OP_CHANNEL}, ${opId})`;
}

// ── the worker's read and wait ──────────────────────────────────────────────────────────────────

/** One operation as a waiter reads it. `null` when there is no such operation for this owner. */
export async function readWikiRepoOp(
  prisma: PrismaService,
  input: { id: string; ownerId?: string },
): Promise<WikiRepoOpRead | null> {
  const row = await prisma.wikiRepoOp.findFirst({
    where: { id: input.id, ...(input.ownerId != null ? { ownerId: input.ownerId } : {}) },
    select: { id: true, jobId: true, spaceId: true, kind: true, state: true, result: true, error: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.jobId,
    spaceId: row.spaceId,
    kind: row.kind,
    state: row.state,
    result: (row.result as Record<string, unknown> | null) ?? null,
    error: row.error,
  };
}

/** The space's snapshot, header and payload: what a pipeline queries instead of the repository. */
export async function readWikiRepoSnapshot(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string },
): Promise<WikiRepoSnapshotRead | null> {
  const header = await prisma.wikiRepoSnapshot.findFirst({
    where: { spaceId: input.spaceId, ownerId: input.ownerId },
    select: { sha: true, digest: true, sizeBytes: true, fragmentCount: true },
  });
  if (!header) return null;
  const fragments = await prisma.wikiRepoSnapshotFragment.findMany({
    where: { spaceId: input.spaceId },
    orderBy: { ordinal: 'asc' },
    select: { content: true },
  });
  return {
    sha: header.sha,
    bytes: Number(header.sizeBytes),
    digest: header.digest,
    fragments: header.fragmentCount,
    index: fragments.map((fragment) => fragment.content).join(''),
  };
}

/** Waiters hear about a settled operation over the channel; a poll answers when one is lost. */
export interface WikiRepoOpWake {
  onChange(listener: (opId: string) => void): () => void;
}

/** What a wait resolved with, or the reason it did not. */
export interface WikiRepoOpWait {
  state: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

/** The operation did not settle within the wait's limit; the row is still whatever it was. */
export class WikiRepoOpWaitTimedOut extends Error {
  constructor(readonly opId: string, readonly timeoutMs: number) {
    super(`the repository operation ${opId} did not settle within ${timeoutMs} ms`);
    this.name = 'WikiRepoOpWaitTimedOut';
  }
}

/**
 * Wait for one operation to settle (§7): the notification is the wake-up and the poll is the fallback, so
 * an announcement lost to a dropped listener costs the waiter one poll interval rather than its answer.
 */
export async function waitForWikiRepoOp(
  prisma: PrismaService,
  input: {
    id: string;
    ownerId?: string;
    timeoutMs: number;
    pollMs?: number;
    wake?: WikiRepoOpWake;
    signal?: AbortSignal;
  },
): Promise<WikiRepoOpWait> {
  const pollMs = input.pollMs ?? WIKI_REPO_OPS.pollSeconds * 1000;
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const read = await readWikiRepoOp(prisma, { id: input.id, ownerId: input.ownerId });
    if (!read) throw new WikiRepoOpRefused('NOT_FOUND', `no repository operation ${input.id}`);
    if (read.state !== 'queued' && read.state !== 'running') {
      return { state: read.state, result: read.result, error: read.error };
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new WikiRepoOpWaitTimedOut(input.id, input.timeoutMs);
    await wakeOrPoll(input.wake, input.id, Math.min(pollMs, left), input.signal);
  }
}

/** One turn of the wait: the notification for this operation, the poll, or a deadline that ran out. */
function wakeOrPoll(
  wake: WikiRepoOpWake | undefined,
  opId: string,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      off?.();
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const off = wake?.onChange((id) => {
      if (id === opId) finish();
    });
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/**
 * Park a running job on a repository operation and wake it when the operation settles (contract
 * `jobs.waitingFor`, design §7).
 *
 * A job that waits for the repository waits on SOMETHING ELSE, so it holds no lease while it does: the row
 * goes to `waiting` with `waiting_for = 'repo'` and its lease columns cleared, and it is put back to
 * `queued` here when the operation settles — whichever way it settled — so the claim picks the job up
 * again with a fresh generation and its pipeline replays from the start, the answer already in the cache.
 *
 * A wait that runs out is an infra failure: the job goes back to queued with the lost attempt counted and
 * the reason on its row. It never ends a job by itself: a runner that is away, or one too old to be given
 * the work at all, is something the next attempt and the health line are for.
 */
export async function waitForWikiRepoOpAsJob(
  prisma: PrismaService,
  input: {
    jobId: string;
    generation: string;
    opId: string;
    timeoutMs: number;
    pollMs?: number;
    wake?: WikiRepoOpWake;
    signal?: AbortSignal;
  },
): Promise<WikiRepoOpWait> {
  const parked = await prisma.$executeRaw`
    UPDATE "wiki_job"
       SET "state" = 'waiting',
           "waiting_for" = 'repo',
           "lease_owner" = NULL,
           "lease_generation" = NULL,
           "lease_deadline_at" = NULL,
           "updated_at" = now()
     WHERE "id" = ${input.jobId}::uuid
       AND "state" = 'running'
       AND "lease_generation" = ${input.generation}::uuid`;
  if (parked === 0) throw new WikiRepoOpRefused('STALE_CLAIM', `the job ${input.jobId} is not this holder's to park`);
  try {
    const answer = await waitForWikiRepoOp(prisma, {
      id: input.opId,
      timeoutMs: input.timeoutMs,
      pollMs: input.pollMs,
      wake: input.wake,
      signal: input.signal,
    });
    await resumeJobAfterRepoOp(prisma, { jobId: input.jobId, opId: input.opId });
    return answer;
  } catch (error) {
    // The wait itself ended — its limit ran out, or the worker is stopping — and that is the platform's
    // failure, not the work's: the job goes back to the queue with the lost attempt counted and the reason
    // on its row, and the operation stays where it is for the attempt that follows.
    const reason = error instanceof WikiRepoOpWaitTimedOut
      ? `the repository operation did not settle within ${Math.round(error.timeoutMs / 1000)} s`
      : `the wait for the repository operation stopped: ${(error as Error)?.message ?? String(error)}`;
    await requeueJobAfterRepoOpFailure(prisma, { jobId: input.jobId, reason });
    throw error;
  }
}

/**
 * A job whose wait for the repository ended badly: back to the queue, the lost attempt counted, the reason
 * on its row, and the next attempt on the backoff (contract `jobs.retry`). Matches only the parked state,
 * so a job a supervisor has since ended is not touched.
 */
export async function requeueJobAfterRepoOpFailure(
  prisma: PrismaService,
  input: { jobId: string; reason: string },
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "wiki_job"
       SET "state" = 'queued',
           "waiting_for" = NULL,
           "attempts" = "attempts" + 1,
           "next_attempt_at" = now() + (CASE WHEN "attempts" >= 2 THEN 30 WHEN "attempts" = 1 THEN 10 ELSE 0 END)
             * interval '1 second',
           "failure_kind" = 'infra',
           "error" = ${`REPO_OP_WAIT: ${input.reason}`},
           "updated_at" = now()
     WHERE "id" = ${input.jobId}::uuid AND "state" = 'waiting' AND "waiting_for" = 'repo'`;
}

/**
 * Put a job that was waiting for the repository back in the queue, with the wait it just had written down.
 * Called in the waiter's `finally`, so a wait that threw — a timeout, a cancelled job — still leaves the
 * job somewhere it can be claimed from.
 */
export async function resumeJobAfterRepoOp(
  prisma: PrismaService,
  input: { jobId: string; opId: string },
): Promise<void> {
  const op = await prisma.wikiRepoOp.findUnique({
    where: { id: input.opId },
    select: { state: true, error: true, kind: true },
  });
  const failed = op == null || op.state === 'failed' || op.state === 'cancelled';
  if (!failed) {
    await prisma.$executeRaw`
      UPDATE "wiki_job"
         SET "state" = 'queued', "waiting_for" = NULL, "next_attempt_at" = NULL, "updated_at" = now()
       WHERE "id" = ${input.jobId}::uuid AND "state" = 'waiting' AND "waiting_for" = 'repo'`;
    return;
  }
  const reason = op == null
    ? 'the repository operation is gone'
    : `${op.kind} failed: ${op.error ?? op.state}`;
  await prisma.$executeRaw`
    UPDATE "wiki_job"
       SET "state" = 'queued',
           "waiting_for" = NULL,
           "attempts" = "attempts" + 1,
           "next_attempt_at" = now() + (CASE WHEN "attempts" >= 2 THEN 30 WHEN "attempts" = 1 THEN 10 ELSE 0 END)
             * interval '1 second',
           "failure_kind" = 'infra',
           "error" = ${`REPO_OP_FAILED: ${reason}`},
           "updated_at" = now()
     WHERE "id" = ${input.jobId}::uuid AND "state" = 'waiting' AND "waiting_for" = 'repo'`;
}

/**
 * The workspace a space's repository is read in (design §2.2): `settings.maintenance.workspaceId`, as
 * `wikiMaintenanceSettings` reads it out of the settings object the space stores — the maintenance block
 * inside it, never the settings whole.
 */
function maintenanceWorkspaceOf(settings: unknown): string | null {
  const stored = (settings ?? {}) as Record<string, unknown>;
  return wikiMaintenanceSettings(stored.maintenance).workspaceId;
}

// ── the health line's read ──────────────────────────────────────────────────────────────────────

/** Three missed 30-second beats, the same window the runner list reads a machine as offline by. */
const RUNNER_OFFLINE_AFTER_MS = 90_000;

/**
 * Whether the space's repository steps can run, and if not, what the status line should say (design §2.2):
 * no workspace to read, no machine behind the workspace, the machine away, or a machine too old to be given
 * one — "upgrade the runner".
 */
export async function readWikiRepoReadiness(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string; now?: Date },
): Promise<WikiRepoReadiness> {
  const now = input.now ?? new Date();
  const space = await prisma.wikiSpace.findFirst({
    where: { id: input.spaceId, ownerId: input.ownerId },
    select: { settings: true },
  });
  const pending = await prisma.wikiRepoOp.count({
    where: { spaceId: input.spaceId, ownerId: input.ownerId, state: { in: ['queued', 'running'] } },
  });
  const workspaceId = maintenanceWorkspaceOf(space?.settings);
  const workspace = workspaceId
    ? await prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId: input.ownerId, deletedAt: null },
      select: { id: true, workDir: true, runnerId: true },
    })
    : null;
  if (!workspace || !workspace.workDir) {
    return {
      look: 'no_workspace',
      workspace: workspace ? { id: workspace.id, workDir: workspace.workDir } : null,
      runner: null,
      pending,
    };
  }
  const runnerRow = workspace.runnerId
    ? await prisma.runner.findFirst({
      where: { id: workspace.runnerId, ownerId: input.ownerId },
      select: { id: true, name: true, version: true, capabilities: true, capabilitiesReportedAt: true, lastHeartbeatAt: true },
    })
    : null;
  if (!runnerRow) {
    return {
      look: 'runner_missing',
      workspace: { id: workspace.id, workDir: workspace.workDir },
      runner: null,
      pending,
    };
  }
  const online = !!runnerRow.lastHeartbeatAt
    && now.getTime() - runnerRow.lastHeartbeatAt.getTime() < RUNNER_OFFLINE_AFTER_MS;
  const capability = !!runnerRow.capabilitiesReportedAt && runnerRow.capabilities.includes(WIKI_REPO_OP_CAPABILITY);
  const runner = { id: runnerRow.id, name: runnerRow.name, version: runnerRow.version, capability, online };
  return {
    look: capability ? (online ? 'ready' : 'runner_offline') : 'runner_upgrade',
    workspace: { id: workspace.id, workDir: workspace.workDir },
    runner,
    pending,
  };
}

/** One operation's kind is one of the four the contract names; anything else is a caller's mistake. */
export function isWikiRepoOpKind(kind: string): kind is WikiRepoOpKind {
  return (WIKI_REPO_OP_KINDS as readonly string[]).includes(kind);
}
