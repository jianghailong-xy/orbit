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
 * Close a HUMAN_SIGNOFF task in PostgreSQL integration fixtures through the same durable evidence,
 * request and signoff facts as production. This never disables the canonical DONE trigger.
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
  if (task.completionCriterion !== 'HUMAN_SIGNOFF') {
    throw new Error(`${label} is ${task.completionCriterion}, not a HUMAN_SIGNOFF fixture task`);
  }

  // A Task has one immutable human signoff fact. If a fixture deliberately reopens the Task to
  // exercise an ABA transition, completing it again must reuse that standing fact rather than
  // forge a second signoff or weaken the unique production constraint.
  const standingSignoff = await db.taskHumanSignoff.findUnique({ where: { taskId } });
  if (standingSignoff) {
    await (tasksService ?? new TasksService(
      db as unknown as PrismaService,
      {} as never,
      { publishForUser() {} } as never,
    )).signoff(ownerId, taskId, {
      requestId: standingSignoff.requestId,
      evidenceDigest: standingSignoff.evidenceDigest,
      evidence: standingSignoff.evidence,
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
  if (!requestId) throw new Error(`${label} produced no HUMAN_SIGNOFF request`);

  await (tasksService ?? new TasksService(
    db as unknown as PrismaService,
    {} as never,
    { publishForUser() {} } as never,
  )).signoff(ownerId, taskId, {
    requestId,
    evidenceDigest: evidence.evidenceDigest,
    evidence: `Owner fixture decision for ${label}`,
  });
}
