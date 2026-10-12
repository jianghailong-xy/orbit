import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { AVATAR_MAX_BYTES, sniffAvatarType } from './avatar';
import { UsersController } from './users.controller';

/**
 * A profile photo of one's own: `PUT | DELETE | GET /users/me/avatar`, and the `avatarUpdatedAt` every
 * answer about the account carries so a client knows which photo to fetch.
 *
 * Over real HTTP: the multipart parsing, its size cap and the guard are what decide these answers, and
 * a unit call on the controller would stand in for all three.
 */

const USER_ID = randomUUID();

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56]);

/** The one photo row there is, as the database would hold it. */
let stored: { mimeType: string; data: Uint8Array; updatedAt: Date } | null = null;
const writes: string[] = [];

const prisma = {
  user: {
    findUnique: async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
      assert.equal(where.id, USER_ID, 'the account read is the caller\'s own');
      assert.ok(select.avatar, 'the account is read with its photo\'s version');
      return {
        id: USER_ID,
        email: 'owner@example.test',
        name: 'Hailong Jiang',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        preferences: {},
        role: 'MEMBER',
        avatar: stored && { updatedAt: stored.updatedAt },
        passwordHash: 'scrypt-hash',
        identities: [],
      };
    },
  },
  userAvatar: {
    upsert: async (args: {
      where: { userId: string };
      create: { userId: string; mimeType: string; data: Uint8Array; updatedAt: Date };
      update: { mimeType: string; data: Uint8Array; updatedAt: Date };
    }) => {
      assert.equal(args.where.userId, USER_ID);
      assert.equal(args.create.userId, USER_ID);
      writes.push('upsert');
      const row = stored ? args.update : args.create;
      stored = { mimeType: row.mimeType, data: Uint8Array.from(row.data), updatedAt: row.updatedAt };
      return stored;
    },
    deleteMany: async ({ where }: { where: { userId: string } }) => {
      assert.equal(where.userId, USER_ID);
      writes.push('delete');
      const count = stored ? 1 : 0;
      stored = null;
      return { count };
    },
    findUnique: async ({ where }: { where: { userId: string } }) => {
      assert.equal(where.userId, USER_ID);
      return stored && { mimeType: stored.mimeType, data: stored.data };
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
class AvatarModule {}

type Call = (method: string, path: string, init?: { body?: FormData; auth?: boolean }) => Promise<Response>;

/** The fields of the account these checks read. */
type Me = { name: string; avatarUpdatedAt: string | null };

async function boot(t: { after: (fn: () => Promise<void>) => void }): Promise<Call> {
  stored = null;
  writes.length = 0;
  const app = await NestFactory.create(AvatarModule, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());
  return (method, path, init = {}) =>
    fetch(`${base}/api/users/${path}`, {
      method,
      headers: init.auth === false ? {} : { authorization: 'Bearer signed-in' },
      body: init.body,
    });
}

function photo(bytes: Uint8Array<ArrayBuffer>, declared: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: declared }), 'avatar');
  return form;
}

test('the bytes decide what a photo is — never the type the client declared', () => {
  assert.equal(sniffAvatarType(JPEG), 'image/jpeg');
  assert.equal(sniffAvatarType(PNG), 'image/png');
  assert.equal(sniffAvatarType(WEBP), 'image/webp');
  assert.equal(sniffAvatarType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffAvatarType(Uint8Array.from([0xff, 0xd8])), null, 'too short to be a JPEG');
  assert.equal(sniffAvatarType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), null,
    'a RIFF file that is not WebP (a WAV)');
});

test('a photo is set, read back by its bytes, replaced, and removed', async (t) => {
  const call = await boot(t);

  const before = (await (await call('GET', 'me')).json()) as Me;
  assert.equal(before.avatarUpdatedAt, null, 'an account with no photo says so');
  assert.equal((await call('GET', 'me/avatar')).status, 404);

  // Declared as something else entirely: the stored type is what the bytes are.
  const set = await call('PUT', 'me/avatar', { body: photo(JPEG, 'application/octet-stream') });
  const account = (await set.json()) as Me;
  assert.equal(set.status, 200, JSON.stringify(account));
  assert.equal(account.name, 'Hailong Jiang', 'the answer is the account, as `me` gives it');
  assert.ok(account.avatarUpdatedAt, 'the account now names its photo\'s version');
  assert.equal(stored?.mimeType, 'image/jpeg');

  const read = await call('GET', 'me/avatar');
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), JPEG);

  // A second photo takes the row over and moves the version on.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const replaced = (await (await call('PUT', 'me/avatar', { body: photo(PNG, 'image/jpeg') })).json()) as Me;
  assert.equal(stored?.mimeType, 'image/png');
  assert.notEqual(replaced.avatarUpdatedAt, account.avatarUpdatedAt, 'a new photo is a new version');
  assert.equal((await call('GET', 'me/avatar')).headers.get('content-type'), 'image/png');

  const removed = await call('DELETE', 'me/avatar');
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as Me).avatarUpdatedAt, null);
  assert.equal((await call('GET', 'me/avatar')).status, 404);
  assert.deepEqual(writes, ['upsert', 'upsert', 'delete']);
});

test('what is not a JPEG, PNG or WebP photo is refused, and nothing is written', async (t) => {
  const call = await boot(t);

  const svg = await call('PUT', 'me/avatar', {
    body: photo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'),
  });
  assert.equal(svg.status, 400);
  assert.match(await svg.text(), /JPEG, PNG or WebP/);

  const none = await call('PUT', 'me/avatar', { body: new FormData() });
  assert.equal(none.status, 400);

  const huge = new Uint8Array(AVATAR_MAX_BYTES + 1);
  huge.set(JPEG);
  const tooBig = await call('PUT', 'me/avatar', { body: photo(huge, 'image/jpeg') });
  assert.equal(tooBig.status, 413, await tooBig.text());

  assert.deepEqual(writes, []);
  assert.equal(stored, null);
});

test('no photo door opens without a signed-in caller', async (t) => {
  const call = await boot(t);

  assert.equal((await call('PUT', 'me/avatar', { body: photo(JPEG, 'image/jpeg'), auth: false })).status, 401);
  assert.equal((await call('DELETE', 'me/avatar', { auth: false })).status, 401);
  assert.equal((await call('GET', 'me/avatar', { auth: false })).status, 401);
  assert.deepEqual(writes, []);
});
