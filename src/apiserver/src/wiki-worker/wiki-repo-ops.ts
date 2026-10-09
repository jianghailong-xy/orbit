import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WIKI_REPO_OPS,
  WIKI_REPO_OP_CAPABILITY,
  WIKI_REPO_OP_KINDS,
  WIKI_REPO_OP_READ_CAPABILITY,
  WIKI_REPO_OP_RESULT_STATES,
  wikiMaintenanceSettings,
  type WikiRepoFileRead,
  type WikiRepoFileState,
  type WikiRepoLook,
  type WikiRepoOpKind,
  type WikiRepoOpState,
} from '@orbit/shared';
// A value import, not a type one: `WikiRepoOps` is a provider, and Nest reads its constructor's
// parameter metadata out of the emitted JavaScript — a type-only import leaves that slot `Object` and the
// process refuses to boot (checked in the e2e stack, 2026-10-08).
import { PrismaService } from '../prisma/prisma.service';
import { classifyTransactionFault, loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { notifyRunnerWakeOnCommit } from '../realtime/runner-wake';
import { stripNul } from '../runner-api/strip-nul';
import { postgresSqlState } from '../tasks/task-supersession';
import { wikiJsonIsStorable, wikiStoredText, wikiTextFromStored, wikiTextIsStorable, wikiTextIsWellFormed } from './wiki-stored-text';

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
 * except a snapshot or a read, which may not be: above WIKI_REPO_OPS.inlineBytes the answer travels in
 * fragments staged under the operation (wiki_repo_op_fragment) and is reassembled here — by its sha256 and
 * its byte count — before it becomes the space's snapshot or the files of its read cache. An upload that
 * therefore fails halfway leaves the cache as it was, and the staged fragments are dropped with the
 * operation's settle.
 *
 * A READ IS CACHED, NOT REPLAYED. A read answers with the whole file at the sha (owner 2026-10-08) and
 * every item of it is written into `wiki_repo_file`, one row per (space, sha, path), in the transaction that
 * settles the operation. A pipeline that needs a file asks for it here: what the space already holds is
 * served, and only the rest is asked of the runner — the same text is never read twice. A `cut` row (the
 * bounded window an older runner answers with) satisfies an older runner's read and not a whole-file one.
 *
 * A FILE IS KEPT BYTE FOR BYTE (contract `repoOps.storedText`). Postgres holds no U+0000 in `text` or `jsonb`,
 * and a source file can have one: such a file's text is kept as its UTF-8 bytes in base64, its row says so, and
 * the cache reads it back to the text `git show` printed (wiki-stored-text.ts). The raw answer — the files'
 * text, the index — is never written into the operation's own row: the row keeps what the settle made of it.
 *
 * NOTHING THE RUNNER IS TOLD IS FINAL IS LEFT RUNNING. A result or a fragment the server refuses, or cannot
 * store, settles the operation failed with the reason before the refusal is answered (`closeUnsettled`): the
 * runner stops on a 4xx, and the job waiting on the operation is woken now rather than at its limit. What a
 * runner gave up on in some other way — its job ended without it, or its claim went quiet long ago — is
 * settled failed by the worker's sweep (`failAbandonedWikiRepoOps`).
 *
 * WHAT IS A SERVICE AND WHAT IS NOT. The writes that own a transaction are methods of `WikiRepoOps` below,
 * so each retry is labelled the way every other retry in this tree is (db-write-inventory.ts). The claim,
 * the renewals, the waits and the sweep are plain functions: they are single statements or read loops,
 * they open no transaction, and nothing about them is a service's.
 */

/** The channel a settled operation announces itself on; a waiting job LISTENs on it and polls as the fallback. */
export const WIKI_REPO_OP_CHANNEL = 'wiki_repo_op';

/**
 * Why a repository operation could not be written. Each is a status code at the route. UNSTORABLE_RESULT is a
 * result or a fragment the database refused to store (a value it cannot hold, a constraint): the operation is
 * settled failed with the reason (`closeUnsettled`), and the 4xx tells the runner not to send it again.
 */
export type WikiRepoOpRefusal = 'STALE_CLAIM' | 'NOT_FOUND' | 'INVALID_RESULT' | 'UNSTORABLE_RESULT';

export const WIKI_REPO_OP_REFUSAL_STATUS: Record<WikiRepoOpRefusal, number> = {
  STALE_CLAIM: 409,
  NOT_FOUND: 404,
  INVALID_RESULT: 400,
  UNSTORABLE_RESULT: 422,
};

export class WikiRepoOpRefused extends Error {
  constructor(readonly refusal: WikiRepoOpRefusal, message?: string) {
    super(message ?? refusal);
    this.name = 'WikiRepoOpRefused';
  }
}

/** The claim a fragment or a result was written under, as the runner sent it: what closing the operation fences on. */
interface WikiRepoOpWrittenUnder {
  id: string;
  runnerId?: string;
  ownerId?: string;
  leaseOwner: string;
  claimGeneration: number;
}

/** A lease owner as the claim mints it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  runner: {
    id: string;
    name: string;
    version: string | null;
    /** It declared `wiki-repo-op/v1`: without it, it is handed no repository work at all. */
    capability: boolean;
    /** It declared `wiki-repo-op-read/v1`: with it, a read answers with the whole file. */
    wholeFile: boolean;
    online: boolean;
  } | null;
  /** Operations of this space that have not settled: what a reader is waiting on. */
  pending: number;
}

