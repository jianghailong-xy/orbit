import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { type ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { TasksController } from '../tasks/tasks.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatScope, workspaceConfinement } from './pat-scope.decorator';
import { PAT_PREFIX, PAT_SCOPES, type PatGrant, type PatService } from './pat.service';

// What JwtAuthGuard does with a token confined to workspaces (docs/personal-access-token-design.md
// §6.3 v1), once its scope has admitted it: which routes it reaches at all, and which of the tasks,
// sessions and workspaces a request names it may touch. PatService is stood in for by its answers;
// `pat-workspace-confinement.pg.spec.ts` runs the same rules through the production app.

const USER = randomUUID();
const EMAIL = 'pat-workspace@example.test';
const MINE = randomUUID();
const ALSO_MINE = randomUUID();
const ELSEWHERE = randomUUID();

/** Where each task and session sits, as PatService.workspacesOf would answer for USER. */
const tasks = new Map<string, string | null>();
const sessions = new Map<string, string | null>();
const taskIn = (workspaceId: string | null) => {
  const id = randomUUID();
  tasks.set(id, workspaceId);
  return id;
};
const sessionIn = (workspaceId: string | null) => {
  const id = randomUUID();
  sessions.set(id, workspaceId);
  return id;
};

const grants = new Map<string, PatGrant>();
const lookups: Array<{ kind: string; ids: readonly string[] }> = [];
const pats = {
  verify: async (token: string) => grants.get(token) ?? null,
  workspacesOf: async (ownerId: string, kind: 'task' | 'session', ids: readonly string[]) => {
    assert.equal(ownerId, USER);
    lookups.push({ kind, ids });
    const sits = kind === 'task' ? tasks : sessions;
    return new Map(ids.filter((id) => sits.has(id)).map((id) => [id, sits.get(id)!]));
  },
} as unknown as PatService;
const guard = new JwtAuthGuard(
  new JwtService({ secret: `pat-workspace-${randomUUID()}`, signOptions: { expiresIn: '1h' } }),
  new Reflector(),
  pats,
);

function tokenWith(workspaceIds: string[], scopes: readonly string[] = PAT_SCOPES): string {
  const token = PAT_PREFIX + randomBytes(32).toString('base64url');
  grants.set(token, { tokenId: randomUUID(), userId: USER, email: EMAIL, scopes: [...scopes], workspaceIds });
  return token;
}
const confined = tokenWith([MINE, ALSO_MINE]);
const unconfined = tokenWith([]);

/** A route of each kind a confined token meets. */
class Routes {
  @PatScope('projects:read', { workspaceConfinable: false })
  notConfinable(): void {}

  @PatScope('tasks:read', { workspaceConfinable: 'LIST' })
  list(): void {}

  @PatScope('tasks:read', { workspaceConfinable: { params: { id: 'task' } } })
  task(): void {}

  @PatScope('sessions:read', { workspaceConfinable: { params: { id: 'session' } } })
  session(): void {}

  @PatScope('workspaces:read', { workspaceConfinable: { params: { id: 'workspace' } } })
  workspace(): void {}

  @PatScope('tasks:write', { workspaceConfinable: { params: { id: 'task', other: 'task' } } })
  twoTasks(): void {}

  @PatScope('tasks:write', { workspaceConfinable: { params: { id: 'task' }, body: { assigneeId: 'workspace', stopSessionId: 'session' } } })
  update(): void {}

  @PatScope('tasks:write', {
    workspaceConfinable: {
      body: { assigneeId: 'workspace', dependsOnTaskIds: 'task' },
      requires: ['assigneeId', 'verification.assigneeId'],
    },
  })
  create(): void {}

  /** Only the census keeps a declaration that names nothing from being written; the guard refuses it too. */
  @PatScope('tasks:write', { workspaceConfinable: {} })
  namesNothing(): void {}
}

interface Answer {
  status: number;
  user?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

/** One request through the guard, as Nest hands it one, with its params, body and query. */
async function present(
  bearer: string,
  handler: string,
  request: { params?: Record<string, unknown>; body?: unknown; query?: Record<string, unknown> } = {},
  controller: new (...args: never[]) => unknown = Routes,
): Promise<Answer> {
  const req: Record<string, unknown> = {
    headers: { authorization: `Bearer ${bearer}`, 'user-agent': 'pat-workspace-spec' },
    params: request.params ?? {},
    query: request.query ?? {},
    body: request.body,
    socket: { remoteAddress: '127.0.0.1' },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
  } as unknown as ExecutionContext;
  try {
    assert.equal(await guard.canActivate(context), true);
    return { status: 200, user: req.user as AuthUser };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), body: error.getResponse() };
  }
}

