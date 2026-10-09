import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgentProvider, PermissionMode } from '@orbit/shared';
import { RunStatus } from '@prisma/client';
import { encryptSecret } from '../providers/provider-crypto';
import { providerDispatchWhereOn, resolveProviderExec } from '../providers/custom-provider';
import { DSH_RUNNER_UPGRADE_ERROR } from '../runner-api/runner-provider-support';
import { SessionsService } from './sessions.service';

process.env.PROVIDER_SECRET_KEY = 'dsh-runner-preflight-test-key';

const ownerId = '22222222-2222-4222-8222-222222222222';
const id = '11111111-1111-4111-8111-111111111111';
const opening = { prompt: 'Continue the project', title: 'Runner admission', workspaceId: 'workspace-1' };
const continuation = { clientTurnId: 'continue-1', content: 'Continue from the previous turn' };
const row = (slug: string, runtime = 'dsh', enabled = true) => ({
  slug, runtime, enabled, ownerId, label: slug,
  baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: encryptSecret('test-dsh-key'),
  defaultModel: null, models: [], presetSlug: null, followsPreset: false,
});
type ProviderRow = ReturnType<typeof row>;

function fixture(options: {
  provider?: string; providerBuiltin?: boolean; seed?: string; capabilities?: string[];
  capabilitiesReportedAt?: Date | null; rows?: ProviderRow[]; status?: RunStatus; permissionMode?: string;
} = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const runner = {
    id: 'runner-1', name: 'build-box', status: 'ONLINE', lastHeartbeatAt: new Date(),
    engines: null, capabilities: options.capabilities, capabilitiesReportedAt: options.capabilitiesReportedAt ?? null,
  };
  const session = {
    id, ownerId, provider: options.provider ?? 'dsh', providerBuiltin: options.providerBuiltin ?? true,
    model: null, permissionMode: options.permissionMode ?? 'default', usesRuntimeDefaultModel: true,
    runtimeSessionId: '55555555-5555-4555-8555-555555555555', numTurns: 3,
    startedAt: new Date(), status: options.status ?? RunStatus.FAILED,
    assignedRunnerId: runner.id, assignedRunner: runner, owner: { preferences: {} },
    workspace: null, cancelRequestedAt: null, completedAt: null, archivedAt: null,
    deletedAt: null, mergeStatus: null, commitStatus: null,
  };
  const db = {
    // An admin, for whom a shared row resolves as any row of theirs does (usableProviderScope).
    user: { findUnique: async () => ({ preferences: {}, role: 'ADMIN' }) },
    workspace: { findFirst: async () => ({ runnerId: runner.id, enableWorktree: false }) },
    runner: { findFirst: async () => runner },
    modelProvider: {
      findFirst: async ({ where }: { where: { slug: string; enabled?: boolean } }) =>
        options.rows?.find((provider) => provider.slug === where.slug &&
          (where.enabled === undefined || provider.enabled)) ?? null,
      // The owner's keys: what the built-in `dsh` picks its default DeepSeek key from (§3.3).
      findMany: async () => (options.rows ?? []).filter((provider) => provider.enabled),
    },
    providerPool: { findFirst: async () => null },
    providerSlugAlias: { findUnique: async () => null },
    session: {
      findFirst: async () => session,
      findUniqueOrThrow: async () => session,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id, ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...session, ...data };
      },
    },
    conversationTurn: {
      findUnique: async () => null, findFirst: async () => ({ seq: 3 }), count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        turns.push(data);
        return { id: 'resume-turn', ...data };
      },
    },
    $queryRaw: async () => [{
      id, workspace_id: 'workspace-1', provider: options.seed ?? 'claude',
      provider_builtin: !options.seed || options.seed === 'claude',
    }],
    $executeRaw: async () => 1,
  };
  const service = new SessionsService({
    ...db, $transaction: async (fn: (tx: typeof db) => unknown) => fn(db),
  } as never, {
    notifySessionQueued: () => undefined, accountPoolRefusal: async () => null,
  } as never, {
    publishSessionCreated: () => undefined, publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined, notifyInbox: () => undefined,
  } as never);
  return { service, creates, updates, turns, session };
}