/**
 * Whether the steps that need the repository can run at all (design §7): a machine is there, beating, and
 * able to be handed operations. A runner with only `wiki-repo-op/v1` can — it reads the old bounded window
 * (`runner_upgrade` says to upgrade it, and the step still runs, cut short) — while one with no repository
 * capability at all cannot, and a step that waited on it would wait out its whole limit to learn that.
 */
export function wikiRepoStepsCanRun(readiness: WikiRepoReadiness): boolean {
  if (readiness.look === 'no_workspace' || readiness.look === 'runner_missing' || readiness.look === 'runner_offline') {
    return false;
  }
  return readiness.runner?.capability === true;
}

// ── the three writes that own a transaction ─────────────────────────────────────────────────────

/**
 * The repository operations' writes, as the door and the worker call them (contract `repoOps`, design §7).
 *
 * Four of them own a transaction — enqueuing an operation, staging a fragment, settling a result, and failing
 * the operation a fragment or a result could not be written for — and each names itself at the retry
 * (db-write-inventory.ts); the rest of the table's statements are the plain functions below, which the door
 * and the worker call directly. A class rather than module functions
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
   * than at the end. A fragment that is refused, or that the database will not store, fails the operation
   * (`closeUnsettled`): the runner abandons an upload on a 4xx, and the job waiting on it is told now.
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
    try {
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
      // A fragment is a piece of JSON text, where a NUL is written `\u0000` and a character is never half a pair:
      // a raw one is not part of any payload that parses, and the staging column could not hold the first.
      if (!wikiTextIsStorable(input.content)) {
        throw new WikiRepoOpRefused('INVALID_RESULT', 'a fragment with a raw U+0000 or a lone surrogate in it, which JSON text never has');
      }
      return await withTransactionRetry(this.prisma, async (tx) => {
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
    } catch (error) {
      throw await this.closeUnsettled(input, 'fragment', error);
    }
  }

  /**
   * What one operation came to (§7): the state, and — for a snapshot — the payload, which is written into
   * the space's cache in the same transaction that settles the row.
   *
   * Everything is decided under the claim's generation. A result that arrives twice (a lost response) is
   * answered with the state the row already holds rather than refused, and a result from a claim that was
   * taken over meets STALE_CLAIM. A result that is refused, or that the database will not store, fails the
   * operation with the reason before the refusal is answered (`closeUnsettled`).
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
    try {
      const state = String(input.body?.state ?? '');
      if (!WIKI_REPO_OP_RESULT_STATES.includes(state as never)) {
        throw new WikiRepoOpRefused('INVALID_RESULT', `${state} is not a result`);
      }
      // A failure's reason is a message — the job's error, the Activity line — so a NUL in it is dropped, as it is
      // from everything else a runner says (runner-api/strip-nul.ts), rather than failing the write that carries it.
      const error = typeof input.body?.error === 'string' ? stripNul(input.body.error).trim() : '';
      if (state === 'failed' && error === '') {
        throw new WikiRepoOpRefused('INVALID_RESULT', 'a failed operation has to say why');
      }
      const result = input.body?.result;
      if (result != null && (typeof result !== 'object' || Array.isArray(result))) {
        throw new WikiRepoOpRefused('INVALID_RESULT', 'a result is an object');
      }

      return await withTransactionRetry(this.prisma, async (tx) => {
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

        // What the row keeps of the answer. A succeeded snapshot's and read's are written below, once the settle
        // has made them — the shape, what became of each item — and never the raw answer: that is the index or
        // the files' text, which the caches hold, and a file with a NUL in it is a text jsonb cannot hold at all
        // (22P05, 2026-10-09). A diff's paths and an anchor's states are the answer itself, and none of them has
        // a NUL or a lone surrogate: one that does is not an answer.
        const kept = state === 'succeeded' && (row.kind === 'snapshot' || row.kind === 'read') ? null : result;
        if (kept != null && !wikiJsonIsStorable(kept)) {
          throw new WikiRepoOpRefused('INVALID_RESULT', `the ${row.kind} result has a U+0000 or a lone surrogate in it, which no ${row.kind} answer has`);
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
            // No result is SQL NULL, never JSON null, which `wiki_repo_op_result_chk` refuses: the runner leaves
            // `result` out of a failure (`omitempty`), so a JSON null here would make every failure unsettleable.
            result: kept == null ? Prisma.DbNull : (kept as Prisma.InputJsonValue),
            error: state === 'failed' ? error : null,
            leaseOwner: null,
            claimedAt: null,
            heartbeatAt: null,
            endedAt: new Date(),
          },
        });
        if (settled.count === 0) throw new WikiRepoOpRefused('STALE_CLAIM');

        if (state === 'succeeded') {
          const answer = await settleSnapshot(tx, row, result as Record<string, unknown> | null)
            ?? await settleRead(tx, row, result as Record<string, unknown> | null);
          // A snapshot answers with its shape, never the payload: the payload is the cache's, and echoing a
          // megabyte of it into the row would double the bytes for a reader that has to be told where it is
          // anyway. A read answers with what became of each item, its text being the cache's too.
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
    } catch (error) {
      const claim = {
        id: input.id,
        runnerId: input.runnerId,
        ownerId: input.ownerId,
        leaseOwner: String(input.body?.leaseOwner ?? ''),
        claimGeneration: Number(input.body?.claimGeneration ?? -1),
      };
      throw await this.closeUnsettled(claim, 'result', error);
    }
  }

  /**
   * The answer to a result or a fragment that was not written (contract `repoOps.unsettled`): unless the miss is
   * one the runner must not, or should, try again, the operation is settled failed with the reason — under the
   * claim the runner wrote with — and the refusal the route gives is final.
   *
   * Until 2026-10-09 a result the database refused was a 500: the runner sent it five more times, gave up, and the
   * operation stayed running under a claim nothing would ever settle, while the job waiting on it waited out
   * 300 seconds per read, three reads in a row. Now:
   *   - STALE_CLAIM and NOT_FOUND pass through: the operation is another claim's or nobody's, and nothing of it is
   *     this runner's to settle;
   *   - a conflict the database rolled back, or the database itself failing (`classifyTransactionFault`'s
   *     TRANSIENT and RESOURCE), passes through too: the write did not happen rather than being refused, the
   *     route answers 503 / 500, and the runner sends it again — which is what its retry is for;
   *   - anything else is the result's: the operation is failed with the reason (`failWikiRepoOp`), its waiter is
   *     woken by the settle's NOTIFY, and the route answers 400 INVALID_RESULT for a refusal, 422
   *     UNSTORABLE_RESULT for a write the database refused — the SQLSTATE in the reason.
   * A close that itself fails leaves the original error standing, and the runner's retry comes back to it.
   */
  private async closeUnsettled(claim: WikiRepoOpWrittenUnder, what: 'result' | 'fragment', error: unknown): Promise<unknown> {
    const refusal = error instanceof WikiRepoOpRefused ? error : null;
    if (refusal?.refusal === 'STALE_CLAIM' || refusal?.refusal === 'NOT_FOUND') return error;
    if (!refusal) {
      const fault = classifyTransactionFault(error);
      if (fault.retryable || fault.family === 'RESOURCE') return error;
    }
    const reason = refusal
      ? `the server refused the runner's ${what}: ${refusal.message}`
      : `the server could not store the runner's ${what}: ${storageFault(error)}`;
    let closed: boolean;
    try {
      closed = await this.failWikiRepoOp(claim, reason);
    } catch (closing) {
      this.logger.warn(`the repository operation ${claim.id} was not failed after its ${what} was not written: ${(closing as Error)?.message ?? String(closing)}`);
      return error;
    }
    const ended = closed ? '; the operation is failed' : '';
    return refusal
      ? new WikiRepoOpRefused(refusal.refusal, `${refusal.message}${ended}`)
      : new WikiRepoOpRefused('UNSTORABLE_RESULT', `${reason}${ended}`);
  }

  /**
   * Settle a running operation failed, with the reason, under the claim that holds it: the same compare-and-set
   * a result is written under, the staging dropped, and the NOTIFY that wakes the job waiting on it. False when
   * the claim no longer holds the row — another claim's, or settled already — and then nothing is written.
   */
  private async failWikiRepoOp(claim: WikiRepoOpWrittenUnder, reason: string): Promise<boolean> {
    // A claim that names no lease is no claim: there is nothing to compare, so nothing is settled.
    if (!UUID.test(claim.leaseOwner) || !Number.isInteger(claim.claimGeneration)) return false;
    return withTransactionRetry(this.prisma, async (tx) => {
      const failed = await tx.wikiRepoOp.updateMany({
        where: {
          id: claim.id,
          state: 'running',
          leaseOwner: claim.leaseOwner,
          claimGeneration: claim.claimGeneration,
          ...(claim.runnerId != null ? { runnerId: claim.runnerId } : {}),
          ...(claim.ownerId != null ? { ownerId: claim.ownerId } : {}),
        },
        data: {
          state: 'failed',
          result: Prisma.DbNull,
          error: reason,
          leaseOwner: null,
          claimedAt: null,
          heartbeatAt: null,
          endedAt: new Date(),
        },
      });
      if (failed.count === 0) return false;
      await tx.wikiRepoOpFragment.deleteMany({ where: { opId: claim.id } });
      await notifyRepoOpSettled(tx, claim.id);
      return true;
    }, loggedRetry(this.logger, 'wikiRepoOp.failUnsettled'));
  }
}

