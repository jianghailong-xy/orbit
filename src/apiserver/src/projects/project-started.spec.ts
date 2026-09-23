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
  type ProjectStart,
  projectStartOfTurn,
  projectStartedMessage,
  projectStartedTurnId,
} from './project-started';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const AT = new Date('2026-09-23T05:06:07.072Z');
const CONFIRMED: Extract<ProjectStart, { by: 'CONFIRMATION' }> = {
  by: 'CONFIRMATION',
  confirmationId: randomUUID(),
  criteriaCount: 8,
  at: AT,
};
const SWITCHED: Extract<ProjectStart, { by: 'SWITCH' }> = { by: 'SWITCH', configRevision: '3', at: AT };

function held(count: number): Array<{ id: string; title: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    title: `held task ${index + 1}`,
  }));
}

function message(
  tasks: Array<{ id: string; title: string }>,
  heldCount = tasks.length,
  start: ProjectStart = CONFIRMED,
) {
  const projectId = randomUUID();
  return {
    projectId,
    text: projectStartedMessage({
      projectId,
      projectTitle: 'Two Codex accounts on one machine',
      start,
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

test('the Automatic switch is told in its own words, and names what the press did not answer', () => {
  const tasks = held(1);
  const { projectId, text } = message(tasks, 1, SWITCHED);
  assert.match(text, /^From Orbit · project switched on\n\n/);
  assert.ok(text.includes(
    'The account owner switched project “Two Codex accounts on one machine” '
      + `(${uuidToBase62(projectId)}) on (Automatic) at 2026-09-23T05:06:07.072Z.`,
  ));
  assert.ok(!text.includes('confirmed'), 'switching it on confirmed nothing');
  assert.ok(text.includes(`- ${tasks[0].title} (${uuidToBase62(tasks[0].id)})`));
  assert.ok(text.endsWith('Switching it on answered nothing else: if you are still waiting on the '
    + 'owner for something, ask it again.'));
});

test('the turn is keyed by what the press wrote: the confirmation, or the revision it moved to', () => {
  const project = randomUUID();
  const key = (start: ProjectStart) => projectStartedTurnId(project, start);
  assert.equal(key(CONFIRMED), key({ ...CONFIRMED, at: new Date() }), 'the same confirmation, one key');
  assert.notEqual(key(CONFIRMED), key({ ...CONFIRMED, confirmationId: randomUUID() }));
  assert.equal(key(SWITCHED), key({ ...SWITCHED, at: new Date() }), 'the same revision, one key');
  assert.notEqual(key(SWITCHED), key({ ...SWITCHED, configRevision: '4' }));
  assert.notEqual(key(SWITCHED), projectStartedTurnId(randomUUID(), SWITCHED),
    'a revision number is only unique within its project');
});

test('a reader gets the start back off the key, and nothing off any other key', () => {
  const project = randomUUID();
  assert.deepEqual(projectStartOfTurn(projectStartedTurnId(project, CONFIRMED)),
    { by: 'CONFIRMATION', confirmationId: CONFIRMED.confirmationId });
  assert.deepEqual(projectStartOfTurn(projectStartedTurnId(project, SWITCHED)),
    { by: 'SWITCH', projectId: project, configRevision: '3' });
  for (const other of [
    null,
    undefined,
    randomUUID(),
    `open-item:v1:${randomUUID()}:1727000000000`,
    'project-started:v1:',
    'project-started:v1:confirmation:not-a-uuid',
    `project-started:v1:confirmation:${randomUUID()}:extra`,
    `project-started:v1:switch:${randomUUID()}`,
    `project-started:v1:switch:${randomUUID()}:three`,
    `project-started:v1:switch:${randomUUID()}:3:extra`,
    `project-started:v1:unknown:${randomUUID()}`,
  ]) {
    assert.equal(projectStartOfTurn(other), null, `${String(other)} was read as a start`);
  }
});