const refusedFor = (answer: Answer, fields: string[]) => {
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.equal(answer.body.code, 'PAT_WORKSPACE_OUT_OF_SCOPE');
  assert.deepEqual(answer.body.fields, fields);
};

test('a route that cannot be told by workspace refuses a confined token 403 PAT_ROUTE_NOT_WORKSPACE_CONFINABLE, and an unconfined one as before', async () => {
  for (const handler of ['notConfinable', 'namesNothing']) {
    const answer = await present(confined, handler);
    assert.equal(answer.status, 403, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, {
      code: 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE',
      message:
        'This access token is confined to workspaces, and this route cannot be confined to one; '
        + 'call it with a token that is not confined to workspaces',
    });
    assert.equal((await present(unconfined, handler)).status, 200);
  }
  // The real routes the census marks false: the paged task list.
  assert.equal((await present(confined, 'listPage', {}, TasksController)).body?.code, 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE');
  assert.equal((await present(unconfined, 'listPage', {}, TasksController)).status, 200);
});

test('a scope comes first: a confined token without it is PAT_SCOPE_MISSING, whatever the route names', async () => {
  const reader = tokenWith([MINE], ['tasks:read']);
  const answer = await present(reader, 'update', { params: { id: taskIn(ELSEWHERE) } });
  assert.equal(answer.status, 403);
  assert.equal(answer.body.code, 'PAT_SCOPE_MISSING');
});

test("a list reaches its handler, which narrows it — workspaceConfinement is the token's workspaces, and nothing for a login or an unconfined token", async () => {
  const answer = await present(confined, 'list');
  assert.equal(answer.status, 200);
  assert.deepEqual(workspaceConfinement(answer.user!), [MINE, ALSO_MINE]);
  assert.equal(workspaceConfinement((await present(unconfined, 'list')).user!), undefined);
  assert.equal(workspaceConfinement({ userId: USER, email: EMAIL, credential: { kind: 'LOGIN' } }), undefined);
});

test('a task, session or workspace the path names must sit in one of the token\'s workspaces', async () => {
  assert.equal((await present(confined, 'task', { params: { id: taskIn(MINE) } })).status, 200);
  assert.equal((await present(confined, 'task', { params: { id: taskIn(ALSO_MINE) } })).status, 200);
  assert.equal((await present(confined, 'session', { params: { id: sessionIn(MINE) } })).status, 200);
  assert.equal((await present(confined, 'workspace', { params: { id: MINE } })).status, 200);
  // As the clients spell ids in URLs, too.
  assert.equal((await present(confined, 'task', { params: { id: uuidToBase62(taskIn(MINE)) } })).status, 200);
  assert.equal((await present(confined, 'workspace', { params: { id: uuidToBase62(ALSO_MINE) } })).status, 200);

  refusedFor(await present(confined, 'task', { params: { id: taskIn(ELSEWHERE) } }), [':id']);
  refusedFor(await present(confined, 'session', { params: { id: sessionIn(ELSEWHERE) } }), [':id']);
  refusedFor(await present(confined, 'workspace', { params: { id: ELSEWHERE } }), [':id']);
  // A task assigned to no workspace, a session in none, one the user does not have, and a path that
  // names nothing are all outside — the same 403, so a token learns nothing about what exists.
  refusedFor(await present(confined, 'task', { params: { id: taskIn(null) } }), [':id']);
  refusedFor(await present(confined, 'session', { params: { id: sessionIn(null) } }), [':id']);
  refusedFor(await present(confined, 'task', { params: { id: randomUUID() } }), [':id']);
  refusedFor(await present(confined, 'task', { params: { id: 'not an id!' } }), [':id']);
  // Every object the path names is judged.
  assert.equal((await present(confined, 'twoTasks', { params: { id: taskIn(MINE), other: taskIn(ALSO_MINE) } })).status, 200);
  refusedFor(await present(confined, 'twoTasks', { params: { id: taskIn(MINE), other: taskIn(ELSEWHERE) } }), [':other']);

  // An unconfined token is not judged at all: nothing is looked up.
  lookups.length = 0;
  assert.equal((await present(unconfined, 'task', { params: { id: taskIn(ELSEWHERE) } })).status, 200);
  assert.equal((await present(unconfined, 'workspace', { params: { id: ELSEWHERE } })).status, 200);
  assert.deepEqual(lookups, []);
});

test('a body may move or tie its object only within the token\'s workspaces, and names nothing else by id', async () => {
  const task = taskIn(MINE);
  assert.equal((await present(confined, 'update', { params: { id: task }, body: { title: 'renamed' } })).status, 200);
  assert.equal((await present(confined, 'update', { params: { id: task }, body: { assigneeId: ALSO_MINE } })).status, 200);
  assert.equal((await present(confined, 'update', { params: { id: task }, body: { stopSessionId: sessionIn(MINE) } })).status, 200);
  assert.equal((await present(confined, 'update', { params: { id: task }, body: { stopSessionId: null } })).status, 200);

  // Out of the token's workspaces, or into none of them.
  refusedFor(await present(confined, 'update', { params: { id: task }, body: { assigneeId: ELSEWHERE } }), ['assigneeId']);
  refusedFor(await present(confined, 'update', { params: { id: task }, body: { assigneeId: null } }), ['assigneeId']);
  refusedFor(await present(confined, 'update', { params: { id: task }, body: { stopSessionId: sessionIn(ELSEWHERE) } }), ['stopSessionId']);
  // An id the route does not judge — a project, a list, a parent — is refused, wherever it sits.
  refusedFor(await present(confined, 'update', { params: { id: task }, body: { projectId: randomUUID() } }), ['projectId']);
  refusedFor(await present(confined, 'update', { params: { id: task }, body: { parentTaskId: null } }), ['parentTaskId']);
  refusedFor(await present(confined, 'update', { params: { id: task }, body: { nested: [{ listId: randomUUID() }] } }), ['listId']);
  refusedFor(await present(confined, 'update', { params: { id: task }, query: { projectId: randomUUID() } }), ['projectId']);
  // A body nested past what is read names something unread.
  let deep: unknown = { assigneeId: MINE };
  for (let i = 0; i < 40; i++) deep = { deeper: deep };
  refusedFor(await present(confined, 'update', { params: { id: task }, body: deep }), ['(nested too deep to read)']);
  // The path is judged with the body.
  refusedFor(await present(confined, 'update', { params: { id: taskIn(ELSEWHERE) }, body: { assigneeId: MINE } }), [':id']);
});

test('what a create makes is made in one of the token\'s workspaces, and what it ties to sits in them', async () => {
  const verification = { title: 'check it', assigneeId: ALSO_MINE };
  assert.equal((await present(confined, 'create', { body: { title: 't', assigneeId: MINE } })).status, 200);
  assert.equal((await present(confined, 'create', { body: { title: 't', assigneeId: uuidToBase62(MINE), verification } })).status, 200);
  assert.equal(
    (await present(confined, 'create', { body: { title: 't', assigneeId: MINE, dependsOnTaskIds: [taskIn(MINE), taskIn(ALSO_MINE)] } })).status,
    200,
  );

  refusedFor(await present(confined, 'create', { body: { title: 't' } }), ['assigneeId']);
  refusedFor(await present(confined, 'create', { body: { title: 't', assigneeId: null } }), ['assigneeId']);
  refusedFor(await present(confined, 'create', { body: { title: 't', assigneeId: ELSEWHERE } }), ['assigneeId']);
  refusedFor(await present(confined, 'create', {}), ['assigneeId']);
  // The check a create files beside its task is made somewhere too, when it is asked for.
  refusedFor(await present(confined, 'create', { body: { title: 't', assigneeId: MINE, verification: { title: 'check' } } }), [
    'verification.assigneeId',
  ]);
  refusedFor(
    await present(confined, 'create', { body: { title: 't', assigneeId: MINE, verification: { title: 'c', assigneeId: ELSEWHERE } } }),
    ['assigneeId'],
  );
  refusedFor(
    await present(confined, 'create', { body: { title: 't', assigneeId: MINE, dependsOnTaskIds: [taskIn(MINE), taskIn(ELSEWHERE)] } }),
    ['dependsOnTaskIds'],
  );
  refusedFor(await present(confined, 'create', { body: { title: 't', assigneeId: MINE, projectId: randomUUID() } }), ['projectId']);

  // An unconfined token creates as before: nothing is required of it.
  assert.equal((await present(unconfined, 'create', { body: { title: 't' } })).status, 200);
  assert.equal((await present(unconfined, 'create', { body: { title: 't', assigneeId: ELSEWHERE, projectId: randomUUID() } })).status, 200);
});
