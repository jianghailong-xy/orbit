import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageEvent } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';
import type { Subscription } from 'rxjs';
import { ControlEventType, type ControlEvent } from '@orbit/shared';
import { EventsController } from '../events/events.controller';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { RUNNER_OFFLINE_AFTER_MS } from '../runners/runner-presence';
import { readOpenListVersion } from '../sessions/open-list-version';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { RealtimeService } from './realtime.service';

/**
 * docs/realtime-control-plane-stream.md §4.8, against a real PostgreSQL:
 *
 *  a) a bare SQL write that publishes no event reaches a stream that declared `hints=list_changed`
 *     as `sessions.list_changed` within 2 s;
 *  b) a runner going offline by the clock alone, with no row written, reaches it within 20 s;
 *  c) two concurrent reads of the Open list at one version build it once;
 *  d) one `session.updated` with three streams of the account open reads the summary once;
 *  e) a stream that did not declare the hint receives `sessions.list_changed` in neither a) nor b).
 *
 * Streams are opened through EventsController, the door the clients use, so the declaration is the
 * query parameter itself. Not destructive: every case owns freshly generated ids.
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

interface Fixture {
  db: PrismaClient;
  prisma: PrismaService;
  realtime: RealtimeService;
  events: EventsController;
  ownerId: string;
  runnerId: string;
  sessionId: string;
}

async function fixture(
  t: { after: (fn: () => Promise<void> | void) => void },
  runnerLastBeat: Date = new Date(),
): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const prisma = db as unknown as PrismaService;
  const push = { scheduleBadgeSync: () => undefined } as unknown as PushService;
  const realtime = new RealtimeService(prisma, push);
  t.after(() => realtime.onModuleDestroy());
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `lch-${ownerId}@list-changed-hints.invalid`, name: 'lch', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'lch-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: runnerLastBeat,
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'lch-workspace', enabled: true } });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: 'lch',
      prompt: 'lch', provider: 'claude', providerBuiltin: true, status: RunStatus.RUNNING, startedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  return { db, prisma, realtime, events: new EventsController(realtime), ownerId, runnerId, sessionId };
}

/** One `GET /api/events` stream, recording every control event it is sent (pings dropped). */
function open(
  f: Fixture,
  t: { after: (fn: () => void) => void },
  hints?: string,
): { received: Array<{ at: number; event: ControlEvent }>; subscription: Subscription } {
  const received: Array<{ at: number; event: ControlEvent }> = [];
  const subscription = f.events.events({ userId: f.ownerId } as never, hints).subscribe((m: MessageEvent) => {
    const event = m.data as ControlEvent | { type: 'ping' };
    if (event.type !== 'ping') received.push({ at: Date.now(), event: event as ControlEvent });
  });
  t.after(() => subscription.unsubscribe());
  return { received, subscription };
}

const hintsIn = (received: Array<{ at: number; event: ControlEvent }>) =>
  received.filter((r) => r.event.type === ControlEventType.SESSIONS_LIST_CHANGED);

