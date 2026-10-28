import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedRunEvent } from '@orbit/shared';
import { RealtimeService } from './realtime.service';
import { INSTANCE_HEADER, liveSubject, RunnerHints, runnerHintSubject, type HintBus } from './runner-hints';

/**
 * Session streams spread over several apiserver processes (task 34nb3xgCijTDzQJVXDVT7; the web gateway's routes for
 * several apiservers, gateway/several-apiservers/): two processes on one NATS, each with the real RunnerHints and
 * RealtimeService.streamForRun. A process subscribes to a session's live stream only while it has a stream of that
 * session, so a delta reaches the processes that hold its session's streams and no other; and each process counts its
 * own streams and tells the runner under its own name, so that the link gateway, which keeps each instance's latest
 * count and sums them (src/link-gateway/live.go), has every stream counted once.
 */

const RUNNER = '0190a0b0-0000-7000-8000-00000000000a';
const S1 = '0190a0b0-0000-7000-8000-0000000000a1';
const S2 = '0190a0b0-0000-7000-8000-0000000000a2';

/** One NATS server: each process's connection, what it subscribes to, and what it is delivered. */
function natsServer() {
  const subs = new Map<string, Array<{ conn: string; fn: (data: Uint8Array) => void }>>();
  const delivered = new Map<string, string[]>();
  const published: Array<{ conn: string; subject: string; message: string; headers?: Record<string, string> }> = [];
  const connect = (conn: string): HintBus => ({
    up: true,
    publish: (subject, message, headers) => void published.push({ conn, subject, message, ...(headers ? { headers } : {}) }),
    subscribe: (subject, fn) => {
      const entry = { conn, fn };
      subs.set(subject, [...(subs.get(subject) ?? []), entry]);
      return () => subs.set(subject, (subs.get(subject) ?? []).filter((e) => e !== entry));
    },
    request: async () => null, // no runner answers a turn prefix here
    close: async () => undefined,
  });
  /** The gateway publishing a runner's live batch for a session. */
  const liveBatch = (sessionId: string, text: string) => {
    const frame = JSON.stringify({ liveBatch: { sessionId, events: [{ liveSeq: '1', type: 'text_delta', tsUnixMs: '1761645600000',
      turnId: '0190a0b0-0000-7000-8000-0000000000b1', payloadJson: Buffer.from(JSON.stringify({ text })).toString('base64') }] } });
    for (const { conn, fn } of subs.get(liveSubject(sessionId)) ?? []) {
      delivered.set(conn, [...(delivered.get(conn) ?? []), sessionId]);
      fn(new TextEncoder().encode(frame));
    }
  };
  const subscribers = (subject: string) => (subs.get(subject) ?? []).map((e) => e.conn).sort();
  /** A process that stops: NATS drops its connection's subscriptions, and the process says nothing. */
  const drop = (conn: string) => {
    for (const [subject, list] of subs) subs.set(subject, list.filter((e) => e.conn !== conn));
  };
  return { connect, liveBatch, subscribers, drop, delivered, published };
}

/** One apiserver process: its hints over its own NATS connection, and its realtime service, as the module wires them. */
function apiserverProcess(nats: ReturnType<typeof natsServer>, conn: string) {
  const prisma = { session: { findUnique: async () => ({ assignedRunnerId: RUNNER }) }, $executeRawUnsafe: async () => 0 };
  const hints = new RunnerHints(prisma as never, 'nats://nats:4222', () => nats.connect(conn));
  (hints as unknown as { log: { log(): void; warn(): void } }).log = { log: () => undefined, warn: () => undefined };
  hints.onModuleInit();
  const realtime = new RealtimeService(prisma as never, {} as never, hints);
  const open = (sessionId: string) => {
    const got: string[] = [];
    const sub = realtime.streamForRun(sessionId).subscribe((e: NormalizedRunEvent) => got.push((e.payload as { text: string }).text));
    return { got, close: () => sub.unsubscribe() };
  };
  return { hints, realtime, open };
}

/**
 * What the link gateway keeps: each instance's latest count of each session, from the hints that name it; summed. The
 * instances in `lapsed` are those whose counts the gateway let go: not repeated within LINK_WATCHERS_TTL.
 */
