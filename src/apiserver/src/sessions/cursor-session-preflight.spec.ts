import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AgentProvider, PermissionMode } from '@orbit/shared';
import { RunStatus } from '@prisma/client';
import { CURSOR_RUNNER_UPGRADE_ERROR } from '../runner-api/runner-provider-support';
import { MOVE_REFUSAL, sessionMoveVerdict } from './session-move';
import { SessionsService } from './sessions.service';

// Cursor CLI at the session doors (project P1): a session is created, resumed and reconfigured on Cursor
// CLI only for a runner whose heartbeat declares it, in a permission mode Cursor CLI keeps.
// scripts/test-cursor-engine.mjs runs these by name.

const ownerId = '22222222-2222-4222-8222-222222222222';
const id = '11111111-1111-4111-8111-111111111111';
const opening = { prompt: 'Continue the project', title: 'Cursor admission', workspaceId: 'workspace-1' };
const continuation = { clientTurnId: 'continue-1', content: 'Continue from the previous turn' };
const DECLARED = ['provider:claude', 'provider:cursor'];

function fixture(options: {
  capabilities?: string[]; capabilitiesReportedAt?: Date | null; accountMode?: string; status?: RunStatus;
  permissionMode?: string; runsAsRoot?: boolean; provider?: string; engine?: string;
} = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const turns: Array<Record<string, unknown>> = [];
  const capabilities = options.capabilities ?? DECLARED;
  const runner = {
    id: 'runner-1', name: 'build-box', status: 'ONLINE', lastHeartbeatAt: new Date(), engines: null,
    capabilities, capabilitiesReportedAt: options.capabilitiesReportedAt === undefined ? new Date() : options.capabilitiesReportedAt,
    runsAsRoot: options.runsAsRoot ?? false,
  };
  const session = {
    id, ownerId, provider: options.provider ?? AgentProvider.CURSOR, providerBuiltin: true,
    engine: options.engine ?? AgentProvider.CURSOR,
    model: 'default[]', permissionMode: options.permissionMode ?? PermissionMode.ACCEPT_EDITS, usesRuntimeDefaultModel: true,
    runtimeSessionId: '55555555-5555-4555-8555-555555555555', numTurns: 3,
    startedAt: new Date(), status: options.status ?? RunStatus.FAILED,
    assignedRunnerId: runner.id, assignedRunner: runner, owner: { preferences: {} },
    workspace: null, cancelRequestedAt: null, completedAt: null, archivedAt: null,
    deletedAt: null, mergeStatus: null, commitStatus: null,
  };
  const preferences = options.accountMode ? { defaultPermissionMode: options.accountMode } : {};
  const db = {
    user: { findUnique: async () => ({ preferences, role: 'ADMIN' }) },
    workspace: { findFirst: async () => ({ runnerId: runner.id, enableWorktree: false }) },
    runner: { findFirst: async () => runner, findUnique: async () => runner },
    // Nothing configured: `cursor` is Cursor CLI's own sign-in, whatever row the slug's guard holds.
    modelProvider: { findFirst: async () => null, findMany: async () => [] },
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
  return { service, creates, updates, turns, session };
}

async function rejectsUpgrade(operation: () => Promise<unknown>) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConflictException);
    assert.equal(error.message, CURSOR_RUNNER_UPGRADE_ERROR);
    return true;
  });
}

async function rejectsMode(operation: () => Promise<unknown>, mode: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof BadRequestException);
    assert.equal(error.message, `Cursor CLI cannot enforce permission mode "${mode}"; use Accept Edits, Plan, Auto, Don't Ask or Bypass`);
    return true;
  });
}

test('P1 cursor preflight: a Cursor CLI session is created only on a runner whose heartbeat declares it', async () => {
  // No declaration, another runtime's, a bare word, and a declaration with no heartbeat behind it.
  for (const [capabilities, reportedAt] of [
    [[], new Date()], [['provider:claude'], new Date()], [['cursor'], new Date()], [['provider:cursor'], null],
  ] as const) {
    for (const request of [{ engine: 'cursor' }, { provider: 'cursor' }, { engine: 'cursor', provider: 'cursor' }]) {
      const f = fixture({ capabilities: [...capabilities], capabilitiesReportedAt: reportedAt });
      await rejectsUpgrade(() => f.service.create(ownerId, { ...opening, ...request }));
      assert.deepEqual(f.creates, [], JSON.stringify({ capabilities, request }));
    }
  }
  for (const request of [{ engine: 'cursor' }, { provider: 'cursor' }]) {
    const f = fixture();
    await f.service.create(ownerId, { ...opening, ...request });
    assert.equal(f.creates.length, 1);
    // Recorded on Cursor CLI for good, on the runner's own sign-in, with an id Cursor CLI mints itself.
    assert.equal(f.creates[0].engine, AgentProvider.CURSOR);
    assert.equal(f.creates[0].provider, AgentProvider.CURSOR);
    assert.equal(f.creates[0].providerBuiltin, true);
    assert.equal(f.creates[0].runtimeSessionId, null);
  }
});

