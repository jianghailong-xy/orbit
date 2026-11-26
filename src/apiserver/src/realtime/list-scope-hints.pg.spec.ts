import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageEvent } from '@nestjs/common';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import type { Subscription } from 'rxjs';
import { ControlEventType, uuidToBase62, type ControlEvent } from '@orbit/shared';
import { EventsController } from '../events/events.controller';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { RUNNER_OFFLINE_AFTER_MS } from '../runners/runner-presence';
import { SessionsService } from '../sessions/sessions.service';
import { OpenListHints } from './open-list-hints';
import { RealtimeService } from './realtime.service';
import { turnStateOfWord } from '../sessions/session-turn-state';

/**
 * docs/list-freshness-scope-hints.md §5.1 and §8.2, the poller's side, against a real PostgreSQL: a stream that
 * declares `hints=list_changed,list_scopes` is told which workspaces moved (`scopes`), and is told nothing when none
 * did; one that declares `list_changed` alone gets exactly `{ version }`, as before. Each case holds within 2 s
 * unless it says otherwise.
 *
 * The last case is the property that makes skipping safe: over a seeded random sequence of writes of every kind
 * of source in three workspaces, whenever a tick sends no hint naming a workspace, a `since=` read of that
 * workspace's column is an empty delta. `LIST_SCOPE_SEED` reproduces a red.
 *
 * Streams are opened through EventsController, the door the clients use, except in the property, which drives the
 * poller's ticks itself. Not destructive: every case owns freshly generated ids.
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

type T = { after: (fn: () => Promise<void> | void) => void };

interface Fixture {
  db: PrismaClient;
  prisma: PrismaService;
  realtime: RealtimeService;
  events: EventsController;
  ownerId: string;
  runnerId: string;
  /** Three workspaces of one runner, and an Open conversation in each. */
  a: string;
  b: string;
  c: string;
  a1: string;
  b1: string;
  c1: string;
  /** A completed conversation in B. */
  bDone: string;
}

async function session(
  db: PrismaClient,
  f: { ownerId: string; runnerId: string },
  workspaceId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: f.ownerId, creatorId: f.ownerId, workspaceId, assignedRunnerId: f.runnerId, title: `lsh ${id.slice(0, 8)}`,
      prompt: 'lsh', provider: 'claude', providerBuiltin: true, turnState: null, startedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER, ...extra,
    },
  });
  return id;
}

async function fixture(t: T, runnerLastBeat: Date = new Date(Date.now() + 86_400_000)): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const prisma = db as unknown as PrismaService;
  const push = { scheduleBadgeSync: () => undefined } as unknown as PushService;
  const realtime = new RealtimeService(prisma, push);
  t.after(() => realtime.onModuleDestroy());
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `lsh-${ownerId}@list-scope-hints.invalid`, name: 'lsh', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'lsh-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: runnerLastBeat,
    },
  });
  const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
  for (const [id, name] of [[a, 'A'], [b, 'B'], [c, 'C']]) {
    await db.workspace.create({ data: { id, ownerId, runnerId, name: `lsh-${name}`, enabled: true } });
  }
  const base = { ownerId, runnerId };
  const a1 = await session(db, base, a);
  const b1 = await session(db, base, b);
  const c1 = await session(db, base, c);
  const bDone = await session(db, base, b, { status: RunStatus.SUCCEEDED, finishedAt: new Date(), completedAt: new Date() });
  return { db, prisma, realtime, events: new EventsController(realtime), ownerId, runnerId, a, b, c, a1, b1, c1, bDone };
}

type Received = Array<{ at: number; event: ControlEvent }>;

/** One `GET /api/events` stream, recording every `sessions.list_changed` it is sent. */
function open(f: Fixture, t: T, hints?: string): { hints: Received; subscription: Subscription } {
  const received: Received = [];
  const subscription = f.events.events({ userId: f.ownerId } as never, hints).subscribe((m: MessageEvent) => {
    const event = m.data as ControlEvent | { type: 'ping' };
    if (event.type === ControlEventType.SESSIONS_LIST_CHANGED) received.push({ at: Date.now(), event: event as ControlEvent });
  });
  t.after(() => subscription.unsubscribe());
  return { hints: received, subscription };
}

