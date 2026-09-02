import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  TASK_COMPLETION_CRITERIA,
  deriveTaskCompletionStatus,
  evaluateTaskCompletion,
  projectVerifierCarrierStatus,
  resolveTaskCompletionCriterion,
  taskCompletionDeclarationError,
  taskCompletionRequiredAction,
} from './task-completion-criterion';

const ACTIVE_VERIFIER_RETIREMENT = {
  currentTerminalReason: null,
  nextTerminalReason: null,
  currentSupersededByTaskId: null,
  nextSupersededByTaskId: null,
};

test('undeclared completion is the ordinary EVIDENCE_JUDGMENT criterion', () => {
  assert.equal(resolveTaskCompletionCriterion({}), 'EVIDENCE_JUDGMENT');
  assert.deepEqual(evaluateTaskCompletion({ completionCriterion: null }), {
    criterion: 'EVIDENCE_JUDGMENT', state: 'UNSATISFIED', satisfied: false,
  });
});

// VERIFICATION is the only criterion with an implementation since 2026-09-02. The other two are
// declared-but-unimplemented: legal to declare, impossible to satisfy, and — the point of naming
// them here — evaluated by their OWN `case`, not by falling through to somebody else's answer or
// to a default. `evaluateTaskCompletion`'s switch has no default arm, so the exhaustiveness check
// is what makes that a compile-time fact rather than a comment.
test('VERIFICATION evaluates both satisfied and unsatisfied facts', () => {
  assert.deepEqual(
    evaluateTaskCompletion({ completionCriterion: 'VERIFICATION', verificationVerdict: 'PASS' }),
    { criterion: 'VERIFICATION', state: 'SATISFIED', satisfied: true },
  );
  assert.deepEqual(
    evaluateTaskCompletion({
      completionCriterion: 'VERIFICATION', verificationVerdict: 'INCONCLUSIVE',
    }),
    { criterion: 'VERIFICATION', state: 'UNSATISFIED', satisfied: false },
  );
});

test('EXECUTABLE and EVIDENCE_JUDGMENT are declared but have no implementation', () => {
  for (const criterion of ['EXECUTABLE', 'EVIDENCE_JUDGMENT'] as const) {
    // Every shape a caller could present, including the ones that used to satisfy them.
    for (const facts of [
      { completionCriterion: criterion },
      { completionCriterion: criterion, verifiesTaskId: 'not-a-verifier-criterion' },
      { completionCriterion: criterion, verificationVerdict: 'PASS' as const },
      { completionCriterion: criterion, ownVerdict: 'PASS' as const },
    ]) {
      assert.deepEqual(
        evaluateTaskCompletion(facts),
        { criterion, state: 'UNSATISFIED', satisfied: false },
        `${criterion} must be UNSATISFIED, never satisfied by another criterion's fact`,
      );
      assert.equal(deriveTaskCompletionStatus(facts), null);
    }
  }
});

test('the removed criteria answer rather than throw, and stay out of the default arm', () => {
  // Not an exception: an unimplemented criterion is a state, not an error, and a caller that
  // evaluates one has asked a legitimate question about a legitimate declaration.
  assert.doesNotThrow(() => evaluateTaskCompletion({ completionCriterion: 'EXECUTABLE' }));
  assert.doesNotThrow(() => evaluateTaskCompletion({ completionCriterion: 'EVIDENCE_JUDGMENT' }));
  const source = readFileSync(
    path.resolve(__dirname, '../../src/tasks/task-completion-criterion.ts'), 'utf8',
  );
  const evaluator = source.slice(source.indexOf('export function evaluateTaskCompletion'));
  assert.match(evaluator, /case 'EXECUTABLE':/u, 'EXECUTABLE keeps its own explicit arm');
  assert.match(evaluator, /case 'EVIDENCE_JUDGMENT':/u);
  assert.doesNotMatch(evaluator.slice(0, evaluator.indexOf('\n}')), /default:/u,
    'no default arm: a fourth criterion must not inherit an answer');
  // The three labels are still declarable. Deleting one would have been the other removal.
  assert.deepEqual(
    [...TASK_COMPLETION_CRITERIA],
    ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT'],
  );
});

test('a satisfied VERIFICATION criterion evaluates task status to DONE', () => {
  assert.equal(deriveTaskCompletionStatus({
    completionCriterion: 'VERIFICATION',
    verificationVerdict: 'PASS',
  }), 'DONE');
});

test('a verifier carrier concludes on every non-null verdict while its subject still requires PASS', () => {
  for (const ownVerdict of ['PASS', 'FAIL', 'INCONCLUSIVE'] as const) {
    assert.equal(deriveTaskCompletionStatus({
      completionCriterion: 'VERIFICATION',
      verifiesTaskId: 'subject',
      ownVerdict,
    }), 'DONE');
  }
  assert.equal(deriveTaskCompletionStatus({
    completionCriterion: 'VERIFICATION',
    verificationVerdict: 'FAIL',
  }), null);
  assert.equal(deriveTaskCompletionStatus({
    completionCriterion: 'VERIFICATION',
    verificationVerdict: 'INCONCLUSIVE',
  }), null);
});

