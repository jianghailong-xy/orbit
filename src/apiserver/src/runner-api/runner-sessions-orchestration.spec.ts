import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SessionsService } from '../sessions/sessions.service';
import { RunnerSessionsController } from './runner-sessions.controller';

const RUNNER = { id: 'runner-1', ownerId: 'owner-1' } as never;
const CALLER_SESSION_ID = 'caller-session';
const ORCHESTRATION_TOKEN = 'signed-session-credential';
const TARGET_SESSION_ID = 'target-session';

type RouteCase = {
  name: string;
  invoke: (
    controller: RunnerSessionsController,
    caller?: string,
    credential?: string,
  ) => Promise<unknown>;
  serviceMethod: string;
};

// Routes a headless caller (no calling session) may reach at all — get/list/send on the runner
// credential, create only with a minted service token (see service-token.spec.ts). Every other
// route below must keep refusing a request with no session context.
const HEADLESS_ROUTE_NAMES = new Set(['list', 'get', 'send', 'create']);

// Keep the calling session immediately after the runner in every controller method. This mirrors
// RunnerAgentsController and, more importantly, makes it difficult to accidentally authenticate
// the target session instead of the agent session making the orchestration request.
const ROUTES: RouteCase[] = [
  {
    name: 'create',
    invoke: (c, caller, credential) =>
      c.createSession(RUNNER, undefined, caller, credential, { prompt: 'do the work' }),
    serviceMethod: 'spawnFromSession',
  },
  {
    name: 'list',
    invoke: (c, caller, credential) =>
      c.listSessions(RUNNER, undefined, caller, credential, undefined, undefined),
    serviceMethod: 'listForOrchestration',
  },
  {
    name: 'search',
    invoke: (c, caller, credential) =>
      c.searchSessions(RUNNER, undefined, caller, credential, 'needle', '5'),
    serviceMethod: 'search',
  },
  {
    name: 'get',
    invoke: (c, caller, credential) =>
      c.getSession(RUNNER, undefined, caller, credential, TARGET_SESSION_ID),
    serviceMethod: 'getForOrchestration',
  },
  {
    name: 'send',
    invoke: (c, caller, credential) =>
      c.sendMessage(RUNNER, undefined, caller, credential, TARGET_SESSION_ID, { message: 'continue' }),
    serviceMethod: 'createTurn',
  },
  {
    name: 'interrupt',
    invoke: (c, caller, credential) =>
      c.interruptSession(RUNNER, undefined, caller, credential, TARGET_SESSION_ID),
    serviceMethod: 'interrupt',
  },
  {
    name: 'merge',
    invoke: (c, caller, credential) =>
      c.mergeSession(RUNNER, undefined, caller, credential, TARGET_SESSION_ID, { targetBranch: 'main' }),
    serviceMethod: 'mergeToMain',
  },
  {
    name: 'end',
    invoke: (c, caller, credential) =>
      c.endSession(RUNNER, undefined, caller, credential, TARGET_SESSION_ID),
    serviceMethod: 'end',
  },
  {
    name: 'complete',
    invoke: (c, caller, credential) =>
      c.completeSession(RUNNER, undefined, caller, credential, TARGET_SESSION_ID),
    serviceMethod: 'complete',
  },
];

function makeController(orchestrationEnabled: boolean) {
  const serviceCalls: string[] = [];
  const authorizationCalls: Array<{
    runner: unknown;
    sessionId: unknown;
    credential: unknown;
  }> = [];
  const sessions = new Proxy(
    {},
    {
      get: (_target, prop: string) => async () => {
        serviceCalls.push(prop);
        return { route: prop };
      },
    },
  );
  const authorizer = {
    assert: async (runner: unknown, sessionId: unknown, credential: unknown) => {
      authorizationCalls.push({ runner, sessionId, credential });
      if (!sessionId) throw new BadRequestException('missing session context');
      if (!credential) throw new ForbiddenException('missing orchestration credential');
      if (!orchestrationEnabled) {
        throw new ForbiddenException('orchestration is not enabled for this agent');
      }
    },
  };
  return {
    controller: new RunnerSessionsController(sessions as never, authorizer as never),
    serviceCalls,
    authorizationCalls,
  };
}

