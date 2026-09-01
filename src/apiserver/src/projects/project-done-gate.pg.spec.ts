import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  Prisma,
  PrismaClient,
  ProjectAcceptanceVerdict,
  ProjectStatus,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { completeHumanTaskForPgTest } from '../tasks/task-completion-test-helper';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';

/**
 * N4: the service gate and its database wall over a fully migrated, disposable PostgreSQL.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/projects/project-done-gate.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

async function connect(): Promise<{ db: PrismaClient; acceptance: ProjectAcceptanceService }> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  return {
    db,
    acceptance: new ProjectAcceptanceService(db as unknown as PrismaService),
  };
}

async function fixture(
  db: PrismaClient,
  label: string,
  taskStatus: TaskStatus,
): Promise<{ ownerId: string; projectId: string; taskId: string }> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@done-gate.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      acceptanceCriteria: 'Build succeeds\nImage boots',
    },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: `${label} task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      status: taskStatus,
    },
  });
  return { ownerId, projectId, taskId };
}

async function runAcceptance(
  acceptance: ProjectAcceptanceService,
  target: { ownerId: string; projectId: string },
  verdicts: [ProjectAcceptanceVerdict, ProjectAcceptanceVerdict],
) {
  const opened = await acceptance.openRun(target.ownerId, target.projectId, {
    decidedBy: 'COORDINATOR_AGENT',
  });
  return acceptance.finalizeRun(
    target.ownerId,
    target.projectId,
    opened.id,
    verdicts.map((verdict, index) => ({ ordinal: index + 1, verdict })),
  );
}

async function settle(
  db: PrismaClient,
  acceptance: ProjectAcceptanceService,
  target: { ownerId: string; projectId: string },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await ProjectAcceptanceService.lockProject(
      tx as Prisma.TransactionClient,
      target.projectId,
      target.ownerId,
      'FOR UPDATE',
    );
    const gate = await acceptance.assertDoneAllowed(
      tx as Prisma.TransactionClient,
      target.projectId,
    );
    await tx.project.update({
      where: { id: target.projectId },
      data: { status: ProjectStatus.DONE, acceptedRunId: gate.runId },
    });
  });
}

test('all criteria PASS allows DONE with an OPEN task; only a criterion change reopens it', { skip }, async () => {
  const { db, acceptance } = await connect();
  try {
    const target = await fixture(db, 'pass-open-task', TaskStatus.OPEN);
    await runAcceptance(acceptance, target, [
      ProjectAcceptanceVerdict.PASS,
      ProjectAcceptanceVerdict.PASS,
    ]);

    const before = await acceptance.evaluateGate(target.projectId);
    assert.equal(before.allowed, true, String(before.reason ?? 'gate refused without a reason'));
    await settle(db, acceptance, target);

    const settled = await db.project.findUniqueOrThrow({
      where: { id: target.projectId },
      select: { status: true },
    });
    const openTasks = await db.task.count({
      where: { projectId: target.projectId, status: TaskStatus.OPEN },
    });
    assert.equal(settled.status, ProjectStatus.DONE);
    assert.equal(openTasks, 1, 'the nice-to-have remains OPEN while the goal is DONE');

    await completeHumanTaskForPgTest(db, target.ownerId, target.taskId, 'pass-open-task');
    const afterTaskWrite = await db.project.findUniqueOrThrow({
      where: { id: target.projectId },
      select: { status: true, acceptedRunId: true },
    });
    assert.equal(afterTaskWrite.status, ProjectStatus.DONE);
    assert.notEqual(afterTaskWrite.acceptedRunId, null, 'a task write did not retire acceptance');

    await db.project.update({
      where: { id: target.projectId },
      data: { acceptanceCriteria: 'Build succeeds\nImage boots\nNew finding is addressed' },
    });
    const afterCriterionChange = await db.project.findUniqueOrThrow({
      where: { id: target.projectId },
      select: { status: true, acceptedRunId: true },
    });
    assert.deepEqual(afterCriterionChange, {
      status: ProjectStatus.OPEN,
      acceptedRunId: null,
    }, 'a finding that changes a criterion automatically exits the completed state');
  } finally {
    await db.$disconnect();
  }
});

test('all tasks DONE cannot pass a failed criterion, and both gates name that criterion', { skip }, async () => {
  const { db, acceptance } = await connect();
  try {
    const target = await fixture(db, 'done-task-failed-goal', TaskStatus.DONE);
    const run = await runAcceptance(acceptance, target, [
      ProjectAcceptanceVerdict.PASS,
      ProjectAcceptanceVerdict.FAIL,
    ]);

    assert.equal(
      await db.task.count({ where: { projectId: target.projectId, status: { not: TaskStatus.DONE } } }),
      0,
      'the task list is fully DONE for this counterexample',
    );
    const serviceGate = await acceptance.evaluateGate(target.projectId);
    assert.equal(serviceGate.allowed, false);
    assert.equal(serviceGate.runId, null);
    assert.equal(typeof serviceGate.code, 'string');
    assert.equal(typeof serviceGate.reason, 'string');

    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await assert.rejects(
        () => client.query(
          `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2 WHERE "id" = $1`,
          [target.projectId, run.id],
        ),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /ACCEPTANCE_MISSING|ACCEPTANCE_BLOCKED|ACCEPTANCE_EVIDENCE_STALE/);
          return true;
        },
      );
    } finally {
      await client.end();
    }

    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: target.projectId } })).status,
      ProjectStatus.OPEN,
      'the rejected direct write changed nothing',
    );
  } finally {
    await db.$disconnect();
  }
});
