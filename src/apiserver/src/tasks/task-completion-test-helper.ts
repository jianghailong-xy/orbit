import { randomUUID } from 'node:crypto';

import {
  CreatorType,
  PrismaClient,
  RunStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { TasksService } from './tasks.service';

/**
 * Close a EVIDENCE_JUDGMENT task in PostgreSQL integration fixtures through the same durable evidence,
 * request and decision facts as production. This never disables the canonical DONE trigger.
 */
export async function completeHumanTaskForPgTest(
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  label: string,
  tasksService?: TasksService,
): Promise<void> {
  const task = await db.task.findFirstOrThrow({
    where: { id: taskId, ownerId },
    select: { status: true, completionCriterion: true },
  });
  if (task.status === TaskStatus.DONE) return;
  if (task.completionCriterion !== 'EVIDENCE_JUDGMENT') {
    throw new Error(`${label} is ${task.completionCriterion}, not a EVIDENCE_JUDGMENT fixture task`);
  }

  // A decided EVIDENCE_JUDGMENT request is the standing fact. If a fixture deliberately reopens the
  // Task to exercise an ABA transition, completing it again replays that decision rather than
  // forging a second one.
  const standing = await db.taskJudgmentRequest.findFirst({
    where: { taskId, kind: 'EVIDENCE_JUDGMENT', status: 'DECIDED', decision: 'PASS' },
    orderBy: { decidedAt: 'desc' },
  });
  if (standing) {
    await (tasksService ?? new TasksService(
      db as unknown as PrismaService,
      {} as never,
      { publishForUser() {} } as never,
    )).judge(ownerId, taskId, {
      requestId: standing.id,
      evidenceDigest: standing.evidenceDigest,
      evidence: standing.decisionNote ?? `Fixture decision for ${label}`,
    });
    return;
  }

  const sourceSessionId = randomUUID();
  await db.session.create({
    data: {
      id: sourceSessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      title: `${label} completion evidence`,
      prompt: 'record the fixture completion evidence',
      status: RunStatus.SUCCEEDED,
      finishedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: false,
    },
  });
  const evidence = await new TaskCompletionEvidenceService(
    db as unknown as PrismaService,
  ).submit(
    ownerId,
    taskId,
    { type: CreatorType.USER, id: ownerId },
    {
      sourceSessionId,
      evidence: { kind: 'PG_TEST_COMPLETION', label },
      idempotencyKey: `pg-test-completion:${label}:${taskId}`,
    },
  ) as unknown as {
    evidenceDigest: string;
    judgmentRequest: { id: string } | null;
  };
  const requestId = evidence.judgmentRequest?.id;
  if (!requestId) throw new Error(`${label} produced no EVIDENCE_JUDGMENT request`);

  await (tasksService ?? new TasksService(
    db as unknown as PrismaService,
    {} as never,
    { publishForUser() {} } as never,
  )).judge(ownerId, taskId, {
    requestId,
    evidenceDigest: evidence.evidenceDigest,
    evidence: `Fixture decision for ${label}`,
  });
}
