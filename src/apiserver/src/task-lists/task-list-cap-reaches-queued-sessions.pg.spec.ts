/**
 * A list's concurrency ceiling reaches the runs already queued under the old one.
 *
 * A list doubles as the durable batch the claim's cap gate reads, and a session carries that
 * ceiling as a COPY made when it was dispatched (`session.batch_max_concurrent`). Written nowhere
 * else, a ceiling changed on the list would govern only the dispatches made after it: the rows
 * already queued keep the old number while the list and its revision show the new one, and the gate
 * and the person reading the list disagree with nothing saying so.
 *
 * 2026-09-21 is that failure, and it is what these cases are written against. The WARC list
 * `01a00627-38a3-7752-aebf-7749e3a0ed7d` had its ceiling raised 1 → 4 (`task_list_revision` v18,
 * note: "原值 1 让队列串行化…排在队里的 000_00009/000_00014 要等十几小时"). Nine sessions had been
 * dispatched under 1, one sibling was RUNNING, so the gate's `batchActiveTurns(s) <
 * s.batch_max_concurrent` was `1 < 1` — false — for every one of them. Nothing moved for ten hours,
 * and from outside it read as a runner that would not pick work up.
 *
 * What is asserted, each against the claim's own predicate rather than a restatement of it:
 *
 *   (1) raising the ceiling rewrites the unfinished rows, and the REAL claim then offers them — one
 *       per free unit of the NEW ceiling, which is the thing the old number forbade;
 *   (2) the write is scoped to unfinished work: a finished session of the same batch keeps the
 *       ceiling it ran under;
 *   (3) lowering the ceiling closes the gate again, on the same rows;
 *   (4) a PATCH that does not touch the ceiling writes no session row at all (xmin, the control
 *       that would show an assertion measuring nothing);
 *   (5) clearing the ceiling propagates NOTHING — the rows keep the last ceiling in force rather
 *       than becoming NULL, which `count(*) < NULL` would wedge as never-claimable.
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, PrismaClient, RunnerStatus } from '@prisma/client';

import { batchActiveTurns } from '../common/session-tree-sql';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskListsService } from './task-lists.service';

const URL = process.env.COORDINATOR_PG_URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface Stack {
  db: PrismaClient;
  lists: TaskListsService;
  queue: QueueService;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    publishes,
  );
  return {
    db,
    lists: new TaskListsService(prisma, publishes, sessions),
    // The real claim, not a restatement of its WHERE clause: the whole point is what the queue
    // offers after the ceiling moves, and only this can answer it.
    queue: new QueueService(prisma, publishes),
  };
}

/** An owner with one online runner and one workspace bound to it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: {
      id: ids.ownerId,
      email: `${label}-${RUN}-${ids.ownerId}@cap.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      maxConcurrent: 8,
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-agent`,
      enabled: true,
      workDir: '/tmp',
    },
  });
  return ids;
}

async function seedList(
  db: PrismaClient,
  ids: World,
  title: string,
  maxConcurrent: number,
): Promise<string> {
  const list = await db.taskList.create({
    data: { id: randomUUID(), ownerId: ids.ownerId, title: `${title}-${RUN}`, maxConcurrent },
    select: { id: true },
  });
  return list.id;
}

/** One session of the batch, at the ceiling it is dispatched under. */
async function seedSession(
  db: PrismaClient,
  ids: World,
  listId: string,
  cap: number,
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED',
  title: string,
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      title: `${title}-${RUN}`,
      prompt: 'x',
      ownerId: ids.ownerId,
      creatorId: ids.ownerId,
      workspaceId: ids.workspaceId,
      assignedRunnerId: ids.runnerId,
      batchId: listId,
      batchMaxConcurrent: cap,
      status,
      ...(status === 'RUNNING' ? { startedAt: new Date() } : {}),
    },
  });
  return id;
}

