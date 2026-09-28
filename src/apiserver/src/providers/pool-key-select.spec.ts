import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePoolKey, keyCanRun, type PoolKeyCandidate } from './pool-key-select';

/**
 * Which key of a shared pool a claim puts a session on (migration 0320): the rules pool-select.ts chooses
 * an account pool's member by, for keys — stay on the key the session has while it can run, the
 * requester's own first when the pool says so, then the most room left under the share caps.
 */

const MIA = 'mia';
const ANN = 'ann';
const MAX = 'max';

const key = (id: string, contributorId: string, over: Partial<PoolKeyCandidate> = {}): PoolKeyCandidate => ({
  id,
  contributorId,
  enabled: true,
  state: 'ACTIVE',
  shareCap: null,
  othersCostMicros: 0,
  ...over,
});
const dollars = (n: number) => n * 1_000_000;
const pick = (keys: PoolKeyCandidate[], requester: string, ownFirst = true, sticky: string | null = null) =>
  choosePoolKey(keys, requester, ownFirst, sticky)?.id ?? null;

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
});

test("a key the others spent to its share cap is passed over — for everyone but its contributor", () => {
  const capped = key('k2', MIA, { shareCap: 10, othersCostMicros: dollars(10) });
  assert.equal(keyCanRun(capped, MAX), false);
  assert.equal(keyCanRun(capped, MIA), true, "the contributor's own use is never capped");
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
