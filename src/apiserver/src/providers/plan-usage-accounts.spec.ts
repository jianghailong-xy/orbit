import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import {
  AgentProvider,
  codexAccountOfEnv,
  codexAccountSnapshot,
  codexRateLimitResetOf,
  planUsageBlockedUntil,
  planUsageReported,
  type PlanUsage,
  type PlanUsageRateLimitReset,
  type PlanUsageSnapshot,
  type RunnerEngineHealth,
  type RunnerHeartbeatRequest,
} from '@orbit/shared';
import { storeRefreshedCodexResetBlock } from '../runner-api/codex-reset-plan-usage';
import { RunnerApiController, type RetryPlanTransaction } from '../runner-api/runner-api.controller';
import { transactionDouble } from '../test-support/prisma-transaction-double';
import { resolveProviderExec } from './custom-provider';
import { runCodexAccount, sanitizePlanUsageAccounts } from './plan-usage-accounts';

/**
 * Codex plan usage by account. A runner with more than one Codex account reports Default's quota as
 * its Codex snapshot's own windows and every other account's under `accounts`
 * (src/runner-go/codex_account_usage.go). Here the heartbeat's planUsage write stores each account
 * as its own snapshot — read back, no account's windows are another's, whatever the Default reset
 * block's compare-and-set does to the snapshot around them — and a run's quota is judged by the
 * account it spends.
 *
 * The runner row is an in-memory double whose `updateMany` matches `planUsage` by JSON value, as
 * PostgreSQL compares jsonb (the same double codex-reset-plan-usage.spec.ts drives).
 */

const FIXTURES = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/codex-rate-limit-reset.fixtures.json'), 'utf8'),
) as { heartbeats: Record<'nestedReset', RunnerHeartbeatRequest> };

const RUNNER = { id: '11111111-1111-4111-8111-111111111111', version: null };
/** The fixture heartbeat's process. */
const A = '6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12';
/** Work: an account the runner added, by its slot id. */
const WORK = '3fa91c2e';
const WORK_HOME = '/root/.orbit/codex-accounts/3fa91c2e';
const NOW = new Date('2026-09-11T04:22:00Z');
/** When Default's and Work's windows reset: far enough out that a gate reading the real clock
 *  still finds them ahead of it. */
const DEFAULT_RESET = '2099-01-01T08:00:00Z';
const WORK_RESET = '2099-01-01T09:30:00Z';

const clone = <T>(value: T): T => structuredClone(value);

const window = (utilization: number, resetsAt: string) => ({ utilization, resetsAt, label: '5h limit', windowDurationMins: 300 });

/** Work's snapshot as the runner reads it: its own windows, never a reset block. */
const work = (utilization: number, resetsAt = WORK_RESET): PlanUsageSnapshot => ({
  provider: AgentProvider.CODEX,
  primary: window(utilization, resetsAt),
  limitId: 'codex',
  rateLimits: [{ limitId: 'codex', primary: window(utilization, resetsAt) }],
  fetchedAt: '2026-09-11T04:21:40Z',
});

/**
 * The contract's nested heartbeat from process A, Default's window `defaultUsed`% spent, its block
 * changed by `block`, and Work's snapshot beside Default's.
 */
function beat(defaultUsed: number, workSnapshot: PlanUsageSnapshot | null, block: Partial<PlanUsageRateLimitReset> = {}): RunnerHeartbeatRequest {
  const fixture = clone(FIXTURES.heartbeats.nestedReset);
  const codex = fixture.planUsage!.codex!;
  codex.primary!.utilization = defaultUsed;
  codex.rateLimits![0].primary!.utilization = defaultUsed;
  codex.rateLimitReset = { ...codex.rateLimitReset!, ...block };
  if (workSnapshot) codex.accounts = { [WORK]: workSnapshot };
  return fixture;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function harness(initial: unknown = null) {
  const row = { planUsage: clone(initial), writes: 0 };
  const prisma = {
    runner: {
      update: async () => ({ maxConcurrent: 4, minFreeDiskMb: null }),
      findUnique: async ({ select }: { select?: Record<string, boolean> }) =>
        select?.planUsage ? { planUsage: clone(row.planUsage) } : null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!('planUsage' in data)) return { count: 0 };
        const filter = where.planUsage as { equals: unknown } | undefined;
        const matches =
          filter === undefined || (filter.equals === Prisma.AnyNull ? row.planUsage === null : jsonEqual(filter.equals, row.planUsage));
        if (!matches) return { count: 0 };
        row.planUsage = clone(data.planUsage);
        row.writes += 1;
        return { count: 1 };
      },
    },
    session: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    workspace: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  };
  const realtime = { drainCancellations: async () => [], drainArtifactRequests: async () => [] };
  const controller = new RunnerApiController(
    prisma as never,
    {} as never,
    realtime as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  return {
    row,
    prisma,
    heartbeat: (dto: RunnerHeartbeatRequest) => controller.heartbeat(RUNNER, clone(dto)),
    /** The stored Codex snapshot of one account, as every reader takes it. */
    account: (id: string) => codexAccountSnapshot((row.planUsage as PlanUsage).codex!, id),
  };
}

