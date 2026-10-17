import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { USER_NAME_MAX_CHARS } from './dto';
import { UsersController } from './users.controller';

/**
 * `PATCH /users/me` renames the signed-in account — iOS Settings' edit-profile card is its caller.
 *
 * Over real HTTP rather than as a unit call: what decides the outcome is spread over the DTO's
 * validators, the global validation pipe (whose `whitelist` is what keeps an `email` in the body
 * from reaching the write), the guard that says whose row it is, and the trim in the controller.
 */

const USER_ID = randomUUID();

/** Every `user.update` the controller asked for, so the assertions are about the write itself. */
const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];

const prisma = {
  user: {
    update: async (args: { where: unknown; data: Record<string, unknown> }) => {
      updates.push({ where: args.where, data: args.data });
      return {
        id: USER_ID,
        email: 'owner@example.test',
        name: args.data.name,
        createdAt: new Date('2026-09-01T00:00:00Z'),
        preferences: {},
        role: 'MEMBER',
        avatar: null,
        passwordHash: 'scrypt-hash',
        identities: [],
      };
    },
  },
};

@Module({
  controllers: [UsersController],
  providers: [
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: USER_ID }) } },
    { provide: PrismaService, useValue: prisma },
  ],
})
class ProfileModule {}

async function boot(t: { after: (fn: () => Promise<void>) => void }) {
  const app = await NestFactory.create(ProfileModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  return (body: unknown, auth = true) =>
    fetch(`${base}/api/users/me`, {
      method: 'PATCH',
      headers: {
        ...(auth ? { authorization: 'Bearer signed-in' } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
}

test('PATCH /users/me writes the trimmed name to the caller\'s own row, and only the name', async (t) => {
  updates.length = 0;
  const patch = await boot(t);

  const response = await patch({ name: '  Hailong Jiang  ', email: 'someone-else@example.test' });
  const text = await response.text();

  assert.equal(response.status, 200, `PATCH answered ${response.status}: ${text}`);
  assert.equal(JSON.parse(text).name, 'Hailong Jiang');
  assert.equal(JSON.parse(text).avatarUpdatedAt, null, 'the answer is the account as `me` gives it');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].where, { id: USER_ID });
  // The email in the body never reaches the write: the sign-in is not this door's to change.
  assert.deepEqual(updates[0].data, { name: 'Hailong Jiang' });
});

test('PATCH /users/me refuses a name that is blank once trimmed, and writes nothing', async (t) => {
  updates.length = 0;
  const patch = await boot(t);

  const response = await patch({ name: ' \t ' });
  const text = await response.text();

  assert.equal(response.status, 400, `PATCH answered ${response.status}: ${text}`);
  assert.match(text, /name must not be empty/);
  assert.equal(updates.length, 0);
});

test('PATCH /users/me refuses a missing, non-string or over-long name, and writes nothing', async (t) => {
  updates.length = 0;
  const patch = await boot(t);

  for (const body of [{}, { name: 42 }, { name: 'x'.repeat(USER_NAME_MAX_CHARS + 1) }]) {
    const response = await patch(body);
    const text = await response.text();
    assert.equal(response.status, 400, `${JSON.stringify(body).slice(0, 40)} answered ${response.status}: ${text}`);
  }
  assert.equal(updates.length, 0);

  // The longest name allowed is allowed.
  const longest = 'x'.repeat(USER_NAME_MAX_CHARS);
  const response = await patch({ name: longest });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(updates.map((u) => u.data.name), [longest]);
});

test('PATCH /users/me is refused without a signed-in caller', async (t) => {
  updates.length = 0;
  const patch = await boot(t);

  const response = await patch({ name: 'Hailong Jiang' }, false);

  assert.equal(response.status, 401, await response.text());
  assert.equal(updates.length, 0);
});