/** The ceilings the batch's sessions carry, by id. */
async function ceilings(db: PrismaClient, listId: string) {
  const rows = await db.session.findMany({
    where: { batchId: listId },
    select: { id: true, batchMaxConcurrent: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  return new Map(rows.map((r) => [r.id, { cap: r.batchMaxConcurrent, status: r.status }]));
}

/** `xmin` per session — the control: an UPDATE moves it, nothing else does. */
async function xmins(db: PrismaClient, listId: string): Promise<Map<string, string>> {
  const rows = await db.$queryRaw<Array<{ id: string; xmin: string }>>`
    SELECT id, xmin::text AS xmin FROM "session" WHERE "batch_id" = ${listId}::uuid`;
  return new Map(rows.map((r) => [r.id, r.xmin]));
}

/**
 * The claim's OWN predicate, over one row.
 *
 * Composed from `batchActiveTurns` rather than written out, so a change to the fragment the claim
 * decides with cannot leave this case asserting a gate that no longer exists.
 */
async function gateOpen(db: PrismaClient, sessionId: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ open: boolean | null }>>(Prisma.sql`
    SELECT (${batchActiveTurns('s')} < s."batch_max_concurrent") AS open
    FROM "session" s WHERE s.id = ${sessionId}::uuid`);
  return rows[0]?.open === true;
}

const claim = (stack: Stack, runnerId: string) =>
  stack.queue.claimSessionForRunner({ id: runnerId, supportedProviders: [] }, 0);

const suite = URL ? test : test.skip;

suite('a list ceiling reaches the runs already queued under it, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const { db, lists, queue } = connect();
  t.after(async () => {
    await db.$disconnect();
  });

  await t.test('raising the ceiling rewrites the queue, and the claim then offers it', async () => {
    // A world of its own per case: the claim is per RUNNER, not per list, so two cases sharing one
    // runner would let the first case's leftovers answer the second case's questions.
    const ids = await world(db, 'raise');
    const listId = await seedList(db, ids, 'raise', 1);
    const running = await seedSession(db, ids, listId, 1, 'RUNNING', 'head');
    const queued = [
      await seedSession(db, ids, listId, 1, 'PENDING', 'q1'),
      await seedSession(db, ids, listId, 1, 'PENDING', 'q2'),
      await seedSession(db, ids, listId, 1, 'PENDING', 'q3'),
    ];
    const done = await seedSession(db, ids, listId, 1, 'SUCCEEDED', 'already-ran');

    // The reported state, before: the gate is shut on every queued row, and the claim agrees.
    for (const id of queued) assert.equal(await gateOpen(db, id), false);
    assert.equal(await claim({ db, lists, queue }, ids.runnerId), null);

    await lists.update(ids.ownerId, listId, { maxConcurrent: 4 });

    const after = await ceilings(db, listId);
    for (const id of queued) {
      assert.equal(after.get(id)!.cap, 4, 'the queued row carries the new ceiling');
      assert.equal(await gateOpen(db, id), true, 'the new ceiling opens the gate');
    }
    // The control on scope: a finished run is not rewritten. Its ceiling only ever meant anything
    // while it could be claimed, and rewriting history is how a revision stops explaining a row.
    assert.equal(after.get(done)!.cap, 1, 'a finished session keeps the ceiling it ran under');
    assert.equal(after.get(running)!.cap, 4, 'a running session can be claimed again, so it moves');

    // The ceiling is the whole difference: the same claim that answered null now hands out work,
    // and it keeps handing it out until the NEW number is spent — not the old one.
    const first = await claim({ db, lists, queue }, ids.runnerId);
    assert.ok(first, 'the claim offers a queued session once the ceiling moves');
    assert.ok(queued.includes(first!.sessionId), 'and it is one of the rows that were queued');
    const second = await claim({ db, lists, queue }, ids.runnerId);
    assert.ok(second, 'and a second one: the new ceiling is 4, not the 1 it was dispatched under');
    assert.notEqual(first!.sessionId, second!.sessionId);
  });

  await t.test('lowering the ceiling closes the gate again', async () => {
    const ids = await world(db, 'lower');
    const listId = await seedList(db, ids, 'lower', 4);
    await seedSession(db, ids, listId, 4, 'RUNNING', 'busy');
    await seedSession(db, ids, listId, 4, 'RUNNING', 'busy2');
    const queued = await seedSession(db, ids, listId, 4, 'PENDING', 'q1');
    assert.equal(await gateOpen(db, queued), true, 'two of four running leaves room');

    await lists.update(ids.ownerId, listId, { maxConcurrent: 1 });

    const after = await ceilings(db, listId);
    assert.equal(after.get(queued)!.cap, 1, 'the queued row follows the ceiling down');
    assert.equal(await gateOpen(db, queued), false, 'one of one running leaves none');
    // The runner is nowhere near its own ceiling here: what shut is the list's, which is the gate
    // the row was queued under and the one the operator moved.
    assert.equal(await claim({ db, lists, queue }, ids.runnerId), null);
  });

  await t.test('a PATCH that does not touch the ceiling writes no session row', async () => {
    const ids = await world(db, 'instructions');
    const listId = await seedList(db, ids, 'instructions', 2);
    const queued = await seedSession(db, ids, listId, 2, 'PENDING', 'q1');
    const before = await xmins(db, listId);

    await lists.update(ids.ownerId, listId, { instructions: 'nothing about concurrency' });

    const after = await xmins(db, listId);
    for (const [id, xmin] of before) {
      assert.equal(after.get(id), xmin, `session ${id} was not written`);
    }
    assert.equal((await ceilings(db, listId)).get(queued)!.cap, 2);
  });

  await t.test('clearing the ceiling propagates nothing, and wedges nothing', async () => {
    const ids = await world(db, 'clear');
    const listId = await seedList(db, ids, 'clear', 2);
    const queued = await seedSession(db, ids, listId, 2, 'PENDING', 'q1');

    await lists.update(ids.ownerId, listId, { maxConcurrent: null });

    // Not NULL: `batch_id` set with a NULL ceiling makes the gate's `count(*) < NULL` evaluate to
    // NULL, and the row could never be claimed at all — the trap the dispatch path guards where it
    // freezes one, and the reason a cleared ceiling is a no-op here rather than a write.
    const after = await ceilings(db, listId);
    assert.equal(after.get(queued)!.cap, 2, 'the last ceiling in force survives the clear');
    assert.equal(await gateOpen(db, queued), true, 'and the row is still claimable');
  });
});
