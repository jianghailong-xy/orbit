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
  WORKFLOW_WAKE_KIND,
  takeJobOffNextTurnQueue,
  undeliveredWakeTurn,
} from './background-job-wake';
import { forwardedDescription, handoffSuccessorOf } from './handoff-wake-forward';

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

type WakeIdentity = {
  id: string;
  ownerId: string;
  sessionId: string;
  status: string;
  description: string | null;
  wakeOwed: boolean;
  wakeFiledAt: Date | null;
};

/** The wake as the background-wake store keeps it. */
function wakeOf(row: WakeIdentity & { resultSummary: string | null }): BackgroundWakeDto {
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
 * parent that ended by a COMPLETED coordinator handoff has the wake forwarded to its last successor; a parent that
 * ended any other way is not woken, and the wake is settled as dropped. Throws only on a failure the sweep is to
 * try again (a handoff still in flight included).
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
  return fileRunWake(prisma, sessions, row, wakeOf(row), 'a SubAgent run',
    (tx) => markSubagentWakeFiled(tx, row.id), () => dropSubagentWake(prisma, row.id));
}

export async function fileWorkflowWake(
  prisma: PrismaClient,
  sessions: Pick<SessionsService, 'createTurn'>,
  runId: string,
): Promise<SubagentWakeOutcome> {
  const row = await prisma.subagentWorkflowRun.findUnique({
    where: { id: runId },
    select: {
      id: true, ownerId: true, sessionId: true, status: true, name: true, description: true,
      result: true, error: true, callsDone: true, callsFailed: true, costUsd: true,
      wakeOwed: true, wakeFiledAt: true,
    },
  });
  if (!row || !row.wakeOwed || row.wakeFiledAt || row.status === 'RUNNING') return 'NOT_OWED';
  const jobId = uuidToBase62(row.id);
  const result = [
    ...(row.error ? [`Error: ${row.error}`] : []),
    ...(row.result ? [`Result: ${row.result}`] : []),
  ].join('\n');
  const excerpt = result.length > SUBAGENT_WAKE_RESULT_CAP ? `${result.slice(0, SUBAGENT_WAKE_RESULT_CAP)}…` : result;
  // Keep the summary with the wake so it survives turn coalescing and forwarding to another session.
  const stats = `Calls done: ${row.callsDone}, failed: ${row.callsFailed}. Cost: $${row.costUsd.toFixed(2)}.`;
  const wake: BackgroundWakeDto = {
    wakeId: `${jobId}:exit`,
    jobId,
    trigger: 'exit',
    kind: WORKFLOW_WAKE_KIND,
    command: row.name,
    description: row.description ?? undefined,
    status: row.status,
    outputPath: '',
    outputOffset: 0,
    outputSize: result.length,
    outputExcerpt: excerpt ? `${stats}\n${excerpt}` : stats,
  };
  return fileRunWake(prisma, sessions, row, wake, 'a workflow',
    (tx) => markWorkflowWakeFiled(tx, row.id), () => markWorkflowWakeFiled(prisma, row.id));
}

async function fileRunWake(
  prisma: PrismaClient,
  sessions: Pick<SessionsService, 'createTurn'>,
  row: WakeIdentity,
  wake: BackgroundWakeDto,
  subject: string,
  markFiled: (tx: Prisma.TransactionClient) => Promise<boolean>,
  drop: () => Promise<boolean>,
): Promise<SubagentWakeOutcome> {
  try {
    await fileWakeOn(sessions, row, row.sessionId, wake, markFiled);
    return 'FILED';
  } catch (error) {
    if (error instanceof SubagentWakeSettled) return 'SETTLED_ELSEWHERE';
    if (!(error instanceof SessionNotSendable || error instanceof NotFoundException)) throw error;
  }
  // The parent has ended. One that ended by a COMPLETED coordinator handoff forwards the wake to its last
  // successor, naming that the previous coordinator started it (docs/coordinator-handoff-v2-design.md §1); a
  // handoff still HANDING_OVER throws HandoffInFlight, which the sweep files again.
  const successor = await handoffSuccessorOf(prisma, row.sessionId);
  if (successor) {
    try {
      await fileWakeOn(sessions, row, successor, {
        ...wake,
        description: forwardedDescription(row.description, subject),
      }, markFiled);
      return 'FILED';
    } catch (error) {
      if (error instanceof SubagentWakeSettled) return 'SETTLED_ELSEWHERE';
      if (!(error instanceof SessionNotSendable || error instanceof NotFoundException)) throw error;
    }
  }
  // Nobody to wake: settled, so the sweep does not come back to it.
  return (await drop()) ? 'DROPPED' : 'SETTLED_ELSEWHERE';
}

