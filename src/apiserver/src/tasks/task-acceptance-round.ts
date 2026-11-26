import type { Prisma, PrismaClient } from '@prisma/client';
import type { TaskAcceptanceRound } from '@orbit/shared';

import { clipCheckTail } from '../runner-api/check-output-redaction';
import { storableBranchSha } from './owner-confirmation-review';

/**
 * The record one EXECUTABLE acceptance round leaves (migration 1672, docs/task-run-sidebar-design.md, "Data that does
 * not exist yet"): what the runner's `/turn-complete` reported for a server-queued acceptance shell turn.
 *
 * Written beside the exit-code comparison, never inside it: that block stays one status write and no other database
 * touch (executable-exit-code-judgment.spec.ts, by the account owner's direction). This row is a record of what ran,
 * for a reader — the task's run column — and nothing derives a status, an attempt or a judgment from it. What an exit
 * code means is still `deriveTaskCompletionStatus`.
 */

/** INTEGER's range. A code outside it is not one the runner can have meant, and is kept as "none reported". */
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export interface TaskAcceptanceRoundInput {
  ownerId: string;
  taskId: string;
  sessionId: string;
  turnId: string;
  /** The code the turn was queued to expect, as its client_turn_id carries it. */
  expectedExitCode: number;
  /** As the completion reported them: unvalidated. */
  shellExitCode: unknown;
  shellOutput: unknown;
  branchSha: unknown;
}

/** The round as its row stores it: the exit code or null, a SHA or null, and the clipped, redacted tail. */
export function taskAcceptanceRoundRow(input: TaskAcceptanceRoundInput) {
  const code = input.shellExitCode;
  return {
    ownerId: input.ownerId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    exitCode: Number.isInteger(code) && (code as number) >= INT4_MIN && (code as number) <= INT4_MAX
      ? (code as number)
      : null,
    expectedExitCode: input.expectedExitCode,
    branchSha: storableBranchSha(input.branchSha) ?? null,
    // The same rule an integration check's outputTail is held to: redacted, then cut to its last 16 KB.
    outputTail: typeof input.shellOutput === 'string' ? clipCheckTail(input.shellOutput) : '',
  };
}

/**
 * One row for the round, in the transaction of the completion's first ACK, so a retried completion — which the ACK
 * absorbs before this is reached — writes none, and a rolled-back one leaves none. `turn_id` is unique besides.
 */
export async function recordTaskAcceptanceRound(
  tx: Prisma.TransactionClient,
  input: TaskAcceptanceRoundInput,
): Promise<void> {
  await tx.taskAcceptanceRound.create({ data: taskAcceptanceRoundRow(input), select: { id: true } });
}

/** Every round of a task, by run session, newest first within each run. */
export async function readTaskAcceptanceRounds(
  prisma: Pick<PrismaClient, 'taskAcceptanceRound'>,
  ownerId: string,
  taskId: string,
): Promise<Map<string, TaskAcceptanceRound[]>> {
  const rows = await prisma.taskAcceptanceRound.findMany({
    where: { taskId, ownerId },
    orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      sessionId: true,
      turnId: true,
      exitCode: true,
      expectedExitCode: true,
      branchSha: true,
      finishedAt: true,
      outputTail: true,
    },
  });
  const bySession = new Map<string, TaskAcceptanceRound[]>();
  for (const row of rows) {
    const rounds = bySession.get(row.sessionId) ?? [];
    rounds.push({
      id: row.id,
      turnId: row.turnId,
      exitCode: row.exitCode,
      expectedExitCode: row.expectedExitCode,
      branchSha: row.branchSha,
      finishedAt: row.finishedAt.toISOString(),
      outputTail: row.outputTail,
    });
    bySession.set(row.sessionId, rounds);
  }
  return bySession;
}
