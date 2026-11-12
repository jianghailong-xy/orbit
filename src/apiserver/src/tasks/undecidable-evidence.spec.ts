import assert from 'node:assert/strict';
import test from 'node:test';

import { uuidToBase62 } from '@orbit/shared';

import { criterionKeyOf } from '../projects/project-acceptance';
import { taskProjectDisqualification } from './task-evidence-decision';
import {
  coordinatorMessage,
  runMessage,
  standardDigest,
  undecidableEvidenceTurnId,
  type UndecidableEvidence,
} from './undecidable-evidence';

const TASK = '10000000-0000-4000-8000-0000000000a1';
const FROM = '10000000-0000-4000-8000-0000000000a2';
const TO = '10000000-0000-4000-8000-0000000000a3';
const WITHDRAWN = '10000000-0000-4000-8000-0000000000a4';
const DECLARED = '10000000-0000-4000-8000-0000000000a5';
const EVIDENCE = '10000000-0000-4000-8000-0000000000a6';
const RUN = '10000000-0000-4000-8000-0000000000a7';

function moved(over: Partial<UndecidableEvidence> = {}): UndecidableEvidence {
  return {
    taskId: TASK,
    title: 'the work',
    revision: '3',
    project: { id: TO, title: 'Target' },
    cause: { kind: 'MOVED', from: { id: FROM, title: 'Source' }, withdrawnCriterionDefinitionId: WITHDRAWN },
    quoted: { key: criterionKeyOf(WITHDRAWN), text: 'what the source wanted' },
    doorReason: 'the door would refuse it',
    standard: { kind: 'PROJECT_CRITERION', key: criterionKeyOf(DECLARED), text: 'what the target wants' },
    ...over,
  };
}

function reworded(over: Partial<UndecidableEvidence> = {}): UndecidableEvidence {
  return moved({
    cause: { kind: 'CRITERIA_CHANGED' },
    quoted: { key: criterionKeyOf(DECLARED), text: 'what the target wanted' },
    doorReason: `the criterion this evidence quotes (${criterionKeyOf(DECLARED)}) is not what the project states today`,
    ...over,
  });
}

test('each message is one turn per reader, revision and standard', () => {
  const digest = standardDigest({ kind: 'PROJECT_CRITERION', key: 'k', text: 'the words' });
  const run = undecidableEvidenceTurnId('run', EVIDENCE, digest);
  assert.equal(run, undecidableEvidenceTurnId('run', EVIDENCE, digest));
  assert.match(run, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(run, undecidableEvidenceTurnId('coordinator', EVIDENCE, digest));
  assert.notEqual(run, undecidableEvidenceTurnId('run', RUN, digest));
  // The same standard, however its line endings or edges are spelled, is the same key; new words are not.
  assert.equal(digest, standardDigest({ kind: 'PROJECT_CRITERION', key: 'k', text: ' the words\r\n' }));
  assert.notEqual(digest, standardDigest({ kind: 'PROJECT_CRITERION', key: 'k', text: 'other words' }));
  assert.notEqual(digest, standardDigest({ kind: 'TASK_ACCEPTANCE_CRITERIA', key: 'k', text: 'the words' }));
  assert.notEqual(standardDigest({ kind: 'NONE' }), standardDigest({ kind: 'DECLARED_CRITERION_DELETED', own: null }));
  assert.notEqual(
    standardDigest({ kind: 'DECLARED_CRITERION_DELETED', own: null }),
    standardDigest({ kind: 'DECLARED_CRITERION_DELETED', own: { key: 'k', text: 'the words' } }),
  );
});

test('a moved task run is told the criterion it quoted was taken back, and the standard it is held to there', () => {
  const says = runMessage(moved());
  assert.ok(says.includes(uuidToBase62(TASK)));
  assert.ok(says.includes(uuidToBase62(TO)));
  assert.ok(says.includes(`key ${criterionKeyOf(WITHDRAWN)}`));
  assert.ok(says.includes('was taken back by the move'));
  assert.ok(says.includes(`key: ${criterionKeyOf(DECLARED)}`));
  assert.ok(says.includes('“what the target wants”'));
  assert.ok(says.includes('task_evidence_submit'));
  assert.ok(says.includes('EVIDENCE_JUDGMENT_CRITERION_MOVED'));

  // A quote of something the move did not take back is not called withdrawn.
  const other = runMessage(moved({ quoted: { key: uuidToBase62(TASK), text: 'its own' } }));
  assert.ok(!other.includes('was taken back by the move'));
  assert.ok(other.includes('is not the standard this task has to meet in project “Target”'));

  // With no standard at all, it is told to state one first.
  const none = runMessage(moved({ standard: { kind: 'NONE' } }));
  assert.ok(none.includes('criterionKey'));
  assert.ok(none.includes('acceptanceCriteria'));
});

test('a run whose standard was reworded is told why, in the door words, and the new wording', () => {
  const says = runMessage(reworded());
  assert.ok(says.includes('can no longer be decided'));
  assert.ok(says.includes('is not what the project states today'), 'the door reason is not given');
  assert.ok(says.includes(`key: ${criterionKeyOf(DECLARED)}`));
  assert.ok(says.includes('“what the target wants”'), 'the new wording is not given word for word');
  assert.ok(!says.includes('moved to project'));

  const deleted = runMessage(reworded({
    standard: { kind: 'DECLARED_CRITERION_DELETED', own: { key: uuidToBase62(TASK), text: 'its own words' } },
  }));
  assert.ok(deleted.includes('no longer exists'));
  assert.ok(deleted.includes('criterionKey: null'));
  assert.ok(deleted.includes('“its own words”'), 'the standard it would fall back to is not named');
});

test('the coordinator is told the revision cannot be decided, and whether a run was told', () => {
  const told = coordinatorMessage(moved(), [RUN]);
  assert.ok(told.includes('to be submitted again'));
  assert.ok(told.includes(`key ${criterionKeyOf(DECLARED)}`));
  assert.ok(told.includes(uuidToBase62(RUN)));
  assert.ok(!told.includes('task_evidence_decide'), 'it is not asked to decide a revision nobody can');
  const nobody = coordinatorMessage(reworded(), []);
  assert.ok(nobody.includes('has no running session'));
  assert.ok(nobody.includes('It is yours to act on'));
  assert.ok(nobody.includes('task_start'));
  assert.ok(nobody.includes('Nothing restarts it by itself'));
  assert.ok(nobody.includes('“what the target wants”'));
});

test('a coordinator already asked to decide the revision is told that request is withdrawn', () => {
  for (const e of [reworded(), moved()]) {
    const handed = coordinatorMessage(e, [], true);
    assert.ok(!handed.includes('not handed to you'), 'it denies a hand-over that happened');
    assert.ok(handed.includes('Earlier you were asked to decide revision 3; that request is withdrawn'));
    assert.ok(handed.includes('EVIDENCE_JUDGMENT_CRITERION_MOVED'));
    assert.ok(!handed.includes('task_evidence_decide'));
    const never = coordinatorMessage(e, []);
    assert.ok(never.includes('so it was not handed to you to decide'));
    assert.ok(!never.includes('withdrawn'));
  }
});

test('a session acting for another project is disqualified; a task or session in none is not', () => {
  assert.equal(taskProjectDisqualification(TO, TO), null);
  assert.equal(taskProjectDisqualification(null, FROM), null);
  assert.equal(taskProjectDisqualification(TO, null), null);
  const why = taskProjectDisqualification(TO, FROM);
  assert.ok(why?.includes(uuidToBase62(FROM)));
  assert.ok(why?.includes(uuidToBase62(TO)));
});
