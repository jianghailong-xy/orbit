import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { uuidToBase62 } from '@orbit/shared';

import { TOMBSTONE_EVENT_TYPE } from '../common/system-noise';
import { readLinkEventBatch, refusedValueState, rejectionOf, tombstoneRow, unstorableTombstone } from './link-events';

/**
 * A runner link batch as the events route reads it (link-events.ts; docs/runner-link-design.md §5.8): the events it
 * stores, those it refuses on sight with the code EventAck.rejected names, and the batches it refuses whole. Then the
 * database's own refusals the route isolates by halves (refusedValueState), and the tombstone row.
 */

const TS = '2026-10-25T10:00:00.123Z';
const TURN = '0190a0b0-0000-7000-8000-0000000000f1';
const NOW = new Date('2026-10-25T11:00:00.000Z');

function event(seq: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { seq, type: 'assistant', ts: TS, turnId: TURN, payload: { text: `step ${seq}` }, ...over };
}

function malformed(body: unknown): string {
  try {
    readLinkEventBatch(body, NOW);
  } catch (error) {
    assert.ok(error instanceof BadRequestException, `a ${String(error)} instead of a 400`);
    const answer = error.getResponse() as { code: string; retryable: boolean; message: string };
    assert.equal(answer.code, 'EVENT_BATCH_MALFORMED');
    assert.equal(answer.retryable, true, 'refused as the gateway refuses a malformed batch: the runner sends again');
    return answer.message;
  }
  assert.fail('the batch was taken');
}

test('a batch of good events is stored whole, through its last seq', () => {
  const batch = readLinkEventBatch({ leaseOwner: 'ignored', events: [event(7), event(8), event(9, { turnId: undefined })] }, NOW);
  assert.deepEqual(batch.tombstones, []);
  assert.equal(batch.firstSeq, 7);
  assert.equal(batch.lastSeq, 9);
  assert.deepEqual(batch.events, [
    { seq: 7, type: 'assistant', ts: TS, turnId: TURN, payload: { text: 'step 7' } },
    { seq: 8, type: 'assistant', ts: TS, turnId: TURN, payload: { text: 'step 8' } },
    { seq: 9, type: 'assistant', ts: TS, payload: { text: 'step 9' } },
  ]);
});

test('each bad event is refused on its own, with its code, and the events around it are stored', () => {
  const batch = readLinkEventBatch({
    events: [
      event(1),
      event(2, { type: '' }),
      event(3, { type: 'a type with spaces' }),
      event(4, { type: 'x'.repeat(65) }),
      event(5, { type: 42 }),
      event(6, { type: TOMBSTONE_EVENT_TYPE }),
      event(7, { type: 'text_delta' }),
      event(8, { type: 'tool_output' }),
      event(9, { ts: 'yesterday' }),
      event(10, { ts: '1969-12-31T23:59:59.999Z' }),
      event(11, { ts: 1761386400123 }),
      event(12, { turnId: 'not a turn' }),
      event(13, { turnId: 12 }),
      event(14, { payload: null }),
      event(15, { payload: [1, 2] }),
      event(16, { payload: 'text' }),
      event(17, { payload: undefined }),
      event(18),
    ],
  }, NOW);
  assert.equal(batch.lastSeq, 18);
  assert.deepEqual(batch.events.map((e) => e.seq), [1, 18]);
  assert.deepEqual(
    batch.tombstones.map((t) => [t.seq, t.code]),
    [
      [2, 'EVENT_TYPE_INVALID'],
      [3, 'EVENT_TYPE_INVALID'],
      [4, 'EVENT_TYPE_INVALID'],
      [5, 'EVENT_TYPE_INVALID'],
      [6, 'EVENT_TYPE_INVALID'],
      [7, 'EVENT_LIVE_ONLY'],
      [8, 'EVENT_LIVE_ONLY'],
      [9, 'EVENT_TS_INVALID'],
      [10, 'EVENT_TS_INVALID'],
      [11, 'EVENT_TS_INVALID'],
      [12, 'EVENT_TURN_ID_INVALID'],
      [13, 'EVENT_TURN_ID_INVALID'],
      [14, 'EVENT_PAYLOAD_INVALID'],
      [15, 'EVENT_PAYLOAD_INVALID'],
      [16, 'EVENT_PAYLOAD_INVALID'],
      [17, 'EVENT_PAYLOAD_INVALID'],
    ],
  );
  for (const t of batch.tombstones) assert.ok(t.message.length > 0, `seq ${t.seq} says why`);
  // What is legible of a refused event is kept on its tombstone: a type that is a word, a turn that is one, its time.
  const at = (seq: number) => batch.tombstones.find((t) => t.seq === seq)!;
  assert.equal(at(2).type, null);
  assert.equal(at(7).type, 'text_delta');
  assert.equal(at(7).turnId, TURN);
  assert.equal(at(7).at.toISOString(), TS);
  assert.equal(at(9).at, NOW, 'a time that is not one is the time it was received');
  assert.equal(at(12).turnId, null);
});

test('a turn id in either spelling is stored as the turn UUID', () => {
  const batch = readLinkEventBatch({ events: [event(1, { turnId: uuidToBase62(TURN) }), event(2, { turnId: TURN.toUpperCase() })] }, NOW);
  assert.deepEqual(batch.events.map((e) => e.turnId), [TURN, TURN]);
});

