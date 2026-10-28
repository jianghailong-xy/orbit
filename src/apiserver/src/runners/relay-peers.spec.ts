import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { CursorKeyCheckRelay } from '../providers/cursor-key-check-relay';
import { MemoryNats, type MemoryNatsConnection } from '../test-support/memory-nats';
import { LoginCodeRelay } from './login-code-relay';
import { HELD_SUBJECT, RelayPeers, peerSubject } from './relay-peers';

/**
 * Several apiserver processes behind the runner link (relay-peers.ts): what a person's request left in one process's
 * memory — Antigravity's pasted code, a Cursor key to check — reaches the runner whichever process its heartbeat is
 * forwarded to, over NATS, once, for the sign-in attempt or the check it was meant for; a heartbeat never waits on
 * NATS for more than a second, and what a slow holder hands over after that is not lost; a process that starts later
 * still hears of it; and nothing crosses NATS while nothing is held. Each process here is a relay of each kind on its
 * own peers, over its own connection to one in-memory NATS (test-support/memory-nats.ts).
 */

const RUNNER = '0190a0b0-0000-7000-8000-00000000000a';
const ATTEMPT = '2026-10-28T04:00:00.000Z';
/** Shaped like a Google authorization code so a leak would be recognisable; not a real one. */
const CODE = '4/0-relay-peers-placeholder-code';
const KEY = 'key_relay-peers-unit-7d1e0c2b9a4f';
const fingerprint = (key: string) => createHash('sha256').update(key.trim()).digest('hex').slice(0, 16);

interface Process {
  name: string;
  conn: MemoryNatsConnection;
  peers: RelayPeers;
  login: LoginCodeRelay;
  cursor: CursorKeyCheckRelay;
  /** The runners this process was asked to have beat now. */
  nudged: string[];
}

/** One apiserver process on `nats`, with the specs' short waits. */
function processOn(nats: MemoryNats, name: string, connect = true): Process {
  const conn = nats.connect(name);
  const peers = new RelayPeers();
  peers.askTimeoutMs = 60;
  peers.replyTimeoutMs = 2_000;
  peers.reannounceMs = 40;
  const p: Process = { name, conn, peers, login: new LoginCodeRelay(peers), cursor: new CursorKeyCheckRelay(peers), nudged: [] };
  if (connect) join(p);
  return p;
}

function join(p: Process): void {
  p.peers.connect(p.conn, `instance-${p.name}`, (runnerId) => void p.nudged.push(runnerId));
}

async function until(what: string, holds: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!holds()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${ms} ms`);
    await sleep(5);
  }
}

/** Until each of `processes` has heard that `holder` holds something of `kind` for RUNNER. */
async function heard(holder: Process, kind: 'login-code' | 'cursor-key-check', ...processes: Process[]): Promise<void> {
  await until(`hearing ${holder.name}'s ${kind}`, () =>
    processes.every((p) => p.peers.holders(kind, RUNNER).some((h) => h.instance === `instance-${holder.name}`)),
  );
}

function stop(...processes: Process[]): void {
  for (const p of processes) p.peers.disconnect();
}

test('a code pasted on one process is handed to a link heartbeat on another, once, for its attempt alone', async () => {
  const nats = new MemoryNats();
  const [a, b, c] = ['a', 'b', 'c'].map((name) => processOn(nats, name));
  try {
    a.login.hold(RUNNER, ATTEMPT, CODE, Date.now() + 60_000);
    await heard(a, 'login-code', b, c);
    // A heartbeat that read another attempt asks nobody, and a request naming one hands nothing over, leaving the code.
    assert.equal(await b.login.takeAnywhere(RUNNER, '2026-10-28T03:00:00.000Z'), undefined);
    assert.deepEqual(await b.peers.ask('instance-a', { type: 'take-login-code', runnerId: RUNNER, attempt: 'another' }), {});
    assert.equal(a.login.holds(RUNNER), true);

    assert.equal(await b.login.takeAnywhere(RUNNER, ATTEMPT), CODE);
    assert.equal(a.login.holds(RUNNER), false, 'gone from the holder once handed over');
    assert.equal(b.login.holds(RUNNER), false, 'and never kept by the process that handed it to the runner');
    assert.equal(await c.login.takeAnywhere(RUNNER, ATTEMPT), undefined, 'never handed over twice');
    assert.equal(await b.login.takeAnywhere(RUNNER, ATTEMPT), undefined);
    // Taken back on api.held: the others stop asking.
    await until('the holder taking it back', () => b.peers.holders('login-code', RUNNER).length === 0);

    // The code crossed NATS once, in the reply to the heartbeat's process: never in what is published or asked.
    for (const { subject, message } of nats.sent) {
      assert.equal(message.includes(CODE), false, `${subject} carried the code`);
    }
  } finally {
    stop(a, b, c);
  }
});

