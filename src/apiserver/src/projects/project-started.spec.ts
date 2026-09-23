/**
 * What a coordinator is told when the owner starts its project (`project-started.ts`).
 *
 * The words only. That the message is sent once, on the off→on transition, to a conversation that
 * has not ended, is `project-acceptance-confirmation.pg.spec.ts` (7).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { uuidToBase62 } from '@orbit/shared';

import {
  PROJECT_STARTED_LISTED_TASKS,
  projectStartedMessage,
  projectStartedTurnId,
} from './project-started';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function held(count: number): Array<{ id: string; title: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    title: `held task ${index + 1}`,
  }));
}

function message(tasks: Array<{ id: string; title: string }>, heldCount = tasks.length) {
  const projectId = randomUUID();
  return {
    projectId,
    text: projectStartedMessage({
      projectId,
      projectTitle: 'Two Codex accounts on one machine',
      criteriaCount: 8,
      confirmedAt: new Date('2026-09-23T05:06:07.072Z'),
      held: tasks,
      heldCount,
    }),
  };
}

test('it names the project, the start, and every task that waits on the coordinator', () => {
  const tasks = held(2);
  const { projectId, text } = message(tasks);
  assert.match(text, /^From Orbit · project started\n\n/);
  assert.ok(text.includes(
    'The account owner confirmed the 8 acceptance criteria of project '
      + `“Two Codex accounts on one machine” (${uuidToBase62(projectId)}) `
      + 'and started it at 2026-09-23T05:06:07.072Z.',
  ));
  assert.ok(text.includes('2 of its open tasks are set to be started by hand'));
  for (const task of tasks) {
    assert.ok(text.includes(`- ${task.title} (${uuidToBase62(task.id)})`), `${task.title} is not named`);
  }
  assert.ok(text.includes('task_start'), 'the coordinator is told how to start them');
  assert.doesNotMatch(text, UUID, 'a model reads base62 ids, never a raw uuid');
});

test('one held task is spoken of in the singular', () => {
  const { text } = message(held(1));
  assert.ok(text.includes('1 of its open tasks is set to be started by hand'));
  assert.ok(text.includes('so nothing starts it unless you do'));
});

test('a long list is cut, and says how many it left out and where to read them', () => {
  const tasks = held(PROJECT_STARTED_LISTED_TASKS);
  const { projectId, text } = message(tasks, PROJECT_STARTED_LISTED_TASKS + 5);
  assert.ok(text.includes(`${PROJECT_STARTED_LISTED_TASKS + 5} of its open tasks are`));
  assert.equal(text.split('\n').filter((line) => line.startsWith('- held task')).length,
    PROJECT_STARTED_LISTED_TASKS);
  assert.ok(text.includes(`- …and 5 more (task_list with projectId: ${uuidToBase62(projectId)})`));
});

test('with nothing held it says so, and still says what the press did not answer', () => {
  const { text } = message([]);
  assert.ok(text.includes('None of its open tasks is set to be started by hand'));
  assert.ok(!text.includes('task_start'), 'there is nothing to start by hand');
  assert.ok(text.endsWith(
    'Starting the project answered nothing else: if you are still waiting on the owner for '
      + 'something, ask it again.',
  ));
});

test('the turn is keyed by the confirmation that started the project', () => {
  const confirmation = randomUUID();
  assert.equal(projectStartedTurnId(confirmation), projectStartedTurnId(confirmation));
  assert.notEqual(projectStartedTurnId(confirmation), projectStartedTurnId(randomUUID()));
  assert.match(projectStartedTurnId(confirmation), UUID);
});
