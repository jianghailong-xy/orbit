import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  choosePoolKey,
  keyCanRun,
  keyRunsAgainAt,
  poolKeySwitchNotice,
  poolKeysResumeAt,
  type PoolKeyCandidate,
} from './pool-key-select';

/**
 * Which key of a shared pool a claim puts a session on (migrations 0321, 0322): the rules pool-select.ts
 * chooses an account pool's member by, for keys — stay on the key the session has while it can run, the
 * requester's own first when the pool says so, then the most room left under the share caps, and none
 * OpenAI said is out of budget until its reset. Also when a pool whose keys cannot run comes back, and the
 * line a move off a key leaves in the transcript.
 */

const MIA = 'mia';
const ANN = 'ann';
const MAX = 'max';
const NOW = new Date('2026-09-28T10:00:00.000Z');
const NEXT_MONTH = new Date('2026-10-01T00:00:00.000Z');

const key = (id: string, contributorId: string, over: Partial<PoolKeyCandidate> = {}): PoolKeyCandidate => ({
  id,
  contributorId,
  enabled: true,
  state: 'ACTIVE',
  shareCap: null,
  othersCostMicros: 0,
  spentUntil: null,
  throttledUntil: null,
  ...over,
});
const dollars = (n: number) => n * 1_000_000;
const pick = (keys: PoolKeyCandidate[], requester: string, ownFirst = true, sticky: string | null = null) =>
  choosePoolKey(keys, requester, ownFirst, sticky, NOW)?.id ?? null;
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

test('a key switched off, or refused by OpenAI, is never chosen', () => {
  const keys = [
    key('k1', ANN, { enabled: false }),
    key('k2', ANN, { state: 'INVALID' }),
    key('k3', ANN, { state: 'DISABLED' }),
  ];
  assert.equal(pick(keys, MAX), null);
  assert.equal(pick([...keys, key('k4', ANN)], MAX), 'k4');
  // …even when a session was on it: staying is only for a key that can run.
  assert.equal(pick([...keys, key('k4', ANN)], MAX, true, 'k2'), 'k4');
});

test('the key a session runs on is kept while it can run, even when another has more room', () => {
  const keys = [key('k1', ANN), key('k2', MIA, { shareCap: 10, othersCostMicros: dollars(9) })];
  assert.equal(pick(keys, MAX, true, 'k2'), 'k2');
  assert.equal(pick(keys, MAX, true, null), 'k1');
});

test("own key first: a requester's own key that can run comes before everybody else's, when the pool says so", () => {
  const keys = [key('k1', ANN), key('k2', MIA)];
  assert.equal(pick(keys, MIA, true), 'k2');
  // Off, the most room wins, and two uncapped keys tie on it — so the lower id.
  assert.equal(pick(keys, MIA, false), 'k1');
  // Own first does not override staying.
  assert.equal(pick(keys, MIA, true, 'k1'), 'k1');
  // …and gives way when her own is out of budget: the next claim moves her to somebody else's.
  assert.equal(pick([key('k1', ANN), key('k2', MIA, { spentUntil: NEXT_MONTH })], MIA, true, 'k2'), 'k1');
});

// A rate limit the gateway could not wait out (migration 0382) is a short mark rather than a budget, and
// it is the credential that cannot run — so it gives way exactly as a spent one does, for its contributor
// too, and comes back at its own moment rather than at a ladder step.
test("a key rate-limited past the gateway's own wait is passed over until it can run again", () => {
  const throttled = key('k1', ANN, { throttledUntil: later(2) });
  assert.equal(keyCanRun(throttled, ANN, NOW), false);
  assert.deepEqual(keyRunsAgainAt(throttled, ANN, NOW), later(2));
  assert.equal(pick([throttled, key('k2', MIA)], MAX), 'k2');
  // A session on it moves too: staying is only for a key that can run.
  assert.equal(pick([throttled, key('k2', MIA)], MAX, true, 'k1'), 'k2');
  // With nothing else to take, nothing is chosen — the session keeps the key it has, which is where the
  // retry waits for the mark rather than at a fixed step.
  assert.equal(pick([throttled], MAX, true, 'k1'), null);
  // The mark has passed: it runs again.
  assert.equal(keyCanRun(key('k1', ANN, { throttledUntil: new Date(NOW.getTime() - 1) }), MAX, NOW), true);
});

test("a key the others spent to its share cap is passed over — for everyone but its contributor", () => {
  const capped = key('k2', MIA, { shareCap: 10, othersCostMicros: dollars(10) });
  assert.equal(keyCanRun(capped, MAX, NOW), false);
  assert.equal(keyCanRun(capped, MIA, NOW), true, "the contributor's own use is never capped");
  assert.equal(pick([capped], MAX), null);
  assert.equal(pick([capped], MIA), 'k2');
  // A cap of 0: nobody else runs on it at all.
  assert.equal(pick([key('k3', MIA, { shareCap: 0 })], MAX), null);
});

