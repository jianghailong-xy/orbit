import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Subject, firstValueFrom, toArray } from 'rxjs';
import { RunEventType } from '@orbit/shared';
import { coalesceDeltas, isStreamingDelta } from './coalesce-deltas';

interface Ev {
  seq: number;
  type: string;
  payload?: unknown;
}

const delta = (text: string, type: string = RunEventType.TEXT_DELTA): Ev => ({
  seq: 0,
  type,
  payload: { text },
});
const plain = (type: string, seq = 1): Ev => ({ seq, type, payload: {} });

/** Feed `events` through the operator and collect everything it emits. */
async function run(events: Ev[], windowMs = 5): Promise<Ev[]> {
  const src = new Subject<Ev>();
  const collected = firstValueFrom(src.pipe(coalesceDeltas<Ev>(windowMs), toArray()));
  for (const e of events) src.next(e);
  src.complete();
  return collected;
}

const texts = (evs: Ev[]): string[] =>
  evs.map((e) => (e.payload as { text?: string } | undefined)?.text ?? `<${e.type}>`);

test('merges a run of consecutive text deltas into one message', async () => {
  const out = await run([delta('Hel'), delta('lo '), delta('world')]);
  assert.equal(out.length, 1);
  assert.deepEqual(texts(out), ['Hello world']);
});

test('flushes buffered text BEFORE the event that supersedes it', async () => {
  // The ordering that matters: every one of these tells the client to clear its streaming
  // buffer, so text arriving after one would repopulate a bubble nothing clears again.
  for (const type of [
    RunEventType.ASSISTANT,
    RunEventType.TURN_END,
    RunEventType.USER,
    RunEventType.INTERRUPT,
    RunEventType.ERROR,
  ]) {
    const out = await run([delta('par'), delta('tial'), plain(type)]);
    assert.deepEqual(texts(out), ['partial', `<${type}>`], `wrong order around ${type}`);
  }
});

test('does not concatenate across delta kinds', async () => {
  // thinking and text drive separate buffers on the client; merging them would splice
  // reasoning into the reply.
  const out = await run([
    delta('think', RunEventType.THINKING_DELTA),
    delta('ing', RunEventType.THINKING_DELTA),
    delta('ans', RunEventType.TEXT_DELTA),
    delta('wer', RunEventType.TEXT_DELTA),
  ]);
  assert.deepEqual(texts(out), ['thinking', 'answer']);
  assert.deepEqual(
    out.map((e) => e.type),
    [RunEventType.THINKING_DELTA, RunEventType.TEXT_DELTA],
  );
});

test('passes non-delta events through untouched', async () => {
  const tool = { seq: 7, type: RunEventType.TOOL_USE, payload: { name: 'Bash' } };
  const out = await run([tool]);
  assert.deepEqual(out, [tool]);
});

test('never mutates the source event — the hub shares it with every subscriber', async () => {
  const first = delta('a');
  const second = delta('b');
  const snapshot = JSON.stringify([first, second]);
  const out = await run([first, second]);
  assert.deepEqual(texts(out), ['ab']);
  assert.equal(JSON.stringify([first, second]), snapshot, 'inputs were mutated');
  assert.notEqual(out[0], first, 'emitted the source object rather than a copy');
});

test('keeps the first delta of a run as the envelope', async () => {
  const out = await run([{ seq: 0, type: RunEventType.TEXT_DELTA, payload: { text: 'x', extra: 1 } }, delta('y')]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].payload, { extra: 1, text: 'xy' });
});

test('emits buffered text when the stream completes mid-run', async () => {
  // A turn that ends by disconnect must not swallow the tail of the reply.
  const out = await run([delta('trailing')]);
  assert.deepEqual(texts(out), ['trailing']);
});

test('a delta whose text is not a string passes through rather than being swallowed', async () => {
  const odd = { seq: 0, type: RunEventType.TEXT_DELTA, payload: { text: 42 } };
  const out = await run([delta('a'), odd]);
  assert.equal(out.length, 2);
  // The buffered run is flushed first, then the unmergeable event is forwarded verbatim.
  assert.deepEqual(out[0].payload, { text: 'a' });
  assert.deepEqual(out[1], odd);
});

test('flushes on the window timer while a turn is still streaming', async () => {
  const src = new Subject<Ev>();
  const seen: Ev[] = [];
  const sub = src.pipe(coalesceDeltas<Ev>(10)).subscribe((e) => seen.push(e));
  src.next(delta('one'));
  src.next(delta(' two'));
  await new Promise((r) => setTimeout(r, 60));
  // Flushed by the timer, without any terminating event.
  assert.deepEqual(texts(seen), ['one two']);
  src.next(delta(' three'));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(texts(seen), ['one two', ' three']);
  sub.unsubscribe();
});

test('the window bounds latency: the timer is not extended by later chunks', async () => {
  const src = new Subject<Ev>();
  const seen: Ev[] = [];
  const sub = src.pipe(coalesceDeltas<Ev>(40)).subscribe((e) => seen.push(e));
  src.next(delta('a'));
  // Keep feeding well past the window; a timer restarted on each chunk would starve forever.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 15));
    src.next(delta('b'));
  }
  assert.ok(seen.length >= 1, 'a continuous stream never flushed within its window');
  sub.unsubscribe();
});

test('isStreamingDelta covers exactly the broadcast-only delta types', () => {
  assert.equal(isStreamingDelta(RunEventType.TEXT_DELTA), true);
  assert.equal(isStreamingDelta(RunEventType.THINKING_DELTA), true);
  assert.equal(isStreamingDelta(RunEventType.ASSISTANT), false);
  assert.equal(isStreamingDelta(RunEventType.THINKING), false);
  assert.equal(isStreamingDelta(RunEventType.TOOL_RESULT), false);
});
