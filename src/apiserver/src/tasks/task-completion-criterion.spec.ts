import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  TASK_COMPLETION_CRITERIA,
  criterionNeedsProjectRefusal,
  deriveTaskCompletionStatus,
  evaluateTaskCompletion,
  projectVerifierCarrierStatus,
  resolveTaskCompletionCriterion,
  taskCompletionDeclarationError,
  taskCompletionRequiredAction,
  verificationSubjectNeedsProjectRefusal,
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

// All three criteria have an implementation again, and the point of naming each here is that each
// is evaluated by its OWN `case` — never by falling through to somebody else's answer or to a
// default. `evaluateTaskCompletion`'s switch has no default arm, so the exhaustiveness check is
// what makes that a compile-time fact rather than a comment.
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

test('EVIDENCE_JUDGMENT is one CONFIRM of the evidence revision that is current', () => {
  // Every shape that is NOT that, including the two executable facts that satisfy its peer: a
  // criterion may never borrow another's answer, and the pair of revisions is the only thing here
  // that is its own.
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
    // Evidence submitted and nobody has answered it. A claim is not a judgment, which is the whole
    // distinction this criterion is made of.
    { completionCriterion: 'EVIDENCE_JUDGMENT' as const, latestEvidenceRevision: 3n },
    // An answer to a version a later submission replaced.
    {
      completionCriterion: 'EVIDENCE_JUDGMENT' as const,
      latestEvidenceRevision: 3n,
      confirmedEvidenceRevision: 2n,
    },
    // And a confirmation with nothing to be a confirmation OF.
    { completionCriterion: 'EVIDENCE_JUDGMENT' as const, confirmedEvidenceRevision: 3n },
  ]) {
    assert.deepEqual(
      evaluateTaskCompletion(facts),
      { criterion: 'EVIDENCE_JUDGMENT', state: 'UNSATISFIED', satisfied: false },
      "EVIDENCE_JUDGMENT must be UNSATISFIED, never satisfied by another criterion's fact",
    );
    assert.equal(deriveTaskCompletionStatus(facts), null);
  }

  // The one shape that satisfies it. No ACTIONABLE arm: an unjudged claim is work that is not
  // settled, not a comparison that could not be made.
  const confirmed = {
    completionCriterion: 'EVIDENCE_JUDGMENT' as const,
    latestEvidenceRevision: 3n,
    confirmedEvidenceRevision: 3n,
  };
  assert.deepEqual(evaluateTaskCompletion(confirmed),
    { criterion: 'EVIDENCE_JUDGMENT', state: 'SATISFIED', satisfied: true });
  assert.equal(deriveTaskCompletionStatus(confirmed), 'DONE');
});

