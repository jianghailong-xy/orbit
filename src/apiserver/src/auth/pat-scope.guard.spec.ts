import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { type ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from '../common/current-user.decorator';
import type { PrismaService } from '../prisma/prisma.service';
import { ProjectsController } from '../projects/projects.controller';
import { TaskOwnerConfirmationController } from '../tasks/task-owner-confirmation.controller';
import { TasksController } from '../tasks/tasks.controller';
import { AdminController } from '../users/admin.controller';
import { AccessTokensController, PatSelfController } from './access-tokens.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatRequestAudit } from './pat-request-audit';
import { PAT_FORBIDDEN_REASONS, PatForbidden, PatScope, PatSelf, type PatForbiddenReason } from './pat-scope.decorator';
import { PAT_PREFIX, PAT_SCOPES, type PatGrant, type PatService } from './pat.service';

// What JwtAuthGuard does with a personal access token once PatService has verified it
// (docs/personal-access-token-design.md §6.2), and that a login is let through exactly as before.
// PatService is stood in for by its answers — the token's verification is the pg spec's
// (`personal-access-token.pg.spec.ts`), which also runs these answers through the production app.

const USER = randomUUID();
const EMAIL = 'pat-scope@example.test';

/** A route of each kind the guard tells apart. */
class Routes {
  @PatScope('tasks:read', { workspaceConfinable: false })
  read(): void {}

  @PatScope('tasks:write', { workspaceConfinable: false })
  write(): void {}

  undeclared(): void {}

  @PatForbidden('OWNER_INTERACTIVE')
  decide(): void {}

  @PatForbidden('TOKEN_MANAGEMENT')
  tokens(): void {}

  @PatSelf()
  self(): void {}
}

/** A controller that refuses tokens, around handlers that declare a scope or @PatSelf: the refusal wins. */
@PatForbidden('ADMIN')
class Closed {
  @PatScope('tasks:read', { workspaceConfinable: false })
  read(): void {}

  @PatSelf()
  self(): void {}
}

const grants = new Map<string, PatGrant>();
const pats = { verify: async (token: string) => grants.get(token) ?? null } as unknown as PatService;
const jwt = new JwtService({ secret: `pat-scope-${randomUUID()}`, signOptions: { expiresIn: '1h' } });
const guard = new JwtAuthGuard(jwt, new Reflector(), pats);

function tokenWith(scopes: readonly string[], workspaceIds: readonly string[] = []): string {
  const token = PAT_PREFIX + randomBytes(32).toString('base64url');
  grants.set(token, { tokenId: randomUUID(), userId: USER, email: EMAIL, scopes: [...scopes], workspaceIds: [...workspaceIds] });
  return token;
}
const login = () => jwt.signAsync({ sub: USER, email: EMAIL });

interface Answer {
  status: number;
  user?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

/** One request through the guard, as Nest hands it one: `handler` of `controller`, bearer in the header. */
async function present(
  bearer: string,
  controller: new (...args: never[]) => unknown,
  handler: string,
  through: JwtAuthGuard = guard,
): Promise<Answer> {
  const request: Record<string, unknown> = {
    headers: { authorization: `Bearer ${bearer}`, 'user-agent': 'pat-scope-spec' },
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
  } as unknown as ExecutionContext;
  try {
    assert.equal(await through.canActivate(context), true);
    return { status: 200, user: request.user as AuthUser };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { status: error.getStatus(), user: request.user as AuthUser | undefined, body: error.getResponse() };
  }
}

test('a token reaches a route that declares a scope it holds, as its user with credential PAT', async () => {
  const token = tokenWith(['tasks:read']);
  const answer = await present(token, Routes, 'read');
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.user, {
    userId: USER,
    email: EMAIL,
    credential: { kind: 'PAT', tokenId: grants.get(token)!.tokenId, scopes: ['tasks:read'], workspaceIds: [] },
  });
  assert.equal((await present(tokenWith(['tasks:read', 'tasks:write']), Routes, 'write')).status, 200);
});

test('a token without the scope a route declares is refused 403 PAT_SCOPE_MISSING, naming the scope', async () => {
  // Holding the read scope of the same resource, or every other scope there is, does not stand in for it.
  for (const scopes of [['tasks:read'], PAT_SCOPES.filter((scope) => scope !== 'tasks:write')]) {
    const answer = await present(tokenWith(scopes), Routes, 'write');
    assert.equal(answer.status, 403, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, {
      code: 'PAT_SCOPE_MISSING',
      scope: 'tasks:write',
      message: 'This access token was not granted the tasks:write scope this route needs',
    });
  }
});

test('a route that declares nothing is refused 403 to every token, one granted every scope included', async () => {
  for (const scopes of [['tasks:read'], PAT_SCOPES]) {
    const answer = await present(tokenWith(scopes), Routes, 'undeclared');
    assert.equal(answer.status, 403, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, {
      code: 'PAT_ROUTE_UNDECLARED',
      message: 'This route declares no access token scope, so a personal access token cannot call it',
    });
  }
});

test('@PatForbidden refuses every token with its reason, and a refusal on the controller wins over a scope on the handler', async () => {
  const everything = tokenWith(PAT_SCOPES);
  const expected = (reason: PatForbiddenReason, code: string) => ({
    code,
    reason,
    requiredAction: 'OPEN_ORBIT',
    message: PAT_FORBIDDEN_REASONS[reason],
  });
  const cases: Array<[new (...args: never[]) => unknown, string, PatForbiddenReason, string]> = [
    [Routes, 'decide', 'OWNER_INTERACTIVE', 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED'],
    [Routes, 'tokens', 'TOKEN_MANAGEMENT', 'PAT_FORBIDDEN'],
    [Closed, 'read', 'ADMIN', 'PAT_FORBIDDEN'],
  ];
  for (const [controller, handler, reason, code] of cases) {
    const answer = await present(everything, controller, handler);
    assert.equal(answer.status, 403, `${controller.name}.${handler}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.body, expected(reason, code));
  }
});

test('@PatSelf: every token reaches the route whatever it holds and wherever it is confined, and a refusal on the controller still wins', async () => {
  for (const scopes of [['tasks:read'], ['events:read'], PAT_SCOPES]) {
    const answer = await present(tokenWith(scopes), Routes, 'self');
    assert.equal(answer.status, 200, `${scopes.join(' ')}: ${JSON.stringify(answer.body)}`);
    assert.equal(answer.user?.credential?.kind, 'PAT');
  }
  // Confined to a workspace, the same token is refused a route that cannot be confined, and reaches
  // this one: nothing in its request is judged — the stand-in PatService could not say where anything sits.
  const confined = tokenWith(['tasks:read'], [randomUUID()]);
  assert.equal((await present(confined, Routes, 'read')).body?.code, 'PAT_ROUTE_NOT_WORKSPACE_CONFINABLE');
  const self = await present(confined, Routes, 'self');
  assert.equal(self.status, 200, JSON.stringify(self.body));
  assert.deepEqual(self.user?.credential, {
    kind: 'PAT',
    tokenId: grants.get(confined)!.tokenId,
    scopes: ['tasks:read'],
    workspaceIds: grants.get(confined)!.workspaceIds,
  });
  const closed = await present(tokenWith(PAT_SCOPES), Closed, 'self');
  assert.equal(closed.status, 403);
  assert.deepEqual([closed.body.code, closed.body.reason], ['PAT_FORBIDDEN', 'ADMIN']);
});

test('@PatSelf goes through the request audit as every route does: GET /pat/self, a read, is not recorded, and DELETE /pat/self, a write, is pat.request', async () => {
  const records: unknown[] = [];
  const prisma = { activity: { create: async ({ data }: { data: unknown }) => void records.push(data) } };
  const audited = new JwtAuthGuard(jwt, new Reflector(), pats, new PatRequestAudit(prisma as unknown as PrismaService));
  // A real node:http server, so the audit sees each answer go out: GET reaches the real reading
  // handler, and DELETE the real revoking one.
  const server = http.createServer(async (req, res) => {
    const routed = Object.assign(req, { route: { path: '/api/pat/self' }, params: {} });
    const context = {
      switchToHttp: () => ({ getRequest: () => routed, getResponse: () => res }),
      getHandler: () => (req.method === 'GET' ? PatSelfController.prototype.self : PatSelfController.prototype.revokeSelf),
      getClass: () => PatSelfController,
    } as unknown as ExecutionContext;
    res.statusCode = await audited.canActivate(context).then(() => 200, (error) => (error instanceof HttpException ? error.getStatus() : 500));
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const token = tokenWith(['wiki:read']);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pat/self`;
    const send = async (method: string) => (await fetch(url, { method, headers: { authorization: `Bearer ${token}` } })).status;
    assert.equal(await send('GET'), 200);
    await sleep(200);
    assert.deepEqual(records, [], 'a read is not recorded');
    assert.equal(await send('DELETE'), 200);
    for (const deadline = Date.now() + 5_000; records.length === 0 && Date.now() < deadline;) await sleep(10);
    await sleep(100);
    assert.deepEqual(records, [{
      actorId: USER,
      type: 'pat.request',
      payload: { method: 'DELETE', route: '/pat/self', status: 200, params: {} },
      credentialKind: 'PAT',
      credentialId: grants.get(token)!.tokenId,
    }]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the real routes: GET and DELETE /pat/self take any token; issuing, listing and revoking tokens, and an administrator\'s token routes, refuse every token', async () => {
  for (const scopes of [['wiki:read'], PAT_SCOPES]) {
    for (const handler of ['self', 'revokeSelf']) {
      assert.equal((await present(tokenWith(scopes), PatSelfController, handler)).status, 200, `${handler} ${scopes.join(' ')}`);
    }
  }
  const everything = tokenWith(PAT_SCOPES);
  const refused: Array<[new (...args: never[]) => unknown, string, PatForbiddenReason]> = [
    [AccessTokensController, 'issue', 'TOKEN_MANAGEMENT'],
    [AccessTokensController, 'list', 'TOKEN_MANAGEMENT'],
    [AccessTokensController, 'revoke', 'TOKEN_MANAGEMENT'],
    [AdminController, 'listAccessTokens', 'ADMIN'],
    [AdminController, 'revokeAccessToken', 'ADMIN'],
  ];
  for (const [controller, handler, reason] of refused) {
    const answer = await present(everything, controller, handler);
    assert.equal(answer.status, 403, `${controller.name}.${handler}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.body, {
      code: 'PAT_FORBIDDEN',
      reason,
      requiredAction: 'OPEN_ORBIT',
      message: PAT_FORBIDDEN_REASONS[reason],
    });
  }
});

test('the real routes: listing tasks takes tasks:read, creating one tasks:write; an owner decision and admin refuse every token', async () => {
  const reader = tokenWith(['tasks:read']);
  assert.equal((await present(reader, TasksController, 'list')).status, 200);
  const create = await present(reader, TasksController, 'create');
  assert.equal(create.status, 403);
  assert.equal(create.body.code, 'PAT_SCOPE_MISSING');
  assert.equal(create.body.scope, 'tasks:write');
  assert.equal((await present(tokenWith(['tasks:write']), TasksController, 'create')).status, 200);
  assert.equal((await present(tokenWith(['projects:read']), ProjectsController, 'get')).status, 200);

  const everything = tokenWith(PAT_SCOPES);
  const confirm = await present(everything, TaskOwnerConfirmationController, 'decide');
  assert.equal(confirm.status, 403);
  assert.equal(confirm.body.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
  assert.equal((await present(everything, ProjectsController, 'start')).body?.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
  const admin = await present(everything, AdminController, 'listUsers');
  assert.equal(admin.status, 403);
  assert.deepEqual([admin.body.code, admin.body.reason], ['PAT_FORBIDDEN', 'ADMIN']);
});

test('a login JWT is let through every one of these routes as before — credential LOGIN, and no declaration read', async () => {
  // A reflector that fails any read shows the login path never consults what a route declares for tokens.
  const blind = new JwtAuthGuard(
    jwt,
    new Proxy({} as Reflector, { get: () => () => assert.fail('a login read route metadata') }),
    pats,
  );
  const routes: Array<[new (...args: never[]) => unknown, string]> = [
    [Routes, 'read'],
    [Routes, 'write'],
    [Routes, 'undeclared'],
    [Routes, 'decide'],
    [Routes, 'tokens'],
    [Routes, 'self'],
    [Closed, 'read'],
    [Closed, 'self'],
    [TasksController, 'create'],
    [AccessTokensController, 'issue'],
    [PatSelfController, 'self'],
    [PatSelfController, 'revokeSelf'],
    [TaskOwnerConfirmationController, 'decide'],
    [AdminController, 'listUsers'],
  ];
  const bearer = await login();
  for (const through of [guard, blind]) {
    for (const [controller, handler] of routes) {
      const answer = await present(bearer, controller, handler, through);
      assert.equal(answer.status, 200, `${controller.name}.${handler}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(answer.user, { userId: USER, email: EMAIL, credential: { kind: 'LOGIN' } });
    }
  }
});

test('a token PatService does not resolve is 401 on every route, before anything the route declares', async () => {
  const unknown = PAT_PREFIX + randomBytes(32).toString('base64url');
  for (const handler of ['read', 'undeclared', 'decide']) {
    const answer = await present(unknown, Routes, handler);
    assert.equal(answer.status, 401);
    assert.equal(answer.user, undefined);
    assert.deepEqual(answer.body, { message: 'invalid token', error: 'Unauthorized', statusCode: 401 });
  }
});