test("a heartbeat stores each Codex account as its own snapshot, and each reads back as its own", async () => {
  const h = harness();
  await h.heartbeat(beat(62, work(8)));

  assert.equal(h.row.writes, 1);
  assert.equal(h.account('default')!.primary!.utilization, 62);
  assert.equal(h.account(WORK)!.primary!.utilization, 8);
  assert.deepEqual(h.account(WORK), work(8), "Work's snapshot is stored exactly as reported");
  // Default's reset block is Default's: stored where it always was, and nowhere on Work.
  assert.deepEqual(codexRateLimitResetOf(h.row.planUsage as PlanUsage), beat(62, null).planUsage!.codex!.rateLimitReset);
  assert.equal(h.account(WORK)!.rateLimitReset, undefined);
  assert.equal(h.account('default')!.accounts, undefined, "Default's part does not carry the others");
  // The Claude snapshot beside it is untouched.
  assert.deepEqual((h.row.planUsage as PlanUsage).claude, FIXTURES.heartbeats.nestedReset.planUsage!.claude);
});

test('a later heartbeat moves each account by its own report, even where the Default block it carries is refused', async () => {
  const h = harness();
  await h.heartbeat(beat(62, work(8), { fetchedAt: '2026-09-11T04:21:31.000Z', sequence: 8 }));
  const stored = codexRateLimitResetOf(h.row.planUsage as PlanUsage);
  // An older read of Default's block: the compare-and-set keeps the stored one and rewrites the
  // snapshot around it. Both accounts' windows are still the ones this heartbeat reported.
  await h.heartbeat(beat(70, work(9), { fetchedAt: '2026-09-11T04:21:30.123Z', sequence: 7 }));
  assert.deepEqual(codexRateLimitResetOf(h.row.planUsage as PlanUsage), stored, 'the refused block did not replace the stored one');
  assert.equal(h.account('default')!.primary!.utilization, 70);
  assert.equal(h.account(WORK)!.primary!.utilization, 9);

  // A report of Default alone leaves no stale Work behind, and a report of both brings it back.
  await h.heartbeat(beat(71, null, { fetchedAt: '2026-09-11T04:21:50.000Z', sequence: 9 }));
  assert.equal(h.account(WORK), undefined);
  assert.equal(h.account('default')!.primary!.utilization, 71);
  await h.heartbeat(beat(72, work(10), { fetchedAt: '2026-09-11T04:21:55.000Z', sequence: 10 }));
  assert.equal(h.account('default')!.primary!.utilization, 72);
  assert.equal(h.account(WORK)!.primary!.utilization, 10);
});

test("the block a reset refresh writes lands on Default and leaves Work's snapshot where it was", async () => {
  const h = harness();
  await h.heartbeat(beat(62, work(8)));
  const refreshed = {
    ...codexRateLimitResetOf(h.row.planUsage as PlanUsage)!,
    fetchedAt: '2026-09-11T04:21:45.000Z',
    sequence: 9,
    rateLimitResetCredits: { availableCount: 6, credits: null },
  };
  assert.equal(await storeRefreshedCodexResetBlock(h.prisma as never, RUNNER.id, refreshed, A), true);
  assert.deepEqual(codexRateLimitResetOf(h.row.planUsage as PlanUsage), refreshed);
  assert.deepEqual(h.account(WORK), work(8));
  assert.equal(h.account('default')!.primary!.utilization, 62);
});

