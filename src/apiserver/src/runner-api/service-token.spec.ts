import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { sha256 } from '../common/crypto.util';
import { RunnerSessionsController } from './runner-sessions.controller';
import { RunnerSessionAuthGuard } from './runner-session-auth.guard';
import { ServiceTokenAuthorizer } from './service-token.authorizer';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;
const TARGET_SESSION_ID = 'target-session';

function makeAuthorizer(overrides: {
  serviceToken?: Record<string, unknown> | null;
  workspace?: Record<string, unknown> | null;
  onCreate?: (data: Record<string, unknown>) => void;
  onUpdate?: (args: unknown) => void;
}) {
  const prisma = {
    serviceToken: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        overrides.onCreate?.(data);
        return { id: 'token-1', ...data };
      },
      findFirst: async () => overrides.serviceToken ?? null,
      findMany: async () => [],
      update: async (args: unknown) => {
        overrides.onUpdate?.(args);
        return { id: 'token-1', revokedAt: new Date() };
      },
    },
    workspace: { findFirst: async () => overrides.workspace ?? null },
  };
  const jwt = new JwtService({ secret: 'test-secret' });
  return { authorizer: new ServiceTokenAuthorizer(prisma as never, jwt), jwt };
}

test('minting rejects unknown, destructive and empty scopes', async () => {
  const { authorizer } = makeAuthorizer({});
  for (const scopes of [undefined, [], ['']]) {
    await assert.rejects(
      () => authorizer.mint(RUNNER, { scopes, ttlSeconds: 3600 }),
      (error: unknown) =>
        error instanceof BadRequestException && /at least one scope/.test(error.message),
      JSON.stringify(scopes),
    );
  }
  // The lifecycle verbs are not in the vocabulary, so no token can ever carry them.
  for (const scope of ['session:end', 'session:interrupt', 'session:merge', 'session:complete']) {
    await assert.rejects(
      () => authorizer.mint(RUNNER, { scopes: [scope], ttlSeconds: 3600 }),
      (error: unknown) => error instanceof BadRequestException && /unknown scope/.test(error.message),
      scope,
    );
  }
});

test('minting bounds the lifetime and requires a workspace pin for create', async () => {
  const { authorizer } = makeAuthorizer({});
  for (const ttlSeconds of [undefined, 0, 30, 400 * 24 * 60 * 60]) {
    await assert.rejects(
      () => authorizer.mint(RUNNER, { scopes: ['session:get'], ttlSeconds }),
      (error: unknown) => error instanceof BadRequestException && /ttlSeconds/.test(error.message),
      String(ttlSeconds),
    );
  }
  await assert.rejects(
    () => authorizer.mint(RUNNER, { scopes: ['session:create'], ttlSeconds: 3600 }),
    (error: unknown) =>
      error instanceof BadRequestException && /workspace id is required/.test(error.message),
  );
});

test('a workspace pin must name a workspace that lives on the minting runner', async () => {
  const { authorizer } = makeAuthorizer({ workspace: null });
  await assert.rejects(
    () => authorizer.mint(RUNNER, { scopes: ['session:create'], workspaceId: 'workspace-x', ttlSeconds: 3600 }),
    (error: unknown) => error instanceof NotFoundException,
  );
});

test('a minted token carries its grant and stores no secret', async () => {
  let stored: Record<string, unknown> | undefined;
  const { authorizer, jwt } = makeAuthorizer({
    workspace: { id: 'workspace-1' },
    onCreate: (data) => (stored = data),
  });
  const minted = await authorizer.mint(RUNNER, {
    scopes: ['session:create', 'session:get', 'session:create'],
    workspaceId: 'workspace-1',
    label: '  feishu bridge  ',
    ttlSeconds: 3600,
  });

  assert.deepEqual(minted.scopes, ['session:create', 'session:get'], 'duplicate scopes collapse');
  assert.equal(stored?.label, 'feishu bridge');
  assert.equal(stored?.runnerId, 'runner-1');
  // Nothing about the credential is recoverable from the row: no hash, no copy of the token.
  for (const field of ['token', 'tokenHash', 'secret']) {
    assert.equal(stored?.[field], undefined, `the row stored ${field}`);
  }
  const claims = jwt.verify(minted.token, { audience: 'orbit-service-token' }) as Record<string, unknown>;
  assert.equal(claims.jti, 'token-1');
  assert.equal(claims.runnerId, 'runner-1');
  assert.equal(claims.workspaceId, 'workspace-1');
  assert.deepEqual(claims.scopes, ['session:create', 'session:get']);
});

