import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { RunEventType } from '@orbit/shared';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsController } from './sessions.controller';

/**
 * The half-sentence you get when you open a session that is already replying.
 *
 * `text_delta` / `thinking_delta` are broadcast-only animation: the ingress drops them
 * (NON_REPLAYABLE_EVENT_TYPES) and the replay query filters them again, so nothing on the server
 * remembered what a turn had already streamed. A client connecting mid-reply therefore joined the
 * engine wherever it happened to be — the bubble opened mid-word, and stayed wrong until the turn's
 * authoritative `assistant` event landed and replaced it.
 *
 * So the turn's streamed text is retained where it is broadcast (RealtimeService) and handed over
 * once, at the moment the SSE handler takes over from the replay. Both halves are driven here for
 * real: the events go through `RealtimeService.publish` and come back out of
 * `SessionsController.events`, because "the prefix survives" is a claim about the two together.
 */

const SESSION = '01a00b25-7e01-7b13-8319-804bce6e90dc';
const TS = '2026-09-05T08:00:00.000Z';

/** Enough of a run_event row for the controller's map(). A transcript whose reply is still being
 *  streamed ends on the prompt that asked for it. */
const promptRow = () => ({
  seq: 10,
  type: RunEventType.USER as string,
  payload: { text: 'write me a sentence' },
  turnId: null,
  createdAt: new Date(TS),
});

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Longer than DELTA_COALESCE_MS, so anything published has certainly been flushed. */
const AFTER_COALESCE_MS = 80;

/**
 * The real RealtimeService: what it retains across a turn is half of what this spec asserts, so a
 * double would be asserting itself. `publish` also NOTIFYs the other replicas through Prisma —
 * nothing here listens, and one raw call is all that has to answer.
 */
const hub = (): RealtimeService =>
  new RealtimeService({ $executeRawUnsafe: async () => 0 } as never, {} as never);

/** Publish as the runner ingress does: live-only kinds ride seq 0, durable ones carry theirs. */
const publish = (
  realtime: RealtimeService,
  type: RunEventType,
  payload: Record<string, unknown>,
  seq = 0,
): void => realtime.publish(SESSION, { seq, type, ts: TS, payload });

const streamed = (realtime: RealtimeService, text: string): void =>
  publish(realtime, RunEventType.TEXT_DELTA, { text });

const thought = (realtime: RealtimeService, text: string): void =>
  publish(realtime, RunEventType.THINKING_DELTA, { text });

function controllerOver(
  realtime: RealtimeService,
  query: () => Promise<unknown[]> = async () => [promptRow()],
): SessionsController {
  const prisma = {
    session: { findFirst: async () => ({ id: SESSION }) },
    $queryRaw: query,
  };
  return new SessionsController({} as never, prisma as never, realtime, {} as never, {} as never);
}

/** A `$queryRaw` that does not answer until the test lets it — the replay window. */
function gatedQuery(rows: () => unknown[]) {
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => (open = r));
  return {
    query: async () => {
      await gate;
      return rows();
    },
    release: (): Promise<void> => {
      open();
      return tick(AFTER_COALESCE_MS);
    },
  };
}

/** A cold connect: no `sinceSeq`, exactly as a client opening a session for the first time. Torn
 *  down after the test whatever it concludes — the ~20s keepalive would otherwise outlive it. */
function connect(t: TestContext, controller: SessionsController) {
  const seen: any[] = [];
  const errors: unknown[] = [];
  const sub = (
    controller.events({ userId: 'u1' } as never, SESSION, undefined, '2048') as any
  ).subscribe({
    next: (m: any) => {
      if (m.data.type !== 'ping') seen.push(m.data);
    },
    error: (e: unknown) => errors.push(e),
  });
  t.after(() => sub.unsubscribe());
  return {
    seen,
    errors,
    types: () => seen.map((d) => d.type),
    /** Every streamed text frame, joined: what the client's open bubble ends up holding. */
    text: () =>
      seen
        .filter((d) => d.type === RunEventType.TEXT_DELTA)
        .map((d) => d.payload.text)
        .join(''),
    thinking: () =>
      seen
        .filter((d) => d.type === RunEventType.THINKING_DELTA)
        .map((d) => d.payload.text)
        .join(''),
  };
}

test('a client connecting mid-reply is handed the text the session already streamed', async (t) => {
  const realtime = hub();
  // Streamed before anybody was watching. None of it is persisted, so no replay can carry it.
  streamed(realtime, 'The quick brown fox ');
  streamed(realtime, 'jumps over ');

  const stream = connect(t, controllerOver(realtime));
  await tick(AFTER_COALESCE_MS);

  streamed(realtime, 'the lazy dog.');
  await tick(AFTER_COALESCE_MS);

  // The whole reply, not the tail of it: this used to open at "the lazy dog.".
  assert.equal(stream.text(), 'The quick brown fox jumps over the lazy dog.');
  assert.deepEqual(stream.types(), [
    RunEventType.USER,
    RunEventType.TEXT_DELTA,
    RunEventType.TEXT_DELTA,
  ]);
});

