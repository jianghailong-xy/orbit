import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  API_ERROR_RETRY_BACKOFF_MS,
  MAX_API_ERROR_RETRIES,
  parseQuotaResetAt,
  type PlanUsageSnapshot,
} from '@orbit/shared';
import { encryptSecret } from '../providers/provider-crypto';
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
const CODEX_RATE_LIMITED =
  'exceeded retry limit, last status: 429 Too Many Requests, request id: 95e00d6c-68cc-4d64-b4da-01a6252260c2';

type RetryPlan = { retryAt?: Date | null; retryAttempts?: number };

const OWNER_ID = '22222222-2222-4222-8222-222222222222';
// The pool members' keys are encrypted here and read by the claim's admission test; both only need
// the same secret.
process.env.PROVIDER_SECRET_KEY ??= 'retry-arming-spec';
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
  // Each one a subscription the pool admits: a claim chooses from no other kind (isPoolCandidate).
  const rows = members.map((usage, i) => ({
    id: `member-${i}`,
    slug: `anthropic-${i}`,
    enabled: true,
    ownerId: OWNER_ID,
    runtime: 'claude',
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnc: encryptSecret(`sk-ant-oat01-member-${i}`),
    usage,
  }));
  const prisma = {
    providerPool: {
      findFirst: async ({ where }: { where: { slug: string; ownerId: string } }) =>
        where.slug === POOL && where.ownerId === OWNER_ID
          ? { engine: 'claude', members: rows.map((provider) => ({ provider })) }
          : null,
    },
    // A Claude pool holds no ChatGPT account; the claim asks after them by pool id (migration 0371).
    poolCodexLogin: { findMany: async () => [] },
  };
  const planUsage = { snapshot: (row: (typeof rows)[number]) => row.usage, usageStanding: () => null };
  return new QueueService(prisma as never, {} as never, planUsage as never);
}

/**
 * What the claim service answers for a session on no pool at all: its credential lookups say nothing, and
 * the fixed backoff stands. That is the ordinary case — a built-in engine, or a configured provider that
 * is not a pool — and the one every case below but the rate-limit pair is judged by.
 */
const noPool = {
  sharedPoolRetryAt: async () => null,
  loginPoolRetryAt: async () => null,
} as unknown as QueueService;

/** A claim service whose pool answers with `at` — what a rate limit the pool itself can speak for does. */
const poolArmsAt = (at: Date | null): QueueService =>
  ({
    sharedPoolRetryAt: async () => at,
    loginPoolRetryAt: async () => at,
  }) as unknown as QueueService;

/** The session row `retryPlanFor` reads, and the runner's quota snapshot beside it. `queue` is the
 *  claim service, which is what answers for an account pool. */
function planFor(
  session: { taskId?: string | null; retryAttempts?: number; provider?: string },
  text: string,
  queue: QueueService = noPool,
  delivered = true,
): Promise<RetryPlan> {
  const tx = transactionDouble<RetryPlanTransaction>({
    session: {
      findUnique: async () => ({
        ownerId: OWNER_ID,
        provider: session.provider ?? 'claude',
        taskId: session.taskId ?? null,
        retryAttempts: session.retryAttempts ?? 0,
        poolCodexAccountId: null,
        poolKeyId: null,
      }),
    },
    runner: { findUnique: async () => ({ planUsage: null, capabilities: [] }) },
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
        tx: RetryPlanTransaction, id: string, runnerId: string, text: string, delivered: boolean,
      ): Promise<RetryPlan>;
    }
  ).retryPlanFor(tx, 'session-1', RUNNER_ID, text, delivered);
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

// No pool answers here — a built-in Codex (or a configured provider that is not a pool) — so the fixed
// ladder is all there is. That is the ordinary case, and the one the two below are told apart from.
test('arms Codex after its 429 retries are exhausted', async () => {
  const before = Date.now();
  const plan = await planFor({ provider: 'codex', retryAttempts: 0 }, CODEX_RATE_LIMITED);
  const delay = plan.retryAt!.getTime() - before;

  assert.ok(
    delay >= API_ERROR_RETRY_BACKOFF_MS[0] && delay <= API_ERROR_RETRY_BACKOFF_MS[0] * 1.3,
    `expected the first step (+jitter), got ${delay}ms`,
  );
});

