import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenListDeltaStore } from './open-list-delta';

type Row = { id: string; title: string };
const OWNER = 'owner-1';
const SCOPE = '[null,null,null,null]';

function store(clock = { now: 0 }, opts: { perOwner?: number; ttlMs?: number } = {}) {
  return new OpenListDeltaStore({ ...opts, now: () => clock.now });
}

function first(s: OpenListDeltaStore, rows: Row[]) {
  const answer = s.answer(OWNER, SCOPE, rows, '');
  assert.equal(answer.full, true);
  return answer.cursor;
}

const a = { id: 'a', title: 'A' };
const b = { id: 'b', title: 'B' };
const c = { id: 'c', title: 'C' };

test('a read with no cursor is the whole list, with a cursor for the next one', () => {
  const answer = store().answer(OWNER, SCOPE, [a, b], '');
  assert.deepEqual(answer.full && answer.sessions, [a, b]);
  assert.match(answer.cursor, /^[A-Za-z0-9_-]{22}$/);
});

test('an unchanged list is an empty delta under the same cursor', () => {
  const s = store();
  const cursor = first(s, [a, b]);
  assert.deepEqual(s.answer(OWNER, SCOPE, [a, b], cursor), {
    full: false, upserts: [], removedIds: [], cursor,
  });
});

test('a new session is an upsert, with the order that places it', () => {
  const s = store();
  const cursor = first(s, [a, b]);
  const answer = s.answer(OWNER, SCOPE, [c, a, b], cursor);
  assert.equal(answer.full, false);
  assert.deepEqual(!answer.full && answer.upserts, [c]);
  assert.deepEqual(!answer.full && answer.removedIds, []);
  assert.deepEqual(!answer.full && answer.order, ['c', 'a', 'b']);
  assert.notEqual(answer.cursor, cursor);
});

test('a changed field is an upsert of that row alone, and no order when it did not move', () => {
  const s = store();
  const cursor = first(s, [a, b]);
  const renamed = { id: 'b', title: 'B, renamed' };
  const answer = s.answer(OWNER, SCOPE, [a, renamed], cursor);
  assert.deepEqual(answer, { full: false, upserts: [renamed], removedIds: [], cursor: answer.cursor });
});

test('a row that moved is sent in the order alone', () => {
  const s = store();
  const cursor = first(s, [a, b]);
  const answer = s.answer(OWNER, SCOPE, [b, a], cursor);
  assert.deepEqual(answer, { full: false, upserts: [], removedIds: [], order: ['b', 'a'], cursor: answer.cursor });
});

// Deleted, completed and trashed all reach the delta the same way: the row is no longer in the
// Open list. The pg spec drives each of those through the real query.
test('a session gone from the list is a removed id', () => {
  const s = store();
  const cursor = first(s, [a, b, c]);
  const answer = s.answer(OWNER, SCOPE, [a, c], cursor);
  assert.deepEqual(answer, { full: false, upserts: [], removedIds: ['b'], order: ['a', 'c'], cursor: answer.cursor });
});

test('an unknown cursor asks for the whole list', () => {
  const s = store();
  first(s, [a]);
  const answer = s.answer(OWNER, SCOPE, [a, b], 'not-a-cursor-this-held');
  assert.deepEqual(answer.full && answer.sessions, [a, b]);
});

test('an expired cursor asks for the whole list', () => {
  const clock = { now: 0 };
  const s = store(clock, { ttlMs: 1_000 });
  const cursor = first(s, [a]);
  clock.now = 1_001;
  const answer = s.answer(OWNER, SCOPE, [a], cursor);
  assert.equal(answer.full, true);
});

test('an evicted cursor asks for the whole list', () => {
  const s = store(undefined, { perOwner: 2 });
  const oldest = first(s, [a]);
  first(s, [b]);
  first(s, [c]);
  assert.equal(s.answer(OWNER, SCOPE, [a], oldest).full, true);
});

test('a cursor answers only the owner and scope it was issued under', () => {
  const s = store();
  const cursor = first(s, [a]);
  assert.equal(s.answer('owner-2', SCOPE, [a], cursor).full, true);
  assert.equal(s.answer(OWNER, '["runner",null,null,null]', [a], cursor).full, true);
});

test('a cursor stays good after use, so a retried read still gets its delta', () => {
  const s = store();
  const cursor = first(s, [a]);
  s.answer(OWNER, SCOPE, [a, b], cursor);
  const retried = s.answer(OWNER, SCOPE, [a, b], cursor);
  assert.equal(retried.full, false);
  assert.deepEqual(!retried.full && retried.upserts, [b]);
});

test('a field the fingerprint leaves out is not a change', () => {
  const s = store();
  const fingerprint = (row: Row & { seen?: number }) => ({ ...row, seen: undefined });
  const cursor = s.answer(OWNER, SCOPE, [{ ...a, seen: 1 }], '', fingerprint).cursor;
  const answer = s.answer(OWNER, SCOPE, [{ ...a, seen: 2 }], cursor, fingerprint);
  assert.deepEqual(answer, { full: false, upserts: [], removedIds: [], cursor });
});
