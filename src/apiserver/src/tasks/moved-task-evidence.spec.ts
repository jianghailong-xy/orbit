import assert from 'node:assert/strict';
import test from 'node:test';

import { uuidToBase62 } from '@orbit/shared';

import { criterionKeyOf } from '../projects/project-acceptance';
import {
  arrivalMessage,
  movedEvidenceTurnId,
  resubmitMessage,
  resubmitStandard,
  type MovedEvidence,
} from './moved-task-evidence';
import { taskProjectDisqualification } from './task-evidence-decision';

const TASK = '10000000-0000-4000-8000-0000000000a1';
const FROM = '10000000-0000-4000-8000-0000000000a2';
const TO = '10000000-0000-4000-8000-0000000000a3';
const WITHDRAWN = '10000000-0000-4000-8000-0000000000a4';
const DECLARED = '10000000-0000-4000-8000-0000000000a5';
const EVIDENCE = '10000000-0000-4000-8000-0000000000a6';
const RUN = '10000000-0000-4000-8000-0000000000a7';

function moved(over: Partial<MovedEvidence> = {}): MovedEvidence {
  return {
    taskId: TASK,
    title: 'the work',
    revision: '3',
    from: { id: FROM, title: 'Source' },
    to: { id: TO, title: 'Target' },
    quoted: { key: criterionKeyOf(WITHDRAWN), text: 'what the source wanted' },
    withdrawnCriterionDefinitionId: WITHDRAWN,
    standard: { kind: 'PROJECT_CRITERION', key: criterionKeyOf(DECLARED), text: 'what the target wants' },
    ...over,
  };
}

test('the standard a moved task is held to is its declared criterion, else its own criteria, else none', () => {
  assert.deepEqual(
    resubmitStandard({ id: TASK, acceptanceCriteria: 'its own', declared: { id: DECLARED, text: 'declared' } }),
    { kind: 'PROJECT_CRITERION', key: criterionKeyOf(DECLARED), text: 'declared' },
  );
  // A task with no declaration quotes its own criteria under its own public id.
  assert.deepEqual(
    resubmitStandard({ id: TASK, acceptanceCriteria: 'its own', declared: null }),
    { kind: 'TASK_ACCEPTANCE_CRITERIA', key: uuidToBase62(TASK), text: 'its own' },
  );
  assert.deepEqual(resubmitStandard({ id: TASK, acceptanceCriteria: '  ', declared: null }), { kind: 'NONE' });
  assert.deepEqual(resubmitStandard({ id: TASK, acceptanceCriteria: null, declared: null }), { kind: 'NONE' });
});

test('each message is one turn per revision, target and reader', () => {
  const run = movedEvidenceTurnId('run', EVIDENCE, TO);
  assert.equal(run, movedEvidenceTurnId('run', EVIDENCE, TO));
  assert.match(run, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(run, movedEvidenceTurnId('coordinator', EVIDENCE, TO));
  assert.notEqual(run, movedEvidenceTurnId('run', EVIDENCE, FROM));
  assert.notEqual(run, movedEvidenceTurnId('run', RUN, TO));
});

test('the run is told the criterion it quoted was taken back, and what to quote instead', () => {
  const says = resubmitMessage(moved());
  assert.ok(says.includes(uuidToBase62(TASK)));
  assert.ok(says.includes(uuidToBase62(TO)));
  assert.ok(says.includes(`key ${criterionKeyOf(WITHDRAWN)}`));
  assert.ok(says.includes('移动时已经收回'));
  assert.ok(says.includes(`key：${criterionKeyOf(DECLARED)}`));
  assert.ok(says.includes('「what the target wants」'));
  assert.ok(says.includes('task_evidence_submit'));

  // A quote of something the move did not take back is not called withdrawn.
  const other = resubmitMessage(moved({ quoted: { key: uuidToBase62(TASK), text: 'its own' } }));
  assert.ok(!other.includes('移动时已经收回'));
  assert.ok(other.includes('不是这个任务在项目「Target」'));

  // With no standard at all, it is told to state one first.
  const none = resubmitMessage(moved({ standard: { kind: 'NONE' } }));
  assert.ok(none.includes('criterionKey'));
  assert.ok(none.includes('acceptanceCriteria'));
});

test('the target coordinator is told the task arrived owing a revision, and who was told', () => {
  const told = arrivalMessage(moved(), [RUN]);
  assert.ok(told.includes('要重交'));
  assert.ok(told.includes(`key ${criterionKeyOf(DECLARED)}`));
  assert.ok(told.includes(uuidToBase62(RUN)));
  assert.ok(!told.includes('task_evidence_decide'), 'it is not asked to decide a revision nobody can');
  const nobody = arrivalMessage(moved(), []);
  assert.ok(nobody.includes('没有运行中的会话'));
  assert.ok(nobody.includes('task_start'));
});

test('a session acting for another project is disqualified; a task or session in none is not', () => {
  assert.equal(taskProjectDisqualification(TO, TO), null);
  assert.equal(taskProjectDisqualification(null, FROM), null);
  assert.equal(taskProjectDisqualification(TO, null), null);
  const why = taskProjectDisqualification(TO, FROM);
  assert.ok(why?.includes(uuidToBase62(FROM)));
  assert.ok(why?.includes(uuidToBase62(TO)));
});