test("a rate limit the pool can speak for is armed at the pool's own moment", async () => {
  const at = new Date(Date.now() + 9 * 60_000);
  const plan = await planFor({ provider: POOL, retryAttempts: 0 }, CODEX_RATE_LIMITED, poolArmsAt(at));

  assert.deepEqual(plan.retryAt, at, 'the pool knows when the credential can run again; the ladder only guesses');
  assert.equal(plan.retryAttempts, undefined, 'the sweeper owns the count; arming must not reset it');
});

// The pool says WHEN; the budget says WHETHER. The sweep spends an attempt per re-send whatever armed
// it, so a pool answer that skipped the budget would be re-armed on every sweep for as long as the pool
// kept being rate-limited — a bounded ladder made unbounded, which is the one shape this must not have.
test('a pool-armed rate limit stops anyway once the run-failure budget is spent', async () => {
  const at = new Date(Date.now() + 9 * 60_000);
  const plan = await planFor({ provider: POOL, retryAttempts: MAX_API_ERROR_RETRIES }, CODEX_RATE_LIMITED, poolArmsAt(at));

  assert.equal(plan.retryAt, null, 'the pool knowing when does not buy more attempts');
});

test('a rate limit on a credential the pool says can still run falls back to the ladder', async () => {
  const before = Date.now();
  const plan = await planFor({ provider: POOL, retryAttempts: 0 }, CODEX_RATE_LIMITED, poolArmsAt(null));
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

test('hands back Codex 429 once the bounded retry budget is spent', async () => {
  const plan = await planFor({ provider: 'codex', retryAttempts: MAX_API_ERROR_RETRIES }, CODEX_RATE_LIMITED);

  assert.equal(plan.retryAt, null);
});

test("arms a task's run in place, like any other session", async () => {
  // Resuming the same session keeps the run's checkout and conversation; the task's own retry
  // would start a new session from nothing, and a run started by hand got none at all. The task's
  // retry waits while this one is armed (RUN_RETRY_ARMED).
  const before = Date.now();
  const plan = await planFor({ taskId: 'task-1' }, OVERLOADED);
  const delay = plan.retryAt!.getTime() - before;

  assert.ok(
    delay >= API_ERROR_RETRY_BACKOFF_MS[0] && delay <= API_ERROR_RETRY_BACKOFF_MS[0] * 1.3,
    `expected the first step (+jitter), got ${delay}ms`,
  );
});

test("arms Codex's model-at-capacity error like a 529", async () => {
  const before = Date.now();
  const plan = await planFor(
    { provider: 'codex' },
    'Selected model is at capacity. Please try a different model.',
  );
  const delay = plan.retryAt!.getTime() - before;

  assert.ok(
    delay >= API_ERROR_RETRY_BACKOFF_MS[0] && delay <= API_ERROR_RETRY_BACKOFF_MS[0] * 1.3,
    `expected the first step (+jitter), got ${delay}ms`,
  );
  assert.equal(plan.retryAttempts, undefined, 'the sweeper owns the count; arming must not reset it');
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

// A turn the runtime started for itself — a background agent or workflow reporting in — failing is
// not the person's message failing: that message was answered before the turn began, and the retry
// re-sends it. Production, 2026-09-25: four re-sends of an answered question after one 429.
test('a failure in a turn nobody delivered arms nothing and leaves an earlier arm standing', async () => {
  for (const text of [OVERLOADED, RATE_LIMITED, CODEX_RATE_LIMITED, QUOTA]) {
    assert.deepEqual(await planFor({ retryAttempts: 1 }, text, {} as never, false), {}, text);
  }
});

test('an ordinary reply in a turn nobody delivered still ends the run of failures', async () => {
  const plan = await planFor({ retryAttempts: 2 }, 'Done — all four reports are in.', {} as never, false);

  assert.deepEqual(plan, { retryAt: null, retryAttempts: 0 });
});
