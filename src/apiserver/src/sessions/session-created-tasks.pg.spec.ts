/**
 * `GET /api/sessions/:id/created-tasks` — the "Tasks created here" row above a session's composer —
 * and `?creatorSessionId=` on `GET /api/tasks`, `/tasks/page` and `/tasks/counts`, where that row's
 * "View all in Tasks ›" lands. Over real HTTP, against a real, fully migrated PostgreSQL.
 *
 * HTTP, because two of the claims are about the WIRE: every id in the answer leaves base62, and
 * another account's session answers exactly as a missing one does. PostgreSQL, because the row is
 * a recursive walk and a set of aggregates in one statement, and the task list's filter reaches the
 * database twice (a Prisma where, and the Ready tab's SQL) — a fake store could only agree with
 * itself about any of them.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-created-tasks.pg.spec.ts
 *
 * Not destructive: every row belongs to owners this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  CreatorType,
  type PrismaClient,
  RunnerStatus,
  RunStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { SESSION_CREATED_TASKS_MAX_LIMIT, toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectAttributionService } from '../projects/project-attribution.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionCreatedTasksController } from '../tasks/session-created-tasks.controller';
import {
  SESSION_CREATED_TASKS_MAX_HOPS,
  SessionCreatedTasksService,
} from '../tasks/session-created-tasks.service';
import { TasksController } from '../tasks/tasks.controller';
import { TasksService } from '../tasks/tasks.service';

declare global {
  interface BigInt { toJSON(): string; }
}
// `main.ts` installs this before it creates the app, and the task list needs it: a task row carries
// BIGINT counters that Prisma maps to native BigInts, which `JSON.stringify` throws on.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** Anywhere in the body, in either case: what `PUBLIC_ID_FIELDS` exists to keep off the wire. */
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Creation instants a minute apart, so "newest first" is the fixture's to decide. */
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000);

type Json = Record<string, any>;
type Sent = { status: number; text: string; json: Json };

