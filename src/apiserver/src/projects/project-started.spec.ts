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
  projectPausedMessage,
  projectPausedTurnId,
  projectStartOfTurn,
  projectStartedMessage,
  projectStartedTurnId,
  readProjectStartedCard,
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
const RESUMED: Extract<ProjectStart, { by: 'RESUME' }> = {
  by: 'RESUME',
  pausedAt: new Date('2026-09-23T04:00:00.000Z'),
  at: AT,
};

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

test('Resume uses the start message format for automatic and held tasks, in its own words', () => {
  const tasks = held(1);
  const { projectId, text } = message(tasks, 1, RESUMED);
  assert.match(text, /^From Orbit · project resumed\n\n/);
  assert.ok(text.includes(
    'The account owner resumed project “Two Codex accounts on one machine” '
      + `(${uuidToBase62(projectId)}) at 2026-09-23T05:06:07.072Z.`,
  ));
  assert.ok(text.includes('From now on Orbit starts this project’s tasks that are set to run on their own'));
  assert.ok(text.includes(`- ${tasks[0].title} (${uuidToBase62(tasks[0].id)})`));
  assert.ok(text.endsWith('Resuming the project answered nothing else: if you are still waiting on the '
    + 'owner for something, ask it again.'));
});

test('Pause says the whole stop, and asks the coordinator to do nothing', () => {
  const projectId = randomUUID();
  const text = projectPausedMessage({ projectId, projectTitle: 'Two Codex accounts on one machine' });
  assert.equal(text, [
    'From Orbit · project paused',
    'The account owner paused project “Two Codex accounts on one machine” '
      + `(${uuidToBase62(projectId)}).`,
    'While the project is paused, task_start is refused with 409 PROJECT_PAUSED. Orbit does not '
      + 'start any of this project’s tasks automatically and does not merge anything into main '
      + 'automatically. Sessions already running are not affected.',
    'This is a notification, not a request to start work. The project stays paused until the '
      + 'account owner presses Resume project.',
  ].join('\n\n'));
});

test('the turn is keyed by what the press wrote: confirmation, revision, or pause episode', () => {
  const project = randomUUID();
  const key = (start: ProjectStart) => projectStartedTurnId(project, start);
  assert.equal(key(CONFIRMED), key({ ...CONFIRMED, at: new Date() }), 'the same confirmation, one key');
  assert.notEqual(key(CONFIRMED), key({ ...CONFIRMED, confirmationId: randomUUID() }));
  assert.equal(key(SWITCHED), key({ ...SWITCHED, at: new Date() }), 'the same revision, one key');
  assert.notEqual(key(SWITCHED), key({ ...SWITCHED, configRevision: '4' }));
  assert.notEqual(key(SWITCHED), projectStartedTurnId(randomUUID(), SWITCHED),
    'a revision number is only unique within its project');
  assert.equal(key(RESUMED), key({ ...RESUMED, at: new Date() }),
    'replaying a Resume of the same pause episode changed its key');
  assert.notEqual(key(RESUMED), key({ ...RESUMED, pausedAt: new Date(RESUMED.pausedAt.getTime() + 1) }));
  assert.notEqual(key(RESUMED), projectStartedTurnId(randomUUID(), RESUMED));
  assert.equal(projectPausedTurnId(project, RESUMED.pausedAt),
    projectPausedTurnId(project, new Date(RESUMED.pausedAt)),
    'replaying Pause for the same episode changed its key');
});

test('a reader gets the start back off the key, and nothing off any other key', () => {
  const project = randomUUID();
  assert.deepEqual(projectStartOfTurn(projectStartedTurnId(project, CONFIRMED)),
    { by: 'CONFIRMATION', confirmationId: CONFIRMED.confirmationId });
  assert.deepEqual(projectStartOfTurn(projectStartedTurnId(project, SWITCHED)),
    { by: 'SWITCH', projectId: project, configRevision: '3' });
  assert.deepEqual(projectStartOfTurn(projectStartedTurnId(project, RESUMED)),
    { by: 'RESUME', projectId: project, pausedAt: RESUMED.pausedAt });
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
    `project-started:v1:resume:${randomUUID()}`,
    `project-started:v1:resume:${randomUUID()}:not-a-time`,
    `project-started:v1:resume:${randomUUID()}:-1`,
    `project-started:v1:resume:${randomUUID()}:9007199254740992`,
    `project-started:v1:resume:${randomUUID()}:8640000000000001`,
    `project-started:v1:resume:${randomUUID()}:1727000000000:extra`,
    projectPausedTurnId(project, RESUMED.pausedAt),
    `project-started:v1:unknown:${randomUUID()}`,
  ]) {
    assert.equal(projectStartOfTurn(other), null, `${String(other)} was read as a start`);
  }
});

test('a Resume key produces no ProjectStarted card, so every client draws the ordinary message', async () => {
  const key = projectStartOfTurn(projectStartedTurnId(randomUUID(), RESUMED));
  assert.ok(key?.by === 'RESUME');
  assert.equal(await readProjectStartedCard({} as never, randomUUID(), key), null);
});

test('a start that recorded its settings says them, and names what is not what it was asked for', () => {
  const settings = {
    line: 'PROJECT_BRANCH' as const,
    projectBranchName: 'refs/heads/project/34WvwUS8YMXfOfWbMqVuu',
    automatic: true,
    maxConcurrentTasks: 3,
    mergeCheckCommand: 'npm test',
  };
  const { text } = message([], 0, {
    ...CONFIRMED,
    record: { settings, differsFromRequest: [] },
  });
  assert.ok(text.includes('It runs with: tasks land on the project branch project/34WvwUS8YMXfOfWbMqVuu '
    + 'first · Automatic on · at most 3 tasks at a time · merge check `npm test`.'));
  assert.ok(!text.includes('Different from what the start asked for'), 'nothing differs, so nothing is named');
  assert.ok(text.endsWith('Starting the project answered nothing else: if you are still waiting on the '
    + 'owner for something, ask it again.'), 'the settings come before the last word, not after it');

  const locked = message([], 0, {
    ...CONFIRMED,
    record: {
      settings: { line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null },
      differsFromRequest: ['line', 'mergeCheckCommand'],
    },
    lineLocked: true,
  }).text;
  assert.ok(locked.includes('It runs with: tasks land directly into main · Automatic off · at most 1 '
    + 'task at a time · no merge check. Different from what the start asked for: the integration '
    + 'line, the merge check. Its integration line had already started, so it stays where it was.'));

  const unrecorded = message([], 0, CONFIRMED).text;
  assert.ok(!unrecorded.includes('It runs with'), 'a start that recorded no settings claims none');
});