/**
 * A write the database refused, as the operation's error says it: the SQLSTATE and the database's own words — the
 * driver's message when Prisma kept it, else the last line of the error's — with any NUL dropped, cut to one line.
 */
function storageFault(error: unknown): string {
  const node = error as { message?: unknown; meta?: { driverAdapterError?: { cause?: { originalMessage?: unknown } } } } | null;
  const said = node?.meta?.driverAdapterError?.cause?.originalMessage;
  const text = typeof said === 'string' && said.trim() !== ''
    ? said
    : String(node?.message ?? error).split('\n').map((line) => line.trim()).filter((line) => line !== '').pop() ?? 'no reason given';
  const code = postgresSqlState(error);
  return `${code ? `${code} ` : ''}${stripNul(text)}`.slice(0, 400);
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

/**
 * The sweep (contract `repoOps.abandoned`): running operations nothing will ever settle, settled failed with the
 * reason. Two kinds, each quiet for at least the takeover window so a result about to arrive is not raced:
 *   - the job it was run for has ended — it went on without the answer, failed, or was cancelled — and nobody
 *     waits for one;
 *   - its claim has been silent for WIKI_REPO_OPS.abandonedSeconds: the runner gave up on it, or is gone.
 * The reads of 2026-10-09 are the first kind: their results were refused with 22P05 and given up on, and they
 * stayed running under their claims long after their maintain job ended. One statement, `FOR UPDATE SKIP LOCKED`
 * so a settle in flight keeps its row, and every operation it ends is announced on the channel a settle uses.
 * Answers how many it ended. The worker runs it on every pass (wiki-job-executor.ts).
 */
export async function failAbandonedWikiRepoOps(prisma: PrismaService, limit = 50): Promise<number> {
  return prisma.$executeRaw`
    WITH abandoned AS (
      SELECT o."id",
             CASE WHEN j."state" IN ('succeeded', 'failed', 'cancelled')
               THEN 'the job (' || j."kind" || ' ' || j."id" || ') ended ' || j."state" || ' with this ' || o."kind"
                    || ' still running: nobody waits for its answer, so it is closed'
               ELSE 'the runner''s claim has been silent since '
                    || to_char(o."heartbeat_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                    || ' and no answer came: the runner gave up on it or is gone, so it is closed'
             END AS "reason"
        FROM "wiki_repo_op" o
        JOIN "wiki_job" j ON j."id" = o."job_id"
       WHERE o."state" = 'running'
         AND o."heartbeat_at" < now() - ${WIKI_REPO_OPS.staleSeconds}::int * interval '1 second'
         AND (j."state" IN ('succeeded', 'failed', 'cancelled')
              OR o."heartbeat_at" < now() - ${WIKI_REPO_OPS.abandonedSeconds}::int * interval '1 second')
       ORDER BY o."heartbeat_at", o."id"
       LIMIT ${limit}
       FOR UPDATE OF o SKIP LOCKED
    ), failed AS (
      UPDATE "wiki_repo_op" o
         SET "state" = 'failed', "result" = NULL, "error" = a."reason", "lease_owner" = NULL,
             "claimed_at" = NULL, "heartbeat_at" = NULL, "ended_at" = now(), "updated_at" = now()
        FROM abandoned a
       WHERE o."id" = a."id" AND o."state" = 'running'
      RETURNING o."id"
    )
    SELECT pg_notify(${WIKI_REPO_OP_CHANNEL}, f."id"::text) FROM failed f`;
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
  // The index is JSON text, where a NUL in a heading or a path is written `\u0000`: a raw one is not an index that
  // parses, and the snapshot's fragments could not hold it.
  if (!wikiTextIsStorable(payload)) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the snapshot has a raw U+0000 or a lone surrogate in it, which its JSON never has');
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
  // What is kept of the repository is the commit the snapshot names: the files read at another sha go with
  // the snapshot that replaced them (design §7). A read in flight for an older sha that settles afterwards
  // writes its own rows back, which the next snapshot drops.
  await tx.wikiRepoFile.deleteMany({ where: { spaceId: row.spaceId, sha: { not: sha } } });
  return { sha, bytes, digest, fragments };
}

/**
 * A succeeded read (§7, owner 2026-10-08): every item becomes a row of the space's file cache at
 * (space, sha, path) — the whole file for `found`, the bounded window for `cut`, and the reason for
 * `missing` and `too_large` — and the row's result is written with what became of each item. The texts
 * themselves are the cache's, never echoed into the result: a reader that wants one reads it there.
 *
 * A text is kept byte for byte (`repoOps.storedText`): one with a U+0000 in it — a source file can have one —
 * as its UTF-8 bytes in base64, `content_encoding` saying so. A path or a text with a lone surrogate is not
 * something `git show` printed (the runner writes an invalid byte as U+FFFD), and is refused.
 */
async function settleRead(
  tx: Prisma.TransactionClient,
  row: { id: string; spaceId: string; ownerId: string; kind: string },
  result: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (row.kind !== 'read') return null;
  const read = readShapeOf(result);
  const answer = await readAnswerOf(tx, row.id, read);
  const sha = String(answer.sha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'a read result names the commit it read at');
  }
  if (read.sha != null && String(read.sha).toLowerCase() !== sha) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the read is not of the commit the result names');
  }
  if (!Array.isArray(answer.items)) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'a read result names its items');
  }
  const items: Array<Record<string, unknown>> = [];
  for (const raw of answer.items) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new WikiRepoOpRefused('INVALID_RESULT', 'a read item is an object');
    }
    const piece = raw as Record<string, unknown>;
    const path = typeof piece.path === 'string' ? piece.path.trim() : '';
    if (path === '') throw new WikiRepoOpRefused('INVALID_RESULT', 'a read item names a path');
    if (!wikiTextIsStorable(path)) {
      throw new WikiRepoOpRefused('INVALID_RESULT', 'a read item\'s path has a U+0000 or a lone surrogate in it, which no path in a tree has');
    }
    const found = piece.found === true;
    const reason = typeof piece.reason === 'string' ? piece.reason : '';
    const truncated = piece.truncated === true;
    const section = typeof piece.section === 'string' ? piece.section.trim() : '';
    const text = found && typeof piece.text === 'string' ? piece.text : '';
    const size = Number.isFinite(Number(piece.size)) ? Math.max(0, Number(piece.size)) : 0;
    if (!found && reason !== '' && reason !== 'too_large') {
      throw new WikiRepoOpRefused('INVALID_RESULT', `a read item is missing for ${reason}, which is no reason`);
    }
    if (Buffer.byteLength(text, 'utf8') > WIKI_REPO_OPS.wholeFileBytes) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `${path} answers with more than a whole file may be`);
    }
    if (!wikiTextIsWellFormed(text)) {
      throw new WikiRepoOpRefused('INVALID_RESULT', `${path} answers with a lone surrogate, which no file's bytes decode to`);
    }
    // What the runner answered: the whole file, or part of it — one section, or the old window's cut, which
    // a whole-file reader treats as a miss and this cache keeps for the bounded reader that asked.
    const state: WikiRepoFileState = !found
      ? (reason === 'too_large' ? 'too_large' : 'missing')
      : (truncated || section !== '' ? 'cut' : 'found');
    const stored = wikiStoredText(text);
    await tx.wikiRepoFile.upsert({
      where: { spaceId_sha_path: { spaceId: row.spaceId, sha, path } },
      create: {
        ownerId: row.ownerId, spaceId: row.spaceId, sha, path, state,
        content: stored.content, contentEncoding: stored.encoding, sizeBytes: BigInt(size),
      },
      update: { state, content: stored.content, contentEncoding: stored.encoding, sizeBytes: BigInt(size) },
    });
    items.push({
      path,
      state,
      chars: Number.isFinite(Number(piece.chars)) ? Number(piece.chars) : [...text].length,
    });
  }
  return { read: { sha, items } };
}

