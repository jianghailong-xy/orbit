import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinatorSessionTitle } from './coordinator-opening';

test('a project coordinator session is titled with the project name', () => {
  assert.equal(coordinatorSessionTitle('Ship the coordinator'), 'Ship the coordinator');
});

test('a project coordinator session keeps the exact project title', () => {
  assert.equal(coordinatorSessionTitle('x'.repeat(240)), 'x'.repeat(240));
});
