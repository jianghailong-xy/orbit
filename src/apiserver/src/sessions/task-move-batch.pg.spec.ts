/**
 * A BATCH OF TASK MOVES IS ANSWERED AT ONCE, AND A QUESTION FOR THE OWNER BRINGS ITS SESSION BACK TO
 * OPEN — ON REAL POSTGRESQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/task-move-batch.pg.spec.ts
 *
 * Project 34vUNVEqe1OFz1uHNULOO: a batch of MOVE_TASK requests is answered from one card in the
 * session (`ProjectHandoffService.listMovesForSession` / `decideBatch`), and a session in Completed
 * or Trash with a question waiting comes back to Open (`sessions/return-to-open.ts`).
 *
 *   (a) the read: the moves one session asked out of A into B are one batch, drawn on the asker
 *       (REQUESTER) and on B's coordinator (TARGET_COORDINATOR), with every crossing key; a session
 *       that asked nothing and coordinates nothing draws nothing;
 *   (b) one key in the answer names another crossing: 409 APPROVAL_TARGET_MISMATCH naming it, and
 *       nothing is written — every row PENDING, every task still in A;
 *   (c) one row of the answer was already answered: 409 HANDOFF_ALREADY_ANSWERED naming it, and
 *       nothing is written;
 *   (d) a move a single yes would refuse (a hierarchy split) refuses the whole batch: nothing written;
 *   (e) the whole batch approved: every row APPLIED by the same answer, every task in B, and the
 *       read draws one answered batch;
 *   (f) the whole batch denied: every row DENIED, every task still in A;
 *   (g) a session the moves are not drawn on, and moves of two batches, are refused with nothing
 *       written;
 *   (h) a move filed while B's coordinator is Completed and the asker is in Trash brings both back
 *       to Open; an owner request filed from a Completed session brings it back to Open;
 *   (i) Complete and Trash of a session with a waiting owner request, a waiting move it asked, or a
 *       waiting move into the project it coordinates, each leave it in Open; a session with nothing
 *       waiting, or whose moves are answered, stays where it was put;
 *   (j) the backfill: sessions filed away by any other writer (here, written directly) with something
 *       waiting are brought back by the reaper's sweep, and one with nothing waiting is not.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own account.
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
import { ProjectHandoffService, type TaskMoveBatch } from '../projects/project-handoff.service';
import { OwnerRequestsService } from '../owner-requests/owner-requests.service';
import { OwnerSecretsService } from '../owner-requests/owner-secrets.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import { ReaperService } from '../realtime/reaper.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'task-move-batch-pg-spec-key';

interface World {
  ownerId: string;
  workspaceId: string;
  projectA: string;
  projectB: string;
  coordA: string;
  coordB: string;
  /** A session of no project. */
  other: string;
}

