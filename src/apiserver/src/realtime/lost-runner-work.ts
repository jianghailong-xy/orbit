import type { Prisma } from '@prisma/client';
import { RunEventType } from '@orbit/shared';

import { isHeld } from '../common/session-release';
import { isSessionExecuting } from '../common/session-working';
import {
  BACKGROUND_WAKE_TURN_PREFIX,
  type BackgroundWakeDto,
  fileBackgroundJobWake,
  sessionHasEnded,
  undeliveredWakeTurn,
} from '../runner-api/background-job-wake';
import { interruptOrphanedSubagentRuns, interruptOrphanedWorkflowRuns } from '../runner-api/subagent-wake';
import { RUNNER_BEATS, type RunnerBeats } from '../runners/runner-presence';
import { CLEARED_RUNNING_WORK } from '../sessions/running-work';
import { sessionTurnStateSql, turnStateOf, type TurnState } from '../sessions/session-turn-state';
import { SessionNotSendable, type SessionsService } from '../sessions/sessions.service';

/**
 * What the reaper does with an idle-looking session whose runner it has judged lost while something was still executing
 * in it (plan step 1.7; docs/session-three-state-design.md §11.3 item 4).
 *
 * A turn in flight is a dispatched turn, and losing its runner fails the session (the reaper's sweep). Any other held
 * session holds no slot and stays resumable, so the reaper left it alone — and with it whatever its sets said was
 * executing on the lost machine: an engine turn the engine started itself, a SubAgent, a runner-hosted job. A runner that
 * comes back clears those at its takeover; one that never comes back left them set for good, and the session's task
 * read as running (`TURN` or `BACKGROUND_JOB`) with nothing left to end it or wake it.
 *
 * So once the reaper has judged the runner lost — behind every hold it keeps on that judgement — such a session:
 *   - has its running-work sets emptied and its engine turn cleared (CLEARED_RUNNING_WORK), and stays where it is:
 *     nothing it was asked to do failed, so it is not failed, and a session with nothing executing is not touched at all;
 *   - has its SubAgent and workflow runs still RUNNING on that runner ended INTERRUPTED owing their wake, as a takeover
 *     ends them (subagent-wake.ts), filed after the commit and by the wake sweep if that filing fails;
 *   - is woken for each runner-hosted job it had, with the exit wake a job killed under it would have sent: the job's
 *     end will never be reported, and the agent that waited for it is told so instead of waiting for good.
 *
 * The job's wake goes on a key of its own (`<jobId>:lost`), not the `<jobId>:exit` the runner would send: a runner that
 * does come back with the job still running reports its real exit later, and that wake must not be taken for this one.
 */

/** Why a job is reported ended in the wake a lost runner owes: the runner hosting it went offline and did not return. */
export const RUNNER_OFFLINE_JOB_REASON = 'runner_offline';

/** What a SubAgent run the reaper ends this way says. */
export const RUNNER_OFFLINE_SUBAGENT_RESULT =
  'The SubAgent was interrupted: the runner hosting it went offline and did not come back before it reported an end. ' +
  'What it changed so far is in that machine\'s working tree, uncommitted.';

/** What a workflow the reaper ends this way says. */
export const RUNNER_OFFLINE_WORKFLOW_ERROR =
  'The workflow was interrupted: the runner hosting it went offline and did not come back before it reported an end.';

/** One runner-hosted job the session was told is running, as its last `running` report described it. */
export interface LostJob {
  jobId: string;
  kind: string;
  command: string;
  outputPath: string;
}

/** What one settle found and changed, for the caller to act on once it has committed. */
export interface LostRunnerWork {
  ownerId: string;
  jobs: LostJob[];
  subagentRuns: string[];
  workflowRuns: string[];
}

interface LockedRow {
  ownerId: string;
  turnState: TurnState | null;
  finishedAt: Date | null;
  assignedRunnerId: string | null;
  cancelRequestedAt: Date | null;
  runClaimedAt: Date | null;
  engineTurnActive: boolean;
  runningSubagents: string[];
  runningBgJobs: string[];
}

/**
 * Settles one session as the module comment says, inside the caller's transaction; null when there is nothing to settle
 * by the time the row is locked: the runner was heard from again, or claimed the session, since the sweep looked; the
 * session moved to another runner, began a dispatched turn, ended, was asked to cancel, or has nothing executing.
 * `claimedBefore` is the line a claim must be older than to be the lost runner's (the reaper's reap window), and
 * `looksOffline` the reaper's own verdict on a runner row, re-asked here as forceFinalize re-asks it.
 */
/**
 * What the reaper reads of a runner to say whether it is lost (ReaperService `runnerLooksOffline`): its status, both
 * records of its heartbeat, and whether it is a managed runner, whose OFFLINE its manager writes on a proven stop and
 * is no sign-off.
 */
export const RUNNER_LIVENESS = { status: true, ...RUNNER_BEATS, managedRunner: { select: { id: true } } } as const;

export type RunnerLiveness = RunnerBeats & { status: string; managedRunner?: { id: string } | null };

