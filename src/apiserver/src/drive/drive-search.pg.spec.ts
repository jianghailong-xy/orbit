/**
 * Drive search (GET /drive/search; migration 1439; drive/drive.service.ts `search`), over a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-search.pg.spec.ts
 *
 *   (1) a file is found by part of its name, any case, in a nested folder, with its path and its folder's path;
 *   (2) nothing in Trash is found, and a file comes back when it is restored;
 *   (3) another account finds nothing of this one's, and this one nothing of theirs;
 *   (4) results are paged by name with a cursor; a `%` in the query is a character, not a wildcard.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { DriveService } from './drive.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('Documents drive: search finds live entries by part of a name, in any folder, for their owner only', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const drive = new DriveService(db as never);
  const accountOf = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const owner = await accountOf('drive-search-owner');
  const stranger = await accountOf('drive-search-stranger');

  const top = await drive.createFolder(owner, { name: 'reports' });
  const nested = await drive.createFolder(owner, { parentId: top.id, name: '2026' });
  const quarterly = await drive.createFile(owner, { parentId: nested.id, name: 'Quarterly-Budget.txt' });
  await drive.createFile(owner, { parentId: top.id, name: 'notes.txt' });
  await drive.createFile(stranger, { name: 'quarterly-secret.txt' });
  const names = async (who: string, q: string) => (await drive.search(who, { q })).entries.map((e) => e.name);

  await t.test('(1) a file is found by part of its name in a nested folder, with its folder', async () => {
    const found = (await drive.search(owner, { q: 'terly-bud' })).entries;
    assert.deepEqual(found.map((e) => e.id), [quarterly.id]);
    assert.equal(found[0].path, '/reports/2026/Quarterly-Budget.txt');
    assert.equal(found[0].folderPath, '/reports/2026');
    assert.deepEqual(await names(owner, 'REPORTS'), ['reports']);
    assert.deepEqual(await names(owner, '   '), []);
  });

  await t.test('(2) Trash is skipped, and a restored file is found again', async () => {
    const group = await drive.moveToTrash(owner, quarterly.id);
    assert.deepEqual(await names(owner, 'budget'), []);
    await drive.restoreGroup(owner, group.trashGroupId);
    assert.deepEqual(await names(owner, 'budget'), ['Quarterly-Budget.txt']);
  });

  await t.test('(3) another account finds nothing of this one, and this one nothing of theirs', async () => {
    assert.deepEqual(await names(stranger, 'budget'), []);
    assert.deepEqual(await names(stranger, 'notes'), []);
    assert.deepEqual(await names(owner, 'secret'), []);
    assert.deepEqual(await names(stranger, 'secret'), ['quarterly-secret.txt']);
  });

  await t.test('(4) pages by name; % is a character', async () => {
    for (const n of ['page-a.txt', 'page-b.txt', 'page-c.txt']) await drive.createFile(owner, { parentId: top.id, name: n });
    await drive.createFile(owner, { parentId: top.id, name: '100%.txt' });
    const first = await drive.search(owner, { q: 'page-', limit: 2 });
    assert.deepEqual(first.entries.map((e) => e.name), ['page-a.txt', 'page-b.txt']);
    assert.ok(first.nextCursor);
    const second = await drive.search(owner, { q: 'page-', limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(second.entries.map((e) => e.name), ['page-c.txt']);
    assert.equal(second.nextCursor, null);
    assert.deepEqual(await names(owner, '%'), ['100%.txt']);
  });
});
