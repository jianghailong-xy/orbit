import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_STARTED_EVENT_TYPES, buildResumeContinuation } from './resume-continuation';

test('started-signal event types cover claude output kinds', () => {
  assert.deepEqual([...CLAUDE_STARTED_EVENT_TYPES], ['assistant', 'thinking', 'tool_use']);
});

test('the nudge tells claude to continue without repeating side effects', () => {
  const out = buildResumeContinuation('开始部署从 main 分支');
  assert.match(out, /runner 重启/);
  assert.match(out, /切勿重复执行/);
  assert.match(out, /开始部署从 main 分支/); // quotes the interrupted message for context
  assert.notEqual(out, '开始部署从 main 分支'); // never the verbatim original
});

test('the nudge caps a very long quoted message', () => {
  const out = buildResumeContinuation('x'.repeat(5000));
  assert.ok(out.includes('…'));
  assert.ok(out.length < 2000);
});

test('the nudge drops the quote block when there is no interrupted text', () => {
  assert.doesNotMatch(buildResumeContinuation(''), /被中断的消息/);
  assert.doesNotMatch(buildResumeContinuation(null), /被中断的消息/);
});
