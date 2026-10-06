/**
 * Unit L4 on the edit door, on real PostgreSQL: a session asks for an existing task to be MOVED into
 * another project — and asking is all that happens (account owner, 2026-10-06).
 *
 * What is under test is the request half of a move: who may ask (either end of the move, never a
 * bystander), what one request may carry, that a move already waiting is the answer to every later
 * request for it — one after another, all at once, and at the database for a writer that skips the
 * service — and that what would make the move impossible is refused before anybody is asked. What
 * applies an approved move is the account owner's confirmation, and not this file's.
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-move-request.pg.spec.ts
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { criterionKeyOf } from '../projects/project-acceptance';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const REPO = 'ssh://git@example.invalid/orbit/move-request';

interface World {
  ownerId: string;
  /** Where the task is. */
  projectA: string;
  /** Where it is asked to go. */
  projectB: string;
  /** A third project of the same owner: neither end of the move. */
  projectC: string;
  /** The three projects' coordinator conversations. */
  coordA: string;
  coordB: string;
  coordC: string;
  /** An execution session, running `work`. */
  worker: string;
  work: string;
  /** The task asked about. It declares `criterionA`, one of A's criteria. */
  task: string;
  taskTitle: string;
  /** A task in A with no run and no declaration, for the owner's own move. */
  plain: string;
  criterionA: string;
  criterionB: string;
}

type Refusal = { status: number; body: Record<string, unknown> };

