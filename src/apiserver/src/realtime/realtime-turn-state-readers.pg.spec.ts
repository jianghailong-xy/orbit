/**
 * THE REAPER, LOST RUNNER WORK AND THE REALTIME CLAIMS, EVENTS AND HINTS ON THE FACTS, AGAINST POSTGRESQL (task T9 of
 * docs/session-status-retirement-plan.md, §2.1 and §2.3).
 *
 * Every case runs over the same rows: each held word, written as its turn state, beside the released words. What each
 * reader selects is held to what its predicate on the stored word selected, spelled here on purpose. (The held rows
 * with no turn_state that the NULL fallback read until task T14 no longer exist: 1652 validated the CHECK.)
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/realtime/realtime-turn-state-readers.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType, RunStatus, SessionEndReason, uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { LEGACY_STATUS_SELECT, legacySessionStatus } from '../sessions/session-legacy-words';
import { settleLostRunnerWork } from './lost-runner-work';
import { openListTickStatement } from './open-list-hints';
import { endIdleWorkOfDoneTask } from './parked-session-end';
import { ReaperService } from './reaper.service';
import { RealtimeService } from './realtime.service';
import { turnStateOfWord } from '../sessions/session-turn-state';
import { wordOf } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HELD_WORDS = [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];
const RELEASED_WORDS = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

interface World {
  ownerId: string;
  runnerId: string;
}

interface Row {
  title: string;
  id: string;
  word: RunStatus;
  held: boolean;
  workspaceId: string;
  taskId: string | null;
}

async function world(db: PrismaClient, label: string, lastHeartbeatAt = new Date()): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@realtime-facts.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt, maxConcurrent: 64,
    },
  });
  return { ownerId, runnerId };
}

/** One session per held word and one per released word, each in a workspace of its own. */
async function everyShape(
  db: PrismaClient,
  ids: World,
  options: { doneTask?: boolean; data?: (word: RunStatus) => Partial<Prisma.SessionUncheckedCreateInput> } = {},
): Promise<Row[]> {
  const shapes = [
    ...HELD_WORDS.map((word) => ({ word })),
    ...RELEASED_WORDS.map((word) => ({ word })),
  ];
  const rows: Row[] = [];
  for (const { word } of shapes) {
    const held = HELD_WORDS.includes(word);
    const title = word;
    const workspace = await db.workspace.create({
      data: { ownerId: ids.ownerId, runnerId: ids.runnerId, name: `${title} ${randomUUID()}`, workDir: '/repo', enabled: true },
    });
    // One task each: a task has one held session at a time.
    const taskId = options.doneTask
      ? (await db.task.create({
        data: {
          ownerId: ids.ownerId, creatorType: 'USER', creatorId: ids.ownerId, title, assigneeId: workspace.id,
          completionCriterion: 'OWNER_CONFIRMED', status: 'DONE',
        },
      })).id
      : null;
    const { id } = await db.session.create({
      data: {
        ownerId: ids.ownerId, creatorId: ids.ownerId, title, prompt: title, turnState: turnStateOfWord(word), taskId,
        startsTaskWork: taskId !== null, dispatchOrigin: SessionDispatchOrigin.USER, provider: 'claude',
        providerBuiltin: true, workspaceId: workspace.id, assignedRunnerId: ids.runnerId, runtimeSessionId: randomUUID(),
        startedAt: new Date(Date.now() - 60 * 60_000), runClaimedAt: new Date(Date.now() - 60 * 60_000),
        ...(held ? {} : { finishedAt: new Date(), lastTurnOutcome: word === RunStatus.FAILED ? 'FAILED' : 'ANSWERED' }),
        ...options.data?.(word),
      },
    });
    rows.push({ title, id, word, held, workspaceId: workspace.id, taskId });
  }
  return rows;
}

const titles = (rows: Row[], keep: (row: Row) => boolean): string[] => rows.filter(keep).map((row) => row.title).sort();

const stored = async (db: PrismaClient, rows: Row[]) => {
  const found = await db.session.findMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return new Map(found.map((row) => [row.id, row]));
};

