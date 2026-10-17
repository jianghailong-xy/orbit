import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { RunnerStatus, type CursorKeyCheckAnswer, type RunnerHeartbeatResponse } from '@orbit/shared';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  CURSOR_KEY_CHECK_V1,
  CURSOR_KEY_CHECKS_PER_RUNNER,
  CursorKeyCheckRelay,
  cursorKeyCheckers,
  cursorKeyCheckRelay,
  type CursorKeyCheckerRow,
} from './cursor-key-check-relay';
import { ProvidersService } from './providers.service';

/**
 * A Cursor API key checked on a runner while somebody waits (project P2 follow-up;
 * docs/cursor-runtime-contract.md §9): which runner is asked, how the key reaches it — on its own
 * heartbeat, once, and only a process that declares cursor-key-check/v1 — how its answer settles the
 * check, and what the person is told, in words that never carry the key. Named in
 * scripts/test-cursor-key-check.mjs.
 */

const KEY = 'key_p2f-unit-0f3c9a7e51d24b88a6e0c4d29b17f3aa';
const fingerprint = (key: string) => createHash('sha256').update(key.trim()).digest('hex').slice(0, 16);
const NOW = Date.parse('2026-10-17T00:00:00.000Z');
const PINNED = [{ engine: 'cursor', installed: true, version: '2026.10.14-941492e', auth: 'unknown' }];
/** What a runner with another Cursor CLI build reports of it (cursor_install.go cursorVersionMismatch). */
const ANOTHER_BUILD = 'CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e';

/** A runner as cursorKeyCheckers reads it: online, declaring the check, the pinned Cursor CLI installed. */
function runner(id: string, overrides: Partial<CursorKeyCheckerRow> = {}): CursorKeyCheckerRow {
  return {
    id,
    status: RunnerStatus.ONLINE,
    lastHeartbeatAt: new Date(NOW - 10_000),
    capabilities: ['provider:cursor', CURSOR_KEY_CHECK_V1],
    capabilitiesReportedAt: new Date(NOW - 10_000),
    engines: PINNED,
    ...overrides,
  };
}

/** Waits until the relay holds a key for `runnerId` that a heartbeat could take — without taking it. */
async function heldFor(relay: CursorKeyCheckRelay, runnerId: string): Promise<void> {
  const held = (relay as unknown as { held: Map<string, { runnerId: string; apiKey: string | null }> }).held;
  for (let i = 0; i < 400; i++) {
    if ([...held.values()].some((check) => check.runnerId === runnerId && check.apiKey !== null)) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`nothing was held for ${runnerId}`);
}

test('P2 follow-up a key check goes to an online runner that declares cursor-key-check/v1 and has the pinned Cursor CLI, the freshest first', () => {
  const fresh = runner('fresh', { lastHeartbeatAt: new Date(NOW - 1_000) });
  const older = runner('older', { lastHeartbeatAt: new Date(NOW - 50_000) });
  const refused = [
    runner('offline', { status: RunnerStatus.OFFLINE }),
    runner('silent', { lastHeartbeatAt: new Date(NOW - 120_000) }),
    runner('never-reported', { capabilitiesReportedAt: null }),
    runner('older-release', { capabilities: ['provider:cursor', 'cursor-account-login/v1'] }),
    runner('not-installed', {
      engines: [{ engine: 'cursor', installed: false, auth: 'unknown', installationError: 'CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed in Orbit\'s version directory' }],
    }),
    runner('another-build', { engines: [{ ...PINNED[0], version: '2026.10.16-e3cb207', installationError: ANOTHER_BUILD }] }),
    runner('unheard-of', { engines: [{ ...PINNED[0], installationError: 'CURSOR_SOMETHING_NEW: whatever it is' }] }),
    runner('no-report', { engines: [{ engine: 'claude', installed: true, auth: 'yes' }] }),
    runner('no-engines', { engines: null }),
  ];
  assert.deepEqual(cursorKeyCheckers([...refused, older, fresh], NOW).map((r) => r.id), ['fresh', 'older']);
  assert.deepEqual(cursorKeyCheckers(refused, NOW), []);
  // The heartbeat keeps the code a runner leads its Cursor CLI report with, and none of the words after it.
  const [stored] = sanitizeRunnerEngines([{ ...PINNED[0], version: '2026.10.16-e3cb207', installationError: ANOTHER_BUILD }])!;
  assert.equal(stored.installationError, 'CURSOR_VERSION_INCOMPATIBLE');
  assert.equal(sanitizeRunnerEngines(PINNED)![0].installationError, undefined);
});

