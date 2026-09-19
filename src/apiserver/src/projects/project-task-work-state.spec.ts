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

/** The READY arm's text between `WHEN` and `THEN 'READY'`. */
function readyBranch(sql: string): string {
  const end = sql.indexOf("THEN 'READY'");
  assert.notEqual(end, -1, 'the READY lane must still exist');
  return sql.slice(sql.lastIndexOf('WHEN ', end), end);
}

test('the READY lane can be narrowed by a caller that already owns the candidate set', () => {
  // Nothing handed in: the lane is the shared execute predicate and nothing else, which is what
  // the project list rollup, the task cards and the graph read.
  const plain = readyBranch(projectTaskWorkStateSql('t'));
  assert.match(plain, /t\.status <> 'DONE'::task_status/u);
  assert.doesNotMatch(plain, /IN \(SELECT/u);

  // Handed a set, it is asked FIRST. The whole point is that the rows it leaves out never reach
  // the dependency walk, so an order the executor could reverse would buy nothing.
  const narrowed = readyBranch(projectTaskWorkStateSql('t', {
    readyCandidates: `t."id" IN (SELECT "id" FROM candidates)`,
  }));
  const set = narrowed.indexOf('IN (SELECT "id" FROM candidates)');
  const walk = narrowed.indexOf('FROM task_dependency dep');
  assert.notEqual(set, -1, 'the candidate set must be spliced into the arm');
  assert.notEqual(walk, -1, 'the arm is still the execute predicate, not a replacement for it');
  assert.ok(set < walk, 'the set must be asked before the graph walk it is there to avoid');
  // The predicate itself is untouched — narrowing is not a second spelling of readiness.
  assert.match(narrowed, /dispatch_hold = false/u);
  assert.match(narrowed, /completion_policy = 'VERIFICATION_PASSED'/u);

  // The lane is per alias, like every other one here.
  assert.match(
    projectTaskWorkStateSql('verifier_task', { readyCandidates: 'verifier_task."id" IN (SELECT 1)' }),
    /WHEN verifier_task\."status" = 'OPEN'::"task_status"\s+AND \(verifier_task\."id" IN \(SELECT 1\)\)/u,
  );
});
