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
import { movedScopes, openListTickStatement } from '../realtime/open-list-hints';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';
import { readCreatedTasksActive } from './task-work-carrier';

/**
 * A list row's count of the tasks its session created that are running or queued now (`createdTasksActive`,
 * docs/mocks/session-row-running-tasks). The count is other sessions' state: the runs that carry those tasks, here in
 * another workspace. So beside the count itself this holds the two paths that keep it fresh when only a run moved:
 * a `since=` read of the creator's column rebuilds the creator's row (its probe token reads the count), and the
 * list_changed poller names the creator's workspace (rule 5), also on the tick after the run stopped carrying.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-row-created-tasks.pg.spec.ts
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

type Row = { id: string; title: string; createdTasksActive?: { running: number; queued: number } | null };
type Delta =
  | { full: true; sessions: Row[]; cursor: string }
  | { full: false; upserts: Row[]; removedIds: string[]; order?: string[]; cursor: string };

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const sessions = new SessionsService(
    db as unknown as PrismaService,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
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
  // The creator sits in B; the runs of its tasks in A, which B's column does not list.
  const [a, b] = [randomUUID(), randomUUID()];
  await db.user.create({
    data: { id: ownerId, email: `srct-${ownerId}@row-created-tasks.invalid`, name: 'srct', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'srct-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(Date.now() + 3_600_000),
    },
  });
  for (const [id, name] of [[a, 'srct-a'], [b, 'srct-b']]) {
    await db.workspace.create({ data: { id, ownerId, runnerId, name, enabled: true } });
  }
  const session = async (workspaceId: string, title: string, status: RunStatus, taskId?: string) =>
    (await db.session.create({
      data: {
        ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'srct',
        provider: 'claude', providerBuiltin: true, turnState: turnStateOfWord(status), startedAt: new Date(), taskId,
        dispatchOrigin: SessionDispatchOrigin.USER,
      },
    })).id;
  const creator = await session(b, 'creator', RunStatus.AWAITING_INPUT);
  const plain = await session(b, 'plain', RunStatus.AWAITING_INPUT);
  const task = async (title: string) => (await db.task.create({
    data: {
      ownerId, title, creatorType: 'USER', creatorId: ownerId, creatorSessionId: creator,
      completionCriterion: 'OWNER_CONFIRMED',
    },
  })).id;
  const running = await task('srct running');
  const queued = await task('srct queued');
  // Created here and never started: no run carries it, so it is not counted.
  await task('srct idle');
  const runA = await session(a, 'run of running', RunStatus.RUNNING, running);
  const runQ = await session(a, 'run of queued', RunStatus.PENDING, queued);

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
  return { db, ownerId, a, b, creator, plain, running, queued, runA, runQ, readB, take };
}

function delta(answer: Delta): Extract<Delta, { full: false }> {
  assert.equal(answer.full, false, `expected a delta, got ${JSON.stringify(answer)}`);
  return answer as Extract<Delta, { full: false }>;
}

test('a row counts the tasks its session created that a run carries, running and queued apart', { skip }, async (t) => {
  const f = await fixture(t);
  const counts = await readCreatedTasksActive(f.db as never, f.ownerId, null);
  assert.deepEqual([...counts], [[f.creator, { running: 1, queued: 1 }]]);
  const first = await f.readB('');
  assert.equal(first.full, true);
  const rows = new Map((first as Extract<Delta, { full: true }>).sessions.map((row) => [row.id, row.createdTasksActive]));
  assert.deepEqual(rows.get(f.creator), { running: 1, queued: 1 });
  // None is null, not zeros: the client draws nothing.
  assert.equal(rows.get(f.plain), null);
});

test("a run in another workspace moving rebuilds the creator's row, and that row alone", { skip }, async (t) => {
  const f = await fixture(t);
  const first = await f.readB('');
  f.take();
  let cursor = first.cursor;

  // The running task's run parks with nothing to wake it: it no longer carries its task.
  await f.db.session.update({ where: { id: f.runA }, data: { turnState: null } });
  let answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts.map((row) => [row.id, row.createdTasksActive]), [[f.creator, { running: 0, queued: 1 }]]);
  assert.deepEqual(f.take(), [1], 'more than the creator row was built');
  cursor = answer.cursor;

  // The queued one starts: it counts as running now.
  await f.db.session.update({ where: { id: f.runQ }, data: { turnState: turnStateOfWord(RunStatus.RUNNING) } });
  answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts.map((row) => [row.id, row.createdTasksActive]), [[f.creator, { running: 1, queued: 0 }]]);
  cursor = answer.cursor;

  // Its run ends: nothing runs, and the row says none.
  await f.db.session.update({ where: { id: f.runQ }, data: { turnState: null, finishedAt: new Date() } });
  answer = delta(await f.readB(cursor));
  assert.deepEqual(answer.upserts.map((row) => [row.id, row.createdTasksActive]), [[f.creator, null]]);
  assert.deepEqual(answer.removedIds, []);
});

test("the list_changed poller names the creator's workspace when a run moves, also on the tick after it stopped", { skip }, async (t) => {
  const f = await fixture(t);
  const pairsOf = async () => {
    const rows = await f.db.$queryRaw<Array<{ kind: string; owner_id: string; a: string; b: string }>>(
      openListTickStatement([f.ownerId], []),
    );
    return rows.filter((row) => row.kind === 't').map((row) => [row.a, row.b] as [string, string]);
  };
  const carrying = await pairsOf();
  assert.deepEqual(carrying, [[f.a, f.b]], 'one pair per workspace pair, however many runs');

  // Only A's own key moved (a run in A wrote): B is named through the pair.
  const before = new Map([[`session@c:${f.a}`, 1n]]);
  const after = new Map([[`session@c:${f.a}`, 2n]]);
  assert.deepEqual(movedScopes(before, after, false, carrying, new Set()), [uuidToBase62(f.b)].sort());
  assert.deepEqual(movedScopes(before, after, false, [], new Set()), [], 'without the pair nothing names B');

  // Both runs stop carrying: this tick reads no pair, so the poller keeps the previous tick's.
  await f.db.session.updateMany({ where: { id: { in: [f.runA, f.runQ] } }, data: { turnState: null } });
  assert.deepEqual(await pairsOf(), []);
});