test('every criterion answers rather than throws, and stays out of the default arm', () => {
  // Not an exception: an unimplemented criterion is a state, not an error, and a caller that
  // evaluates one has asked a legitimate question about a legitimate declaration.
  assert.doesNotThrow(() => evaluateTaskCompletion({ completionCriterion: 'EXECUTABLE' }));
  assert.doesNotThrow(() => evaluateTaskCompletion({ completionCriterion: 'EVIDENCE_JUDGMENT' }));
  assert.doesNotThrow(() => evaluateTaskCompletion({ completionCriterion: 'OWNER_CONFIRMED' }));
  const source = readFileSync(
    path.resolve(__dirname, '../../src/tasks/task-completion-criterion.ts'), 'utf8',
  );
  const evaluator = source.slice(source.indexOf('export function evaluateTaskCompletion'));
  const body = evaluator.slice(0, evaluator.indexOf('\n}'));
  assert.match(body, /case 'EXECUTABLE':/u, 'EXECUTABLE keeps its own explicit arm');
  assert.match(body, /case 'EVIDENCE_JUDGMENT':/u);
  assert.match(body, /case 'OWNER_CONFIRMED':/u,
    'the fourth criterion answers in an arm of its own, not in somebody else\'s');
  assert.doesNotMatch(body, /default:/u,
    'no default arm: a fifth criterion must not inherit an answer');
  // The four labels are declarable. Deleting one would have been a removal.
  assert.deepEqual(
    [...TASK_COMPLETION_CRITERIA],
    ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT', 'OWNER_CONFIRMED'],
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
  // The third remedy names the two acts that settle it — and neither is the removed door
  // (`task_judge`) nor a rebuild the caller can only wait for.
  const evidence = taskCompletionRequiredAction('EVIDENCE_JUDGMENT');
  assert.equal(evidence.requiredAction, 'SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION');
  assert.match(evidence.instruction, /submit[\s\S]*completion evidence/u);
  assert.match(evidence.instruction, /did not do the work/u);
  assert.match(evidence.instruction, /CONFIRM/u);
  assert.doesNotMatch(evidence.instruction, /task_judge/u);
  assert.doesNotMatch(evidence.instruction, /AWAIT|rebuil|removed/u,
    'the remedy must not still describe the criterion as unimplemented');
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
    completionCriterion: 'EVIDENCE_JUDGMENT', verifiesTaskId: 'subject',
  })!, /must use VERIFICATION/);
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'EVIDENCE_JUDGMENT',
    acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  })!, /cannot also/);
});

/**
 * The two columns answer different questions, and on a subject they used to be fused.
 *
 * `completionCriterion` says WHO settles this task; `completionPolicy` says whether anything other
 * than this row's own work is involved in getting there. Requiring VERIFICATION_PASSED of every
 * subject read the first as if it were the second, so "do the work, then have another session check
 * it" was a shape nobody could declare — the only VERIFICATION row without a `verifiesTaskId` was
 * one that may never run.
 */
test('VERIFICATION names who settles the task, not that the row has no work of its own', () => {
  // The gate row: no work of its own, settled by a PASS recorded against it.
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION', completionPolicy: 'VERIFICATION_PASSED',
  }), null);
  // The work row, and the capability this split adds: it runs, and an independent verdict rather
  // than its own run is what settles it.
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION', completionPolicy: 'MANUAL',
  }), null, 'a task may both do work and be settled by an independent verdict');
  // The verifier itself, unchanged by any of this.
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION', completionPolicy: 'MANUAL', verifiesTaskId: 'subject',
  }), null);

  // Exactly three shapes, not four. ALL_CHILDREN_DONE says the children finish this row while
  // VERIFICATION says a verdict does, and `recomputeTask` reads the criterion first: the pair would
  // write DONE on the next reconcile with no verdict anywhere. It stays refused.
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION', completionPolicy: 'ALL_CHILDREN_DONE',
  })!, /ALL_CHILDREN_DONE/u);
  // And a verifier still may not carry a roll-up policy.
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
    verifiesTaskId: 'subject',
  })!, /A verification task requires completionPolicy MANUAL/u);
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

// A subject — VERIFICATION with no verifiesTaskId — is settled only by a PASS another task records,
// and outside a project nothing files that task. The three write doors ask this through the service
// (`task-criterion-shape-advice.spec.ts` drives them); the rule and its words are pinned here.
test('a verification subject in no project is refused, and the refusal names both ways out', () => {
  const refusal = verificationSubjectNeedsProjectRefusal({
    completionCriterion: 'VERIFICATION', verifiesTaskId: null, projectId: null,
  });
  assert.ok(refusal, 'a subject nobody can file a verification for must be refused');
  assert.equal(refusal.code, 'VERIFICATION_SUBJECT_REQUIRES_PROJECT');
  assert.equal(refusal.kind, 'REFUSAL');
  assert.equal(refusal.requiredAction, 'FILE_UNDER_A_PROJECT_OR_DECLARE_EXECUTABLE');
  assert.match(refusal.message, /in no project, so there is no coordinator/u,
    'the refusal says why nothing would ever settle it');
  assert.match(refusal.message, /projectId/u, 'one way out is filing the work under a project');
  assert.match(refusal.message, /EXECUTABLE with acceptanceCommand and acceptanceExpectedExitCode/u,
    'the other is a criterion the task settles on its own');
  assert.deepEqual(
    verificationSubjectNeedsProjectRefusal({ completionCriterion: 'VERIFICATION' }), refusal,
    'an omitted projectId and verifiesTaskId are the same facts as null ones',
  );
});