test('then the most room left: no cap before a cap, and more left before less; equal room goes to the lower id', () => {
  const keys = [
    key('k1', MIA, { shareCap: 10, othersCostMicros: dollars(2) }),
    key('k2', ANN, { shareCap: 10, othersCostMicros: dollars(7) }),
    key('k3', ANN),
  ];
  assert.equal(pick(keys, MAX), 'k3');
  assert.equal(pick(keys.slice(0, 2), MAX), 'k1');
  assert.equal(pick([key('k9', ANN), key('k5', MIA)], MAX), 'k5');
  // Row order is not an input.
  assert.equal(pick([...keys].reverse(), MAX), 'k3');
});

test('a key OpenAI said is out of budget runs for nobody until its reset — its contributor included — and then again', () => {
  const spent = key('k1', MIA, { spentUntil: later(30) });
  assert.equal(keyCanRun(spent, MAX, NOW), false);
  assert.equal(keyCanRun(spent, MIA, NOW), false, "OpenAI's budget binds its contributor too");
  assert.equal(pick([spent, key('k2', ANN)], MAX, true, 'k1'), 'k2', 'the session moves off it at its next claim');
  // Past the reset it is a key like any other, and the mark itself needs no clearing to stop counting.
  assert.equal(keyCanRun(spent, MAX, later(31)), true);
  assert.equal(choosePoolKey([spent], MAX, true, null, later(31))?.id, 'k1');
});

test('when a key comes back: now if it can run, its reset or the first of next month when it is spent, never when a person has to act', () => {
  assert.deepEqual(keyRunsAgainAt(key('k1', ANN), MAX, NOW), NOW);
  assert.deepEqual(keyRunsAgainAt(key('k1', ANN, { spentUntil: later(30) }), MAX, NOW), later(30));
  const capped = key('k1', ANN, { shareCap: 5, othersCostMicros: dollars(5) });
  assert.deepEqual(keyRunsAgainAt(capped, MAX, NOW), NEXT_MONTH, 'a spent cap counts from zero on the first');
  assert.deepEqual(keyRunsAgainAt(capped, ANN, NOW), NOW, "and never holds its contributor");
  // Both at once: the later of the two.
  assert.deepEqual(
    keyRunsAgainAt({ ...capped, spentUntil: new Date('2026-10-02T00:00:00.000Z') }, MAX, NOW),
    new Date('2026-10-02T00:00:00.000Z'),
  );
  assert.equal(keyRunsAgainAt(key('k1', ANN, { enabled: false }), MAX, NOW), null);
  assert.equal(keyRunsAgainAt(key('k1', ANN, { state: 'INVALID' }), MAX, NOW), null);
  assert.equal(keyRunsAgainAt(key('k1', ANN, { state: 'DISABLED' }), MAX, NOW), null);
});

test("a pool resumes when its first key does: now while one runs, the earliest reset while all are spent, null when none will", () => {
  const spentSoon = key('k1', ANN, { spentUntil: later(10) });
  const spentLater = key('k2', MIA, { spentUntil: later(90) });
  assert.deepEqual(poolKeysResumeAt([spentSoon, spentLater, key('k3', ANN)], MAX, NOW), NOW);
  assert.deepEqual(poolKeysResumeAt([spentLater, spentSoon], MAX, NOW), later(10));
  assert.equal(poolKeysResumeAt([key('k1', ANN, { state: 'INVALID' }), key('k2', MIA, { enabled: false })], MAX, NOW), null);
  assert.equal(poolKeysResumeAt([], MAX, NOW), null);
});

test('the line a move leaves in the transcript names the key it left and why, in the account pool\'s words', () => {
  const to = { label: 'orbit-org-2' };
  const from = (over: Partial<PoolKeyCandidate>) => ({ ...key('k1', ANN, over), label: 'orbit-org-1' });
  assert.equal(
    poolKeySwitchNotice(to, from({ spentUntil: NEXT_MONTH }), MAX, NOW),
    'Switched to orbit-org-2 — orbit-org-1 is out of budget',
  );
  assert.equal(
    poolKeySwitchNotice(to, from({ shareCap: 1, othersCostMicros: dollars(1) }), MAX, NOW),
    'Switched to orbit-org-2 — orbit-org-1 is out of budget',
    'a cap the others spent reads the same as OpenAI saying so',
  );
  assert.equal(
    poolKeySwitchNotice(to, from({ state: 'INVALID' }), MAX, NOW),
    'Switched to orbit-org-2 — orbit-org-1 was rejected by OpenAI',
  );
  assert.equal(poolKeySwitchNotice(to, from({ enabled: false }), MAX, NOW), 'Switched to orbit-org-2 — orbit-org-1 is disabled');
  assert.equal(poolKeySwitchNotice(to, from({ state: 'DISABLED' }), MAX, NOW), 'Switched to orbit-org-2 — orbit-org-1 is disabled');
  assert.equal(
    poolKeySwitchNotice(to, null, MAX, NOW),
    'Switched to orbit-org-2 — the previous key is no longer in this pool',
  );
});
