/**
 * A folder of 100,000 entries to Trash and back (docs/orbit-files-drive-technical-design.md §1.4, §3.3, §3.5), over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, through the owner's routes on the real controller:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-trash-large.pg.spec.ts
 *
 *   (1) `DELETE /drive/entries/:id` of a folder with 100,000 descendants (10 folders, 990 under them, 99,000 files) puts
 *       all 100,001 entries in ONE Trash group, its top the folder, with nothing live left under it, and every drive
 *       transaction it ran still bounded (`SET LOCAL statement_timeout = '10s'` first, 20 s in all) and moving at most
 *       1,000 entries; restoring the group brings back all 100,001 under their own names, as bounded;
 *   (2) a delete cut off by the 10 s statement bound answers 503 DRIVE_LIMIT_HIT, not a bare 500, and leaves the folder
 *       live; sent again once the bound is not hit, it succeeds;
 *   (3) a folder whose marking stopped part-way (its process gone) is finished by deleting it again, which answers its
 *       group, or by the drive's timer (finishStoppedTrash), each lifting the group's mark.
 *
 * Found by the 5 GiB walk: one recursive statement marked the whole subtree and was cancelled at 10 s. Not destructive:
 * every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { json } from 'express';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FilesService } from '../files/files.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { DriveChunksService } from './drive-chunks.service';
import { DriveContentService } from './drive-content.service';
import { DriveDownloadLinks } from './drive-download-links';
import { DriveUploadsService } from './drive-uploads.service';
import { DriveController, DriveDownloadController } from './drive.controller';
import { DriveService } from './drive.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const DESCENDANTS = 100_000;
/** What one transaction may move: §3.5's 1,000 entries, and the folder itself in the first one. */
const PER_TRANSACTION = 1_000;
const BOUND = "SET LOCAL statement_timeout = '10s'";

/** One interactive transaction a drive call ran: its client-side timeout and its first raw statement. */
interface SeenTransaction {
  timeout?: number;
  first?: string;
}

