import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunEventType, type NormalizedRunEvent } from '@orbit/shared';

import { NON_REPLAYABLE_EVENT_TYPES } from '../common/system-noise';
import { RealtimeService } from './realtime.service';

/**
 * A runner's event batch across replicas (RealtimeService.publishBatch; docs/runner-link-design.md §6.7): every event
 * reaches this replica's streams as before, the other replicas hear of the batch in ONE notification carrying only
 * what was stored, and live-only events are not announced at all. The receiving replica turns that one notification
 * back into the batch's events, whole or read back from run_event.
 */

const SESSION = '0190a0b0-0000-7000-8000-0000000000a1';
const TURN = '0190a0b0-0000-7000-8000-0000000000b1';
const TS = '2026-10-25T10:00:00.000Z';

function ev(seq: number, type: string, payload: Record<string, unknown> = { text: `#${seq}` }): NormalizedRunEvent {
  return { seq, type: type as RunEventType, payload, turnId: TURN, ts: TS };
}

/** What publishing touches of Prisma: the NOTIFYs it issues, and the rows a range is read back from. */
function database(rows: Array<{ seq: number; type: string; payload: unknown; turnId: string | null; createdAt: Date }> = []) {
  const notified: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const reads: unknown[] = [];
  const prisma = {
    $executeRawUnsafe: async (_sql: string, channel: string, payload: string) => {
      notified.push({ channel, payload: JSON.parse(payload) as Record<string, unknown> });
      return 0;
    },
    runEvent: {
      findMany: async (query: { where: { seq: { gte: number; lte: number }; type: { notIn: string[] } } }) => {
        reads.push(query);
        const { gte, lte } = query.where.seq;
        return rows
          .filter((r) => r.seq >= gte && r.seq <= lte && !query.where.type.notIn.includes(r.type))
          .sort((a, b) => a.seq - b.seq);
      },
    },
  };
  return { prisma, notified, reads };
}

/** What a stream of the session receives. */
function watch(realtime: RealtimeService): NormalizedRunEvent[] {
  const seen: NormalizedRunEvent[] = [];
  realtime.streamForRun(SESSION).subscribe((e) => seen.push(e));
  return seen;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a batch reaches this replica\'s streams event by event, and the other replicas in one notification of what was stored', async () => {
  const db = database();
  const realtime = new RealtimeService(db.prisma as never, {} as never);
  const seen = watch(realtime);
  const local: NormalizedRunEvent[] = [];
  realtime.localPublications().subscribe(({ event }) => local.push(event));
  const batch = [
    ev(3, RunEventType.ASSISTANT),
    ev(4, RunEventType.TEXT_DELTA),
    ev(0, RunEventType.TOOL_OUTPUT, { toolUseId: 't1', content: 'running', snapshotSeq: 5 }),
    ev(6, RunEventType.TOOL_USE, { id: 't2', name: 'Bash' }),
    ev(7, RunEventType.BACKGROUND_OUTPUT),
    ev(8, RunEventType.TURN_END),
  ];
  realtime.publishBatch(SESSION, batch);
  await settle();

  assert.deepEqual(seen, batch, 'every event, live or stored, in order');
  assert.deepEqual(local, batch, 'and once each to this replica\'s own consumers');
  assert.equal(db.notified.length, 1, 'one notification for the batch');
  const [note] = db.notified;
  assert.equal(note.channel, 'orbit_event');
  assert.equal(note.payload.r, SESSION);
  assert.deepEqual(
    (note.payload.b as NormalizedRunEvent[]).map((e) => `${e.seq}:${e.type}`),
    ['3:assistant', '6:tool_use', '8:turn_end'],
    'only what was stored: no delta, no tool output snapshot, no background output',
  );
  for (const e of note.payload.b as NormalizedRunEvent[]) {
    assert.equal(NON_REPLAYABLE_EVENT_TYPES.includes(e.type), false);
  }
});

test('a batch of nothing but live events reaches this replica\'s streams and is announced to no other', async () => {
  const db = database();
  const realtime = new RealtimeService(db.prisma as never, {} as never);
  const seen = watch(realtime);
  const live = [ev(1, RunEventType.TEXT_DELTA), ev(2, RunEventType.THINKING_DELTA), ev(3, RunEventType.TASK_PROGRESS)];
  realtime.publishBatch(SESSION, live);
  realtime.publishBatch(SESSION, []);
  await settle();
  assert.deepEqual(seen, live);
  assert.deepEqual(db.notified, []);
});

