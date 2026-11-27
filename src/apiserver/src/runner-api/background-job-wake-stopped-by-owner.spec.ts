import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BG_JOB_STOPPED_BY_OWNER } from '@orbit/shared';
import { buildBackgroundWakeBlock } from './background-job-wake';

// A job the session's owner stopped from the app (POST /sessions/:id/background/jobs/:jobId/stop) ends `killed` with
// the reason `stopped_by_owner`. The agent did not stop it, so its wake says a person did — and, unlike a kill the
// runner's stop made, does not tell the agent to start it again: that would undo what the person just did.

const wake = (over: Record<string, unknown>) =>
  ({
    jobId: 'bgj_0123456789ab',
    trigger: 'exit',
    kind: 'job',
    command: 'sleep 600',
    description: 'a long sleep',
    status: 'killed',
    exitCode: null,
    reason: BG_JOB_STOPPED_BY_OWNER,
    outputPath: '/run/bgj_0123456789ab.output',
    outputOffset: 0n,
    outputSize: 0n,
    outputExcerpt: '',
    elapsedMs: null,
    idleMs: null,
    lastOutputAt: null,
    createdAt: new Date(0),
    ...over,
  }) as never;

test('a job the owner stopped says the person who owns the session stopped it', () => {
  const block = buildBackgroundWakeBlock([wake({})]);
  assert.match(block, /ended｜killed｜reason stopped_by_owner \(the person who owns this session stopped it from the app; you did not stop it/);
  assert.doesNotMatch(block, /start it again with bg_run/);
});

test('the agent, runner_shutdown and session_cancelled kills keep their own reasons beside it', () => {
  const block = buildBackgroundWakeBlock([
    wake({}),
    wake({ jobId: 'bgj_000000000001', reason: 'requested' }),
    wake({ jobId: 'bgj_000000000002', reason: 'runner_shutdown' }),
    wake({ jobId: 'bgj_000000000003', reason: 'session_cancelled' }),
  ]);
  assert.match(block, /ended｜killed｜reason requested\n/);
  assert.match(block, /ended｜killed｜reason runner_shutdown \(the runner process hosting it stopped/);
  assert.match(block, /ended｜killed｜reason session_cancelled \(the session was cancelled/);
  assert.equal(block.match(/stopped it from the app/g)?.length, 1, 'only the owner-stopped job names the person');
  assert.match(block, /start it again with bg_run/, 'a job the runner killed may still be started again');
});
