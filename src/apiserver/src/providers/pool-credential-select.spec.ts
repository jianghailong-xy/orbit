import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanUsageSnapshot } from '@orbit/shared';
import { choosePoolCredential, type CredentialPool, type SessionCredential } from './pool-credential-select';
import type { PoolKeyCandidate } from './pool-key-select';
import type { LoginAccount } from './pool-login-select';

/**
 * Which credential of a Codex pool a claim puts a session on, now that one pool holds its owner's ChatGPT
 * accounts and API keys side by side (migration 0358):
 *
 *  (1) The owner's session runs on a ChatGPT account that can run, before any key — their own included —
 *      staying on its account while that can run, else taking the one whose quota resets soonest.
 *  (2) Every account used up or signed out: a key, the owner's own first, the move saying why it left the
 *      account.
 *  (3) An account back: the next choosing moves the session off its key onto it, and says so.
 *  (4) Anybody else's session runs on the keys alone — their own first, none the others spent to its share
 *      cap — and never on an account, whatever its row names; on a shared pool its maker's too.
 *  (5) Nothing can run: nothing is chosen, and the session keeps the credential it has.
 */

type Key = PoolKeyCandidate & { label: string };

/** The pool's owner. */
const OLGA = 'olga';
/** Two people she added to it. */
const PIA = 'pia';
const MAX = 'max';
const NOW = new Date('2026-10-02T10:00:00.000Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const DAY = 24 * 60;
const dollars = (n: number) => n * 1_000_000;

const account = (accountId: string, over: Partial<LoginAccount> = {}): LoginAccount => ({
  accountId,
  email: `${accountId}@chatgpt.invalid`,
  state: 'ACTIVE',
  spentUntil: null,
  usage: null,
  ...over,
});
const key = (id: string, contributorId: string, over: Partial<Key> = {}): Key => ({
  id,
  contributorId,
  label: `${id}-key`,
  enabled: true,
  state: 'ACTIVE',
  shareCap: null,
  othersCostMicros: 0,
  spentUntil: null,
  ...over,
});
/** A reading the gateway stores off an answer: the 5-hour window, resetting in two hours, and the week. */
const reading = (fiveHour: number, weekly: number, weekEnds: Date): PlanUsageSnapshot => ({
  primary: { utilization: fiveHour, resetsAt: later(120).toISOString(), windowDurationMins: 300 },
  secondary: { utilization: weekly, resetsAt: weekEnds.toISOString(), windowDurationMins: 7 * DAY },
});
const pool = (over: Partial<CredentialPool<LoginAccount, Key>>): CredentialPool<LoginAccount, Key> => ({
  ownerId: OLGA,
  shared: false,
  accounts: [],
  keys: [],
  ownKeyFirst: true,
  ...over,
});
const on = (accountId: string | null, keyId: string | null): SessionCredential => ({ accountId, keyId });
/** `who`'s session, on `current` — nothing yet, by default — choosing at `now`. */
const choose = (p: CredentialPool<LoginAccount, Key>, who: string, current = on(null, null), now = NOW) =>
  choosePoolCredential(p, { ownerId: who, ...current }, now);

test('(1) the owner runs on a ChatGPT account that can run, before any key — her own included', () => {
  const keys = [key('k1', OLGA), key('k2', MAX)];
  // Where a session starts is no move, and says nothing.
  assert.deepEqual(choose(pool({ accounts: [account('a1')], keys }), OLGA), {
    chosen: on('a1', null),
    next: on('a1', null),
    notice: null,
  });
  // Among her accounts: what is left of a week is lost first on the one whose week resets first.
  const resetsSoon = account('a1', { usage: reading(40, 30, later(DAY)) });
  const resetsLate = account('a2', { usage: reading(5, 10, later(5 * DAY)) });
  const two = pool({ accounts: [resetsLate, resetsSoon], keys });
  assert.deepEqual(choose(two, OLGA).chosen, on('a1', null));
  // A session on an account that can run stays there, though choosing afresh would take the other.
  assert.deepEqual(choose(two, OLGA, on('a2', null)), { chosen: on('a2', null), next: on('a2', null), notice: null });
});

test('(2) every account used up or signed out: a key, her own first, and the move says why it left the account', () => {
  const accounts = [
    // The backend said its usage limit is reached, until an hour and a half from now.
    account('a1', { spentUntil: later(90) }),
    // Its last reading says its 5-hour window is used up.
    account('a2', { usage: reading(100, 40, later(3 * DAY)) }),
    account('a3', { state: 'SIGNED_OUT' }),
  ];
  const keys = [key('k1', MAX), key('k2', OLGA), key('k3', PIA)];
  assert.deepEqual(choose(pool({ accounts, keys }), OLGA, on('a1', null)), {
    chosen: on(null, 'k2'),
    next: on(null, 'k2'),
    notice: 'Switched to k2-key — the usage limit on a1@chatgpt.invalid is reached',
  });
  assert.equal(
    choose(pool({ accounts, keys }), OLGA, on('a2', null)).notice,
    'Switched to k2-key — the 5-hour window on a2@chatgpt.invalid is spent',
  );
  assert.equal(
    choose(pool({ accounts, keys }), OLGA, on('a3', null)).notice,
    'Switched to k2-key — a3@chatgpt.invalid was signed out by OpenAI',
  );
  // A session starting now starts on her key.
  assert.deepEqual(choose(pool({ accounts, keys }), OLGA), { chosen: on(null, 'k2'), next: on(null, 'k2'), notice: null });
  // Her own key out of budget too: somebody else's.
  const ownSpent = [key('k1', MAX), key('k2', OLGA, { spentUntil: later(60) })];
  assert.deepEqual(choose(pool({ accounts, keys: ownSpent }), OLGA, on('a1', null)).chosen, on(null, 'k1'));
});

test('(3) an account back: the next choosing takes the session off its key onto it, and says so', () => {
  const spent = account('a1', { spentUntil: later(90) });
  const keys = [key('k1', OLGA), key('k2', MAX)];
  // While no account can run, the session stays on the key it is on — even one not her own.
  assert.deepEqual(choose(pool({ accounts: [spent], keys }), OLGA, on(null, 'k2')), {
    chosen: on(null, 'k2'),
    next: on(null, 'k2'),
    notice: null,
  });
  // Past the reset the backend named: back on the account — its quota costs nothing more, the key is billed.
  assert.deepEqual(choose(pool({ accounts: [spent], keys }), OLGA, on(null, 'k2'), later(91)), {
    chosen: on('a1', null),
    next: on('a1', null),
    notice: 'Switched to a1@chatgpt.invalid — your ChatGPT accounts come first',
  });
  // So too once a used-up window has turned over.
  const windowSpent = account('a1', { usage: reading(100, 40, later(3 * DAY)) });
  assert.equal(choose(pool({ accounts: [windowSpent], keys }), OLGA, on(null, 'k1')).chosen?.keyId, 'k1');
  assert.deepEqual(choose(pool({ accounts: [windowSpent], keys }), OLGA, on(null, 'k1'), later(121)).chosen, on('a1', null));
});

test("(4) anybody else's session runs on the keys alone: their own first, none the others spent to its share cap", () => {
  // Olga's account can run — and is never Pia's to run on.
  const accounts = [account('a1')];
  // Olga's key, capped at $10 a month for everybody else, who have spent all of it.
  const capped = key('k1', OLGA, { shareCap: 10, othersCostMicros: dollars(10) });
  const keys = [capped, key('k2', PIA), key('k3', MAX, { shareCap: 10, othersCostMicros: dollars(9) })];
  assert.deepEqual(choose(pool({ accounts, keys }), PIA), { chosen: on(null, 'k2'), next: on(null, 'k2'), notice: null });
  // Her own switched off: Max's, with a dollar of its cap left — never Olga's, though its id is lower.
  const ownOff = [capped, key('k2', PIA, { enabled: false }), keys[2]];
  assert.deepEqual(choose(pool({ accounts, keys: ownOff }), PIA).chosen, on(null, 'k3'));
  // The cap is on everybody but its contributor: Olga runs on her own key all the same, once her accounts cannot.
  assert.deepEqual(choose(pool({ accounts: [account('a1', { state: 'SIGNED_OUT' })], keys: [capped] }), OLGA).chosen, on(null, 'k1'));
  // A row that names Olga's account — carried over, or written by hand — is put on a key all the same, and
  // says nothing: the session never ran on the account here.
  assert.deepEqual(choose(pool({ accounts, keys }), PIA, on('a1', null)), {
    chosen: on(null, 'k2'),
    next: on(null, 'k2'),
    notice: null,
  });
  // No key at all: still never the account.
  assert.deepEqual(choose(pool({ accounts, keys: [] }), PIA, on('a1', null)), { chosen: null, next: on(null, null), notice: null });
  // A move between keys says why, as pool-key-select.ts says it.
  const k2Spent = [capped, key('k2', PIA, { spentUntil: later(30) }), keys[2]];
  assert.equal(choose(pool({ accounts, keys: k2Spent }), PIA, on(null, 'k2')).notice, 'Switched to k3-key — k2-key is out of budget');
});

test('(4) on a shared pool everybody runs on its keys, its maker too — and an account carried over from another pool is dropped without a line', () => {
  const shared = pool({ shared: true, keys: [key('k1', MAX), key('k2', OLGA)] });
  assert.deepEqual(choose(shared, OLGA, on('a9', null)), { chosen: on(null, 'k2'), next: on(null, 'k2'), notice: null });
});

test('(5) nothing can run: nothing is chosen, and the session keeps the credential it has', () => {
  const dead = [
    key('k1', OLGA, { state: 'INVALID' }),
    key('k2', MAX, { enabled: false }),
    key('k3', MAX, { shareCap: 5, othersCostMicros: dollars(5) }),
  ];
  // A person's session stays on its key, which the gateway answers with why.
  assert.deepEqual(choose(pool({ keys: dead }), PIA, on(null, 'k3')), { chosen: null, next: on(null, 'k3'), notice: null });
  assert.deepEqual(choose(pool({ keys: dead }), PIA), { chosen: null, next: on(null, null), notice: null });
  // The owner's, every account used up as well: on its key, or on its account.
  const accounts = [account('a1', { spentUntil: later(60) }), account('a2', { state: 'SIGNED_OUT' })];
  assert.deepEqual(choose(pool({ accounts, keys: dead }), OLGA, on(null, 'k1')), { chosen: null, next: on(null, 'k1'), notice: null });
  assert.deepEqual(choose(pool({ accounts, keys: dead }), OLGA, on('a2', null)), { chosen: null, next: on('a2', null), notice: null });
  // One on no account the pool holds goes to the one that comes back first — so the gateway answers it with
  // that account's limit, not as a pool with no account — and a move off one the pool lost says so.
  assert.deepEqual(choose(pool({ accounts, keys: dead }), OLGA), { chosen: null, next: on('a1', null), notice: null });
  assert.deepEqual(choose(pool({ accounts, keys: dead }), OLGA, on('a0', null)), {
    chosen: null,
    next: on('a1', null),
    notice: 'Switched to a1@chatgpt.invalid — the previous account is no longer in this pool',
  });
});
