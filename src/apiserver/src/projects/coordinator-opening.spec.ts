import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCoordinatorDeliveryInstructions,
  buildCoordinatorInstructions,
  coordinatorSessionTitle,
} from './coordinator-opening';

const PROJECT_ID = '0192f0d0-0000-7000-8000-000000000001';

test('a project coordinator session is titled with the project name', () => {
  assert.equal(coordinatorSessionTitle('Ship the coordinator'), 'Ship the coordinator');
});

test('a project coordinator session keeps the exact project title', () => {
  assert.equal(coordinatorSessionTitle('x'.repeat(240)), 'x'.repeat(240));
});

// All three paths that hand a session the coordinator role share one instruction body, so what it
// says about the work that turns up HERE has to hold in all three. The delivery form is the one
// that repeats every turn, and is therefore the one a coordinator re-reads before it proposes.
test('every form of the coordinator role files new work as tasks, and prices opening a project', () => {
  const forms = [
    buildCoordinatorInstructions('Crawl the corpus', PROJECT_ID),
    buildCoordinatorDeliveryInstructions(PROJECT_ID),
  ];
  for (const form of forms) {
    // Still the default and still first: ordinary new work belongs to the project it turned up in.
    assert.match(form, /记成这个项目下的任务/);
    // Opening one is allowed — the confirmation card is the owner's answer — but the reason
    // travels with the permission: the new project is coordinated by a conversation of its own,
    // which knows none of this one, so what the coordinator writes is all it inherits.
    assert.match(form, /可以开新项目/);
    assert.match(form, /一个会话只能协调一个项目/);
    assert.match(form, /另开一条自己的协调会话/);
  }
});

// `task_start` is refused until the owner starts the project, and a coordinator that learns it
// only from the refusal has already told the owner its tasks are running.
test('every form of the coordinator role says the start is the owner’s', () => {
  for (const form of [
    buildCoordinatorInstructions('Crawl the corpus', PROJECT_ID),
    buildCoordinatorDeliveryInstructions(PROJECT_ID),
  ]) {
    assert.match(form, /「Start the project」账号所有者还没按下时，task_start 会被拒/);
    assert.match(form, /等 Orbit 告诉你项目已开工再启动/);
  }
});