/** The reaper's own sweep, over this owner's sessions only (other specs share the database). */
async function sweep(db: PrismaClient, ownerId: string, published: Map<string, Record<string, unknown>>): Promise<void> {
  const scoped = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== 'session') return Reflect.get(target, key, receiver);
      const delegate = target.session;
      return new Proxy(delegate, {
        get(d, k, r) {
          if (k !== 'findMany') return Reflect.get(d, k, r);
          return (args: { where?: object }) => d.findMany({ ...args, where: { ...(args?.where ?? {}), ownerId } } as never);
        },
      });
    },
  }) as unknown as PrismaService;
  const realtime = new Proxy({}, {
    get: (_target, key) => (sessionId: string, event: { type?: string; payload?: Record<string, unknown> }) => {
      if (key === 'publish' && event.type === RunEventType.STATUS) published.set(sessionId, event.payload!);
    },
  }) as unknown as RealtimeService;
  await (new ReaperService(scoped, realtime) as unknown as { sweep(): Promise<void> }).sweep();
}

test('the reaper and realtime read the facts, and select what the stored word selected', { skip, timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  t.after(() => db.$disconnect());

  await t.test('a lost runner fails the turns in flight and nothing else', async () => {
    const ids = await world(db, 'lost', new Date(Date.now() - 10 * 60_000));
    const rows = await everyShape(db, ids);
    assert.equal(await db.session.count({ where: { ownerId: ids.ownerId, finishedAt: null, turnState: null } }), 1,
      'the control: only the parked row holds no turn state');
    const before = await stored(db, rows);
    const published = new Map<string, Record<string, unknown>>();
    await sweep(db, ids.ownerId, published);
    const after = await stored(db, rows);

    const reaped = titles(rows, (row) => after.get(row.id)!.finishedAt != null && before.get(row.id)!.finishedAt == null);
    assert.deepEqual(reaped, titles(rows, (row) => row.word === RunStatus.RUNNING));
    for (const row of rows) {
      const now = after.get(row.id)!;
      if (row.word !== RunStatus.RUNNING) {
        assert.deepEqual(now, before.get(row.id), `${row.title}: untouched`);
        continue;
      }
      assert.deepEqual([wordOf(now), now.turnState, now.lastTurnOutcome, now.error],
        [RunStatus.FAILED, null, 'FAILED', 'runner offline'], row.title);
      assert.equal(published.get(row.id)?.status, RunStatus.FAILED, `${row.title}: the STATUS event`);
    }
  });

  // Two cases over one sweep: which rows it releases and what it writes (today's behaviour exactly, plan §1.4), and
  // apart from that the word its STATUS event carries (plan §3.4 C1).
  const grace: { rows: Row[]; published: Map<string, Record<string, unknown>> } = { rows: [], published: new Map() };

  await t.test('a cancel past its grace releases every held session as its turn state says', async () => {
    const ids = await world(db, 'grace');
    const asked = new Date(Date.now() - 10 * 60_000);
    const rows = await everyShape(db, ids, { data: () => ({ cancelRequestedAt: asked, endReason: SessionEndReason.CANCELLED }) });
    grace.rows = rows;
    const before = await stored(db, rows);
    await sweep(db, ids.ownerId, grace.published);
    const after = await stored(db, rows);

    const released = titles(rows, (row) => after.get(row.id)!.finishedAt != null && before.get(row.id)!.finishedAt == null);
    assert.deepEqual(released, titles(rows, (row) => row.held), 'every held row');
    assert.deepEqual(titles(rows, (row) => grace.published.has(row.id)), released, 'one STATUS event for each');
    for (const row of rows) {
      const now = after.get(row.id)!;
      if (!row.held) {
        assert.deepEqual(now, before.get(row.id), `${row.title}: a released row is not swept`);
        continue;
      }
      const queued = row.word === RunStatus.PENDING;
      assert.deepEqual(
        [wordOf(now), now.turnState, now.finishedAt != null, now.lastTurnOutcome, now.error, now.endReason, now.retryAt],
        [
          queued ? RunStatus.CANCELLED : RunStatus.FAILED, null, true,
          row.word === RunStatus.RUNNING ? 'CANCELLED' : null,
          queued ? null : 'cancel not honored', SessionEndReason.CANCELLED, null,
        ],
        row.title,
      );
    }
  });

  await t.test("the cancel grace's STATUS event carries the word the released row answers with", async () => {
    const held = grace.rows.filter((row) => row.held);
    assert.equal(held.length, 8);
    const projected: Array<[string, string]> = [];
    for (const row of held) {
      const facts = await db.session.findUniqueOrThrow({ where: { id: row.id }, select: LEGACY_STATUS_SELECT });
      projected.push([row.title, legacySessionStatus(facts)]);
    }
    // An end somebody asked for: every one reads CANCELLED, the unhonoured ones too, which are stored FAILED (C1).
    assert.deepEqual(projected, held.map((row) => [row.title, RunStatus.CANCELLED]));
    assert.deepEqual(held.map((row) => [row.title, grace.published.get(row.id)?.status]), projected);
  });

  await t.test('a DONE task ends its parked sessions and no other', async () => {
    const ids = await world(db, 'parked');
    const rows = await everyShape(db, ids, { doneTask: true });
    const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
    const ended: string[] = [];
    for (const row of rows) {
      ended.push(...await endIdleWorkOfDoneTask(prisma, realtime, { warn: () => undefined } as never,
        { ownerId: ids.ownerId, taskId: row.taskId! }));
    }
    assert.deepEqual(titles(rows, (row) => ended.includes(row.id)),
      titles(rows, (row) => row.word === RunStatus.AWAITING_INPUT));
  });

  await t.test('lost work is settled on every held session without a turn in flight', async () => {
    const ids = await world(db, 'work', new Date(Date.now() - 10 * 60_000));
    const rows = await everyShape(db, ids, { data: () => ({ engineTurnActive: true }) });
    const settled: string[] = [];
    for (const row of rows) {
      const found = await db.$transaction((tx) =>
        settleLostRunnerWork(tx, row.id, ids.runnerId, new Date(Date.now() - 5 * 60_000), () => true));
      if (found) settled.push(row.id);
    }
    assert.deepEqual(titles(rows, (row) => settled.includes(row.id)),
      titles(rows, (row) => row.held && row.word !== RunStatus.RUNNING));
  });

  await t.test('a heartbeat claims the merges of released sessions and of the held ones its process leases', async () => {
    for (const leased of [true, false]) {
      const ids = await world(db, `merge-${leased}`);
      const owner = randomUUID();
      const rows = await everyShape(db, ids, {
        data: () => ({
          branch: 'orbit/session', mergeStatus: 'pending', mergeOperationId: randomUUID(),
          inboxLeaseOwner: leased ? owner : randomUUID(),
        }),
      });
      const claimed = (await new RealtimeService(prisma, {} as never).drainMergeRequests(ids.runnerId, owner))
        .map((command) => command.sessionId);
      assert.deepEqual(titles(rows, (row) => claimed.includes(row.id)), titles(rows, (row) => leased || !row.held),
        `leased ${leased}`);
    }
  });

  await t.test('a heartbeat claims the commits of parked sessions and of released dirty checkouts', async () => {
    const ids = await world(db, 'commit');
    const owner = randomUUID();
    const rows = await everyShape(db, ids, {
      data: () => ({
        branch: 'orbit/session', commitStatus: 'pending', commitOperationId: randomUUID(), inboxLeaseOwner: owner,
        worktreeDirty: true,
      }),
    });
    const claimed = (await new RealtimeService(prisma, {} as never).drainCommitRequests(ids.runnerId, owner, true))
      .map((command) => command.sessionId);
    assert.deepEqual(titles(rows, (row) => claimed.includes(row.id)),
      titles(rows, (row) => !row.held || row.word === RunStatus.AWAITING_INPUT));
  });

  await t.test('the open-list tick names the workspaces holding a queued session', async () => {
    const ids = await world(db, 'hints');
    const rows = await everyShape(db, ids);
    const tick = await db.$queryRaw<Array<{ kind: string; a: string }>>(openListTickStatement([ids.ownerId], []));
    const named = new Set(tick.filter((row) => row.kind === 'a').map((row) => row.a));
    assert.deepEqual(titles(rows, (row) => named.has(row.workspaceId) || named.has(uuidToBase62(row.workspaceId))),
      titles(rows, (row) => row.word === RunStatus.PENDING));
  });

  await t.test('the session summary carries the projected word: the stored one on every held row', async () => {
    const ids = await world(db, 'summary');
    const rows = await everyShape(db, ids);
    const service = new RealtimeService(prisma, {} as never) as unknown as {
      buildSessionSummary(id: string): Promise<{ status: string; runStatus: string }>;
    };
    for (const row of rows) {
      const summary = await service.buildSessionSummary(row.id);
      const facts = await db.session.findUniqueOrThrow({ where: { id: row.id }, select: LEGACY_STATUS_SELECT });
      const expected = row.held ? row.word : legacySessionStatus(facts);
      assert.deepEqual([summary.status, summary.runStatus], [expected, expected], row.title);
    }
  });
});