test('P2 follow-up the relay hands a key once, to the heartbeat of the runner it was asked of, and then forgets it', async () => {
  const relay = new CursorKeyCheckRelay();
  const answer = relay.ask('runner-a', KEY);
  assert.deepEqual(relay.take('runner-b'), [], 'another runner was handed the key');
  const [command, ...more] = relay.take('runner-a');
  assert.deepEqual(more, []);
  assert.match(command.checkId, /^[0-9a-f]{32}$/);
  assert.equal(command.apiKey, KEY);
  assert.deepEqual(relay.take('runner-a'), [], 'the key was handed over twice');
  // What is kept until the answer is the key's fingerprint, and nothing that holds the key.
  const kept = JSON.stringify([...(relay as unknown as { held: Map<string, object> }).held.values()]);
  assert.ok(kept.includes(fingerprint(KEY)) && !kept.includes(KEY), `the relay still holds the key: ${kept}`);
  assert.equal(relay.answer('runner-a', { checkId: command.checkId, state: 'VALID', keyFingerprint: fingerprint(KEY) }), true);
  assert.equal(await answer, 'VALID');
});

test('P2 follow-up an answer settles its check once, only from that runner and only about that key', async () => {
  const relay = new CursorKeyCheckRelay();
  const answer = relay.ask('runner-a', KEY);
  const early = { checkId: '', state: 'VALID', keyFingerprint: fingerprint(KEY) };
  // Nothing settles a check no heartbeat has taken yet.
  const checkId = [...(relay as unknown as { held: Map<string, object> }).held.keys()][0];
  assert.equal(relay.answer('runner-a', { ...early, checkId }), false, 'a check was settled before it was handed over');
  relay.take('runner-a');
  for (const [label, from, result] of [
    ['another runner', 'runner-b', { checkId, state: 'VALID', keyFingerprint: fingerprint(KEY) }],
    ['another key', 'runner-a', { checkId, state: 'VALID', keyFingerprint: fingerprint(`${KEY}-replaced`) }],
    ['another check', 'runner-a', { checkId: '0'.repeat(32), state: 'VALID', keyFingerprint: fingerprint(KEY) }],
    ['no answer Cursor gives', 'runner-a', { checkId, state: 'MAYBE', keyFingerprint: fingerprint(KEY) }],
  ] as const) {
    assert.equal(relay.answer(from, result), false, `${label} settled the check`);
  }
  assert.equal(relay.answer('runner-a', { checkId, state: 'INVALID', keyFingerprint: fingerprint(KEY) }), true);
  assert.equal(await answer, 'INVALID');
  assert.equal(relay.answer('runner-a', { checkId, state: 'VALID', keyFingerprint: fingerprint(KEY) }), false, 'a check was settled twice');
});

test('P2 follow-up a check nobody answers in time settles as no answer, and its key is gone', async (t) => {
  // The relay's timer is unref'd, so nothing keeps this process alive while a real one runs out: the
  // test runs it out itself.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const relay = new CursorKeyCheckRelay();
  const answer = relay.ask('runner-a', KEY);
  const checkId = [...(relay as unknown as { held: Map<string, object> }).held.keys()][0];
  t.mock.timers.tick(relay.waitMs);
  assert.equal(await answer, null);
  assert.deepEqual(relay.take('runner-a'), [], 'a heartbeat after the wait was handed the key');
  assert.equal(relay.answer('runner-a', { checkId, state: 'VALID', keyFingerprint: fingerprint(KEY) }), false);
  assert.equal((relay as unknown as { held: Map<string, object> }).held.size, 0);
});

