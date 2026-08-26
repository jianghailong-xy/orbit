import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateTaskCompletion,
  resolveTaskCompletionCriterion,
  taskCompletionDeclarationError,
} from './task-completion-criterion';

test('undeclared completion is the ordinary HUMAN_SIGNOFF criterion', () => {
  assert.equal(resolveTaskCompletionCriterion({}), 'HUMAN_SIGNOFF');
  assert.deepEqual(evaluateTaskCompletion({ completionCriterion: null }), {
    criterion: 'HUMAN_SIGNOFF', state: 'UNSATISFIED', satisfied: false,
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
      'HUMAN_SIGNOFF',
      { completionCriterion: 'HUMAN_SIGNOFF' as const, humanSignoff: true },
      { completionCriterion: 'HUMAN_SIGNOFF' as const, humanSignoff: false },
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
    completionCriterion: 'HUMAN_SIGNOFF',
  }), null);

  assert.match(taskCompletionDeclarationError({ completionCriterion: 'EXECUTABLE' })!, /requires/);
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION', completionPolicy: 'MANUAL',
  })!, /VERIFICATION_PASSED/);
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'HUMAN_SIGNOFF',
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
});