test('a subject in a project, a verifier in none and the other criteria are not refused', () => {
  assert.equal(verificationSubjectNeedsProjectRefusal({
    completionCriterion: 'VERIFICATION', projectId: 'project',
  }), null);
  // A verifier settles on its own verdict, and `fileVerification` files those in no project too.
  assert.equal(verificationSubjectNeedsProjectRefusal({
    completionCriterion: 'VERIFICATION', verifiesTaskId: 'subject', projectId: null,
  }), null);
  assert.equal(verificationSubjectNeedsProjectRefusal({ completionCriterion: 'EXECUTABLE' }), null);
  // EVIDENCE_JUDGMENT keeps its own rule and code, and neither rule answers for the other.
  assert.equal(
    verificationSubjectNeedsProjectRefusal({ completionCriterion: 'EVIDENCE_JUDGMENT' }), null,
  );
  assert.equal(criterionNeedsProjectRefusal({ completionCriterion: 'VERIFICATION' }), null);
});

test('the EVIDENCE_JUDGMENT refusal no longer sends a project-less task to VERIFICATION', () => {
  const refusal = criterionNeedsProjectRefusal({ completionCriterion: 'EVIDENCE_JUDGMENT' });
  assert.ok(refusal);
  assert.equal(refusal.code, 'EVIDENCE_JUDGMENT_REQUIRES_PROJECT');
  assert.match(refusal.message, /projectId/u);
  assert.match(refusal.message, /EXECUTABLE with acceptanceCommand and acceptanceExpectedExitCode/u);
  assert.doesNotMatch(refusal.message, /VERIFICATION/u,
    'that way out would only lead to VERIFICATION_SUBJECT_REQUIRES_PROJECT');
});

/**
 * The fourth criterion. What satisfies it is one fact — the account owner's newest decision about
 * the task is a CONFIRM — and every other shape, including the facts that satisfy its three peers,
 * is UNSATISFIED. Who may record that decision is its door's question
 * (`task-owner-confirmation.spec.ts`), not this evaluator's.
 */
test('OWNER_CONFIRMED is the owner\'s newest decision being a CONFIRM, and nothing else', () => {
  for (const facts of [
    { completionCriterion: 'OWNER_CONFIRMED' as const },
    { completionCriterion: 'OWNER_CONFIRMED' as const, ownerDecision: null },
    // Sent back: the owner's newest word says the task is still open.
    { completionCriterion: 'OWNER_CONFIRMED' as const, ownerDecision: 'SEND_BACK' as const },
    // A run that reports success is not its owner confirming it.
    { completionCriterion: 'OWNER_CONFIRMED' as const, acceptanceExpectedExitCode: 0, executableExitCode: 0 },
    { completionCriterion: 'OWNER_CONFIRMED' as const, verificationVerdict: 'PASS' as const },
    { completionCriterion: 'OWNER_CONFIRMED' as const, ownVerdict: 'PASS' as const, verifiesTaskId: 'x' },
    {
      completionCriterion: 'OWNER_CONFIRMED' as const,
      latestEvidenceRevision: 2n,
      confirmedEvidenceRevision: 2n,
    },
  ]) {
    assert.deepEqual(
      evaluateTaskCompletion(facts),
      { criterion: 'OWNER_CONFIRMED', state: 'UNSATISFIED', satisfied: false },
      `OWNER_CONFIRMED must not be satisfied by ${JSON.stringify(facts, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`,
    );
    assert.equal(deriveTaskCompletionStatus(facts), null);
  }

  const confirmed = { completionCriterion: 'OWNER_CONFIRMED' as const, ownerDecision: 'CONFIRM' as const };
  assert.deepEqual(evaluateTaskCompletion(confirmed),
    { criterion: 'OWNER_CONFIRMED', state: 'SATISFIED', satisfied: true });
  assert.equal(deriveTaskCompletionStatus(confirmed), 'DONE');

  // And its fact settles no other criterion: an owner's CONFIRM is not an exit code, a verdict or a
  // judgment of evidence.
  for (const completionCriterion of ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT'] as const) {
    assert.equal(
      evaluateTaskCompletion({ completionCriterion, ownerDecision: 'CONFIRM' }).satisfied,
      false,
      `${completionCriterion} must not borrow the owner's confirmation`,
    );
  }
});