test('unit L4: a session asks for a task to be moved, and only asks', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const { prismaClientFor } = await import('../prisma/prisma-client.js');
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await verifyCoordinatorPgIdentity(admin);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await admin.end().catch(() => undefined);
  });

  const handoffs = new ProjectHandoffService(prisma as never);
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged: () => undefined, publishForUser: () => undefined } as never,
    handoffs,
  );

  async function insertTask(
    w: Pick<World, 'ownerId'>,
    title: string,
    projectId: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    const row: Record<string, unknown> = {
      id, owner_id: w.ownerId, title, status: 'OPEN', project_id: projectId, creator_type: 'USER',
      creator_id: w.ownerId, updated_at: new Date(), completion_criterion: 'EVIDENCE_JUDGMENT',
      ...extra,
    };
    const columns = Object.keys(row);
    const values = Object.values(row);
    await admin.query(
      `INSERT INTO "task" (${columns.map((c) => `"${c}"`).join(',')})
       VALUES (${values.map((_, i) => `$${i + 1}`).join(',')})`,
      values,
    );
    return id;
  }

  async function insertCriterion(projectId: string, text: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method","content_hash","created_at","updated_at")
       VALUES ($1,$2,1,$3,'a pg spec',$4,now(),now())`,
      [id, projectId, text, createHash('sha256').update(text).digest('hex')],
    );
    return id;
  }

  async function seed(label: string): Promise<World> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [ownerId, `${label}-${ownerId}@move.invalid`, label],
    );
    await admin.query(
      `INSERT INTO "runner" ("id","owner_id","name","status","token_hash","capabilities_reported_at")
       VALUES ($1,$2,$3,'ONLINE',$4,now())`,
      [runnerId, ownerId, `${label}-runner`, `${label}-${runnerId}`],
    );
    await admin.query(
      `INSERT INTO "workspace" ("id","owner_id","name","runner_id","can_create_tasks","can_delegate")
       VALUES ($1,$2,$3,$4,true,true)`,
      [workspaceId, ownerId, `${label}-agent`, runnerId],
    );
    const [projectA, projectB, projectC] = [randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[projectA, 'A'], [projectB, 'B'], [projectC, 'C']]) {
      await admin.query(
        `INSERT INTO "project" ("id","owner_id","title","coordinator_enabled","updated_at")
         VALUES ($1,$2,$3,true,now())`,
        [id, ownerId, `${label} project ${name}`],
      );
      await admin.query(
        `INSERT INTO "project_runtime" ("project_id","updated_at") VALUES ($1,now())
           ON CONFLICT ("project_id") DO NOTHING`,
        [id],
      );
    }
    const [coordA, coordB, coordC, worker] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const [id, name] of [[coordA, 'coordinator of A'], [coordB, 'coordinator of B'],
      [coordC, 'coordinator of C'], [worker, 'a run in A']]) {
      await admin.query(
        `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
           "provider","status","dispatch_origin","updated_at")
         VALUES ($1,$2,$3,$4,'fixture',$2,'claude','RUNNING'::"run_status",
           'USER'::"session_dispatch_origin",now())`,
        [id, ownerId, workspaceId, `${label}: ${name}`],
      );
    }
    for (const [project, session] of [[projectA, coordA], [projectB, coordB], [projectC, coordC]]) {
      await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [project, session]);
    }
    const criterionA = await insertCriterion(projectA, `${label}: what A wants`);
    const criterionB = await insertCriterion(projectB, `${label}: what B wants`);
    const w = { ownerId };
    const work = await insertTask(w, `${label}: the work the run is doing`, projectA);
    await admin.query('UPDATE "session" SET "task_id" = $2::uuid WHERE "id" = $1::uuid', [worker, work]);
    const taskTitle = `${label}: work that belongs to B`;
    const task = await insertTask(w, taskTitle, projectA, {
      criterion_definition_id: criterionA, criterion_revision: 1,
    });
    const plain = await insertTask(w, `${label}: work the owner moves`, projectA);
    return {
      ownerId, projectA, projectB, projectC, coordA, coordB, coordC, worker, work, task, taskTitle,
      plain, criterionA, criterionB,
    };
  }

  /** The request, as `task_update` sends it: another project, and the declaration. */
  const ask = (w: World, sessionId: string, over: Record<string, unknown> = {}, taskId = w.task) =>
    tasks.update(w.ownerId, taskId, {
      projectId: w.projectB, handoff: { reason: 'it serves B' }, ...over,
    } as never, sessionId);

  async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    }
    throw new assert.AssertionError({ message: 'the request was not refused' });
  }

  async function rows(ownerId: string) {
    const { rows: found } = await admin.query(
      `SELECT * FROM "project_handoff_approval" WHERE "owner_id" = $1::uuid
        ORDER BY "requested_at", "id"`,
      [ownerId],
    );
    return found;
  }

  async function projectOf(taskId: string): Promise<string | null> {
    const { rows: [row] } = await admin.query<{ project_id: string | null }>(
      'SELECT "project_id" FROM "task" WHERE "id" = $1::uuid', [taskId]);
    return row.project_id;
  }

  /** The one question a first request files, and the refusal that names it. */
  async function assertFiled(
    w: World,
    refusal: Refusal,
    asker: string,
    subject = w.task,
  ): Promise<Record<string, unknown>> {
    assert.equal(refusal.status, 403);
    assert.equal(refusal.body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
    assert.equal(refusal.body.rule, 'R10_NO_APPROVAL');
    assert.equal(refusal.body.requiredAction, 'AWAIT_HANDOFF_APPROVAL');
    assert.equal(refusal.body.taskId, subject);
    assert.deepEqual(refusal.body.scope, { projectId: w.projectA });
    assert.deepEqual(refusal.body.target, { projectId: w.projectB });
    const all = await rows(w.ownerId);
    assert.equal(all.length, 1, 'one question, and only one');
    const [row] = all;
    assert.equal(refusal.body.handoffId, row.id, 'the refusal names the question it filed');
    assert.equal(refusal.body.handoffState, 'PENDING');
    assert.equal(row.kind, 'MOVE_TASK');
    assert.equal(row.subject_task_id, subject);
    assert.equal(row.state, 'PENDING');
    assert.equal(row.from_project_id, w.projectA);
    assert.equal(row.to_project_id, w.projectB);
    assert.equal(row.requested_by_session_id, asker);
    assert.equal(row.reason, 'it serves B');
    assert.equal(row.decided_by, null);
    assert.equal(row.applied_task_id, null);
    assert.equal(await projectOf(subject), w.projectA, 'a request moves nothing');
    return row;
  }

  // ------------------------------------------------------------------------------------------
  // Who may ask: either end of the move.
  // ------------------------------------------------------------------------------------------

  await t.test('the source project\'s coordinator asks to push a task out: one question, no move', async () => {
    const w = await seed('push');
    const row = await assertFiled(w, await refusalOf(() => ask(w, w.coordA)), w.coordA);
    assert.equal(row.title, w.taskTitle, 'the question shows the task it is about');
    assert.equal(row.requested_criterion_definition_id, null);
  });

  await t.test('the target project\'s coordinator asks to pull a task in: one question, no move', async () => {
    // The 2026-10-06 request this project started from had exactly this shape: the coordinator of
    // the project the work belonged to, asking for it to be brought over.
    const w = await seed('pull');
    await assertFiled(w, await refusalOf(() => ask(w, w.coordB)), w.coordB);
  });

  await t.test('an execution session asks for the task it is running to move: one question, no move', async () => {
    const w = await seed('worker');
    const row = await assertFiled(w, await refusalOf(() => ask(w, w.worker, {}, w.work)), w.worker, w.work);
    assert.equal(row.title, `worker: the work the run is doing`);
    // And the run is still running in the project it was started for.
    const { rows: [session] } = await admin.query<{ task_id: string }>(
      'SELECT "task_id" FROM "session" WHERE "id" = $1::uuid', [w.worker]);
    assert.equal(session.task_id, w.work);
  });

  await t.test('a session that holds neither end is refused, files nothing, and learns nothing', async () => {
    const w = await seed('bystander');
    const refused = await refusalOf(() => ask(w, w.coordC));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'PROJECT_SCOPE_MISMATCH');
    assert.equal(refused.body.rule, 'R6_OUT_OF_SCOPE');
    assert.match(String(refused.body.message), /holds neither/);
    assert.equal(refused.body.handoffId, null);
    assert.deepEqual(await rows(w.ownerId), [], 'a bystander files no question');

    // With a question already waiting for the very same move, the bystander still meets the scope
    // refusal — not APPROVAL_PENDING, which would hand it a question it had no standing to ask.
    await refusalOf(() => ask(w, w.coordA));
    const again = await refusalOf(() => ask(w, w.coordC));
    assert.equal(again.body.code, 'PROJECT_SCOPE_MISMATCH');
    assert.equal(again.body.handoffId, null);
    assert.equal((await rows(w.ownerId)).length, 1);
    assert.equal(await projectOf(w.task), w.projectA);
  });

  await t.test('a move without handoff is still R7, and asks nobody anything', async () => {
    const w = await seed('undeclared');
    for (const dto of [{ projectId: w.projectB }, { projectId: w.projectB, handoff: null }]) {
      const refused = await refusalOf(() => tasks.update(w.ownerId, w.task, dto as never, w.coordA));
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'PROJECT_SCOPE_MISMATCH');
      assert.equal(refused.body.rule, 'R7_UNDECLARED_CROSSING');
    }
    // Undeclared from the target's coordinator too: pulling without asking is still a crossing.
    const pulled = await refusalOf(() =>
      tasks.update(w.ownerId, w.task, { projectId: w.projectB } as never, w.coordB));
    assert.equal(pulled.body.code, 'PROJECT_SCOPE_MISMATCH');
    assert.deepEqual(await rows(w.ownerId), []);
    assert.equal(await projectOf(w.task), w.projectA);
  });

  // ------------------------------------------------------------------------------------------
  // One question per move.
  // ------------------------------------------------------------------------------------------

  await t.test('asking again for a move already waiting returns that question, unchanged', async () => {
    const w = await seed('again');
    await assertFiled(w, await refusalOf(() => ask(w, w.coordA)), w.coordA);
    const [filed] = await rows(w.ownerId);
    const repeats: Array<[string, string, Record<string, unknown>]> = [
      ['the same session', w.coordA, {}],
      ['the same session with another reason', w.coordA, { handoff: { reason: 'a different argument' } }],
      ['the other end', w.coordB, {}],
      ['an execution session of the source', w.worker, {}],
      ['a request naming a target criterion', w.coordB, { criterionKey: criterionKeyOf(w.criterionB) }],
    ];
    for (const [who, session, over] of repeats) {
      const again = await refusalOf(() => ask(w, session, over));
      assert.equal(again.status, 403, who);
      assert.equal(again.body.code, 'APPROVAL_PENDING', who);
      assert.equal(again.body.rule, 'R11_APPROVAL_PENDING', who);
      assert.equal(again.body.handoffId, filed.id, `${who} is handed the question already waiting`);
      assert.equal(again.body.handoffState, 'PENDING', who);
    }
    const after = await rows(w.ownerId);
    assert.equal(after.length, 1, 'no second question');
    assert.deepEqual(after[0], filed, 'and nothing about the first was rewritten');
    assert.equal(await projectOf(w.task), w.projectA);
  });

  await t.test('requests for one move made all at once file one question', async () => {
    const w = await seed('concurrent');
    const askers = [w.coordA, w.coordB, w.worker, w.coordA, w.coordB, w.worker];
    const answers = await Promise.all(askers.map((session, index) =>
      refusalOf(() => ask(w, session, { handoff: { reason: `asker ${index}` } }))));
    const all = await rows(w.ownerId);
    assert.equal(all.length, 1, 'one question, however many asked at once');
    for (const answer of answers) {
      assert.equal(answer.status, 403);
      assert.equal(answer.body.handoffId, all[0].id, 'every asker is handed the same question');
    }
    const codes = answers.map((answer) => answer.body.code).sort();
    assert.deepEqual(codes, ['APPROVAL_PENDING', 'APPROVAL_PENDING', 'APPROVAL_PENDING',
      'APPROVAL_PENDING', 'APPROVAL_PENDING', 'CROSS_PROJECT_APPROVAL_REQUIRED'],
    'exactly one of them filed it');
    assert.equal(await projectOf(w.task), w.projectA);
  });

  await t.test('the database keeps one waiting move per task and destination, whoever writes it', async () => {
    const w = await seed('one-pending');
    await refusalOf(() => ask(w, w.coordA));
    const [filed] = await rows(w.ownerId);
    // A second PENDING row for the same move under a different crossing key — the shape a repair
    // script, a mixed-version binary or a forgotten call site could produce.
    await assert.rejects(
      () => admin.query(
        `INSERT INTO "project_handoff_approval" (
           "id","owner_id","from_project_id","to_project_id","kind","subject_task_id",
           "payload_digest","crossing_key","state","title","requested_by_session_id","requested_at")
         VALUES ($1,$2,$3,$4,'MOVE_TASK',$5,repeat('a',64),repeat('b',64),'PENDING','raw',$6,now())`,
        [randomUUID(), w.ownerId, w.projectA, w.projectB, w.task, w.coordB]),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23505' && error.constraint === 'project_handoff_approval_pending_move_idx',
    );
    assert.deepEqual(await rows(w.ownerId), [filed]);
    // The requested criterion is part of the question, so it is frozen with it — and only a move
    // names one.
    await assert.rejects(
      () => admin.query(
        `UPDATE "project_handoff_approval" SET "requested_criterion_definition_id" = $2::uuid
          WHERE "id" = $1::uuid`, [filed.id, w.criterionB]),
      /PROJECT_HANDOFF_IMMUTABLE/,
    );
    await assert.rejects(
      () => admin.query(
        `INSERT INTO "project_handoff_approval" (
           "id","owner_id","from_project_id","to_project_id","kind","subject_task_id",
           "payload_digest","crossing_key","state","title","requested_by_session_id","requested_at",
           "requested_criterion_definition_id")
         VALUES ($1,$2,$3,$4,'FILE_TASK',NULL,repeat('c',64),repeat('d',64),'PENDING','raw',$5,now(),$6)`,
        [randomUUID(), w.ownerId, w.projectA, w.projectB, w.coordA, w.criterionB]),
      (error: { code?: string; constraint?: string }) =>
        error.code === '23514' && error.constraint === 'project_handoff_approval_requested_criterion_chk',
    );
  });

  await t.test('after a refusal the same request stays refused, and a changed one is a new question', async () => {
    const w = await seed('after-no');
    await refusalOf(() => ask(w, w.coordA));
    const [refusedRow] = await rows(w.ownerId);
    await handoffs.decide(w.ownerId, w.ownerId, refusedRow.id, 'DENY', new Date());
    const same = await refusalOf(() => ask(w, w.coordA, { handoff: { reason: 'please' } }));
    assert.equal(same.body.code, 'APPROVAL_DENIED');
    assert.equal(same.body.handoffId, refusedRow.id);
    assert.equal((await rows(w.ownerId)).length, 1);
    // To change what is asked, ask again with the change: a different question, filed afresh.
    const changed = await refusalOf(() => ask(w, w.coordA, { criterionKey: criterionKeyOf(w.criterionB) }));
    assert.equal(changed.body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
    const all = await rows(w.ownerId);
    assert.deepEqual(all.map((row) => row.state), ['DENIED', 'PENDING']);
    assert.equal(changed.body.handoffId, all[1].id);
    assert.equal(all[1].requested_criterion_definition_id, w.criterionB);
    assert.equal(await projectOf(w.task), w.projectA);
  });

  await t.test('re-sending a request the owner has approved moves nothing', async () => {
    // Applying an approved move is the account owner's confirmation; the request door never does,
    // whatever it finds on file.
    const w = await seed('approved');
    await refusalOf(() => ask(w, w.coordA));
    const [question] = await rows(w.ownerId);
    await handoffs.decide(w.ownerId, w.ownerId, question.id, 'APPROVE', new Date());
    const resent = await refusalOf(() => ask(w, w.coordA));
    assert.equal(resent.status, 409);
    assert.equal(resent.body.code, 'MOVE_TASK_ALREADY_APPROVED');
    assert.equal(resent.body.handoffId, question.id);
    assert.equal(resent.body.handoffState, 'APPROVED');
    assert.equal(await projectOf(w.task), w.projectA);
    const [after] = await rows(w.ownerId);
    assert.equal(after.state, 'APPROVED', 'and the yes is not spent by asking again');
    assert.equal(after.applied_task_id, null);
  });

  // ------------------------------------------------------------------------------------------
  // What one request may carry.
  // ------------------------------------------------------------------------------------------

  await t.test('a request carrying any other edit is refused whole, and writes nothing', async () => {
    const w = await seed('extra');
    const before = (await admin.query('SELECT * FROM "task" WHERE "id" = $1::uuid', [w.task])).rows[0];
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ title: 'renamed on the way' }, ['title']],
      [{ status: 'IN_PROGRESS', labels: ['moved'], assigneeId: null }, ['assigneeId', 'labels', 'status']],
      [{ criterionKey: criterionKeyOf(w.criterionB), dependsOnTaskIds: [] }, ['dependsOnTaskIds']],
    ];
    for (const [over, fields] of cases) {
      const refused = await refusalOf(() => ask(w, w.coordA, over));
      assert.equal(refused.status, 400, JSON.stringify(over));
      assert.equal(refused.body.code, 'MOVE_TASK_EXTRA_FIELDS');
      assert.deepEqual(refused.body.fields, fields);
      assert.match(String(refused.body.message), /separate task_update/);
    }
    assert.deepEqual(await rows(w.ownerId), []);
    const after = (await admin.query('SELECT * FROM "task" WHERE "id" = $1::uuid', [w.task])).rows[0];
    assert.deepEqual(after, before, 'the task is exactly as it was');
  });

  await t.test('a target criterion has to be one the target states', async () => {
    const w = await seed('criterion');
    for (const [what, key] of [
      ['a criterion of the project it is leaving', criterionKeyOf(w.criterionA)],
      ['a key naming nothing', criterionKeyOf(randomUUID())],
      ['a blank key', '  '],
    ]) {
      const refused = await refusalOf(() => ask(w, w.coordB, { criterionKey: key }));
      assert.equal(refused.status, 400, what);
      assert.equal(refused.body.code, 'TASK_CRITERION_UNKNOWN', what);
    }
    assert.deepEqual(await rows(w.ownerId), []);
    // One the target states is part of the question.
    await assertFiled(
      w, await refusalOf(() => ask(w, w.coordB, { criterionKey: criterionKeyOf(w.criterionB) })), w.coordB);
    const [row] = await rows(w.ownerId);
    assert.equal(row.requested_criterion_definition_id, w.criterionB);
  });

  // ------------------------------------------------------------------------------------------
  // What makes a move impossible is refused before anybody is asked.
  // ------------------------------------------------------------------------------------------

  await t.test('a task being landed is refused with its own code, and no question is filed', async () => {
    const w = await seed('landing');
    const codebase = randomUUID();
    await admin.query(
      `INSERT INTO "project_codebase"("id","project_id","owner_id","canonical_repo_url","upstream_ref",
         "integration_ref","ref_authority","updated_at")
       VALUES ($1,$2,$3,$4,'refs/heads/main','refs/heads/main','REMOTE',now())`,
      [codebase, w.projectA, w.ownerId, REPO]);
    const job = randomUUID();
    await admin.query(
      `INSERT INTO "project_integration_job"("id","project_id","owner_id","codebase_id","kind","state",
         "task_id","serial_key","target_ref","upstream_ref","source_ref","idempotency_key","updated_at")
       VALUES ($1,$2,$3,$4,'LAND_TASK','QUEUED',$5,$6,'refs/heads/main','refs/heads/main',
         'refs/heads/orbit/move-request',$7,now())`,
      [job, w.projectA, w.ownerId, codebase, w.task, `${REPO}#main#${job}`, `move-request-${job}`]);
    for (const state of ['QUEUED', 'RUNNING']) {
      await admin.query('UPDATE "project_integration_job" SET "state" = $2 WHERE "id" = $1::uuid', [job, state]);
      const refused = await refusalOf(() => ask(w, w.coordA));
      assert.equal(refused.status, 409, state);
      assert.equal(refused.body.code, 'MOVE_TASK_LANDING_IN_FLIGHT', state);
      assert.equal(refused.body.jobId, job, state);
      assert.equal(refused.body.taskId, w.task, state);
      assert.deepEqual(await rows(w.ownerId), [], `a ${state} landing files no question`);
    }
    // Once the job has ended, the same request is asked.
    await admin.query(
      `UPDATE "project_integration_job" SET "state" = 'CANCELLED', "finished_at" = now() WHERE "id" = $1::uuid`,
      [job]);
    await assertFiled(w, await refusalOf(() => ask(w, w.coordA)), w.coordA);
  });

  await t.test('a move that would leave subtasks or verifications behind is refused before asking', async () => {
    const withSubtask = await seed('subtask');
    await insertTask(withSubtask, 'subtask: a part of it', withSubtask.projectA, { parent_task_id: withSubtask.task });
    const subtask = await refusalOf(() => ask(withSubtask, withSubtask.coordA));
    assert.equal(subtask.status, 400);
    assert.match(String(subtask.body.message), /subtask\(s\) that would be left in a different project/);
    assert.deepEqual(await rows(withSubtask.ownerId), []);

    const withCheck = await seed('verification');
    await insertTask(withCheck, 'verification: a check of it', withCheck.projectA, {
      verifies_task_id: withCheck.task, completion_criterion: 'VERIFICATION',
    });
    const check = await refusalOf(() => ask(withCheck, withCheck.coordB));
    assert.equal(check.status, 400);
    assert.match(String(check.body.message), /verification\(s\) that would be left in a different project/);
    assert.deepEqual(await rows(withCheck.ownerId), []);
    assert.equal(await projectOf(withCheck.task), withCheck.projectA);
  });

  await t.test('a settled destination is R8, as it always was', async () => {
    const w = await seed('settled');
    await admin.query(`UPDATE "project" SET "status"='CANCELLED'::"project_status" WHERE "id"=$1::uuid`,
      [w.projectB]);
    const refused = await refusalOf(() => ask(w, w.coordA));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'PROJECT_REOPEN_REQUIRED');
    assert.equal(refused.body.rule, 'R8_SETTLED_PROJECT');
    assert.deepEqual(await rows(w.ownerId), []);
  });

  // ------------------------------------------------------------------------------------------
  // The owner, and the person answering.
  // ------------------------------------------------------------------------------------------

  await t.test('the account owner\'s own move, with no session, is untouched', async () => {
    const w = await seed('owner');
    const moved = await tasks.update(w.ownerId, w.plain, {
      projectId: w.projectB, handoff: { reason: 'the owner says so' },
    } as never) as { projectId: string | null };
    assert.equal(moved.projectId, w.projectB);
    assert.equal(await projectOf(w.plain), w.projectB);
    assert.deepEqual(await rows(w.ownerId), [], 'the owner asks nobody');
  });

  await t.test('the crossings list shows a person what they are answering', async () => {
    const w = await seed('card');
    // A filing beside the move, so the list is read with both shapes in it.
    await refusalOf(() => tasks.create(w.ownerId, {
      title: 'card: new work for B', projectId: w.projectB, handoff: { reason: 'it serves B' },
      completionCriterion: 'EVIDENCE_JUDGMENT',
    } as never, { type: 'AGENT', id: w.ownerId } as never, w.coordA));
    await refusalOf(() => ask(w, w.coordB, { criterionKey: criterionKeyOf(w.criterionB) }));
    for (const end of [w.projectA, w.projectB]) {
      const listed = await handoffs.listForProject(w.ownerId, end);
      assert.equal(listed.length, 2, 'both ends list both questions');
      const move = listed.find((row) => row.kind === 'MOVE_TASK')!;
      assert.deepEqual(move.subjectTask, { id: w.task, title: w.taskTitle });
      assert.equal(move.fromProjectId, w.projectA);
      assert.equal(move.toProjectId, w.projectB);
      assert.deepEqual(move.fromProject, { title: 'card project A', status: 'OPEN' });
      assert.deepEqual(move.toProject, { title: 'card project B', status: 'OPEN' });
      assert.deepEqual(move.requestedCriterion,
        { key: criterionKeyOf(w.criterionB), text: 'card: what B wants' });
      assert.deepEqual(move.withdrawnCriterion,
        { key: criterionKeyOf(w.criterionA), text: 'card: what A wants' },
        'the criterion of the source the move takes back');
      assert.equal(move.requestedBySessionId, w.coordB);
      assert.deepEqual(move.requestedBySession, { id: w.coordB, title: 'card: coordinator of B' });
      assert.equal(move.reason, 'it serves B');
      assert.equal(move.state, 'PENDING');
      // The filing keeps the shape the web card already reads, with the move-only parts empty.
      const filing = listed.find((row) => row.kind === 'FILE_TASK')!;
      assert.equal(filing.title, 'card: new work for B');
      assert.equal(filing.subjectTask, null);
      assert.equal(filing.requestedCriterion, null);
      assert.equal(filing.withdrawnCriterion, null);
      assert.deepEqual(filing.requestedBySession, { id: w.coordA, title: 'card: coordinator of A' });
      for (const row of listed) {
        for (const field of ['id', 'fromProjectId', 'toProjectId', 'kind', 'subjectTaskId',
          'crossingKey', 'state', 'title', 'reason', 'requestedAt', 'decidedAt', 'expiresAt']) {
          assert.ok(field in row, `${row.kind} rows still carry ${field}`);
        }
      }
    }
  });
});
