import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  decodeLiveBatch,
  decodeTurnPrefixResponse,
  INSTANCE_HEADER,
  liveSubject,
  RunnerHints,
  runnerHintSubject,
  turnPrefixRequestMessage,
  WATCHERS_REFRESH_MS,
  type HintBus,
} from './runner-hints';

/**
 * The live stream's half of the runner link hints (runner-hints.ts; docs/runner-link-design.md §5.9): who watches a
 * session, told to its runner with this instance named; the live events the gateway publishes, read back; and the
 * turn prefix asked of the runner. All of it only while the link is configured.
 */

const RUNNER_A = '0190a0b0-0000-7000-8000-00000000000a';
const SESSION_ON_A = '0190a0b0-0000-7000-8000-0000000000a1';
const SESSION_WITHOUT_RUNNER = '0190a0b0-0000-7000-8000-0000000000c1';

// From build/realtime back to the repository root, as the compose specs read the repository.
const ROOT = path.resolve(__dirname, '../../../..');

type Sent = { subject: string; message: string; headers?: Record<string, string> };

/** NATS as the hints see it: what is published, who subscribes, and what a request is answered with. */
function fakeBus() {
  const sent: Sent[] = [];
  const subscriptions = new Map<string, Set<(data: Uint8Array) => void>>();
  const requests: Array<{ subject: string; message: string; timeoutMs: number }> = [];
  let answer: (subject: string, message: string) => string | null = () => null;
  const bus: HintBus = {
    up: true,
    publish: (subject, message, headers) => void sent.push({ subject, message, ...(headers ? { headers } : {}) }),
    subscribe: (subject, onMessage) => {
      const set = subscriptions.get(subject) ?? new Set();
      set.add(onMessage);
      subscriptions.set(subject, set);
      return () => {
        set.delete(onMessage);
        if (set.size === 0) subscriptions.delete(subject);
      };
    },
    request: async (subject, message, timeoutMs) => {
      requests.push({ subject, message, timeoutMs });
      const reply = answer(subject, message);
      return reply === null ? null : new TextEncoder().encode(reply);
    },
    close: async () => undefined,
  };
  return {
    bus,
    sent,
    subscriptions,
    requests,
    answerWith: (fn: typeof answer) => { answer = fn; },
    deliver: (subject: string, message: string) => {
      for (const fn of subscriptions.get(subject) ?? []) fn(new TextEncoder().encode(message));
    },
  };
}

function hintsOver(bus: HintBus) {
  const prisma = {
    session: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === SESSION_ON_A ? { assignedRunnerId: RUNNER_A } : where.id === SESSION_WITHOUT_RUNNER ? { assignedRunnerId: null } : null,
    },
  };
  const hints = new RunnerHints(prisma as never, 'nats://nats.test:4222', () => bus);
  (hints as unknown as { log: { log(): void; warn(): void } }).log = { log: () => undefined, warn: () => undefined };
  hints.onModuleInit();
  return hints;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The watchers hints published, as [count, instance header]. */
function watchersSent(sent: Sent[]): Array<[number, string | undefined]> {
  return sent.filter((s) => s.message.includes('"watchers"')).map((s) => {
    assert.equal(s.subject, runnerHintSubject(RUNNER_A));
    const hint = JSON.parse(s.message).hint.watchers as { sessionId: string; watchers: number };
    assert.equal(hint.sessionId, SESSION_ON_A);
    return [hint.watchers, s.headers?.[INSTANCE_HEADER]];
  });
}

test('each stream of a session is counted, and the runner told every new count, naming this instance', async () => {
  const nats = fakeBus();
  const hints = hintsOver(nats.bus);
  const first = hints.watch(SESSION_ON_A);
  const second = hints.watch(SESSION_ON_A);
  await settle();
  first();
  first(); // a release is once
  await settle();
  second();
  await settle();
  assert.deepEqual(watchersSent(nats.sent), [[1, hints.instanceId], [2, hints.instanceId], [1, hints.instanceId], [0, hints.instanceId]]);
  await hints.onModuleDestroy();
});

test('a count that is not zero is published again, so the gateway keeps it; one that is zero is not', async () => {
  const nats = fakeBus();
  const hints = hintsOver(nats.bus);
  const release = hints.watch(SESSION_ON_A);
  await settle();
  hints.refreshWatchers();
  await settle();
  release();
  await settle();
  hints.refreshWatchers();
  await settle();
  assert.deepEqual(watchersSent(nats.sent).map(([n]) => n), [1, 1, 0]);
  assert.ok(WATCHERS_REFRESH_MS < 60_000, 'refreshed well within the gateway\'s 60 s');
  await hints.onModuleDestroy();
});

test('the heartbeat route is given this instance\'s counts of the sessions it names', () => {
  const nats = fakeBus();
  const hints = hintsOver(nats.bus);
  hints.watch(SESSION_ON_A);
  hints.watch(SESSION_ON_A);
  assert.deepEqual(hints.watchersOf([SESSION_ON_A, SESSION_WITHOUT_RUNNER, SESSION_ON_A]), {
    instance: hints.instanceId,
    sessions: [{ sessionId: SESSION_ON_A, watchers: 2 }],
  });
});

test('off, a stream is counted nowhere and nothing is asked', async () => {
  let opened = 0;
  const hints = new RunnerHints({} as never, null, () => {
    opened += 1;
    return fakeBus().bus;
  });
  hints.onModuleInit();
  hints.watch(SESSION_ON_A)();
  const stop = hints.liveEvents(SESSION_ON_A, () => assert.fail('no live events while off'));
  stop();
  assert.equal(await hints.turnPrefix(SESSION_ON_A), null);
  assert.equal(opened, 0);
  assert.deepEqual(hints.watchersOf([SESSION_ON_A]).sessions, []);
});

