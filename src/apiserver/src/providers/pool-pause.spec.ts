import assert from 'node:assert/strict';
import { test } from 'node:test';
import { choosePoolMember, poolResumesAt, selectPoolMember, type PoolCandidate } from './pool-select';
import { chooseLoginAccount, loginPoolResumesAt, type LoginAccount } from './pool-login-select';
import { choosePoolKey, poolKeysResumeAt, type PoolKeyCandidate } from './pool-key-select';
import { choosePoolCredential } from './pool-credential-select';

const now = new Date('2026-10-04T10:00:00Z');
const first = new Date('2026-10-04T11:00:00Z');
const later = new Date('2026-10-04T12:00:00Z');
const account = (accountId: string, pausedUntil: Date | null): LoginAccount => ({
  accountId, pausedUntil, email: accountId, state: 'ACTIVE', spentUntil: null, throttledUntil: null, usage: null,
});
const key = (id: string, pausedUntil: Date | null): PoolKeyCandidate & { label: string } => ({
  id, label: id, pausedUntil, contributorId: 'owner', state: 'ACTIVE', enabled: true,
  spentUntil: null, throttledUntil: null, shareCap: null, othersCostMicros: 0,
});
const member = (id: string, pausedUntil: Date | null): PoolCandidate<{ id: string; slug: string }> => ({
  row: { id, slug: id }, pausedUntil, usage: null, refused: false, usageUnreadable: false,
});

test('a manual pause overrides sticky account selection and expires without rewriting auth or quota', () => {
  const accounts = [account('a', later), account('b', null)];
  assert.equal(chooseLoginAccount(accounts, 'a', now)?.accountId, 'b');
  assert.equal(chooseLoginAccount(accounts, 'a', later)?.accountId, 'a');
  const keys = [key('a', later), key('b', null)];
  assert.equal(choosePoolKey(keys, 'owner', true, 'a', now)?.id, 'b');
  assert.equal(choosePoolKey(keys, 'owner', true, 'a', later)?.id, 'a');
  const members = [member('a', later), member('b', null)];
  assert.equal(choosePoolMember(members, 'a', now)?.id, 'b');
  assert.equal(choosePoolMember(members, 'a', later)?.id, 'a');
});

test('every account paused: never choose the sticky paused account, and wait for the first expiry', () => {
  const accounts = [account('a', later), account('b', first)];
  assert.equal(chooseLoginAccount(accounts, 'a', now), null);
  assert.deepEqual(loginPoolResumesAt(accounts, now), first);
  const keys = [key('a', later), key('b', first)];
  assert.equal(choosePoolKey(keys, 'owner', true, 'a', now), null);
  assert.deepEqual(poolKeysResumeAt(keys, 'owner', now), first);
  const members = [member('a', later), member('b', first)];
  assert.equal(choosePoolMember(members, 'a', now), null);
  assert.equal(selectPoolMember(members, 'a', now).kind, 'EXHAUSTED');
  assert.deepEqual(poolResumesAt(members, now), first);
});

test('pause and rate-limit cooldown combine without clearing either and use the later return', () => {
  assert.deepEqual(loginPoolResumesAt([{ ...account('a', first), spentUntil: later }], now), later);
  assert.deepEqual(poolKeysResumeAt([{ ...key('a', first), spentUntil: later }], 'owner', now), later);
  const paused = { ...member('a', first), usage: { fiveHour: { utilization: 100, resetsAt: later.toISOString() } } };
  assert.deepEqual(poolResumesAt([paused], now), later);
  assert.equal(choosePoolMember([paused], 'a', now), null);
});

test('a Codex pool skips paused logins, uses an available key, and returns to the login after expiry', () => {
  const pool = { ownerId: 'owner', accounts: [account('a', later)], keys: [key('k', null)], ownKeyFirst: true };
  const choice = choosePoolCredential(pool, { ownerId: 'owner', accountId: 'a', keyId: null }, now);
  assert.deepEqual(choice.chosen, { accountId: null, keyId: 'k' });
  assert.match(choice.notice!, /is paused/);
  assert.deepEqual(choosePoolCredential(pool, { ownerId: 'owner', accountId: null, keyId: 'k' }, later).chosen, { accountId: 'a', keyId: null });
});