/** A read result's own object: the items, or — when the answer travelled in fragments — their shape. */
function readShapeOf(result: Record<string, unknown> | null): Record<string, unknown> {
  const read = result?.read;
  if (read == null || typeof read !== 'object' || Array.isArray(read)) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'a read result is an object');
  }
  return read as Record<string, unknown>;
}

/**
 * The answer of a read: the items it carries, or — when it was too large for one request body — the staged
 * fragments reassembled and read back. The digest and the byte count the result names are checked against
 * what was staged, so a payload that is not all there is refused rather than cached in part.
 */
async function readAnswerOf(
  tx: Prisma.TransactionClient,
  opId: string,
  read: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (Array.isArray(read.items)) return read;
  const staged = await tx.wikiRepoOpFragment.findMany({
    where: { opId },
    orderBy: { ordinal: 'asc' },
    select: { ordinal: true, content: true },
  });
  const total = Number(read.fragments ?? 0);
  if (staged.length === 0 || staged.length !== total) {
    throw new WikiRepoOpRefused(
      'INVALID_RESULT',
      `a read in fragments names how many there are: ${staged.length} staged, ${total} named`,
    );
  }
  if (staged.some((fragment, index) => fragment.ordinal !== index)) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the staged fragments are not a run of 0..n');
  }
  const payload = staged.map((fragment) => fragment.content).join('');
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (read.bytes != null && Number(read.bytes) !== bytes) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the read is not as many bytes as the result says');
  }
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  if (read.digest != null && String(read.digest) !== digest) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the read does not hash as the result says it does');
  }
  let answer: unknown;
  try {
    answer = JSON.parse(payload);
  } catch {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the read payload is not JSON');
  }
  if (answer == null || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'a read payload is an object');
  }
  const shape = answer as Record<string, unknown>;
  if (String(shape.sha ?? '').toLowerCase() !== String(read.sha ?? '').toLowerCase()) {
    throw new WikiRepoOpRefused('INVALID_RESULT', 'the read payload is not of the commit the result names');
  }
  return shape;
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

