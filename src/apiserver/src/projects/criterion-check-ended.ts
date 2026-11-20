import type { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { hasPendingWakeSource } from '../sessions/session-request';
import { refreshProjectDone } from './project-done-request';

/** What a check that never reported is settled with, before the end that stopped it. */
export const CHECK_ENDED_WITHOUT_VERDICT = 'The check ended without a verdict';

/** How much of an end's own words (a runner error, a reap reason) the note keeps. */
const ENDING_LIMIT = 500;

/** A project whose criterion an end just settled, for its DONE to be re-projected after the commit. */
export interface SettledCriterionCheck {
  ownerId: string;
  projectId: string;
}

/**
 * An Agent check whose run is over and never called `criterion_check_report` (migration 0545).
 *
 * The check's PENDING `project_criterion_confirmation` row is what that report would settle, and
 * nothing else does: left alone the criterion reads "Checking…" for good and its attempt never ends.
 * So the doors that end a run settle it themselves, in the transaction that ends the run, as a FAILED
 * attempt naming the end — the same outcome a reported FAIL writes, so the criterion reads
 * CHECK_FAILED, nothing is running, and another check can be started. Called beside
 * `settleUnrunSessionRequests` / `closeUnansweredRequests`, under the ending session's lock:
 *
 *  - runnerApi.turnComplete: the run parked idle with nothing left to wake it (the turn ended without
 *    reporting — the check task's `true` acceptance included), or its turn failed with no retry armed;
 *  - runnerApi.finalize: the runner finalized the run, no retry armed;
 *  - reaper.forceFinalize: the run was reaped (its runner was lost, a cancel was never honored), no
 *    retry armed;
 *  - SessionsService.transitionEndLocked: somebody ended or cancelled the run.
 *
 * A run with a retry armed has not ended, nor has one parked idle that something will still wake:
 * the same session goes on and may still report. A row that already settled (a reported PASS or FAIL) or was withdrawn is never touched: the UPDATE is a
 * compare-and-set on PENDING, so a report racing this end meets it on the row and only one wins.
 */
export async function settleChecksOfEndedRun(
  tx: Prisma.TransactionClient,
  run: { sessionId: string; taskId: string | null },
  ending: string,
  /** The run parked idle rather than ending: it has ended only if nothing will wake it again
   *  (`hasPendingWakeSource` — a job, a watch, a wake-up, an armed retry). */
  parked?: { runningBgJobs: readonly string[]; retryAt: Date | null },
): Promise<SettledCriterionCheck[]> {
  if (!run.taskId) return [];
  const pending = await tx.projectCriterionConfirmation.findMany({
    where: { checkTaskId: run.taskId, confirmerKind: 'AGENT_CHECK', outcome: 'PENDING', withdrawnAt: null },
    select: { id: true },
  });
  if (pending.length === 0) return [];
  if (parked && await hasPendingWakeSource(tx, { id: run.sessionId, ...parked })) return [];
  return tx.projectCriterionConfirmation.updateManyAndReturn({
    where: { id: { in: pending.map((row) => row.id) }, outcome: 'PENDING', withdrawnAt: null },
    data: {
      outcome: 'FAILED',
      sessionId: run.sessionId,
      note: `${CHECK_ENDED_WITHOUT_VERDICT}: ${ending.trim().slice(0, ENDING_LIMIT)}.`,
      settledAt: new Date(),
    },
    select: { ownerId: true, projectId: true },
  });
}

/**
 * The post-commit edge of the settlement above, as `ProjectCriterionConfirmationService` ends every
 * write: a failed attempt can take a project's DONE away. Never raises: the settlement has committed.
 */
export async function reprojectAfterSettledChecks(
  prisma: PrismaService,
  settled: readonly SettledCriterionCheck[] | undefined,
  logger: Pick<Logger, 'warn'>,
): Promise<void> {
  for (const { ownerId, projectId } of new Map((settled ?? []).map((s) => [s.projectId, s])).values()) {
    await refreshProjectDone(prisma, ownerId, projectId).catch((error) => logger.warn(
      `project ${projectId} done not re-projected after an Agent check ended: ${
        error instanceof Error ? error.message : error}`));
  }
}