test('P1 cursor preflight: a new session nobody named a mode for starts in one Cursor CLI keeps', async () => {
  for (const [accountMode, expected] of [
    [undefined, PermissionMode.ACCEPT_EDITS],
    [PermissionMode.DEFAULT, PermissionMode.ACCEPT_EDITS],
    [PermissionMode.AUTO, PermissionMode.AUTO],
    [PermissionMode.PLAN, PermissionMode.PLAN],
    [PermissionMode.DONT_ASK, PermissionMode.DONT_ASK],
    [PermissionMode.ACCEPT_EDITS, PermissionMode.ACCEPT_EDITS],
    // `--force` runs as root: a root runner keeps Bypass for Cursor CLI, unlike Claude Code.
    [PermissionMode.BYPASS, PermissionMode.BYPASS],
  ] as const) {
    const f = fixture({ accountMode, runsAsRoot: true });
    await f.service.create(ownerId, { ...opening, engine: 'cursor' });
    assert.equal(f.creates[0].permissionMode, expected, `account default ${accountMode}`);
  }
});

test('P1 cursor preflight: a mode the caller names has to be one Cursor CLI keeps', async () => {
  for (const mode of [PermissionMode.DEFAULT]) {
    const f = fixture();
    await rejectsMode(() => f.service.create(ownerId, { ...opening, engine: 'cursor', permissionMode: mode }), mode);
    assert.deepEqual(f.creates, []);
  }
  for (const mode of [PermissionMode.ACCEPT_EDITS, PermissionMode.PLAN, PermissionMode.AUTO, PermissionMode.DONT_ASK, PermissionMode.BYPASS]) {
    const f = fixture({ runsAsRoot: true });
    await f.service.create(ownerId, { ...opening, engine: 'cursor', permissionMode: mode });
    assert.equal(f.creates[0].permissionMode, mode);
  }
  // The runner refusal comes first, so an older machine is told what to update.
  const old = fixture({ capabilities: ['provider:claude'] });
  await rejectsUpgrade(() => old.service.create(ownerId, { ...opening, engine: 'cursor', permissionMode: PermissionMode.DEFAULT }));
});

test('P1 cursor preflight: resume and reconfiguration refuse a runner that withdrew the declaration, or a mode Cursor CLI refuses', async () => {
  for (const operation of ['resume', 'config'] as const) {
    const status = operation === 'resume' ? RunStatus.FAILED : RunStatus.AWAITING_INPUT;
    for (const [capabilities, reportedAt] of [[['provider:claude'], new Date()], [['provider:cursor'], null]] as const) {
      const f = fixture({ capabilities: [...capabilities], capabilitiesReportedAt: reportedAt, status });
      await rejectsUpgrade(() => operation === 'resume'
        ? f.service.resume(ownerId, id, continuation)
        : f.service.updateConfig(ownerId, id, { effort: 'high' }));
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.turns, []);
    }
    for (const mode of [PermissionMode.DEFAULT]) {
      const f = fixture({ status });
      await rejectsMode(() => operation === 'resume'
        ? f.service.resume(ownerId, id, { ...continuation, permissionMode: mode })
        : f.service.updateConfig(ownerId, id, { permissionMode: mode }), mode);
      assert.deepEqual(f.updates, []);
      assert.deepEqual(f.turns, []);
    }
  }
});

test('P1 cursor preflight: a Cursor CLI session does not move to another workspace', () => {
  const verdict = sessionMoveVerdict({
    status: RunStatus.SUCCEEDED, deletedAt: null, completedAt: new Date(), importSourceCwd: null, taskId: null,
    dispatchOrigin: 'USER', coordinatesProject: false, cancelRequestedAt: null, engineTurnActive: false,
    runningBgShells: [], runningBgJobs: [], runningSubagents: [], mergeStatus: null, commitStatus: null,
    retryAt: null, runtime: AgentProvider.CURSOR,
  } as never);
  assert.deepEqual(verdict, { reason: "Moving Cursor CLI sessions isn't supported yet.", needsEnd: false });
  assert.notEqual(verdict.reason, MOVE_REFUSAL.ENGINE_UNKNOWN);
});
