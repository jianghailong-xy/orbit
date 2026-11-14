import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { RECOVERY_ACTION_SEMANTICS, parseRecovery } from '@orbit/shared';

import {
  SESSION_RECOVERY_RULES, type SessionRecoveryCode, managedRunnerStartingNote, mergePendingNext, sessionRecoveryBody,
} from './session-recovery';

/**
 * The server half of docs/recovery-contract.md §9: SESSION_RECOVERY_RULES is the table, the shared
 * vectors in contracts/recovery.fixtures.json ("session recovery: …") are what both client parsers and
 * the Go renderer are held to, and this holds the two to each other.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const FIXTURES = JSON.parse(readFileSync(path.join(ROOT, 'contracts/recovery.fixtures.json'), 'utf8')) as {
  cases: Array<{ name: string; input: { status: number; body: string } }>;
};
const SESSION_CASES = FIXTURES.cases.filter((c) => c.name.startsWith('session recovery: '));
const CODES = Object.keys(SESSION_RECOVERY_RULES) as SessionRecoveryCode[];

test('every code has a shared vector, and every vector is the table as the server writes it', () => {
  assert.deepEqual(SESSION_CASES.map((c) => c.name.slice('session recovery: '.length)).sort(), [...CODES].sort());
  for (const c of SESSION_CASES) {
    const body = JSON.parse(c.input.body);
    const rule = SESSION_RECOVERY_RULES[body.code as SessionRecoveryCode];
    assert.equal(c.input.status, rule.status, body.code);
    assert.equal(body.statusCode, rule.status, body.code);
    assert.equal(body.owner, rule.actor, body.code);
    assert.equal(body.requiredAction, rule.actionCode, body.code);
    assert.equal(body.retryable, rule.retryPolicy === 'SAFE', body.code);
    assert.equal(body.recovery.retryPolicy, rule.retryPolicy, body.code);
    assert.equal(body.recovery.actionCode, rule.actionCode, body.code);
    assert.equal(body.recovery.actor, rule.actor, body.code);
    assert.equal(body.recovery.effect, 'NONE', body.code);
    assert.equal(body.recovery.userConfirmation, 'NOT_REQUIRED', body.code);
  }
});

test('every action the table names is registered in the contract', () => {
  for (const code of CODES) assert.ok(RECOVERY_ACTION_SEMANTICS[SESSION_RECOVERY_RULES[code].actionCode], code);
});

test('backpressure never advises a resend: not retryable, no automatic-retry action, no SAFE policy', () => {
  for (const code of ['SPAWN_TREE_OUTSTANDING_LIMIT', 'SPAWN_TREE_RATE_LIMIT', 'SPAWN_DEPTH_LIMIT', 'CALLER_SESSION_NOT_LIVE'] as const) {
    const env = parseRecovery({ source: 'HTTP', status: SESSION_RECOVERY_RULES[code].status, body: JSON.stringify(sessionRecoveryBody(code, 'm', { retryAfterSeconds: 30 })) })!;
    assert.notEqual(env.retry.policy, 'SAFE', code);
    assert.notEqual(env.retry.policy, 'SAME_REQUEST_ID', code);
    assert.equal(RECOVERY_ACTION_SEMANTICS[env.actionCode!].automaticRetry, false, code);
  }
  // The depth limit is final for this request and stops further spawning below.
  const depth = sessionRecoveryBody('SPAWN_DEPTH_LIMIT', 'm', { retryAfterSeconds: 30 });
  assert.equal((depth.recovery as { retryPolicy: string }).retryPolicy, 'NEVER');
  assert.equal((depth.recovery as { retryAfterSeconds: unknown }).retryAfterSeconds, null, 'NEVER carries no wait');
  assert.equal(depth.retryAfterSeconds, undefined);
});

test('a person\'s boundary is named as one: Trash, orchestration, sign-in and a failed machine are AWAIT_USER_FIX, actor USER', () => {
  for (const code of ['SESSION_TRASHED', 'ORCHESTRATION_DISABLED', 'ENGINE_SIGNED_OUT', 'MANAGED_RUNNER_FAILED'] as const) {
    assert.equal(SESSION_RECOVERY_RULES[code].actor, 'USER', code);
    assert.equal(SESSION_RECOVERY_RULES[code].actionCode, 'AWAIT_USER_FIX', code);
    assert.notEqual(SESSION_RECOVERY_RULES[code].retryPolicy, 'SAFE', code);
  }
  // And the only USER-actor codes are those: nothing else is handed to a person.
  assert.deepEqual(CODES.filter((c) => SESSION_RECOVERY_RULES[c].actor === 'USER').sort(),
    ['ENGINE_SIGNED_OUT', 'MANAGED_RUNNER_FAILED', 'ORCHESTRATION_DISABLED', 'SESSION_TRASHED']);
});

test('only the next-turn race is retryable, and only after its wait', () => {
  assert.deepEqual(CODES.filter((c) => SESSION_RECOVERY_RULES[c].retryPolicy === 'SAFE'), ['SESSION_NEXT_TURN_STARTING']);
  assert.equal(SESSION_RECOVERY_RULES.SESSION_NEXT_TURN_STARTING.retryAfterSeconds, 2);
});

test('a pending merge points at a read of its session, not at another merge', () => {
  assert.deepEqual(mergePendingNext('s-1'), { actionCode: 'POLL_STATE', afterSeconds: 30, resources: [{ type: 'SESSION', id: 's-1' }] });
  assert.equal(RECOVERY_ACTION_SEMANTICS.POLL_STATE.mayWrite, false);
});

test('a machine still coming up is a poll of the child, owned by the platform, never shorter than 30 s', () => {
  const now = Date.parse('2026-11-15T00:00:00Z');
  const soon = managedRunnerStartingNote('child', 'runner', { state: 'STARTING', retryAfter: new Date(now + 5_000) }, now);
  assert.equal(soon.next.afterSeconds, 30);
  assert.equal(soon.runnerState.owner, 'SYSTEM');
  assert.equal(soon.next.actionCode, 'POLL_STATE');
  assert.deepEqual(soon.next.resources, [{ type: 'SESSION', id: 'child' }, { type: 'RUNNER', id: 'runner' }]);
  const later = managedRunnerStartingNote('child', 'runner', { state: 'WAITING_CAPACITY', retryAfter: new Date(now + 120_000) }, now);
  assert.equal(later.next.afterSeconds, 120);
  assert.equal(later.runnerState.managementState, 'WAITING_CAPACITY');
});
