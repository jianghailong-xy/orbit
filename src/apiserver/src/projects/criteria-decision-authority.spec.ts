import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTHORITY_REFUSAL_CODES,
  AUTHORITY_REQUIRED_ACTIONS,
  COORDINATOR_AUTHORITY,
  refuseSessionAuthoredCriteriaDecision,
  refuseSessionAuthoredConfirmation,
} from './coordinator-authority';

/**
 * The decision door's one authority rule, on its own, with no database in front of it.
 *
 * `criteria-decision-door.pg.spec.ts` witnesses that the rule is REACHED and that a refused
 * request writes nothing. This file pins what the rule SAYS — which is the half a pg spec is a
 * clumsy place to state, because every assertion here is a property of two lines of pure code.
 *
 * The rule is one predicate: a decision authored by an acting session is refused, whatever role
 * that session has. It is not a claim that a person is present; the owner channel is a credential
 * like any other.
 */

test('a decision with no acting session meets no rule here', () => {
  for (const absent of [undefined, null, '']) {
    assert.equal(refuseSessionAuthoredCriteriaDecision(absent), null,
      `an acting session of ${JSON.stringify(absent)} is no acting session`);
  }
});

test('a decision authored by a session is refused, and the refusal is actionable', () => {
  const refused = refuseSessionAuthoredCriteriaDecision('a-session-id');
  assert.ok(refused, 'a session-authored criteria decision must not be allowed');
  assert.equal(refused.code, 'PROJECT_CRITERIA_DECISION_OWNER_CHANNEL_ONLY');
  assert.equal(refused.action, 'EDIT_ACCEPTANCE_CRITERIA',
    'answering a held criteria change IS the edit taking effect, so it is that row of the table');
  assert.equal(refused.tier, COORDINATOR_AUTHORITY.EDIT_ACCEPTANCE_CRITERIA);
  assert.equal(refused.tier, 'HUMAN_ONLY');
  assert.equal(refused.requiredAction, 'ASK_A_PERSON');
  assert.ok(AUTHORITY_REFUSAL_CODES.includes(refused.code),
    'the code is one of the closed set, so a client can switch on it');
  assert.ok(AUTHORITY_REQUIRED_ACTIONS.includes(refused.requiredAction));
  // What a refused caller has to be able to read off the message: that its request changed
  // nothing, and that the credential proves no person.
  assert.match(refused.message, /Nothing was written/);
  assert.match(refused.message, /owner/);
  assert.match(refused.message, /(?:not|neither is) proof that a human held the credential/);
});

test('every acting session is refused, whatever it is', () => {
  for (const session of ['coordinator-session', 'judgment-session', 'a-task-session']) {
    const refused = refuseSessionAuthoredCriteriaDecision(session);
    assert.ok(refused, `${session} must not be able to decide a criteria change`);
    assert.equal(refused.code, 'PROJECT_CRITERIA_DECISION_OWNER_CHANNEL_ONLY',
      'one rule, one code: the refusal does not vary with the session\'s role');
  }
});

test('deciding a change and confirming the set are two rules with two codes', () => {
  // §12 E2 forbids two spellings of one rule. These are two rules — one is about whether an edit
  // takes effect, the other about whether the set as it stands expresses the goal — so a caller
  // refused by one has not met the other, and being told the wrong code would say it had.
  const decision = refuseSessionAuthoredCriteriaDecision('a-session-id');
  const confirmation = refuseSessionAuthoredConfirmation('a-session-id');
  assert.ok(decision && confirmation);
  assert.notEqual(decision.code, confirmation.code);
  assert.notEqual(decision.action, confirmation.action);
});
