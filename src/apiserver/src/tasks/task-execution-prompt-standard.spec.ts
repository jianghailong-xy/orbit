import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';

import { buildTaskExecutionPrompt } from './task-execution-prompt';

/**
 * The brief states the standard a task's evidence is judged against, and the exact `criterion` to
 * send for it, instead of telling the run to copy one from project_get
 * (docs/evidence-always-has-an-addressee-design.md §2). On 2026-11-12 two runs of a project task
 * that declared no criterionKey did as that sentence said, quoted another criterion of the project,
 * and their evidence sat undecidable for hours.
 */

const TASK_ID = '019a7a10-1111-7111-8111-111111111111';
const PROJECT_ID = '019a7a10-2222-7222-8222-222222222222';
const DEFINITION_ID = '019a7a10-3333-7333-8333-333333333333';
const OWN = 'The changelog lists every release under its version heading.';
const CRITERION = 'Every release the project shipped has a changelog entry.';

const TASK = {
  id: TASK_ID,
  title: 'Fold the release notes into the changelog',
  description: 'Read project_get first, then move every entry under its version heading.',
  acceptanceCriteria: OWN,
  completionCriterion: 'EVIDENCE_JUDGMENT' as const,
  isForeman: false,
  verifiesTaskId: null,
  list: null,
};

/** Step 3 of the brief: from its number to step 4. */
function stepThree(brief: string): string {
  const start = brief.indexOf('\n3. ');
  const end = brief.indexOf('\n4. ');
  assert.ok(start >= 0 && end > start, brief);
  return brief.slice(start, end);
}

/** No sentence of the brief sends the run to project_get for its criterion. */
function neverPointsAtProjectCriteria(brief: string): void {
  const steps = brief.slice(brief.indexOf('Follow these steps:'));
  assert.doesNotMatch(steps, /project_get/, steps);
  assert.doesNotMatch(steps, /copied from the acceptance criteria/, steps);
}

test('a project task with no criterionKey is held to its own acceptanceCriteria, and is told to send its own id as the key', () => {
  const brief = buildTaskExecutionPrompt({
    ...TASK,
    projectId: PROJECT_ID,
    criterionRevision: null,
    criterionDefinition: null,
  });
  assert.ok(brief.includes(`Acceptance criteria (what decides whether this task is done):\n${OWN}\n\n`), brief);
  const step = stepThree(brief);
  assert.ok(step.includes('This task is held to its own acceptance criteria, quoted above, and to nothing else'), step);
  assert.ok(step.includes(`criterion (exactly {"key": "${uuidToBase62(TASK_ID)}", "text": this task's acceptance `
    + 'criteria quoted above, character for character}; no criterion of a project is this task\'s standard)'), step);
  assert.ok(!step.includes(uuidToBase62(DEFINITION_ID)), step);
  neverPointsAtProjectCriteria(brief);
});

test('a project task that declares a criterionKey is held to that criterion\'s live text, quoted verbatim, with its key', () => {
  const brief = buildTaskExecutionPrompt({
    ...TASK,
    projectId: PROJECT_ID,
    criterionRevision: 1,
    criterionDefinition: { id: DEFINITION_ID, text: `  ${CRITERION}\n` },
  });
  const key = uuidToBase62(DEFINITION_ID);
  const step = stepThree(brief);
  assert.ok(step.includes(`This task is held to its project's acceptance criterion ${key}, which reads:\n\n`
    + `${CRITERION}\n\nYour evidence has to show that this holds.`), step);
  assert.ok(step.includes(`criterion (exactly {"key": "${key}", "text": the criterion quoted above, character for `
    + 'character}; no other criterion is this task\'s standard)'), step);
  // Its own criteria are still shown, but no longer as what decides it.
  assert.ok(brief.includes('Acceptance criteria (the task\'s own notes; the standard it is judged against is in '
    + `step 3):\n${OWN}\n\n`), brief);
  assert.ok(!brief.includes('Acceptance criteria (what decides whether this task is done)'), brief);
  assert.ok(!step.includes(uuidToBase62(TASK_ID)), step);
  neverPointsAtProjectCriteria(brief);
});

test('a task in no project is held to its own acceptanceCriteria, with its own id as the key', () => {
  const brief = buildTaskExecutionPrompt({ ...TASK, projectId: null, criterionRevision: null, criterionDefinition: null });
  const step = stepThree(brief);
  assert.ok(step.includes('This task is held to its own acceptance criteria, quoted above, and to nothing else'), step);
  assert.ok(step.includes(`criterion (exactly {"key": "${uuidToBase62(TASK_ID)}", `), step);
  neverPointsAtProjectCriteria(brief);
  // The same brief as a project task without a declaration: the filing does not change the standard.
  assert.equal(brief, buildTaskExecutionPrompt({ ...TASK, projectId: PROJECT_ID }));
});

test('a task that states no standard is told its submission is refused and what to write first', () => {
  const brief = buildTaskExecutionPrompt({ ...TASK, acceptanceCriteria: '   ', projectId: PROJECT_ID });
  const step = stepThree(brief);
  assert.ok(step.includes('This task states no standard: it declares no project criterion (criterionKey) and its '
    + 'acceptanceCriteria are empty, so a submission is refused.'), step);
  assert.ok(step.includes('write what would settle the work into its acceptanceCriteria with task_update, or declare '
    + 'a criterionKey'), step);
  neverPointsAtProjectCriteria(brief);
});

test('a verifier with no criteria of its own is settled by its verdict, not told it has no standard', () => {
  const brief = buildTaskExecutionPrompt({
    ...TASK,
    acceptanceCriteria: null,
    projectId: PROJECT_ID,
    verifiesTaskId: '019a7a10-4444-7444-8444-444444444444',
  });
  const step = stepThree(brief);
  assert.ok(step.includes('This task checks another task and is settled by its verdict'), step);
  assert.ok(!step.includes('This task states no standard'), step);
  neverPointsAtProjectCriteria(brief);
});

test('a row whose id is not a UUID is keyed by that id as it is', () => {
  const step = stepThree(buildTaskExecutionPrompt({ ...TASK, id: 'task-1' }));
  assert.ok(step.includes('criterion (exactly {"key": "task-1", '), step);
});

test('a declared criterion since deleted is not replaced by the task\'s own criteria', () => {
  const brief = buildTaskExecutionPrompt({
    ...TASK,
    projectId: PROJECT_ID,
    criterionRevision: 2,
    criterionDefinition: null,
  });
  const step = stepThree(brief);
  assert.ok(step.includes('The project criterion this task declared has been deleted, so it has no standard'), step);
  assert.ok(!step.includes(uuidToBase62(TASK_ID)), step);
  neverPointsAtProjectCriteria(brief);
});

test('tasks that submit no evidence keep their own criteria as what decides them', () => {
  for (const extra of [
    { completionCriterion: 'EXECUTABLE' as const, acceptanceCommand: 'npm test', acceptanceExpectedExitCode: 0 },
    { completionCriterion: 'OWNER_CONFIRMED' as const },
  ]) {
    const brief = buildTaskExecutionPrompt({
      ...TASK,
      ...extra,
      projectId: PROJECT_ID,
      criterionRevision: 1,
      criterionDefinition: { id: DEFINITION_ID, text: CRITERION },
    });
    assert.ok(brief.includes(`Acceptance criteria (what decides whether this task is done):\n${OWN}\n\n`), brief);
    assert.ok(!brief.includes('criterion (exactly'), brief);
  }
});