test('OWNER_CONFIRMED is declared with MANUAL and nothing else, in a project or in none', () => {
  assert.equal(taskCompletionDeclarationError({ completionCriterion: 'OWNER_CONFIRMED' }), null);
  assert.equal(taskCompletionDeclarationError({
    completionCriterion: 'OWNER_CONFIRMED', completionPolicy: 'MANUAL',
  }), null);
  assert.equal(resolveTaskCompletionCriterion({ completionCriterion: 'OWNER_CONFIRMED' }), 'OWNER_CONFIRMED');
  assert.notEqual(resolveTaskCompletionCriterion({}), 'OWNER_CONFIRMED',
    'omission never selects it: the owner is asked only by a task that declared it');

  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'OWNER_CONFIRMED', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
  })!, /OWNER_CONFIRMED cannot also declare executable acceptance/u);
  for (const completionPolicy of ['ALL_CHILDREN_DONE', 'VERIFICATION_PASSED'] as const) {
    assert.match(taskCompletionDeclarationError({
      completionCriterion: 'OWNER_CONFIRMED', completionPolicy,
    })!, /OWNER_CONFIRMED requires completionPolicy MANUAL/u, completionPolicy);
  }
  assert.match(taskCompletionDeclarationError({
    completionCriterion: 'OWNER_CONFIRMED', verifiesTaskId: 'subject',
  })!, /must use VERIFICATION/u);

  // Neither refusal about work in no project applies: the owner can confirm a task wherever it is
  // filed, so there is no stranded state to refuse.
  for (const projectId of [null, undefined, 'project']) {
    assert.equal(criterionNeedsProjectRefusal({ completionCriterion: 'OWNER_CONFIRMED', projectId }), null);
    assert.equal(
      verificationSubjectNeedsProjectRefusal({ completionCriterion: 'OWNER_CONFIRMED', projectId }),
      null,
    );
  }
});

test('a direct DONE on an OWNER_CONFIRMED task is told the owner confirms it in the app', () => {
  const remedy = taskCompletionRequiredAction('OWNER_CONFIRMED');
  assert.equal(remedy.requiredAction, 'HAVE_THE_ACCOUNT_OWNER_CONFIRM_IN_THE_APP');
  assert.match(remedy.instruction, /only the account owner can settle this task/u);
  assert.match(remedy.instruction, /Confirm done/u, 'names the press that settles it');
  assert.match(remedy.instruction, /detail panel when no run is waiting/u,
    'and where it is pressed for a task no run is waiting on');
  assert.match(remedy.instruction, /No agent session can record it, a coordinator included/u);
  assert.match(remedy.instruction, /Send back/u);
  assert.doesNotMatch(remedy.instruction, /rebuil|removed|not implemented/u);
  // Its own remedy, not a peer's.
  for (const peer of ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT'] as const) {
    assert.notEqual(taskCompletionRequiredAction(peer).requiredAction, remedy.requiredAction, peer);
  }
});