async function rejectsUpgrade(operation: () => Promise<unknown>) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConflictException);
    assert.equal(error.message, DSH_RUNNER_UPGRADE_ERROR);
    return true;
  });
}

test('P1b dsh preflight: direct Harness creation requires a heartbeat capability', async () => {
  for (const capabilities of [undefined, [], ['provider:claude'], ['dsh'], ['provider:dsh']]) {
    for (const permissionMode of [undefined, PermissionMode.BYPASS]) {
      // The built-in `dsh` runs on the owner's default DeepSeek key (docs/provider-engine-contract.md §3.3).
      const f = fixture({ capabilities, rows: [row('my-deepseek', 'claude')],
        capabilitiesReportedAt: !capabilities || capabilities.includes('provider:dsh') ? null : new Date() });
      await rejectsUpgrade(() => f.service.create(ownerId, { ...opening, provider: 'dsh', permissionMode }));
      assert.deepEqual(f.creates, [], JSON.stringify(capabilities));
    }
  }
});

test('P1b dsh preflight: configured Harness credentials cannot bypass the runner gate', async () => {
  for (const capabilities of [undefined, [], ['provider:claude'], ['provider:dsh']]) {
    for (const inherited of [false, true]) {
      const f = fixture({ capabilities,
        capabilitiesReportedAt: !capabilities || capabilities.includes('provider:dsh') ? null : new Date(),
        rows: [row('harness-key')], seed: inherited ? 'harness-key' : undefined });
      await rejectsUpgrade(() => f.service.create(ownerId, {
        ...opening, ...(inherited ? {} : { provider: 'harness-key' }),
      }));
      assert.deepEqual(f.creates, []);
    }
  }
});

test('P1b dsh preflight: resume and config reject withdrawn direct and borrowed capabilities', async () => {
  for (const provider of ['dsh', 'harness-key']) {
    for (const operation of ['resume', 'config']) {
      for (const capabilities of [undefined, ['provider:claude'], ['provider:dsh']]) {
        const f = fixture({
          provider, providerBuiltin: provider === 'dsh', capabilities,
          capabilitiesReportedAt: !capabilities || capabilities.includes('provider:dsh') ? null : new Date(),
          rows: [row('harness-key')], status: operation === 'resume' ? RunStatus.FAILED : RunStatus.AWAITING_INPUT,
        });
        await rejectsUpgrade(() => operation === 'resume'
          ? f.service.resume(ownerId, id, continuation)
          : f.service.updateConfig(ownerId, id, { effort: 'high' }));
        assert.deepEqual(f.updates, []);
        assert.deepEqual(f.turns, []);
        assert.equal(f.session.runtimeSessionId, '55555555-5555-4555-8555-555555555555');
      }
    }
  }
});

test('P1b dsh preflight: capable runners still reject unverified Harness permissions', async () => {
  for (const operation of ['create', 'resume', 'config']) {
    // Plan has no enforceable Harness equivalent (P4); Default, Auto and Don't Ask are admitted. The built-in
    // `dsh` creates on the owner's default DeepSeek key (§3.3).
    const f = fixture({ capabilities: ['provider:dsh'], capabilitiesReportedAt: new Date(), rows: [row('my-deepseek', 'claude')],
      status: operation === 'config' ? RunStatus.AWAITING_INPUT : RunStatus.FAILED, permissionMode: PermissionMode.PLAN });
    await assert.rejects(() => operation === 'create'
      ? f.service.create(ownerId, { ...opening, provider: 'dsh', permissionMode: PermissionMode.PLAN })
      : operation === 'resume'
        ? f.service.resume(ownerId, id, continuation)
        : f.service.updateConfig(ownerId, id, { effort: 'high' }),
    (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.match(error.message, /DeepSeek Harness cannot enforce permission mode "plan"/);
      return true;
    });
    assert.deepEqual(f.creates, []);
    assert.deepEqual(f.updates, []);
    assert.deepEqual(f.turns, []);
  }
});

