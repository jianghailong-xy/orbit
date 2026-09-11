import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import {
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V1,
  codexRateLimitResetOf,
  codexResetAccountOverride,
  codexResetRefusal,
  RunnerStatus,
  type PlanUsage,
  type PlanUsageRateLimitReset,
  type RunnerHeartbeatRequest,
} from '@orbit/shared';
import { PLAN_USAGE_CAS_ATTEMPTS, storeHeartbeatPlanUsage } from './codex-reset-plan-usage';
import { RunnerApiController } from './runner-api.controller';

/**
 * The heartbeat's planUsage write (docs/codex-rate-limit-reset-contract.md §8), named in
 * scripts/test-codex-reset-read.sh. The Codex reset block a heartbeat carries only ever replaces
 * the stored one when it is a later read: the same process out of order, an old process, a block
 * relayed by a process that did not read it, a legacy heartbeat and an invalid block all leave the
 * stored block where it was, while the rest of the report still lands. The write is a
 * compare-and-set, so a newer block that lands between the read and the write is merged against.
 *
 * The runner row is an in-memory double whose `updateMany` matches `planUsage` by JSON value, as
 * PostgreSQL compares jsonb; codex-reset-plan-usage.pg.spec.ts runs the same statement for real.
 */

const FIXTURES = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/codex-rate-limit-reset.fixtures.json'), 'utf8'),
) as {
  heartbeats: Record<'nestedReset' | 'flatReset', RunnerHeartbeatRequest>;
  blocks: { invalid: { name: string; value: unknown }[] };
};

const RUNNER = { id: '11111111-1111-4111-8111-111111111111', version: null };
/** The fixture heartbeats' process. */
const A = '6f1c2b7e-4d3a-4b8e-9c21-7a5e0d3f9b12';
/** A second process of the same runner. */
const B = '0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b';

const clone = <T>(value: T): T => structuredClone(value);

/** The nested fixture heartbeat from `leaseOwner`, its block changed by `block` (removed by null). */
function beat(leaseOwner: string | undefined, block: Partial<PlanUsageRateLimitReset> | null, utilization = 100): RunnerHeartbeatRequest {
  const { leaseOwner: _fixtureOwner, ...fixture } = clone(FIXTURES.heartbeats.nestedReset);
  const codex = fixture.planUsage!.codex!;
  codex.primary!.utilization = utilization;
  if (block === null) delete codex.rateLimitReset;
  else codex.rateLimitReset = { ...codex.rateLimitReset!, ...block };
  return { ...fixture, ...(leaseOwner ? { leaseOwner } : {}) };
}

const blockOf = (planUsage: unknown) => codexRateLimitResetOf(planUsage as PlanUsage);

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    assert.deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function harness(initial: unknown = null) {
  const row = { planUsage: clone(initial), writes: 0, misses: 0, updates: [] as Record<string, unknown>[] };
  let interleave: { write: () => void; times: number } | undefined;
  const prisma = {
    runner: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        row.updates.push(data);
        return { maxConcurrent: 4, minFreeDiskMb: null };
      },
      findUnique: async ({ select }: { select?: Record<string, boolean> }) =>
        select?.planUsage ? { planUsage: clone(row.planUsage) } : null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        // The heartbeat's other claims (a pending model-catalog refresh, say) find nothing here.
        if (!('planUsage' in data)) return { count: 0 };
        if (interleave && interleave.times > 0) {
          interleave.times -= 1;
          interleave.write();
        }
        // Without a planUsage predicate the row matches on its id alone, as it would in SQL.
        const filter = where.planUsage as { equals: unknown } | undefined;
        const matches =
          filter === undefined || (filter.equals === Prisma.AnyNull ? row.planUsage === null : jsonEqual(filter.equals, row.planUsage));
        if (!matches) {
          row.misses += 1;
          return { count: 0 };
        }
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
    /** Lands `write` just before each of the next `times` compare-and-set statements. */
    interleave(write: () => void, times = 1) {
      interleave = { write, times };
    },
    heartbeat: (dto: RunnerHeartbeatRequest) => controller.heartbeat(RUNNER, clone(dto)),
  };
}

test('a heartbeat stores the reset block losslessly: credits null, truncated details and a count above the listed rows', async () => {
  const nested = FIXTURES.heartbeats.nestedReset;
  const flat = FIXTURES.heartbeats.flatReset;
  assert.equal(blockOf(nested.planUsage)!.rateLimitResetCredits!.availableCount, 7);
  assert.equal(blockOf(nested.planUsage)!.rateLimitResetCredits!.credits!.length, 1, 'the nested fixture lists fewer credits than its count');
  assert.equal(blockOf(flat.planUsage)!.rateLimitResetCredits!.credits, null, 'the flat fixture knows only the count');
  for (const fixture of [nested, flat]) {
    const h = harness();
    await h.heartbeat(fixture);
    assert.equal(h.row.writes, 1);
    assert.deepEqual(h.row.planUsage, fixture.planUsage, 'stored exactly as reported, block included');
    assert.deepEqual(blockOf(h.row.planUsage)!.rateLimitResetCredits, blockOf(fixture.planUsage)!.rateLimitResetCredits);
    assert.equal('planUsage' in h.row.updates[0], false, 'planUsage is not written with the rest of the heartbeat');
  }
});