test(`P2 follow-up a runner is asked at most ${CURSOR_KEY_CHECKS_PER_RUNNER} checks at once`, async () => {
  const relay = new CursorKeyCheckRelay();
  const answers = Array.from({ length: CURSOR_KEY_CHECKS_PER_RUNNER }, (_, i) => relay.ask('runner-a', `${KEY}-${i}`));
  assert.equal(relay.hasRoom('runner-a'), false);
  assert.equal(relay.hasRoom('runner-b'), true, 'a runner is full of another runner\'s checks');
  const [first] = relay.take('runner-a');
  relay.answer('runner-a', { checkId: first.checkId, state: 'VALID', keyFingerprint: fingerprint(first.apiKey) });
  assert.equal(relay.hasRoom('runner-a'), true, 'a settled check still takes room');
  assert.equal(await answers[0], 'VALID');
});

test('P2 follow-up the heartbeat hands a key only to a process that declares cursor-key-check/v1, and only when one is waiting', async () => {
  const RUNNER = '33333333-3333-4333-8333-333333333333';
  const prisma = {
    runner: { update: async () => ({ maxConcurrent: 2 }), findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
    workspace: { findMany: async () => [] },
  } as never;
  const realtime = {
    drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  } as never;
  const api = new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never);
  const beat = (capabilities?: string) => api.heartbeat(
    { id: RUNNER, version: null }, { status: RunnerStatus.ONLINE, idleCapacity: 1 }, capabilities,
  ) as Promise<RunnerHeartbeatResponse>;

  assert.equal('cursorKeyChecks' in await beat(`provider:cursor,${CURSOR_KEY_CHECK_V1}`), false, 'a beat with nothing to hand over has a new key');
  const answer = cursorKeyCheckRelay.ask(RUNNER, KEY);
  try {
    // An older process of the same machine, or one that never declared it, is handed nothing.
    for (const older of [undefined, 'provider:cursor', 'provider:cursor,cursor-account-login/v1']) {
      assert.equal('cursorKeyChecks' in await beat(older), false, `a process declaring ${older} was handed a key`);
    }
    const handed = await beat(`session-worktree-ops-v1,${CURSOR_KEY_CHECK_V1}`);
    assert.equal(handed.cursorKeyChecks?.length, 1);
    assert.equal(handed.cursorKeyChecks?.[0].apiKey, KEY);
    assert.equal('cursorKeyChecks' in await beat(CURSOR_KEY_CHECK_V1), false, 'the key was handed over twice');
    const { checkId } = handed.cursorKeyChecks![0];
    assert.equal(cursorKeyCheckRelay.answer(RUNNER, { checkId, state: 'UNREACHABLE', keyFingerprint: fingerprint(KEY) }), true);
    assert.equal(await answer, 'UNREACHABLE');
  } finally {
    // Whatever a failed assertion left held is not left for the next case.
    for (const { checkId } of cursorKeyCheckRelay.take(RUNNER)) {
      cursorKeyCheckRelay.answer(RUNNER, { checkId, state: 'VALID', keyFingerprint: fingerprint(KEY) });
    }
  }
});