test('the thinking a turn has streamed comes back too, ahead of its text', async (t) => {
  const realtime = hub();
  thought(realtime, 'The user wants one sentence. ');
  streamed(realtime, 'The quick brown fox ');

  const stream = connect(t, controllerOver(realtime));
  await tick(AFTER_COALESCE_MS);

  assert.equal(stream.thinking(), 'The user wants one sentence. ');
  assert.equal(stream.text(), 'The quick brown fox ');
  // Thinking precedes the text it reasoned toward; the two drive separate drafts on every client.
  assert.deepEqual(stream.types(), [
    RunEventType.USER,
    RunEventType.THINKING_DELTA,
    RunEventType.TEXT_DELTA,
  ]);
});

test('the prefix is handed over once, never alongside a second copy of itself', async (t) => {
  const realtime = hub();
  streamed(realtime, 'Half a ');

  // The rest of the sentence is streamed while the replay query is still in flight, which is
  // exactly where the same text could reach one client down both halves at once.
  const gate = gatedQuery(() => [promptRow()]);
  const stream = connect(t, controllerOver(realtime, gate.query));
  await tick(20);
  streamed(realtime, 'sentence.');
  await gate.release();

  assert.equal(stream.text(), 'Half a sentence.');
  assert.equal(
    stream.seen.filter((d) => String(d.payload.text ?? '').includes('Half a ')).length,
    1,
    'the prefix arrives in exactly one frame',
  );
});

/** Everything that supersedes a live draft, in the client's own terms (steerDelivery's
 *  `supersedesLiveDrafts` plus the two cases beside it in WorkspaceView). */
const BOUNDARIES: [string, RunEventType, Record<string, unknown>][] = [
  ['the authoritative assistant text', RunEventType.ASSISTANT, { text: 'The quick brown fox.' }],
  ['turn_end', RunEventType.TURN_END, {}],
  ['a user turn that is not a steer', RunEventType.USER, { text: 'do something else' }],
  ['an interrupt', RunEventType.INTERRUPT, {}],
  ['an error', RunEventType.ERROR, { message: 'engine died' }],
  ['a resumed system event', RunEventType.SYSTEM, { subtype: 'resumed' }],
];

for (const [name, type, payload] of BOUNDARIES) {
  test(`${name} ends the turn: a later connect is told nothing about it`, async (t) => {
    const realtime = hub();
    streamed(realtime, 'The quick brown fox ');
    publish(realtime, type, payload, 11);

    const stream = connect(t, controllerOver(realtime));
    await tick(AFTER_COALESCE_MS);

    // Whatever this client is shown comes from the transcript. Replaying last turn's half-sentence
    // into a fresh bubble would be a worse lie than the one this whole path removes.
    assert.deepEqual(stream.types(), [RunEventType.USER]);
    assert.equal(stream.text(), '');
  });
}

test('a steer is not a boundary: the turn it lands in keeps streaming into the same draft', async (t) => {
  const realtime = hub();
  streamed(realtime, 'The quick brown fox ');
  publish(realtime, RunEventType.USER, { text: 'make it about a cat', steer: true }, 11);

  const stream = connect(t, controllerOver(realtime));
  await tick(AFTER_COALESCE_MS);

  assert.equal(stream.text(), 'The quick brown fox ');
});

test('a durable thinking block ends its own draft and leaves the text alone', async (t) => {
  const realtime = hub();
  thought(realtime, 'One sentence, then. ');
  streamed(realtime, 'The quick brown fox ');
  publish(realtime, RunEventType.THINKING, { text: 'One sentence, then. ' }, 11);

  const stream = connect(t, controllerOver(realtime));
  await tick(AFTER_COALESCE_MS);

  // The thinking is durable now and arrives with the transcript; the text is still being written.
  assert.equal(stream.thinking(), '');
  assert.equal(stream.text(), 'The quick brown fox ');
});

test('a session that ended releases what it was holding', async (t) => {
  const realtime = hub();
  streamed(realtime, 'The quick brown fox ');
  publish(realtime, RunEventType.SESSION_ENDED, { status: 'COMPLETED' });

  const stream = connect(t, controllerOver(realtime));
  await tick(AFTER_COALESCE_MS);

  assert.deepEqual(stream.types(), [RunEventType.USER]);
});

test('a turn past the retention cap degrades to no backfill rather than holding it all', async (t) => {
  const realtime = hub();
  // 66,000 characters is past TURN_PREFIX_MAX_CHARS. Retaining a suffix would open the bubble
  // mid-word all over again, so the answer is the behaviour this change replaced — and, above all,
  // not an error on the broadcast path that every event in the system goes through.
  assert.doesNotThrow(() => {
    for (let i = 0; i < 66; i += 1) streamed(realtime, 'x'.repeat(1000));
  });

  const stream = connect(t, controllerOver(realtime));
  await tick(AFTER_COALESCE_MS);

  assert.deepEqual(stream.types(), [RunEventType.USER]);
  assert.equal(stream.text(), '');

  // And the stream itself is healthy: what the session streams from here still arrives.
  streamed(realtime, 'still streaming');
  await tick(AFTER_COALESCE_MS);
  assert.equal(stream.text(), 'still streaming');
  assert.deepEqual(stream.errors, []);
});