/** What a pipeline reads a file as: its text, and whether it is the whole file at the sha. */
export function wikiRepoFileText(file: WikiRepoFileRead | null | undefined): string {
  return file != null && (file.state === 'found' || file.state === 'cut') ? file.text : '';
}

/**
 * The files of a commit the space already holds, one entry per path the read cache has a row for
 * (contract `repoOps.cache`, design §7): what a pipeline serves without asking the runner at all.
 *
 * `wholeFile` says what the caller needs. A `cut` row is the bounded window an older runner answered with:
 * it satisfies a caller reading the same way and is a miss for a whole-file reader, which must read the
 * file again once its runner can. `missing` and `too_large` are answers too — the commit does not change —
 * and are served to both.
 */
export async function readCachedWikiRepoFiles(
  prisma: PrismaService,
  input: { ownerId: string; spaceId: string; sha: string; paths: readonly string[]; wholeFile: boolean },
): Promise<Map<string, WikiRepoFileRead>> {
  const out = new Map<string, WikiRepoFileRead>();
  if (input.paths.length === 0) return out;
  const rows = await prisma.wikiRepoFile.findMany({
    where: { ownerId: input.ownerId, spaceId: input.spaceId, sha: input.sha, path: { in: [...new Set(input.paths)] } },
    select: { path: true, state: true, content: true, contentEncoding: true, sizeBytes: true },
  });
  for (const row of rows) {
    const state = row.state as WikiRepoFileState;
    if (input.wholeFile && state === 'cut') continue;
    // The text as the runner read it: a file kept as its bytes (it has a U+0000) is turned back into its text here,
    // so every reader — the documents' build, the plan's symbol fallback, maintenance — reads what `git show` printed.
    const text = wikiTextFromStored(row.content, row.contentEncoding);
    out.set(row.path, { path: row.path, state, text, sizeBytes: Number(row.sizeBytes) });
  }
  return out;
}

