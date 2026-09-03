import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * "The task's own session runs the command and the server derives DONE/FAILED from the exit code."
 *
 * That sentence described this controller until 2026-09-02, when the account owner had the
 * judgment machinery deleted; on 2026-09-03 the owner asked for the comparison itself back,
 * without any of the recording — "根据 exit code 来简单判断，不需要实际记录数据". So the sentence is
 * true again, and this file replaces the negative control that asserted it was false
 * (`executable-derivation-removal.spec.ts`).
 *
 * Restoring a derivation is easy to do too generously — the usual failure is to bring back the
 * comparison and, with it, the ledger that made it auditable. So this reads the whole
 * `turnComplete` handler and asserts three things: the comparison is there, `task.status` is the
 * ONLY thing it writes, and none of the removed evidence carriers came back with it.
 */

const API = path.resolve(__dirname, '../..');
const CONTROLLER = readFileSync(path.join(API, 'src/runner-api/runner-api.controller.ts'), 'utf8');

function turnCompleteHandler(): string {
  const start = CONTROLLER.indexOf('async turnComplete(');
  assert.ok(start > 0);
  // Up to the next top-level method. The whole ACK transaction lives inside.
  const rest = CONTROLLER.slice(start);
  const end = rest.indexOf('\n  @Post(');
  return end > 0 ? rest.slice(0, end) : rest;
}

test('the callback compares the reported exit code against the declared one', () => {
  const handler = turnCompleteHandler();
  // The comparison is delegated, not re-implemented: one predicate, in the pure boundary, shared
  // with every other reader of a criterion. A second inline `===` here would be a fork of it.
  assert.match(handler, /deriveTaskCompletionStatus\(\{/u);
  assert.match(handler, /executableExitCode: actualExitCode/u);
  assert.match(handler, /acceptanceExpectedExitCode: expectedExitCode/u);
  assert.match(handler, /const actualExitCode = dto\.shellExitCode!/u);
  // FAILED is the conservative half and is NOT criterion-derived: `deriveTaskCompletionStatus`
  // can only ever answer DONE or null, so the fallback has to be spelled at the call site.
  assert.match(handler, /const derivedStatus = completed \?\? TaskStatus\.FAILED;/u);
});

test('the derived status is the only Task write, and it is a compare-and-set', () => {
  const handler = turnCompleteHandler();
  const statusWrites = [...handler.matchAll(/(?:tx|this\.prisma)\.task\.(update|updateMany)\(/gu)];
  assert.deepEqual(statusWrites.map((match) => match[0]), ['tx.task.updateMany('],
    'exactly one Task write: a second route to a status is a second criterion');
  // Its WHERE repeats the declaration and the pending status, so the write fails closed if it is
  // ever moved out from under the row lock taken above it.
  const write = handler.slice(handler.indexOf('tx.task.updateMany('));
  const body = write.slice(0, write.indexOf('});'));
  for (const guard of [
    /status: \{ in: \[\.\.\.EXECUTABLE_ACCEPTANCE_PENDING_STATUSES\] \}/u,
    /acceptanceCommand: lockedAcceptanceTask\.acceptanceCommand/u,
    /acceptanceExpectedExitCode: expectedExitCode/u,
    /completionCriterion: 'EXECUTABLE'/u,
    /data: \{ status: derivedStatus \}/u,
  ]) {
    assert.match(body, guard, `the compare-and-set lost ${guard}`);
  }
});

test('nothing about the run is recorded: the comparison writes one status and stops', () => {
  // The account owner's instruction was that the exit code is a comparison input and not data.
  // The removal suites already assert tree-wide that no deleted carrier came back; what belongs
  // HERE is the shape of the block that replaced them, because that is where a "make it
  // diagnosable" repair would land. It inserts nothing, and it hands nothing to a helper.
  const handler = turnCompleteHandler();
  const start = handler.indexOf('let acceptanceTaskChanged');
  assert.ok(start > 0);
  const comparison = handler.slice(start, handler.indexOf('acceptanceTaskAwaitingResult', start));
  for (const forbidden of [/\.create\(/u, /createMany\(/u, /upsert\(/u, /taskComment/u,
    /Evidence/u, /Judgment/u, /Attempt/u, /Ledger/u]) {
    assert.doesNotMatch(comparison, forbidden,
      `the comparison writes a record through ${forbidden}: nothing about the run may be stored`);
  }
  // `shellOutput` is not read on this path at all any more: the comparison needs one integer, and
  // requiring the output would make an unread field able to withhold a judgment.
  assert.doesNotMatch(comparison, /shellOutput/u,
    'the comparison must not depend on output it does not use');
  // And it touches the database exactly once. This is the measure that means something: every
  // read this block does not perform is a fact it cannot have consulted, and every write it does
  // not perform is a row it cannot have left behind. One `await`, and it is the status write.
  const awaits = [...comparison.matchAll(/await\s+([A-Za-z0-9_.]+)/gu)].map((m) => m[1]);
  assert.deepEqual(awaits, ['tx.task.updateMany'],
    'the comparison reaches the database more than once; it has inputs or outputs it should not');
});

test('an incomparable turn still reaches the human signal, and only that turn does', () => {
  const handler = turnCompleteHandler();
  // Mutually exclusive by construction: the signal is guarded on the comparison NOT having moved
  // the task, so a judged turn cannot also produce it.
  assert.match(handler,
    /if \(taskAcceptanceTurn && acceptanceTaskAwaitingResult && !acceptanceTaskChanged\) \{/u);
  assert.match(handler, /postExecutableAcceptanceUnavailableComment\(/u);
  // And the comparison is the only thing that can clear that flag.
  const sets = [...handler.matchAll(/acceptanceTaskChanged = true/gu)];
  assert.equal(sets.length, 1);
});

test('the pure criterion boundary owns the comparison and has no default arm', () => {
  const criterion = readFileSync(
    path.join(API, 'src/tasks/task-completion-criterion.ts'), 'utf8',
  );
  const evaluator = criterion.slice(criterion.indexOf('export function evaluateTaskCompletion'));
  const body = evaluator.slice(0, evaluator.indexOf('\n}\n'));
  assert.doesNotMatch(body, /throw\b/u, 'an unsatisfied criterion is a state, not an error');
  assert.doesNotMatch(body, /default:/u);
  assert.match(body, /case 'EXECUTABLE':/u);
  assert.match(body, /case 'VERIFICATION':/u);
  assert.match(body, /case 'EVIDENCE_JUDGMENT':/u);
  // EVIDENCE_JUDGMENT was NOT restored alongside EXECUTABLE. It is still declared and still
  // unimplemented, and its arm still says so without reading a fact.
  assert.match(body, /case 'EVIDENCE_JUDGMENT':\s*\n\s*state = 'UNSATISFIED';/u);
  // `deriveTaskCompletionStatus` is still the one projection onto a status.
  assert.match(criterion, /return evaluateTaskCompletion\(facts\)\.satisfied \? 'DONE' : null;/u);
});
