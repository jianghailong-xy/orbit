import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { type ExecutionContext, HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from '../common/current-user.decorator';
import type { DisabledAccounts } from './disabled-accounts';
import {
  createImpersonationJwt,
  IMPERSONATION_FORBIDDEN,
  IMPERSONATION_READ_ONLY,
  IMPERSONATION_TTL_SECONDS,
  Impersonation,
  WritesNothing,
} from './impersonation';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PatForbidden, PatScope } from './pat-scope.decorator';

// What JwtAuthGuard makes of the token an administrator views another account with
// (auth/impersonation.ts): that account's reads, and nothing else. The route that issues it is
// admin-impersonate.http.spec.ts's; the production app's wiring is impersonation.pg.spec.ts's.

const SECRET = `impersonation-${randomUUID()}`;
const ADMIN = randomUUID();
const USER = randomUUID();
const EMAIL = 'viewed@example.test';

/** A route of each kind the read-only rule tells apart. */
class Routes {
  @PatScope('tasks:read', { workspaceConfinable: false })
  read(): void {}

  @PatScope('tasks:write', { workspaceConfinable: false })
  write(): void {}

  undeclared(): void {}

  @PatForbidden('ACCOUNT')
  account(): void {}

  @PatForbidden('OWNER_INTERACTIVE')
  decide(): void {}

  @PatForbidden('NO_SCOPE')
  @WritesNothing()
  previews(): void {}

  @PatForbidden('NO_SCOPE')
  watches(): void {}

  @PatForbidden('SECRET_REVEAL')
  reveal(): void {}
}

/** A controller closed to tokens whole, as admin/* is. */
@PatForbidden('ADMIN')
class Administration {
  @PatScope('tasks:read', { workspaceConfinable: false })
  users(): void {}
}

const login = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });
const signing = createImpersonationJwt({ get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined) } as unknown as ConfigService);
const impersonation = new Impersonation(signing);
const disabled = new Set<string>();
const accounts = { has: (id: string) => disabled.has(id) } as unknown as DisabledAccounts;
const guard = new JwtAuthGuard(login, new Reflector(), undefined, undefined, accounts, impersonation);

const viewing = async () => (await impersonation.issue(ADMIN, { id: USER, email: EMAIL })).accessToken;

interface Answer {
  status: number;
  user?: AuthUser;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: any;
}

/** One request through the guard, as Nest hands it one: `method` on `handler` of `controller`. */
async function present(
  bearer: string,
  method: string,
  controller: new (...args: never[]) => unknown,
  handler: string,
  through: JwtAuthGuard = guard,
): Promise<Answer> {
  const request: Record<string, unknown> = { method, headers: { authorization: `Bearer ${bearer}` }, query: {} };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
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

test('the token reads as the account viewed, its credential naming the administrator and when it ends', async () => {
  const before = Math.floor(Date.now() / 1000);
  const issued = await impersonation.issue(ADMIN, { id: USER, email: EMAIL });
  const answer = await present(issued.accessToken, 'GET', Routes, 'read');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const expiresAt = issued.expiresAt.getTime() / 1000;
  assert.deepEqual(answer.user, {
    userId: USER,
    email: EMAIL,
    credential: { kind: 'IMPERSONATION', administratorId: ADMIN, expiresAt },
  });
  assert.ok(expiresAt >= before + IMPERSONATION_TTL_SECONDS && expiresAt <= before + IMPERSONATION_TTL_SECONDS + 2, `ends at ${expiresAt}`);
});

test('every read is let through, on routes closed to access tokens too, but administration and a stored key', async () => {
  const token = await viewing();
  for (const [method, handler] of [
    ['GET', 'read'],
    ['GET', 'write'],
    ['GET', 'undeclared'],
    ['GET', 'account'],
    ['GET', 'decide'],
    ['GET', 'watches'],
    ['HEAD', 'read'],
    // A POST that only reads: its access token scope is a read scope, or it is marked so.
    ['POST', 'read'],
    ['POST', 'previews'],
  ] as const) {
    const answer = await present(token, method, Routes, handler);
    assert.equal(answer.status, 200, `${method} ${handler}: ${JSON.stringify(answer.body)}`);
  }
  for (const [controller, handler] of [[Routes, 'reveal'], [Administration, 'users']] as const) {
    const answer = await present(token, 'GET', controller, handler);
    assert.equal(answer.status, 403, `GET ${handler}`);
    assert.equal(answer.body.code, IMPERSONATION_FORBIDDEN);
  }
});

test('every write is refused 403 IMPERSONATION_READ_ONLY, whatever the route declares', async () => {
  const token = await viewing();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const handler of ['write', 'undeclared', 'account', 'decide', 'watches']) {
      const answer = await present(token, method, Routes, handler);
      assert.equal(answer.status, 403, `${method} ${handler}`);
      assert.deepEqual(answer.body, {
        code: IMPERSONATION_READ_ONLY,
        message: 'You are viewing Orbit as another user, read-only: nothing can be changed',
      });
    }
  }
});

test('a login reads and writes as before', async () => {
  const token = await login.signAsync({ sub: USER, email: EMAIL });
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const answer = await present(token, method, Routes, 'write');
    assert.equal(answer.status, 200, `${method}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.user, { userId: USER, email: EMAIL, credential: { kind: 'LOGIN' } });
  }
});

test('a server that does not know the token answers it 401: it is never read as the account\'s login', async () => {
  const before = new JwtAuthGuard(login, new Reflector(), undefined, undefined, accounts);
  for (const method of ['GET', 'POST']) {
    const answer = await present(await viewing(), method, Routes, 'write', before);
    assert.equal(answer.status, 401, method);
    assert.equal(answer.user, undefined);
  }
});

test('a token in its audience that its own key did not sign is answered 401, as is one past its end', async () => {
  const claims = { email: EMAIL, act: { sub: ADMIN } };
  const forged = [
    // The login key, which anyone holding a login does not have either, does not stand in for its own.
    await login.signAsync(claims, { audience: 'orbit-impersonation', subject: USER }),
    await new JwtService({ secret: 'not-the-key' }).signAsync(claims, { audience: 'orbit-impersonation', subject: USER, expiresIn: 60 }),
    // Its own key, but no administrator named, or no account.
    await signing.signAsync({ email: EMAIL }, { audience: 'orbit-impersonation', subject: USER, expiresIn: 60 }),
    await signing.signAsync(claims, { audience: 'orbit-impersonation', expiresIn: 60 }),
    // Its own key, ended a minute ago.
    await signing.signAsync({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, { audience: 'orbit-impersonation', subject: USER }),
  ];
  for (const [index, token] of forged.entries()) {
    const answer = await present(token, 'GET', Routes, 'read');
    assert.equal(answer.status, 401, `token ${index}`);
    assert.equal(answer.user, undefined, `token ${index}`);
  }
});

test('a token that cannot be read at all is answered 401, as before, not a 500', async () => {
  const b64 = (text: string) => Buffer.from(text).toString('base64url');
  for (const token of ['garbage', `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64('not json')}.signature`]) {
    const answer = await present(token, 'GET', Routes, 'read');
    assert.equal(answer.status, 401, token);
  }
});

test('the token stops working once either account is disabled', async (t) => {
  t.after(() => disabled.clear());
  const token = await viewing();
  for (const id of [USER, ADMIN]) {
    disabled.clear();
    disabled.add(id);
    assert.equal((await present(token, 'GET', Routes, 'read')).status, 401, id === USER ? 'the account viewed' : 'the administrator');
  }
  disabled.clear();
  assert.equal((await present(token, 'GET', Routes, 'read')).status, 200);
});
