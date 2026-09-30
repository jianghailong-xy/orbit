import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { UsersController } from './users.controller';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

const upload = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype, size: buffer.length, originalname: 'avatar' });

/**
 * Migration 0335 against a real PostgreSQL: the photo the controller keeps is one row per user,
 * replaced whole, typed only as one of the three image kinds, never empty, and gone with its user —
 * and the account `me` answers with names its version.
 */
suite('a profile photo is one row per user, replaced whole, and gone with its user', { timeout: 60_000 }, async (t) => {
  assert.ok(URL, 'COORDINATOR_PG_URL is required');
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  const db = prismaClientFor(URL);
  await sql.connect();
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);

  const userId = randomUUID();
  await db.user.create({
    data: { id: userId, email: `${userId}@avatar.invalid`, name: 'avatar owner', passwordHash: 'x' },
  });
  const users = new UsersController(db as never);
  const caller = { userId, email: `${userId}@avatar.invalid` };

  const bare = await users.me(caller);
  assert.equal(bare?.avatarUpdatedAt, null);

  const first = await users.setAvatar(caller, upload(JPEG, 'image/png'));
  assert.ok(first?.avatarUpdatedAt instanceof Date);
  await new Promise((resolve) => setTimeout(resolve, 5)); // a later millisecond, so a later version
  const second = await users.setAvatar(caller, upload(PNG, 'image/jpeg'));
  const rows = await sql.query<{ mime_type: string; data: Buffer }>(
    'SELECT mime_type, data FROM "user_avatar" WHERE user_id = $1', [userId]);
  assert.equal(rows.rowCount, 1, 'a second photo replaces the first');
  assert.equal(rows.rows[0].mime_type, 'image/png', 'typed by its bytes, not by what the client said');
  assert.deepEqual(rows.rows[0].data, PNG);
  // Read through Prisma: node-pg reads a column without a time zone in the process's own zone.
  const stored = await db.userAvatar.findUnique({ where: { userId }, select: { updatedAt: true } });
  assert.equal(second?.avatarUpdatedAt?.getTime(), stored?.updatedAt.getTime(),
    '`me` names the stored photo\'s version');
  assert.ok(second!.avatarUpdatedAt!.getTime() > first!.avatarUpdatedAt!.getTime(), 'a new photo is a new version');

  const read = await users.avatar(caller);
  assert.equal(read.getHeaders().type, 'image/png');

  // The table holds only what the controller would write.
  await assert.rejects(
    sql.query('UPDATE "user_avatar" SET mime_type = \'image/gif\' WHERE user_id = $1', [userId]),
    (error: { constraint?: string }) => error.constraint === 'user_avatar_mime_type_check');
  await assert.rejects(
    sql.query('UPDATE "user_avatar" SET data = \'\'::bytea WHERE user_id = $1', [userId]),
    (error: { constraint?: string }) => error.constraint === 'user_avatar_data_check');

  const removed = await users.removeAvatar(caller);
  assert.equal(removed?.avatarUpdatedAt, null);
  assert.equal((await sql.query('SELECT 1 FROM "user_avatar" WHERE user_id = $1', [userId])).rowCount, 0);

  // Deleting the account takes its photo too, rather than refusing to delete it.
  await users.setAvatar(caller, upload(JPEG, 'image/jpeg'));
  await db.user.delete({ where: { id: userId } });
  assert.equal((await sql.query('SELECT 1 FROM "user_avatar" WHERE user_id = $1', [userId])).rowCount, 0);
});
