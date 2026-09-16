import assert from 'node:assert/strict';
import test from 'node:test';

import { projectTaskWorkStateSql, verificationSubjectSql } from './project-task-work-state';

/**
 * Which rows the project lanes call AWAITING_VERIFICATION, asked of the SQL they are built from.
 *
 * The behaviour against a real server is `project-work-overview-readiness.pg.spec.ts`'s; what is
 * held here is the predicate, because this expression is spliced raw into panorama, the project
 * list roll-up, task cards and the graph, and a clause added to it is invisible to `tsc`.
 *
 * The lane exists for a row that CANNOT run: nothing but a verdict recorded elsewhere will ever
 * move it, so the honest thing to show is that it is waiting for one. A task whose policy is MANUAL
 * is not that row — it has its own work, has possibly never been run, and calling it "awaiting
 * verification" would report a wait on something nobody has been asked for yet.
 */

/** The branch text between `WHEN` and `THEN 'AWAITING_VERIFICATION'`, for the default alias. */
function awaitingVerificationBranch(): string {
  const sql = projectTaskWorkStateSql('t');
  const end = sql.indexOf("THEN 'AWAITING_VERIFICATION'");
  assert.notEqual(end, -1, 'the AWAITING_VERIFICATION lane must still exist');
  const start = sql.lastIndexOf('WHEN ', end);
  return sql.slice(start, end);
}

test('a verification subject is the gate row: the policy, not the criterion, decides', () => {
  const subject = verificationSubjectSql('t');
  assert.match(subject, /t\."completion_policy" = 'VERIFICATION_PASSED'::"task_completion_policy"/u);
  assert.match(subject, /t\."verifies_task_id" IS NULL/u);
  assert.doesNotMatch(subject, /completion_criterion/u,
    'VERIFICATION says who settles the task; it does not say the row has no work of its own');
  // The alias is the caller's: the task-detail read passes the verifier's own alias through here.
  assert.match(verificationSubjectSql('verifier_task'),
    /verifier_task\."completion_policy" = 'VERIFICATION_PASSED'/u);
});

test('AWAITING_VERIFICATION cannot land on a work row that has never run', () => {
  const branch = awaitingVerificationBranch();
  // The lane is entered only through the subject predicate, so a MANUAL row — whatever criterion it
  // declares, and whether or not it has ever been dispatched — cannot reach it.
  assert.ok(branch.includes(verificationSubjectSql('t')),
    'the lane must be guarded by the gate-row predicate itself, not by a second spelling of it');
  assert.doesNotMatch(branch, /completion_criterion/u);
  // And the whole classification asks about the criterion nowhere: every lane below reads status,
  // the live-work claim and the shared Ready predicate.
  assert.doesNotMatch(projectTaskWorkStateSql('t'), /completion_criterion/u,
    'no work lane may be decided by the criterion column any more');
});