/** What one read of files at a sha needs: the job it answers, the commit, and the paths wanted. */
export interface WikiRepoFilesRequest {
  prisma: PrismaService;
  repoOps: WikiRepoOps;
  jobId: string;
  ownerId: string;
  spaceId: string;
  sha: string;
  paths: readonly string[];
  /** Whether the space's runner reads whole files; a bounded one is asked with the old limits. */
  wholeFile: boolean;
  /** The size of a path at the sha, from the snapshot, for packing a request; unknown reads as the cap. */
  sizeOf?: (path: string) => number;
  /** How long one operation is waited for. */
  waitMs: number;
  wake?: WikiRepoOpWake;
  signal?: AbortSignal;
}

/**
 * The text of the paths at the sha, cache first (§7, owner 2026-10-08): what the space holds is served as
 * it is, and only the rest becomes a `read` operation — packed by the sizes the snapshot gives, waited for
 * one at a time — after which the answer is read back from the cache. Every requested path has an entry;
 * one the runner answered `missing` or `too_large` reads as null text through `wikiRepoFileText`.
 *
 * A wait that runs out, and an operation that failed, are the caller's to word: they throw. A signal that is aborted
 * asks the runner for nothing more: `WikiRepoOpWaitCancelled`, before the next operation is written.
 */
