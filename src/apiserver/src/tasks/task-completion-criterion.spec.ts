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

// `resolveTaskCompletionCriterion` is the SERVICE's compatibility rule, and it still answers
// EVIDENCE_JUDGMENT for a declaration that states nothing at all. That is not the door's rule: both
// write boundaries run `requireExplicitCompletionCriterion` first and refuse an untranslatable
// omission before it gets here (`task-completion-criterion.pg.spec.ts`). The evaluator below no
// longer takes a null criterion at all — it used to substitute EVIDENCE_JUDGMENT and thereby answer
// about a criterion no task had declared.
test('an undeclared service-level declaration still resolves to the ordinary criterion', () => {
  assert.equal(resolveTaskCompletionCriterion({}), 'EVIDENCE_JUDGMENT');
  assert.deepEqual(evaluateTaskCompletion({ completionCriterion: 'EVIDENCE_JUDGMENT' }), {
    criterion: 'EVIDENCE_JUDGMENT', state: 'UNSATISFIED', satisfied: false,
  });
});

// EXECUTABLE and VERIFICATION have implementations; EVIDENCE_JUDGMENT is declared-but-
// unimplemented since 2026-09-02: legal to declare, impossible to satisfy, and — the point of
// naming it here — evaluated by its OWN `case`, not by falling through to somebody else's answer
// or to a default. `evaluateTaskCompletion`'s switch has no default arm, so the exhaustiveness
// check is what makes that a compile-time fact rather than a comment.
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

/**
 * The whole EXECUTABLE criterion, as a table.
 *
 * Restored on 2026-09-03 at the account owner's direction, and deliberately this small: two
 * numbers in, one of three states out, nothing kept. The four rows the account owner's task
 * enumerated are the first four here — matching, mismatching, no exit code, no expectation — and
 * the rest are the shapes that must NOT change the answer.
 *
 * ACTIONABLE earns its own state rather than collapsing into UNSATISFIED: "the command disagreed"
 * and "there was nothing to compare" reach different places in the runner callback, and folding
 * them together is what would turn a missing field into a task failure.
 */
test('EXECUTABLE is one exit-code comparison, and answers all four input shapes', () => {
  const rows: Array<{
    label: string;
    facts: Parameters<typeof evaluateTaskCompletion>[0];
    state: 'SATISFIED' | 'UNSATISFIED' | 'ACTIONABLE';
    status: 'DONE' | null;
  }> = [
    {
      label: 'the exit code matches the expectation',
      facts: { completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 0, executableExitCode: 0 },
      state: 'SATISFIED', status: 'DONE',
    },
    {
      label: 'the exit code does not match',
      facts: { completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 0, executableExitCode: 7 },
      state: 'UNSATISFIED', status: null,
    },
    {
      label: 'no exit code was reported',
      facts: { completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 0, executableExitCode: null },
      state: 'ACTIONABLE', status: null,
    },
    {
      label: 'no expectation is declared',
      facts: { completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: null, executableExitCode: 0 },
      state: 'ACTIONABLE', status: null,
    },
    {
      label: 'neither side is present',
      facts: { completionCriterion: 'EXECUTABLE' },
      state: 'ACTIONABLE', status: null,
    },
    {
      // -1 is what the runner reports for a start failure, a timeout kill or a signal. Since 0227
      // removed the typed termination nothing can tell those apart from a command that ran and
      // disagreed, so -1 is compared like any other integer. The account owner accepted exactly
      // this loss: "超时与真实失败不再可区分".
      label: 'the runner reported -1 for a kill, a signal or a start failure',
      facts: { completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 0, executableExitCode: -1 },
      state: 'UNSATISFIED', status: null,
    },
    {
      label: 'a negative expectation is honoured rather than treated as a sentinel',
      facts: { completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: -1, executableExitCode: -1 },
      state: 'SATISFIED', status: 'DONE',
    },
    {
      label: 'a nonzero expectation is the declaration, not a synonym for failure',
      facts: { completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 7, executableExitCode: 7 },
      state: 'SATISFIED', status: 'DONE',
    },
    {
      label: "another criterion's satisfied fact cannot stand in for the comparison",
      facts: {
        completionCriterion: 'EXECUTABLE',
        verificationVerdict: 'PASS' as const,
        ownVerdict: 'PASS' as const,
        verifiesTaskId: 'not-a-verifier-criterion',
      },
      state: 'ACTIONABLE', status: null,
    },
  ];
  for (const row of rows) {
    assert.deepEqual(
      evaluateTaskCompletion(row.facts),
      { criterion: 'EXECUTABLE', state: row.state, satisfied: row.state === 'SATISFIED' },
      row.label,
    );
    assert.equal(deriveTaskCompletionStatus(row.facts), row.status, row.label);
  }
});

test('EVIDENCE_JUDGMENT is declared but has no implementation', () => {
  // Every shape a caller could present, including the ones that used to satisfy it and the two
  // executable facts that satisfy its peer — a criterion may never borrow another's answer.
  for (const facts of [
    { completionCriterion: 'EVIDENCE_JUDGMENT' as const },
    { completionCriterion: 'EVIDENCE_JUDGMENT' as const, verifiesTaskId: 'not-a-verifier-criterion' },
    { completionCriterion: 'EVIDENCE_JUDGMENT' as const, verificationVerdict: 'PASS' as const },
    { completionCriterion: 'EVIDENCE_JUDGMENT' as const, ownVerdict: 'PASS' as const },
    {
      completionCriterion: 'EVIDENCE_JUDGMENT' as const,
      acceptanceExpectedExitCode: 0,
      executableExitCode: 0,
    },
  ]) {
    assert.deepEqual(
      evaluateTaskCompletion(facts),
      { criterion: 'EVIDENCE_JUDGMENT', state: 'UNSATISFIED', satisfied: false },
      "EVIDENCE_JUDGMENT must be UNSATISFIED, never satisfied by another criterion's fact",
    );
    assert.equal(deriveTaskCompletionStatus(facts), null);
  }
});

test('every criterion answers rather than throws, and stays out of the default arm', () => {
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
  // EXECUTABLE has an implementation again, so its remedy names an action the caller can take
  // rather than a rebuild it can only wait for.
  assert.equal(taskCompletionRequiredAction('EXECUTABLE').requiredAction,
    'RUN_ACCEPTANCE_COMMAND');
  const executable = taskCompletionRequiredAction('EXECUTABLE').instruction;
  assert.match(executable, /acceptanceCommand[\s\S]*acceptanceExpectedExitCode/u);
  assert.match(executable, /DONE when they are equal, FAILED when they are not/u);
  // And it is honest about the cost the owner accepted: the run is not recorded anywhere.
  assert.match(executable, /nothing about the run is recorded/u);
  assert.doesNotMatch(executable, /AWAIT|rebuil|removed/u,
    'the remedy must not still describe the criterion as unimplemented');
  assert.match(
    taskCompletionRequiredAction('VERIFICATION').instruction,
    /independent verification task with verdict PASS/,
  );
  // The one remedy with no implementation behind it says so, and says what IS still possible,
  // rather than naming a door (`task_judge`, the removed decision) that no longer exists.
  const evidence = taskCompletionRequiredAction('EVIDENCE_JUDGMENT');
  assert.match(evidence.requiredAction, /^AWAIT_/u);
  assert.match(evidence.instruction, /implementation/u);
  assert.match(evidence.instruction, /VERIFICATION/u);
  assert.doesNotMatch(evidence.instruction, /task_judge/u);
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
