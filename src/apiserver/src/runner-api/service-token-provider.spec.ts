import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerSessionsController } from './runner-sessions.controller';

/**
 * `orbit session create --provider X` run by a headless process (launchd/cron) on a service token.
 * The CLI puts `provider` in the body wherever it runs, but the headless door used to drop it, so
 * the session started wherever its workspace last started and nothing said so — the account
 * owner's stand-in coordinator, started this way after a coordinator session dies, among them.
 */

// `[K3]` guards attempts at this door; nothing here is an attempt, so both calls are no-ops.
const ATTEMPTS = { assertMayEndSession: async () => undefined, chargeSteer: async () => undefined };

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;

const CREATE_GRANT = {
  tokenId: 'token-1',
  runner: RUNNER,
  scopes: ['session:create'],
  workspaceId: 'workspace-1',
} as never;

const HEADLESS_ONLY = {
  assert: async () => {
    throw new Error('a service-token call must never reach the orchestration authorizer');
  },
};

function makeController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sessions = new Proxy(
    {},
    {
      get: (_target, prop: string) => async (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return { route: prop };
      },
    },
  );
  return {
    controller: new RunnerSessionsController(
      sessions as never, HEADLESS_ONLY as never, {} as never, ATTEMPTS as never),
    calls,
  };
}

test('the provider a create-scoped token names reaches the spawn', async () => {
  const { controller, calls } = makeController();
  await controller.createSession(RUNNER, CREATE_GRANT, undefined, undefined, {
    prompt: 'take over as coordinator',
    provider: 'codex',
  });
  assert.equal(calls.at(-1)?.method, 'spawnForServiceToken');
  assert.equal((calls.at(-1)?.args[2] as { provider?: string }).provider, 'codex');
});

/** Configured providers as the database holds them; only the first is the caller's to dispatch. */
const PROVIDERS = [
  { slug: 'deepseek', runtime: 'claude', enabled: true, ownerId: 'owner-1' },
  { slug: 'switched-off', runtime: 'claude', enabled: false, ownerId: 'owner-1' },
  { slug: 'someone-elses', runtime: 'claude', enabled: true, ownerId: 'owner-2' },
];

/** The door on the real SessionsService, so a provider is followed all the way to the row. */
function makeServiceBackedController() {
  const creates: Array<Record<string, unknown>> = [];
  const prisma = {
    workspace: {
      findFirst: async () => ({
        id: 'workspace-1',
        name: 'orbit',
        runnerId: 'runner-1',
        enableWorktree: false,
        enabled: true,
        env: null,
        codexAccount: null,
        effort: null,
      }),
    },
    // What the workspace last started on: the default a dropped provider falls back to.
    $queryRaw: async () => [{ workspace_id: 'workspace-1', provider: 'claude', provider_builtin: true }],
    runner: { findFirst: async () => ({ id: 'runner-1' }) },
    user: { findUnique: async () => ({ preferences: {} }) },
    // Answers the way the database would, so a disabled row and another owner's are really
    // there and still out of reach, rather than indistinguishable from a slug nobody configured.
    modelProvider: {
      findFirst: async ({
        where,
      }: {
        where: { slug: string; enabled: boolean; OR: Array<{ ownerId: string | null }> };
      }) =>
        PROVIDERS.find(
          (row) =>
            row.slug === where.slug &&
            row.enabled === where.enabled &&
            where.OR.some((scope) => scope.ownerId === row.ownerId),
        ) ?? null,
    },
    providerPool: { findFirst: async () => null },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return { id: 'session-1', ...data, endReason: null, completedAt: null, archivedAt: null, deletedAt: null };
      },
      updateMany: async () => ({ count: 1 }),
    },
  };
  const queue = { notifySessionQueued: () => undefined, accountPoolRefusal: async () => null };
  const realtime = {
    publishSessionCreated: () => undefined,
    publishSessionUpdated: () => undefined,
    publishWorkspaceChanged: () => undefined,
  };
  const service = new SessionsService(prisma as never, queue as never, realtime as never);
  return {
    controller: new RunnerSessionsController(service, HEADLESS_ONLY as never, {} as never, ATTEMPTS as never),
    creates,
  };
}

test('the session a token starts runs on the provider it named, not the workspace default', async () => {
  for (const provider of ['codex', 'deepseek']) {
    const { controller, creates } = makeServiceBackedController();
    const created = await controller.createSession(RUNNER, CREATE_GRANT, undefined, undefined, {
      prompt: 'take over as coordinator',
      title: 'stand-in coordinator',
      provider,
    });
    assert.equal(creates.length, 1, provider);
    assert.equal(creates[0].provider, provider, provider);
    assert.equal((created as { provider?: string }).provider, provider, provider);
    // Still the pinned workspace on the token's runner: naming a provider moves nothing else.
    assert.equal(creates[0].workspaceId, 'workspace-1', provider);
    assert.equal(creates[0].assignedRunnerId, 'runner-1', provider);
  }
});

test('a provider the owner cannot dispatch is refused by name, and nothing starts on the default', async () => {
  const { controller, creates } = makeServiceBackedController();
  for (const provider of ['no-such-provider', 'switched-off', 'someone-elses']) {
    await assert.rejects(
      () =>
        controller.createSession(RUNNER, CREATE_GRANT, undefined, undefined, {
          prompt: 'take over as coordinator',
          title: 'stand-in coordinator',
          provider,
        }),
      (error: unknown) =>
        error instanceof BadRequestException &&
        error.getStatus() === 400 &&
        error.message.includes(`"${provider}"`),
      provider,
    );
  }
  assert.deepEqual(creates, [], 'a refused provider must not fall back to the default');
});
