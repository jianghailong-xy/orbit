import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';

const URL = process.env.COORDINATOR_PG_URL;
// Same opt-in policy as the other destructive PG specs: the shape tests below are always-on, and
// the live proof runs wherever an isolated migrated database is provisioned.
const suite = URL ? test : test.skip;

const MIGRATION = readFileSync(path.resolve(
  __dirname, '../../prisma/migrations/0241_task_attachments/migration.sql',
), 'utf8');
// `../..` is the package root from either src/ or build/, which is how the other source-reading
// specs in this tree (db-write-inventory.spec.ts) address the sources they scan.
const TASKS_SERVICE = readFileSync(path.resolve(
  __dirname, '../..', 'src/tasks/tasks.service.ts',
), 'utf8');
const SESSIONS_SERVICE = readFileSync(path.resolve(
  __dirname, '../..', 'src/sessions/sessions.service.ts',
), 'utf8');

test('0241 gives an attachment a task scope that cascades and excludes the other two', () => {
  assert.match(MIGRATION, /ALTER TABLE "attachment" ADD COLUMN "task_id" UUID/);
  // CASCADE, not SET NULL: these bytes are part of the task, so a task that is gone has no inputs
  // to keep and a template row that outlived its task would be unreachable by every read.
  assert.match(MIGRATION, /REFERENCES "task"\("id"\) ON DELETE CASCADE/);
  assert.match(MIGRATION, /CREATE INDEX "attachment_task_id_idx"/);
  assert.match(MIGRATION, /CHECK \("task_id" IS NULL OR \("session_id" IS NULL AND "turn_id" IS NULL\)\)/);
});

/**
 * The wiring, asserted at the source, because it is what makes the feature exist and nothing else
 * fails when it is removed: a dispatch that stops copying still starts a session, still runs the
 * task and still passes every other test — it just runs it without the design mock the author
 * attached. That is a silent wrong answer, so the call sites are pinned here.
 */
test('both dispatch paths copy the task inputs into the run', () => {
  // The CREATE path: copies unscoped and merges them into the dto `sessions.create` adopts from.
  assert.match(TASKS_SERVICE, /const copies = await this\.copyTaskAttachments\(task\.id, null\);/);
  assert.match(TASKS_SERVICE, /attachmentIds: \[\.\.\.\(dto\.attachmentIds \?\? \[\]\), \.\.\.copies\]/);
  // The RESUME path: copies already scoped to the session, which is what `resume` requires of an
  // attachment it links to the turn.
  assert.match(
    TASKS_SERVICE,
    /const resumeAttachments = await this\.copyTaskAttachments\(task\.id, plan\.sessionId\);/,
  );
  // COPIES, never moves — the whole point. An implementation that reassigned `taskId` would empty
  // the task on its first run, so the template must never appear on the left of a write here.
  assert.doesNotMatch(TASKS_SERVICE, /data: \{ taskId: null \}/);
});

/**
 * The delivery door's idea of "unscoped" has to include the task scope, or a task's template is
 * consumable as a compose-page upload — which 0241's CHECK then refuses as a 500 rather than the
 * 400 the request deserves. Both spots are pinned: the validator that answers the caller, and the
 * adoption that races it.
 */
test('a session upload cannot claim a row that belongs to a task', () => {
  assert.match(
    SESSIONS_SERVICE,
    /where: \{ id: \{ in: ids \}, ownerId, sessionId: null, turnId: null, taskId: null \}/,
  );
  assert.match(
    SESSIONS_SERVICE,
    /where: \{ id: \{ in: attachmentIds \}, sessionId: null, turnId: null, taskId: null \}/,
  );
});

suite('a task keeps its inputs across runs, and a copy cannot also be a template', { timeout: 60_000 }, async (t) => {
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
  await sql.query('TRUNCATE "attachment", "task", "user" RESTART IDENTITY CASCADE');

  const ownerId = randomUUID();
  const taskId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${ownerId}@task-inputs.invalid`, name: 'inputs owner', passwordHash: 'x' },
  });
  await db.task.create({
    data: {
      id: taskId, title: 'implement the mock', ownerId,
      creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
    },
  });
  const template = await db.attachment.create({
    data: {
      ownerId, taskId, mimeType: 'image/png', sizeBytes: 3,
      fileName: 'mock.png', data: new Uint8Array([1, 2, 3]),
    },
    select: { id: true },
  });

  await t.test('the template is what a dispatch reads, and it survives being read twice', async () => {
    // Two runs of the same task, each copying the same way `copyTaskAttachments` does.
    const runs: string[][] = [];
    for (const _ of [0, 1]) {
      const inputs = await db.attachment.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
      assert.equal(inputs.length, 1, 'the template must still be there for the second run');
      const copies: string[] = [];
      for (const a of inputs) {
        const copy = await db.attachment.create({
          data: {
            ownerId: a.ownerId, sessionId: null, mimeType: a.mimeType,
            sizeBytes: a.sizeBytes, fileName: a.fileName, data: a.data,
          },
          select: { id: true },
        });
        copies.push(copy.id);
      }
      runs.push(copies);
    }
    // Two runs, two distinct sets of bytes, and the task still owns exactly one template. This is
    // the property the whole design exists for: the second run is not handed an empty task.
    assert.equal(runs.length, 2);
    assert.notDeepEqual(runs[0], runs[1], 'each run must get its own copies');
    const stillTemplates = await db.attachment.findMany({ where: { taskId }, select: { id: true } });
    assert.deepEqual(stillTemplates.map((a) => a.id), [template.id]);
    // And the copies are NOT templates — nothing a runner receives is listed as the task's input.
    for (const id of [...runs[0], ...runs[1]]) {
      const copy = await db.attachment.findUniqueOrThrow({ where: { id }, select: { taskId: true } });
      assert.equal(copy.taskId, null);
    }
  });

  await t.test('a row cannot be a task template and a conversation blob at once', async () => {
    // The database's own refusal (0241's CHECK), not the service's. A copy that kept its `taskId`
    // would be handed to a runner AND listed as the task's input, so deleting one image from the
    // task would reach into a transcript and remove a picture from a message already sent.
    await assert.rejects(
      sql.query(
        'UPDATE "attachment" SET "session_id" = $1 WHERE "id" = $2',
        [randomUUID(), template.id],
      ),
      /attachment_scope_exclusive/,
    );
  });

  await t.test('a task template cannot be consumed as a session upload', async () => {
    // The template has no session and no turn, which is what "unscoped" used to mean — so the
    // delivery door let it through and migration 0241's CHECK refused the adoption, turning a
    // wrong reference into a 500. The task scope is now part of that question, and the row a
    // dispatch must copy cannot be handed to one conversation instead.
    const stillTemplate = await db.attachment.findMany({
      where: { id: template.id, sessionId: null, turnId: null, taskId: null },
      select: { id: true },
    });
    assert.deepEqual(stillTemplate, [], 'a task input must not read as an unscoped upload');
  });

  await t.test('deleting the task takes its inputs with it', async () => {
    await db.task.delete({ where: { id: taskId } });
    assert.equal(await db.attachment.count({ where: { id: template.id } }), 0);
  });
});
