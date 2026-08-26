import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  completionEvidenceRevisedFact,
  executableResultRecordedFact,
  humanSignoffRequestedFact,
  verificationVerdictRecordedFact,
} from './completion-input';
import { wakeIdempotencyKey } from './coordinator-wake';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const TASK = '10000000-0000-4000-8000-000000000002';
const REQUEST = '10000000-0000-4000-8000-000000000003';

test('criterion input keys move only with their immutable fact version', () => {
  const first = completionEvidenceRevisedFact({
    projectId: PROJECT,
    taskId: TASK,
    revision: '7',
    criterionRevision: 'a'.repeat(64),
    evidenceDigest: 'b'.repeat(64),
    requestId: REQUEST,
    requestKind: 'HUMAN_SIGNOFF',
  });
  const same = { ...first, detail: { displayOnly: 'changed' } };
  const next = completionEvidenceRevisedFact({
    projectId: PROJECT,
    taskId: TASK,
    revision: '8',
    criterionRevision: 'a'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
    requestId: '10000000-0000-4000-8000-000000000004',
    requestKind: 'HUMAN_SIGNOFF',
  });
  assert.equal(wakeIdempotencyKey(first), wakeIdempotencyKey(same));
  assert.notEqual(wakeIdempotencyKey(first), wakeIdempotencyKey(next));
  assert.doesNotMatch(wakeIdempotencyKey(first), new RegExp(PROJECT));
});

test('each criterion input has its own event, subject and version', () => {
  const executable = executableResultRecordedFact({
    projectId: PROJECT,
    taskId: TASK,
    requestId: REQUEST,
    resultId: '10000000-0000-4000-8000-000000000005',
    evidenceDigest: 'd'.repeat(64),
    actualExitCode: 0,
  });
  const verification = verificationVerdictRecordedFact({
    projectId: PROJECT,
    taskId: TASK,
    requestId: REQUEST,
    verifierTaskId: '10000000-0000-4000-8000-000000000006',
    verdictRevision: '3',
    evidenceDigest: 'e'.repeat(64),
    verdict: 'PASS',
  });
  const human = humanSignoffRequestedFact({
    projectId: PROJECT,
    taskId: TASK,
    requestId: REQUEST,
    criterionRevision: 'f'.repeat(64),
    evidenceDigest: '0'.repeat(64),
    recipientId: '10000000-0000-4000-8000-000000000007',
  });
  assert.deepEqual(
    [executable, verification, human].map((fact) => [fact.event, fact.subjectType, fact.subjectId]),
    [
      ['EXECUTABLE_RESULT_RECORDED', 'JUDGMENT_REQUEST', REQUEST],
      ['VERIFICATION_VERDICT_RECORDED', 'JUDGMENT_REQUEST', REQUEST],
      ['HUMAN_SIGNOFF_REQUESTED', 'JUDGMENT_REQUEST', REQUEST],
    ],
  );
  assert.equal(new Set([executable, verification, human].map(wakeIdempotencyKey)).size, 3);
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
