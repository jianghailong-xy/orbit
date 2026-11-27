import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';
import { declaresListScopes, movedScopes, openListTickStatement } from './open-list-hints';

/** What the poller names from two reads of an account's counter keys (docs/list-freshness-scope-hints.md §5.1). */

const A = '0190f3a8-7c1e-7d2a-9b3c-4d5e6f708192';
const B = '0190f3a8-7c1e-7d2a-9b3c-4d5e6f7081a3';
const C = '0190f3a8-7c1e-7d2a-9b3c-4d5e6f7081b4';
const keys = (entries: Record<string, number>) => new Map(Object.entries(entries).map(([key, n]) => [key, BigInt(n)]));
const none = new Set<string>();

test('the first read, an account-wide key and the clock part each name no workspace: any list may have moved', () => {
  assert.equal(movedScopes(undefined, keys({ [`session@w:${A}`]: 1 }), false, [], none), undefined);
  assert.equal(movedScopes(keys({ task: 1 }), keys({ task: 2 }), false, [], none), undefined);
  assert.equal(movedScopes(keys({ [`session@w:${A}`]: 1, task: 1 }), keys({ [`session@w:${A}`]: 2, task: 2 }), false, [], none), undefined);
  assert.equal(movedScopes(keys({ task: 1 }), keys({ task: 1 }), true, [], none), undefined);
});

test('an Open key names its workspace; a closed key alone names none, and nothing moved names none', () => {
  assert.deepEqual(movedScopes(keys({ [`session@w:${A}`]: 1 }), keys({ [`session@w:${A}`]: 2 }), false, [], none), [uuidToBase62(A)]);
  assert.deepEqual(movedScopes(keys({}), keys({ [`conversation_turn@w:${B}`]: 1 }), false, [], none), [uuidToBase62(B)]);
  assert.deepEqual(movedScopes(keys({ [`session@c:${A}`]: 1 }), keys({ [`session@c:${A}`]: 2 }), false, [], none), []);
  assert.deepEqual(movedScopes(keys({ [`session@w:${A}`]: 1 }), keys({ [`session@w:${A}`]: 1 }), false, [], none), []);
});

test('an open request names the other end of a move in either scope; always-rebuilt workspaces join any move', () => {
  const pairs: Array<[string, string]> = [[A, B]];
  assert.deepEqual(movedScopes(keys({}), keys({ [`session@c:${B}`]: 1 }), false, pairs, none), [uuidToBase62(A)]);
  assert.deepEqual(movedScopes(keys({}), keys({ [`session@w:${A}`]: 1 }), false, pairs, none), [uuidToBase62(A), uuidToBase62(B)].sort());
  assert.deepEqual(movedScopes(keys({}), keys({ [`session@c:${B}`]: 1 }), false, [], new Set([C])), [uuidToBase62(C)]);
  assert.deepEqual(movedScopes(keys({}), keys({}), false, pairs, new Set([C])), []);
});

test('a pair in one workspace names it when its peer outside every Open list moves', () => {
  assert.deepEqual(movedScopes(keys({}), keys({ [`session@c:${A}`]: 1 }), false, [[A, A]], none), [uuidToBase62(A)]);
  assert.deepEqual(movedScopes(keys({}), keys({ [`conversation_turn@c:${A}`]: 1 }), false, [[A, A], [B, C]], none), [uuidToBase62(A)]);
});

test('the tick statement keeps pairs in one workspace and reads no LANDING-rooted rows', () => {
  const { sql } = openListTickStatement([A], []);
  assert.doesNotMatch(sql, /f\.workspace_id\s*<>\s*t\.workspace_id/, 'pairs in one workspace are dropped');
  assert.doesNotMatch(sql, /LANDING/, 'the tick reads LANDING-rooted rows, a scan of the account');
  assert.match(sql, /x\.finished_at IS NULL AND [\s\S]*x\."turn_state"[\s\S]* = 'QUEUED'/);
});

test('the hints value declares list_scopes beside the others', () => {
  assert.equal(declaresListScopes('list_changed,owner_requests,schedule_cards,list_scopes'), true);
  assert.equal(declaresListScopes(['list_changed', ' list_scopes ']), true);
  assert.equal(declaresListScopes('list_changed,owner_requests'), false);
  assert.equal(declaresListScopes(undefined), false);
});