test('a heartbeat carrying only other accounts stores no quota and no block for Default', async () => {
  const h = harness();
  await h.heartbeat(beat(62, work(8)));
  // A runner process that has read Work but not yet Default reports Work on a snapshot holding
  // nothing of Default's. Grafting the stored block onto it would read as usage data (contract §2).
  const onlyWork: RunnerHeartbeatRequest = {
    ...clone(FIXTURES.heartbeats.nestedReset),
    planUsage: { codex: { provider: AgentProvider.CODEX, accounts: { [WORK]: work(8) } } },
  };
  await h.heartbeat(onlyWork);
  assert.deepEqual(h.row.planUsage, onlyWork.planUsage);
  assert.equal(codexRateLimitResetOf(h.row.planUsage as PlanUsage), undefined);
  assert.equal(h.account('default'), undefined);
  assert.equal(planUsageReported(h.row.planUsage as PlanUsage, 'codex', 'default'), false);
  assert.equal(h.account(WORK)!.primary!.utilization, 8);
  // Nor does a reset refresh give such a snapshot a block of its own.
  const block = beat(62, null).planUsage!.codex!.rateLimitReset!;
  assert.equal(await storeRefreshedCodexResetBlock(h.prisma as never, RUNNER.id, { ...block, sequence: 99 }, A), false);
  assert.equal(codexRateLimitResetOf(h.row.planUsage as PlanUsage), undefined);
});

test('an account entry is stored as that account’s own windows, under an id a runner could have added', async () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`0000000${i.toString(16)}`.slice(-8), work(i)]));
  const reported: PlanUsage = {
    provider: AgentProvider.CODEX,
    primary: window(62, DEFAULT_RESET),
    accounts: {
      // Default is the snapshot's own windows, never an entry.
      default: work(1),
      '3FA91C2E': work(2),
      '../x': work(3),
      [WORK]: { ...work(8), rateLimitReset: beat(62, null).planUsage!.codex!.rateLimitReset, accounts: { [WORK]: work(4) } },
      'deadbeef': 'not a snapshot' as unknown as PlanUsageSnapshot,
    },
  };
  assert.deepEqual(sanitizePlanUsageAccounts(reported), {
    provider: AgentProvider.CODEX,
    primary: window(62, DEFAULT_RESET),
    accounts: { [WORK]: work(8) },
  });
  // Nested: the other runtimes' snapshots are left as reported.
  const nested = sanitizePlanUsageAccounts({ claude: { provider: AgentProvider.CLAUDE }, codex: { provider: AgentProvider.CODEX, accounts: many } });
  assert.equal(Object.keys(nested.codex!.accounts!).length, 16);
  assert.deepEqual(nested.claude, { provider: AgentProvider.CLAUDE });
  // Nothing usable left: no `accounts` at all, which reads as a runner with one account.
  assert.deepEqual(sanitizePlanUsageAccounts({ provider: AgentProvider.CODEX, accounts: { default: work(1) } }), { provider: AgentProvider.CODEX });
  const plain = { provider: AgentProvider.CODEX, primary: window(5, DEFAULT_RESET) } as PlanUsage;
  assert.equal(sanitizePlanUsageAccounts(plain), plain, 'a report without accounts is passed through untouched');

  const h = harness();
  await h.heartbeat({ ...beat(62, null), planUsage: { codex: { ...beat(62, null).planUsage!.codex!, accounts: reported.accounts } } });
  assert.deepEqual(Object.keys((h.row.planUsage as PlanUsage).codex!.accounts!), [WORK]);
  assert.equal(h.account(WORK)!.rateLimitReset, undefined, 'no block is stored under an account');
});

/** The runner's report of its engines: Codex with Default and Work. */
const ENGINES: RunnerEngineHealth[] = [
  {
    engine: 'codex',
    installed: true,
    auth: 'yes',
    accounts: [
      { id: 'default', codexHome: '/root/.codex', auth: 'yes' },
      { id: WORK, name: 'Work', codexHome: WORK_HOME, auth: 'yes' },
    ],
  },
];

/** Codex's words when a run hits its limit without naming when it lifts. */
const CODEX_LIMIT = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits.";

/** retryPlanFor for a quota-killed Codex session in a workspace with env `env` and the Codex account
 *  `codexAccount` picked, on a runner reporting `planUsage`. */
