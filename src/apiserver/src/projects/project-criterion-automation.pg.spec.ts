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
import { BadRequestException } from '@nestjs/common';
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
      completionCriterion: 'EVIDENCE_JUDGMENT',
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
 * A project criterion after 2026-09-04.
 *
 * Three tests stood here, one per criterion KIND, each following a criterion from declared to
 * concluded. Migration 0229 removed the project acceptance JUDGMENT on the account owner's
 * instruction, so nothing concluded a criterion of any kind; migration 0233 then removed the kind
 * itself, along with the command, expected exit code and evidence pointer beside it — a criterion
 * no longer names the work that serves it, the work names the criterion
 * (`Task.criterionDefinitionId`, migration 0232).
 *
 * So what is left to assert is what survived: the DECLARATION — text and the reader-facing method
 * — stored intact and unmoved by anything happening to the tasks that cite it, plus the project
 * settling as an ordinary write with nothing checking anything first.
 */
test('a project criterion is still declarable, and nothing about the work concludes it',
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
          },
          {
            text: '独立复核确认实现符合意图',
            verificationMethod: 'Consume the independent verifier Task verdict',
          },
          {
            text: '由 owner 判断发布取舍是否值得',
            verificationMethod: 'Owner reviews the release tradeoff',
          },
        ],
      } as never);

      const declared = await db.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: target.projectId },
        orderBy: { ordinal: 'asc' },
      });
      assert.deepEqual(declared.map((d) => d.text), [
        '验收命令退出码与预期一致',
        '独立复核确认实现符合意图',
        '由 owner 判断发布取舍是否值得',
      ]);
      assert.deepEqual(declared.map((d) => d.verificationMethod), [
        'Read the exact durable command result and raw output',
        'Consume the independent verifier Task verdict',
        'Owner reviews the release tradeoff',
      ]);
      // The tasks that would once have been wired into these criteria are still ordinary tasks,
      // and no criterion names them.
      for (const criterion of declared) {
        for (const gone of [
          'completionCriterion', 'acceptanceCommand', 'acceptanceExpectedExitCode',
          'evidenceTaskId',
        ]) {
          assert.equal(gone in criterion, false, `${gone} is still stored on a criterion`);
        }
      }
      assert.equal(source.acceptanceCommand, 'npm test');

      // A verifier verdict is a fact about the TASK, and nothing carries it to a criterion: the
      // reconciler that did was removed with the conclusions it wrote, and since 0233 there is not
      // even a column that could have named the verifier.
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

/**
 * The negative control for migration 0233, at the service door.
 *
 * The soft landing this removal had to avoid is the silent one: the four names are no longer
 * columns, so a caller that keeps sending them could simply have them ignored and be told the
 * write succeeded. Each is refused by name, and the refusal says where the relation went.
 */
test('a criterion that still names the removed wiring is refused, not quietly ignored',
  { skip }, async () => {
    const { db, projects } = await connect();
    try {
      const target = await base(db, 'removed-wiring');
      const evidence = await task(db, target, 'work that serves it');
      const sent: Record<string, unknown> = {
        completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
        acceptanceCommand: 'npm test',
        acceptanceExpectedExitCode: 0,
        evidenceTaskId: evidence.id,
      };
      for (const [field, value] of Object.entries(sent)) {
        await assert.rejects(
          declare(projects, target, {
            text: `A criterion sending ${field}`,
            verificationMethod: 'A person reads it',
            [field]: value,
          }),
          (error: unknown) => {
            assert.ok(error instanceof BadRequestException, `${field} was not refused`);
            assert.equal(error.getStatus(), 400);
            assert.match(error.message, new RegExp(`${field} was removed by migration 0233`));
            assert.match(error.message, /task\.criterionDefinitionId/);
            return true;
          },
        );
      }
      // Refused, not partially applied: nothing was written by any of the four attempts.
      assert.equal(
        await db.projectAcceptanceCriterionDefinition.count({ where: { projectId: target.projectId } }),
        0,
      );
    } finally {
      await db.$disconnect();
    }
  });

test('the PostgreSQL target is a disposable database', { skip }, verifyDisposableDatabase);
