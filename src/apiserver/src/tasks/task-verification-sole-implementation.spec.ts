import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * After 2026-09-02, VERIFICATION is the one criterion with an implementation.
 *
 * That sentence is the load-bearing claim of the whole removal, and it has two failure modes. One
 * is that VERIFICATION was damaged on the way past — its epoch read, its dependency predicate and
 * its SQL fragments all consulted the judgment request, and stripping that out could easily have
 * taken the surviving lane with it. The other is that a substitute crept in for one of the two
 * criteria that were supposed to be left empty.
 *
 * `task-status-derived-end-to-end.pg.spec.ts` runs the positive path on a real server. This file
 * holds the shape: what the surviving predicate reads, and what nothing reads any more.
 */

const API = path.resolve(__dirname, '../..');

function read(relative: string): string {
  return readFileSync(path.join(API, relative), 'utf8');
}

const DEPENDENCY = read('src/tasks/verification-dependency.ts');
const EPOCH_READ = read('src/tasks/verification-epoch-read.ts');
const WORK_STATE = read('src/projects/project-task-work-state.ts');

test('the verification epoch is decided from the check itself, with no request left in it', () => {
  for (const [name, source] of [['verification-dependency.ts', DEPENDENCY],
    ['verification-epoch-read.ts', EPOCH_READ],
    ['project-task-work-state.ts', WORK_STATE]] as const) {
    assert.doesNotMatch(source, /task_judgment_request/u, `${name} still joins the request table`);
    assert.doesNotMatch(source, /taskJudgmentRequest/u, `${name} still reads the request model`);
    assert.doesNotMatch(source, /judgmentStatus|judgmentDecision|judgmentCreatedAt/u,
      `${name} still projects a judgment onto an epoch`);
  }

  // What decides an epoch now: the check's own status, verdict, revision, settled run and applied
  // ledger action. Every one of those predates the judgment machinery.
  const gate = DEPENDENCY.slice(DEPENDENCY.indexOf('export function verificationEpochGate'));
  const body = gate.slice(0, gate.indexOf('\n}\n'));
  for (const clause of ['VERIFICATION_IN_FLIGHT', 'VERDICT_ABSENT', 'VERIFICATION_FAILED',
    'VERIFICATION_INCONCLUSIVE', 'VERDICT_UNREVISIONED', 'RUN_NOT_SETTLED',
    'VERDICT_NOT_APPLIED', 'SUBJECT_NOT_DONE']) {
    assert.ok(body.includes(clause), `the epoch gate lost its ${clause} clause`);
  }
  // Chronology is the check's own creation time again, not a request's.
  const newest = DEPENDENCY.slice(DEPENDENCY.indexOf('export function newestLiveCheck'));
  assert.match(newest.slice(0, newest.indexOf('\n}\n')), /const aTime = a\.createdAt;/u);
});

test('the SQL fragments select and pass a check on its own facts', () => {
  const passed = DEPENDENCY.slice(DEPENDENCY.indexOf('export function verificationCheckPassedSql'));
  const fragment = passed.slice(0, passed.indexOf('\n}\n'));
  assert.doesNotMatch(fragment, /passed_request|passed_legacy_request/u);
  for (const clause of ['"status" = \'DONE\'', '"verdict" = \'PASS\'', '"verdict_revision" > 0',
    'passed_run', 'passed_action']) {
    assert.ok(fragment.includes(clause), `the PASS predicate lost ${clause}`);
  }

  const newest = DEPENDENCY.slice(DEPENDENCY.indexOf('export function latestLiveVerificationCheckIdSql'));
  const selector = newest.slice(0, newest.indexOf('\n}\n'));
  assert.doesNotMatch(selector, /newest_request|LEFT JOIN/u);
  assert.match(selector, /ORDER BY newest_check\."created_at" DESC, newest_check\."id" DESC/u);
});

test('the two removed criteria have no substitute anywhere in the completion path', () => {
  const criterion = read('src/tasks/task-completion-criterion.ts');
  const evaluator = criterion.slice(criterion.indexOf('export function evaluateTaskCompletion'));
  const body = evaluator.slice(0, evaluator.indexOf('\n}\n'));
  // Exactly one criterion reads a fact; the other two read nothing.
  const factReads = [...body.matchAll(/facts\.([a-zA-Z]+)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(factReads)].sort(),
    ['completionCriterion', 'ownVerdict', 'verificationVerdict', 'verifiesTaskId']);

  // And the facts type carries nothing else to read: a field left behind is the seam a substitute
  // would grow back through.
  const facts = criterion.slice(criterion.indexOf('export interface TaskCompletionFacts'));
  const shape = facts.slice(0, facts.indexOf('\n}\n'));
  const fields = [...shape.matchAll(/^\s{2}([a-zA-Z]+)\?:/gmu)].map((match) => match[1]);
  assert.deepEqual(fields.sort(),
    ['completionCriterion', 'ownVerdict', 'verificationVerdict', 'verifiesTaskId']);

  // The aggregation half, which is what actually settles a VERIFICATION_PASSED subject, is
  // untouched and still keyed on a verifier's verdict.
  const aggregation = read('src/projects/task-aggregation.ts');
  assert.match(aggregation, /VERIFICATION_PASSED/u);
  assert.doesNotMatch(aggregation, /judgment/iu);
});

test('the tasks service completes a subject through the verdict, and through nothing else', () => {
  const service = read('src/tasks/tasks.service.ts');
  assert.doesNotMatch(service, /taskJudgmentRequest/u);
  assert.doesNotMatch(service, /async judge\(/u);
  // The verdict path itself: still locks both rows, still refuses a self-verification, still
  // recomputes the aggregation that derives the subject's status.
  assert.match(service, /consumesVerificationRequest = dto\.verdict != null && verifiesTaskId != null/u);
  assert.match(service, /independent run/u);
  assert.match(service, /dispatchDependentsAfterCompletion\(ownerId, verifiesTaskId\)/u);
  assert.match(service, /projectVerifierCarrierStatus/u);
});
