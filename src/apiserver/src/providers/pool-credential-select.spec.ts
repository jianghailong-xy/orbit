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
 *  (4) Any session runs on the pool's ChatGPT accounts first — whoever in the pool signed each one in
 *      (2026-10-03, and migration 0371 for accounts a member contributed) — and on its keys while none can
 *      run: the requester's own first, none the others spent to its share cap. A pool holding no account —
 *      what a shared pool (0321) is until somebody in it signs one in — is the same rule with nothing to
 *      choose on the account side.
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
  throttledUntil: null,
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
  throttledUntil: null,
  ...over,
});
/** A reading the gateway stores off an answer: the 5-hour window, resetting in two hours, and the week. */
const reading = (fiveHour: number, weekly: number, weekEnds: Date): PlanUsageSnapshot => ({
  primary: { utilization: fiveHour, resetsAt: later(120).toISOString(), windowDurationMins: 300 },
  secondary: { utilization: weekly, resetsAt: weekEnds.toISOString(), windowDurationMins: 7 * DAY },
});
const pool = (over: Partial<CredentialPool<LoginAccount, Key>>): CredentialPool<LoginAccount, Key> => ({
  ownerId: OLGA,
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

// A rate limit the gateway could not wait out (migration 0382): the account it left the mark on cannot
// run, so a session on it is moved exactly as one on a spent account is — and keeps it while nothing
// else can take the session, which is where the retry waits for the mark instead of a fixed step.
test('(1) an account rate-limited past the gateway\'s own wait is left for one that can run', () => {
  const throttled = account('a1', { throttledUntil: later(2) });
  const other = account('a2');
  assert.deepEqual(choose(pool({ accounts: [throttled, other] }), OLGA, on('a1', null)).chosen, on('a2', null));
  // Nothing else can take it: nothing is chosen, and the session keeps the account it has — which is where
  // the retry waits for the mark rather than at a fixed step.
  assert.deepEqual(choose(pool({ accounts: [throttled] }), OLGA, on('a1', null)), {
    chosen: null,
    next: on('a1', null),
    notice: null,
  });
  // The mark has passed: choosing afresh takes it back, and a session on it stays.
  const served = account('a1', { throttledUntil: new Date(NOW.getTime() - 1) });
  assert.deepEqual(choose(pool({ accounts: [served, other] }), OLGA, on('a1', null)).chosen, on('a1', null));
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

test("(4) anybody else's session too runs on the pool's ChatGPT accounts first, and on its keys while none can run", () => {
  const accounts = [account('a1')];
  // Olga's key, capped at $10 a month for everybody else, who have spent all of it.
  const capped = key('k1', OLGA, { shareCap: 10, othersCostMicros: dollars(10) });
  const keys = [capped, key('k2', PIA), key('k3', MAX, { shareCap: 10, othersCostMicros: dollars(9) })];
  // Pia's session starts on Olga's account — since 2026-10-03 the accounts run everybody's in the pool,
  // its owner's sessions and the people they added's alike — before any key.
  assert.deepEqual(choose(pool({ accounts, keys }), PIA), { chosen: on('a1', null), next: on('a1', null), notice: null });
  // A row that names that account is already where she runs.
  assert.deepEqual(choose(pool({ accounts, keys }), PIA, on('a1', null)), {
    chosen: on('a1', null),
    next: on('a1', null),
    notice: null,
  });
  // Every account down: her own key first, none the others spent to its share cap.
  const down = [account('a1', { state: 'SIGNED_OUT' })];
  assert.deepEqual(choose(pool({ accounts: down, keys }), PIA), { chosen: on(null, 'k2'), next: on(null, 'k2'), notice: null });
  // Her own switched off: Max's, with a dollar of its cap left — never Olga's, though its id is lower.
  const ownOff = [capped, key('k2', PIA, { enabled: false }), keys[2]];
  assert.deepEqual(choose(pool({ accounts: down, keys: ownOff }), PIA).chosen, on(null, 'k3'));
  // The cap is on everybody but its contributor: Olga runs on her own key all the same, once her accounts cannot.
  assert.deepEqual(choose(pool({ accounts: down, keys: [capped] }), OLGA).chosen, on(null, 'k1'));
  // An account back: off the key onto it — with the line for one of the people added, whose accounts it is not.
  assert.deepEqual(choose(pool({ accounts, keys }), PIA, on(null, 'k2')), {
    chosen: on('a1', null),
    next: on('a1', null),
    notice: "Switched to a1@chatgpt.invalid — the pool's ChatGPT accounts come first",
  });
  // No key at all, and only an account that cannot run: nothing chosen, and the session goes to the
  // account chooseLoginAccount falls back to — the one that comes back first — so the gateway answers
  // with that account's refusal rather than as a pool holding no account.
  assert.deepEqual(choose(pool({ accounts: down, keys: [] }), PIA), { chosen: null, next: on('a1', null), notice: null });
  // A pool holding neither: nothing chosen, nothing named.
  assert.deepEqual(choose(pool({ accounts: [], keys: [] }), PIA), { chosen: null, next: on(null, null), notice: null });
  // A move between keys says why, as pool-key-select.ts says it.
  const k2Spent = [capped, key('k2', PIA, { spentUntil: later(30) }), keys[2]];
  assert.equal(choose(pool({ accounts: down, keys: k2Spent }), PIA, on(null, 'k2')).notice, 'Switched to k3-key — k2-key is out of budget');
});

test('(4) a pool holding no account is the same rule: its keys do the work, and a row naming an account it does not hold moves on with a line', () => {
  // A keys-only pool — what a shared pool (0321) is until somebody in it signs an account in (0371) — and
  // a session whose row names an account this pool does not hold: it goes to a key, and the line says
  // which account it left (one carried over from another pool, or one this pool no longer holds).
  const keysOnly = pool({ keys: [key('k1', MAX), key('k2', OLGA)] });
  assert.deepEqual(choose(keysOnly, OLGA, on('a9', null)), {
    chosen: on(null, 'k2'),
    next: on(null, 'k2'),
    notice: 'Switched to k2-key — the previous account is no longer in this pool',
  });
  // A session that names nothing moves without a line: it starts here.
  assert.deepEqual(choose(keysOnly, OLGA), { chosen: on(null, 'k2'), next: on(null, 'k2'), notice: null });
  // The same pool once the account IS one of its own (0371): the session stays on it.
  const withAccount = pool({ accounts: [account('a9')], keys: [key('k1', MAX), key('k2', OLGA)] });
  assert.deepEqual(choose(withAccount, OLGA, on('a9', null)), { chosen: on('a9', null), next: on('a9', null), notice: null });
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
  // One of the people the owner added, the same: her session names the account that comes back first, so
  // the gateway answers with its limit rather than as a pool with no account.
  assert.deepEqual(choose(pool({ accounts, keys: dead }), PIA), { chosen: null, next: on('a1', null), notice: null });
});
