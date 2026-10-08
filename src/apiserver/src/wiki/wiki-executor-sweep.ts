import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import type { WikiExecutorMode } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { currentWikiExecutorSwitch, wikiExecutorServes } from './wiki-executor-switch';

const sweepLog = new Logger('WikiExecutorSweep');

/**
 * The rollback sweep (contract `jobs.executor.rollback`, design §10): what ends the wiki jobs the
 * server was running for an account the executor switch no longer serves — the switch moved back to
 * `runner`, or the account left the `canary` list.
 *
 * WHY A SWEEP, AND WHY IT RUNS AT APISERVER START. The worker never claims such a row — the claim
 * filters by the switch's owners — so once the switch moves, a job that is still queued, running or
 * waiting has nothing left that will ever settle it, and one kind of it (the `maintain` job) holds
 * its space's maintenance the way an open task does: on 2026-10-08 a rollback to `runner` left the
 * owner's `maintain` job running, and the trigger's `unfinished` answer blocked the runner path's
 * maintenance task for the space. Moving the switch recreates the apiserver and the wiki-worker
 * together (docs/configuration.md), so the apiserver's start is the one moment that always follows
 * a switch: the sweep cancels whatever the server left in flight, and the trigger's own gate
 * (`unfinishedMaintainJob` is asked only when the server executes the account) keeps the runner
 * path clear even before the sweep has run. The worker is not the place for it: it is the process
 * that stops serving the account, not the one that was blocked.
 *
 * HOW EACH ROW IS SETTLED. One job's whole settle — the job, its calls, its repository operations
 * and its run or plan job — is ONE TRANSACTION: a crash between the writes cannot leave the job
 * cancelled while the rows it owns wait for a conclusion that can now never come, and a failure
 * rolls back whole, leaving the job entirely in flight for the next sweep. Every write is
 * predicated on the row still being in flight, so a sweep that runs twice, or that races a worker
 * settling its last write, changes nothing a run already ended. The job itself goes to `cancelled`
 * with its lease and its wait cleared and the reason on
 * its row; the calls it had in the model queue go to `cancelled` with the 0401 constraints' clears
 * (error, error_kind, partial and the lease triple are a queued or running row's, so a cancelled
 * row's are NULL); its repository operations, which a runner would otherwise still take, are
 * cancelled the same way. Then the kind's own rows, none of which may wait for a conclusion that
 * cannot come:
 *
 *   - `maintain`: the run row is ended `failed` / `infra` with the reason — the rollback is the
 *     platform's doing, not the pipeline's, so the failure is not counted against the space's
 *     streak (the streak lives on the cursor row, which the sweep does not touch; the next runner
 *     run re-reads what this one did not take in, because the cursor did not move);
 *   - `plan_draft`, `plan_revise`, `docs_build`: the plan job is ended `failed` with the reason,
 *     still naming its wiki_job — a made or ended plan job must name its maker (0405) — so the
 *     owner's next request is made on the path that runs now;
 *   - `verify`: nothing else is written — an op left `verifying` is waited for by design, and the
 *     next maintenance run of the space adopts it (`reviewModes.verification.adoption.who`), now
 *     the runner path's again;
 *   - `articles`, `import`, `smoke`: nothing else is written — articles and import resume where a
 *     later run or command finds the rows (the import's proposed ops are verified the same way),
 *     and a smoke job is a probe with no rows of its own.
 */

/** What the sweep did: the jobs it cancelled, and the spaces each one is owed a `wiki.changed` for. */
export interface WikiExecutorSweepResult {
  cancelled: number;
  spaces: Array<{ ownerId: string; spaceId: string }>;
}

/** A job row as the sweep reads it. */
interface SweepJob {
  id: string;
  owner_id: string;
  space_id: string;
  kind: string;
  input: unknown;
}

/**
 * Cancel every in-flight wiki job of an account the executor switch no longer serves. Idempotent:
 * every write matches only the rows still in flight, so a second run finds nothing to do. One job's
 * failure does not stop the others: its transaction rolled back whole (nothing it touched is left
 * cancelled), and the next sweep — apiserver start, or a later pass — settles it then. Answers what
 * it cancelled, for the notifications each space is owed.
 */
