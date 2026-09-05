import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Observable } from 'rxjs';
import { RunEventType } from '@orbit/shared';
import { SessionsController } from './sessions.controller';

/**
 * The window between the replay and the live half.
 *
 * `GET /sessions/:id/events` answers with history first and the hub second. For as long as those
 * were `concat`ed, the hub was subscribed only once the history query had come back — so every
 * event the runner published during that round trip landed on nobody, and nothing ever brought it
 * back: the hub is a bare Subject with no replay, and clients dedup by seq without assuming seq is
 * contiguous, so the hole is invisible to them.
 *
 * One round trip is a small window, but a session that is mid-reply is exactly when events are
 * densest. Losing the authoritative `assistant` there leaves the streaming draft nothing will ever
 * clear, and the tool cards that follow render underneath that half-finished bubble until the turn
 * ends.
 *
 * So the contract asserted here is: subscribe first, query second, and hold what arrives in
 * between — then hand it over without repeating what the replay already carried.
 */

const SESSION = '01a00b25-7e01-7b13-8319-804bce6e90dc';

/** Enough of a run_event row for the controller's map(). */
const row = (seq: number, type: string = RunEventType.ASSISTANT, payload: unknown = { text: 'hi' }) => ({
  seq,
  type,
  payload,
  turnId: null,
  createdAt: new Date('2026-09-05T08:00:00Z'),
});

/** What `RealtimeService.publish` hands the hub: no `createdAt`, and `ts` already a string. */
const published = (seq: number, type: string, payload: unknown = {}) => ({
  seq,
  type,
  ts: '2026-09-05T08:00:00.000Z',
  payload,
});

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Longer than DELTA_COALESCE_MS, so a buffered delta has certainly been flushed. */
const AFTER_COALESCE_MS = 80;

/** A hub whose subscribe/unsubscribe moments the test can see, plus the publish side. */
function fakeHub() {
  const state = { subscribed: 0, unsubscribed: 0 };
  let emit: ((e: unknown) => void) | null = null;
  const stream = new Observable<unknown>((subscriber) => {
    state.subscribed += 1;
    emit = (e) => subscriber.next(e);
    return () => {
      state.unsubscribed += 1;
      emit = null;
    };
  });
  // A bare Subject with no subscriber drops what is published on it — which is the whole defect
  // this spec is about, so the fake drops it here too rather than announcing it.
  return { state, stream, publish: (e: unknown) => emit?.(e) };
}

/** A `$queryRaw` that does not answer until the test lets it — the window this spec is about. */
function gatedQuery(answer: () => Promise<unknown[]>) {
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  return {
    query: async () => {
      await gate;
      return answer();
    },
    release: (): Promise<void> => {
      open();
      return tick(AFTER_COALESCE_MS);
    },
  };
}

function controllerOver(query: () => Promise<unknown>, hub: Observable<unknown>, owned = true): SessionsController {
  const prisma = {
    session: { findFirst: async () => (owned ? { id: SESSION } : null) },
    $queryRaw: query,
  };
  return new SessionsController(
    {} as never,
    prisma as never,
    { streamForRun: () => hub } as never,
    {} as never,
    {} as never,
  );
}

/** Subscribes the SSE stream and records the frames, minus the ~20s keepalive pings. Torn down
 *  after the test whatever it concludes: the keepalive timer would otherwise outlive it. */
function listen(t: TestContext, controller: SessionsController, sinceSeq?: string) {
  const seen: any[] = [];
  const errors: unknown[] = [];
  const sub = (controller.events({ userId: 'u1' } as never, SESSION, sinceSeq, '2048') as any).subscribe({
    next: (m: any) => {
      if (m.data.type !== 'ping') seen.push(m.data);
    },
    error: (e: unknown) => errors.push(e),
  });
  t.after(() => sub.unsubscribe());
  return { seen, errors, sub, types: () => seen.map((d) => d.type), seqs: () => seen.map((d) => d.seq) };
}

test('an event published while the replay query is in flight still reaches the client', async (t) => {
  const hub = fakeHub();
  const gate = gatedQuery(async () => [row(10, RunEventType.USER, { text: 'write me a sentence' })]);
  const stream = listen(t, controllerOver(gate.query, hub.stream), '9');

  // Mid-query: the turn's authoritative full text — the event every client clears its streaming
  // draft on. Under `concat` nobody was listening yet and this was simply gone.
  await tick(20);
  hub.publish(published(11, RunEventType.ASSISTANT, { text: 'the whole reply' }));

  await gate.release();
  hub.publish(published(12, RunEventType.TOOL_USE, { id: 't1', name: 'Bash' }));
  await tick();

  assert.deepEqual(stream.types(), [RunEventType.USER, RunEventType.ASSISTANT, RunEventType.TOOL_USE]);
  assert.deepEqual(stream.seqs(), [10, 11, 12]);
  assert.equal(stream.seen[1].payload.text, 'the whole reply');
});

