import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting } from '../src/greeting.js';

test('greets the named operator', () => {
  assert.equal(greeting('runner'), 'Hello, runner!');
});
