import { randomUUID } from 'node:crypto';

import { CreatorType, PrismaClient, TaskStatus } from '@prisma/client';

/**
 * Drive a fixture task to genuinely finished, through the one criterion that still has an
 * implementation.
 *
 * Until 2026-09-02 this closed an EVIDENCE_JUDGMENT task by submitting evidence, reading back the
 * request the ledger raised and deciding it. All three of those facts were removed with the rest
 * of the judgment machinery, so the only remaining route to DONE is VERIFICATION.
 *
 * The transition goes through the same fence production takes — no trigger is disabled, and the
 * subject's own status write is 0193's `VERIFICATION_PASSED` lane. The scaffolding it needs to get
 * there is then taken down again; see below for why that is the honest shape for a fixture.
 */
export async function completeHumanTaskForPgTest(
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  label: string,
): Promise<void> {
  const task = await db.task.findFirstOrThrow({
    where: { id: taskId, ownerId },
    select: {
      status: true, projectId: true, listId: true, assigneeId: true,
      completionCriterion: true, completionPolicy: true,
    },
  });
  if (task.status === TaskStatus.DONE) return;

  // The subject declares that an independent check settles it. A fixture written before the
  // judgment machinery went is redeclared here rather than at each call site; the criterion is a
  // declaration, and this is the declaration the surviving implementation reads.
  await db.task.update({
    where: { id: taskId },
    data: { completionCriterion: 'VERIFICATION', completionPolicy: 'VERIFICATION_PASSED' },
  });

  // The independent check, carrying the PASS that 0192's carrier trigger turns into its own DONE
  // and that 0193's fence then accepts for the subject.
  const verifier = await db.task.create({
    data: {
      id: randomUUID(),
      ownerId,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      title: `[VERIFY] ${label}`.slice(0, 200),
      description: `fixture verification of ${label}`,
      projectId: task.projectId,
      listId: task.listId,
      assigneeId: task.assigneeId,
      verifiesTaskId: taskId,
      verdict: 'PASS',
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'MANUAL',
      completionFenceRevision: 1,
      autoRunWhenReady: false,
    },
    select: { id: true },
  });

  // The subject's own transition, through the fence's VERIFICATION_PASSED lane. `updateMany` so a
  // fixture that concurrently cancelled the task is a no-op rather than a throw.
  const settled = await db.task.updateMany({
    where: {
      id: taskId,
      ownerId,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      status: { not: TaskStatus.CANCELLED },
      supersededByTaskId: null,
      terminalReason: null,
    },
    data: { status: TaskStatus.DONE },
  });

  // Then take the scaffolding down again.
  //
  // Both halves matter, and both are about what a fixture MEANS by "this task is finished".
  //
  //   * The check is deleted. A standing verifier is not neutral: §13.3 DEP holds every dependent
  //     until the check's own run has settled and, inside a project, until its verdict was applied
  //     by the ledger — and it makes the subject itself unrunnable the moment it is reopened,
  //     because a reopened subject fails its own epoch. Every caller here is testing dispatch
  //     epochs, coordinator wakes or project settlement, and would be measuring the verification
  //     lifecycle by accident. Deleting it leaves exactly what they mean: a DONE task with no
  //     outstanding check.
  //   * The declaration goes back to whatever the caller made. `VERIFICATION` with no subject is
  //     a task §13.1 AG6 says only completion may finish, so it can never be started again, and
  //     `VERIFICATION_PASSED` is a STANDING rule that §13.1 re-derives on every later write — both
  //     would silently change what the fixtures that reopen and re-run their task are measuring.
  //     The two only have to be true for the one statement the fence reads them in.
  //
  // Neither weakens the transition itself: it went through the same fence, on the same lane, that
  // production takes.
  if (settled.count > 0) {
    await db.session.deleteMany({ where: { taskId: verifier.id } });
    await db.task.delete({ where: { id: verifier.id } });
    await db.task.update({
      where: { id: taskId },
      data: {
        completionCriterion: task.completionCriterion,
        completionPolicy: task.completionPolicy,
      },
    });
  }
}