test('an event the replay already carried is not handed over twice', async (t) => {
  const hub = fakeHub();
  // The row is already committed when the query snapshots it, and its broadcast lands in the
  // window: the same event reaches this stream down both halves.
  const gate = gatedQuery(async () => [row(10, RunEventType.USER, { text: 'go' }), row(11)]);
  const stream = listen(t, controllerOver(gate.query, hub.stream), '9');

  await tick(20);
  hub.publish(published(11, RunEventType.ASSISTANT, { text: 'hi' }));

  await gate.release();
  hub.publish(published(12, RunEventType.TOOL_USE, { id: 't1', name: 'Bash' }));
  await tick();

  assert.deepEqual(stream.seqs(), [10, 11, 12]);
});

test('the live-only events buffered in the window are not deduped away with it', async (t) => {
  const hub = fakeHub();
  const gate = gatedQuery(async () => [row(10, RunEventType.USER, { text: 'go' }), row(11)]);
  const stream = listen(t, controllerOver(gate.query, hub.stream), '9');

  // Approvals, resyncs, tool_output and the deltas all ride seq 0 — they are never persisted, so
  // no replay can carry them and the seq comparison above must not claim them.
  await tick(20);
  hub.publish(published(0, RunEventType.APPROVAL_REQUEST, { id: 'a1' }));

  await gate.release();

  assert.deepEqual(stream.types(), [RunEventType.USER, RunEventType.ASSISTANT, RunEventType.APPROVAL_REQUEST]);
});

test('a boundary event buffered in the window still lands after the deltas it supersedes', async (t) => {
  const hub = fakeHub();
  const gate = gatedQuery(async () => [row(10, RunEventType.USER, { text: 'go' })]);
  const stream = listen(t, controllerOver(gate.query, hub.stream), '9');

  // coalesceDeltas flushes buffered text before any boundary event, because a delta arriving
  // *after* one repopulates a bubble nothing will clear again. Holding the live half must not
  // reorder that.
  await tick(20);
  hub.publish(published(0, RunEventType.TEXT_DELTA, { text: 'jumps over ' }));
  hub.publish(published(0, RunEventType.TEXT_DELTA, { text: 'the lazy dog.' }));
  hub.publish(published(11, RunEventType.ASSISTANT, { text: 'the whole reply' }));

  await gate.release();

  assert.deepEqual(stream.types(), [RunEventType.USER, RunEventType.TEXT_DELTA, RunEventType.ASSISTANT]);
  assert.equal(stream.seen[1].payload.text, 'jumps over the lazy dog.');
});

test('the deltas a replayed boundary event already superseded are dropped with it', async (t) => {
  const hub = fakeHub();
  const gate = gatedQuery(async () => [row(11, RunEventType.ASSISTANT, { text: 'The quick brown fox.' })]);
  const stream = listen(t, controllerOver(gate.query, hub.stream), '9');

  // Dropping the duplicate `assistant` on its own would leave its own deltas trailing behind the
  // full text the replay already delivered — the stray half-finished bubble this whole path
  // exists to avoid.
  await tick(20);
  hub.publish(published(0, RunEventType.TEXT_DELTA, { text: 'The quick ' }));
  hub.publish(published(11, RunEventType.ASSISTANT, { text: 'The quick brown fox.' }));

  await gate.release();
  hub.publish(published(0, RunEventType.TEXT_DELTA, { text: 'Next turn ' }));
  await tick(AFTER_COALESCE_MS);

  // The delta after the release belongs to whatever comes next and is kept.
  assert.deepEqual(stream.types(), [RunEventType.ASSISTANT, RunEventType.TEXT_DELTA]);
  assert.equal(stream.seen[1].payload.text, 'Next turn ');
});

test('a buffer past its bound is answered with a resync, not a silent hole', async (t) => {
  const hub = fakeHub();
  const gate = gatedQuery(async () => [row(10, RunEventType.USER, { text: 'go' })]);
  const stream = listen(t, controllerOver(gate.query, hub.stream), '9');

  // 501 events is what "more than the live buffer holds" looks like. Handing over what survived
  // would leave a hole the client cannot see, so it is told to re-seed instead — the same answer
  // an over-long replay gap gets.
  await tick(20);
  for (let i = 0; i < 501; i += 1) {
    hub.publish(published(100 + i, RunEventType.TOOL_USE, { id: `t${i}`, name: 'Bash' }));
  }

  await gate.release();

  assert.deepEqual(stream.types(), [RunEventType.USER, RunEventType.RESYNC]);
  // Seq 0 keeps it clear of the client's dedup, like every other live-only control event.
  assert.equal(stream.seen[1].seq, 0);
});

test('a failing replay query takes the live subscription down with it', async (t) => {
  const hub = fakeHub();
  const stream = listen(
    t,
    controllerOver(async () => {
      throw new Error('connection terminated');
    }, hub.stream),
    '9',
  );

  await tick(20);

  assert.equal(hub.state.subscribed, 1, 'the hub is subscribed before the query, not after');
  assert.equal(stream.errors.length, 1);
  assert.equal(hub.state.unsubscribed, 1, 'and torn down again when the query fails');
});

test('a non-owner never reaches the hub at all', async (t) => {
  const hub = fakeHub();
  const stream = listen(
    t,
    controllerOver(async () => [row(10)], hub.stream, false),
    '9',
  );

  await tick(20);

  // Subscribing to live earlier must not move it above the ownership gate.
  assert.equal(hub.state.subscribed, 0);
  assert.equal(stream.seen.length, 0);
  assert.equal(stream.errors.length, 1);
});