export async function settleLostRunnerWork(
  tx: Prisma.TransactionClient,
  sessionId: string,
  runnerId: string,
  claimedBefore: Date,
  looksOffline: (runner: RunnerLiveness | null) => boolean,
): Promise<LostRunnerWork | null> {
  // The verdict came from the sweep's one snapshot; re-asked here.
  const runner = await tx.runner.findUnique({ where: { id: runnerId }, select: RUNNER_LIVENESS });
  if (!looksOffline(runner)) return null;
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT "owner_id" AS "ownerId",
           ${sessionTurnStateSql('"session"')} AS "turnState", "finished_at" AS "finishedAt",
           "assigned_runner_id" AS "assignedRunnerId",
           "cancel_requested_at" AS "cancelRequestedAt", "run_claimed_at" AS "runClaimedAt",
           "engine_turn_active" AS "engineTurnActive", "running_subagents" AS "runningSubagents",
           "running_bg_jobs" AS "runningBgJobs"
      FROM "session"
     WHERE "id" = ${sessionId}::uuid
     FOR UPDATE`;
  const row = rows[0];
  if (
    !row ||
    row.assignedRunnerId !== runnerId ||
    !isHeld(row) ||
    turnStateOf(row) === 'IN_FLIGHT' ||
    row.cancelRequestedAt !== null ||
    (row.runClaimedAt !== null && row.runClaimedAt >= claimedBefore) ||
    !isSessionExecuting(row)
  ) {
    return null;
  }
  const jobs = await lostJobs(tx, sessionId, row.runningBgJobs);
  await tx.session.update({
    where: { id: sessionId },
    data: { ...CLEARED_RUNNING_WORK, engineTurnActive: false },
    select: { id: true },
  });
  const subagentRuns = await interruptOrphanedSubagentRuns(tx, sessionId, RUNNER_OFFLINE_SUBAGENT_RESULT);
  const workflowRuns = await interruptOrphanedWorkflowRuns(tx, sessionId, RUNNER_OFFLINE_WORKFLOW_ERROR);
  return { ownerId: row.ownerId, jobs, subagentRuns, workflowRuns };
}

/** The jobs `jobIds` as the session's newest `background_task` report of each describes them; a job never described is named alone. */
async function lostJobs(tx: Prisma.TransactionClient, sessionId: string, jobIds: readonly string[]): Promise<LostJob[]> {
  if (jobIds.length === 0) return [];
  const reports = await tx.$queryRaw<Array<{ jobId: string; payload: Record<string, unknown> | null }>>`
    SELECT DISTINCT ON (e."payload"->>'toolUseId') e."payload"->>'toolUseId' AS "jobId", e."payload"
      FROM "run_event" e
     WHERE e."session_id" = ${sessionId}::uuid
       AND e."type" = ${RunEventType.BACKGROUND_TASK}
       AND e."payload"->>'toolUseId' = ANY(${[...jobIds]}::text[])
     ORDER BY e."payload"->>'toolUseId', e."seq" DESC`;
  const byId = new Map(reports.map((r) => [r.jobId, r.payload ?? {}]));
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return jobIds.map((jobId) => {
    const payload = byId.get(jobId) ?? {};
    return { jobId, kind: text(payload.kind) || 'job', command: text(payload.command), outputPath: text(payload.outputPath) };
  });
}

/** The wake a lost job owes its session: its exit, killed because its runner went offline. */
export function lostJobWake(job: LostJob): BackgroundWakeDto {
  return {
    wakeId: `${job.jobId}:lost`,
    jobId: job.jobId,
    trigger: 'exit',
    kind: job.kind,
    command: job.command,
    status: 'killed',
    reason: RUNNER_OFFLINE_JOB_REASON,
    outputPath: job.outputPath,
    outputOffset: 0,
    outputSize: 0,
    outputExcerpt: '',
  } as BackgroundWakeDto;
}

/**
 * Files a lost job's wake as a turn of its session, as the runner's own exit wake is filed (runnerApi.backgroundWake):
 * onto the wake turn nobody has been handed yet, or as a new one. Never steered: no turn is running on a lost runner.
 * Nothing for a session that has ended since.
 */
export async function fileLostJobWake(
  sessions: Pick<SessionsService, 'createTurn'>,
  ownerId: string,
  sessionId: string,
  job: LostJob,
): Promise<'FILED' | 'DROPPED'> {
  const wake = lostJobWake(job);
  const clientTurnId = `${BACKGROUND_WAKE_TURN_PREFIX}${wake.wakeId}`;
  try {
    await sessions.createTurn(ownerId, sessionId, { clientTurnId, content: '', intent: 'NEXT_TURN' }, {
      coalesce: async (tx, session, route) => {
        if (sessionHasEnded(session)) throw new SessionNotSendable('the session has ended');
        const queued = await undeliveredWakeTurn(tx, sessionId, route);
        await fileBackgroundJobWake(tx, sessionId, queued?.clientTurnId ?? clientTurnId, wake);
        return queued;
      },
    });
    return 'FILED';
  } catch (error) {
    if (error instanceof SessionNotSendable) return 'DROPPED';
    throw error;
  }
}
