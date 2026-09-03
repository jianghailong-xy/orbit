import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  CreatorType,
  Prisma,
  PrismaClient,
  ProjectStatus,
  TaskCompletionCriterion,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectsService } from './projects.service';

/**
 * There is no project DONE gate. Asserted over a fully migrated, disposable PostgreSQL, because
 * the claim is the DATABASE's: migration 0229 dropped 0150's `project_acceptance_done_gate` /
 * `_advance_epoch` / `_epoch_audit` and 0172's `_criteria_fact` from the `project` table, and the
 * six columns they read.
 *
 * The account owner was offered a narrower guard on 2026-09-03 and chose the other option:
 * `project.status = 'DONE'` is now an ordinary column write that any actor may make, with no
 * database gate and no application-layer refusal. That is a consequence to be shown working, not
 * a risk to be hedged — a removal asserted only as "the trigger is not in pg_trigger" would not
 * notice a replacement gate arriving under another name.
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

async function connect(): Promise<{
  db: PrismaClient;
  acceptance: ProjectAcceptanceService;
  projects: ProjectsService;
}> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const acceptance = new ProjectAcceptanceService(db as unknown as PrismaService);
  return {
    db,
    acceptance,
    projects: new ProjectsService(db as unknown as PrismaService, acceptance),
  };
}

/** A project with two stated criteria and one task, in whatever status the case needs. */
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
      acceptanceCriterionDefinitions: {
        create: ['Build succeeds', 'Image boots'].map((text, index) => ({
          ordinal: index + 1,
          text,
          verificationMethod: `A person checks that ${text.toLowerCase()}`,
          completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
          contentHash: '0'.repeat(64),
        })),
      },
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

// The database half. A raw UPDATE is the writer the gate existed for — the one that goes around
// every service — so it is the one that has to be shown going through.
test('a raw UPDATE settles a project DONE with an OPEN task and unjudged criteria',
  { skip }, async () => {
    const { db } = await connect();
    try {
      const target = await fixture(db, 'raw-done', TaskStatus.OPEN);

      const updated = await db.$executeRaw(Prisma.sql`
        UPDATE "project" SET "status" = 'DONE' WHERE "id" = ${target.projectId}::uuid`);
      assert.equal(updated, 1);

      const row = await db.project.findUniqueOrThrow({ where: { id: target.projectId } });
      assert.equal(row.status, ProjectStatus.DONE);
      // The criteria are untouched by it, and still unjudged — because nothing judges them.
      const criteria = await db.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: target.projectId },
        orderBy: { ordinal: 'asc' },
      });
      assert.deepEqual(criteria.map((c) => c.text), ['Build succeeds', 'Image boots']);
    } finally {
      await db.$disconnect();
    }
  });

// The application half. `refuseDirectDone` used to turn this into a 409 for every principal.
test('ProjectsService.update settles a project DONE for an ordinary caller', { skip }, async () => {
  const { db, projects } = await connect();
  try {
    const target = await fixture(db, 'service-done', TaskStatus.OPEN);

    const updated: any = await projects.update(target.ownerId, target.projectId, {
      status: ProjectStatus.DONE,
    } as never);

    assert.equal(updated.status, ProjectStatus.DONE);
    assert.equal(
      (await db.project.findUniqueOrThrow({ where: { id: target.projectId } })).status,
      ProjectStatus.DONE,
    );
  } finally {
    await db.$disconnect();
  }
});

// DONE is not a one-way door either: nothing advances an epoch on the way back, because there is
// no epoch. The reopen acknowledgement that used to fence this is gone with it.
test('a settled project reopens without acknowledging anything', { skip }, async () => {
  const { db, projects } = await connect();
  try {
    const target = await fixture(db, 'reopen', TaskStatus.DONE);
    await projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);

    const reopened: any = await projects.update(target.ownerId, target.projectId, {
      status: ProjectStatus.OPEN,
    } as never);

    assert.equal(reopened.status, ProjectStatus.OPEN);
    assert.equal('reopened' in reopened, false, 'a reopen report describes machinery that is gone');
  } finally {
    await db.$disconnect();
  }
});

// The catalog, stated as its own assertion: the four triggers and the six columns 0229 removed
// from the core `project` table, and nothing installed in their place.
test('the project table carries no acceptance trigger and no acceptance machine column',
  { skip }, async () => {
    const { db } = await connect();
    try {
      const triggers = await db.$queryRaw<Array<{ tgname: string }>>(Prisma.sql`
        SELECT t."tgname" FROM "pg_trigger" t
         WHERE t."tgrelid" = 'project'::regclass AND NOT t."tgisinternal"
         ORDER BY t."tgname"`);
      const names = triggers.map((t) => t.tgname);
      for (const gone of [
        'project_acceptance_done_gate',
        'project_acceptance_advance_epoch',
        'project_acceptance_epoch_audit',
        'project_acceptance_criteria_fact',
      ]) {
        assert.equal(names.includes(gone), false, `${gone} survives on project`);
      }
      assert.equal(names.some((n) => /acceptance/i.test(n)), false,
        `an acceptance trigger arrived under another name: ${names.join(', ')}`);

      const columns = await db.$queryRaw<Array<{ column_name: string }>>(Prisma.sql`
        SELECT "column_name" FROM "information_schema"."columns"
         WHERE "table_schema" = 'public' AND "table_name" = 'project'
         ORDER BY "column_name"`);
      const columnNames = columns.map((c) => c.column_name);
      for (const gone of [
        'accepted_run_id', 'acceptance_epoch', 'legacy_accepted_at',
        'acceptance_criteria', 'acceptance_criteria_digest', 'acceptance_criteria_format',
      ]) {
        assert.equal(columnNames.includes(gone), false, `project.${gone} survives`);
      }
    } finally {
      await db.$disconnect();
    }
  });

test('the PostgreSQL target is a disposable database', { skip }, verifyDisposableDatabase);