test('P2 follow-up connecting a Cursor key answers VALID, INVALID, UNREACHABLE or NO_RUNNER, in words that never carry the key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const OWNER = '44444444-4444-4444-8444-444444444444';
  const RUNNER = '55555555-5555-4555-8555-555555555555';
  let runners: CursorKeyCheckerRow[] = [];
  const woken: string[] = [];
  const providers = new ProvidersService(
    { runner: { findMany: async ({ where }: { where: { ownerId: string } }) => (where.ownerId === OWNER ? runners : []) } } as never,
    { notifyRunnerWake: (id: string) => woken.push(id) } as never,
    {} as never,
  );
  const connect = (apiKey = KEY) => providers.testConnection(
    { baseUrl: 'https://api2.cursor.sh', apiKey, runtime: 'cursor' }, OWNER,
  ) as Promise<CursorKeyCheckAnswer>;
  /** Connects while the runner answers `state` for the key it is handed. */
  async function answered(state: string): Promise<CursorKeyCheckAnswer> {
    const pending = connect(`  ${KEY}  `);
    await heldFor(cursorKeyCheckRelay, RUNNER);
    const [command] = cursorKeyCheckRelay.take(RUNNER);
    assert.equal(command?.apiKey, KEY, 'the runner was not handed the key, trimmed');
    assert.equal(cursorKeyCheckRelay.answer(RUNNER, { checkId: command.checkId, state, keyFingerprint: fingerprint(KEY) }), true);
    return pending;
  }

  const answers: CursorKeyCheckAnswer[] = [];
  // No runner of the owner's can check one.
  answers.push(await connect());
  assert.deepEqual({ ok: answers[0].ok, keyCheck: answers[0].keyCheck }, { ok: false, keyCheck: 'NO_RUNNER' });
  assert.match(answers[0].message, /^No runner of yours can check Cursor keys right now/);
  assert.match(answers[0].message, /Save the key anyway/);
  assert.deepEqual(woken, [], 'a runner was woken with none able to check');

  runners = [runner(RUNNER, { lastHeartbeatAt: new Date(), capabilitiesReportedAt: new Date() })];
  const valid = await answered('VALID');
  assert.deepEqual(valid, { ok: true, keyCheck: 'VALID', message: 'Cursor accepted this key.' });
  const invalid = await answered('INVALID');
  assert.deepEqual(invalid, {
    ok: false,
    keyCheck: 'INVALID',
    message: 'Cursor rejected this key: “The provided API key is invalid.” Check it on cursor.com and paste it again.',
  });
  const unreachable = await answered('UNREACHABLE');
  assert.deepEqual(unreachable, {
    ok: false,
    keyCheck: 'UNREACHABLE',
    message: 'Couldn’t reach Cursor from the runner that checks keys. The key itself may be fine.',
  });
  assert.deepEqual(woken, [RUNNER, RUNNER, RUNNER], 'the runner was not woken for each check');
  answers.push(valid, invalid, unreachable);

  // The one asked does not answer in time.
  const pending = connect();
  await heldFor(cursorKeyCheckRelay, RUNNER);
  t.mock.timers.tick(cursorKeyCheckRelay.waitMs);
  const silent = await pending;
  assert.deepEqual({ ok: silent.ok, keyCheck: silent.keyCheck }, { ok: false, keyCheck: 'NO_RUNNER' });
  assert.equal(silent.message, 'The runner asked to check this key didn’t answer in time. Save the key anyway, or try again.');
  answers.push(silent);
  // Every runner able to check is checking other keys already.
  const busy = Array.from({ length: CURSOR_KEY_CHECKS_PER_RUNNER }, () => cursorKeyCheckRelay.ask(RUNNER, `${KEY}-other`));
  const full = await connect();
  assert.deepEqual({ keyCheck: full.keyCheck, message: full.message },
    { keyCheck: 'NO_RUNNER', message: 'Your runners are already checking other Cursor keys. Try again in a moment.' });
  answers.push(full);
  t.mock.timers.tick(cursorKeyCheckRelay.waitMs);
  await Promise.all(busy);
  // A blank key is refused before any runner is asked, and the refusal names no key.
  await assert.rejects(connect('   '), (error: { getStatus(): number; message: string }) => error.getStatus() === 400);
  for (const answer of answers) assert.ok(!JSON.stringify(answer).includes(KEY), `an answer carries the key: ${answer.message}`);
});
