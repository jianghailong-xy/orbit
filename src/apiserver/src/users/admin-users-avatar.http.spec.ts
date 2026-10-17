import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';

import { GoogleLoginService } from '../auth/google-login.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PatService } from '../auth/pat.service';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { AdminController } from './admin.controller';

/**
 * Admin → Users draws each account's profile photo where its initial was: every row of
 * `GET /admin/users` names the photo's version (`avatarUpdatedAt`, null while there is none, as `me`
 * does), and `GET /admin/users/:id/avatar` answers its bytes. Over real HTTP, so the guards, the id pipe
 * and the streamed answer are the ones a client meets.
 */

const SECRET = `admin-users-avatar-${randomUUID()}`;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const SET_AT = new Date('2026-10-16T08:30:00.000Z');

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'MEMBER' | 'ADMIN';
}

const admin: UserRow = { id: randomUUID(), email: 'admin@example.test', name: 'Admin', role: 'ADMIN' };
const pictured: UserRow = { id: randomUUID(), email: 'pictured@example.test', name: 'Pictured', role: 'MEMBER' };
const plain: UserRow = { id: randomUUID(), email: 'plain@example.test', name: 'Plain', role: 'MEMBER' };
const users = [admin, pictured, plain];

/** The photos there are, by user id, as user_avatar holds them: the member `pictured`'s alone. */
const photos = new Map([[pictured.id, { mimeType: 'image/png', data: PNG, updatedAt: SET_AT }]]);

const prisma = {
  user: {
    // AdminRoleGuard's look at the caller's role.
    findUnique: async ({ where }: { where: { id: string } }) => users.find((user) => user.id === where.id) ?? null,
    findMany: async ({ select }: { select: Record<string, unknown> }) => {
      assert.deepEqual(select.avatar, { select: { updatedAt: true } }, 'the list reads each photo\'s version, never its bytes');
      return users.map((user) => {
        const photo = photos.get(user.id);
        return {
          ...user,
          createdAt: new Date('2026-10-01T00:00:00Z'),
          disabledAt: null,
          avatar: photo ? { updatedAt: photo.updatedAt } : null,
          passwordHash: 'hash',
          identities: [],
          clientVersions: [],
          personalAccessTokens: [],
        };
      });
    },
  },
  userAvatar: {
    findUnique: async ({ where, select }: { where: { userId: string }; select: Record<string, unknown> }) => {
      assert.deepEqual(select, { mimeType: true, data: true });
      const photo = photos.get(where.userId);
      return photo ? { mimeType: photo.mimeType, data: photo.data } : null;
    },
  },
};

const jwt = new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } });

@Module({
  controllers: [AdminController],
  providers: [
    JwtAuthGuard,
    Reflector,
    { provide: JwtService, useValue: jwt },
    { provide: PrismaService, useValue: prisma },
    // AdminController's other routes; none is called here.
    { provide: PatService, useValue: {} },
    { provide: GoogleLoginService, useValue: {} },
  ],
})
class AdminUsersAvatarModule {}

async function boot(t: { after: (fn: () => Promise<void>) => void }) {
  const app = await NestFactory.create(AdminUsersAvatarModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  return (route: string, caller?: UserRow) =>
    caller
      ? jwt.signAsync({ sub: caller.id, email: caller.email }).then((bearer) =>
        fetch(`${base}/api${route}`, { headers: { authorization: `Bearer ${bearer}` } }))
      : fetch(`${base}/api${route}`);
}

test('every row of the list names its photo\'s version, null while the account has none', async (t) => {
  const get = await boot(t);

  const list = await get('/admin/users', admin);
  assert.equal(list.status, 200);
  const rows = (await list.json()) as Array<{ id: string; avatarUpdatedAt: string | null }>;
  assert.deepEqual(
    rows.map((row) => [toUuid(row.id), row.avatarUpdatedAt]),
    [[admin.id, null], [pictured.id, SET_AT.toISOString()], [plain.id, null]],
  );
});

test('an administrator reads an account\'s photo by the id its row answers, as the bytes and the type they are', async (t) => {
  const get = await boot(t);

  const read = await get(`/admin/users/${uuidToBase62(pictured.id)}/avatar`, admin);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), PNG);

  // The UUID spelling names the same account.
  assert.deepEqual(new Uint8Array(await (await get(`/admin/users/${pictured.id}/avatar`, admin)).arrayBuffer()), PNG);

  const none = await get(`/admin/users/${uuidToBase62(plain.id)}/avatar`, admin);
  assert.equal(none.status, 404, 'an account without a photo has none to answer');
  assert.equal((await get(`/admin/users/${uuidToBase62(randomUUID())}/avatar`, admin)).status, 404, 'nor has an account that does not exist');
});

test('a member does not read another account\'s photo, and nobody reads one signed out', async (t) => {
  const get = await boot(t);

  assert.equal((await get(`/admin/users/${uuidToBase62(pictured.id)}/avatar`, plain)).status, 403);
  assert.equal((await get(`/admin/users/${uuidToBase62(pictured.id)}/avatar`, pictured)).status, 403, 'not even its own, here: that is users/me/avatar');
  assert.equal((await get(`/admin/users/${uuidToBase62(pictured.id)}/avatar`)).status, 401);
});
