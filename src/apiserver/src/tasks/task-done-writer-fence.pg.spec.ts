import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { TASK_COMPLETION_FENCE_REVISION } from './task-completion-criterion';

const URL = process.env.COORDINATOR_PG_URL;
// Generic API CI has no PostgreSQL fixture, so follow the repository's explicit opt-in policy for
// destructive PG specs. The migration-shape test below remains always-on. The live writer proof is
// still mandatory in outcome-reconciler-bootstrap.sh, which supplies a migrated isolated database
// and rejects skipped tests.
const suite = URL ? test : test.skip;

test('0193 installs the canonical DONE writer fence', () => {
  const sql = readFileSync(path.resolve(
    __dirname,
    '../../prisma/migrations/0193_task_done_writer_fence/migration.sql',
  ), 'utf8');
  assert.match(sql, /completion_fence_revision/);
  assert.match(sql, /TASK_DONE_CANONICAL_FACT_REQUIRED/);
  assert.match(sql, /task_judgment_request/);
  assert.match(sql, /BEFORE UPDATE OF "status", "completion_fence_revision"/);
});

suite('an old direct status writer cannot complete a revision-1 task', { timeout: 60_000 }, async (t) => {
  assert.ok(URL, 'COORDINATOR_PG_URL is required; bootstrap must provision an isolated database');
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  const db = prismaClientFor(URL);
  await sql.connect();
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query('TRUNCATE "task", "user" RESTART IDENTITY CASCADE');

  const ownerId = randomUUID();
  const fencedTaskId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${ownerId}@writer-fence.invalid`,
      name: 'writer fence owner',
      passwordHash: 'x',
    },
  });
  await db.task.create({
    data: {
      id: fencedTaskId,
      ownerId,
      creatorType: 'USER',
      creatorId: ownerId,
      title: 'canonical status writer only',
      completionCriterion: 'HUMAN_SIGNOFF',
      completionFenceRevision: TASK_COMPLETION_FENCE_REVISION,
    },
  });

  await assert.rejects(
    db.task.update({ where: { id: fencedTaskId }, data: { status: TaskStatus.DONE } }),
    /TASK_DONE_CANONICAL_FACT_REQUIRED/,
  );
  await assert.rejects(
    db.task.update({
      where: { id: fencedTaskId },
      data: { completionFenceRevision: 0, status: TaskStatus.DONE },
    }),
    /TASK_COMPLETION_FENCE_REVISION_DOWNGRADE/,
  );
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fencedTaskId } })).status, 'OPEN');
});
