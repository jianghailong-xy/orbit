import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badgeDiff, BadgeState } from './badge-diff';

const state = (badge: number, ids: string[]): BadgeState => ({ badge, sessions: new Set(ids) });

test('first-ever compute (no prior state) is a change to the current count', () => {
  const d = badgeDiff(undefined, ['a', 'b']);
  assert.equal(d.badge, 2);
  assert.deepEqual(d.clearSessions, []);
  assert.equal(d.changed, true);
});

test('no prior state and nothing pending is NOT a change (no spurious badge=0 push)', () => {
  // The common case: a status event fires for an owner who has no pending approvals.
  const d = badgeDiff(undefined, []);
  assert.equal(d.badge, 0);
  assert.deepEqual(d.clearSessions, []);
  assert.equal(d.changed, false);
});

test('badge counts sessions, not approvals — a session id appears once', () => {
  // currentIds is a session-id list; the query already de-dupes to one id per session.
  const d = badgeDiff(state(0, []), ['a']);
  assert.equal(d.badge, 1);
  assert.equal(d.changed, true);
});

test('resolving one of a session’s several approvals leaves it needing you → no change', () => {
  // session "a" still holds a pending approval, so it stays in the list; nothing to push.
  const d = badgeDiff(state(1, ['a']), ['a']);
  assert.equal(d.changed, false);
  assert.deepEqual(d.clearSessions, []);
  assert.equal(d.badge, 1);
});

test('a session dropping out lowers the badge and is marked for banner clearing', () => {
  const d = badgeDiff(state(2, ['a', 'b']), ['a']);
  assert.equal(d.badge, 1);
  assert.deepEqual(d.clearSessions, ['b']);
  assert.equal(d.changed, true);
});

test('clearing the last session goes to 0 and clears its banner', () => {
  const d = badgeDiff(state(1, ['a']), []);
  assert.equal(d.badge, 0);
  assert.deepEqual(d.clearSessions, ['a']);
  assert.equal(d.changed, true);
});

test('idempotent recompute of the same set is not a change', () => {
  const d = badgeDiff(state(2, ['a', 'b']), ['b', 'a']);
  assert.equal(d.changed, false);
  assert.deepEqual(d.clearSessions, []);
  assert.equal(d.badge, 2);
});

test('a net-zero swap still clears the banner of the session that left', () => {
  // one session leaves, another enters — count unchanged, but "a" must still be cleared.
  const d = badgeDiff(state(1, ['a']), ['b']);
  assert.equal(d.badge, 1);
  assert.deepEqual(d.clearSessions, ['a']);
  assert.equal(d.changed, true);
});
