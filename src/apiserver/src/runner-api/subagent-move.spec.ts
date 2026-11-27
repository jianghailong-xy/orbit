import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunFailureKind, type SubagentAttempt } from '@orbit/shared';
import { subjectKey } from '../providers/account-health';
import {
  ACCOUNT_REFUSAL_OUTCOMES,
  countedMoves,
  isMovableOutcome,
  movableFailure,
  moveReason,
  noProviderMessage,
  subjectOfKey,
  trialSubject,
} from './subagent-run';

/**
 * A SubAgent's move after its account refused it (docs/routing-account-health-design.md §7.3, §6.5): which failures
 * move, what the move's Why line says, and how many moves count toward SUBAGENT_MAX_MOVES.
 */

const WORDS = 'provider words';

test('movableFailure: every kind the runner may send', () => {
  const expected: Record<RunFailureKind, string | null> = {
    [RunFailureKind.USAGE_LIMIT]: 'USAGE_LIMIT',
    [RunFailureKind.CAPACITY]: 'AT_CAPACITY',
    [RunFailureKind.CREDENTIAL_REFUSED]: 'AUTH_FAILED',
    [RunFailureKind.ACCOUNT_ACTION_REQUIRED]: 'ACCOUNT_ACTION_REQUIRED',
    [RunFailureKind.ACCESS_DENIED]: 'ACCESS_DENIED',
    [RunFailureKind.TRANSPORT]: null,
    [RunFailureKind.REQUEST_REFUSED]: null,
  };
  for (const kind of Object.values(RunFailureKind)) {
    assert.equal(movableFailure(WORDS, { kind }), expected[kind], kind);
    // The runner's admission flag adds nothing to a classified kind: a refused request is still the result.
    assert.equal(movableFailure(WORDS, { kind }, true), expected[kind], `${kind}, refused at admission`);
  }
});

test('movableFailure: an unclassified failure moves only when the runner measured it as refused at admission', () => {
  assert.equal(movableFailure('Upgrade your plan to keep going', null, true), 'ADMISSION_FAILED');
  assert.equal(movableFailure('Upgrade your plan to keep going', { kind: 'A_NEWER_KIND' }, true), 'ADMISSION_FAILED',
    "a kind this server does not know is unclassified");
  assert.equal(movableFailure('Upgrade your plan to keep going', null, false), null, 'it did some work');
  assert.equal(movableFailure('Upgrade your plan to keep going'), null, 'an older runner measures nothing');
  // A dropped connection reads as TRANSPORT through the legacy markers: it says nothing of the account.
  assert.equal(movableFailure('Failed to authenticate. API Error: 403 Attention Required! | Cloudflare', null, true), null);
  // The legacy markers still decide first for a runner that sent no kind.
  assert.equal(movableFailure("You've hit your session limit · resets 6:20pm", null, true), 'USAGE_LIMIT');
  assert.equal(movableFailure('Not logged in · Please run /login', null, true), 'AUTH_FAILED');
});

test('the account refusals are not moved off a named model; a limit or capacity is', () => {
  assert.deepEqual([...ACCOUNT_REFUSAL_OUTCOMES].sort(), ['ACCESS_DENIED', 'ACCOUNT_ACTION_REQUIRED', 'ADMISSION_FAILED', 'AUTH_FAILED']);
  assert.equal(isMovableOutcome('USAGE_LIMIT'), true);
  assert.equal(isMovableOutcome('ADMISSION_FAILED'), true);
  assert.equal(isMovableOutcome('FAILED'), false);
  assert.equal(isMovableOutcome('RUNNING'), false);
});

test("moveReason: the Why line names both models and what the first one's account did", () => {
  const next = { model: 'b-coder', provider: 'metered-b' };
  assert.equal(moveReason(next, 'a-coder', 'ACCOUNT_ACTION_REQUIRED'), "Moved to b-coder on metered-b after a-coder's account needed action");
  assert.equal(moveReason(next, 'a-coder', 'ACCESS_DENIED'), "Moved to b-coder on metered-b after a-coder's account needed action");
  assert.equal(moveReason(next, 'a-coder', 'ADMISSION_FAILED'), 'Moved to b-coder on metered-b after a-coder could not start');
  // Today's lines, unchanged.
  assert.equal(moveReason(next, 'a-coder', 'USAGE_LIMIT'), "Moved to b-coder on metered-b after a-coder's account hit its limit");
  assert.equal(moveReason(next, 'a-coder', 'AT_CAPACITY'), 'Moved to b-coder on metered-b after a-coder was at capacity');
  assert.equal(moveReason(next, 'a-coder', 'AUTH_FAILED'), "Moved to b-coder on metered-b after a-coder's login failed");
});

const attempt = (n: number, outcome: SubagentAttempt['outcome'], trialOf?: string) => ({
  engine: 'claude', provider: `p${n}`, model: `m${n}`, effort: null, attempt: n, outcome, startedAt: '2026-11-23T00:00:00.000Z',
  ...(trialOf ? { trialOf } : {}),
}) as SubagentAttempt;

test('countedMoves: each attempt moved off counts, except a refused trial (§6.5)', () => {
  assert.equal(countedMoves([attempt(1, 'USAGE_LIMIT')]), 1);
  assert.equal(countedMoves([attempt(1, 'USAGE_LIMIT'), attempt(2, 'ACCOUNT_ACTION_REQUIRED', 'provider:x')]), 1);
  assert.equal(countedMoves([attempt(1, 'USAGE_LIMIT'), attempt(2, 'ACCESS_DENIED', 'provider:x'), attempt(3, 'USAGE_LIMIT')]), 2);
});

test('noProviderMessage: says what each new outcome was', () => {
  const message = noProviderMessage({ level: 'M', candidates: [] }, [
    attempt(1, 'ACCOUNT_ACTION_REQUIRED'), attempt(2, 'ACCESS_DENIED'), attempt(3, 'ADMISSION_FAILED'), attempt(4, 'FAILED'),
  ]);
  assert.equal(message, "No provider is left to run this SubAgent in tier M. Each provider's reason:\n"
    + '- p1 (claude), m1: the account needed action\n'
    + '- p2 (claude), m2: the account did not allow this use\n'
    + '- p3 (claude), m3: it could not start');
});

test('subjectOfKey reads every subject key back as the subject it names', () => {
  const subjects = [
    { type: 'runner' as const, runnerId: '0193a3f4-7d2e-7a10-8c55-0123456789ab', engine: 'claude', account: 'work:alt' },
    { type: 'provider' as const, providerId: '0193a3f4-7d2e-7a10-8c55-0123456789ab' },
    { type: 'pool-login' as const, poolId: '0193a3f4-7d2e-7a10-8c55-0123456789ab', accountId: 'acct-1' },
  ];
  for (const subject of subjects) assert.deepEqual(subjectOfKey(subjectKey(subject)), subject);
  assert.equal(subjectOfKey('provider:not-a-uuid'), null);
  assert.equal(subjectOfKey('something:else'), null);
});

test("trialSubject: the router's due trial on a candidate, else none", () => {
  assert.equal(trialSubject({ trial: { subject: 'provider:x' } }), 'provider:x');
  assert.equal(trialSubject({}), null);
  assert.equal(trialSubject({ trial: { subject: '' } }), null);
});