test('an older read delivered after a newer one — the same process out of order — cannot take the stored block back', async () => {
  const h = harness();
  const newer = beat(A, { fetchedAt: '2026-09-11T04:21:31.000Z', sequence: 8, rateLimitResetCredits: { availableCount: 6, credits: null } }, 40);
  const older = beat(A, { fetchedAt: '2026-09-11T04:21:30.123Z', sequence: 7 }, 55);
  await h.heartbeat(newer);
  await h.heartbeat(older);
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(newer.planUsage));
  assert.equal((h.row.planUsage as PlanUsage).codex!.primary!.utilization, 55, 'the rest of the late heartbeat is still stored as reported');
  await h.heartbeat(newer);
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(newer.planUsage), 'the same read again changes nothing');
});

test('an old process cannot overwrite a newer process block: an older read or the same millisecond is refused, a later read is not', async () => {
  const h = harness();
  const fromB = beat(B, { fetchedAt: '2026-09-11T04:21:40.000Z', generation: B, sequence: 1 });
  await h.heartbeat(fromB);
  await h.heartbeat(beat(A, { fetchedAt: '2026-09-11T04:21:30.123Z', generation: A, sequence: 41 }));
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(fromB.planUsage), 'an old process still reporting an older read');
  await h.heartbeat(beat(A, { fetchedAt: '2026-09-11T04:21:40.000Z', generation: A, sequence: 42 }));
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(fromB.planUsage), 'the same millisecond from another process keeps what is stored');
  const later = beat(A, { fetchedAt: '2026-09-11T04:21:50.000Z', generation: A, sequence: 43 });
  await h.heartbeat(later);
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(later.planUsage), 'a later read replaces it, whichever process made it');
});

test('a block the heartbeat process did not read, or any block on a heartbeat without a leaseOwner, is never stored', async () => {
  const nested = FIXTURES.heartbeats.nestedReset;
  const h = harness();
  await h.heartbeat(nested);
  await h.heartbeat(beat(B, { fetchedAt: '2026-09-11T04:21:50.000Z', generation: A, sequence: 8 }));
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(nested.planUsage), 'a block relayed by another process');
  await h.heartbeat(beat(undefined, { fetchedAt: '2026-09-11T04:21:55.000Z', sequence: 9 }));
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(nested.planUsage), 'a legacy heartbeat');

  const empty = harness();
  await empty.heartbeat(beat(B, { fetchedAt: '2026-09-11T04:21:50.000Z', generation: A, sequence: 8 }, 33));
  assert.equal(blockOf(empty.row.planUsage), undefined, 'nothing stored yet is no reason to store a refused block');
  assert.equal((empty.row.planUsage as PlanUsage).codex!.primary!.utilization, 33, 'the rest of that heartbeat is stored');
});

test('a Codex snapshot without a block or with an invalid one keeps the stored block, and a heartbeat without Codex usage is stored as before', async () => {
  const nested = FIXTURES.heartbeats.nestedReset;
  const h = harness();
  await h.heartbeat(nested);
  await h.heartbeat(beat(A, null, 12));
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(nested.planUsage), 'a Codex snapshot without a block');
  assert.equal((h.row.planUsage as PlanUsage).codex!.primary!.utilization, 12);
  await h.heartbeat(beat(A, { fetchedAt: '2026-09-11T04:21:50.000Z', sequence: 0 }));
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(nested.planUsage), 'an invalid block');

  const claudeOnly: RunnerHeartbeatRequest = {
    status: RunnerStatus.ONLINE,
    idleCapacity: 1,
    leaseOwner: A,
    planUsage: clone(nested.planUsage!.claude!),
  };
  await h.heartbeat(claudeOnly);
  assert.deepEqual(h.row.planUsage, claudeOnly.planUsage, 'no reset-only Codex snapshot is grafted onto a report without Codex usage');
});

test('a block carrying raw account data is refused and never stored', async () => {
  const raw = FIXTURES.blocks.invalid.find((fixture) => fixture.name === 'fingerprint-raw-account-id');
  assert.ok(raw, 'the contract fixture for a raw account id is present');
  const h = harness();
  const dto = beat(A, null);
  dto.planUsage!.codex!.rateLimitReset = clone(raw.value) as PlanUsageRateLimitReset;
  await h.heartbeat(dto);
  const withEmail = beat(A, { fetchedAt: '2026-09-11T04:21:50.000Z', sequence: 8 });
  Object.assign(withEmail.planUsage!.codex!.rateLimitReset!, { accountId: 'acct_fixture_primary', email: 'fixture@example.invalid' });
  await h.heartbeat(withEmail);
  assert.equal(blockOf(h.row.planUsage), undefined);
  const stored = JSON.stringify(h.row.planUsage);
  for (const secret of ['acct_fixture_primary', 'fixture@example.invalid']) {
    assert.equal(stored.includes(secret), false, `${secret} was stored`);
  }
});