test('session orchestration routes outside the headless subset reject a missing calling session before doing work', async () => {
  for (const route of ROUTES.filter((r) => !HEADLESS_ROUTE_NAMES.has(r.name))) {
    const { controller, serviceCalls, authorizationCalls } = makeController(true);
    await assert.rejects(
      () => route.invoke(controller),
      (error: unknown) =>
        error instanceof BadRequestException && error.message === 'missing session context',
      route.name,
    );
    assert.deepEqual(
      authorizationCalls,
      [{ runner: RUNNER, sessionId: undefined, credential: undefined }],
      `${route.name} did not authorize the calling context`,
    );
    assert.deepEqual(serviceCalls, [], `${route.name} must reject before calling SessionsService`);
  }
});

test('all session orchestration routes reject a missing credential before doing work', async () => {
  for (const route of ROUTES) {
    const { controller, serviceCalls, authorizationCalls } = makeController(true);
    await assert.rejects(
      () => route.invoke(controller, CALLER_SESSION_ID),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        error.message === 'missing orchestration credential',
      route.name,
    );
    assert.deepEqual(
      authorizationCalls,
      [{ runner: RUNNER, sessionId: CALLER_SESSION_ID, credential: undefined }],
      `${route.name} did not authorize the credential`,
    );
    assert.deepEqual(serviceCalls, [], `${route.name} must reject before calling SessionsService`);
  }
});

test('all session orchestration routes reject a calling session whose agent is not enabled', async () => {
  for (const route of ROUTES) {
    const { controller, serviceCalls, authorizationCalls } = makeController(false);
    await assert.rejects(
      () => route.invoke(controller, CALLER_SESSION_ID, ORCHESTRATION_TOKEN),
      (error: unknown) =>
        error instanceof ForbiddenException &&
        error.message === 'orchestration is not enabled for this agent',
      route.name,
    );
    assert.deepEqual(
      authorizationCalls,
      [
        {
          runner: RUNNER,
          sessionId: CALLER_SESSION_ID,
          credential: ORCHESTRATION_TOKEN,
        },
      ],
      `${route.name} did not authorize the calling context`,
    );
    assert.deepEqual(serviceCalls, [], `${route.name} must reject before calling SessionsService`);
  }
});

test('all session orchestration routes accept an enabled caller and invoke only their service method', async () => {
  for (const route of ROUTES) {
    const { controller, serviceCalls, authorizationCalls } = makeController(true);
    const result = await route.invoke(controller, CALLER_SESSION_ID, ORCHESTRATION_TOKEN);
    assert.deepEqual(result, { route: route.serviceMethod }, route.name);
    assert.deepEqual(
      authorizationCalls,
      [
        {
          runner: RUNNER,
          sessionId: CALLER_SESSION_ID,
          credential: ORCHESTRATION_TOKEN,
        },
      ],
      `${route.name} did not authorize the calling context`,
    );
    assert.deepEqual(serviceCalls, [route.serviceMethod], route.name);
  }
});