/** File the run's wake as a turn of `sessionId`: the parent, or the successor a handoff forwards it to. */
async function fileWakeOn(
  sessions: Pick<SessionsService, 'createTurn'>,
  row: WakeIdentity,
  sessionId: string,
  wake: BackgroundWakeDto,
  markFiled: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<void> {
  const clientTurnId = `${BACKGROUND_WAKE_TURN_PREFIX}${wake.wakeId}`;
  await sessions.createTurn(
    row.ownerId,
    sessionId,
    { clientTurnId, content: '', intent: 'NEXT_TURN' },
    {
      steerIfLive: true,
      coalesce: async (tx, session, route) => {
        if (sessionHasEnded(session)) throw new SessionNotSendable('the session has ended');
        if (!(await markFiled(tx))) throw new SubagentWakeSettled();
        const queued = await undeliveredWakeTurn(tx, sessionId, route);
        const filedOn = queued?.clientTurnId ?? clientTurnId;
        await fileBackgroundJobWake(tx, sessionId, filedOn, wake);
        if (route.kind === 'steer') await takeJobOffNextTurnQueue(tx, sessionId, filedOn, wake.jobId);
        return queued;
      },
    },
  );
}

/** Mark a run's wake filed, inside the transaction filing it, if nothing has yet. */
async function markSubagentWakeFiled(tx: Prisma.TransactionClient, runId: string): Promise<boolean> {
  const settled = await tx.subagentRun.updateMany({
    where: { id: runId, wakeOwed: true, wakeFiledAt: null },
    data: { wakeFiledAt: new Date() },
  });
  return settled.count === 1;
}

/** Settle a workflow wake in its turn's transaction, or on its own when the wake is dropped. */
async function markWorkflowWakeFiled(db: Prisma.TransactionClient, runId: string): Promise<boolean> {
  const settled = await db.subagentWorkflowRun.updateMany({
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
 * End every run of the sessions their runner left RUNNING as INTERRUPTED. A workflow owns its calls' wake. Called when a
 * different runner process takes a session over, singly or in a batch, and when the reaper finds the runner hosting an
 * idle-looking session lost: the process that hosted those runs is gone, and their child engines with it, so none of
 * them will report an end. Returns the run ids so the caller can file any owed wakes once this transaction has
 * committed. A remote run is left alone: its target runner hosts it, not the process replaced.
 */
export async function interruptOrphanedSubagentRuns(
  tx: Prisma.TransactionClient,
  sessionIds: string | readonly string[],
  result: string = ORPHANED_SUBAGENT_RESULT,
): Promise<string[]> {
  const ids = typeof sessionIds === 'string' ? [sessionIds] : [...sessionIds];
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "subagent_run"
    SET "status" = 'INTERRUPTED',
        "result_summary" = ${result},
        "ended_at" = now(),
        "wake_owed" = ("workflow_run_id" IS NULL)
    WHERE "session_id" = ANY(${ids}::uuid[]) AND "status" = 'RUNNING'
      -- A remote run (docs/subagent-design.md §10) lives on its target runner, which a takeover of the parent leaves running.
      AND "target_runner_id" IS NULL
    RETURNING "id"
  `;
  return rows.map((row) => row.id);
}

/** What a workflow its runner left RUNNING says, once the next runner process has taken its session over. */
export const ORPHANED_WORKFLOW_ERROR =
  'The workflow was interrupted: the runner process hosting it stopped (a restart, an update or a crash) before ' +
  'it reported an end.';

/** Interrupt workflows left running by the previous process and keep their completion wakes owed. */
export async function interruptOrphanedWorkflowRuns(
  tx: Prisma.TransactionClient,
  sessionIds: string | readonly string[],
  error: string = ORPHANED_WORKFLOW_ERROR,
): Promise<string[]> {
  const ids = typeof sessionIds === 'string' ? [sessionIds] : [...sessionIds];
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "subagent_workflow_run"
    SET "status" = 'INTERRUPTED', "ended_at" = now(), "wake_owed" = true, "error" = ${error}
    WHERE "session_id" = ANY(${ids}::uuid[]) AND "status" = 'RUNNING'
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

/** Ended workflows whose owed wake is still to be filed, oldest first. */
export async function unfiledWorkflowWakes(prisma: PrismaClient, limit: number): Promise<string[]> {
  const rows = await prisma.subagentWorkflowRun.findMany({
    where: { wakeOwed: true, wakeFiledAt: null, status: { not: 'RUNNING' } },
    orderBy: { endedAt: 'asc' },
    take: limit,
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
