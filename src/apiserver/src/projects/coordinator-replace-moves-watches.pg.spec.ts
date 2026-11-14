/**
 * A replaced coordinator's pending waits go to its successor, over a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/coordinator-replace-moves-watches.pg.spec.ts
 *
 * The outgoing coordinator is completed by a replacement, and a completed observer is refused every
 * delivery (OBSERVER_SESSION_COMPLETED). So `ProjectsService.coordinator(…, 'replace')` re-points
 * every live watch (ACTIVE or PAUSED, the PAUSED one keeping its state) the outgoing session observes to the new one, in the transaction that swaps
 * `project.coordinator_session_id`, and answers how many it moved. A swap that fails or loses the
 * race moves nothing; a watch that has ended, or that another session observes, stays put.
 *
 * The service is the real one over the real database. The session service is the only stand-in:
 * `create` inserts a real session row (it is where the cases below inject a concurrent change, in
 * the window between the candidate's creation and the swap), `complete` writes `completed_at`.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { SessionsService } from '../sessions/sessions.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let harness: Promise<{ db: PrismaClient; sql: Client }> | undefined;
function boot() {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    return { db: prismaClientFor(URL!), sql };
  })();
  return harness;
}

after(async () => {
  const h = await harness?.catch(() => undefined);
  if (!h) return;
  await h.db.$disconnect();
  await h.sql.end();
});

type Inject = (db: PrismaClient, fixture: Fixture, candidate: string) => Promise<void>;

interface Fixture {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  outgoing: string;
  /** Another session of the same owner, observing watches of its own. */
  bystander: string;
  taskId: string;
}

/** The service, real, over the real client; the session service writes real rows. */
function service(db: PrismaClient, fixture: Fixture, inject?: Inject) {
  const published: string[] = [];
  const sessions = {
    complete: async (_owner: string, id: string) => {
      await db.session.update({ where: { id }, data: { completedAt: new Date() } });
      return { ok: true };
    },
    create: async (owner: string, dto: { workspaceId: string; title: string }) => {
      const row = await db.session.create({
        data: {
          ownerId: owner, creatorId: owner, title: dto.title, prompt: 'p', workspaceId: dto.workspaceId,
          status: 'AWAITING_INPUT', dispatchOrigin: 'USER', titleManagedByProject: true,
        },
      });
      await inject?.(db, fixture, row.id);
      return { id: row.id };
    },
    discardProjectCoordinatorCandidate: async (_owner: string, id: string) => {
      await db.session.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },
    announceProjectSessionChanged: () => undefined,
  } as unknown as SessionsService;
  const realtime = new Proxy({}, {
    get: (_t, name) => name === 'publishWatchChanged'
      ? (_owner: string, watchId: string) => { published.push(watchId); }
      : () => undefined,
  }) as unknown as RealtimeService;
  const projects = new ProjectsService(db as unknown as PrismaService, undefined, sessions, realtime);
  return { projects, published };
}

