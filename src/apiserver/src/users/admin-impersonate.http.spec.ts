import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';

import { GoogleLoginService } from '../auth/google-login.service';
import { createImpersonationJwt, Impersonation, IMPERSONATION_JWT, IMPERSONATION_TTL_SECONDS } from '../auth/impersonation';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatService } from '../auth/pat.service';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { AdminController } from './admin.controller';
import { UsersController } from './users.controller';

/**
 * `POST /admin/users/:id/impersonate`: an administrator views Orbit as another account, read-only
 * (auth/impersonation.ts). Over real HTTP, so the answer is the one a client gets: the validation pipe,
 * both guards, the controller, and the token then sent back through the same app.
 */

const SECRET = `admin-impersonate-${randomUUID()}`;

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'MEMBER' | 'ADMIN';
  disabledAt: Date | null;
}

const admin: UserRow = { id: randomUUID(), email: 'admin@example.test', name: 'Admin', role: 'ADMIN', disabledAt: null };
const otherAdmin: UserRow = { id: randomUUID(), email: 'other-admin@example.test', name: 'Other', role: 'ADMIN', disabledAt: null };
const member: UserRow = { id: randomUUID(), email: 'member@example.test', name: 'Member', role: 'MEMBER', disabledAt: null };
const disabledMember: UserRow = { id: randomUUID(), email: 'gone@example.test', name: 'Gone', role: 'MEMBER', disabledAt: new Date() };
const users = [admin, otherAdmin, member, disabledMember];

/** Every write the app asked for: the Activity rows, and any change to an account. */
const activities: Array<Record<string, unknown>> = [];
const userWrites: unknown[] = [];

const prisma = {
  user: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = users.find((user) => user.id === where.id);
      // What every select of these routes reads: `me` reads the photo and sign-in methods besides.
      return row && { ...row, createdAt: new Date('2026-10-01T00:00:00Z'), preferences: {}, avatar: null, passwordHash: 'hash', identities: [] };
    },
    update: async (args: unknown) => {
      userWrites.push(args);
      throw new Error('no account is changed here');
    },
  },
  activity: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      activities.push(data);
      return { id: randomUUID(), ...data };
    },
  },
};

const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });

@Module({
  controllers: [AdminController, UsersController],
  providers: [
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: jwt },
    { provide: IMPERSONATION_JWT, useValue: createImpersonationJwt({ get: () => SECRET } as unknown as ConfigService) },
    Impersonation,
    { provide: PrismaService, useValue: prisma },
    // AdminController's other routes; none is called here.
    { provide: PatService, useValue: {} },
    { provide: GoogleLoginService, useValue: {} },
  ],
})
class AdminImpersonateModule {}

async function boot(t: { after: (fn: () => Promise<void>) => void }) {
  activities.length = 0;
  userWrites.length = 0;
  const app = await NestFactory.create(AdminImpersonateModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  return async (method: string, route: string, bearer: string, body?: unknown) => {
    const response = await fetch(`${base}/api${route}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, text, json };
  };
}

const bearerOf = (user: UserRow) => jwt.signAsync({ sub: user.id, email: user.email });

test('an administrator gets a token that reads as the member, recorded with the reason before it is answered', async (t) => {
  const call = await boot(t);
  const before = Date.now();

  const started = await call('POST', `/admin/users/${member.id}/impersonate`, await bearerOf(admin), { reason: '  ticket 42: tasks list is empty  ' });

  assert.equal(started.status, 201, started.text);
  const { id, email, name } = started.json.user;
  assert.deepEqual({ id, email, name }, { id: uuidToBase62(member.id), email: member.email, name: member.name });
  const expiresAt = Date.parse(started.json.expiresAt);
  assert.ok(expiresAt >= before + IMPERSONATION_TTL_SECONDS * 1000 - 1000 && expiresAt <= Date.now() + IMPERSONATION_TTL_SECONDS * 1000, started.json.expiresAt);
  assert.equal('refreshToken' in started.json, false, 'a look cannot be refreshed');
  assert.deepEqual(activities, [
    {
      actorId: admin.id,
      type: 'user.impersonated',
      payload: { userId: member.id, email: member.email, reason: 'ticket 42: tasks list is empty', expiresAt: new Date(expiresAt).toISOString() },
      credentialKind: 'LOGIN',
    },
  ]);

  // The token, sent back: the member's own account is what it reads.
  const me = await call('GET', '/users/me', started.json.accessToken);
  assert.equal(me.status, 200, me.text);
  assert.equal(me.json.email, member.email);
  assert.equal(me.json.id, uuidToBase62(member.id));

  // Nothing is changed with it, and nothing of administration is reached with it.
  const rename = await call('PATCH', '/users/me', started.json.accessToken, { name: 'Renamed' });
  assert.equal(rename.status, 403, rename.text);
  assert.equal(rename.json.code, 'IMPERSONATION_READ_ONLY');
  assert.deepEqual(userWrites, []);
  const list = await call('GET', '/admin/users', started.json.accessToken);
  assert.equal(list.status, 403, list.text);
  assert.equal(list.json.code, 'IMPERSONATION_FORBIDDEN');
  const again = await call('POST', `/admin/users/${disabledMember.id}/impersonate`, started.json.accessToken, { reason: 'nested' });
  assert.equal(again.status, 403, again.text);
  assert.equal(activities.length, 1, 'no second look was recorded');
});

test('refused, with nothing recorded: no reason, the administrator themselves, another administrator, a disabled or unknown account', async (t) => {
  const call = await boot(t);
  const bearer = await bearerOf(admin);
  for (const [id, body, status, message] of [
    [member.id, {}, 400, /reason/],
    [member.id, { reason: 42 }, 400, /reason/],
    [member.id, { reason: ' \t ' }, 400, /a reason is required/],
    [member.id, { reason: 'x'.repeat(501) }, 400, /reason/],
    [admin.id, { reason: 'self' }, 400, /you cannot view Orbit as yourself/],
    [otherAdmin.id, { reason: 'another admin' }, 400, /you cannot view Orbit as another administrator/],
    [disabledMember.id, { reason: 'disabled' }, 400, /this account is disabled/],
    [randomUUID(), { reason: 'nobody' }, 404, /user not found/],
  ] as const) {
    const answer = await call('POST', `/admin/users/${id}/impersonate`, bearer, body);
    assert.equal(answer.status, status, `${JSON.stringify(body).slice(0, 40)}: ${answer.text}`);
    assert.match(answer.text, message);
  }
  assert.deepEqual(activities, []);
});

test('a member is refused, with nothing recorded', async (t) => {
  const call = await boot(t);
  const answer = await call('POST', `/admin/users/${disabledMember.id}/impersonate`, await bearerOf(member), { reason: 'curious' });
  assert.equal(answer.status, 403, answer.text);
  assert.deepEqual(activities, []);
});