export async function cancelUnservedWikiJobs(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<WikiExecutorSweepResult> {
  const sw = currentWikiExecutorSwitch();
  // Under `server` the switch serves every account: nothing here can be unserved.
  if (sw.mode === 'server') return { cancelled: 0, spaces: [] };
  const jobs = await prisma.$queryRaw<SweepJob[]>`
    SELECT "id", "owner_id", "space_id", "kind", "input"
      FROM "wiki_job"
     WHERE "state" IN ('queued', 'running', 'waiting')`;
  const result: WikiExecutorSweepResult = { cancelled: 0, spaces: [] };
  const settler = new UnservedJobSettler(prisma);
  for (const job of jobs) {
    if (wikiExecutorServes(sw, job.owner_id)) continue;
    try {
      if (await settler.settle(job, sw.mode, now)) {
        result.cancelled += 1;
        result.spaces.push({ ownerId: job.owner_id, spaceId: job.space_id });
      }
    } catch (error) {
      // One job's settle is owed to no other: a failure here — a database hiccup mid-transaction —
      // leaves this job entirely in flight for the next sweep, and the rest are settled now.
      sweepLog.warn(`the in-flight job ${job.id} was not settled: ${(error as Error).message}`);
    }
  }
  return result;
}

/**
 * The one writer of an unserved job's cancellation: a class only so that its retry is labelled
 * like every other's. ONE TRANSACTION — the job, its calls, its repository operations and its run
 * or plan job settle together or not at all: a crash between the writes cannot leave the job
 * cancelled while the rows it owns wait for a conclusion that can now never come. The predicates
 * are compare-and-sets either way. The job first, inside the transaction: the writes below are
 * owed to a cancellation that matched, so a job a worker settled while the sweep read (no longer
 * in flight) keeps its rows the way its run said.
 */
class UnservedJobSettler {
  private readonly logger = new Logger('WikiExecutorSweep');

  constructor(private readonly prisma: PrismaService) {}

  async settle(job: SweepJob, mode: WikiExecutorMode, now: Date): Promise<boolean> {
    const reason = `the server no longer executes this account's wiki (ORBIT_WIKI_EXECUTOR=${mode}) and the in-flight job was cancelled at apiserver start`;
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const cancelled = await tx.$executeRaw`
          UPDATE "wiki_job"
             SET "state" = 'cancelled', "ended_at" = ${now}, "error" = ${reason}, "waiting_for" = NULL,
                 "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL, "updated_at" = now()
           WHERE "id" = ${job.id}::uuid AND "state" IN ('queued', 'running', 'waiting')`;
        if (cancelled === 0) return false;
        // The model calls it had out, queued or running: cancelled with the clears the 0401 constraints
        // ask of a row that is no longer queued or running — no error, no kind, no partial, no lease —
        // so a replayed job re-issues them from nothing rather than meeting a row it cannot use.
        await tx.$executeRaw`
          UPDATE "wiki_model_request"
             SET "state" = 'cancelled', "ended_at" = ${now}, "error" = NULL, "error_kind" = NULL, "partial" = NULL,
                 "not_before" = NULL, "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL, "updated_at" = now()
           WHERE "job_id" = ${job.id}::uuid AND "state" IN ('queued', 'running')`;
        // Its repository operations, which a runner would otherwise still take: cancelled the same way,
        // the claim and the heartbeat cleared with the state that made them mean something.
        await tx.$executeRaw`
          UPDATE "wiki_repo_op"
             SET "state" = 'cancelled', "ended_at" = ${now}, "error" = ${reason},
                 "lease_owner" = NULL, "claimed_at" = NULL, "heartbeat_at" = NULL, "runner_id" = NULL, "updated_at" = now()
           WHERE "job_id" = ${job.id}::uuid AND "state" IN ('queued', 'running')`;
        const input = (job.input ?? {}) as { runId?: unknown; planJobId?: unknown };
        if (job.kind === 'maintain' && typeof input.runId === 'string') {
          // The run the job executes: failed, and the platform's failure — the rollback, not the pipeline
          // — so the space's streak is not touched and the next run re-reads what this one never took in.
          await tx.$executeRaw`
            UPDATE "wiki_maintenance_run"
               SET "outcome" = 'failed', "failure_kind" = 'infra', "error" = ${reason}, "ended_at" = ${now}, "updated_at" = now()
             WHERE "id" = ${input.runId}::uuid AND "outcome" IS NULL`;
        }
        if ((job.kind === 'plan_draft' || job.kind === 'plan_revise' || job.kind === 'docs_build') && typeof input.planJobId === 'string') {
          // The plan job it runs: ended failed with why, still naming its wiki_job — a made or ended plan
          // job must name its maker (0405) — so the owner's next request is made on the path that runs now.
          await tx.wikiPlanJob.updateMany({
            where: { id: input.planJobId, state: 'made' },
            data: { state: 'ended', outcome: 'failed', endedAt: now, error: reason },
          });
        }
        return true;
      },
      loggedRetry(this.logger, 'wiki.executorSweep'),
    );
  }
}

/**
 * The sweep as the apiserver runs it: one pass at start, the way the scheduled-wakeup worker's
 * first pass is what finds everything that came due while no replica was running. Fire-and-forget,
 * like that first pass: the trigger's gate means a sweep that failed does not block the runner
 * path, and a boot must not wait on a database hiccup.
 */
@Injectable()
export class WikiExecutorSweep implements OnModuleInit {
  private readonly logger = new Logger(WikiExecutorSweep.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.cancelUnserved().catch((error: unknown) => {
      this.logger.warn(`the rollback sweep did not run: ${(error as Error).message}`);
    });
  }

  /** The sweep, and the `wiki.changed` every space it touched is owed. */
  async cancelUnserved(now: Date = new Date()): Promise<WikiExecutorSweepResult> {
    const result = await cancelUnservedWikiJobs(this.prisma, now);
    if (result.cancelled > 0) {
      this.logger.log(`cancelled ${result.cancelled} in-flight wiki job(s) of accounts the executor switch no longer serves`);
    }
    for (const { ownerId, spaceId } of result.spaces) {
      this.realtime?.publishWikiChanged(ownerId, spaceId);
    }
    return result;
  }
}
