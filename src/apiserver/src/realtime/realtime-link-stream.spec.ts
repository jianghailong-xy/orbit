import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NormalizedRunEvent } from '@orbit/shared';
import { RealtimeService } from './realtime.service';
import type { LinkLiveEvent, LinkTurnPrefix, RunnerHints } from './runner-hints';

/**
 * A session's stream with the runner link configured (RealtimeService.streamForRun; docs/runner-link-design.md §5.9):
 * the hub as before, and beside it what the runner's link carries: the turn's prefix, asked of the runner when the
 * stream opens, then its live events after the prefix, each once. Without the link the stream is the hub alone.
 */

const SESSION = '0190a0b0-0000-7000-8000-0000000000a1';
/** What publish touches of Prisma: the NOTIFY that bridges replicas. */
const prismaForPublish = { $executeRawUnsafe: async () => 0 };
const TURN = '0190a0b0-0000-7000-8000-0000000000b1';

function delta(liveSeq: number, text: string, turnId = TURN): LinkLiveEvent {
  return { liveSeq, event: { seq: 0, type: 'text_delta' as never, payload: { text }, turnId, ts: '2026-10-25T10:00:00.000Z' } };
}

/** RunnerHints as the stream uses it, driven by the test. */
function linkHints() {
  let listener: ((e: LinkLiveEvent) => void) | undefined;
  let answer: (prefix: LinkTurnPrefix | null) => void = () => undefined;
  const calls = { watched: 0, released: 0, stopped: 0, asked: 0 };
  const hints = {
    enabled: true,
    watch: (sessionId: string) => {
      assert.equal(sessionId, SESSION);
      calls.watched += 1;
      return () => void (calls.released += 1);
    },
    liveEvents: (sessionId: string, fn: (e: LinkLiveEvent) => void) => {
      assert.equal(sessionId, SESSION);
      listener = fn;
      return () => void (calls.stopped += 1);
    },
    turnPrefix: (sessionId: string) => {
      assert.equal(sessionId, SESSION);
      calls.asked += 1;
      return new Promise<LinkTurnPrefix | null>((resolve) => { answer = resolve; });
    },
  };
  return {
    hints: hints as unknown as RunnerHints,
    calls,
    live: (e: LinkLiveEvent) => listener?.(e),
    answer: (prefix: LinkTurnPrefix | null) => answer(prefix),
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function texts(events: NormalizedRunEvent[]): string[] {
  return events.map((e) => `${e.type}:${(e.payload as { text?: string }).text ?? ''}`);
}

test('without the runner link a stream is the hub alone, as before', async () => {
  const realtime = new RealtimeService(prismaForPublish as never, {} as never);
  const got: NormalizedRunEvent[] = [];
  const sub = realtime.streamForRun(SESSION).subscribe((e) => got.push(e));
  realtime.publish(SESSION, { seq: 7, type: 'assistant' as never, payload: { text: 'from the hub' }, ts: '2026-10-25T10:00:00.000Z' });
  sub.unsubscribe();
  assert.deepEqual(texts(got), ['assistant:from the hub']);
  realtime.onModuleDestroy();
});

test('the runner\'s prefix comes first, then the live events after it, each once', async () => {
  const link = linkHints();
  const realtime = new RealtimeService(prismaForPublish as never, {} as never, link.hints);
  const got: NormalizedRunEvent[] = [];
  const sub = realtime.streamForRun(SESSION).subscribe((e) => got.push(e));
  assert.deepEqual(link.calls, { watched: 1, released: 0, stopped: 0, asked: 1 });

  // While the runner is asked: held, not sent, and those the prefix will fold in are left out once it answers.
  link.live(delta(6, 'lo'));
  link.live(delta(7, ' wor'));
  link.live(delta(8, 'ld'));
  link.live(delta(2, 'other turn', '0190a0b0-0000-7000-8000-0000000000b2'));
  assert.equal(got.length, 0);
  link.answer({ turnId: TURN, text: 'Hello wor', thinking: 'weighing', throughLiveSeq: 7 });
  await settle();
  assert.deepEqual(texts(got), ['thinking_delta:weighing', 'text_delta:Hello wor', 'text_delta:ld', 'text_delta:other turn']);
  assert.equal(got[1].turnId, TURN);
  assert.equal(got[1].seq, 0, 'a prefix is animation, never history');

  // After the answer, events pass at once, still cut at the prefix within its own turn.
  link.live(delta(5, 'stale'));
  link.live(delta(9, '!'));
  // And the hub's own events as before.
  realtime.publish(SESSION, { seq: 12, type: 'assistant' as never, payload: { text: 'Hello world!' }, ts: '2026-10-25T10:00:01.000Z' });
  assert.deepEqual(texts(got).slice(4), ['text_delta:!', 'assistant:Hello world!']);

  sub.unsubscribe();
  assert.deepEqual(link.calls, { watched: 1, released: 1, stopped: 1, asked: 1 });
  realtime.onModuleDestroy();
});

test('a runner that does not answer leaves the stream with every live event and no prefix', async () => {
  const link = linkHints();
  const realtime = new RealtimeService(prismaForPublish as never, {} as never, link.hints);
  const got: NormalizedRunEvent[] = [];
  const sub = realtime.streamForRun(SESSION).subscribe((e) => got.push(e));
  link.live(delta(1, 'a'));
  link.answer(null);
  await settle();
  link.live(delta(2, 'b'));
  assert.deepEqual(texts(got), ['text_delta:a', 'text_delta:b']);
  sub.unsubscribe();
  realtime.onModuleDestroy();
});

test('a stream closed before the runner answers sends nothing more', async () => {
  const link = linkHints();
  const realtime = new RealtimeService(prismaForPublish as never, {} as never, link.hints);
  const got: NormalizedRunEvent[] = [];
  const sub = realtime.streamForRun(SESSION).subscribe((e) => got.push(e));
  link.live(delta(1, 'a'));
  sub.unsubscribe();
  link.answer({ turnId: TURN, text: 'late', thinking: '', throughLiveSeq: 0 });
  await settle();
  assert.equal(got.length, 0);
  assert.deepEqual(link.calls, { watched: 1, released: 1, stopped: 1, asked: 1 });
  realtime.onModuleDestroy();
});
