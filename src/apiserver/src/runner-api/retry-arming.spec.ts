import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_ERROR_RETRY_BACKOFF_MS,
  MAX_API_ERROR_RETRIES,
  parseQuotaResetAt,
  type PlanUsageSnapshot,
} from '@orbit/shared';
import { QueueService } from '../queue/queue.service';
import { RetryPlanTransaction, RunnerApiController } from './runner-api.controller';
import { transactionDouble } from '../test-support/prisma-transaction-double';

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

const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const POOL = 'work-pool';

const inHours = (h: number): Date => new Date(Date.now() + h * 3_600_000);

/** An account pool member whose 5-hour window is spent until `resetsAt`. */
const spentUntil = (resetsAt: Date): PlanUsageSnapshot => ({
  fiveHour: { utilization: 100, resetsAt: resetsAt.toISOString() },
});

/**
 * The claim service over OWNER_ID's account pool on POOL, one member per snapshot (null: that member
 * reports none). Only the pool's rows and the quota cache are stood in for.
 */
function poolQueue(members: Array<PlanUsageSnapshot | null>): QueueService {
  const rows = members.map((usage, i) => ({ id: `member-${i}`, slug: `anthropic-${i}`, enabled: true, usage }));
  const prisma = {
    providerPool: {
      findFirst: async ({ where }: { where: { slug: string; ownerId: string } }) =>
        where.slug === POOL && where.ownerId === OWNER_ID
          ? { members: rows.map((provider) => ({ provider })) }
          : null,
    },
  };
  const planUsage = { snapshot: (row: (typeof rows)[number]) => row.usage, refused: () => false };
  return new QueueService(prisma as never, {} as never, planUsage as never);
}

/** The session row `retryPlanFor` reads, and the runner's quota snapshot beside it. `queue` is the
 *  claim service, which is what answers for an account pool. */
function planFor(
  session: { taskId?: string | null; retryAttempts?: number; provider?: string },
  text: string,
  queue: QueueService = {} as never,
): Promise<RetryPlan> {
  const tx = transactionDouble<RetryPlanTransaction>({
    session: {
      findUnique: async () => ({
        ownerId: OWNER_ID,
        provider: session.provider ?? 'claude',
        taskId: session.taskId ?? null,
        retryAttempts: session.retryAttempts ?? 0,
      }),
    },
    runner: { findUnique: async () => ({ planUsage: null }) },
  });
  const controller = new RunnerApiController(
    {} as never,
    queue,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return (
    controller as unknown as {
      retryPlanFor(
        tx: RetryPlanTransaction, id: string, runnerId: string, text: string,
      ): Promise<RetryPlan>;
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

// An account pool's slug is in no runner's snapshot, and the limit the text names is one member's.
test('an account pool re-sends now while another member has room, not at the reset its spent member named', async () => {
  const before = Date.now();
  const plan = await planFor(
    { provider: POOL },
    QUOTA,
    poolQueue([spentUntil(inHours(3)), { fiveHour: { utilization: 20, resetsAt: inHours(4).toISOString() } }]),
  );

  const delay = plan.retryAt!.getTime() - before;
  assert.ok(delay >= 0 && delay < 2 * 60_000, `expected now (+jitter), got ${plan.retryAt?.toISOString()}`);
});

test('an account pool with every member spent is armed for the EARLIEST member reset', async () => {
  const sooner = inHours(1.5);
  const plan = await planFor({ provider: POOL }, QUOTA, poolQueue([spentUntil(inHours(3)), spentUntil(sooner)]));

  const late = plan.retryAt!.getTime() - sooner.getTime();
  assert.ok(
    late >= 0 && late < 2 * 60_000,
    `expected ${sooner.toISOString()} (+jitter), got ${plan.retryAt?.toISOString()}`,
  );
});

test('an account pool no member reports on is armed as any unreported quota: for the reset the runtime named', async () => {
  const named = parseQuotaResetAt(QUOTA, new Date())!;
  const plan = await planFor({ provider: POOL }, QUOTA, poolQueue([null, null]));

  const late = plan.retryAt!.getTime() - named.getTime();
  assert.ok(
    late >= 0 && late < 2 * 60_000,
    `expected ${named.toISOString()} (+jitter), got ${plan.retryAt?.toISOString()}`,
  );
});