test('verification refuses a revoked, expired or moved grant', async () => {
  const { authorizer: minter, jwt } = makeAuthorizer({ workspace: { id: 'workspace-1' } });
  const minted = await minter.mint(RUNNER, {
    scopes: ['session:get'],
    workspaceId: 'workspace-1',
    ttlSeconds: 3600,
  });

  // Revoked / expired server-side: the row query filters those out, so nothing comes back.
  const revoked = makeAuthorizer({ serviceToken: null }).authorizer;
  await assert.rejects(
    () => revoked.verify(minted.token),
    (error: unknown) =>
      error instanceof UnauthorizedException && /revoked or expired/.test(error.message),
  );

  // A row whose runner or pin no longer matches the signed claims is refused rather than guessed.
  for (const row of [
    { id: 'token-1', ownerId: 'owner-1', runnerId: 'runner-2', workspaceId: 'workspace-1', scopes: ['session:get'], runner: RUNNER },
    { id: 'token-1', ownerId: 'owner-1', runnerId: 'runner-1', workspaceId: 'workspace-2', scopes: ['session:get'], runner: RUNNER },
  ]) {
    const moved = makeAuthorizer({ serviceToken: row }).authorizer;
    await assert.rejects(
      () => moved.verify(minted.token),
      (error: unknown) => error instanceof UnauthorizedException,
      JSON.stringify(row),
    );
  }

  // A token signed for something else is not ours to judge: the guard falls through to 401.
  const foreign = await jwt.signAsync({ purpose: 'other' }, { audience: 'orbit-service-token' });
  assert.equal(await makeAuthorizer({}).authorizer.verify('not-a-jwt'), null);
  await assert.rejects(
    () => makeAuthorizer({}).authorizer.verify(foreign),
    (error: unknown) => error instanceof UnauthorizedException,
  );
});

test('the session guard accepts a runner credential or a service token, and nothing else', async () => {
  const runnerRow = { id: 'runner-1', ownerId: 'owner-1' };
  const grant = { tokenId: 'token-1', runner: runnerRow, scopes: ['session:get'], workspaceId: null };
  const guard = new RunnerSessionAuthGuard(
    {
      runner: {
        findFirst: async ({ where }: { where: { tokenHash: string } }) =>
          where.tokenHash === sha256('runner-secret') ? runnerRow : null,
      },
    } as never,
    { verify: async (token: string) => (token === 'service' ? grant : null) } as never,
  );
  const context = (token?: string) => {
    const req: Record<string, unknown> = { headers: token ? { authorization: `Bearer ${token}` } : {} };
    return { switchToHttp: () => ({ getRequest: () => req }), req } as never as {
      switchToHttp: () => { getRequest: () => Record<string, unknown> };
      req: Record<string, unknown>;
    };
  };

  const runnerCall = context('runner-secret');
  assert.equal(await guard.canActivate(runnerCall as never), true);
  assert.equal(runnerCall.req.runner, runnerRow);
  assert.equal(runnerCall.req.serviceGrant, undefined, 'a runner credential must carry no grant');

  const serviceCall = context('service');
  assert.equal(await guard.canActivate(serviceCall as never), true);
  assert.equal(serviceCall.req.serviceGrant, grant);

  await assert.rejects(
    () => guard.canActivate(context() as never),
    (error: unknown) => error instanceof UnauthorizedException,
  );
});

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
  const authorizer = {
    assert: async () => {
      throw new Error('a service-token call must never reach the orchestration authorizer');
    },
  };
  return {
    controller: new RunnerSessionsController(sessions as never, authorizer as never, {} as never),
    calls,
  };
}

const CREATE_GRANT = {
  tokenId: 'token-1',
  runner: RUNNER,
  scopes: ['session:create'],
  workspaceId: 'workspace-1',
} as never;

test('a create-scoped token starts only its own workspace, batched under the token', async () => {
  const { controller, calls } = makeController();
  const created = await controller.createSession(RUNNER, CREATE_GRANT, undefined, undefined, {
    prompt: 'relay this',
    title: 'from the bridge',
  });
  assert.deepEqual(created, { route: 'spawnForServiceToken' });
  assert.deepEqual(calls.at(-1), {
    method: 'spawnForServiceToken',
    args: [
      'owner-1',
      { assignedRunnerId: 'runner-1', workspaceId: 'workspace-1', tokenId: 'token-1' },
      { prompt: 'relay this', title: 'from the bridge', model: undefined, permissionMode: undefined },
    ],
  });

  // A cron bridge is the least-watched caller there is, so the mode it picks has to reach the
  // spawn rather than being dropped on the way — `orbit session create --permission-mode` is the
  // same flag whether or not the process happens to be inside a session.
  await controller.createSession(RUNNER, CREATE_GRANT, undefined, undefined, {
    prompt: 'nightly sweep',
    permissionMode: 'dontAsk',
  });
  assert.equal(
    (calls.at(-1)?.args[2] as { permissionMode?: string }).permissionMode,
    'dontAsk',
  );

  // The pin is the authorization, so the body cannot redirect the spawn elsewhere.
  await assert.rejects(
    () =>
      controller.createSession(RUNNER, CREATE_GRANT, undefined, undefined, {
        prompt: 'relay this',
        workspaceId: 'workspace-2',
      }),
    (error: unknown) => error instanceof ForbiddenException && /only start its own workspace/.test(error.message),
  );
});