test('NUL is taken out before anything is read, as over HTTPS', () => {
  const batch = readLinkEventBatch({ events: [event(1, { type: 'assist\u0000ant', payload: { text: 'a\u0000b' } })] }, NOW);
  assert.deepEqual(batch.tombstones, []);
  assert.equal(batch.events[0].type, 'assistant');
  assert.deepEqual(batch.events[0].payload, { text: 'ab' });
});

test('a batch that is not one is refused whole: nothing a tombstone could hold', () => {
  assert.match(malformed(undefined), /no events/);
  assert.match(malformed({}), /no events/);
  assert.match(malformed({ events: [] }), /no events/);
  assert.match(malformed({ events: 'many' }), /no events/);
  assert.match(malformed({ events: [null] }), /seq undefined/);
  assert.match(malformed({ events: [event(0)] }), /seq 0 is not an event seq/);
  assert.match(malformed({ events: [event(1.5)] }), /seq 1\.5/);
  assert.match(malformed({ events: [event(2_147_483_648)] }), /seq 2147483648/);
  assert.match(malformed({ events: [event(1, { seq: '1' })] }), /seq "1"/);
  assert.match(malformed({ events: [event(1), event(3)] }), /seq 1 is followed by 3/);
  assert.match(malformed({ events: [event(2), event(1)] }), /seq 2 is followed by 1/);
  assert.match(malformed({ events: [event(1), event(1)] }), /seq 1 is followed by 1/);
});

test('a tombstone row holds the refused seq, why, and what was legible of the event', () => {
  const [tombstone] = readLinkEventBatch({ events: [event(5, { type: 'text_delta' })] }, NOW).tombstones;
  const runnerId = '0190a0b0-0000-7000-8000-0000000000c1';
  const leaseOwner = '0190a0b0-0000-7000-8000-0000000000d1';
  assert.deepEqual(tombstoneRow(tombstone, 'the session', runnerId, leaseOwner), {
    sessionId: 'the session',
    seq: 5,
    type: TOMBSTONE_EVENT_TYPE,
    payload: { code: 'EVENT_LIVE_ONLY', message: tombstone.message, type: 'text_delta' },
    turnId: TURN,
    createdAt: new Date(TS),
    ingestedByRunnerId: runnerId,
    ingestedUnderLeaseGeneration: leaseOwner,
  });
  const [untyped] = readLinkEventBatch({ events: [event(6, { type: '' })] }, NOW).tombstones;
  assert.equal('type' in (tombstoneRow(untyped, 's', runnerId, null).payload as object), false);

  const unstorable = unstorableTombstone({ seq: 9, type: 'tool_use' as never, ts: TS, turnId: TURN, payload: {} }, '22P02');
  assert.deepEqual(unstorable, {
    seq: 9,
    code: 'EVENT_UNSTORABLE',
    message: 'the database refused a value of this event (SQLSTATE 22P02)',
    type: 'tool_use',
    turnId: TURN,
    at: new Date(TS),
  });

  // Read back, a tombstone says what the answer said when it was written: a batch found stored is answered alike.
  const row = tombstoneRow(unstorable, 's', runnerId, leaseOwner);
  assert.deepEqual(rejectionOf({ seq: row.seq, payload: row.payload }), {
    seq: 9,
    code: 'EVENT_UNSTORABLE',
    message: 'the database refused a value of this event (SQLSTATE 22P02)',
  });
});

test('what the database refuses a value for is told apart from every other failure', () => {
  // Prisma 7 keeps PostgreSQL's code two objects down.
  const prismaError = (originalCode: string, code = 'P2010') =>
    Object.assign(new Error('the statement failed'), { code, meta: { driverAdapterError: { cause: { originalCode, kind: 'postgres' } } } });
  assert.equal(refusedValueState(prismaError('22P02')), '22P02', 'text a jsonb or uuid column cannot read');
  assert.equal(refusedValueState(prismaError('22001', 'P2000')), '22001', 'a value too long for its column');
  assert.equal(refusedValueState(prismaError('54000')), '54000', 'an index row too large');
  assert.equal(refusedValueState(Object.assign(new Error('pg'), { code: '22021' })), '22021');

  assert.equal(refusedValueState(prismaError('40001')), null, 'a serialization failure is the transaction, not the value');
  assert.equal(refusedValueState(prismaError('40P01')), null, 'a deadlock');
  assert.equal(refusedValueState(prismaError('53300')), null, 'out of connections');
  assert.equal(refusedValueState(prismaError('57014')), null, 'a cancelled statement');
  assert.equal(refusedValueState(Object.assign(new Error('pool'), { code: 'P2024' })), null, 'the pool');
  assert.equal(refusedValueState(prismaError('23505', 'P2002')), null, 'a duplicate key');
  assert.equal(refusedValueState(prismaError('42703')), null, 'a column the code names and the schema lacks');
  assert.equal(refusedValueState(new ConflictException('runner process no longer owns this session')), null);
  assert.equal(refusedValueState(new TypeError("Cannot read properties of null (reading 'name')")), null);
  assert.equal(refusedValueState(undefined), null);
  // A chain that points back at itself ends.
  const loop: Record<string, unknown> = { message: 'loop' };
  loop.cause = loop;
  assert.equal(refusedValueState(loop), null);
});