test('the write is a compare-and-set: a newer block stored between the read and the write is merged against, never overwritten', async () => {
  const nested = FIXTURES.heartbeats.nestedReset;
  const h = harness(nested.planUsage);
  const concurrent = beat(B, { fetchedAt: '2026-09-11T04:21:59.000Z', generation: B, sequence: 3 }, 90).planUsage;
  h.interleave(() => {
    h.row.planUsage = clone(concurrent);
  });
  const late = beat(A, { fetchedAt: '2026-09-11T04:21:45.000Z', sequence: 8 }, 77);
  await h.heartbeat(late);
  assert.equal(h.row.misses, 1, 'the write merged against the value that was replaced is refused');
  assert.deepEqual(blockOf(h.row.planUsage), blockOf(concurrent), 'the newer block that landed in between survives');
  assert.equal((h.row.planUsage as PlanUsage).codex!.primary!.utilization, 77, 'and this heartbeat still lands, merged against it');
});

test('a writer that keeps losing gives up after PLAN_USAGE_CAS_ATTEMPTS attempts without writing', async () => {
  const nested = FIXTURES.heartbeats.nestedReset;
  const h = harness(nested.planUsage);
  let step = 0;
  h.interleave(() => {
    step += 1;
    h.row.planUsage = beat(B, { fetchedAt: `2026-09-11T04:21:5${step}.000Z`, generation: B, sequence: step }, step).planUsage;
  }, Number.MAX_SAFE_INTEGER);
  const written = await storeHeartbeatPlanUsage(h.prisma as never, RUNNER.id, beat(A, { fetchedAt: '2026-09-11T04:21:45.000Z', sequence: 8 }).planUsage!, A);
  assert.equal(written, false);
  assert.equal(h.row.misses, PLAN_USAGE_CAS_ATTEMPTS);
  assert.equal(h.row.writes, 0);
  assert.equal(blockOf(h.row.planUsage)!.generation, B, 'what the other writer stored stays');
});

test('an override context never opens reset on the stored default-account block, and unsupported auth is refused on its own', async () => {
  const h = harness();
  const readAt = new Date(Date.now() - 60_000).toISOString();
  await h.heartbeat(beat(A, { fetchedAt: readAt, sequence: 9 }));
  const stored = blockOf(h.row.planUsage);
  const fingerprint = stored?.accountFingerprint;
  assert.ok(fingerprint);
  const refusal = (accountOverride: boolean, rateLimitReset: PlanUsageRateLimitReset | undefined) =>
    codexResetRefusal({
      now: new Date(),
      accountOverride,
      activeOperation: false,
      runnerOnline: true,
      // Declared here by hand: a runner declares it only once consume and the relay exist.
      runnerCapabilities: [CODEX_RATE_LIMIT_RESET_CAPABILITY_V1],
      heartbeatLeaseOwner: A,
      runnerDraining: false,
      rateLimitReset,
      expectedAccountFingerprint: fingerprint,
    });
  assert.equal(refusal(false, stored), null, 'on the runner page the default account is eligible');
  for (const context of [
    { provider: 'codex', env: { CODEX_HOME: '/srv/another-codex-home' } },
    { provider: 'codex', env: { CODEX_API_KEY: 'orbit-test-key' } },
    { provider: 'codex', env: { OPENAI_API_KEY: 'orbit-test-key' } },
    { provider: 'codex', env: { OPENAI_BASE_URL: 'https://proxy.invalid/v1' } },
    { provider: 'custom-openai-provider', env: {} },
  ]) {
    assert.equal(refusal(codexResetAccountOverride(context), stored), 'ACCOUNT_OVERRIDE', JSON.stringify(context));
  }

  const apiKey = beat(A, null);
  apiKey.planUsage!.codex!.rateLimitReset = {
    protocolVersion: 1,
    support: 'UNSUPPORTED_AUTH',
    rateLimitResetCredits: null,
    fetchedAt: new Date(Date.now() - 30_000).toISOString(),
    generation: A,
    sequence: 10,
  };
  await h.heartbeat(apiKey);
  const unsupported = blockOf(h.row.planUsage);
  assert.equal(unsupported?.support, 'UNSUPPORTED_AUTH');
  assert.equal(unsupported?.accountFingerprint, undefined);
  assert.equal(refusal(false, unsupported), 'UNSUPPORTED_AUTH');
});