test('a sign-in settled where the runner reported it drops the code wherever it is held', async () => {
  const nats = new MemoryNats();
  const [a, b] = ['a', 'b'].map((name) => processOn(nats, name));
  try {
    a.login.hold(RUNNER, ATTEMPT, CODE, Date.now() + 60_000);
    await heard(a, 'login-code', b);
    b.login.drop(RUNNER);
    await until('the holder dropping it', () => !a.login.holds(RUNNER));
    // A new paste replaces a code held anywhere else, too.
    a.login.hold(RUNNER, ATTEMPT, CODE, Date.now() + 60_000);
    await heard(a, 'login-code', b);
    b.login.hold(RUNNER, ATTEMPT, `${CODE}-replacement`, Date.now() + 60_000);
    await until('the older paste dropped', () => !a.login.holds(RUNNER));
    await heard(b, 'login-code', a);
    assert.equal(await a.login.takeAnywhere(RUNNER, ATTEMPT), `${CODE}-replacement`);
  } finally {
    stop(a, b);
  }
});

test('a heartbeat waits a bounded time for a slow holder, and what it hands over late is held by the asker, not lost', async () => {
  const nats = new MemoryNats();
  const [a, b, c] = ['a', 'b', 'c'].map((name) => processOn(nats, name));
  try {
    a.login.hold(RUNNER, ATTEMPT, CODE, Date.now() + 60_000);
    await heard(a, 'login-code', b, c);
    // The holder answers 200 ms after it is asked: past the heartbeat's wait.
    a.conn.delayMs = 200;
    const started = Date.now();
    assert.equal(await b.login.takeAnywhere(RUNNER, ATTEMPT), undefined, 'the heartbeat goes on without it');
    assert.ok(Date.now() - started < 200, `the heartbeat waited ${Date.now() - started} ms`);

    await until('the late answer held by the process that asked', () => b.login.holds(RUNNER));
    assert.equal(a.login.holds(RUNNER), false);
    assert.deepEqual(b.nudged, [RUNNER], 'and the runner has its next heartbeat now');
    // Said to be: the next heartbeat, wherever it lands, takes it from there.
    await heard(b, 'login-code', c);
    assert.equal(await c.login.takeAnywhere(RUNNER, ATTEMPT), CODE);
    assert.equal(b.login.holds(RUNNER), false);
  } finally {
    stop(a, b, c);
  }
});

test('a process that starts after the code was pasted hears of it, and nothing is said while nothing is held', async () => {
  const nats = new MemoryNats();
  const a = processOn(nats, 'a');
  const late = processOn(nats, 'late', false);
  try {
    await sleep(100);
    assert.equal(nats.sent.length, 0, 'an idle process says nothing');

    a.login.hold(RUNNER, ATTEMPT, CODE, Date.now() + 60_000);
    await sleep(10);
    join(late);
    assert.deepEqual(late.peers.holders('login-code', RUNNER), [], 'it started after the code was said to be held');
    await heard(a, 'login-code', late);
    assert.equal(await late.login.takeAnywhere(RUNNER, ATTEMPT), CODE);

    // Taken: said once more, as taken back, and then nothing again.
    await sleep(20);
    const said = nats.sent.filter((m) => m.subject === HELD_SUBJECT).length;
    await sleep(150);
    assert.equal(nats.sent.filter((m) => m.subject === HELD_SUBJECT).length, said, 'quiet once nothing is held');
    const last = JSON.parse(nats.sent.filter((m) => m.subject === HELD_SUBJECT).at(-1)!.message);
    assert.deepEqual(last, { instance: 'instance-a', kind: 'login-code', runnerId: RUNNER, item: ATTEMPT, ttlMs: 0 });
  } finally {
    stop(a, late);
  }
});

test('a heartbeat never fails for NATS: down, a holder gone, a request that throws', async () => {
  const nats = new MemoryNats();
  const [a, b] = ['a', 'b'].map((name) => processOn(nats, name));
  try {
    a.login.hold(RUNNER, ATTEMPT, CODE, Date.now() + 60_000);
    await heard(a, 'login-code', b);

    b.conn.up = false;
    assert.equal(await b.login.takeAnywhere(RUNNER, ATTEMPT), undefined);
    b.conn.up = true;

    const request = b.conn.request.bind(b.conn);
    b.conn.request = () => {
      throw new Error('the connection broke');
    };
    assert.equal(await b.login.takeAnywhere(RUNNER, ATTEMPT), undefined);
    b.conn.request = request;

    // The holder went away: nobody answers its subject, which NATS says at once.
    a.peers.disconnect();
    assert.equal(nats.listeners(peerSubject('instance-a')), 0);
    const started = Date.now();
    assert.equal(await b.login.takeAnywhere(RUNNER, ATTEMPT), undefined);
    assert.ok(Date.now() - started < 60, 'no responders is answered at once');
  } finally {
    stop(a, b);
  }
});