// A launchd/cron bridge belongs to no session and outlives every session, so it can hold no
// session-bound credential. It authenticates with the runner token alone, and every route it can
// reach must therefore be narrowed to the sessions this runner already hosts.
test('headless callers reach the read and send routes scoped to the runner that authenticated', async () => {
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
      throw new Error('a headless call must not go through the orchestration authorizer');
    },
  };
  const controller = new RunnerSessionsController(sessions as never, authorizer as never);

  assert.deepEqual(await controller.listSessions(RUNNER, undefined, undefined, undefined, 'RUNNING', undefined), {
    route: 'listForOrchestration',
  });
  assert.deepEqual(calls.at(-1), {
    method: 'listForOrchestration',
    args: [
      'owner-1',
      {
        status: 'RUNNING',
        parentSessionId: undefined,
        scope: { assignedRunnerId: 'runner-1', agentId: null },
      },
    ],
  });

  assert.deepEqual(await controller.getSession(RUNNER, undefined, undefined, undefined, TARGET_SESSION_ID), {
    route: 'getForOrchestration',
  });
  assert.deepEqual(calls.at(-1), {
    method: 'getForOrchestration',
    args: ['owner-1', TARGET_SESSION_ID, { assignedRunnerId: 'runner-1', agentId: null }],
  });

  assert.deepEqual(
    await controller.sendMessage(RUNNER, undefined, undefined, undefined, TARGET_SESSION_ID, {
      message: 'continue',
    }),
    { route: 'createTurn' },
  );
  // The scope check must run BEFORE the turn is created, not alongside it.
  assert.deepEqual(
    calls.slice(-2).map((call) => call.method),
    ['assertHostedByRunner', 'createTurn'],
  );
  assert.deepEqual(calls.at(-2)?.args, [
    'owner-1',
    { assignedRunnerId: 'runner-1', agentId: null },
    TARGET_SESSION_ID,
  ]);
});

test('the headless session scope only matches sessions assigned to the authenticated runner', async () => {
  let query: { where?: Record<string, unknown> } = {};
  const prisma = {
    session: {
      findFirst: async (args: typeof query) => {
        query = args;
        return null;
      },
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);

  // A session hosted on another machine is reported as missing rather than forbidden, so the
  // runner credential cannot be used to probe for sessions it may not touch.
  await assert.rejects(
    () =>
      service.assertHostedByRunner(
        'owner-1',
        { assignedRunnerId: 'runner-1' },
        TARGET_SESSION_ID,
      ),
    (error: unknown) => error instanceof NotFoundException,
  );
  assert.deepEqual(query.where, {
    id: TARGET_SESSION_ID,
    ownerId: 'owner-1',
    assignedRunnerId: 'runner-1',
    deletedAt: null,
  });
});

test('session orchestration detail scopes to one runner only when asked', async () => {
  let query: { where?: Record<string, unknown> } = {};
  const prisma = {
    session: {
      findFirst: async (args: typeof query) => {
        query = args;
        return { id: TARGET_SESSION_ID, status: 'RUNNING' };
      },
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);

  await service.getForOrchestration('owner-1', TARGET_SESSION_ID, {
    assignedRunnerId: 'runner-1',
    agentId: 'agent-1',
  });
  assert.deepEqual(query.where, {
    id: TARGET_SESSION_ID,
    ownerId: 'owner-1',
    assignedRunnerId: 'runner-1',
    agentId: 'agent-1',
  });
});

test('session orchestration detail uses an explicit allowlist and never returns agent secrets', async () => {
  let query: { where?: Record<string, unknown>; select?: Record<string, unknown> } = {};
  const prisma = {
    session: {
      findFirst: async (args: typeof query) => {
        query = args;
        return { id: TARGET_SESSION_ID, status: 'RUNNING' };
      },
    },
  };
  const service = new SessionsService(prisma as never, {} as never, {} as never);
  await service.getForOrchestration('owner-1', TARGET_SESSION_ID);

  assert.deepEqual(query.where, { id: TARGET_SESSION_ID, ownerId: 'owner-1' });
  assert.equal(query.select?.id, true);
  assert.equal(query.select?.lastAssistantText, true);
  for (const field of ['shareToken', 'sharedAt', 'runtimeSessionId']) {
    assert.equal(query.select?.[field], undefined, `session detail exposed ${field}`);
  }
  const agent = query.select?.agent as { select?: Record<string, unknown> } | undefined;
  for (const field of ['env', 'mcpConfig', 'systemPrompt', 'appendSystemPrompt', 'agentKey']) {
    assert.equal(agent?.select?.[field], undefined, `session detail exposed agent.${field}`);
  }
  // No agent.provider to expose: an agent holds none, and the session's own is authoritative.
  assert.deepEqual(agent?.select, { id: true, name: true, model: true });
});
