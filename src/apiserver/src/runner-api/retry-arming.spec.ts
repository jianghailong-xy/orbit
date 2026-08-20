import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_ERROR_RETRY_BACKOFF_MS, MAX_API_ERROR_RETRIES } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

/**
 * Which retry a reply arms, decided at event ingestion. The sweeper only acts on what this
 * writes, so the classification of "will this succeed if we just send it again" lives here.
 */

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OVERLOADED =
  'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
const QUOTA = "You've hit your session limit · resets 6:20pm (Europe/Berlin)";
const RATE_LIMITED =
  "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";

type RetryPlan = { retryAt?: Date | null; retryAttempts?: number };

/** The session row `retryPlanFor` reads, and the runner's quota snapshot beside it. */
function planFor(
  session: { taskId?: string | null; retryAttempts?: number; provider?: string },
  text: string,
): Promise<RetryPlan> {
  const tx = {
    session: {
      findUnique: async () => ({
        provider: session.provider ?? 'claude',
        taskId: session.taskId ?? null,
        retryAttempts: session.retryAttempts ?? 0,
      }),
    },
    runner: { findUnique: async () => ({ planUsage: null }) },
  };
  const controller = new RunnerApiController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return (
    controller as unknown as {
      retryPlanFor(tx: unknown, id: string, runnerId: string, text: string): Promise<RetryPlan>;
    }
  ).retryPlanFor(tx, 'session-1', RUNNER_ID, text);
}

test('arms the first backoff step when the provider is overloaded', async () => {
  const before = Date.now();
  const plan = await planFor({ retryAttempts: 0 }, OVERLOADED);
  const delay = plan.retryAt!.getTime() - before;

  assert.ok(
    delay >= API_ERROR_RETRY_BACKOFF_MS[0] && delay <= API_ERROR_RETRY_BACKOFF_MS[0] * 1.3,
    `expected the first step (+jitter), got ${delay}ms`,
  );
  assert.equal(plan.retryAttempts, undefined, 'the sweeper owns the count; arming must not reset it');
});

test('walks further out as the streak grows', async () => {
  const before = Date.now();
  const plan = await planFor({ retryAttempts: 1 }, OVERLOADED);

  assert.ok(plan.retryAt!.getTime() - before >= API_ERROR_RETRY_BACKOFF_MS[1]);
});

test('arms the API key rate limit even though its status is mid-sentence', async () => {
  const before = Date.now();
  const plan = await planFor({ retryAttempts: 0 }, RATE_LIMITED);
  const delay = plan.retryAt!.getTime() - before;

  assert.ok(
    delay >= API_ERROR_RETRY_BACKOFF_MS[0] && delay <= API_ERROR_RETRY_BACKOFF_MS[0] * 1.3,
    `expected the first step (+jitter), got ${delay}ms`,
  );
});

test('hands back once the steps are spent instead of retrying forever', async () => {
  const plan = await planFor({ retryAttempts: MAX_API_ERROR_RETRIES }, OVERLOADED);

  assert.equal(plan.retryAt, null);
});

test('leaves a task-bound session to the task scheduler', async () => {
  // The same turn also fails its task, which has its own retry budget. Two schedulers reviving
  // one task is how you get two runs of it.
  const plan = await planFor({ taskId: 'task-1' }, OVERLOADED);

  assert.deepEqual(plan, {}, 'nothing written — not even a cleared count');
});

test('does not arm an error that a re-send would reproduce', async () => {
  const plan = await planFor(
    {},
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"prompt is too long: 234523 tokens > 200000 maximum"}}',
  );

  assert.deepEqual(plan, { retryAt: null, retryAttempts: 0 });
});

test('a real reply ends the streak, so the next failure starts at the first step', async () => {
  const plan = await planFor({ retryAttempts: 2 }, 'Done — the tests pass.');

  assert.deepEqual(plan, { retryAt: null, retryAttempts: 0 });
});

test('still arms a spent quota for its own reset, counting nothing against it', async () => {
  const plan = await planFor({ retryAttempts: 1 }, QUOTA);

  assert.ok(plan.retryAt instanceof Date, 'armed for the reset the runtime named');
  assert.ok(plan.retryAt!.getTime() > Date.now(), 'in the future');
  assert.equal(plan.retryAttempts, undefined);
});