/** testdata/b4-live.json: what the gateway publishes, written by its own encoder (src/link-gateway/fixtures_test.go). */
function gatewayFixture(): Array<{ name: string; subject: string; message: string }> {
  return (JSON.parse(readFileSync(path.join(ROOT, 'src/link-gateway/testdata/b4-live.json'), 'utf8')) as {
    cases: Array<{ name: string; subject: string; message: string }>;
  }).cases;
}

test('a live batch the gateway published reads back as the live events a client streams', () => {
  const [deltas, mixed] = gatewayFixture();
  assert.equal(deltas.subject, liveSubject(SESSION_ON_A));
  const turnId = '0190a0b0-0000-7000-8000-0000000000b1';
  assert.deepEqual(decodeLiveBatch(deltas.message, SESSION_ON_A), [
    { liveSeq: 41, event: { seq: 0, type: 'thinking_delta', payload: { text: 'weighing <b> & ü' }, turnId, ts: new Date(1761380000123).toISOString() } },
    { liveSeq: 42, event: { seq: 0, type: 'text_delta', payload: { text: 'Hello wor' }, turnId, ts: new Date(1761380000124).toISOString() } },
    { liveSeq: 9007199254740990, event: { seq: 0, type: 'text_delta', payload: { text: 'ld — 中文' }, turnId, ts: new Date(1761380000125).toISOString() } },
  ]);
  // A tool output snapshot is bounded and ordered by its live_seq as over HTTPS; a durable type is never live.
  const events = decodeLiveBatch(mixed.message, SESSION_ON_A);
  assert.deepEqual(events.map((e) => e.event.type), ['tool_output', 'background_output']);
  assert.deepEqual(events[0].event, {
    seq: 0, type: 'tool_output', ts: new Date(1761380000126).toISOString(), turnId,
    payload: { toolUseId: 'toolu_01', content: 'line 1\nline 2', snapshotSeq: 43 },
  });
  assert.equal(events[1].event.turnId, undefined);
  // Another session's batch, or something that is not one, reads as nothing.
  assert.deepEqual(decodeLiveBatch(deltas.message, SESSION_WITHOUT_RUNNER), []);
  assert.deepEqual(decodeLiveBatch('not json', SESSION_ON_A), []);
});

test('the gateway\'s answer to a turn prefix request reads back, and only for the request it answers', () => {
  const [, , prefix, empty] = gatewayFixture();
  assert.deepEqual(decodeTurnPrefixResponse(prefix.message, '0190a0b0-0000-4000-8000-0000000000c1'), {
    turnId: '0190a0b0-0000-7000-8000-0000000000b1', text: 'Hello wor', thinking: 'weighing <b> & ü', throughLiveSeq: 42,
  });
  assert.deepEqual(decodeTurnPrefixResponse(empty.message, '0190a0b0-0000-4000-8000-0000000000c2'), {
    turnId: '', text: '', thinking: '', throughLiveSeq: 0,
  });
  assert.equal(decodeTurnPrefixResponse(prefix.message, 'another-request'), null);
});

test('a session\'s streams share one subscription to its live subject, let go with the last of them', () => {
  const nats = fakeBus();
  const hints = hintsOver(nats.bus);
  const seen: string[][] = [[], []];
  const stopFirst = hints.liveEvents(SESSION_ON_A, (e) => seen[0].push(`${e.liveSeq}`));
  const stopSecond = hints.liveEvents(SESSION_ON_A, (e) => seen[1].push(`${e.liveSeq}`));
  assert.equal(nats.subscriptions.get(liveSubject(SESSION_ON_A))?.size, 1);
  nats.deliver(liveSubject(SESSION_ON_A), gatewayFixture()[0].message);
  assert.deepEqual(seen, [['41', '42', '9007199254740990'], ['41', '42', '9007199254740990']]);
  stopFirst();
  assert.equal(nats.subscriptions.has(liveSubject(SESSION_ON_A)), true);
  stopSecond();
  assert.equal(nats.subscriptions.has(liveSubject(SESSION_ON_A)), false);
});

test('a turn prefix is asked of the session\'s runner, on its subject, and its answer read', async () => {
  const nats = fakeBus();
  const hints = hintsOver(nats.bus);
  let asked: { requestId: string; sessionId: string } | undefined;
  nats.answerWith((subject, message) => {
    asked = JSON.parse(message).turnPrefixRequest;
    return JSON.stringify({ turnPrefixResponse: { ...asked, turnId: 't-1', text: 'Hel', throughLiveSeq: '7' } });
  });
  assert.deepEqual(await hints.turnPrefix(SESSION_ON_A), { turnId: 't-1', text: 'Hel', thinking: '', throughLiveSeq: 7 });
  assert.equal(nats.requests[0].subject, runnerHintSubject(RUNNER_A));
  assert.equal(nats.requests[0].message, turnPrefixRequestMessage(asked!.requestId, SESSION_ON_A));
  assert.ok(nats.requests[0].timeoutMs <= 2_000, 'a stream does not wait long for it');

  // No answer, or nobody to ask: the stream goes on without one.
  nats.answerWith(() => null);
  assert.equal(await hints.turnPrefix(SESSION_ON_A), null);
  assert.equal(await hints.turnPrefix(SESSION_WITHOUT_RUNNER), null);
  assert.equal(nats.requests.length, 2, 'a session with no runner is asked nothing');
});