test('the verifier carrier projector derives DONE and removes it when its verdict is revoked', () => {
  assert.equal(projectVerifierCarrierStatus({
    ...ACTIVE_VERIFIER_RETIREMENT,
    verifiesTaskId: 'subject',
    currentStatus: 'OPEN',
    currentVerdict: null,
    nextVerdict: 'FAIL',
    roleAttached: false,
    verdictChanged: true,
  }), 'DONE');
  assert.equal(projectVerifierCarrierStatus({
    ...ACTIVE_VERIFIER_RETIREMENT,
    verifiesTaskId: 'subject',
    currentStatus: 'DONE',
    currentVerdict: 'FAIL',
    nextVerdict: null,
    roleAttached: false,
    verdictChanged: true,
  }), 'OPEN');
  assert.equal(projectVerifierCarrierStatus({
    ...ACTIVE_VERIFIER_RETIREMENT,
    verifiesTaskId: 'subject',
    currentStatus: 'DONE',
    currentVerdict: 'PASS',
    nextVerdict: null,
    roleAttached: false,
    verdictChanged: true,
    requestedStatus: 'CANCELLED',
  }), 'CANCELLED');
  assert.equal(projectVerifierCarrierStatus({
    ...ACTIVE_VERIFIER_RETIREMENT,
    verifiesTaskId: 'subject',
    currentStatus: 'DONE',
    currentVerdict: 'PASS',
    nextVerdict: null,
    roleAttached: false,
    verdictChanged: false,
  }), null);
  assert.equal(projectVerifierCarrierStatus({
    ...ACTIVE_VERIFIER_RETIREMENT,
    verifiesTaskId: 'subject',
    currentStatus: 'DONE',
    currentVerdict: 'PASS',
    nextVerdict: 'PASS',
    roleAttached: false,
    verdictChanged: false,
    requestedStatus: 'CANCELLED',
  }), 'DONE');
  assert.equal(projectVerifierCarrierStatus({
    ...ACTIVE_VERIFIER_RETIREMENT,
    verifiesTaskId: 'subject',
    currentStatus: 'DONE',
    currentVerdict: null,
    nextVerdict: null,
    roleAttached: true,
    verdictChanged: false,
  }), 'OPEN', 'an ordinary DONE fact cannot survive a change into the verifier role');

  assert.equal(projectVerifierCarrierStatus({
    verifiesTaskId: 'subject',
    currentStatus: 'FAILED',
    currentVerdict: 'FAIL',
    nextVerdict: 'FAIL',
    currentTerminalReason: 'ABANDONED',
    nextTerminalReason: null,
    currentSupersededByTaskId: null,
    nextSupersededByTaskId: null,
    roleAttached: false,
    verdictChanged: false,
  }), 'DONE', 'clearing retirement reactivates the verdict-owned carrier lifecycle');
});

test('an unsatisfied criterion cannot manufacture an optimistic status', () => {
  assert.equal(deriveTaskCompletionStatus({
    completionCriterion: 'VERIFICATION',
    verificationVerdict: 'FAIL',
  }), null);
});

test('every direct-DONE refusal points at the declared criterion remedy', () => {
  assert.equal(taskCompletionRequiredAction('EXECUTABLE').requiredAction,
    'AWAIT_EXECUTABLE_IMPLEMENTATION');
  assert.match(taskCompletionRequiredAction('EXECUTABLE').instruction,
    /implementation was removed[\s\S]*declaration is intact/u);
  assert.match(
    taskCompletionRequiredAction('VERIFICATION').instruction,
    /independent verification task with verdict PASS/,
  );
  // The two remedies with no implementation behind them say so, and say what IS still possible,
  // rather than naming a door (`task_judge`, the exit-code evaluator) that no longer exists.
  for (const criterion of ['EXECUTABLE', 'EVIDENCE_JUDGMENT'] as const) {
    const remedy = taskCompletionRequiredAction(criterion);
    assert.match(remedy.requiredAction, /^AWAIT_/u);
    assert.match(remedy.instruction, /implementation/u);
    assert.match(remedy.instruction, /VERIFICATION/u);
    assert.doesNotMatch(remedy.instruction, /task_judge/u);
  }
});

test('the three peer declarations require only their own evidence shape', () => {
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'npm test',
    acceptanceExpectedExitCode: 0,
  }), null);
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
  }), null);
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'MANUAL',
    verifiesTaskId: 'subject',
  }), null);
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'EVIDENCE_JUDGMENT',
  }), null);

  assert.match(taskCompletionDeclarationError({ completionCriterion: 'EXECUTABLE' })!, /requires/);
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION', completionPolicy: 'MANUAL',
  })!, /VERIFICATION_PASSED/);
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'EVIDENCE_JUDGMENT', verifiesTaskId: 'subject',
  })!, /must use VERIFICATION/);
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'EVIDENCE_JUDGMENT',
    acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  })!, /cannot also/);
});

test('legacy create declarations retain their explicit meaning without a fallback chain', () => {
  assert.equal(resolveTaskCompletionCriterion({
    acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  }), 'EXECUTABLE');
  assert.equal(resolveTaskCompletionCriterion({
    completionPolicy: 'VERIFICATION_PASSED',
  }), 'VERIFICATION');
  assert.equal(resolveTaskCompletionCriterion({ verifiesTaskId: 'subject' }), 'VERIFICATION');
});