test('a batch of task moves is answered at once; a waiting question brings its session back to Open', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
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
  const db = prisma as unknown as PrismaService;

  /** Every session the services said came back to Open. */
  const reopened: string[] = [];
  const realtime = new Proxy({
    publishSessionCreated: (sessionId: string) => { reopened.push(sessionId); },
  }, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
  }) as unknown as RealtimeService;

  const pushFake = { notifyOwnerRequest: async () => undefined } as unknown as PushService;
  const requests = new OwnerRequestsService(db, new OwnerSecretsService(db), pushFake, undefined, realtime);
  const handoffs = new ProjectHandoffService(db);
  const tasks = new TasksService(prisma as never, {} as never, realtime as never, handoffs);
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const reaper = new ReaperService(db, realtime);

  async function insertSession(ownerId: string, workspaceId: string, title: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "session" ("id","owner_id","workspace_id","title","prompt","creator_id",
         "provider","status","dispatch_origin","updated_at")
       VALUES ($1,$2,$3,$4,'fixture',$2,'claude','AWAITING_INPUT'::"run_status",
         'USER'::"session_dispatch_origin",now())`,
      [id, ownerId, workspaceId, title],
    );
    return id;
  }

  async function insertTask(ownerId: string, title: string, projectId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "task" ("id","owner_id","title","status","project_id","creator_type","creator_id",
         "updated_at","completion_criterion")
       VALUES ($1,$2,$3,'OPEN',$4,'USER',$2,now(),'EVIDENCE_JUDGMENT')`,
      [id, ownerId, title, projectId],
    );
    return id;
  }

  async function seed(label: string): Promise<World> {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await admin.query(
      `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
      [ownerId, `${label}-${ownerId}@task-move-batch.invalid`, label],
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
    const [projectA, projectB] = [randomUUID(), randomUUID()];
    for (const [id, name] of [[projectA, 'A'], [projectB, 'B']]) {
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
    const coordA = await insertSession(ownerId, workspaceId, `${label}: coordinator of A`);
    const coordB = await insertSession(ownerId, workspaceId, `${label}: coordinator of B`);
    const other = await insertSession(ownerId, workspaceId, `${label}: a session of no project`);
    for (const [project, session] of [[projectA, coordA], [projectB, coordB]]) {
      await admin.query('UPDATE "project" SET "coordinator_session_id" = $2::uuid WHERE "id" = $1::uuid',
        [project, session]);
    }
    const text = `${label}: what B wants`;
    await admin.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method","content_hash","created_at","updated_at")
       VALUES ($1,$2,1,$3,'a pg spec',$4,now(),now())`,
      [randomUUID(), projectB, text, createHash('sha256').update(text).digest('hex')],
    );
    return { ownerId, workspaceId, projectA, projectB, coordA, coordB, other };
  }

  async function refusalOf(run: () => Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      await run();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
      const body = error.getResponse();
      return { status: error.getStatus(), body: (typeof body === 'object' ? body : { message: body }) as Record<string, unknown> };
    }
    throw new assert.AssertionError({ message: 'the request was not refused' });
  }

  /** `count` tasks in A, each asked to move to B by `asker`: the request ids, in order. */
  async function askMoves(w: World, asker: string, count: number, label: string) {
    const out: Array<{ taskId: string; handoffId: string }> = [];
    for (let i = 0; i < count; i += 1) {
      const taskId = await insertTask(w.ownerId, `${label} ${i + 1}`, w.projectA);
      const { body } = await refusalOf(() => tasks.update(w.ownerId, taskId, {
        projectId: w.projectB, handoff: { reason: 'it serves B' },
      } as never, asker));
      assert.equal(body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
      out.push({ taskId, handoffId: String(body.handoffId) });
    }
    return out;
  }

  /** The waiting batch on `sessionId` holding `handoffId`. */
  async function batchOf(w: World, sessionId: string, handoffId: string): Promise<TaskMoveBatch> {
    const batches = await handoffs.listMovesForSession(w.ownerId, sessionId);
    const found = batches.find((batch) => batch.moves.some((move) => move.id === handoffId));
    assert.ok(found, `no batch on ${sessionId} holds ${handoffId}`);
    return found;
  }

  const answersOf = (batch: TaskMoveBatch) =>
    batch.moves.map((move) => ({ handoffId: move.id, crossingKey: move.crossingKey }));

  async function states(ids: string[]): Promise<string[]> {
    const { rows } = await admin.query<{ id: string; state: string }>(
      'SELECT "id", "state" FROM "project_handoff_approval" WHERE "id" = ANY($1::uuid[])', [ids]);
    return ids.map((id) => rows.find((row) => row.id === id)!.state);
  }

  async function projectsOf(ids: string[]): Promise<string[]> {
    const { rows } = await admin.query<{ id: string; project_id: string }>(
      'SELECT "id", "project_id" FROM "task" WHERE "id" = ANY($1::uuid[])', [ids]);
    return ids.map((id) => rows.find((row) => row.id === id)!.project_id);
  }

  async function lifecycle(sessionId: string) {
    const { rows } = await admin.query<{ completed_at: Date | null; archived_at: Date | null; deleted_at: Date | null }>(
      'SELECT "completed_at", "archived_at", "deleted_at" FROM "session" WHERE "id" = $1::uuid', [sessionId]);
    return rows[0];
  }

  const w = await seed('batch');
  let moves: Array<{ taskId: string; handoffId: string }> = [];

  await t.test('(a) one asker\'s moves out of A into B are one batch, drawn on the asker and on B\'s coordinator', async () => {
    moves = await askMoves(w, w.coordA, 3, 'batch: a task that belongs to B');

    for (const [sessionId, drawnAs] of [[w.coordA, ['REQUESTER']], [w.coordB, ['TARGET_COORDINATOR']]] as const) {
      const batches = await handoffs.listMovesForSession(w.ownerId, sessionId);
      const waiting = batches.filter((batch) => batch.state === 'PENDING');
      assert.equal(waiting.length, 1, 'three moves from one session into one project are one batch');
      const [batch] = waiting;
      assert.equal(batch.requestedBySessionId, w.coordA);
      assert.equal(batch.fromProjectId, w.projectA);
      assert.equal(batch.toProjectId, w.projectB);
      assert.deepEqual(batch.drawnAs, drawnAs);
      assert.deepEqual(batch.moves.map((move) => move.id), moves.map((move) => move.handoffId));
      for (const move of batch.moves) {
        assert.match(move.crossingKey, /^[0-9a-f]{64}$/);
        assert.ok(move.subjectTask?.title.startsWith('batch: a task that belongs to B'));
      }
    }
    // The session that asked nothing and coordinates nothing draws nothing.
    assert.deepEqual(await handoffs.listMovesForSession(w.ownerId, w.other), []);
  });

  await t.test('(b) one key that names another crossing refuses the batch, and nothing is written', async () => {
    const batch = await batchOf(w, w.coordB, moves[0].handoffId);
    const answers = answersOf(batch);
    answers[1] = { ...answers[1], crossingKey: answers[0].crossingKey };
    for (const decision of ['APPROVE', 'DENY'] as const) {
      const { status, body } = await refusalOf(() => handoffs.decideBatch(
        w.ownerId, w.ownerId, w.coordB, decision, answers, new Date(), { kind: 'LOGIN' } as never,
      ));
      assert.equal(status, 409);
      assert.equal(body.code, 'APPROVAL_TARGET_MISMATCH', decision);
      assert.deepEqual(body.handoffIds, [moves[1].handoffId], `${decision}: the refusal names the one that disagrees`);
      const [conflict] = body.conflicts as Array<Record<string, unknown>>;
      assert.equal(conflict.reason, 'KEY_MISMATCH');
      assert.equal(conflict.crossingKey, batch.moves[1].crossingKey);
    }
    assert.deepEqual(await states(moves.map((m) => m.handoffId)), ['PENDING', 'PENDING', 'PENDING']);
    assert.deepEqual(await projectsOf(moves.map((m) => m.taskId)), [w.projectA, w.projectA, w.projectA]);
  });

  await t.test('(c) one row already answered refuses the batch, and nothing else is written', async () => {
    const before = answersOf(await batchOf(w, w.coordB, moves[0].handoffId));
    await handoffs.decide(w.ownerId, w.ownerId, moves[2].handoffId, 'DENY', new Date());
    for (const decision of ['APPROVE', 'DENY'] as const) {
      const { status, body } = await refusalOf(() => handoffs.decideBatch(
        w.ownerId, w.ownerId, w.coordA, decision, before, new Date(), { kind: 'LOGIN' } as never,
      ));
      assert.equal(status, 409);
      assert.equal(body.code, 'HANDOFF_ALREADY_ANSWERED', decision);
      assert.deepEqual(body.handoffIds, [moves[2].handoffId]);
      assert.equal((body.conflicts as Array<Record<string, unknown>>)[0].state, 'DENIED');
    }
    assert.deepEqual(await states(moves.map((m) => m.handoffId)), ['PENDING', 'PENDING', 'DENIED']);
    assert.deepEqual(await projectsOf(moves.map((m) => m.taskId)), [w.projectA, w.projectA, w.projectA]);
    moves = moves.slice(0, 2);
  });

  await t.test('(d) a move a single yes would refuse refuses the whole batch, and nothing is written', async () => {
    // The second task becomes a subtask of one that stays in A: moving it alone would split the
    // hierarchy, which is what a single yes refuses.
    const parent = await insertTask(w.ownerId, 'batch: a parent that stays in A', w.projectA);
    await admin.query('UPDATE "task" SET "parent_task_id" = $2::uuid WHERE "id" = $1::uuid', [moves[1].taskId, parent]);
    const answers = answersOf(await batchOf(w, w.coordB, moves[0].handoffId));
    assert.equal(answers.length, 2);
    const { status, body } = await refusalOf(() => handoffs.decideBatch(
      w.ownerId, w.ownerId, w.coordB, 'APPROVE', answers, new Date(), { kind: 'LOGIN' } as never,
    ));
    assert.equal(status, 409);
    assert.equal(body.code, 'MOVE_TASK_HIERARCHY_CONFLICT');
    assert.deepEqual(await states(moves.map((m) => m.handoffId)), ['PENDING', 'PENDING'],
      'the first move, which a yes alone would have applied, is not applied either');
    assert.deepEqual(await projectsOf(moves.map((m) => m.taskId)), [w.projectA, w.projectA]);
    await admin.query('UPDATE "task" SET "parent_task_id" = NULL WHERE "id" = $1::uuid', [moves[1].taskId]);
  });

  await t.test('(e) the whole batch approved: every move applied by one answer', async () => {
    const answers = answersOf(await batchOf(w, w.coordB, moves[0].handoffId));
    const now = new Date();
    const rows = await handoffs.decideBatch(
      w.ownerId, w.ownerId, w.coordB, 'APPROVE', answers, now, { kind: 'LOGIN' } as never,
    );
    assert.deepEqual(rows.map((row) => row.state), ['APPLIED', 'APPLIED']);
    assert.deepEqual(rows.map((row) => row.appliedTaskId), moves.map((m) => m.taskId));
    assert.deepEqual(await projectsOf(moves.map((m) => m.taskId)), [w.projectB, w.projectB]);
    const { rows: activity } = await admin.query(
      `SELECT count(*)::int AS n FROM "activity" WHERE "type" = 'task.moved' AND "payload"->>'handoffId' = ANY($1::text[])`,
      [moves.map((m) => m.handoffId)],
    );
    assert.equal(activity[0].n, 2, 'each move recorded as the single path records it');

    for (const sessionId of [w.coordA, w.coordB]) {
      const batches = await handoffs.listMovesForSession(w.ownerId, sessionId);
      assert.equal(batches.filter((batch) => batch.state === 'PENDING').length, 0, 'nothing waits');
      const applied = batches.filter((batch) => batch.state === 'APPLIED');
      assert.equal(applied.length, 1, 'answered together, drawn as one answered batch');
      assert.deepEqual(applied[0].moves.map((move) => move.id), moves.map((m) => m.handoffId));
    }
    // Answering it again is an already-answered batch.
    const { body } = await refusalOf(() => handoffs.decideBatch(
      w.ownerId, w.ownerId, w.coordB, 'APPROVE', answers, new Date(), { kind: 'LOGIN' } as never,
    ));
    assert.equal(body.code, 'HANDOFF_ALREADY_ANSWERED');
  });

  await t.test('(f) the whole batch denied: every move DENIED, every task where it was', async () => {
    const asked = await askMoves(w, w.coordA, 2, 'batch: a task B will not take');
    const answers = answersOf(await batchOf(w, w.coordA, asked[0].handoffId));
    assert.equal(answers.length, 2);
    const rows = await handoffs.decideBatch(w.ownerId, w.ownerId, w.coordA, 'DENY', answers, new Date());
    assert.deepEqual(rows.map((row) => row.state), ['DENIED', 'DENIED']);
    assert.deepEqual(rows.map((row) => row.decidedBy), ['USER', 'USER']);
    assert.deepEqual(await projectsOf(asked.map((m) => m.taskId)), [w.projectA, w.projectA]);
  });

  await t.test('(g) a session the moves are not drawn on, and two batches in one answer, are refused', async () => {
    const asked = await askMoves(w, w.coordA, 1, 'batch: drawn elsewhere');
    const answers = answersOf(await batchOf(w, w.coordA, asked[0].handoffId));
    const notDrawn = await refusalOf(() => handoffs.decideBatch(
      w.ownerId, w.ownerId, w.other, 'DENY', answers, new Date(),
    ));
    assert.equal(notDrawn.status, 400);

    // A second asker in A's scope is not available here, so the second batch is A's moves in the
    // other direction: B's coordinator asks to move a task of B into A.
    const back = await insertTask(w.ownerId, 'batch: a task of B that belongs to A', w.projectB);
    const text = 'batch: what A wants';
    await admin.query(
      `INSERT INTO "project_acceptance_criterion_definition"
         ("id","project_id","ordinal","text","verification_method","content_hash","created_at","updated_at")
       VALUES ($1,$2,1,$3,'a pg spec',$4,now(),now())`,
      [randomUUID(), w.projectA, text, createHash('sha256').update(text).digest('hex')],
    );
    const { body } = await refusalOf(() => tasks.update(w.ownerId, back, {
      projectId: w.projectA, handoff: { reason: 'it serves A' },
    } as never, w.coordB));
    assert.equal(body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
    const other = answersOf(await batchOf(w, w.coordB, String(body.handoffId)));
    const mixed = await refusalOf(() => handoffs.decideBatch(
      w.ownerId, w.ownerId, w.coordB, 'DENY', [...answers, ...other], new Date(),
    ));
    assert.equal(mixed.status, 400);
    assert.deepEqual(await states([asked[0].handoffId, String(body.handoffId)]), ['PENDING', 'PENDING']);
  });

  await t.test('(h) a waiting question brings a Completed or trashed session back to Open', async () => {
    const v = await seed('reopen');
    await admin.query('UPDATE "session" SET "completed_at" = now(), "archived_at" = now() WHERE "id" = $1::uuid', [v.coordB]);
    await admin.query('UPDATE "session" SET "deleted_at" = now() WHERE "id" = $1::uuid', [v.coordA]);
    const untouched = await lifecycle(v.other);
    reopened.length = 0;

    const [asked] = await askMoves(v, v.coordA, 1, 'reopen: a task that belongs to B');
    assert.ok(asked.handoffId);
    for (const sessionId of [v.coordA, v.coordB]) {
      assert.deepEqual(await lifecycle(sessionId), { completed_at: null, archived_at: null, deleted_at: null },
        'back in Open');
      assert.ok(reopened.includes(sessionId), 'and the lists are told, as a restore tells them');
    }
    assert.deepEqual(await lifecycle(v.other), untouched, 'a session the move is not drawn on is not touched');

    // An owner request filed from a Completed session.
    await admin.query('UPDATE "session" SET "completed_at" = now(), "archived_at" = now() WHERE "id" = $1::uuid', [v.other]);
    reopened.length = 0;
    await requests.file(v.ownerId, v.other, {
      kind: 'CONFIRM',
      title: 'Confirm the staging deploy',
      why: 'the deploy waits for it',
    } as never);
    assert.deepEqual(await lifecycle(v.other), { completed_at: null, archived_at: null, deleted_at: null });
    assert.deepEqual(reopened, [v.other]);

    // A session already in Open is left as it is and not announced again.
    reopened.length = 0;
    await requests.file(v.ownerId, v.other, {
      kind: 'CONFIRM',
      title: 'Confirm the production deploy',
      why: 'the deploy waits for it',
    } as never);
    assert.deepEqual(reopened, []);
  });
  const OPEN = { completed_at: null, archived_at: null, deleted_at: null };

  await t.test('(i) Complete and Trash of a session with something waiting leave it in Open', async () => {
    const v = await seed('stay-open');
    // A waiting owner request on `asker`; a waiting move asked by coordA into B (coordinated by coordB).
    const asker = v.other;
    await requests.file(v.ownerId, asker, {
      kind: 'DECISION', title: 'Pick the region', why: 'the deploy waits for it',
      options: [{ label: 'eu' }, { label: 'us' }],
    } as never);
    const [move] = await askMoves(v, v.coordA, 1, 'stay-open: a task that belongs to B');
    const quiet = await insertSession(v.ownerId, v.workspaceId, 'stay-open: nothing waits here');

    for (const [label, file] of [
      ['Complete', (id: string) => sessions.complete(v.ownerId, id)],
      ['Trash', (id: string) => sessions.remove(v.ownerId, id)],
    ] as const) {
      for (const [who, sessionId] of [
        ['the session that asked an owner request', asker],
        ['the session that asked a move', v.coordA],
        ['the coordinator of the move\'s target', v.coordB],
      ] as const) {
        reopened.length = 0;
        await file(sessionId);
        assert.deepEqual(await lifecycle(sessionId), OPEN, `${label}: ${who} is back in Open`);
        assert.deepEqual(reopened, [sessionId], `${label}: ${who} is announced as back in Open`);
      }
      await file(quiet);
      const filed = await lifecycle(quiet);
      assert.ok(label === 'Complete' ? filed.completed_at : filed.deleted_at,
        `${label}: a session with nothing waiting stays where it was put`);
      await sessions.restore(v.ownerId, quiet);
    }

    // Answered, nothing waits: Complete files them for good.
    await handoffs.decide(v.ownerId, v.ownerId, move.handoffId, 'DENY', new Date());
    await sessions.complete(v.ownerId, v.coordB);
    assert.ok((await lifecycle(v.coordB)).completed_at, 'a coordinator whose moves are answered stays Completed');
    await sessions.complete(v.ownerId, v.coordA);
    assert.ok((await lifecycle(v.coordA)).completed_at, 'an asker whose moves are answered stays Completed');
  });

  await t.test('(j) the backfill: the sweep brings back sessions filed away with something waiting', async () => {
    const v = await seed('backfill');
    const asker = v.other;
    await requests.file(v.ownerId, asker, {
      kind: 'CONFIRM', title: 'Confirm the rollout', why: 'the rollout waits for it',
    } as never);
    await askMoves(v, v.coordA, 1, 'backfill: a task that belongs to B');
    const quiet = await insertSession(v.ownerId, v.workspaceId, 'backfill: nothing waits here');
    // Filed away by a path that does not bring anything back, as sessions were before this existed.
    await admin.query(
      'UPDATE "session" SET "completed_at" = now(), "archived_at" = now() WHERE "id" = ANY($1::uuid[])',
      [[asker, v.coordB, quiet]],
    );
    await admin.query('UPDATE "session" SET "deleted_at" = now() WHERE "id" = $1::uuid', [v.coordA]);

    reopened.length = 0;
    const moved = await reaper.returnWaitingSessions();
    assert.ok(moved >= 3);
    for (const sessionId of [asker, v.coordA, v.coordB]) {
      assert.deepEqual(await lifecycle(sessionId), OPEN, 'back in Open');
      assert.ok(reopened.includes(sessionId), 'and announced');
    }
    assert.ok((await lifecycle(quiet)).completed_at, 'a session with nothing waiting is left in Completed');
    assert.ok(!reopened.includes(quiet));
    reopened.length = 0;
    await reaper.returnWaitingSessions();
    for (const sessionId of [asker, v.coordA, v.coordB, quiet]) {
      assert.ok(!reopened.includes(sessionId), 'a second sweep finds nothing more of these to move');
    }
  });
});
