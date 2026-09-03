import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  PrismaClient,
  ProjectStatus,
  RunStatus,
  RunnerStatus,
  TaskCompletionCriterion,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
async function verifyDisposableDatabase(): Promise<void> {
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

async function connect() {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const acceptance = new ProjectAcceptanceService(db as unknown as PrismaService);
  return {
    db,
    acceptance,
    projects: new ProjectsService(db as unknown as PrismaService, acceptance),
  };
}

async function base(db: PrismaClient, label: string) {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@project-criterion.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: `Prove the ${label} criterion automation boundary`,
    },
  });
  return { ownerId, projectId };
}

async function task(
  db: PrismaClient,
  target: { ownerId: string; projectId: string },
  title: string,
  data: Record<string, unknown> = {},
) {
  return db.task.create({
    data: {
      id: randomUUID(),
      ownerId: target.ownerId,
      projectId: target.projectId,
      title,
      creatorType: CreatorType.USER,
      creatorId: target.ownerId,
      status: TaskStatus.OPEN,
      ...data,
    },
  });
}

async function declare(
  projects: ProjectsService,
  target: { ownerId: string; projectId: string },
  item: Record<string, unknown>,
) {
  return projects.update(target.ownerId, target.projectId, {
    acceptanceCriteriaItems: [item],
  } as never);
}

/**
 * The three peer criterion kinds after 2026-09-03.
 *
 * Three tests stood here, one per kind, each following a criterion from declared to concluded.
 * Migration 0229 removed the project acceptance JUDGMENT on the account owner's instruction, so
 * there is nothing left that concludes a project criterion of ANY kind — EXECUTABLE lost its
 * evidence source to 0227/0228, VERIFICATION lost the reconciler that consumed a verifier verdict,
 * and EVIDENCE_JUDGMENT lost the conclusion event a person recorded.
 *
 * That is a fact about the gate worth stating rather than a gap worth hiding: every kind is still
 * declarable, still stored with its command, expected exit code and evidence task, and none of
 * them can conclude. So what these assert now is the DECLARATION surviving intact and the project
 * standing still — plus, in the last case, that settling the project is an ordinary write with
 * nothing checking anything first.
 */
test('all three criterion kinds are still declarable, and none of them concludes',
  { skip }, async () => {
    const { db, projects } = await connect();
    try {
      const target = await base(db, 'declarable');
      const source = await task(db, target, 'run the release command', {
        completionCriterion: TaskCompletionCriterion.EXECUTABLE,
        acceptanceCommand: 'npm test',
        acceptanceExpectedExitCode: 0,
      });
      const subject = await task(db, target, 'implementation under review');
      const verifier = await task(db, target, 'independent review', {
        verifiesTaskId: subject.id,
        completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
      });

      await projects.update(target.ownerId, target.projectId, {
        acceptanceCriteriaItems: [
          {
            text: '验收命令退出码与预期一致',
            verificationMethod: 'Read the exact durable command result and raw output',
            completionCriterion: TaskCompletionCriterion.EXECUTABLE,
            acceptanceCommand: 'npm test',
            acceptanceExpectedExitCode: 0,
            evidenceTaskId: source.id,
          },
          {
            text: '独立复核确认实现符合意图',
            verificationMethod: 'Consume the independent verifier Task verdict',
            completionCriterion: TaskCompletionCriterion.VERIFICATION,
            evidenceTaskId: verifier.id,
          },
          {
            text: '由 owner 判断发布取舍是否值得',
            verificationMethod: 'Owner reviews the release tradeoff',
            completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
          },
        ],
      } as never);

      const declared = await db.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: target.projectId },
        orderBy: { ordinal: 'asc' },
      });
      assert.deepEqual(declared.map((d) => d.completionCriterion), [
        TaskCompletionCriterion.EXECUTABLE,
        TaskCompletionCriterion.VERIFICATION,
        TaskCompletionCriterion.EVIDENCE_JUDGMENT,
      ]);
      assert.equal(declared[0].acceptanceCommand, 'npm test');
      assert.equal(declared[0].acceptanceExpectedExitCode, 0);
      assert.equal(declared[0].evidenceTaskId, source.id);
      assert.equal(declared[1].evidenceTaskId, verifier.id);
      assert.equal(declared[2].acceptanceCommand, null);

      // A verifier verdict is a fact about the TASK, and nothing carries it to the criterion that
      // cites it: the reconciler that did was removed with the conclusions it wrote.
      await db.task.update({ where: { id: verifier.id }, data: { verdict: TaskVerdict.PASS } });
      const after = await db.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: target.projectId },
        orderBy: { ordinal: 'asc' },
      });
      assert.deepEqual(after.map((d) => d.revision), declared.map((d) => d.revision));
      assert.equal(
        await db.project.findUniqueOrThrow({ where: { id: target.projectId } }).then((p) => p.status),
        ProjectStatus.OPEN,
        'a verifier PASS must not settle the project it was cited by',
      );

      // And settling it is now an ordinary write. This used to be a PROJECT_DONE_AUTOMATIC_ONLY
      // 409 for every principal; the account owner chose to remove that refusal with the gate.
      const settled: any = await projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);
      assert.equal(settled.status, ProjectStatus.DONE);
    } finally {
      await db.$disconnect();
    }
  });

test('structured project criteria reject a missing declaration instead of defaulting', { skip }, async () => {
  const { db, projects } = await connect();
  try {
    const target = await base(db, 'missing-declaration');
    await assert.rejects(
      declare(projects, target, {
        text: 'A declaration is mandatory',
        verificationMethod: 'No implicit fallback is allowed',
      }),
      (error: unknown) => {
        assert.ok(error instanceof BadRequestException);
        assert.match(error.message, /requires completionCriterion/);
        return true;
      },
    );
    assert.equal(
      await db.projectAcceptanceCriterionDefinition.count({ where: { projectId: target.projectId } }),
      0,
    );
  } finally {
    await db.$disconnect();
  }
});

test('the PostgreSQL target is a disposable database', { skip }, verifyDisposableDatabase);
