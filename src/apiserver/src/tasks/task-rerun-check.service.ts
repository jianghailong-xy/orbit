import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { RunEventType, uuidToBase62 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RUNNER_BEATS, runnerIsOnline } from '../runners/runner-presence';
import { SessionsService } from '../sessions/sessions.service';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from './executable-acceptance-round';

/**
 * Re-run the check (docs/task-run-sidebar-design.md, D3 = A): a FAILED task whose criterion is EXECUTABLE runs its
 * acceptance command again in its latest run session, on the branch as it is now, and no agent turn starts.
 *
 * The round is the same round an answered message turn queues (runner-api.controller.ts, `taskAcceptanceClientTurnId`):
 * one reserved shell turn whose client id carries the expected exit code, settled by the same comparison at
 * /turn-complete, and recorded as a `task_acceptance_round` there. What this door adds is the way in: the task moves
 * FAILED → IN_PROGRESS — the pending status a retry of a FAILED run takes, which the comparison accepts and the auto-run
 * sweep, reading OPEN only, does not dispatch — in the transaction that writes the turn, so neither lands without the
 * other.
 */

/** The typed refusals, each with its English sentence for whoever pressed the button. */
export const RERUN_CHECK_REFUSALS = {
  TASK_NOT_FAILED: 'RERUN_CHECK_TASK_NOT_FAILED',
  NOT_EXECUTABLE: 'RERUN_CHECK_NOT_EXECUTABLE',
  NO_RUN_SESSION: 'RERUN_CHECK_NO_RUN_SESSION',
  RUNNER_OFFLINE: 'RERUN_CHECK_RUNNER_OFFLINE',
} as const;

export type RerunCheckRefusalCode = (typeof RERUN_CHECK_REFUSALS)[keyof typeof RERUN_CHECK_REFUSALS];

function refusal(code: RerunCheckRefusalCode, message: string, taskId: string, sessionId?: string): ConflictException {
  return new ConflictException({
    code,
    message,
    taskId: uuidToBase62(taskId),
    ...(sessionId ? { sessionId: uuidToBase62(sessionId) } : {}),
  });
}

/**
 * The reserved client id of the round one press queues.
 *
 * Derived by the server from what the press is about, never minted per request: the newest round the task has recorded
 * (or, before it has any, the run itself), and the code the declaration expects. A second press, or a retry after a
 * lost response, therefore names the same key in the same session, and the turn's unique (session, client id) is what
 * keeps it to one. Once that round settles it is the newest round, so the next press after it names a new key.
 */
export function rerunCheckClientTurnId(anchorId: string, expectedExitCode: number): string {
  return `${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}rerun:${anchorId}:${expectedExitCode}`;
}

/**
 * FAILED → IN_PROGRESS, as one compare-and-set on the declaration the round was queued for. Called through `resume`'s
 * `onTurnWritten` hook, in the transaction that writes the round's turn: the task leaves FAILED only beside its round,
 * and a status moved or a declaration edited since the door read them refuses the press whole, the turn with it.
 */
export async function moveFailedTaskToPending(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
  command: string,
  expectedExitCode: number,
): Promise<void> {
  const moved = await tx.task.updateMany({
    where: {
      id: taskId,
      ownerId,
      status: TaskStatus.FAILED,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: command,
      acceptanceExpectedExitCode: expectedExitCode,
    },
    data: { status: TaskStatus.IN_PROGRESS },
  });
  if (moved.count === 0) {
    throw refusal(
      RERUN_CHECK_REFUSALS.TASK_NOT_FAILED,
      'This task changed while the check was being queued, so nothing was queued. Reload it and try again.',
      taskId,
    );
  }
}

export interface RerunCheckReceipt {
  taskId: string;
  sessionId: string;
  turnId: string;
  /** True when this press found the round an earlier press already queued, and queued nothing. */
  replayed: boolean;
}

@Injectable()
export class TaskRerunCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly realtime: RealtimeService,
  ) {}

  async rerun(ownerId: string, taskId: string): Promise<RerunCheckReceipt> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: {
        id: true,
        status: true,
        completionCriterion: true,
        acceptanceCommand: true,
        acceptanceExpectedExitCode: true,
      },
    });
    if (!task) throw new NotFoundException('task not found');
    // The task's latest run: the newest engine session that ran it and is not in the Trash.
    const run = await this.prisma.session.findFirst({
      where: { taskId, ownerId, deletedAt: null, sessionKind: 'CONVERSATION' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        assignedRunner: { select: { status: true, ...RUNNER_BEATS } },
        workspace: { select: { runner: { select: { status: true, ...RUNNER_BEATS } } } },
      },
    });
    const expected = task.acceptanceExpectedExitCode;
    const key = run && expected != null ? await this.clientTurnIdFor(task.id, run.id, expected) : null;
    // A press already answered: its round is the receipt, whatever the task has become since.
    if (run && key) {
      const queued = await this.prisma.conversationTurn.findUnique({
        where: { sessionId_clientTurnId: { sessionId: run.id, clientTurnId: key } },
        select: { id: true },
      });
      if (queued) return { taskId: task.id, sessionId: run.id, turnId: queued.id, replayed: true };
    }
    if (task.status !== TaskStatus.FAILED) {
      throw refusal(
        RERUN_CHECK_REFUSALS.TASK_NOT_FAILED,
        `Re-run the check is only for a failed task. This task is ${task.status.toLowerCase().replace('_', ' ')}.`,
        task.id,
      );
    }
    if (task.completionCriterion !== 'EXECUTABLE' || task.acceptanceCommand == null || expected == null) {
      throw refusal(
        RERUN_CHECK_REFUSALS.NOT_EXECUTABLE,
        'This task is not settled by an acceptance command, so there is no check to re-run.',
        task.id,
      );
    }
    if (!run || !key) {
      throw refusal(
        RERUN_CHECK_REFUSALS.NO_RUN_SESSION,
        'This task has no run to re-run the check in. Retry the task instead.',
        task.id,
      );
    }
    if (!runnerIsOnline(run.assignedRunner ?? run.workspace?.runner)) {
      throw refusal(
        RERUN_CHECK_REFUSALS.RUNNER_OFFLINE,
        'No runner is online for this task\'s workspace, so the check cannot run now. Bring the runner online and try again.',
        task.id,
        run.id,
      );
    }
    const command = task.acceptanceCommand;
    const answer = await this.sessions.resume(
      ownerId,
      run.id,
      { clientTurnId: key, kind: 'shell', content: command },
      {
        // In the transaction that writes the turn, under the session's lock: the task leaves FAILED only beside its
        // round, and a declaration edited or a status moved since the reads above refuses the press whole.
        onTurnWritten: (tx) => moveFailedTaskToPending(tx, ownerId, task.id, command, expected),
      },
    );
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [task.id], resync: false });
    return { taskId: task.id, sessionId: run.id, turnId: answer.turnId, replayed: false };
  }

  private async clientTurnIdFor(taskId: string, sessionId: string, expectedExitCode: number): Promise<string> {
    const newest = await this.prisma.taskAcceptanceRound.findFirst({
      where: { taskId },
      orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return rerunCheckClientTurnId(newest?.id ?? sessionId, expectedExitCode);
  }
}