test('every headless route is confined to the scopes and the workspace its token carries', async () => {
  const readGrant = {
    tokenId: 'token-1',
    runner: RUNNER,
    scopes: ['session:get', 'session:list', 'session:send'],
    workspaceId: 'workspace-1',
  } as never;
  const { controller, calls } = makeController();

  await controller.listSessions(RUNNER, readGrant, undefined, undefined, undefined, undefined);
  assert.deepEqual((calls.at(-1)?.args as never[])[1], {
    status: undefined,
    parentSessionId: undefined,
    scope: { assignedRunnerId: 'runner-1', workspaceId: 'workspace-1' },
  });

  await controller.getSession(RUNNER, readGrant, undefined, undefined, TARGET_SESSION_ID);
  assert.deepEqual((calls.at(-1)?.args as never[])[2], {
    assignedRunnerId: 'runner-1',
    workspaceId: 'workspace-1',
  });

  await controller.sendMessage(RUNNER, readGrant, undefined, undefined, TARGET_SESSION_ID, {
    message: 'ping',
  });
  assert.deepEqual(
    calls.slice(-2).map((call) => call.method),
    ['assertHostedByRunner', 'createTurn'],
  );

  // A scope it does not carry is refused before any work happens.
  await assert.rejects(
    () =>
      controller.createSession(RUNNER, readGrant, undefined, undefined, { prompt: 'spawn attempt' }),
    (error: unknown) =>
      error instanceof ForbiddenException && /session:create scope/.test(error.message),
  );
});

test('the runner credential alone can observe and message but never create', async () => {
  const { controller, calls } = makeController();
  await controller.listSessions(RUNNER, undefined, undefined, undefined, undefined, undefined);
  assert.deepEqual((calls.at(-1)?.args as never[])[1], {
    status: undefined,
    parentSessionId: undefined,
    scope: { assignedRunnerId: 'runner-1', workspaceId: null },
  });

  await assert.rejects(
    () => controller.createSession(RUNNER, undefined, undefined, undefined, { prompt: 'spawn attempt' }),
    (error: unknown) =>
      error instanceof ForbiddenException && /orbit token mint/.test(error.message),
    'the machine credential must not be able to spawn',
  );
});

test('a service token can never act through the session-bound orchestration path', async () => {
  const grant = {
    tokenId: 'token-1',
    runner: RUNNER,
    scopes: ['session:get', 'session:list', 'session:send', 'session:create'],
    workspaceId: 'workspace-1',
  } as never;
  const { controller, calls } = makeController();
  const routes: Array<[string, () => Promise<unknown>]> = [
    ['create', () => controller.createSession(RUNNER, grant, 'caller', 'proof', { prompt: 'x' })],
    ['list', () => controller.listSessions(RUNNER, grant, 'caller', 'proof', undefined, undefined)],
    ['search', () => controller.searchSessions(RUNNER, grant, 'caller', 'proof', 'q', '5')],
    ['get', () => controller.getSession(RUNNER, grant, 'caller', 'proof', TARGET_SESSION_ID)],
    ['send', () => controller.sendMessage(RUNNER, grant, 'caller', 'proof', TARGET_SESSION_ID, { message: 'x' })],
    ['interrupt', () => controller.interruptSession(RUNNER, grant, 'caller', 'proof', TARGET_SESSION_ID)],
    ['merge', () => controller.mergeSession(RUNNER, grant, 'caller', 'proof', TARGET_SESSION_ID, {})],
    ['end', () => controller.endSession(RUNNER, grant, 'caller', 'proof', TARGET_SESSION_ID)],
    ['complete', () => controller.completeSession(RUNNER, grant, 'caller', 'proof', TARGET_SESSION_ID)],
    ['archive', () => controller.archiveSessionCompatibility(RUNNER, grant, 'caller', 'proof', TARGET_SESSION_ID)],
  ];
  for (const [name, invoke] of routes) {
    await assert.rejects(
      invoke,
      (error: unknown) =>
        error instanceof ForbiddenException && /cannot act on behalf of a session/.test(error.message),
      name,
    );
  }
  // Even the lifecycle verbs with no calling session are refused for the same reason: no token
  // may hold them, so there is nothing to fall through to.
  for (const invoke of [
    () => controller.interruptSession(RUNNER, grant, undefined, undefined, TARGET_SESSION_ID),
    () => controller.endSession(RUNNER, grant, undefined, undefined, TARGET_SESSION_ID),
    () => controller.completeSession(RUNNER, grant, undefined, undefined, TARGET_SESSION_ID),
    () => controller.mergeSession(RUNNER, grant, undefined, undefined, TARGET_SESSION_ID, {}),
    () => controller.searchSessions(RUNNER, grant, undefined, undefined, 'q', '5'),
  ]) {
    await assert.rejects(invoke, (error: unknown) => error instanceof ForbiddenException);
  }
  assert.deepEqual(calls, [], 'no service-token call reached SessionsService');
});
