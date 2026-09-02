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

test('production wiring has no parked-session or whole-task-set completion gate', () => {
  const root = path.resolve(__dirname, '../../src');
  const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
  const moduleSource = read('projects/coordinator-judgment.module.ts');
  const runnerSource = read('runner-api/runner-api.controller.ts');
  const tasksSource = read('tasks/tasks.service.ts');
  const attemptSource = read('projects/attempt-ended-unsettled.producer.ts');
  const routerSource = read('projects/completion-input-router.service.ts');

  assert.doesNotMatch(moduleSource, /ProjectTasksSettledProducer|AttemptEndedUnsettledProducer/);
  assert.doesNotMatch(runnerSource, /AttemptEndedUnsettledProducer|attemptEndedUnsettled/);
  assert.doesNotMatch(tasksSource, /ProjectTasksSettledProducer|deliverSettledProjectFacts/);
  assert.doesNotMatch(attemptSource, /ATTEMPT_WAKE_SESSION_PARKED|ATTEMPT_SESSION_PARKED/);
  assert.doesNotMatch(attemptSource, /OnApplicationBootstrap/);
  assert.doesNotMatch(routerSource, /SessionsService|CoordinatorJudgmentService|setInterval|setTimeout/);
});
