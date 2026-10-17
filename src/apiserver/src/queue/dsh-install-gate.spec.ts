import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentProvider, SESSION_SOURCE_PIN_V1 } from '@orbit/shared';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  DSH_NOT_INSTALLED_ERROR,
  DSH_PLATFORM_UNSUPPORTED_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  DSH_VERSION_INCOMPATIBLE_ERROR,
  dshRuntimeUnavailable,
} from '../runner-api/runner-provider-support';
import { QueueService } from './queue.service';

const runner = { id: '11111111-1111-4111-8111-111111111111', ownerId: '22222222-2222-4222-8222-222222222222' };
const header = 'claude,codex,kimi,opencode,antigravity,dsh';
const health = { credentialPresent: false, modelCatalogReadable: true, requestValidation: 'unknown', sandboxEnforcement: 'unknown' };
const INSTALLED = [{ engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown', dsh: { versionCompatible: true, ...health } }];
const NOT_INSTALLED = [{ engine: 'dsh', installed: false, auth: 'unknown', installationError: 'DSH_NOT_INSTALLED' }];

test('dsh install gate: the engine report decides whether a declaring runner can start dsh', () => {
  assert.equal(dshRuntimeUnavailable(INSTALLED), null);
  // As stored by the heartbeat (code only) and as the runner sends it (code and sentence).
  for (const engines of [NOT_INSTALLED, [{ ...NOT_INSTALLED[0], installationError: 'DSH_NOT_INSTALLED: stat …/engines/dsh/0.2.0-rc.2' }]]) {
    assert.equal(dshRuntimeUnavailable(engines), DSH_NOT_INSTALLED_ERROR);
  }
  // Not knowing is not installed: nothing reported, nothing about dsh, or nothing readable.
  for (const engines of [undefined, null, [], {}, 'dsh', [{ engine: 'claude', installed: true, auth: 'yes' }], [{ engine: 'dsh' }], [{ engine: 'dsh', installed: 'true' }]]) {
    assert.equal(dshRuntimeUnavailable(engines), DSH_NOT_INSTALLED_ERROR, JSON.stringify(engines));
  }
  for (const code of ['DSH_PLATFORM_UNSUPPORTED', 'DSH_NODE_UNSUPPORTED']) {
    for (const installed of [false, true]) {
      assert.equal(dshRuntimeUnavailable([{ engine: 'dsh', installed, auth: 'unknown', installationError: code }]), DSH_PLATFORM_UNSUPPORTED_ERROR);
    }
  }
  for (const report of [
    { ...INSTALLED[0], dsh: { ...INSTALLED[0].dsh, versionCompatible: false } },
    { ...INSTALLED[0], installationError: 'DSH_VERSION_INCOMPATIBLE' },
    { ...INSTALLED[0], installationError: 'DSH_INSTALL_FAILED', dsh: { ...INSTALLED[0].dsh, versionCompatible: false } },
    { engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown' },
  ]) {
    assert.equal(dshRuntimeUnavailable([report]), DSH_VERSION_INCOMPATIBLE_ERROR, JSON.stringify(report));
  }
  // A request validation or credential verdict is the session's business, not the install's.
  assert.equal(dshRuntimeUnavailable([{ ...INSTALLED[0], dsh: { ...INSTALLED[0].dsh, requestValidation: 'invalid', diagnostic: 'DSH_CREDENTIAL_INVALID' } }]), null);
  // The clients read these as their existing repairs (web dshRepair, OrbitKit DshRuntime.repair).
  assert.ok(DSH_NOT_INSTALLED_ERROR.includes('DSH_NOT_INSTALLED'));
  assert.ok(DSH_PLATFORM_UNSUPPORTED_ERROR.startsWith('DSH_PLATFORM_UNSUPPORTED'));
  for (const notice of [DSH_NOT_INSTALLED_ERROR, DSH_PLATFORM_UNSUPPORTED_ERROR, DSH_VERSION_INCOMPATIBLE_ERROR]) {
    assert.ok(!notice.startsWith('DeepSeek Harness requires a newer Orbit runner'), notice);
  }
  // The install is where the clients' runner-state hints send it (web DSH_STATE_HINT, OrbitKit DshRuntime): Infrastructure.
  assert.equal(
    DSH_NOT_INSTALLED_ERROR,
    'DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet; ' +
      'install it from Infrastructure, then try again',
  );
  assert.equal(
    DSH_VERSION_INCOMPATIBLE_ERROR,
    'DSH_VERSION_INCOMPATIBLE: this runner has a DeepSeek Harness version Orbit does not support; ' +
      'reinstall it from Infrastructure, then try again',
  );
});

function claimController(snapshot: unknown) {
  const handed: Array<{ supportedProviders: readonly AgentProvider[]; dshUnavailable?: string | null }> = [];
  const marked: Array<{ where: unknown; data: { error: string } }> = [];
  const prisma = {
    runner: { findUnique: async () => snapshot },
    // An admin, for whom the configured rows on a runtime include the shared ones (usableProviderScope).
    user: { findUnique: async () => ({ role: 'ADMIN' }) },
    modelProvider: { findMany: async ({ where }: { where: { runtime: string } }) =>
      where.runtime === 'dsh' ? [{ slug: 'harness-key' }] : [] },
    session: {
      findMany: async () => [{ id: 'native', error: null }],
      updateMany: async (args: { where: unknown; data: { error: string } }) => { marked.push(args); return { count: 1 }; },
    },
  };
  const queue = { claimSessionForRunner: async (value: (typeof handed)[number]) => { handed.push(value); return null; } };
  const api = new RunnerApiController(prisma as never, queue as never,
    { publishSessionCreated() {}, notifyInbox() {} } as never, {} as never, {} as never, {} as never,
    { appendFor: async (_tx: unknown, _id: unknown, text: string) => text } as never);
  return { api, handed, marked };
}

test('dsh install gate: a declaring runner without the CLI keeps its declaration and the queue is told why it cannot start dsh', async () => {
  for (const [engines, notice] of [
    [undefined, DSH_NOT_INSTALLED_ERROR],
    [NOT_INSTALLED, DSH_NOT_INSTALLED_ERROR],
    [[{ engine: 'dsh', installed: false, auth: 'unknown', installationError: 'DSH_PLATFORM_UNSUPPORTED' }], DSH_PLATFORM_UNSUPPORTED_ERROR],
    [[{ ...INSTALLED[0], dsh: { ...INSTALLED[0].dsh, versionCompatible: false } }], DSH_VERSION_INCOMPATIBLE_ERROR],
  ] as const) {
    const f = claimController({ capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date(), engines });
    await f.api.claim(runner, SESSION_SOURCE_PIN_V1, header);
    assert.equal(f.handed.length, 1);
    assert.ok(f.handed[0].supportedProviders.includes(AgentProvider.DSH), 'the protocol declaration was rewritten');
    assert.equal(f.handed[0].dshUnavailable, notice);
    assert.equal(f.marked.length, 0, 'the upgrade notice was stamped on a runner that declares dsh');
  }
});

test('dsh install gate: an installed CLI is handed dsh rows, and a runner without the declaration still waits for an upgrade', async () => {
  const ready = claimController({ capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date(), engines: INSTALLED });
  await ready.api.claim(runner, SESSION_SOURCE_PIN_V1, header);
  assert.ok(ready.handed[0].supportedProviders.includes(AgentProvider.DSH));
  assert.ok(!('dshUnavailable' in ready.handed[0]), 'a ready runner was handed a reason');
  assert.equal(ready.marked.length, 0, 'a ready runner stamped a notice');

  for (const [request, snapshot] of [
    [header, { capabilities: [], capabilitiesReportedAt: new Date(), engines: INSTALLED }],
    ['claude,codex,opencode,antigravity', { capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date(), engines: NOT_INSTALLED }],
  ] as const) {
    const f = claimController(snapshot);
    await f.api.claim(runner, SESSION_SOURCE_PIN_V1, request);
    assert.ok(!f.handed[0].supportedProviders.includes(AgentProvider.DSH));
    assert.ok(!('dshUnavailable' in f.handed[0]));
    assert.deepEqual(f.marked.map((m) => m.data.error), [DSH_RUNNER_UPGRADE_ERROR]);
  }
});

test('dsh install gate: the queue holds the runner\'s dsh rows with the notice and leaves its other rows alone', async () => {
  const pending = (id: string, provider: string, error: string | null) => ({
    id, ownerId: runner.ownerId, provider, providerBuiltin: true, error,
    codexAccount: null, codexAccountPinned: false, claudeAccount: null, claudeAccountPinned: false,
    workspace: { env: null, codexAccount: null, claudeAccount: null },
    assignedRunner: { engines: null, accountPauses: null, planUsage: null, capabilities: [] },
  });
  for (const dshUnavailable of [DSH_NOT_INSTALLED_ERROR, undefined]) {
    const asked: Array<{ OR: unknown[] }> = [];
    const marked: Array<{ where: { id: string }; data: { error: string } }> = [];
    const published: string[] = [];
    let claim: { strings: readonly string[]; values: readonly unknown[] } | undefined;
    const tx = {
      $executeRaw: async () => 0,
      $queryRaw: async (...args: unknown[]) => { claim = renderRawQuery(args); return []; },
    };
    const prisma = {
      session: {
        findMany: async ({ where }: { where: { OR: unknown[] } }) => {
          asked.push(where);
          return [pending('waiting', 'dsh', null), pending('marked', 'dsh', DSH_NOT_INSTALLED_ERROR), pending('claude-row', 'claude', null)];
        },
        updateMany: async (args: (typeof marked)[number]) => { marked.push(args); return { count: 1 }; },
      },
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as never;
    await new QueueService(prisma, { publishSessionUpdated: (id: string) => published.push(id) } as never)
      .claimSessionForRunner({ id: runner.id, supportedProviders: [AgentProvider.CLAUDE, AgentProvider.DSH], dshUnavailable });
    assert.ok(claim, 'the claim did not run');
    const pausedAt = claim.strings.findIndex((segment, i) => i > 0 && segment.startsWith('::uuid[]))'));
    const paused = claim.values[pausedAt - 1];
    if (dshUnavailable) {
      assert.ok(asked[0].OR.some((clause) => JSON.stringify(clause) === JSON.stringify({ provider: 'dsh', providerBuiltin: true })));
      assert.deepEqual(paused, ['waiting', 'marked']);
      assert.deepEqual(marked, [{ where: { id: 'waiting', status: 'PENDING' }, data: { error: DSH_NOT_INSTALLED_ERROR } }]);
      assert.deepEqual(published, ['waiting']);
    } else {
      assert.ok(!asked[0].OR.some((clause) => JSON.stringify(clause).includes('"dsh"')));
      assert.deepEqual(paused, []);
      assert.deepEqual(marked, []);
    }
  }
});

async function claimStatement(dshUnavailable: string | null) {
  let sql: { strings: readonly string[]; values: readonly unknown[] } | undefined;
  let settings: { strings: readonly string[]; values: readonly unknown[] } | undefined;
  const tx = {
    $executeRaw: async (...args: unknown[]) => {
      const rendered = renderRawQuery(args);
      if (rendered.text.includes('orbit.runner_supports_dsh')) settings = rendered;
      return 0;
    },
    $queryRaw: async (...args: unknown[]) => { sql = renderRawQuery(args); return []; },
  };
  const prisma = {
    session: { findMany: async () => [] },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never;
  await new QueueService(prisma, { publishSessionUpdated() {} } as never)
    .claimSessionForRunner({ id: runner.id, supportedProviders: [AgentProvider.CLAUDE, AgentProvider.DSH], dshUnavailable });
  assert.ok(sql && settings, 'the claim did not run');
  const gucIndex = settings.strings.findIndex((segment) => segment.includes("'orbit.runner_supports_dsh', "));
  // The capability bound in front of the persisted-declaration check of the dsh predicate.
  const predicate = sql.strings.findIndex((segment, i) => i > 0 && segment.includes('SELECT 1 FROM "runner" r WHERE r.id ='));
  return { guc: settings.values[gucIndex], capability: sql.values[predicate - 1], values: sql.values };
}

test('dsh install gate: the claim statement and database guard withhold dsh while the CLI is not ready, and a claim clears the notice', async () => {
  const waiting = await claimStatement(DSH_NOT_INSTALLED_ERROR);
  assert.equal(waiting.guc, '0');
  assert.equal(waiting.capability, false);
  const ready = await claimStatement(null);
  assert.equal(ready.guc, '1');
  assert.equal(ready.capability, true);
  for (const notice of [DSH_NOT_INSTALLED_ERROR, DSH_PLATFORM_UNSUPPORTED_ERROR, DSH_VERSION_INCOMPATIBLE_ERROR, DSH_RUNNER_UPGRADE_ERROR]) {
    assert.ok(ready.values.includes(notice), `a claim keeps ${notice}`);
  }
});
