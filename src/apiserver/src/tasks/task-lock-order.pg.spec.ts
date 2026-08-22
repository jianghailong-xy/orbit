/**
 * §8.6 LO1 through the doors a caller actually has, against a real PostgreSQL.
 *
 * `task-lock-order.spec.ts` proves the rule is stated correctly. `tools/lock-order/barriers.mjs`
 * proves the ORDER is the right one, by driving raw statements and showing the same five barriers
 * deadlock without migration 0136 and do not with it. Neither of them proves the thing that actually broke, which
 * is that `TasksService` TAKES the order — the production incident was not a wrong rule, it was
 * four write paths that each took part of it and one that took none.
 *
 * So everything here goes through the service, with a REAL concurrent holder on the other side:
 * a second connection in an open transaction holding exactly what a Coordinator pass holds. What
 * is measured is what an HTTP caller gets — never a `40P01`, never an untyped 500.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';
import { TaskStatus } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;

interface World {
  ownerId: string;
  projectId: string;
  otherProjectId: string;
  workspaceId: string;
}

const cancelled: string[] = [];

function tasksService(db: PrismaClient): TasksService {
  const realtime = { publishTaskChanged: () => {}, publishForUser: () => {} };
  const sessions = {
    create: () => { throw new Error('no fixture in this spec should start a run'); },
    cancel: async (_owner: string, sessionId: string) => { cancelled.push(sessionId); },
  };
  return new TasksService(db as unknown as PrismaService, sessions as any, realtime as any);
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@h3lo.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  for (const [id, title] of [[projectId, label], [otherProjectId, `${label}-other`]] as const) {
    await db.project.create({ data: { id, ownerId, title } });
    await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
  }
  return { ownerId, projectId, otherProjectId, workspaceId };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  cancelled.length = 0;
  // A TRUNCATE takes ACCESS EXCLUSIVE on every table named, so one leaked holder from a previous
  // test would park this call — and the failure would be reported against the NEXT test rather than
  // the one that leaked. Bounded, so a leak is named where it happened.
  await client.query(`SET lock_timeout = '10s'`);
  await client.query(`
    TRUNCATE "project_event", "project_decision", "project_action", "project_runtime",
             "task_dependency", "task", "session", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * How long the stand-in Coordinator holds the project before letting go, and the outer bound on any
 * single service call made underneath it.
 *
 * The hold is SHORT and it is RELEASED ON A TIMER, and that is the difference between a barrier and
 * a hang. A holder that only lets go once the call it is blocking has returned is not modelling a
 * concurrent transaction — it is modelling a stuck process, and every correct implementation waits
 * on it forever. The first version of this file did exactly that and had to be killed after six
 * minutes with `pg_blocking_pids` pointing straight at the fixture. A real Coordinator pass holds
 * the project for the length of its own transaction and then commits, so that is what this does.
 */
const HOLD_MS = 250;
const CALL_DEADLINE_MS = 20_000;

/** Reject rather than hang, and say what BOTH sides were doing when the deadline passed. */
async function withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `${what} did not settle within ${CALL_DEADLINE_MS}ms — the holder should have released `
            + `after ${HOLD_MS}ms, so this is a wait nothing was going to end`)),
          CALL_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A second connection holding what a Coordinator pass holds — the project row `FOR NO KEY UPDATE`,
 * §8.6 LO1 level 1 — while `run` starts, and letting go `HOLD_MS` later.
 *
 * This is the whole point of the file. A service call that takes the project FIRST waits for this
 * holder, gets it when the holder commits, and finishes. One that takes the TASK first meets 0136's
 * BEFORE guard, which refuses NOWAIT. So the two outcomes this can produce are "it worked" and "a
 * typed 409", and the one it can no longer produce is the deadlock that reached production.
 *
 * Released in `finally` as well as on the timer, so a `run` that throws cannot strand the lock and
 * take the rest of the file down with it.
 */
async function whileProjectIsHeld<T>(
  url: string, projectId: string, what: string, run: () => Promise<T>,
): Promise<T> {
  const holder = new Client({ connectionString: url, application_name: 'h3-holder' });
  await holder.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await holder.query('ROLLBACK').catch(() => {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The holder itself must never be the thing that waits: if some other connection is holding
    // this project, that is a leaked fixture and it should say so immediately rather than join the
    // queue and turn one stuck test into a stuck file.
    await holder.query(`SET lock_timeout = '5s'`);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM "project" WHERE "id" = $1::uuid FOR NO KEY UPDATE', [projectId]);
    const started = run();
    timer = setTimeout(() => { void release(); }, HOLD_MS);
    return await withDeadline(started, what);
  } finally {
    if (timer) clearTimeout(timer);
    await release();
    await holder.end();
  }
}

/** The refusal `fn` produced, or '' if it did not refuse. */
async function message(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e: any) { return String(e?.message ?? e); }
  return '';
}