async function retryAtFor(
  env: Record<string, string> | null,
  planUsage: PlanUsage,
  codexAccount: string | null = null,
): Promise<Date | null | undefined> {
  const tx = transactionDouble<RetryPlanTransaction>({
    session: {
      findUnique: async () => ({
        provider: AgentProvider.CODEX,
        taskId: null,
        retryAttempts: 0,
        workspace: { env, codexAccount },
      }),
    },
    runner: { findUnique: async () => ({ planUsage, engines: ENGINES }) },
  });
  const controller = new RunnerApiController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never,
  );
  const plan = await (
    controller as unknown as {
      retryPlanFor(tx: RetryPlanTransaction, id: string, runnerId: string, text: string): Promise<{ retryAt?: Date | null }>;
    }
  ).retryPlanFor(tx, 'session-1', RUNNER.id, CODEX_LIMIT);
  return plan.retryAt;
}

const withinJitterOf = (at: Date | null | undefined, reset: string) =>
  !!at && at.getTime() >= Date.parse(reset) && at.getTime() < Date.parse(reset) + 60_000;

test('a quota-killed run is armed by the quota of the account it spends, never by Default’s for another account', async () => {
  const defaultSpent: PlanUsage = { provider: AgentProvider.CODEX, primary: window(100, DEFAULT_RESET), accounts: { [WORK]: work(8) } };
  const workSpent: PlanUsage = { provider: AgentProvider.CODEX, primary: window(62, DEFAULT_RESET), accounts: { [WORK]: work(100) } };

  assert.ok(withinJitterOf(await retryAtFor(null, defaultSpent), DEFAULT_RESET), 'a run on Default waits for Default');
  // Work's window has room: Default's spent quota says nothing about when a run on Work may go.
  assert.equal(await retryAtFor({ CODEX_HOME: WORK_HOME }, defaultSpent), undefined);
  assert.ok(withinJitterOf(await retryAtFor({ CODEX_HOME: WORK_HOME }, workSpent), WORK_RESET), 'a run on Work waits for Work');
  assert.equal(await retryAtFor(null, workSpent), undefined, "Work's spent quota does not hold Default back");
});

test("the gates' question — which account does this run spend — is its workspace's, on its runner", () => {
  assert.equal(runCodexAccount('codex', null, null, ENGINES), 'default');
  assert.equal(runCodexAccount('codex', { CODEX_HOME: WORK_HOME }, null, ENGINES), WORK);
  assert.equal(runCodexAccount('codex', { CODEX_HOME: '/srv/elsewhere' }, null, ENGINES), null);
  assert.equal(runCodexAccount('codex', { CODEX_API_KEY: 'sk-test' }, null, ENGINES), null);
  // Accounts are Codex's; any other provider's gate asks as before.
  assert.equal(runCodexAccount('claude', { CODEX_HOME: WORK_HOME }, WORK, ENGINES), undefined);

  const usage: PlanUsage = { provider: AgentProvider.CODEX, primary: window(100, DEFAULT_RESET), accounts: { [WORK]: work(8) } };
  const spent = (env: Record<string, string> | null) =>
    planUsageBlockedUntil(usage, 'codex', NOW, runCodexAccount('codex', env, null, ENGINES));
  assert.deepEqual(spent(null), new Date(DEFAULT_RESET));
  assert.equal(spent({ CODEX_HOME: WORK_HOME }), null);
  assert.equal(spent({ CODEX_HOME: '/srv/elsewhere' }), null);
});

/** A slot id the runner does not report: the workspace's pick lives on another machine, or was removed. */
const GONE = 'c0ffee42';

/** Default's 5-hour window spent, Work's with room; and the other way round. */
const DEFAULT_SPENT: PlanUsage = { provider: AgentProvider.CODEX, primary: window(100, DEFAULT_RESET), accounts: { [WORK]: work(8) } };
const WORK_SPENT: PlanUsage = { provider: AgentProvider.CODEX, primary: window(62, DEFAULT_RESET), accounts: { [WORK]: work(100) } };

/**
 * The account a Codex session in this workspace is dispatched on: the env dispatch hands the runner
 * (resolveProviderExec), read as the runner reads it. The gates judge a run by the account they name,
 * so each case below also holds that it is this one.
 */
function dispatchedOn(
  env: Record<string, string> | null,
  codexAccount: string | null | undefined,
  engines: RunnerEngineHealth[] = ENGINES,
): string | null {
  const exec = resolveProviderExec({
    declaredProvider: AgentProvider.CODEX,
    customRow: null,
    workspaceEnv: env,
    codexAccount,
    runnerEngines: engines,
  });
  return codexAccountOfEnv(exec.env, engines.find((engine) => engine.engine === 'codex')?.accounts);
}

