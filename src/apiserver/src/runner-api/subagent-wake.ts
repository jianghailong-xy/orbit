import { NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import { SessionNotSendable, type SessionsService } from '../sessions/sessions.service';
import {
  BACKGROUND_WAKE_TURN_PREFIX,
  type BackgroundWakeDto,
  fileBackgroundJobWake,
  sessionHasEnded,
  SUBAGENT_WAKE_KIND,
  takeJobOffNextTurnQueue,
  undeliveredWakeTurn,
} from './background-job-wake';

/**
 * The wake a SubAgent run's end owes its parent session (docs/subagent-design.md §2, §5.2), held by the server.
 *
 * The runner used to send it, through the same background-wake door a bg_run job wakes its session through, and
 * a runner that restarted between the run's start and its end took that intent with it. Now the intent is a
 * column of the run (`subagent_run.wake_owed`): set when the run opens in the background, or when the
 * foreground call that waited for it stops waiting (the runner's `RUNNING` report with `wake: true`), or when
 * the run ends INTERRUPTED. The wake is filed here when the run ends — on the runner's report, or, for a run
 * its runner left RUNNING, when the next runner process takes the session over (`interruptOrphanedSubagentRuns`)
 * — and a sweep files any whose filing failed. `wake_filed_at` is set in the transaction that files it, as a
 * compare-and-set, so one end wakes the parent once however many of those reach it.
 *
 * The wake is kept beside its turn as a background job's is (`background_job_wake`, kind `subagent`), and is
 * delivered in its own block, `<orbit-subagent-finished>` (`buildSubagentFinishedBlock`), never in bg_run's.
 */

/** How much of a run's result its wake quotes. */
export const SUBAGENT_WAKE_RESULT_CAP = 6_000;

/** The reason on a run the runner's stop interrupted, as a killed bg_run job's is named. */
export const SUBAGENT_RUNNER_STOPPED_REASON = 'runner_shutdown';

/** What a run its runner left RUNNING says, once the next runner process has taken its session over. */
export const ORPHANED_SUBAGENT_RESULT =
  'The SubAgent was interrupted: the runner process hosting it stopped (a restart, an update or a crash) before ' +
  'it reported an end. What it changed so far is in the working tree, uncommitted.';

/** The wake was filed (or dropped) by another path first. Thrown from the coalesce hook so nothing is written. */
class SubagentWakeSettled extends Error {}

export type SubagentWakeOutcome = 'FILED' | 'DROPPED' | 'SETTLED_ELSEWHERE' | 'NOT_OWED';

type WakeRow = {
  id: string;
  ownerId: string;
  sessionId: string;
  status: string;
  description: string | null;
  resultSummary: string | null;
  wakeOwed: boolean;
  wakeFiledAt: Date | null;
};

/** The wake as the background-wake store keeps it. */
function wakeOf(row: WakeRow): BackgroundWakeDto {
  const runId = uuidToBase62(row.id);
  const result = (row.resultSummary ?? '').replace(/\0/g, '');
  const excerpt = result.length > SUBAGENT_WAKE_RESULT_CAP ? `${result.slice(0, SUBAGENT_WAKE_RESULT_CAP)}…` : result;
  return {
    wakeId: `${runId}:exit`,
    jobId: runId,
    trigger: 'exit',
    kind: SUBAGENT_WAKE_KIND,
    command: row.description ?? '',
    description: row.description ?? undefined,
    status: row.status,
    reason: row.status === 'INTERRUPTED' ? SUBAGENT_RUNNER_STOPPED_REASON : undefined,
    outputPath: '',
    outputOffset: 0,
    outputSize: result.length,
    outputExcerpt: excerpt,
  } as BackgroundWakeDto;
}

/**
 * File the wake a run's end owes its parent, if it owes one that is not filed yet: as a turn of the parent, onto
 * its wake turn nobody has been handed yet, or written into the turn it is running when it can take a steer. A
 * parent that has ended is not woken, and the wake is settled as dropped. Throws only on a failure the sweep is
 * to try again.
 */
export async function fileSubagentWake(
  prisma: PrismaClient,
  sessions: Pick<SessionsService, 'createTurn'>,
  runId: string,
): Promise<SubagentWakeOutcome> {
  const row = await prisma.subagentRun.findUnique({
    where: { id: runId },
    select: {
      id: true, ownerId: true, sessionId: true, status: true, description: true, resultSummary: true,
      wakeOwed: true, wakeFiledAt: true,
    },
  });
  if (!row || !row.wakeOwed || row.wakeFiledAt || row.status === 'RUNNING') return 'NOT_OWED';
  const wake = wakeOf(row);
  const clientTurnId = `${BACKGROUND_WAKE_TURN_PREFIX}${wake.wakeId}`;
  try {
    await sessions.createTurn(
      row.ownerId,
      row.sessionId,
      { clientTurnId, content: '', intent: 'NEXT_TURN' },
      {
        steerIfLive: true,
        coalesce: async (tx, session, route) => {
          if (sessionHasEnded(session)) throw new SessionNotSendable('the session has ended');
          if (!(await markSubagentWakeFiled(tx, row.id))) throw new SubagentWakeSettled();
          const queued = await undeliveredWakeTurn(tx, row.sessionId, route);
          const filedOn = queued?.clientTurnId ?? clientTurnId;
          await fileBackgroundJobWake(tx, row.sessionId, filedOn, wake);
          if (route.kind === 'steer') await takeJobOffNextTurnQueue(tx, row.sessionId, filedOn, wake.jobId);
          return queued;
        },
      },
    );
    return 'FILED';
  } catch (error) {
    if (error instanceof SubagentWakeSettled) return 'SETTLED_ELSEWHERE';
    if (error instanceof SessionNotSendable || error instanceof NotFoundException) {
      // Nobody to wake: settled, so the sweep does not come back to it.
      return (await dropSubagentWake(prisma, row.id)) ? 'DROPPED' : 'SETTLED_ELSEWHERE';
    }
    throw error;
  }
}

/** Mark a run's wake filed, inside the transaction filing it, if nothing has yet. */
async function markSubagentWakeFiled(tx: Prisma.TransactionClient, runId: string): Promise<boolean> {
  const settled = await tx.subagentRun.updateMany({
    where: { id: runId, wakeOwed: true, wakeFiledAt: null },
    data: { wakeFiledAt: new Date() },
  });
  return settled.count === 1;
}

/** Settle a wake nobody is left to receive (the parent ended), if nothing has yet. */
async function dropSubagentWake(prisma: PrismaClient, runId: string): Promise<boolean> {
  const settled = await prisma.subagentRun.updateMany({
    where: { id: runId, wakeOwed: true, wakeFiledAt: null },
    data: { wakeFiledAt: new Date() },
  });
  return settled.count === 1;
}

/**
 * End every run of the session its runner left RUNNING, as INTERRUPTED, owing the parent a wake. Called when a
 * different runner process takes the session over: the process that hosted those runs is gone, and their child
 * engines with it, so none of them will report an end. Returns the run ids, whose wakes the caller files once
 * this transaction has committed. A remote run is left alone: its target runner hosts it, not the process replaced.
 */
export async function interruptOrphanedSubagentRuns(tx: Prisma.TransactionClient, sessionId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "subagent_run"
    SET "status" = 'INTERRUPTED',
        "result_summary" = ${ORPHANED_SUBAGENT_RESULT},
        "ended_at" = now(),
        "wake_owed" = true
    WHERE "session_id" = ${sessionId}::uuid AND "status" = 'RUNNING'
      -- A remote run (docs/subagent-design.md §10) lives on its target runner, which a takeover of the parent leaves running.
      AND "target_runner_id" IS NULL
    RETURNING "id"
  `;
  return rows.map((row) => row.id);
}

/** Ended runs whose owed wake is still to be filed, oldest first: what the sweep files. */
export async function unfiledSubagentWakes(prisma: PrismaClient, limit: number): Promise<string[]> {
  const rows = await prisma.subagentRun.findMany({
    where: { wakeOwed: true, wakeFiledAt: null, status: { not: 'RUNNING' } },
    orderBy: { endedAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