async function fixture(): Promise<Fixture & { db: PrismaClient; sql: Client }> {
  const { db, sql } = await boot();
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${ownerId}@moves-watches.invalid`, name: 'o', passwordHash: 'x' } });
  const workspaceId = (await db.workspace.create({ data: { ownerId, name: 'home' } })).id;
  const projectId = (await db.project.create({ data: { ownerId, title: 'Ship it' } })).id;
  const mk = async (title: string) => (await db.session.create({
    data: { ownerId, creatorId: ownerId, title, prompt: 'p', workspaceId, status: 'AWAITING_INPUT', dispatchOrigin: 'USER' },
  })).id;
  const outgoing = await mk('the coordinator');
  const bystander = await mk('a bystander');
  await db.project.update({ where: { id: projectId }, data: { coordinatorSessionId: outgoing, coordinatorWorkspaceId: workspaceId } });
  const taskId = (await db.task.create({
    data: { ownerId, creatorType: 'USER', creatorId: ownerId, title: 'Fix login redirect', projectId, completionCriterion: 'OWNER_CONFIRMED' },
  })).id;
  return { db, sql, ownerId, projectId, workspaceId, outgoing, bystander, taskId };
}

const TERMINAL = new Set(['MATCHED', 'EXPIRED', 'CANCELLED', 'REVOKED', 'UNRESOLVABLE']);

async function watch(
  f: Fixture & { db: PrismaClient },
  observer: string,
  state: string,
  target: { kind: 'TASK' | 'SESSION'; id: string; leaf: string },
): Promise<string> {
  const expiresAt = new Date(Date.now() + 3_600_000);
  const row = await f.db.watch.create({
    data: {
      ownerId: f.ownerId, observerType: 'SESSION', observerSessionId: observer,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: target.leaf }, action: 'RESUME_SESSION',
      state, generation: state === 'MATCHED' ? 1 : 0, expiresAt,
      nextEvaluateAt: TERMINAL.has(state) ? null : expiresAt,
      targets: { create: [{ targetKind: target.kind, targetResourceId: target.id }] },
    },
  });
  return row.id;
}

async function observers(db: PrismaClient, ids: string[]): Promise<Record<string, string | null>> {
  const rows = await db.watch.findMany({ where: { id: { in: ids } }, select: { id: true, observerSessionId: true } });
  return Object.fromEntries(rows.map((r) => [r.id, r.observerSessionId]));
}

test('(a)+(c) a replacement moves the outgoing coordinator\'s ACTIVE and PAUSED watches to the successor, PAUSED kept, answers how many, and leaves the rest', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active1 = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const active2 = await watch(f, f.outgoing, 'ACTIVE', { kind: 'SESSION', id: f.bystander, leaf: 'SESSION_TURN_SETTLED' });
  const paused = await watch(f, f.outgoing, 'PAUSED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const matched = await watch(f, f.outgoing, 'MATCHED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const cancelled = await watch(f, f.outgoing, 'CANCELLED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const expired = await watch(f, f.outgoing, 'EXPIRED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const others = await watch(f, f.bystander, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const { projects, published } = service(f.db, f);

  const replaced = await projects.coordinator(f.ownerId, f.projectId, undefined, 'replace');

  assert.equal(replaced.created, true);
  assert.notEqual(replaced.sessionId, f.outgoing);
  assert.equal(replaced.movedWatches, 3, 'the answer counts exactly the live watches it moved');
  assert.deepEqual(await observers(f.db, [active1, active2, paused, matched, cancelled, expired, others]), {
    [active1]: replaced.sessionId,
    [active2]: replaced.sessionId,
    [paused]: replaced.sessionId,
    [matched]: f.outgoing,
    [cancelled]: f.outgoing,
    [expired]: f.outgoing,
    [others]: f.bystander,
  });
  assert.deepEqual([...published].sort(), [active1, active2, paused].sort(), 'each moved watch is announced once, after commit');
  assert.equal((await f.db.watch.findUniqueOrThrow({ where: { id: paused } })).state, 'PAUSED', 'a PAUSED watch moves and stays paused');
  const project = await f.db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  assert.equal(project.coordinatorSessionId, replaced.sessionId);

  // A second replacement moves them on again: the successor is now the outgoing one.
  const again = await service(f.db, f).projects.coordinator(f.ownerId, f.projectId, undefined, 'replace');
  assert.equal(again.movedWatches, 3);
  assert.equal((await observers(f.db, [active1]))[active1], again.sessionId);
});

test('(c) a replacement with nothing pending answers zero, and an open that resolves the standing coordinator moves nothing', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const opened = await service(f.db, f).projects.coordinator(f.ownerId, f.projectId);
  assert.deepEqual(opened, { sessionId: f.outgoing, created: false, workspaceId: f.workspaceId, movedWatches: 0 });
  assert.equal((await observers(f.db, [active]))[active], f.outgoing);

  await f.db.watch.update({ where: { id: active }, data: { state: 'CANCELLED', nextEvaluateAt: null } });
  const replaced = await service(f.db, f).projects.coordinator(f.ownerId, f.projectId, undefined, 'replace');
  assert.equal(replaced.created, true);
  assert.equal(replaced.movedWatches, 0);
});

test('(b) a swap that FAILS inside its transaction moves no watch', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  // The landing is disabled between the candidate's creation and the swap: the transaction's own
  // FOR SHARE re-check refuses, and everything it would have written is rolled back.
  const { projects, published } = service(f.db, f, async (db, fx) => {
    await db.workspace.update({ where: { id: fx.workspaceId }, data: { enabled: false } });
  });

  await assert.rejects(projects.coordinator(f.ownerId, f.projectId, undefined, 'replace'));

  assert.equal((await observers(f.db, [active]))[active], f.outgoing);
  assert.deepEqual(published, []);
  const project = await f.db.project.findUniqueOrThrow({ where: { id: f.projectId } });
  assert.equal(project.coordinatorSessionId, f.outgoing);
});

test('(b) a swap that LOSES the race moves no watch', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const active = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  let winner = '';
  // Somebody else binds a coordinator in the window: the compare-and-swap reads a pointer that is
  // no longer the one this call saw, and adopts the winner instead.
  const { projects, published } = service(f.db, f, async (db, fx) => {
    winner = (await db.session.create({
      data: { ownerId: fx.ownerId, creatorId: fx.ownerId, title: 'winner', prompt: 'p', workspaceId: fx.workspaceId, status: 'AWAITING_INPUT', dispatchOrigin: 'USER' },
    })).id;
    await db.project.update({ where: { id: fx.projectId }, data: { coordinatorSessionId: winner } });
  });

  const answer = await projects.coordinator(f.ownerId, f.projectId, undefined, 'replace');

  assert.deepEqual(answer, { sessionId: winner, created: false, workspaceId: f.workspaceId, movedWatches: 0 });
  assert.equal((await observers(f.db, [active]))[active], f.outgoing, 'a lost swap moves nothing');
  assert.deepEqual(published, []);
});

test('(a) a watch that settles while the swap waits on its row lock is not moved', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const settling = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const staying = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  // The evaluator's landing, held open: it owns the watch row FOR UPDATE while it decides.
  const holder = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT "id" FROM "watch" WHERE "id" = $1 FOR UPDATE', [settling]);

    const pending = service(f.db, f).projects.coordinator(f.ownerId, f.projectId, undefined, 'replace');
    // Wait until the swap is queued behind the held row, rather than for a guessed interval.
    for (let i = 0; ; i++) {
      const { rows } = await f.sql.query(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.query LIKE '%UPDATE "watch" SET "observer_session_id"%'`);
      if (rows[0].n > 0) break;
      assert.ok(i < 400, 'the swap never queued behind the held watch row');
      await new Promise((r) => setTimeout(r, 25));
    }
    // The landing settles the watch and commits.
    await holder.query(
      `UPDATE "watch" SET "state" = 'MATCHED', "generation" = 1, "next_evaluate_at" = NULL WHERE "id" = $1`, [settling]);
    await holder.query('COMMIT');

    const replaced = await pending;
    assert.equal(replaced.movedWatches, 1);
    assert.deepEqual(await observers(f.db, [settling, staying]), {
      [settling]: f.outgoing,
      [staying]: replaced.sessionId,
    });
  } finally {
    await holder.end();
  }
});