/**
 * The one property every call in this file has to have: whatever a caller is told, it is never a
 * SQLSTATE, a deadlock, or one of the database's internal markers. That is what the incident was
 * made of — an untyped 500 with a PostgreSQL error code in it, for a condition with a remedy.
 *
 * Deliberately NOT "and it must say retry". A refusal here can be an ordinary rule — a cycle, a
 * concluded verification, a live run — and those are legal outcomes with their own sentences.
 * Which sentence each MARKER turns into is checked exhaustively in `task-lock-order.spec.ts`,
 * where the marker can be produced on purpose instead of hoped for.
 */
function assertNeverLeaks(refusal: string, what: string): void {
  assert.doesNotMatch(refusal, /40P01|deadlock detected/i, `${what} leaked a deadlock`);
  assert.doesNotMatch(refusal, /_BUSY|_MOVED|_CONTENDED|55P03|lock_not_available|P20\d\d/,
    `${what} leaked a database marker instead of a sentence: ${refusal}`);
}

const suite = URL ? test : test.skip;

suite('the Project → Task → Session acquisition order, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  t.after(async () => { await db.$disconnect(); await client.end(); });

  // -------------------------------------------------------------------------------------
  // 1. The four PATCH shapes that took NO lock before this change.
  // -------------------------------------------------------------------------------------

  await t.test('every acceptance-fact PATCH commits against a held project, and none of them 500s',
    async () => {
      await emptyWorld(client);
      const w = await world(db, 'facts');
      const tasks = tasksService(db);

      // Each of these writes ONE acceptance-fact column, and each took the no-lock fast path before
      // this change: `{status}` and `{completionPolicy}` were never in the routing condition at all,
      // and `{verdict: null}` fell out of it because the old predicate asked whether the write
      // REACHED a verdict rather than whether it wrote the column.
      const subject = await tasks.create(w.ownerId, { title: 'subject', projectId: w.projectId });
      const check = await tasks.create(w.ownerId, {
        title: 'check', projectId: w.projectId, verifiesTaskId: subject.id,
      });
      await tasks.update(w.ownerId, check.id, { verdict: 'PASS' as never });

      // A SECOND check, never concluded: re-pointing a verification that has reached a verdict is
      // refused on its own merits (§13.2), so reusing `check` here would measure that rule rather
      // than the lock order.
      const fresh = await tasks.create(w.ownerId, {
        title: 'fresh check', projectId: w.projectId, verifiesTaskId: subject.id,
      });
      const patches: Array<[string, string, Record<string, unknown>]> = [
        ['pure status', subject.id, { status: TaskStatus.DONE }],
        ['pure completionPolicy', subject.id, { completionPolicy: 'ALL_CHILDREN_DONE' }],
        ['verdict REVOCATION', check.id, { verdict: null }],
        ['verifies detach', fresh.id, { verifiesTaskId: null }],
      ];
      for (const [what, id, dto] of patches) {
        const refusal = await whileProjectIsHeld(URL!, w.projectId, what,
          () => message(() => tasks.update(w.ownerId, id, dto as never)));
        assertNeverLeaks(refusal, what);
      }
    });

  await t.test('a status PATCH still writes what it was asked to write', async () => {
    // The order is worth nothing if it changed the outcome. Same PATCH, no holder, asserted.
    await emptyWorld(client);
    const w = await world(db, 'outcome');
    const tasks = tasksService(db);
    const task = await tasks.create(w.ownerId, { title: 't', projectId: w.projectId });
    await tasks.update(w.ownerId, task.id, { status: TaskStatus.DONE } as never);
    const row = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(row.status, 'DONE');
  });

  // -------------------------------------------------------------------------------------
  // 2. The closure: what a write reaches beyond the row it names.
  // -------------------------------------------------------------------------------------

  await t.test('deleting a subject closes out its checks and their runs, and orphans neither',
    async () => {
      await emptyWorld(client);
      const w = await world(db, 'cascade');
      const tasks = tasksService(db);
      const subject = await tasks.create(w.ownerId, { title: 'subject', projectId: w.projectId });
      const check = await tasks.create(w.ownerId, {
        title: 'check', projectId: w.projectId, verifiesTaskId: subject.id,
      });
      // A live run ON THE CHECK — not on the subject. The delete never names this task and never
      // names this session, and both are reached only by following `verifies_task_id`. A closure
      // that stopped at the named row would leave this session attached to a task that no longer
      // exists: `Session.taskId` SET NULL, the run parked at AWAITING_INPUT forever, and no later
      // sweep able to recognise it because there is no task left to read a status from.
      const run = await db.session.create({
        data: {
          ownerId: w.ownerId, creatorId: w.ownerId, title: 'checking', prompt: 'p',
          taskId: check.id, startsTaskWork: true, status: RunStatus.RUNNING,
        },
      });

      const refusal = await whileProjectIsHeld(URL!, w.projectId, 'delete of a subject',
        () => message(() => tasks.remove(w.ownerId, subject.id)));
      assertNeverLeaks(refusal, 'delete of a subject');
      if (refusal) return;   // a typed refusal is a legal outcome; nothing to assert about a no-op

      assert.equal(await db.task.count({ where: { id: { in: [subject.id, check.id] } } }), 0,
        'the check should have CASCADEd away with its subject');
      assert.deepEqual(cancelled, [run.id],
        'the run on the cascaded check was not ended — it would park forever');
      const orphan = await db.session.findUniqueOrThrow({ where: { id: run.id } });
      assert.equal(orphan.taskId, null);
    });

  await t.test('a verdict PATCH takes the subject with it, so the two never move apart', async () => {
    await emptyWorld(client);
    const w = await world(db, 'verdict-scope');
    const tasks = tasksService(db);
    const subject = await tasks.create(w.ownerId, { title: 'subject', projectId: w.projectId });
    const check = await tasks.create(w.ownerId, {
      title: 'check', projectId: w.projectId, verifiesTaskId: subject.id,
    });
    // A verdict applies its consequences to the SUBJECT, which is a second row in a second
    // acceptance projection. Under a held project both rows are reached, so if the closure were
    // only the named task this would be the write that took one project and needed two.
    const refusal = await whileProjectIsHeld(URL!, w.projectId, 'verdict PATCH',
      () => message(() => tasks.update(w.ownerId, check.id, { verdict: 'FAIL' } as never)));
    assertNeverLeaks(refusal, 'verdict PATCH');
    if (!refusal) {
      const row = await db.task.findUniqueOrThrow({ where: { id: check.id } });
      assert.equal(row.verdict, 'FAIL');
      assert.equal(row.verifiesTaskId, subject.id);
    }
  });

  // -------------------------------------------------------------------------------------
  // 3. The dependency replacement — the shape that reached production, twice.
  // -------------------------------------------------------------------------------------

  await t.test('a dependency replacement against a held project is atomic and leaks no 500',
    async () => {
      await emptyWorld(client);
      const w = await world(db, 'deps');
      const tasks = tasksService(db);
      const dependent = await tasks.create(w.ownerId, { title: 'L1', projectId: w.projectId });
      const a = await tasks.create(w.ownerId, { title: 'A', projectId: w.projectId });
      const b = await tasks.create(w.ownerId, { title: 'B', projectId: w.projectId });

      const refusal = await whileProjectIsHeld(URL!, w.projectId, 'dependency replacement',
        () => message(
          () => tasks.update(w.ownerId, dependent.id, { dependsOnTaskIds: [a.id, b.id] } as never)));
      assertNeverLeaks(refusal, 'dependency replacement');

      const edges = await db.taskDependency.findMany({ where: { taskId: dependent.id } });
      // Either both edges or neither: the failure the incident reported rolled back whole, and
      // "whole" is the property worth asserting. A partial replacement is the one outcome that
      // would be silent.
      assert.ok(edges.length === 0 || edges.length === 2,
        `a replacement left ${edges.length} of 2 edges — it was not atomic`);
    });

  await t.test('the same replacement twice writes the same graph, not a second copy', async () => {
    await emptyWorld(client);
    const w = await world(db, 'idem');
    const tasks = tasksService(db);
    const dependent = await tasks.create(w.ownerId, { title: 'L1', projectId: w.projectId });
    const a = await tasks.create(w.ownerId, { title: 'A', projectId: w.projectId });
    // The production report's own remedy was "the identical idempotent request succeeded seconds
    // later". That is only a remedy if repeating it is harmless — a retry that doubled the edges
    // would have turned an intermittent 500 into a silently wrong graph.
    await tasks.update(w.ownerId, dependent.id, { dependsOnTaskIds: [a.id] } as never);
    await tasks.update(w.ownerId, dependent.id, { dependsOnTaskIds: [a.id] } as never);
    const edges = await db.taskDependency.findMany({ where: { taskId: dependent.id } });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].dependsOnTaskId, a.id);
  });

  await t.test('a refused write leaves nothing behind', async () => {
    await emptyWorld(client);
    const w = await world(db, 'zero-effect');
    const tasks = tasksService(db);
    const dependent = await tasks.create(w.ownerId, { title: 'L1', projectId: w.projectId });
    const a = await tasks.create(w.ownerId, { title: 'A', projectId: w.projectId });
    // A cycle is refused by the service, inside the same transaction that took the locks. The
    // point here is not the cycle check — it is that the refusal rolls back the whole acquisition,
    // so no half-written edge and no touched `updated_at` survives it.
    await tasks.update(w.ownerId, dependent.id, { dependsOnTaskIds: [a.id] } as never);
    const before = await db.task.findUniqueOrThrow({ where: { id: a.id } });
    const refusal = await message(
      () => tasks.update(w.ownerId, a.id, { dependsOnTaskIds: [dependent.id] } as never));
    assert.match(refusal, /cycle/i);
    assert.equal(await db.taskDependency.count({ where: { taskId: a.id } }), 0);
    const after = await db.task.findUniqueOrThrow({ where: { id: a.id } });
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  });

  // -------------------------------------------------------------------------------------
  // 4. The move: two projects, one write, and a scope that is re-checked under the locks.
  // -------------------------------------------------------------------------------------

  await t.test('moving a task between projects takes BOTH, in either direction', async () => {
    await emptyWorld(client);
    const w = await world(db, 'move');
    const tasks = tasksService(db);
    const task = await tasks.create(w.ownerId, { title: 'movable', projectId: w.projectId });
    // A move reopens the OLD project and the NEW one from the same AFTER trigger. Held from either
    // side it must behave the same way — an order that only worked when the lower id happened to be
    // the source would be an order that worked by luck.
    for (const held of [w.projectId, w.otherProjectId]) {
      const to = held === w.projectId ? w.otherProjectId : w.projectId;
      const current = await db.task.findUniqueOrThrow({ where: { id: task.id } });
      const target = current.projectId === to ? held : to;
      const refusal = await whileProjectIsHeld(URL!, held, `move while ${held} held`,
        () => message(() => tasks.update(w.ownerId, task.id, { projectId: target } as never)));
      assertNeverLeaks(refusal, `move while ${held === w.projectId ? 'source' : 'destination'} held`);
    }
  });

  // -------------------------------------------------------------------------------------
  // 5. Concurrency through the door, rather than through hand-written SQL.
  // -------------------------------------------------------------------------------------

  await t.test('concurrent service writes over one project settle without a deadlock', async () => {
    await emptyWorld(client);
    const w = await world(db, 'concurrent');
    const tasks = tasksService(db);
    const rows = await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) =>
      tasks.create(w.ownerId, { title: `t${n}`, projectId: w.projectId })));

    // Six writers, three kinds, all over the same project: the closest thing to the production
    // shape that can be produced without a Coordinator. Every one is a separate transaction taking
    // LO1's chain, and `Promise.allSettled` so a refusal is examined rather than thrown away.
    const outcomes = await withDeadline(Promise.allSettled([
      tasks.update(w.ownerId, rows[0].id, { status: TaskStatus.DONE } as never),
      tasks.update(w.ownerId, rows[1].id, { status: TaskStatus.IN_PROGRESS } as never),
      tasks.update(w.ownerId, rows[2].id, { dependsOnTaskIds: [rows[3].id] } as never),
      tasks.update(w.ownerId, rows[4].id, { dependsOnTaskIds: [rows[5].id] } as never),
      tasks.addDependency(w.ownerId, rows[0].id, rows[1].id),
      // `rows[6]`, which nothing else in this batch names. Deleting a task another writer is
      // adding an edge TO is an ordinary foreign-key race with its own outcome, and letting it into
      // this fixture would measure that instead of the acquisition order.
      tasks.remove(w.ownerId, rows[6].id),
    ]), 'six concurrent service writers');
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome.status === 'rejected') {
        assertNeverLeaks(String(outcome.reason?.message ?? outcome.reason), `concurrent writer ${i}`);
      }
    }
    // At least the two independent status writes must have landed: contention may legally refuse a
    // writer, but a run where EVERYTHING refused would mean the order had become a serialization
    // bottleneck rather than an order.
    const settled = outcomes.filter((o) => o.status === 'fulfilled').length;
    assert.ok(settled >= 2, `only ${settled} of 6 concurrent writers settled`);
  });
});
