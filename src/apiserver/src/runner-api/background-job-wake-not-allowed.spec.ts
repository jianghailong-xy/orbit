import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBackgroundWakeBlock } from './background-job-wake';

// A job the runner's permission gate never started ends as `killed` with the reason `not_allowed`. Nothing was
// cut short, and the owner has just answered, so the wake must not tell the agent to start it again.

const wake = (over: Record<string, unknown>) =>
  ({
    jobId: 'bgj_0123456789ab',
    trigger: 'exit',
    kind: 'job',
    command: 'npm test',
    description: null,
    status: 'killed',
    exitCode: null,
    reason: 'not_allowed',
    outputPath: '/run/bgj_0123456789ab.output',
    outputOffset: 0n,
    outputSize: 80n,
    outputExcerpt: '[orbit] Not started. The owner refused this job, so it did not run.',
    elapsedMs: null,
    idleMs: null,
    lastOutputAt: null,
    createdAt: new Date(0),
    ...over,
  }) as never;

test('a job the owner refused says it never ran, and does not say to start it again', () => {
  const block = buildBackgroundWakeBlock([wake({})]);
  assert.match(block, /ended｜killed｜reason not_allowed \(it never ran/);
  assert.match(block, /The owner refused this job/);
  assert.doesNotMatch(block, /start it again/);
});

test('a job that was really killed beside it still gets the line about starting it again', () => {
  const block = buildBackgroundWakeBlock([wake({}), wake({ jobId: 'bgj_ba9876543210', reason: 'runner_shutdown' })]);
  assert.match(block, /start it again with bg_run/);
});

// A "tell me when it's done" comes due when a job ends. The wake says where the person hears it: notify, not a
// reply they will read only when they next look. Only for an exit: output and stall wakes are news on the way.
test('an ended job points at notify for a person who asked to hear about it', () => {
  const ended = buildBackgroundWakeBlock([wake({ status: 'exited', exitCode: 0, reason: null })]);
  assert.match(ended, /^ {2}If the person asked to hear when this was done, tell them with mcp__orbit__notify/m);
  const news = buildBackgroundWakeBlock([wake({ trigger: 'output', status: 'running', reason: null })]);
  assert.doesNotMatch(news, /mcp__orbit__notify/);
});
