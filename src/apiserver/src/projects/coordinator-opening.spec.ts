import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coordinatorSessionTitle } from './coordinator-opening';

test('a project coordinator session is titled with the project name', () => {
  assert.equal(coordinatorSessionTitle('Ship the coordinator'), 'Coordinator: Ship the coordinator');
});

test('a project coordinator session title stays within the session title limit', () => {
  const title = coordinatorSessionTitle('x'.repeat(100));

  assert.equal(title.length, 80);
  assert.equal(title, `Coordinator: ${'x'.repeat(67)}`);
});