test('a batch too big to ride along is announced as the seq range it was stored at', async () => {
  const db = database();
  const realtime = new RealtimeService(db.prisma as never, {} as never);
  const big = Array.from({ length: 12 }, (_, i) => ev(20 + i, RunEventType.ASSISTANT, { text: 'x'.repeat(1_000) }));
  realtime.publishBatch(SESSION, [...big, ev(32, RunEventType.TEXT_DELTA)]);
  await settle();
  assert.equal(db.notified.length, 1);
  const { payload } = db.notified[0];
  assert.deepEqual({ r: payload.r, f: payload.f, t: payload.t, b: payload.b }, { r: SESSION, f: 20, t: 31, b: undefined });
  assert.ok(JSON.stringify(payload).length < 200);
});

test('one event published alone is announced alone, as before', async () => {
  const db = database();
  const realtime = new RealtimeService(db.prisma as never, {} as never);
  realtime.publish(SESSION, ev(0, RunEventType.APPROVAL_RESOLVED, { id: 'a1', status: 'ABANDONED' }));
  realtime.publish(SESSION, ev(0, RunEventType.SESSION_UPDATED, {}));
  await settle();
  assert.deepEqual(db.notified.map((n) => (n.payload.e as NormalizedRunEvent).type), ['approval_resolved', 'session_updated']);
});

test('the replica that hears of a batch hands its streams the events, whole or read back in seq order', async () => {
  const origin = database();
  const sender = new RealtimeService(origin.prisma as never, {} as never);
  sender.publishBatch(SESSION, [ev(3, RunEventType.ASSISTANT), ev(4, RunEventType.TEXT_DELTA), ev(5, RunEventType.TURN_END)]);
  const big = Array.from({ length: 12 }, (_, i) => ev(20 + i, RunEventType.ASSISTANT, { text: 'x'.repeat(1_000) }));
  sender.publishBatch(SESSION, big);
  await settle();
  assert.equal(origin.notified.length, 2);

  // The rows the ingest stored in that range, where seqs 25 to 27 hold a tombstone, a legacy live-only row and a
  // noise ping.
  const createdAt = new Date(TS);
  const receiving = database([
    { seq: 27, type: RunEventType.SYSTEM, payload: { subtype: 'status', model: null }, turnId: null, createdAt },
    { seq: 26, type: RunEventType.TOOL_OUTPUT, payload: {}, turnId: null, createdAt },
    { seq: 25, type: 'tombstone', payload: { code: 'EVENT_PAYLOAD_INVALID' }, turnId: null, createdAt },
    ...big
      .filter((e) => e.seq < 25 || e.seq > 27)
      .map((e) => ({ seq: e.seq, type: e.type as string, payload: e.payload, turnId: TURN, createdAt })),
  ]);
  const replica = new RealtimeService(receiving.prisma as never, {} as never);
  const seen = watch(replica);
  const hear = (replica as unknown as { onNotify(channel: string, payload: string): void }).onNotify.bind(replica);
  for (const { channel, payload } of origin.notified) hear(channel, JSON.stringify(payload));
  await settle();
  await settle();

  assert.deepEqual(seen.slice(0, 2).map((e) => `${e.seq}:${e.type}`), ['3:assistant', '5:turn_end'], 'the small batch, whole');
  const readBack = seen.slice(2);
  assert.deepEqual(
    readBack.map((e) => e.seq),
    big.map((e) => e.seq).filter((seq) => seq < 25 || seq > 27),
    'the big one read back in seq order: neither the tombstone, the legacy live row nor the noise ping',
  );
  assert.equal(readBack[0].ts, TS);
  assert.equal(receiving.reads.length, 1);

  // A replica's own notification is never handed to its streams a second time.
  const before = seen.length;
  const own = sender as unknown as { onNotify(channel: string, payload: string): void };
  const mine: NormalizedRunEvent[] = [];
  sender.streamForRun(SESSION).subscribe((e) => mine.push(e));
  for (const { channel, payload } of origin.notified) own.onNotify(channel, JSON.stringify(payload));
  await settle();
  assert.deepEqual(mine, []);
  assert.equal(seen.length, before);
});