async function until(cond: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

test('a/e: a bare SQL write reaches a declared stream as sessions.list_changed within 2 s, and an undeclared one never', { skip }, async (t) => {
  const f = await fixture(t);
  const declared = open(f, t, 'list_changed');
  const undeclared = open(f, t);
  // The first counter read is the baseline the change is measured against.
  await sleep(1_500);
  assert.equal(hintsIn(declared.received).length, 0, 'a hint before anything changed');

  // Publishes nothing: only the table's own counter trigger knows.
  await f.db.$executeRawUnsafe(`UPDATE session SET title = 'renamed by sql' WHERE id = $1::uuid`, f.sessionId);
  const wroteAt = Date.now();
  assert.ok(await until(() => hintsIn(declared.received).length > 0, 2_000), 'no sessions.list_changed within 2 s of the write');
  const [hint] = hintsIn(declared.received);
  assert.ok(hint.at - wroteAt <= 2_000);
  assert.equal(hint.event.sessionId, '');
  assert.equal(hint.event.agentId, null);
  assert.equal(typeof hint.event.data.version, 'string');
  assert.equal(hint.event.data.version, await readOpenListVersion(f.prisma, f.ownerId));

  // At most one per account per second, and none while nothing moves.
  await sleep(1_500);
  assert.equal(hintsIn(declared.received).length, 1, 'a hint repeated for a version already announced');
  assert.equal(hintsIn(undeclared.received).length, 0, 'an undeclared stream received sessions.list_changed');
});

test('b/e: a runner going offline by the clock alone reaches a declared stream within 20 s, and an undeclared one never', { skip }, async (t) => {
  // Online for four more seconds, then offline with nothing written anywhere.
  const f = await fixture(t, new Date(Date.now() - RUNNER_OFFLINE_AFTER_MS + 4_000));
  const declared = open(f, t, 'other,list_changed');
  const undeclared = open(f, t, 'other');
  const openedAt = Date.now();
  assert.ok(await until(() => hintsIn(declared.received).length > 0, 20_000), 'no sessions.list_changed within 20 s of the runner going offline');
  assert.ok(hintsIn(declared.received)[0].at - openedAt <= 20_000);
  assert.equal(hintsIn(undeclared.received).length, 0, 'an undeclared stream received sessions.list_changed');
});

test('c: two concurrent Open-list reads at one version build it once', { skip }, async (t) => {
  const f = await fixture(t);
  const sessions = new SessionsService(
    f.prisma,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  let built = 0;
  const target = sessions as unknown as { listRows: (...args: unknown[]) => Promise<unknown> };
  const listRows = target.listRows.bind(sessions);
  target.listRows = (...args: unknown[]) => {
    built += 1;
    return listRows(...args);
  };
  const controller = new SessionsController(sessions, {} as never, {} as never, {} as never, {} as never, {} as never);
  const read = (since?: string) => {
    const res = { setHeader: () => undefined, status: () => res };
    return controller.list(
      { userId: f.ownerId } as never,
      undefined, undefined, undefined, undefined, 'open', undefined,
      undefined, undefined, since, undefined, res as never,
    );
  };

  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(built, 1, `two reads at one version built the list ${built} times`);
  assert.deepEqual(first, second);
  assert.notEqual(first, second, 'two readers were handed the same object');
  assert.equal((first as Array<{ id: string }>)[0].id, f.sessionId);

  // The delta read at the same version shares the build too.
  const [a, b] = await Promise.all([read(''), read('')]);
  assert.equal(built, 1, `the since= reads at the same version built the list again (${built})`);
  assert.equal((a as { full: boolean }).full, true);
  assert.deepEqual((a as { upserts: unknown }).upserts, (b as { upserts: unknown }).upserts);

  // What a shared read is handed is exactly what a build of its own reads.
  assert.deepEqual(first, await sessions.list(f.ownerId, { view: 'open' }));
  assert.equal(built, 2);

  // A new version is a new build.
  await f.db.$executeRawUnsafe(`UPDATE session SET title = 'moved' WHERE id = $1::uuid`, f.sessionId);
  const [moved] = (await read()) as Array<{ title: string }>;
  assert.equal(built, 3);
  assert.equal(moved.title, 'moved');
});

test('d: one session.updated with three streams open reads the summary once, and each stream gets the same', { skip }, async (t) => {
  const f = await fixture(t);
  let summaries = 0;
  const target = f.realtime as unknown as { buildSessionSummary: (id: string) => Promise<unknown> };
  const build = target.buildSessionSummary.bind(f.realtime);
  target.buildSessionSummary = (id: string) => {
    summaries += 1;
    return build(id);
  };
  const streams = [open(f, t), open(f, t, 'list_changed'), open(f, t)];
  const updates = () => streams.map((s) => s.received.filter((r) => r.event.type === ControlEventType.SESSION_UPDATED));

  f.realtime.publishSessionUpdated(f.sessionId);
  assert.ok(await until(() => updates().every((u) => u.length === 1), 5_000), 'not every stream received the update');
  assert.equal(summaries, 1, `the summary was read ${summaries} times for one event`);
  const [one, two, three] = updates().map((u) => u[0].event);
  assert.equal(one.sessionId, f.sessionId);
  assert.equal((one.data as { title: string }).title, 'lch');
  assert.deepEqual(one, two);
  assert.deepEqual(one, three);
  assert.notEqual(one.data, two.data, 'two streams were handed the same payload object');
});
