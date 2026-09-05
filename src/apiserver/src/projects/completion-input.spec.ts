import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { completionEvidenceRevisedFact } from './completion-input';
import {
  COORDINATOR_WAKE_EVENTS,
  RETIRED_COORDINATOR_WAKE_EVENTS,
  wakeIdempotencyKey,
} from './coordinator-wake';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const TASK = '10000000-0000-4000-8000-000000000002';

test('criterion input keys move only with their immutable fact version', () => {
  const first = completionEvidenceRevisedFact({
    projectId: PROJECT,
    taskId: TASK,
    revision: '7',
    criterionRevision: 'a'.repeat(64),
    evidenceDigest: 'b'.repeat(64),
  });
  const same = { ...first, detail: { displayOnly: 'changed' } };
  const next = completionEvidenceRevisedFact({
    projectId: PROJECT,
    taskId: TASK,
    revision: '8',
    criterionRevision: 'a'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
  });
  assert.equal(wakeIdempotencyKey(first), wakeIdempotencyKey(same));
  assert.notEqual(wakeIdempotencyKey(first), wakeIdempotencyKey(next));
  assert.doesNotMatch(wakeIdempotencyKey(first), new RegExp(PROJECT));
});

// The judgment machinery was removed on 2026-09-02. Four of the five completion inputs were facts
// ABOUT a `task_judgment_request` — an exit-code result that decided one, a verdict that decided
// one, and the two request lifecycle events — so their constructors went with the table. What is
// asserted now is that they are RETIRED rather than merely deleted: `project_coordinator_wake`'s
// CHECK still accepts every one of them because rows already carry them, and a spelling that
// appeared in neither list would be a wake nothing in this tree could explain.
test('the four judgment-request completion inputs are retired, not silently dropped', () => {
  for (const event of [
    'EXECUTABLE_RESULT_RECORDED',
    'VERIFICATION_VERDICT_RECORDED',
    'EVIDENCE_JUDGMENT_REQUESTED',
    'EVIDENCE_JUDGMENT_DECIDED',
    'EVIDENCE_JUDGMENT_REQUEST_SUPERSEDED',
  ]) {
    assert.ok(
      (RETIRED_COORDINATOR_WAKE_EVENTS as readonly string[]).includes(event),
      `${event} must be listed as retired, not removed from the vocabulary`,
    );
    assert.ok(
      !(COORDINATOR_WAKE_EVENTS as readonly string[]).includes(event),
      `${event} must no longer be a live event: nothing produces it`,
    );
  }
  const source = readFileSync(
    path.resolve(__dirname, '../../src/projects/completion-input.ts'), 'utf8',
  );
  for (const gone of [
    'executableResultRecordedFact',
    'verificationVerdictRecordedFact',
    'evidenceJudgmentRequestedFact',
    'evidenceJudgmentDecidedFact',
    'evidenceJudgmentRequestSupersededFact',
  ]) {
    assert.doesNotMatch(source, new RegExp(gone), `${gone} must not have a producer left`);
  }
});

/**
 * The gates that are deliberately back, and the producer that is deliberately still not.
 *
 * This case used to assert that NEITHER was wired, which was true of the tree it was written
 * against: both producers existed and nothing in production reached either. `PROJECT_TASKS_SETTLED`
 * is now delivered by the task write path, so the half of that claim about T7 has stopped being
 * true and is replaced here by the SHAPE of the wiring instead of its absence — a wall that goes
 * on asserting a removal after the thing was deliberately restored is a wall that has to be
 * deleted rather than read.
 *
 * The rest is untouched and still says what it said, with one word of it now carrying more weight
 * than it did: the attempt PRODUCER is still unreached — `ATTEMPT_ENDED_UNSETTLED` reaches the
 * ledger through the router's own exception door and `TaskExceptionInputProducer`, which is the
 * same "add to the router's vocabulary rather than start a second mechanism" this file is about.
 * What remains asserted is that the hollowed-out producer is not what got wired back: neither the
 * judgment module nor the runner door names it, the refusal codes and bootstrap hook its removed
 * version had are still gone, and the router still has no clock and opens no session of its own.
 */
test('the gates are wired through the router, and the hollowed-out attempt producer is not', () => {
  const root = path.resolve(__dirname, '../../src');
  const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
  const moduleSource = read('projects/coordinator-judgment.module.ts');
  const runnerSource = read('runner-api/runner-api.controller.ts');
  const tasksSource = read('tasks/tasks.service.ts');
  const attemptSource = read('projects/attempt-ended-unsettled.producer.ts');
  const routerSource = read('projects/completion-input-router.service.ts');

  // One construction site, and it is the module that owns the producer's two collaborators.
  assert.match(moduleSource, /ProjectTasksSettledProducer/);
  // The task write path holds a router, not a producer: a second holder is a second instance, and
  // "which object delivered it" is not a question the wake ledger can answer afterwards.
  assert.doesNotMatch(tasksSource, /ProjectTasksSettledProducer/);

  // The exception gate arrived the same way and is held the same way: constructed where its
  // convergence service is a provider, and reached from the task write path through the router.
  assert.match(moduleSource, /TaskExceptionInputProducer/);
  assert.doesNotMatch(tasksSource, /TaskExceptionInputProducer/);

  assert.doesNotMatch(moduleSource, /AttemptEndedUnsettledProducer/);
  assert.doesNotMatch(runnerSource, /AttemptEndedUnsettledProducer|attemptEndedUnsettled/);
  assert.doesNotMatch(attemptSource, /ATTEMPT_WAKE_SESSION_PARKED|ATTEMPT_SESSION_PARKED/);
  assert.doesNotMatch(attemptSource, /OnApplicationBootstrap/);
  assert.doesNotMatch(routerSource, /SessionsService|CoordinatorJudgmentService|setInterval|setTimeout/);
});