test("a workspace that picked an account its runner reports is judged by that account's snapshot: Default's spent quota does not hold it back", async () => {
  // The pick is what the run spends, whatever CODEX_HOME the workspace's env was given by hand.
  for (const env of [null, { CODEX_HOME: '/root/.codex' }, { CODEX_HOME: '/srv/elsewhere' }]) {
    assert.equal(runCodexAccount('codex', env, WORK, ENGINES), WORK);
    assert.equal(dispatchedOn(env, WORK), WORK);
  }
  // A key of the run's own still spends no account, there as at dispatch.
  assert.equal(runCodexAccount('codex', { CODEX_API_KEY: 'sk-test' }, WORK, ENGINES), null);
  assert.equal(dispatchedOn({ CODEX_API_KEY: 'sk-test' }, WORK), null);

  const onWork = runCodexAccount('codex', null, WORK, ENGINES);
  assert.equal(planUsageBlockedUntil(DEFAULT_SPENT, 'codex', NOW, onWork), null);
  assert.deepEqual(planUsageBlockedUntil(WORK_SPENT, 'codex', NOW, onWork), new Date(WORK_RESET));
  assert.equal(planUsageReported(DEFAULT_SPENT, 'codex', onWork), true);
  // The same through a quota-killed run's retry time.
  assert.equal(await retryAtFor(null, DEFAULT_SPENT, WORK), undefined, "Default's spent quota names no moment for a run on Work");
  assert.ok(withinJitterOf(await retryAtFor(null, WORK_SPENT, WORK), WORK_RESET), 'a run on Work waits for Work');
});

test('a workspace that picked an account its runner does not report is judged by Default, where dispatch runs it', async () => {
  /** A runner too old to list its accounts. */
  const unlisted: RunnerEngineHealth[] = [{ engine: 'codex', installed: true, auth: 'yes' }];
  assert.equal(runCodexAccount('codex', null, GONE, ENGINES), 'default');
  assert.equal(dispatchedOn(null, GONE), 'default');
  assert.equal(runCodexAccount('codex', null, WORK, unlisted), 'default');
  assert.equal(dispatchedOn(null, WORK, unlisted), 'default');

  const onGone = runCodexAccount('codex', null, GONE, ENGINES);
  assert.deepEqual(planUsageBlockedUntil(DEFAULT_SPENT, 'codex', NOW, onGone), new Date(DEFAULT_RESET));
  assert.equal(planUsageBlockedUntil(WORK_SPENT, 'codex', NOW, onGone), null);
  assert.ok(withinJitterOf(await retryAtFor(null, DEFAULT_SPENT, GONE), DEFAULT_RESET), 'the run waits for Default');
  // A CODEX_HOME the env was given is then what the run spends, as it is without a pick.
  assert.equal(runCodexAccount('codex', { CODEX_HOME: WORK_HOME }, GONE, ENGINES), WORK);
  assert.equal(dispatchedOn({ CODEX_HOME: WORK_HOME }, GONE), WORK);
});

test('a workspace that picked no account is judged by its env, as before accounts could be picked', async () => {
  const accounts = ENGINES[0].accounts;
  const envs: Array<Record<string, string> | null> = [
    null,
    { CODEX_HOME: WORK_HOME },
    { CODEX_HOME: '/root/.codex' },
    { CODEX_HOME: '/srv/elsewhere' },
    { HOME: '/home/ada' },
    { CODEX_API_KEY: 'sk-test' },
  ];
  for (const env of envs) {
    // No pick, and Default picked by name, are one choice.
    for (const pick of [null, undefined, 'default']) {
      assert.equal(runCodexAccount('codex', env, pick, ENGINES), codexAccountOfEnv(env, accounts), `${JSON.stringify(env)} / ${pick}`);
      assert.equal(dispatchedOn(env, pick), codexAccountOfEnv(env, accounts), `${JSON.stringify(env)} / ${pick}`);
    }
  }
  assert.ok(withinJitterOf(await retryAtFor(null, DEFAULT_SPENT, null), DEFAULT_RESET), 'a run on Default waits for Default');
  assert.equal(await retryAtFor({ CODEX_HOME: WORK_HOME }, DEFAULT_SPENT, null), undefined);
  assert.ok(withinJitterOf(await retryAtFor({ CODEX_HOME: WORK_HOME }, WORK_SPENT, null), WORK_RESET));
});