test('P1b dsh preflight: existing engines and legacy DeepSeek routes remain available', async () => {
  for (const provider of ['claude', 'codex', 'kimi', 'opencode', 'antigravity', 'deepseek', 'dsh']) {
    const f = fixture({ rows: [row('deepseek', 'claude'), row('dsh', 'claude')] });
    await f.service.create(ownerId, { ...opening, provider });
    assert.equal(f.creates[0].provider, provider);
    assert.equal(f.creates[0].providerBuiltin, !['deepseek', 'dsh'].includes(provider));
    const configured = ['deepseek', 'dsh'].includes(provider) ? row(provider, 'claude') : null;
    assert.equal(resolveProviderExec({
      declaredProvider: provider, declaredProviderBuiltin: f.creates[0].providerBuiltin as boolean,
      customRow: configured,
    }).provider, configured ? AgentProvider.CLAUDE : provider);
  }
});

test('P1b dsh preflight: unresolved and disabled provider identities fail closed', async () => {
  for (const rows of [[], [row('harness-key', 'dsh', false)], [row('harness-key', 'unknown-runtime')]]) {
    // A key on a protocol no engine speaks runs nowhere (PROVIDER_ENGINE_INCOMPATIBLE, §3.2).
    const explicit = fixture({ rows });
    await assert.rejects(() => explicit.service.create(ownerId, { ...opening, provider: 'harness-key' }),
      /provider.*not available|cannot run on any engine/);
    assert.deepEqual(explicit.creates, []);
    const inherited = fixture({ rows, seed: 'harness-key' });
    await assert.rejects(() => inherited.service.create(ownerId, opening), /provider.*not available|cannot run on any engine/);
    assert.deepEqual(inherited.creates, []);
    for (const operation of ['resume', 'config']) {
      const f = fixture({ rows, provider: 'harness-key', providerBuiltin: false,
        status: operation === 'resume' ? RunStatus.FAILED : RunStatus.AWAITING_INPUT });
      await assert.rejects(() => operation === 'resume'
        ? f.service.resume(ownerId, id, continuation)
        : f.service.updateConfig(ownerId, id, { effort: 'high' }), /provider (?:runtime )?(?:not available|is disabled)/);
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.turns, []);
    }
  }
});

test('P1b dsh dispatch: unknown runtimes and unavailable providers never resolve to Claude', () => {
  for (const provider of ['unknown-provider', 'kimi', 'dsh']) {
    assert.throws(() => resolveProviderExec({ declaredProvider: provider, declaredProviderBuiltin: false, customRow: null }), /provider not available/);
  }
  for (const runtime of ['claude', 'dsh']) {
    assert.throws(() => resolveProviderExec({ declaredProvider: 'harness-key', customRow: row('harness-key', runtime, false) }), /provider is disabled/);
  }
  assert.throws(() => resolveProviderExec({ declaredProvider: 'harness-key', customRow: row('harness-key', 'unknown-runtime') }), /provider runtime not available/);
  assert.throws(() => resolveProviderExec({ declaredProvider: 'harness-key',
    customRow: { ...row('harness-key', 'claude'), runtime: undefined as never } }), /provider runtime not available/);
});

test('P1b dsh dispatch: capability filters preserve configured dsh keyword collisions', async () => {
  const seen: unknown[] = [];
  const db = {
    user: { findUnique: async () => ({ role: 'ADMIN' }) },
    modelProvider: { findMany: async (query: unknown) => { seen.push(query); return [{ slug: 'harness-key' }]; } },
  };
  // A session recorded on the runtime is filtered by that alone (migration 0414); the collisions are
  // preserved where they still decide anything, on a row without an engine.
  assert.deepEqual(await providerDispatchWhereOn(db as never, ownerId, AgentProvider.DSH), {
    OR: [
      { engine: AgentProvider.DSH },
      { AND: [
        { engine: null },
        { OR: [
          { provider: AgentProvider.DSH, providerBuiltin: true },
          { provider: { in: ['harness-key'] }, providerBuiltin: false },
        ] },
      ] },
    ],
  });
  assert.deepEqual(seen[0], { where: { runtime: AgentProvider.DSH, enabled: true, OR: [{ ownerId: null }, { ownerId }] }, select: { slug: true } });
  assert.deepEqual(await providerDispatchWhereOn(db as never, ownerId, AgentProvider.ANTIGRAVITY), {
    OR: [
      { engine: AgentProvider.ANTIGRAVITY },
      { AND: [{ engine: null }, { provider: { in: ['antigravity', 'harness-key'] } }] },
    ],
  });
});