function watchersSummed(published: ReturnType<typeof natsServer>['published'], lapsed: string[] = []): Record<string, number> {
  const latest = new Map<string, number>();
  for (const p of published) {
    const w = (JSON.parse(p.message).hint ?? {}).watchers as { sessionId: string; watchers: number } | undefined;
    if (!w || lapsed.includes(p.headers?.[INSTANCE_HEADER] ?? '')) continue;
    assert.equal(p.subject, runnerHintSubject(RUNNER));
    latest.set(`${p.headers?.[INSTANCE_HEADER]} ${w.sessionId}`, w.watchers);
  }
  const sums: Record<string, number> = {};
  for (const [key, n] of latest) {
    const session = key.split(' ')[1];
    sums[session] = (sums[session] ?? 0) + n;
  }
  return sums;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a delta reaches the processes that hold its session\'s streams, and every stream is counted once across them', async () => {
  const nats = natsServer();
  const a = apiserverProcess(nats, 'conn-a');
  const b = apiserverProcess(nats, 'conn-b');
  assert.notEqual(a.hints.instanceId, b.hints.instanceId);

  // Two streams of S1 on A (two tabs), one of S1 on B (another device), one of S2 on B.
  const a1 = a.open(S1);
  const a2 = a.open(S1);
  const b1 = b.open(S1);
  const b2 = b.open(S2);
  await settle();

  // One subscription per process per session it holds streams of, and none elsewhere.
  assert.deepEqual(nats.subscribers(liveSubject(S1)), ['conn-a', 'conn-b']);
  assert.deepEqual(nats.subscribers(liveSubject(S2)), ['conn-b']);

  nats.liveBatch(S2, 'two');
  nats.liveBatch(S1, 'one');
  await settle();
  assert.deepEqual(nats.delivered.get('conn-a'), [S1], 'A was delivered nothing of S2, which it holds no stream of');
  assert.deepEqual(nats.delivered.get('conn-b'), [S2, S1]);
  assert.deepEqual([a1.got, a2.got, b1.got, b2.got], [['one'], ['one'], ['one'], ['two']]);

  // Each process names itself, and what each says adds up to the streams there are.
  const named = new Set(nats.published.map((p) => p.headers?.[INSTANCE_HEADER]).filter(Boolean));
  assert.deepEqual([...named].sort(), [a.hints.instanceId, b.hints.instanceId].sort());
  assert.deepEqual(watchersSummed(nats.published), { [S1]: 3, [S2]: 1 });
  // The heartbeat route answers with the answering process's own counts, under its own name (runner-link-hints.ts).
  assert.deepEqual(a.realtime.linkWatchersOf([S1, S2]), { instance: a.hints.instanceId, sessions: [{ sessionId: S1, watchers: 2 }] });
  assert.deepEqual(b.realtime.linkWatchersOf([S1, S2]), {
    instance: b.hints.instanceId, sessions: [{ sessionId: S1, watchers: 1 }, { sessionId: S2, watchers: 1 }],
  });

  // B's streams end: B lets go of its subscriptions and says 0 for itself; A's count stands.
  b1.close();
  b2.close();
  await settle();
  assert.deepEqual(nats.subscribers(liveSubject(S1)), ['conn-a']);
  assert.deepEqual(nats.subscribers(liveSubject(S2)), []);
  assert.deepEqual(watchersSummed(nats.published), { [S1]: 2, [S2]: 0 });
  nats.liveBatch(S2, 'unwatched');
  assert.deepEqual(nats.delivered.get('conn-b'), [S2, S1], 'nothing more reaches B');

  a1.close();
  a2.close();
  await settle();
  assert.deepEqual(watchersSummed(nats.published), { [S1]: 0, [S2]: 0 });
  for (const p of [a, b]) {
    p.realtime.onModuleDestroy();
    await p.hints.onModuleDestroy();
  }
});

test('when a process stops, its session\'s stream opened again on another is counted and fed there', async () => {
  const nats = natsServer();
  const a = apiserverProcess(nats, 'conn-a');
  const b = apiserverProcess(nats, 'conn-b');
  const onA = a.open(S1);
  await settle();
  nats.liveBatch(S1, 'before');
  // A stops: NATS drops its subscriptions, and A says nothing. Its client opens the stream again, which the web gateway
  // now sends to B.
  nats.drop('conn-a');
  const onB = b.open(S1);
  await settle();
  nats.liveBatch(S1, 'after');
  await settle();
  assert.deepEqual(onA.got, ['before']);
  assert.deepEqual(onB.got, ['after']);
  assert.deepEqual(nats.subscribers(liveSubject(S1)), ['conn-b']);
  // B counts the stream under its own name. The gateway still holds A's last count until it lapses (60 s): one stream
  // too many, which only has the runner go on sending its deltas meanwhile. Then B's alone is left.
  assert.deepEqual(watchersSummed(nats.published), { [S1]: 2 });
  assert.deepEqual(watchersSummed(nats.published, [a.hints.instanceId]), { [S1]: 1 });
  onB.close();
  for (const p of [a, b]) {
    p.realtime.onModuleDestroy();
    await p.hints.onModuleDestroy();
  }
});