test('Orbit Files drive: a folder of 100,000 entries to Trash in one group and back, every transaction bounded', {
  skip: !URL, concurrency: 1, timeout: 1_200_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-trash-large-'));
  const files = new FilesService(db as never, { dir, storage: 'local' });

  // Every interactive transaction the drive opens, seen through the client it is handed.
  const seen: SeenTransaction[] = [];
  const realTransaction = db.$transaction.bind(db) as (work: unknown, options?: { timeout?: number }) => Promise<unknown>;
  (db as unknown as { $transaction: unknown }).$transaction = (work: unknown, options?: { timeout?: number }) => {
    if (typeof work !== 'function') return realTransaction(work, options);
    return realTransaction(async (tx: object) => {
      const record: SeenTransaction = { timeout: options?.timeout };
      seen.push(record);
      const spy = new Proxy(tx, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if ((prop === '$executeRaw' || prop === '$queryRaw') && typeof value === 'function') {
            return (strings: TemplateStringsArray, ...values: unknown[]) => {
              record.first ??= strings.join('?').trim();
              return (value as (...args: unknown[]) => unknown).call(target, strings, ...values);
            };
          }
          return value;
        },
      });
      return (work as (tx: object) => Promise<unknown>)(spy);
    }, options);
  };

  const accountOf = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const owner = await accountOf('drive-trash-large-owner');
  const other = await accountOf('drive-trash-large-other');
  let caller: string = owner;

  @Module({
    controllers: [DriveController, DriveDownloadController],
    providers: [
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: caller }) } },
      { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: `secret-${RUN}` }) },
      { provide: PrismaService, useValue: db },
      { provide: FilesService, useValue: files },
      DriveService, DriveChunksService, DriveUploadsService, DriveContentService, DriveDownloadLinks,
    ],
  })
  class DriveHarness {}
  const app: INestApplication = await NestFactory.create(DriveHarness, { bodyParser: false, logger: false });
  app.use(json());
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  t.after(async () => {
    await app.close();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const drive = app.get(DriveService);

  const call = (who: string, method: string, route: string) => {
    caller = who;
    return fetch(`${origin}/api/drive${route}`, { method, headers: { authorization: 'Bearer signed-in' } });
  };
  const one = async (text: string, ...values: unknown[]) => (await sql.query(text, values)).rows[0] as Record<string, number | string | boolean | null>;
  /** The drive transactions since `from`, each bounded as §1.4 says. */
  const assertBounded = (from: number, label: string) => {
    const ran = seen.slice(from);
    assert.ok(ran.length > 0, `${label}: ran no transaction`);
    for (const [i, tx] of ran.entries()) {
      assert.equal(tx.first, BOUND, `${label}: transaction ${i} began with ${tx.first}, not the statement bound`);
      assert.equal(tx.timeout, 20_000, `${label}: transaction ${i} has a ${tx.timeout} ms timeout`);
    }
    return ran.length;
  };

  await t.test('(1) 100,000 descendants go to Trash through DELETE in one group and come back whole', async () => {
    const big = await drive.createFolder(owner, { name: 'bench-s3' });
    const rootId = big.parentId!;
    // 10 folders, 99 folders in each, 100 empty files in each of those: 10 + 990 + 99,000 = 100,000 below the folder.
    await sql.query('BEGIN');
    await sql.query(
      `INSERT INTO drive_entry (id, owner_id, parent_id, kind, name, last_writer_kind)
       SELECT gen_random_uuid(), $1, $2, 'FOLDER', 'a' || i, 'OWNER' FROM generate_series(0, 9) i`,
      [owner, big.id],
    );
    await sql.query(
      `INSERT INTO drive_entry (id, owner_id, parent_id, kind, name, last_writer_kind)
       SELECT gen_random_uuid(), $1, a.id, 'FOLDER', 'b' || j, 'OWNER'
         FROM drive_entry a, generate_series(0, 98) j WHERE a.owner_id = $1 AND a.parent_id = $2`,
      [owner, big.id],
    );
    await sql.query(
      `INSERT INTO drive_entry (id, owner_id, parent_id, kind, name, current_version_id, last_writer_kind)
       SELECT gen_random_uuid(), $1, b.id, 'FILE', 'f' || k || '.txt', gen_random_uuid(), 'OWNER'
         FROM drive_entry b JOIN drive_entry a ON a.id = b.parent_id, generate_series(0, 99) k
        WHERE b.owner_id = $1 AND a.parent_id = $2`,
      [owner, big.id],
    );
    await sql.query(
      `INSERT INTO drive_version (id, owner_id, entry_id, writer_kind)
       SELECT current_version_id, owner_id, id, 'OWNER' FROM drive_entry WHERE owner_id = $1 AND kind = 'FILE'`,
      [owner],
    );
    await sql.query('COMMIT');
    await sql.query('ANALYZE drive_entry');
    await sql.query('ANALYZE drive_version');
    assert.equal(Number((await one('SELECT count(*) AS n FROM drive_entry WHERE owner_id = $1 AND parent_id IS NOT NULL', owner)).n), DESCENDANTS + 1);

    const before = seen.length;
    const started = Date.now();
    const reply = await call(owner, 'DELETE', `/entries/${big.id}`);
    const tookMs = Date.now() - started;
    assert.equal(reply.status, 200, await reply.clone().text());
    const { trashGroupId } = (await reply.json()) as { trashGroupId: string };
    const trashTransactions = assertBounded(before, 'the delete');
    t.diagnostic(`delete: ${tookMs} ms in ${trashTransactions} transactions`);

    // One group holds the folder and all 100,000 below it; nothing under it is live.
    const marked = await one(
      `SELECT count(*) AS n, count(DISTINCT trash_group_id) AS groups, min(trash_group_id::text) AS group_id,
              count(*) FILTER (WHERE trash_top) AS tops, bool_or(trash_top AND id = $2) AS folder_top
         FROM drive_entry WHERE owner_id = $1 AND trashed_at IS NOT NULL`,
      owner, big.id,
    );
    assert.deepEqual(
      { n: Number(marked.n), groups: Number(marked.groups), group: marked.group_id, tops: Number(marked.tops), folderTop: marked.folder_top },
      { n: DESCENDANTS + 1, groups: 1, group: trashGroupId, tops: 1, folderTop: true },
    );
    assert.equal(Number((await one('SELECT count(*) AS n FROM drive_entry WHERE owner_id = $1 AND parent_id IS NOT NULL AND trashed_at IS NULL', owner)).n), 0);
    const group = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: trashGroupId } });
    assert.deepEqual({ kind: group.kind, items: group.itemCount, marking: group.marking, folderId: group.folderId }, { kind: 'DELETE', items: DESCENDANTS + 1, marking: false, folderId: rootId });
    // Each entry went once, and the feed says so once per entry.
    const removed = await one(`SELECT count(*) AS n, count(DISTINCT entry_id) AS entries FROM drive_change WHERE owner_id = $1 AND op = 'REMOVE'`, owner);
    assert.deepEqual({ n: Number(removed.n), entries: Number(removed.entries) }, { n: DESCENDANTS + 1, entries: DESCENDANTS + 1 });
    // No transaction marked more than a batch: each marks with its own time.
    const perTransaction = await one(
      'SELECT max(n) AS most, count(*) AS batches FROM (SELECT count(*) AS n FROM drive_entry WHERE owner_id = $1 AND trash_group_id = $2 GROUP BY trashed_at) b',
      owner, trashGroupId,
    );
    assert.ok(Number(perTransaction.most) <= PER_TRANSACTION + 1, `one transaction marked ${perTransaction.most} entries`);
    t.diagnostic(`marked in ${perTransaction.batches} batches, at most ${perTransaction.most} each`);

    // Trash shows one group, the folder at its top; the root no longer lists the folder.
    const trash = (await (await call(owner, 'GET', '/trash')).json()) as { groups: Array<{ id: string; itemCount: number; items: Array<{ id: string }> }> };
    assert.deepEqual(trash.groups.map((g) => ({ id: g.id, itemCount: g.itemCount, items: g.items.map((i) => i.id) })), [{ id: trashGroupId, itemCount: DESCENDANTS + 1, items: [big.id] }]);
    // Another account's restore of it is not found and writes nothing.
    assert.equal((await call(other, 'POST', `/trash/groups/${trashGroupId}/restore`)).status, 404);

    const beforeRestore = seen.length;
    const restoreStarted = Date.now();
    const back = await call(owner, 'POST', `/trash/groups/${trashGroupId}/restore`);
    const restoreMs = Date.now() - restoreStarted;
    assert.equal(back.status, 200, await back.clone().text());
    const { entryIds } = (await back.json()) as { entryIds: string[] };
    const restoreTransactions = assertBounded(beforeRestore, 'the restore');
    t.diagnostic(`restore: ${restoreMs} ms in ${restoreTransactions} transactions`);
    assert.equal(entryIds.length, DESCENDANTS + 1);
    assert.equal(new Set(entryIds).size, DESCENDANTS + 1);

    const live = await one(
      `SELECT count(*) AS n, count(*) FILTER (WHERE trashed_at IS NOT NULL OR trash_group_id IS NOT NULL OR trash_top) AS still,
              count(*) FILTER (WHERE name LIKE '% (%)%') AS suffixed
         FROM drive_entry WHERE owner_id = $1 AND parent_id IS NOT NULL`,
      owner,
    );
    assert.deepEqual({ n: Number(live.n), still: Number(live.still), suffixed: Number(live.suffixed) }, { n: DESCENDANTS + 1, still: 0, suffixed: 0 });
    assert.equal((await db.driveEntry.findUniqueOrThrow({ where: { id: big.id } })).parentId, rootId);
    assert.equal(await db.driveTrashGroup.count({ where: { id: trashGroupId } }), 0);
    const tree = await one(
      `SELECT count(*) FILTER (WHERE kind = 'FOLDER') AS folders, count(*) FILTER (WHERE kind = 'FILE') AS files
         FROM drive_entry WHERE owner_id = $1 AND parent_id IS NOT NULL AND id <> $2`,
      owner, big.id,
    );
    assert.deepEqual({ folders: Number(tree.folders), files: Number(tree.files) }, { folders: 1_000, files: 99_000 });
    const restoredPer = await one(
      'SELECT max(n) AS most FROM (SELECT count(*) AS n FROM drive_entry WHERE owner_id = $1 AND parent_id IS NOT NULL GROUP BY updated_at) b',
      owner,
    );
    assert.ok(Number(restoredPer.most) <= PER_TRANSACTION, `one transaction restored ${restoredPer.most} entries`);
    const upserted = await one(`SELECT count(DISTINCT entry_id) AS entries FROM drive_change WHERE owner_id = $1 AND op = 'UPSERT'`, owner);
    assert.ok(Number(upserted.entries) >= DESCENDANTS + 1);
  });

  await t.test('(2) a delete cut off by the statement bound answers 503 DRIVE_LIMIT_HIT and leaves the folder live', async () => {
    const held = await drive.createFolder(owner, { name: `held-${RUN}` });
    await drive.createFile(owner, { parentId: held.id, name: 'inside.txt' });
    // Another session holds the folder's row, so the delete's lock on it waits past the 10 s bound.
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM drive_entry WHERE id = $1 FOR UPDATE', [held.id]);
      const started = Date.now();
      const reply = await call(owner, 'DELETE', `/entries/${held.id}`);
      t.diagnostic(`answered ${reply.status} after ${Date.now() - started} ms`);
      assert.equal(reply.status, 503, await reply.clone().text());
      const body = (await reply.json()) as { code: string; retryable: boolean };
      assert.equal(body.code, 'DRIVE_LIMIT_HIT');
      assert.equal(body.retryable, true);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end().catch(() => undefined);
    }
    assert.equal((await db.driveEntry.findUniqueOrThrow({ where: { id: held.id } })).trashedAt, null);
    const again = await call(owner, 'DELETE', `/entries/${held.id}`);
    assert.equal(again.status, 200, await again.clone().text());
    const { trashGroupId } = (await again.json()) as { trashGroupId: string };
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner, trashGroupId } }), 2);
  });

  await t.test('(3) a marking that stopped part-way is finished by deleting again, or by the timer', async () => {
    /** A folder with a folder and files under it whose trash stopped after its first step: only the folder marked. */
    const stoppedFolder = async (name: string) => {
      const folder = await drive.createFolder(owner, { name });
      const sub = await drive.createFolder(owner, { parentId: folder.id, name: 'sub' });
      for (const f of ['a.txt', 'b.txt']) await drive.createFile(owner, { parentId: sub.id, name: f });
      await drive.createFile(owner, { parentId: folder.id, name: 'c.txt' });
      const groupId = randomUUID();
      const long = new Date(Date.now() - 60 * 60 * 1000);
      await db.driveTrashGroup.create({
        data: {
          id: groupId, ownerId: owner, kind: 'DELETE', folderId: folder.parentId, folderPath: '/', createdAt: long,
          lastAddedAt: long, closedAt: long, actorKind: 'OWNER', itemCount: 1, marking: true,
        },
      });
      await db.driveEntry.update({ where: { id: folder.id }, data: { trashedAt: long, trashGroupId: groupId, trashTop: true } });
      return { folder, groupId };
    };
    const inGroup = (groupId: string) => db.driveEntry.count({ where: { ownerId: owner, trashGroupId: groupId } });
    const liveUnder = async (folderId: string) =>
      Number((await one(
        `WITH RECURSIVE sub AS (SELECT id FROM drive_entry WHERE parent_id = $1 UNION ALL SELECT e.id FROM drive_entry e JOIN sub ON e.parent_id = sub.id)
         SELECT count(*) AS n FROM drive_entry e JOIN sub ON sub.id = e.id WHERE e.trashed_at IS NULL`,
        folderId,
      )).n);

    const first = await stoppedFolder(`stopped-${RUN}`);
    assert.equal(await liveUnder(first.folder.id), 4);
    const again = await call(owner, 'DELETE', `/entries/${first.folder.id}`);
    assert.equal(again.status, 200, await again.clone().text());
    assert.deepEqual(await again.json(), { trashGroupId: first.groupId });
    assert.equal(await liveUnder(first.folder.id), 0);
    assert.equal(await inGroup(first.groupId), 5);
    const finished = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: first.groupId } });
    assert.deepEqual({ marking: finished.marking, items: finished.itemCount }, { marking: false, items: 5 });
    // Finished, it is in Trash like any other: deleting it again is not found.
    assert.equal((await call(owner, 'DELETE', `/entries/${first.folder.id}`)).status, 404);

    const second = await stoppedFolder(`stopped-timer-${RUN}`);
    assert.ok((await drive.finishStoppedTrash()) >= 1);
    assert.equal(await liveUnder(second.folder.id), 0);
    assert.equal(await inGroup(second.groupId), 5);
    assert.equal((await db.driveTrashGroup.findUniqueOrThrow({ where: { id: second.groupId } })).marking, false);
    assert.equal(await drive.finishStoppedTrash(), 0);
  });
});