export async function readWikiRepoFiles(
  request: WikiRepoFilesRequest,
): Promise<Map<string, WikiRepoFileRead | null>> {
  const paths = [...new Set(request.paths)];
  const out = new Map<string, WikiRepoFileRead | null>();
  const cached = await readCachedWikiRepoFiles(request.prisma, {
    ownerId: request.ownerId,
    spaceId: request.spaceId,
    sha: request.sha,
    paths,
    wholeFile: request.wholeFile,
  });
  for (const path of paths) out.set(path, cached.get(path) ?? null);
  const missing = paths.filter((path) => !cached.has(path));
  if (missing.length === 0) return out;

  // One request's material: the whole-file runner is packed by bytes (its answer may travel in fragments,
  // so a pack is generous), the bounded one by the characters it can answer in all.
  const budget = request.wholeFile ? WIKI_REPO_OPS.operationBytes : WIKI_REPO_OPS.sectionChars;
  const packs: string[][] = [];
  let pack: string[] = [];
  let used = 0;
  for (const path of missing) {
    const size = request.wholeFile
      ? Math.min(request.sizeOf?.(path) ?? WIKI_REPO_OPS.wholeFileBytes, WIKI_REPO_OPS.wholeFileBytes)
      : Math.min(request.sizeOf?.(path) ?? WIKI_REPO_OPS.boundedChars, WIKI_REPO_OPS.boundedChars);
    if (pack.length > 0 && used + size > budget) {
      packs.push(pack);
      pack = [];
      used = 0;
    }
    pack.push(path);
    used += size;
  }
  if (pack.length > 0) packs.push(pack);

  for (const one of packs) {
    // A stopping worker asks the runner for nothing more (design §5.4): the read is the next process's replay's.
    if (request.signal?.aborted) throw new WikiRepoOpWaitCancelled(null);
    const items = one.map((path) => (request.wholeFile
      ? { path }
      : { path, maxChars: Math.min(request.sizeOf?.(path) ?? WIKI_REPO_OPS.boundedChars, WIKI_REPO_OPS.boundedChars) }));
    const { id } = await request.repoOps.enqueueWikiRepoOp({
      jobId: request.jobId,
      kind: 'read',
      input: { sha: request.sha, items },
    });
    const settled = await waitForWikiRepoOp(request.prisma, {
      id,
      ownerId: request.ownerId,
      timeoutMs: request.waitMs,
      wake: request.wake,
      signal: request.signal,
    });
    if (settled.state !== 'succeeded') {
      throw new WikiRepoOpRefused(
        'INVALID_RESULT',
        `a read of ${one.length === 1 ? one[0] : `${one.length} files`} ${settled.state}: ${settled.error ?? 'no reason given'}`,
      );
    }
  }

  const read = await readCachedWikiRepoFiles(request.prisma, {
    ownerId: request.ownerId,
    spaceId: request.spaceId,
    sha: request.sha,
    paths: missing,
    wholeFile: request.wholeFile,
  });
  for (const path of missing) out.set(path, read.get(path) ?? null);
  return out;
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
 * The waiter's own signal ended the wait (the worker is stopping); the row is still whatever it was. With no
 * operation, the signal came before one was asked, and none was.
 */
export class WikiRepoOpWaitCancelled extends Error {
  constructor(readonly opId: string | null) {
    super(opId === null
      ? 'the worker is stopping: no repository operation was asked'
      : `the wait for the repository operation ${opId} was cancelled`);
    this.name = 'WikiRepoOpWaitCancelled';
  }
}

/**
 * Wait for one operation to settle (§7): the notification is the wake-up and the poll is the fallback, so
 * an announcement lost to a dropped listener costs the waiter one poll interval rather than its answer. The
 * signal ends the wait at once — a stopping worker must not keep reading the row until the deadline.
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
    if (input.signal?.aborted) throw new WikiRepoOpWaitCancelled(input.id);
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
  const reported = !!runnerRow.capabilitiesReportedAt;
  const capability = reported && runnerRow.capabilities.includes(WIKI_REPO_OP_CAPABILITY);
  const wholeFile = reported && runnerRow.capabilities.includes(WIKI_REPO_OP_READ_CAPABILITY);
  const runner = { id: runnerRow.id, name: runnerRow.name, version: runnerRow.version, capability, wholeFile, online };
  // A machine that cannot be handed repository work at all, and one that can but reads only the old
  // bounded window, are both the runner to upgrade: the reason the status line gives is the same one, and
  // the second still runs the steps (cut short) while the first would make them wait.
  const look: WikiRepoLook = !capability ? 'runner_upgrade' : !online ? 'runner_offline' : wholeFile ? 'ready' : 'runner_upgrade';
  return { look, workspace: { id: workspace.id, workDir: workspace.workDir }, runner, pending };
}

/** One operation's kind is one of the four the contract names; anything else is a caller's mistake. */
export function isWikiRepoOpKind(kind: string): kind is WikiRepoOpKind {
  return (WIKI_REPO_OP_KINDS as readonly string[]).includes(kind);
}
