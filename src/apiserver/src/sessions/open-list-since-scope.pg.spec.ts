import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readOpenListVersion } from './open-list-version';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';

/**
 * One workspace's `since=` read (`GET /sessions?runnerId=R&workspaceId=B&view=open&since=`, the web
 * console's column) against writes elsewhere on the same account.
 *
 * The account's data version moves with every write of the account (open-list-version.ts), and
 * while anything runs that is about once a second. A `since=` read that found its cursor's version
 * gone used to build the whole workspace list (~550 rows in production) to learn, nearly every time,
 * that nothing in it had moved. Here a write the B list does not show must leave B's read without
 * any row built (`listRows` not called); a write it does show must come back as exactly that row,
 * with only that row built; and writers in two workspaces must not wait for each other.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/open-list-since-scope.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated ids.
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

function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

type Row = { id: string; title: string; taskTitle?: string | null };
type Delta =
  | { full: true; sessions: Row[]; cursor: string }
  | { full: false; upserts: Row[]; removedIds: string[]; order?: string[]; cursor: string };

interface Fixture {
  db: PrismaClient;
  ownerId: string;
  runnerId: string;
  a: string;
  b: string;
  /** A's sessions: one mid-turn, one parked; the first carries `taskA`. */
  a1: string;
  a2: string;
  /** B's sessions, both parked; the second carries `taskB`. */
  b1: string;
  b2: string;
  taskA: string;
  taskB: string;
  /** How many rows each `listRows` call built, since the last `take()`. */
  take(): number[];
  /** One `since=` read of B's column through the controller. */
  readB(since: string): Promise<Delta>;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const sessions = new SessionsService(
    db as unknown as PrismaService,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  // Every build of list rows goes through listRows; count what each one built.
  let built: number[] = [];
  const service = sessions as unknown as { listRows: (...args: unknown[]) => Promise<unknown[]> };
  const listRows = service.listRows.bind(sessions);
  service.listRows = async (...args: unknown[]) => {
    const rows = await listRows(...args);
    built.push(rows.length);
    return rows;
  };
  const controller = new SessionsController(sessions, {} as never, {} as never, {} as never, {} as never, {} as never);

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const [a, b] = [randomUUID(), randomUUID()];
  await db.user.create({
    data: { id: ownerId, email: `ols-${ownerId}@open-list-scope.invalid`, name: 'ols', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'ols-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(Date.now() + 3_600_000),
    },
  });
  for (const [id, name] of [[a, 'ols-a'], [b, 'ols-b']]) {
    await db.workspace.create({ data: { id, ownerId, runnerId, name, enabled: true } });
  }
  const task = async (title: string) => (await db.task.create({
    data: { ownerId, title, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'OWNER_CONFIRMED' },
  })).id;
  const taskA = await task('ols task a');
  const taskB = await task('ols task b');
  const session = async (workspaceId: string, title: string, status: RunStatus, taskId?: string) =>
    (await db.session.create({
      data: {
        ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'ols',
        provider: 'claude', providerBuiltin: true, turnState: turnStateOfWord(status), startedAt: new Date(), taskId,
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    })).id;
  const a1 = await session(a, 'a1', RunStatus.RUNNING, taskA);
  const a2 = await session(a, 'a2', RunStatus.AWAITING_INPUT);
  const b1 = await session(b, 'b1', RunStatus.AWAITING_INPUT);
  const b2 = await session(b, 'b2', RunStatus.AWAITING_INPUT, taskB);

  const readB = async (since: string) => {
    const res = { setHeader: () => undefined, status: () => res };
    return await controller.list(
      { userId: ownerId } as never,
      runnerId, b, undefined, undefined, 'open', undefined,
      undefined, undefined, since, undefined, res as never,
    ) as unknown as Delta;
  };
  const take = () => {
    const out = built;
    built = [];
    return out;
  };
  return { db, ownerId, runnerId, a, b, a1, a2, b1, b2, taskA, taskB, take, readB };
}

/** B's first read: the whole column and a cursor. */
async function baseline(f: Fixture): Promise<string> {
  const first = await f.readB('');
  assert.equal(first.full, true);
  assert.deepEqual(new Set((first as Extract<Delta, { full: true }>).sessions.map((row) => row.id)), new Set([f.b1, f.b2]));
  f.take();
  return first.cursor;
}

function delta(answer: Delta): Extract<Delta, { full: false }> {
  assert.equal(answer.full, false, `expected a delta, got ${JSON.stringify(answer)}`);
  return answer as Extract<Delta, { full: false }>;
}

test('(i) a write the B column does not show leaves its since= read with nothing built', { skip }, async (t) => {
  const f = await fixture(t);
  let cursor = await baseline(f);
  const otherProject = await f.db.project.create({ data: { ownerId: f.ownerId, title: 'ols elsewhere' } });
  const writes: Array<[string, () => Promise<unknown>]> = [
    ["an A session's title", () => f.db.session.update({ where: { id: f.a2 }, data: { title: 'a2 renamed' } })],
    ["an A session's status", () => f.db.session.update({ where: { id: f.a1 }, data: { turnState: null } })],
    ["an A session's last activity", () => f.db.$executeRaw`UPDATE session SET last_turn_at = now() WHERE id = ${f.a2}::uuid`],
    ['a turn on an A session', () => f.db.conversationTurn.create({
      data: { sessionId: f.a1, seq: 1, kind: 'message', status: 'IN_FLIGHT', clientTurnId: randomUUID(), deliveredAt: new Date() },
    })],
    ['an approval card on an A session', () => f.db.approval.create({
      data: { sessionId: f.a1, toolName: 'Bash', input: {}, status: 'PENDING' },
    })],
    ["the task an A session carries", () => f.db.task.update({ where: { id: f.taskA }, data: { title: 'task a renamed' } })],
    ['a task no session carries', () => f.db.task.create({
      data: { ownerId: f.ownerId, title: 'ols loose', creatorType: 'USER', creatorId: f.ownerId, completionCriterion: 'OWNER_CONFIRMED' },
    })],
    ['a project nothing in B belongs to', () => f.db.project.update({ where: { id: otherProject.id }, data: { title: 'ols elsewhere renamed' } })],
    ['a new session in A', () => f.db.session.create({
      data: {
        ownerId: f.ownerId, creatorId: f.ownerId, workspaceId: f.a, assignedRunnerId: f.runnerId, title: 'a3', prompt: 'ols',
        turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      },
    })],
    ['an A session finishing', () => f.db.session.update({ where: { id: f.a2 }, data: { completedAt: new Date() } })],
  ];
  for (const [label, write] of writes) {
    const before = await readOpenListVersion(f.db as never, f.ownerId);
    await write();
    // The case means something only if the account's version moved: that is what used to build.
    assert.notEqual(await readOpenListVersion(f.db as never, f.ownerId), before, `${label}: the account version did not move`);
    const answer = delta(await f.readB(cursor));
    assert.deepEqual(f.take(), [], `${label}: B's since= read built list rows`);
    assert.deepEqual(answer, { full: false, upserts: [], removedIds: [], cursor }, `${label}: B's read was not an empty delta`);
    cursor = answer.cursor;
  }
});

test('(ii) a write the B column shows comes back as exactly that change, and only that row is built', { skip }, async (t) => {
  const f = await fixture(t);
  let cursor = await baseline(f);
  // Writes in A first, so the version the cursor was built at is long gone.
  await f.db.session.update({ where: { id: f.a2 }, data: { title: 'a2 renamed' } });

  await f.db.session.update({ where: { id: f.b1 }, data: { title: 'b1 renamed' } });
  let answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts.map((row) => [row.id, row.title]), [[f.b1, 'b1 renamed']]);
  assert.deepEqual(answer.removedIds, []);
  assert.deepEqual(f.take(), [1], 'B rebuilt more than the one row that moved');
  cursor = answer.cursor;

  // A row's task is another table: renaming it reaches the row that carries it, and only that one.
  await f.db.task.update({ where: { id: f.taskB }, data: { title: 'task b renamed' } });
  answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts.map((row) => [row.id, row.taskTitle]), [[f.b2, 'task b renamed']]);
  assert.deepEqual(answer.removedIds, []);
  assert.deepEqual(f.take(), [1], 'a task rename rebuilt more than the row that carries it');
  cursor = answer.cursor;

  // A row waiting on another session's reply names that session. Renaming it — a write in A, to a
  // row B does not list — moves the B row that names it, and that row alone is built.
  const turn = await f.db.conversationTurn.create({
    data: { sessionId: f.a2, seq: 1, kind: 'message', status: 'IN_FLIGHT', clientTurnId: randomUUID() },
  });
  await f.db.sessionRequest.create({
    data: {
      ownerId: f.ownerId, fromSessionId: f.b1, toSessionId: f.a2, turnId: turn.id, clientTurnId: turn.clientTurnId,
      kind: 'MESSAGE', requestPreview: 'ols?', replyBy: new Date(Date.now() + 3_600_000),
    },
  });
  answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts.map((row) => row.id), [f.b1], 'the request did not reach the row that asked it');
  assert.deepEqual(f.take(), [1]);
  cursor = answer.cursor;
  await f.db.session.update({ where: { id: f.a2 }, data: { title: 'a2 asked' } });
  answer = delta(await f.readB(cursor));
  assert.deepEqual(
    answer.upserts.map((row) => [row.id, (row as { awaitingReplyFrom?: Array<{ title: string }> }).awaitingReplyFrom?.map((peer) => peer.title)]),
    [[f.b1, ['a2 asked']]],
  );
  assert.deepEqual(f.take(), [1]);
  cursor = answer.cursor;

  // A row leaving the column is a removal and builds nothing.
  await f.db.session.update({ where: { id: f.b2 }, data: { completedAt: new Date() } });
  answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts, []);
  // Removed ids are spelled publicly by the service itself; rows are rewritten later, by the interceptor.
  assert.deepEqual(answer.removedIds, [uuidToBase62(f.b2)]);
  assert.deepEqual(f.take(), []);
  cursor = answer.cursor;

  // A row arriving is built alone and placed in the order.
  const b3 = (await f.db.session.create({
    data: {
      ownerId: f.ownerId, creatorId: f.ownerId, workspaceId: f.b, assignedRunnerId: f.runnerId, title: 'b3', prompt: 'ols',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
    },
  })).id;
  answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts.map((row) => row.id), [b3]);
  assert.ok(answer.order, 'a new row did not send the order');
  assert.deepEqual(f.take(), [1]);

  // Whatever the deltas said adds up to what a whole read answers now.
  const whole = await f.readB('');
  assert.equal(whole.full, true);
  assert.deepEqual(
    (whole as Extract<Delta, { full: true }>).sessions.map((row) => [row.id, row.title]).sort(),
    [[f.b1, 'b1 renamed'], [b3, 'b3']].sort(),
  );
});