test('(d) the pending-waits read lists the coordinator\'s live watches, as id + label + paused', { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const onTask = await watch(f, f.outgoing, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_DONE' });
  const onSession = await watch(f, f.outgoing, 'ACTIVE', { kind: 'SESSION', id: f.bystander, leaf: 'SESSION_TURN_SETTLED' });
  const paused = await watch(f, f.outgoing, 'PAUSED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_FAILED' });
  await watch(f, f.outgoing, 'MATCHED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_FAILED' });
  await watch(f, f.outgoing, 'CANCELLED', { kind: 'TASK', id: f.taskId, leaf: 'TASK_FAILED' });
  await watch(f, f.bystander, 'ACTIVE', { kind: 'TASK', id: f.taskId, leaf: 'TASK_FAILED' });
  const { projects } = service(f.db, f);

  assert.deepEqual(await projects.coordinatorPendingWaits(f.ownerId, f.projectId), [
    { id: onTask, label: 'Waiting for "Fix login redirect" to be DONE', paused: false },
    { id: onSession, label: 'Waiting for "a bystander" to finish its turn', paused: false },
    { id: paused, label: 'Waiting for "Fix login redirect" to fail', paused: true },
  ]);

  // After the replacement, the same read asks about the successor — which now holds them.
  await projects.coordinator(f.ownerId, f.projectId, undefined, 'replace');
  assert.deepEqual((await projects.coordinatorPendingWaits(f.ownerId, f.projectId)).map((w) => w.id), [onTask, onSession, paused]);

  // Another owner's read of this project is a 404, not an empty list.
  await assert.rejects(projects.coordinatorPendingWaits(randomUUID(), f.projectId), /project not found/);
});
