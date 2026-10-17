import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { RunStatus } from '@prisma/client';
import { encryptSecret } from '../providers/provider-crypto';
import {
  DSH_NOT_INSTALLED_ERROR,
  DSH_PLATFORM_UNSUPPORTED_ERROR,
  DSH_RUNNER_UPGRADE_ERROR,
  DSH_VERSION_INCOMPATIBLE_ERROR,
} from '../runner-api/runner-provider-support';
import { SessionsService } from './sessions.service';

process.env.PROVIDER_SECRET_KEY = 'dsh-install-preflight-test-key';

// A runner upgraded to one that declares dsh (provider:dsh, persisted by its heartbeat) but whose
// engine report, the same heartbeat's, says the pinned CLI is not ready (F-P7-1).
const ownerId = '22222222-2222-4222-8222-222222222222';
const id = '11111111-1111-4111-8111-111111111111';
const runtimeSessionId = '55555555-5555-4555-8555-555555555555';
const opening = { prompt: 'Continue the project', title: 'Install admission', workspaceId: 'workspace-1' };
const continuation = { clientTurnId: 'continue-1', content: 'Continue from the previous turn' };
const health = { credentialPresent: false, modelCatalogReadable: true, requestValidation: 'unknown', sandboxEnforcement: 'unknown' };
const INSTALLED = [{ engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown', dsh: { versionCompatible: true, ...health } }];
const NOT_READY: Array<[string, unknown, string]> = [
  ['no engine report', null, DSH_NOT_INSTALLED_ERROR],
  ['an empty engine report', [], DSH_NOT_INSTALLED_ERROR],
  ['a report without dsh', [{ engine: 'claude', installed: true, auth: 'yes' }], DSH_NOT_INSTALLED_ERROR],
  ['dsh not installed', [{ engine: 'dsh', installed: false, auth: 'unknown',
    installationError: "DSH_NOT_INSTALLED: DeepSeek Harness 0.2.0-rc.2 is not installed in Orbit's version directory" }], DSH_NOT_INSTALLED_ERROR],
  ['a macOS runner', [{ engine: 'dsh', installed: false, auth: 'unknown',
    installationError: 'DSH_PLATFORM_UNSUPPORTED: DeepSeek Harness 0.2.0-rc.2 is supported only on Linux x64; this runner is darwin/arm64' }], DSH_PLATFORM_UNSUPPORTED_ERROR],
  ['an installed CLI without Node 26', [{ engine: 'dsh', installed: true, auth: 'unknown',
    installationError: 'DSH_NODE_UNSUPPORTED: the service Node version is incompatible', dsh: { versionCompatible: false, ...health } }], DSH_PLATFORM_UNSUPPORTED_ERROR],
  ['another version in the directory', [{ engine: 'dsh', installed: true, version: '0.2.0-rc.1', auth: 'unknown',
    installationError: 'DSH_VERSION_INCOMPATIBLE: supported version is exactly 0.2.0-rc.2', dsh: { versionCompatible: false, ...health } }], DSH_VERSION_INCOMPATIBLE_ERROR],
  ['a version probe that failed', [{ engine: 'dsh', installed: true, auth: 'unknown',
    installationError: 'DSH_INSTALL_FAILED: DeepSeek Harness version probe failed to start', dsh: { versionCompatible: false, ...health } }], DSH_VERSION_INCOMPATIBLE_ERROR],
  ['an installed CLI with no version verdict', [{ engine: 'dsh', installed: true, version: '0.2.0-rc.2', auth: 'unknown' }], DSH_VERSION_INCOMPATIBLE_ERROR],
];
const row = (slug: string, runtime = 'dsh') => ({
  slug, runtime, enabled: true, ownerId, label: slug,
  baseUrl: 'https://api.deepseek.com/anthropic', apiKeyEnc: encryptSecret('test-dsh-key'),
  defaultModel: null, models: [], presetSlug: null, followsPreset: false,
});

function fixture(options: {
  provider?: string; providerBuiltin?: boolean; engines?: unknown; capabilities?: string[];
  status?: RunStatus;
} = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const runner = {
    id: 'runner-1', name: 'build-box', status: 'ONLINE', lastHeartbeatAt: new Date(),
    engines: options.engines ?? null, capabilities: options.capabilities ?? ['provider:claude', 'provider:dsh'],
    capabilitiesReportedAt: new Date(),
  };
  const session = {
    id, ownerId, provider: options.provider ?? 'dsh', providerBuiltin: options.providerBuiltin ?? true,
    model: null, permissionMode: 'default', usesRuntimeDefaultModel: true, runtimeSessionId, numTurns: 3,
    startedAt: new Date(), status: options.status ?? RunStatus.CANCELLED,
    assignedRunnerId: runner.id, assignedRunner: runner, owner: { preferences: {} },
    workspace: null, cancelRequestedAt: null, completedAt: null, archivedAt: null,
    deletedAt: null, mergeStatus: null, commitStatus: null,
  };
  const db = {
    user: { findUnique: async () => ({ preferences: {} }) },
    workspace: { findFirst: async () => ({ runnerId: runner.id, enableWorktree: false }) },
    runner: { findFirst: async () => runner },
    modelProvider: {
      findFirst: async ({ where }: { where: { slug: string } }) =>
        [row('harness-key')].find((provider) => provider.slug === where.slug) ?? null,
      // The owner's keys, of which `harness-key` — a DeepSeek key — is the default one the built-in `dsh`
      // resolves to (docs/provider-engine-contract.md §3.3).
      findMany: async () => [row('harness-key')],
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
    $queryRaw: async () => [{ id, workspace_id: 'workspace-1', provider: 'claude', provider_builtin: true }],
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
  return { service, creates, updates, turns, session, runner };
}

async function refusedWith(operation: () => Promise<unknown>, message: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConflictException, String(error));
    assert.equal(error.getStatus(), 409);
    assert.equal(error.message, message);
    return true;
  });
}

test('dsh install gate: creating a Harness session on a declaring runner that cannot start it is refused with why', async () => {
  for (const [label, engines, notice] of NOT_READY) {
    for (const provider of ['dsh', 'harness-key']) {
      const f = fixture({ engines });
      await refusedWith(() => f.service.create(ownerId, { ...opening, provider }), notice);
      assert.deepEqual(f.creates, [], `${label} / ${provider} wrote a session`);
    }
  }
});

test('dsh install gate: a persisted Harness session is not revived until the install, then revives as it was', async () => {
  for (const provider of ['dsh', 'harness-key']) {
    const f = fixture({ provider, providerBuiltin: provider === 'dsh', engines: NOT_READY[3][1] });
    await refusedWith(() => f.service.resume(ownerId, id, continuation), DSH_NOT_INSTALLED_ERROR);
    assert.equal(f.updates.length, 0, 'a refused resume moved the session');
    assert.equal(f.turns.length, 0, 'a refused resume queued the message');
    assert.equal(f.session.status, RunStatus.CANCELLED);
    assert.equal(f.session.runtimeSessionId, runtimeSessionId);
    // The next heartbeat reports the install finished: the same session takes the same message.
    f.runner.engines = INSTALLED as never;
    const revived = await f.service.resume(ownerId, id, continuation);
    assert.equal(revived.revived, true);
    assert.equal(f.turns.length, 1);
    assert.equal(f.turns[0].content, continuation.content);
    assert.ok(f.updates.some((data) => data.status === RunStatus.PENDING), 'the revived session was not queued for its runner');
    assert.ok(!f.updates.some((data) => 'runtimeSessionId' in data), 'the revive replaced the Harness conversation');
  }
});

test('dsh install gate: creation goes through once the engine report shows the pinned CLI ready', async () => {
  for (const provider of ['dsh', 'harness-key']) {
    const f = fixture({ engines: INSTALLED });
    await f.service.create(ownerId, { ...opening, provider });
    assert.equal(f.creates.length, 1);
    // The built-in `dsh` is written as DeepSeek Harness on the default DeepSeek key (§3.3).
    assert.equal(f.creates[0].provider, 'harness-key');
    assert.equal(f.creates[0].engine, 'dsh');
    assert.equal(f.creates[0].status, RunStatus.PENDING);
  }
});

test('dsh install gate: a runner that does not declare dsh still gets the upgrade notice first', async () => {
  for (const engines of [null, NOT_READY[3][1], INSTALLED]) {
    const created = fixture({ engines, capabilities: ['provider:claude'] });
    await refusedWith(() => created.service.create(ownerId, { ...opening, provider: 'dsh' }), DSH_RUNNER_UPGRADE_ERROR);
    const resumed = fixture({ engines, capabilities: ['provider:claude'] });
    await refusedWith(() => resumed.service.resume(ownerId, id, continuation), DSH_RUNNER_UPGRADE_ERROR);
  }
});

test('dsh install gate: other engines on the same runner do not read the Harness install', async () => {
  for (const provider of ['claude', 'codex', 'kimi', 'opencode', 'antigravity']) {
    const f = fixture({ engines: NOT_READY[3][1] });
    await f.service.create(ownerId, { ...opening, provider });
    assert.equal(f.creates[0]?.provider, provider);
  }
});