test('the tasks a session created: its row, its counts, its order, and the task list scoped to it', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  let app: INestApplication | undefined;
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  const prisma = db as unknown as PrismaService;

  // Nothing here starts a run: every read under test is a read. A call that reaches the session
  // layer is a failure, not a no-op.
  const refuse = (what: string) => () => {
    throw new Error(`${what} is out of scope for a read of created tasks`);
  };
  const tasks = new TasksService(
    prisma,
    {
      create: refuse('sessions.create'),
      resume: refuse('sessions.resume'),
      createTurn: refuse('sessions.createTurn'),
      cancel: refuse('sessions.cancel'),
    } as never,
    new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService,
  );
  const createdTasks = new SessionCreatedTasksService(prisma, tasks);

  // ── the world ──────────────────────────────────────────────────────────────────────────────
  async function account(label: string) {
    const ownerId = randomUUID();
    const runnerId = randomUUID();
    const workspaceId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `${label}-${RUN}-${ownerId}@created-tasks.invalid`, name: label, passwordHash: 'x' },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label} runner`,
        tokenHash: `created-tasks-${runnerId}`,
        status: RunnerStatus.ONLINE,
        capabilities: [],
        capabilitiesReportedAt: new Date(),
      },
    });
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId, name: `${label} workspace`, enabled: true },
    });
    return { ownerId, runnerId, workspaceId };
  }
  const me = await account('owner');
  const stranger = await account('stranger');

  async function conversation(ownerId: string, title: string): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, title, prompt: title,
        status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    return id;
  }
  /** The session under test, a second one of the same owner, one that created nothing. */
  const here = await conversation(me.ownerId, 'Coordinate the parking strip');
  const elsewhere = await conversation(me.ownerId, 'Some other conversation');
  const quiet = await conversation(me.ownerId, 'A conversation that filed nothing');
  const theirs = await conversation(stranger.ownerId, 'their conversation');

  const names = new Map<string, string>();
  async function task(
    title: string,
    minute: number,
    extra: {
      status?: TaskStatus;
      /** `here` unless named; null for a task no session created. */
      from?: string | null;
      ownerId?: string;
      projectId?: string;
      assigneeId?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await db.task.create({
      data: {
        id,
        ownerId: extra.ownerId ?? me.ownerId,
        title,
        creatorType: CreatorType.AGENT,
        creatorId: me.workspaceId,
        creatorSessionId: extra.from === undefined ? here : extra.from,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        status: extra.status ?? TaskStatus.OPEN,
        projectId: extra.projectId,
        assigneeId: extra.assigneeId,
        // Ready to run by hand, never by itself: nothing in this file may be dispatched.
        autoRunWhenReady: false,
        createdAt: at(minute),
      },
    });
    names.set(uuidToBase62(id), title);
    return id;
  }
  const supersede = (id: string, by: string) =>
    db.task.update({
      where: { id },
      data: { supersededByTaskId: by, terminalReason: 'SUPERSEDED', supersededAt: new Date() },
    });
  async function run(taskId: string, status: RunStatus) {
    await db.session.create({
      data: {
        id: randomUUID(), ownerId: me.ownerId, creatorId: me.ownerId, taskId,
        title: `run of ${taskId}`, prompt: 'do the thing', status,
        dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      },
    });
  }

  const P = randomUUID();
  const P2 = randomUUID();
  await db.project.create({ data: { id: P, ownerId: me.ownerId, title: 'Parking strip' } });
  await db.project.create({ data: { id: P2, ownerId: me.ownerId, title: 'Runner upkeep' } });

  // One task per group, in and out of order, and two where the order within a group is the point.
  const failedOld = await task('failed, older', 1, { status: TaskStatus.FAILED });
  const failedNew = await task('failed, newer', 2, { status: TaskStatus.FAILED });
  const running = await task('running', 3, { status: TaskStatus.IN_PROGRESS, projectId: P2 });
  await run(running, RunStatus.RUNNING);
  // Marked FAILED by its own run, which has not ended yet: its pill says Running, so it sorts there
  // — and it is still a row whose status is FAILED, so it is counted as one.
  const failedRunning = await task('failed, still running', 4, { status: TaskStatus.FAILED });
  await run(failedRunning, RunStatus.RUNNING);
  const queued = await task('queued', 5);
  await run(queued, RunStatus.PENDING);
  const open = await task('open', 6);
  const inProgress = await task('in progress', 7, { status: TaskStatus.IN_PROGRESS });
  const done1 = await task('done, older', 8, { status: TaskStatus.DONE });
  await run(done1, RunStatus.SUCCEEDED);
  const done2 = await task('done, newer', 9, { status: TaskStatus.DONE });
  const cancelled = await task('cancelled', 10, { status: TaskStatus.CANCELLED });

  // A → B: this session's failure, redone by another session and finished there.
  const A = await task('A: first attempt', 11, { status: TaskStatus.FAILED, projectId: P });
  const B = await task('B: redone elsewhere', 12, { status: TaskStatus.DONE, from: elsewhere, projectId: P });
  await supersede(A, B);
  // C and D → E: two of this session's tasks taken over by one.
  const C = await task('C: dropped', 13, { status: TaskStatus.CANCELLED, projectId: P });
  const D = await task('D: failed', 14, { status: TaskStatus.FAILED, projectId: P });
  const E = await task('E: takes over C and D', 15, { from: elsewhere, projectId: P });
  await supersede(C, E);
  await supersede(D, E);
  // F → G → H: walked to the end, past an attempt that failed too.
  const F = await task('F: first', 16, { status: TaskStatus.FAILED });
  const G = await task('G: second', 17, { status: TaskStatus.FAILED, from: null });
  const H = await task('H: third, done', 18, { status: TaskStatus.DONE, from: null });
  await supersede(F, G);
  await supersede(G, H);
  // I → J, and J deleted: the pointer is gone (SET NULL), the reason stays, and I draws itself.
  const I = await task('I: its successor was deleted', 19, { status: TaskStatus.FAILED });
  const J = await task('J: deleted', 20, { from: null });
  await supersede(I, J);
  await db.task.delete({ where: { id: J } });
  // K → L, both filed here: one row, not two.
  const K = await task('K: filed here, failed', 21, { status: TaskStatus.FAILED });
  const L = await task('L: filed here, redid K', 22, { status: TaskStatus.DONE });
  await supersede(K, L);
  // M0 → M1 → … → M12: longer than the walk goes. The row settles for the tenth hop.
  const M: string[] = [await task('M0', 23, { status: TaskStatus.FAILED })];
  for (let hop = 1; hop <= 12; hop += 1) {
    M.push(await task(`M${hop}`, 23 + hop, { status: hop === 12 ? TaskStatus.DONE : TaskStatus.FAILED, from: null }));
    await supersede(M[hop - 1], M[hop]);
  }
  assert.equal(SESSION_CREATED_TASKS_MAX_HOPS, 10);
  // Startable by hand: the Ready tab's answer, which the task list reads through SQL.
  const ready = await task('ready to run', 36, { assigneeId: me.workspaceId });
  const readyElsewhere = await task('ready, filed elsewhere', 37, { assigneeId: me.workspaceId, from: elsewhere });
  await task('filed elsewhere', 38, { from: elsewhere });
  const theirTask = await task('their task', 39, { ownerId: stranger.ownerId, from: theirs });

  /** Every task this session's agent created — the task list's answer, chains NOT followed. */
  const filedHere = [
    failedOld, failedNew, running, failedRunning, queued, open, inProgress, done1, done2, cancelled,
    A, C, D, F, I, K, L, M[0], ready,
  ];
  /** The row, in order: Failed, Running, Queued, the rest of the unfinished, Done, Cancelled. */
  const ROWS = [
    M[10], I, failedNew, failedOld,
    failedRunning, running,
    queued,
    ready, E, inProgress, open,
    L, H, B, done2, done1,
    cancelled,
  ];

  // ── the app: the real controllers and services, and main.ts's pipe, interceptors and filters ──
  @Module({
    controllers: [SessionCreatedTasksController, TasksController],
    providers: [
      { provide: SessionCreatedTasksService, useValue: createdTasks },
      { provide: TasksService, useValue: tasks },
      { provide: ProjectAttributionService, useValue: {} },
      JwtAuthGuard,
      Reflector,
      {
        provide: JwtService,
        useValue: { verifyAsync: async (token: string) => ({ sub: token === 'stranger' ? stranger.ownerId : me.ownerId }) },
      },
    ],
  })
  class CreatedTasksHarness {}

  app = await NestFactory.create(CreatedTasksHarness, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();

  const answers: Sent[] = [];
  async function get(path: string, who = 'owner'): Promise<Sent> {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${who}` } });
    const text = await response.text();
    let json: Json = {};
    try { json = JSON.parse(text) as Json; } catch { /* asserted on by the caller */ }
    const sent = { status: response.status, text, json };
    if (path.includes('/created-tasks')) answers.push(sent);
    return sent;
  }
  const pub = uuidToBase62;
  const createdTasksOf = (session: string, query = '', who = 'owner') =>
    get(`/api/sessions/${pub(session)}/created-tasks${query}`, who);
  /** Titles rather than ids, so a wrong order reads as one. */
  const titles = (items: Json[]) => items.map((item) => names.get(item.id) ?? item.id);

  const full = await createdTasksOf(here);
  assert.equal(full.status, 200, full.text);
  const rowOf = (id: string) => {
    const rows = full.json.items.filter((item: Json) => item.id === pub(id));
    assert.equal(rows.length, 1, `${names.get(pub(id))} is one row`);
    return rows[0] as Json;
  };
  const isRow = (id: string) => full.json.items.some((item: Json) => item.id === pub(id));

  await t.test('the migration indexes task.creator_session_id, and a lookup by session uses it', async () => {
    const { rows } = await sql.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'task' AND indexname = 'task_creator_session_idx'`,
    );
    assert.equal(rows.length, 1, 'task_creator_session_idx exists');
    assert.match(rows[0].indexdef, /ON \S*task USING btree \(creator_session_id\)$/);
    // Asked of the planner with the statistics current and the alternative priced out: the claim is
    // that this index can answer the lookup at all, which a missing or differently-keyed one cannot.
    await sql.query('ANALYZE task');
    await sql.query('SET enable_seqscan = off');
    try {
      const plan = await sql.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM task WHERE creator_session_id = '${here}'::uuid`,
      );
      assert.match(JSON.stringify(plan.rows[0]), /"Index Name":"task_creator_session_idx"/);
    } finally {
      await sql.query('RESET enable_seqscan');
    }
  });

  await t.test('another account’s session is a 404, exactly like one that does not exist', async () => {
    const other = await createdTasksOf(theirs);
    const nobody = await createdTasksOf(randomUUID());
    assert.equal(other.status, 404, other.text);
    assert.equal(nobody.status, 404, nobody.text);
    assert.equal(other.text, nobody.text, 'the two refusals are the same answer');
    assert.equal((await createdTasksOf(here, '', 'stranger')).status, 404, 'and the other way round');
    // It was ownership that hid it: the stranger reads their own.
    const own = await createdTasksOf(theirs, '', 'stranger');
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.total, 1);
    assert.deepEqual(own.json.items.map((item: Json) => item.id), [pub(theirTask)]);
    // And an id that is no id at all is refused before anything is read.
    assert.equal((await get('/api/sessions/not%20an%20id/created-tasks')).status, 400);
  });

  await t.test('a session that created nothing answers zeros, not an error', async () => {
    const none = await createdTasksOf(quiet);
    assert.equal(none.status, 200, none.text);
    assert.deepEqual(none.json, { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
  });

  await t.test('rows: Failed, Running, Queued, the rest of the unfinished, Done, Cancelled; newest first in each', () => {
    assert.deepEqual(titles(full.json.items), titles(ROWS.map((id) => ({ id: pub(id) }))));
    assert.deepEqual(full.json.items.map((item: Json) => item.id), ROWS.map(pub));
  });

  await t.test('the counts count rows: taken-over tasks are counted as what took them over', () => {
    const { total, running: live, failed, done } = full.json;
    // 19 tasks filed here make 17 rows: E stands for C and D, and L for K.
    assert.deepEqual({ total, running: live, failed, done }, { total: ROWS.length, running: 2, failed: 5, done: 5 });
    const items: Json[] = full.json.items;
    assert.equal(total, items.length, 'the default limit holds every row of this session');
    assert.equal(live, items.filter((item) => item.running).length);
    assert.equal(failed, items.filter((item) => item.status === 'FAILED').length);
    assert.equal(done, items.filter((item) => item.status === 'DONE').length);
  });

  await t.test('a taken-over task is drawn as the end of its chain, which says what it replaces', () => {
    // A → B: the row is B, and the failure it redid is not drawn at all.
    assert.equal(isRow(A), false, 'A is not a row');
    assert.equal(rowOf(B).status, 'DONE');
    assert.deepEqual(rowOf(B).replaces, { id: pub(A), publicId: pub(A), title: 'A: first attempt' });
    assert.equal(rowOf(B).createdAt, at(12).toISOString(), 'the row is B’s, date included');
    // C and D → E: one row, and it replaces the earlier of the two.
    assert.equal(isRow(C) || isRow(D), false, 'neither C nor D is a row');
    assert.equal(rowOf(E).replaces.id, pub(C));
    // F → G → H: to the end of the chain, not one hop.
    assert.equal(isRow(F) || isRow(G), false, 'neither F nor G is a row');
    assert.equal(rowOf(H).replaces.id, pub(F));
    // I's successor was deleted: the chain is broken, and I is its own row again.
    assert.equal(rowOf(I).status, 'FAILED');
    assert.equal(rowOf(I).replaces, null);
    // K → L, both filed here: L once, replacing K; K not at all.
    assert.equal(isRow(K), false, 'K is not a row');
    assert.equal(rowOf(L).replaces.id, pub(K));
    // Past the hop limit the row stops where the walk did.
    assert.equal(rowOf(M[10]).replaces.id, pub(M[0]));
    for (const hop of [0, 9, 11, 12]) assert.equal(isRow(M[hop]), false, `M${hop} is not a row`);
    // Every other row replaces nothing.
    const replacing = new Set([B, E, H, L, M[10]].map(pub));
    for (const item of full.json.items as Json[]) {
      if (!replacing.has(item.id)) assert.equal(item.replaces, null, `${names.get(item.id)} replaces nothing`);
    }
  });

  await t.test('limit cuts the list and nothing else', async () => {
    const three = await createdTasksOf(here, '?limit=3');
    assert.equal(three.status, 200, three.text);
    assert.deepEqual(three.json.items.map((item: Json) => item.id), ROWS.slice(0, 3).map(pub));
    for (const count of ['total', 'running', 'failed', 'done']) {
      assert.equal(three.json[count], full.json[count], `${count} is the session's, not the page's`);
    }
    // `projects` follows the items it is about.
    assert.deepEqual(three.json.projects, []);
    const six = await createdTasksOf(here, '?limit=6');
    assert.deepEqual(six.json.items.map((item: Json) => item.id), ROWS.slice(0, 6).map(pub));
    assert.deepEqual(six.json.projects.map((project: Json) => project.id), [pub(P2)]);
    // At five the page cuts `running` itself, which must still be counted as running.
    const five = await createdTasksOf(here, '?limit=5');
    assert.deepEqual(five.json.items.map((item: Json) => item.id), ROWS.slice(0, 5).map(pub));
    assert.equal(five.json.running, 2, 'a running row the page cut is still counted');

    const most = await createdTasksOf(here, `?limit=${SESSION_CREATED_TASKS_MAX_LIMIT}`);
    assert.equal(most.status, 200, most.text);
    assert.equal(most.json.items.length, ROWS.length);
    for (const bad of ['0', String(SESSION_CREATED_TASKS_MAX_LIMIT + 1), '2.5', 'ten', '-1', '']) {
      const refused = await createdTasksOf(here, `?limit=${bad}`);
      assert.equal(refused.status, 400, `limit=${bad}: ${refused.text}`);
    }
  });

  await t.test('running and queued are withRunning’s, the task list’s and the link card’s', async () => {
    const items: Json[] = full.json.items;
    const flags = await tasks.withRunning(me.ownerId, items.map((item) => ({ id: toUuid(item.id) })), true);
    items.forEach((item, index) => {
      assert.deepEqual(
        { running: item.running, queued: item.queued },
        { running: flags[index].running, queued: flags[index].queued },
        `${names.get(item.id)}: the row's live state is withRunning's`,
      );
    });
    const page = await get(`/api/tasks/page?creatorSessionId=${pub(here)}&limit=200`);
    assert.equal(page.status, 200, page.text);
    for (const listed of page.json.items as Json[]) {
      const row = items.find((item) => item.id === listed.id);
      if (!row) continue;
      assert.deepEqual(
        { running: row.running, queued: row.queued },
        { running: listed.running, queued: listed.queued },
        `${names.get(listed.id)}: the row's live state is the task list's`,
      );
    }
    // Not vacuous: the fixture's live rows are live, and nothing else is.
    const live = items.filter((item) => item.running || item.queued).map((item) => [names.get(item.id), item.running, item.queued]);
    assert.deepEqual(live, [
      ['failed, still running', true, false],
      ['running', true, false],
      ['queued', false, true],
    ]);
  });

  await t.test('?creatorSessionId= on the task list: the tasks filed here, as filed, and nothing else', async () => {
    const expected = filedHere.map(pub).sort();
    const page = await get(`/api/tasks/page?creatorSessionId=${pub(here)}&limit=200`);
    assert.equal(page.status, 200, page.text);
    assert.deepEqual(page.json.items.map((item: Json) => item.id).sort(), expected);
    assert.equal(page.json.total, filedHere.length);
    assert.equal(page.json.counts.total, filedHere.length, 'the tab badges describe the scope');
    // No chain is followed here: the tasks the row draws in their place are filed elsewhere.
    for (const id of [B, E, H, M[10]]) {
      assert.equal(page.json.items.some((item: Json) => item.id === pub(id)), false, `${names.get(pub(id))} is not filed here`);
    }
    const counts = await get(`/api/tasks/counts?creatorSessionId=${pub(here)}`);
    assert.equal(counts.status, 200, counts.text);
    assert.deepEqual(counts.json, page.json.counts, '/tasks/counts reads the same scope');
    assert.equal(counts.json.running, 2);
    assert.equal(counts.json.queued, 1);
    // The Ready tab reaches the database as SQL, not as the Prisma where: the scope has to hold there too.
    const readyTab = await get(`/api/tasks/page?creatorSessionId=${pub(here)}&status=RUNNABLE`);
    assert.equal(readyTab.status, 200, readyTab.text);
    assert.deepEqual(readyTab.json.items.map((item: Json) => item.id), [pub(ready)]);
    assert.equal(counts.json.runnable, 1);
    const everyReady = await get('/api/tasks/page?status=RUNNABLE');
    assert.deepEqual(
      everyReady.json.items.map((item: Json) => item.id).sort(),
      [pub(ready), pub(readyElsewhere)].sort(),
      'unscoped, the other session’s ready task is there — so it was the scope that removed it',
    );
    // The list the native client reads.
    const list = await get(`/api/tasks?creatorSessionId=${pub(here)}`);
    assert.equal(list.status, 200, list.text);
    assert.deepEqual((list.json as unknown as Json[]).map((item) => item.id).sort(), expected);
    // Another account's session narrows to nothing; an id that is none is refused.
    const other = await get(`/api/tasks/page?creatorSessionId=${pub(theirs)}`);
    assert.equal(other.status, 200, other.text);
    assert.equal(other.json.total, 0);
    for (const path of ['/api/tasks/page', '/api/tasks/counts', '/api/tasks']) {
      assert.equal((await get(`${path}?creatorSessionId=not%20an%20id`)).status, 400, path);
    }
  });

  await t.test('every id leaves base62: rows, what they replace, their projects', () => {
    const b = rowOf(B);
    assert.deepEqual(b, {
      id: pub(B),
      publicId: pub(B),
      title: 'B: redone elsewhere',
      status: 'DONE',
      running: false,
      queued: false,
      createdAt: at(12).toISOString(),
      projectId: pub(P),
      projectPublicId: pub(P),
      replaces: { id: pub(A), publicId: pub(A), title: 'A: first attempt' },
    });
    assert.equal(rowOf(running).projectId, pub(P2));
    assert.equal(rowOf(open).projectId, null);
    // Each project once, in the order the rows first name them: `running` (P2) sorts above E (P).
    assert.deepEqual(full.json.projects, [
      { id: pub(P2), publicId: pub(P2), title: 'Runner upkeep' },
      { id: pub(P), publicId: pub(P), title: 'Parking strip' },
    ]);
    assert.ok(answers.length >= 10);
    for (const answer of answers) {
      assert.doesNotMatch(answer.text, UUID_ANYWHERE, answer.text.slice(0, 2_000));
    }
  });
});