/**
 * 0487's guarantee, held across workspaces: a writer in B never waits for an open transaction in A
 * (and the other way round), on the session rows or on the version counters. `lock_timeout` turns a
 * wait into an error (55P03), so a writer that queues fails here instead of only being slow.
 */
test('(iii) writers in two workspaces never wait for each other', { skip }, async (t) => {
  const f = await fixture(t);
  const cursor = await baseline(f);
  const connect = async () => {
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    t.after(() => client.end());
    return client;
  };
  const inA = await connect();
  const inB = await connect();
  for (const client of [inA, inB]) {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '500ms'`);
  }
  await inA.query(`UPDATE session SET title = 'a1 held' WHERE id = $1`, [f.a1]);
  await inA.query(`UPDATE task SET title = 'task a held' WHERE id = $1`, [f.taskA]);
  // B writes the same tables while A's transaction is open, then A writes again beside B's.
  await inB.query(`UPDATE session SET title = 'b1 beside' WHERE id = $1`, [f.b1]);
  await inB.query(`UPDATE task SET title = 'task b beside' WHERE id = $1`, [f.taskB]);
  await inA.query(`UPDATE session SET title = 'a2 beside' WHERE id = $1`, [f.a2]);
  await inB.query(`INSERT INTO conversation_turn (id, session_id, seq, kind, status, client_turn_id, created_at)
                   VALUES (gen_random_uuid(), $1, 1, 'message', 'IN_FLIGHT', gen_random_uuid()::text, now())`, [f.b1]);
  await inA.query(`INSERT INTO conversation_turn (id, session_id, seq, kind, status, client_turn_id, created_at)
                   VALUES (gen_random_uuid(), $1, 1, 'message', 'IN_FLIGHT', gen_random_uuid()::text, now())`, [f.a1]);
  await inB.query('COMMIT');

  // B's read sees B's committed writes while A's are still open, and builds only those rows.
  const answer = delta(await f.readB(cursor));
  assert.deepEqual(
    answer.upserts.map((row) => [row.id, row.title, row.taskTitle]).sort(),
    [[f.b1, 'b1 beside', null], [f.b2, 'b2', 'task b beside']].sort(),
  );
  assert.deepEqual(f.take(), [2]);
  await inA.query('COMMIT');
  // A's commit is nothing B shows.
  assert.deepEqual(await f.readB(answer.cursor), { full: false, upserts: [], removedIds: [], cursor: answer.cursor });
  assert.deepEqual(f.take(), []);
});

