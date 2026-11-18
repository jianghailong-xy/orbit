import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RUNTIME_STARTED_EVENT_TYPES,
  RUNTIME_STARTED_SYSTEM_SUBTYPE,
  buildResumeContinuation,
  buildUpdateResumeContinuation,
  updateContinuationVersion,
} from './resume-continuation';

test('started-signal event types cover claude output kinds', () => {
  assert.deepEqual([...RUNTIME_STARTED_EVENT_TYPES], ['assistant', 'thinking', 'tool_use']);
  assert.equal(RUNTIME_STARTED_SYSTEM_SUBTYPE, 'step_start');
});

test('the nudge tells claude to continue without repeating side effects', () => {
  const out = buildResumeContinuation('开始部署从 main 分支');
  assert.match(out, /its runner restarted/);
  assert.match(out, /never repeat any operation with side effects that has already completed/);
  assert.match(out, /开始部署从 main 分支/); // quotes the interrupted message for context
  assert.notEqual(out, '开始部署从 main 分支'); // never the verbatim original
});

test('the nudge caps a very long quoted message', () => {
  const out = buildResumeContinuation('x'.repeat(5000));
  assert.ok(out.includes('…'));
  assert.ok(out.length < 2000);
});

test('the nudge drops the quote block when there is no interrupted text', () => {
  assert.doesNotMatch(buildResumeContinuation(''), /The interrupted message/);
  assert.doesNotMatch(buildResumeContinuation(null), /The interrupted message/);
});

test('a turn the owner’s Update Now cut resumes with the update’s note, naming the release', () => {
  const out = buildUpdateResumeContinuation('backfill the missing shard rows', '0.1.254');
  assert.ok(out.startsWith('[Orbit] The runner update interrupted this turn; continue. Orbit updated its runner to 0.1.254'));
  assert.match(out, /never repeat any operation with side effects that has already completed/);
  assert.match(out, /The interrupted message:\nbackfill the missing shard rows$/);
  assert.doesNotMatch(out, /its runner restarted/);
  assert.equal(updateContinuationVersion(out), '0.1.254');
  // Without the release the runner named, it still says it was the update.
  const unnamed = buildUpdateResumeContinuation('', null);
  assert.ok(unnamed.startsWith('[Orbit] The runner update interrupted this turn; continue. Orbit updated its runner at'));
  assert.equal(updateContinuationVersion(unnamed), null);
  assert.equal(updateContinuationVersion(buildResumeContinuation('x')), undefined);
});
