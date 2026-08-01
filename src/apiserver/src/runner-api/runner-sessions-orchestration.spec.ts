import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
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

// Keep the calling session immediately after the runner in every controller method. This mirrors
// RunnerAgentsController and, more importantly, makes it difficult to accidentally authenticate
// the target session instead of the agent session making the orchestration request.
const ROUTES: RouteCase[] = [
  {
    name: 'create',
    invoke: (c, caller, credential) =>
      c.createSession(RUNNER, caller, credential, { prompt: 'do the work' }),
    serviceMethod: 'spawnFromSession',
  },
  {
    name: 'list',
    invoke: (c, caller, credential) =>
      c.listSessions(RUNNER, caller, credential, undefined, undefined),
    serviceMethod: 'listForOrchestration',
  },
  {
    name: 'search',
    invoke: (c, caller, credential) =>
      c.searchSessions(RUNNER, caller, credential, 'needle', '5'),
    serviceMethod: 'search',
  },
  {
    name: 'get',
    invoke: (c, caller, credential) =>
      c.getSession(RUNNER, caller, credential, TARGET_SESSION_ID),
    serviceMethod: 'getForOrchestration',
  },
  {
    name: 'send',
    invoke: (c, caller, credential) =>
      c.sendMessage(RUNNER, caller, credential, TARGET_SESSION_ID, { message: 'continue' }),
    serviceMethod: 'createTurn',
  },
  {
    name: 'interrupt',
    invoke: (c, caller, credential) =>
      c.interruptSession(RUNNER, caller, credential, TARGET_SESSION_ID),
    serviceMethod: 'interrupt',
  },
  {
    name: 'merge',
    invoke: (c, caller, credential) =>
      c.mergeSession(RUNNER, caller, credential, TARGET_SESSION_ID, { targetBranch: 'main' }),
    serviceMethod: 'mergeToMain',
  },
  {
    name: 'end',
    invoke: (c, caller, credential) =>
      c.endSession(RUNNER, caller, credential, TARGET_SESSION_ID),
    serviceMethod: 'end',
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

test('all session orchestration routes reject a missing calling session before doing work', async () => {
  for (const route of ROUTES) {
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
  for (const field of ['shareToken', 'sharedAt', 'runtimeSessionId', 'claudeSessionId']) {
    assert.equal(query.select?.[field], undefined, `session detail exposed ${field}`);
  }
  const agent = query.select?.agent as { select?: Record<string, unknown> } | undefined;
  for (const field of ['env', 'mcpConfig', 'systemPrompt', 'appendSystemPrompt', 'agentKey']) {
    assert.equal(agent?.select?.[field], undefined, `session detail exposed agent.${field}`);
  }
  assert.deepEqual(agent?.select, { id: true, name: true, provider: true, model: true });
});
