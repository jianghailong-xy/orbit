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

// All three paths that hand a session the coordinator role share one instruction body, so the
// rule against opening a SECOND project has to hold in all three. The delivery form is the one
// that repeats every turn, and is therefore the one that would keep re-offering the proposal.
test('every form of the coordinator role tells it to file tasks rather than propose a project', () => {
  const forms = [
    buildCoordinatorInstructions('Crawl the corpus', PROJECT_ID),
    buildCoordinatorDeliveryInstructions(PROJECT_ID),
  ];
  for (const form of forms) {
    assert.match(form, /别提议新建项目/);
    assert.match(form, /记成这个项目下的任务/);
    // The reason travels with the rule: without it this reads as an arbitrary restriction, and
    // the actual consequence — a second conversation that knows none of this one — is the point.
    assert.match(form, /一个会话只能协调一个项目/);
  }
});
