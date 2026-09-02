import assert from 'node:assert/strict';
import test from 'node:test';
import {
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

test('each completion criterion evaluates both satisfied and unsatisfied facts', () => {
  const cases = [
    [
      'EXECUTABLE',
      { completionCriterion: 'EXECUTABLE' as const, acceptanceExpectedExitCode: 0, executableExitCode: 0 },
      { completionCriterion: 'EXECUTABLE' as const, acceptanceExpectedExitCode: 0, executableExitCode: 7 },
    ],
    [
      'VERIFICATION',
      { completionCriterion: 'VERIFICATION' as const, verificationVerdict: 'PASS' as const },
      { completionCriterion: 'VERIFICATION' as const, verificationVerdict: 'INCONCLUSIVE' as const },
    ],
    [
      'EVIDENCE_JUDGMENT',
      { completionCriterion: 'EVIDENCE_JUDGMENT' as const, evidenceJudgment: true },
      { completionCriterion: 'EVIDENCE_JUDGMENT' as const, evidenceJudgment: false },
    ],
  ] as const;

  for (const [criterion, satisfied, unsatisfied] of cases) {
    assert.deepEqual(evaluateTaskCompletion(satisfied), {
      criterion, state: 'SATISFIED', satisfied: true,
    });
    assert.deepEqual(evaluateTaskCompletion(unsatisfied), {
      criterion, state: 'UNSATISFIED', satisfied: false,
    });
  }
});

test('a satisfied EXECUTABLE criterion evaluates task status to DONE', () => {
  assert.equal(deriveTaskCompletionStatus({
    completionCriterion: 'EXECUTABLE',
    acceptanceExpectedExitCode: 7,
    executableExitCode: 7,
  }), 'DONE');
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

test('a satisfied EVIDENCE_JUDGMENT criterion evaluates task status to DONE', () => {
  assert.equal(deriveTaskCompletionStatus({
    completionCriterion: 'EVIDENCE_JUDGMENT',
    evidenceJudgment: true,
  }), 'DONE');
});

test('an unsatisfied criterion cannot manufacture an optimistic status', () => {
  assert.equal(deriveTaskCompletionStatus({
    completionCriterion: 'EVIDENCE_JUDGMENT',
    evidenceJudgment: false,
  }), null);
});

test('every direct-DONE refusal points at the declared criterion remedy', () => {
  assert.deepEqual(taskCompletionRequiredAction('EXECUTABLE'), {
    requiredAction: 'RUN_EXECUTABLE_CRITERION',
    instruction:
      'finish the task run and let Orbit run its declared acceptanceCommand; the recorded ' +
      'exit code must equal acceptanceExpectedExitCode',
  });
  assert.match(
    taskCompletionRequiredAction('VERIFICATION').instruction,
    /independent verification task with verdict PASS/,
  );
  assert.match(
    taskCompletionRequiredAction('EVIDENCE_JUDGMENT').instruction,
    /current EVIDENCE_JUDGMENT request[\s\S]*requestId and evidenceDigest/,
  );
  // The remedy names a door anybody credentialed can reach, not a person to go and find.
  assert.equal(taskCompletionRequiredAction('EVIDENCE_JUDGMENT').requiredAction,
    'DECIDE_THE_OPEN_EVIDENCE_JUDGMENT');
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