async function until(cond: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

const scopesOf = (hint: { event: ControlEvent }): string[] | undefined => hint.event.data.scopes as string[] | undefined;
const pub = uuidToBase62;
const SCOPED = 'list_changed,list_scopes';

/** One more hint than `count` within `ms`, returned. */
async function nextHint(received: Received, count: number, ms = 2_000): Promise<{ at: number; event: ControlEvent }> {
  assert.ok(await until(() => received.length > count, ms), `no sessions.list_changed within ${ms} ms`);
  return received[count];
}

/** A stream's first hint, and a second of quiet after it. */
async function settled(received: Received): Promise<void> {
  assert.ok(await until(() => received.length === 1, 2_000), 'a new stream was not told the current version');
  await sleep(1_200);
  assert.equal(received.length, 1, 'a hint repeated while nothing moved');
}

test('first hint: a list_scopes stream is told the version with no scopes, once', { skip }, async (t) => {
  const f = await fixture(t);
  const scoped = open(f, t, SCOPED);
  await settled(scoped.hints);
  assert.equal(scopesOf(scoped.hints[0]), undefined, 'the first hint after a subscribe named workspaces');
  assert.equal(typeof scoped.hints[0].event.data.version, 'string');
});

test('a drawn write in B: a list_scopes stream gets scopes [B]; a list_changed stream gets { version } alone', { skip }, async (t) => {
  const f = await fixture(t);
  const scoped = open(f, t, SCOPED);
  const plain = open(f, t, 'list_changed');
  await settled(scoped.hints);
  await settled(plain.hints);
  await f.db.$executeRaw`UPDATE session SET title = 'renamed in B' WHERE id = ${f.b1}::uuid`;
  const hint = await nextHint(scoped.hints, 1);
  assert.deepEqual(scopesOf(hint), [pub(f.b)]);
  const old = await nextHint(plain.hints, 1);
  assert.deepEqual(Object.keys(old.event.data), ['version'], 'a stream that did not declare list_scopes was sent more than { version }');
  assert.equal(old.event.data.version, hint.event.data.version);
  // A turn of A's session: A alone.
  await f.db.conversationTurn.create({
    data: { sessionId: f.a1, seq: 1, clientTurnId: `lsh-${randomUUID()}`, kind: 'message', content: 'hi', status: 'PENDING' },
  });
  assert.deepEqual(scopesOf(await nextHint(scoped.hints, 2)), [pub(f.a)]);
  assert.deepEqual(Object.keys((await nextHint(plain.hints, 2)).event.data), ['version']);
});

test('an account-wide write, a task title, gives a hint with no scopes', { skip }, async (t) => {
  const f = await fixture(t);
  const task = await f.db.task.create({
    data: { ownerId: f.ownerId, title: 'lsh task', creatorType: 'USER', creatorId: f.ownerId, completionCriterion: 'OWNER_CONFIRMED' },
  });
  const scoped = open(f, t, SCOPED);
  await settled(scoped.hints);
  await f.db.$executeRaw`UPDATE task SET title = 'lsh task renamed' WHERE id = ${task.id}::uuid`;
  const hint = await nextHint(scoped.hints, 1);
  assert.equal(scopesOf(hint), undefined, 'a task write named workspaces');
});

test('a write in no Open list (a completed session) sends a list_scopes stream nothing; a list_changed stream is told as before', { skip }, async (t) => {
  const f = await fixture(t);
  const scoped = open(f, t, SCOPED);
  const plain = open(f, t, 'list_changed');
  await settled(scoped.hints);
  await settled(plain.hints);
  await f.db.$executeRaw`UPDATE session SET title = 'completed, renamed' WHERE id = ${f.bDone}::uuid`;
  await nextHint(plain.hints, 1);
  await sleep(1_500);
  assert.equal(scoped.hints.length, 1, 'a write no Open list draws sent a list_scopes stream a hint');
});

test('an OPEN RUN_QUESTION from A to a coordinator in B: a write to the coordinator\'s turn names A and B', { skip }, async (t) => {
  const f = await fixture(t);
  const turn = await f.db.conversationTurn.create({
    data: { sessionId: f.b1, seq: 1, clientTurnId: `lsh-${randomUUID()}`, kind: 'message', content: 'asked', status: 'PENDING' },
  });
  await f.db.$executeRaw`
    INSERT INTO session_request (id, owner_id, from_session_id, to_session_id, turn_id, client_turn_id, request_preview, reply_by, kind)
    VALUES (gen_random_uuid(), ${f.ownerId}::uuid, ${f.a1}::uuid, ${f.b1}::uuid, ${turn.id}::uuid, ${turn.clientTurnId},
            'asked', now() + interval '1 hour', 'RUN_QUESTION')`;
  await f.db.project.create({ data: { ownerId: f.ownerId, title: 'lsh project', coordinatorSessionId: f.b1 } });
  const scoped = open(f, t, SCOPED);
  await settled(scoped.hints);
  await f.db.$executeRaw`UPDATE conversation_turn SET status = 'IN_FLIGHT', delivered_at = now() WHERE id = ${turn.id}::uuid`;
  const scopes = scopesOf(await nextHint(scoped.hints, 1));
  assert.ok(scopes, 'the turn write gave a hint with no scopes');
  for (const ws of [f.a, f.b]) assert.ok(scopes.includes(pub(ws)), `the hint did not name ${ws} (${scopes.join(', ')})`);
  assert.ok(!scopes.includes(pub(f.c)), 'the hint named a workspace nothing in it reads');
});

/** An OPEN request of `kind` from `from` to `to`, delivered in a turn of `to`'s; returns that turn's id. */
async function openRequest(f: Fixture, from: string, to: string, kind: 'MESSAGE' | 'RUN_QUESTION'): Promise<string> {
  const turn = await f.db.conversationTurn.create({
    data: { sessionId: to, seq: 1, clientTurnId: `lsh-${randomUUID()}`, kind: 'message', content: 'asked', status: 'PENDING' },
  });
  await f.db.$executeRaw`
    INSERT INTO session_request (id, owner_id, from_session_id, to_session_id, turn_id, client_turn_id, request_preview, reply_by, kind)
    VALUES (gen_random_uuid(), ${f.ownerId}::uuid, ${from}::uuid, ${to}::uuid, ${turn.id}::uuid, ${turn.clientTurnId},
            'asked', now() + interval '1 hour', ${kind})`;
  return turn.id;
}

test('rule 3 in one workspace: an OPEN MESSAGE between an Open session in A and a completed one in A, renaming the completed one names A', { skip }, async (t) => {
  const f = await fixture(t);
  const sessions = new SessionsService(
    f.prisma,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  const aDone = await session(f.db, f, f.a, { status: RunStatus.SUCCEEDED, finishedAt: new Date(), completedAt: new Date() });
  await openRequest(f, f.a1, aDone, 'MESSAGE');
  const scoped = open(f, t, SCOPED);
  await settled(scoped.hints);
  const read = (since: string) => sessions.listOpenSince(f.ownerId, { runnerId: f.runnerId, workspaceId: f.a }, since) as Promise<Delta>;
  const { cursor } = await read('');
  await f.db.$executeRaw`UPDATE session SET title = 'the peer, renamed' WHERE id = ${aDone}::uuid`;
  // The rename moves A's column (the Open asker shows its peer's title), so a hint that left A out would hide it.
  const delta = await read(cursor);
  assert.ok(!delta.full && (delta.upserts?.length ?? 0) > 0, 'renaming the completed peer did not move A\'s column (the case proves nothing)');
  const scopes = scopesOf(await nextHint(scoped.hints, 1));
  assert.ok(scopes?.includes(pub(f.a)), `the hint did not name A (${scopes === undefined ? 'every list' : scopes.join(', ')})`);
});

test('rule 3 in one workspace: an OPEN RUN_QUESTION to a completed coordinator in A, a write to its delivery turn names A', { skip }, async (t) => {
  const f = await fixture(t);
  const coordinator = await session(f.db, f, f.a, { status: RunStatus.SUCCEEDED, finishedAt: new Date(), completedAt: new Date() });
  await f.db.project.create({ data: { ownerId: f.ownerId, title: 'lsh project', coordinatorSessionId: coordinator } });
  const turn = await openRequest(f, f.a1, coordinator, 'RUN_QUESTION');
  const scoped = open(f, t, SCOPED);
  await settled(scoped.hints);
  await f.db.$executeRaw`UPDATE conversation_turn SET status = 'IN_FLIGHT', delivered_at = now() WHERE id = ${turn}::uuid`;
  const scopes = scopesOf(await nextHint(scoped.hints, 1));
  assert.ok(scopes?.includes(pub(f.a)), `the hint did not name A (${scopes === undefined ? 'every list' : scopes.join(', ')})`);
});

test('a workspace holding a PENDING row is named whenever any workspace moves', { skip }, async (t) => {
  const f = await fixture(t);
  await session(f.db, f, f.c, { status: RunStatus.PENDING, startedAt: null });
  const scoped = open(f, t, SCOPED);
  await settled(scoped.hints);
  await f.db.$executeRaw`UPDATE session SET title = 'B moved' WHERE id = ${f.b1}::uuid`;
  assert.deepEqual(scopesOf(await nextHint(scoped.hints, 1)), [pub(f.b), pub(f.c)].sort());
});

test('heartbeats and runner-row writes outside steady send no hint; a rename sends one with no scopes', { skip, timeout: 60_000 }, async (t) => {
  const f = await fixture(t, new Date());
  const scoped = open(f, t, SCOPED);
  const undeclared = open(f, t);
  await settled(scoped.hints);
  const quiet = async (what: string, write: () => Promise<unknown>) => {
    await write();
    await sleep(1_500);
    assert.equal(scoped.hints.length, 1, `${what} sent a hint`);
  };
  await quiet('a presence beat', () => f.db.runnerPresence.upsert({
    where: { runnerId: f.runnerId },
    create: { runnerId: f.runnerId, lastBeatAt: new Date(), linkState: 'HTTP' },
    update: { lastBeatAt: new Date() },
  }));
  await quiet('a runner heartbeat', () => f.db.runner.update({ where: { id: f.runnerId }, data: { lastHeartbeatAt: new Date() } }));
  await quiet('a runner column outside steady', () =>
    f.db.runner.update({ where: { id: f.runnerId }, data: { capabilitiesReportedAt: new Date() } }));
  await quiet('a heartbeat\'s directory probe', () =>
    f.db.$executeRaw`UPDATE workspace SET work_dir_probed_at = now(), work_dir_free_bytes = 12345 WHERE runner_id = ${f.runnerId}::uuid`);
  await f.db.runner.update({ where: { id: f.runnerId }, data: { name: 'renamed', lastHeartbeatAt: new Date() } });
  const hint = await nextHint(scoped.hints, 1, 20_000);
  assert.equal(scopesOf(hint), undefined, 'a runner rename named workspaces');
  assert.equal(undeclared.hints.length, 0, 'an undeclared stream received sessions.list_changed');
});

test('a runner going offline by the clock alone gives a list_scopes stream a hint with no scopes within 20 s', { skip, timeout: 60_000 }, async (t) => {
  const offlineAt = Date.now() + 4_000;
  const f = await fixture(t, new Date(offlineAt - RUNNER_OFFLINE_AFTER_MS));
  const scoped = open(f, t, SCOPED);
  assert.ok(await until(() => scoped.hints.length === 1, 2_000), 'a new stream was not told the current version');
  const hint = await nextHint(scoped.hints, 1, offlineAt + 20_000 - Date.now());
  assert.ok(hint.at >= offlineAt && hint.at - offlineAt <= 20_000);
  assert.equal(scopesOf(hint), undefined, 'a clock threshold named workspaces');
});

/** A small seeded PRNG (mulberry32), so a red reproduces from its seed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

type Delta = { full: boolean; upserts?: unknown[]; removedIds?: unknown[]; order?: unknown[]; cursor: string };

test('soundness: whenever a tick sends no hint naming W, a since= read of W\'s column is an empty delta', { skip, timeout: 600_000 }, async (t) => {
  const seed = Number(process.env.LIST_SCOPE_SEED ?? 20261123);
  const steps = Number(process.env.LIST_SCOPE_STEPS ?? 150);
  const random = prng(seed);
  const pick = <V>(values: readonly V[]): V => values[Math.floor(random() * values.length)];
  const f = await fixture(t);
  const { db } = f;
  const workspaces = [f.a, f.b, f.c];
  const sessions = new SessionsService(
    f.prisma,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  // More rows of every kind: Open ones, completed ones, a scheduled run, a task, a project with a coordinator.
  const base = { ownerId: f.ownerId, runnerId: f.runnerId };
  const live: string[] = [f.a1, f.b1, f.c1];
  const closed: string[] = [f.bDone];
  for (const ws of workspaces) {
    live.push(await session(db, base, ws));
    closed.push(await session(db, base, ws, { status: RunStatus.SUCCEEDED, finishedAt: new Date(), completedAt: new Date() }));
  }
  const scheduledRun = await session(db, base, f.a);
  await db.$executeRaw`UPDATE session SET run_source = 'SCHEDULE' WHERE id = ${scheduledRun}::uuid`;
  const tasks = [] as string[];
  for (const name of ['one', 'two']) {
    tasks.push((await db.task.create({
      data: { ownerId: f.ownerId, title: `lsh ${name}`, creatorType: 'USER', creatorId: f.ownerId, completionCriterion: 'OWNER_CONFIRMED' },
    })).id);
  }
  const project = await db.project.create({ data: { ownerId: f.ownerId, title: 'lsh project', coordinatorSessionId: f.c1 } });
  const tag = await db.sessionTag.create({ data: { ownerId: f.ownerId, name: 'lsh-tag', color: '#00ff00' } });
  const turns: string[] = [];
  const requests: string[] = [];
  const watches: string[] = [];
  let seq = 100;
  const turnOn = async (sessionId: string, status = 'PENDING') => {
    const turn = await db.conversationTurn.create({
      data: { sessionId, seq: seq++, clientTurnId: `lsh-${randomUUID()}`, kind: 'message', content: 'x', status },
    });
    turns.push(turn.id);
    return turn;
  };
  const any = () => pick([...live, ...closed]);

  /** The writes the sequence draws from: every kind of source, in and out of Open lists, undrawn ones too. */
  const writes: Array<[string, () => Promise<unknown>]> = [
    ['rename an Open session', () => db.session.update({ where: { id: pick(live) }, data: { title: `t${random()}` } })],
    ['rename a completed session', () => db.session.update({ where: { id: pick(closed) }, data: { title: `t${random()}` } })],
    ['rename the scheduled run', () => db.session.update({ where: { id: scheduledRun }, data: { title: `t${random()}` } })],
    ['an undrawn session write', () => db.$executeRaw`UPDATE session SET context_tokens = ${Math.floor(random() * 1e6)} WHERE id = ${any()}::uuid`],
    ['a turn arrives', () => turnOn(any(), pick(['PENDING', 'IN_FLIGHT']))],
    ['a turn is answered', async () => {
      if (turns.length) await db.$executeRaw`UPDATE conversation_turn SET status = 'ANSWERED', answered_at = now() WHERE id = ${pick(turns)}::uuid`;
    }],
    ['an approval', () => db.approval.create({ data: { sessionId: any(), toolName: 'Bash', input: {}, toolUseId: `toolu_${randomUUID()}` } })],
    ['a tag linked or unlinked', async () => {
      const sessionId = any();
      const linked = await db.sessionTagLink.findFirst({ where: { sessionId, tagId: tag.id } });
      if (linked) await db.sessionTagLink.deleteMany({ where: { sessionId, tagId: tag.id } });
      else await db.sessionTagLink.create({ data: { sessionId, tagId: tag.id } });
    }],
    ['the tag renamed', () => db.sessionTag.update({ where: { id: tag.id }, data: { name: `lsh-tag-${random()}` } })],
    ['a task renamed', () => db.task.update({ where: { id: pick(tasks) }, data: { title: `lsh ${random()}` } })],
    ['a session given a task', () => db.session.update({ where: { id: pick(live) }, data: { taskId: pick([...tasks, null]) } })],
    ['a session rooted elsewhere', () => db.session.update({ where: { id: pick(live) }, data: { rootSessionId: pick([...live, null]) } })],
    ['the project renamed', () => db.project.update({ where: { id: project.id }, data: { title: `lsh project ${random()}` } })],
    ['a workspace renamed', () => db.workspace.update({ where: { id: pick(workspaces) }, data: { name: `lsh-${random()}` } })],
    ['a directory probe', () => db.$executeRaw`UPDATE workspace SET work_dir_probed_at = now(), work_dir_free_bytes = ${Math.floor(random() * 1e9)} WHERE id = ${pick(workspaces)}::uuid`],
    ['a request opened', async () => {
      const from = pick(live);
      const to = pick([...live, ...closed].filter((id) => id !== from));
      const turn = await turnOn(to);
      const id = randomUUID();
      await db.$executeRaw`
        INSERT INTO session_request (id, owner_id, from_session_id, to_session_id, turn_id, client_turn_id, request_preview, reply_by, kind)
        VALUES (${id}::uuid, ${f.ownerId}::uuid, ${from}::uuid, ${to}::uuid, ${turn.id}::uuid, ${turn.clientTurnId},
                'asked', now() + interval '1 hour', ${pick(['MESSAGE', 'RUN_QUESTION'])})`;
      requests.push(id);
    }],
    ['a request in one workspace with a closed peer', async () => {
      // A peer outside every Open list moves only its workspace's closed key; the Open peer beside it still draws it.
      const peer = pick(closed);
      const { workspaceId } = await db.session.findUniqueOrThrow({ where: { id: peer }, select: { workspaceId: true } });
      const beside = (await db.session.findMany({ where: { id: { in: live }, workspaceId }, select: { id: true } })).map((row) => row.id);
      if (beside.length === 0) return;
      const [from, to] = random() < 0.5 ? [pick(beside), peer] : [peer, pick(beside)];
      const turn = await turnOn(to);
      const id = randomUUID();
      await db.$executeRaw`
        INSERT INTO session_request (id, owner_id, from_session_id, to_session_id, turn_id, client_turn_id, request_preview, reply_by, kind)
        VALUES (${id}::uuid, ${f.ownerId}::uuid, ${from}::uuid, ${to}::uuid, ${turn.id}::uuid, ${turn.clientTurnId},
                'asked', now() + interval '1 hour', ${pick(['MESSAGE', 'RUN_QUESTION'])})`;
      requests.push(id);
    }],
    ['a request closed', async () => {
      if (requests.length) await db.$executeRaw`UPDATE session_request SET state = 'REPLIED', reply_text = 'answered', closed_at = now() WHERE id = ${pick(requests)}::uuid AND state = 'OPEN'`;
    }],
    ['a watch armed', async () => {
      watches.push((await db.watch.create({
        data: {
          ownerId: f.ownerId, observerType: 'SESSION', observerSessionId: any(),
          predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' }, mode: 'ONE_SHOT', action: 'RESUME_SESSION',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })).id);
    }],
    ['a watch cancelled', async () => {
      if (watches.length) await db.watch.updateMany({ where: { id: pick(watches), state: 'ACTIVE' }, data: { state: 'CANCELLED', nextEvaluateAt: null } });
    }],
    ['a wake-up armed or cancelled', async () => {
      const sessionId = any();
      const pending = await db.sessionScheduledWakeup.findFirst({ where: { sessionId, state: 'PENDING' } });
      if (pending) await db.sessionScheduledWakeup.update({ where: { id: pending.id }, data: { state: 'CANCELLED' } });
      else await db.sessionScheduledWakeup.create({ data: { sessionId, delaySeconds: 600, reason: 'lsh', dueAt: new Date(Date.now() + 600_000) } });
    }],
    ['a session queued or running', () => db.session.update({ where: { id: pick(live) }, data: { turnState: turnStateOfWord(pick([RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT])) } })],
    ['a session completed or reopened', async () => {
      const id = any();
      const completing = live.includes(id);
      // Keep both kinds on hand for the writes that pick one: at least three Open sessions and two closed ones.
      if (completing ? live.length <= 3 : closed.length <= 2) return;
      await db.session.update({ where: { id }, data: { completedAt: completing ? new Date() : null } });
      if (completing) live.splice(live.indexOf(id), 1), closed.push(id);
      else closed.splice(closed.indexOf(id), 1), live.push(id);
    }],
    ['a session moved to another workspace', () => db.session.update({ where: { id: any() }, data: { workspaceId: pick(workspaces) } })],
    ['nothing at all', async () => undefined],
  ];

  // The poller, ticked here: no timer of its own fires during the test, and no clock tick after the first.
  const poller = new OpenListHints(f.prisma, 3_600_000, 3_600_000);
  t.after(() => poller.stop());
  const told: ControlEvent[] = [];
  // Typed loosely, so this file compiles against a poller that predates `scoped` and fails there on its assertions.
  const watch = poller.watch.bind(poller) as unknown as (ownerId: string, options: { scoped: boolean }) => ReturnType<OpenListHints['watch']>;
  const subscription = watch(f.ownerId, { scoped: true }).subscribe((event) => told.push(event));
  t.after(() => subscription.unsubscribe());
  const tick = () => (poller as unknown as { tick(): Promise<void> }).tick();

  // The column of each workspace as WorkspaceView reads it, and the cursor it holds.
  const read = (ws: string, since: string) =>
    sessions.listOpenSince(f.ownerId, { runnerId: f.runnerId, workspaceId: ws }, since) as Promise<Delta>;
  await tick();
  assert.equal(told.length, 1, 'the first tick told the stream nothing');
  const cursors = new Map<string, string>();
  for (const ws of workspaces) cursors.set(ws, (await read(ws, '')).cursor);

  const log: string[] = [];
  let named = 0;
  let skipped = 0;
  for (let step = 0; step < steps; step += 1) {
    const count = 1 + Math.floor(random() * 3);
    const done: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const [what, write] = pick(writes);
      // A write the schema refuses (a random combination can break a constraint) wrote nothing, and moved nothing.
      const refused = await write().then(() => false, (error: { code?: string; message?: string }) => {
        if (!/P2002|P2003|P2025|23505|23514|23503/.test(`${error.code} ${error.message}`)) throw error;
        return true;
      });
      done.push(refused ? `${what} (refused)` : what);
    }
    const before = told.length;
    await tick();
    const hints = told.slice(before);
    assert.ok(hints.length <= 1, 'one tick sent a stream two hints');
    const scopes = hints.length === 0 ? [] : (hints[0].data.scopes as string[] | undefined);
    log.push(`${step}: ${done.join(' + ')} -> ${hints.length === 0 ? 'no hint' : scopes === undefined ? 'every list' : scopes.join(',')}`);
    for (const ws of workspaces) {
      const delta = await read(ws, cursors.get(ws)!);
      const isNamed = hints.length > 0 && (scopes === undefined || scopes.includes(pub(ws)));
      if (isNamed) {
        named += 1;
      } else {
        skipped += 1;
        const empty = !delta.full && (delta.upserts?.length ?? 0) === 0 && (delta.removedIds?.length ?? 0) === 0 && delta.order === undefined;
        assert.ok(empty, `seed ${seed}, step ${step}: no hint named ${ws}, yet its since= read moved `
          + `(${JSON.stringify({ full: delta.full, upserts: delta.upserts?.length, removed: delta.removedIds, order: delta.order !== undefined })})\n`
          + log.slice(-8).join('\n'));
      }
      cursors.set(ws, delta.cursor);
    }
  }
  console.log(JSON.stringify({ soundness: { seed, steps, namedReads: named, skippedReads: skipped } }));
  // The property was exercised both ways.
  assert.ok(named > 0 && skipped > steps / 2, `the sequence named ${named} and skipped ${skipped} workspace reads`);
});
