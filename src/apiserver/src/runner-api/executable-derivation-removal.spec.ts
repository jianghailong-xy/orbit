import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * "The task's own session runs the command and the server derives DONE/FAILED from the exit code."
 * That sentence described this controller until 2026-09-02. It no longer does.
 *
 * Removing a derivation is easy to do incompletely — the usual failure is to delete the comparison
 * and leave a second path that reaches the same status by another route. So this reads the whole
 * `turnComplete` handler and asserts three things: the comparison is gone, no other statement in
 * it writes a Task status, and the surviving surfaces (the acceptance turn, the typed attempt, the
 * needs-human signal) are the ones that were never part of the decision.
 */

const API = path.resolve(__dirname, '../..');
const CONTROLLER = readFileSync(path.join(API, 'src/runner-api/runner-api.controller.ts'), 'utf8');

test('nothing in the runner controller compares an exit code to a declared one', () => {
  for (const gone of [
    /deriveTaskCompletionStatus/u,
    /derivedStatus/u,
    /acceptanceTaskCompleted/u,
    /executableExitCode/u,
    /ensureLegacyExecutableJudgmentRequest/u,
    /shellExitCode\s*===/u,
    /=== expectedExitCode/u,
    /=== lockedAcceptanceTask\.acceptanceExpectedExitCode/u,
  ]) {
    assert.doesNotMatch(CONTROLLER, gone, `the controller still carries ${gone}`);
  }
});

test('no statement in turnComplete writes a Task status', () => {
  const start = CONTROLLER.indexOf('async turnComplete(');
  assert.ok(start > 0);
  // Up to the next top-level method. The whole ACK transaction lives inside.
  const rest = CONTROLLER.slice(start);
  const end = rest.indexOf('\n  @Post(');
  const handler = end > 0 ? rest.slice(0, end) : rest;

  const statusWrites = [...handler.matchAll(/(?:tx|this\.prisma)\.task\.(update|updateMany)\(/gu)];
  assert.deepEqual(statusWrites.map((match) => match[0]), [],
    'the acceptance callback writes no Task row at all any more');
  assert.doesNotMatch(handler, /TaskStatus\.DONE/u);
  assert.doesNotMatch(handler, /status:\s*TaskStatus\.FAILED/u);
});

test('what survives is the declaration-driven turn, the typed attempt and the human signal', () => {
  // The acceptance turn is still queued FROM the stored declaration: the declaration is what the
  // owner kept, and reading it to dispatch a command is not a decision about the task.
  assert.match(CONTROLLER, /acceptanceCommand/u);
  assert.match(CONTROLLER, /taskAcceptance/u);

  // 0200's typed attempt lane belongs to the executable runtime, not to this change. It records a
  // termination and reconciles project acceptance; it derives no status.
  assert.match(CONTROLLER, /taskExecutableAttempt\.update/u);
  assert.match(CONTROLLER, /acceptanceAttemptTerminatedId/u);

  // And the honest signal when a reserved turn produces nothing comparable, which predates the
  // derivation and is now what every acceptance turn reaches.
  assert.match(CONTROLLER, /postExecutableAcceptanceUnavailableComment/u);
  assert.match(CONTROLLER, /acceptance command result no longer matches the current declaration/u);
});

test('the pure criterion boundary answers UNSATISFIED rather than throwing or defaulting', () => {
  const criterion = readFileSync(
    path.join(API, 'src/tasks/task-completion-criterion.ts'), 'utf8',
  );
  const evaluator = criterion.slice(criterion.indexOf('export function evaluateTaskCompletion'));
  const body = evaluator.slice(0, evaluator.indexOf('\n}\n'));
  assert.doesNotMatch(body, /throw\b/u, 'an unimplemented criterion is a state, not an error');
  assert.doesNotMatch(body, /default:/u);
  assert.match(body, /case 'EXECUTABLE':/u);
  assert.match(body, /case 'VERIFICATION':/u);
  assert.match(body, /case 'EVIDENCE_JUDGMENT':/u);
  // `deriveTaskCompletionStatus` is the only projection onto a status, and it is still the one
  // predicate: VERIFICATION is what can reach DONE through it.
  assert.match(criterion, /return evaluateTaskCompletion\(facts\)\.satisfied \? 'DONE' : null;/u);
});