test('a Cursor key asked on one process is handed to another\'s heartbeat for its check id, and an answer on a third settles the wait', async () => {
  const nats = new MemoryNats();
  const [a, b, c] = ['a', 'b', 'c'].map((name) => processOn(nats, name));
  try {
    const answer = a.cursor.ask(RUNNER, KEY);
    await heard(a, 'cursor-key-check', b, c);
    const [{ instance, items }] = b.peers.holders('cursor-key-check', RUNNER);
    assert.equal(instance, 'instance-a');
    // A request naming no check, or another one, is handed nothing.
    assert.deepEqual(await b.peers.ask('instance-a', { type: 'take-cursor-key-checks', runnerId: RUNNER }), { checks: [] });
    assert.deepEqual(await b.peers.ask('instance-a', { type: 'take-cursor-key-checks', runnerId: RUNNER, checkIds: ['0'.repeat(32)] }), { checks: [] });
    assert.deepEqual(
      await b.peers.ask('instance-a', { type: 'take-cursor-key-checks', runnerId: '0190a0b0-0000-7000-8000-00000000000b', checkIds: items }),
      { checks: [] },
      'nor one for another runner',
    );

    const commands = await b.cursor.takeAnywhere(RUNNER);
    assert.deepEqual(commands, [{ checkId: items[0], apiKey: KEY }]);
    assert.deepEqual(await c.cursor.takeAnywhere(RUNNER), [], 'handed over once');

    // The answer reaches a third process: one about another key is refused there, the right one settles the wait.
    const result = { checkId: items[0], state: 'VALID', keyFingerprint: fingerprint(KEY) };
    assert.equal(await c.cursor.answerAnywhere(RUNNER, { ...result, keyFingerprint: fingerprint('key_other') }), false);
    assert.deepEqual(
      await c.peers.ask('instance-a', { type: 'answer-cursor-key-check', runnerId: '0190a0b0-0000-7000-8000-00000000000b', ...result }),
      { accepted: false },
      'or from another runner',
    );
    assert.equal(await c.cursor.answerAnywhere(RUNNER, result), true);
    assert.equal(await answer, 'VALID');
    assert.equal(await b.cursor.answerAnywhere(RUNNER, result), false, 'settled once');
    await until('the check taken back', () => c.peers.holders('cursor-key-check', RUNNER).length === 0);

    for (const { subject, message } of nats.sent) {
      assert.equal(message.includes(KEY), false, `${subject} carried the key`);
    }
  } finally {
    stop(a, b, c);
  }
});

test('a Cursor key handed over after the heartbeat stopped waiting is handed on from the asker, and its answer still settles', async () => {
  const nats = new MemoryNats();
  const [a, b, c] = ['a', 'b', 'c'].map((name) => processOn(nats, name));
  try {
    const answer = a.cursor.ask(RUNNER, KEY);
    await heard(a, 'cursor-key-check', b, c);
    const [checkId] = b.peers.holders('cursor-key-check', RUNNER)[0].items;
    a.conn.delayMs = 200;
    assert.deepEqual(await b.cursor.takeAnywhere(RUNNER), []);
    await until('the late key held by the process that asked', () => b.nudged.length > 0);
    assert.deepEqual(b.nudged, [RUNNER]);
    a.conn.delayMs = 0;

    await until('the asker saying so', () => c.peers.holders('cursor-key-check', RUNNER).some((h) => h.instance === 'instance-b'));
    assert.deepEqual(await c.cursor.takeAnywhere(RUNNER), [{ checkId, apiKey: KEY }]);
    assert.deepEqual(await b.cursor.takeAnywhere(RUNNER), []);
    assert.equal(await b.cursor.answerAnywhere(RUNNER, { checkId, state: 'INVALID', keyFingerprint: fingerprint(KEY) }), true);
    assert.equal(await answer, 'INVALID');
  } finally {
    stop(a, b, c);
  }
});

test('a check nobody answers still settles as no answer when its wait is up, wherever its key went', async () => {
  const nats = new MemoryNats();
  const [a, b] = ['a', 'b'].map((name) => processOn(nats, name));
  try {
    a.cursor.waitMs = 150;
    const answer = a.cursor.ask(RUNNER, KEY);
    await heard(a, 'cursor-key-check', b);
    assert.equal((await b.cursor.takeAnywhere(RUNNER)).length, 1);
    assert.equal(await answer, null);
    await until('the check taken back', () => b.peers.holders('cursor-key-check', RUNNER).length === 0);
  } finally {
    stop(a, b);
  }
});

test('without NATS each relay is its process\'s alone, as before', async () => {
  const lone = new RelayPeers();
  const login = new LoginCodeRelay(lone);
  login.hold(RUNNER, ATTEMPT, CODE, Date.now() + 60_000);
  assert.equal(await login.takeAnywhere(RUNNER, ATTEMPT), CODE);
  const cursor = new CursorKeyCheckRelay(lone);
  void cursor.ask(RUNNER, KEY);
  assert.equal((await cursor.takeAnywhere(RUNNER))[0].apiKey, KEY);
  assert.deepEqual(lone.holders('login-code', RUNNER), []);
});
