/**
 * Two owner routes of the Files page (docs/drive-technical-design.md §3.5, §4.1; board 02-web frame 6, D12),
 * over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, with chunks on a files directory of this run's:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-restore-item-download.pg.spec.ts
 *
 *   (1) one item restored out of a Trash group comes back to its folder; the rest stay in the group, recounted;
 *   (2) an item under a deleted folder comes back in that folder made again, with what hangs under it; the group keeps
 *       the deleted folder;
 *   (3) a name a live entry took meanwhile gets the first free suffix;
 *   (4) the group's last item restored deletes the group; the item restored again is answered 404 with nothing written;
 *   (5) another account's group or item is not found, and B's own group with A's item writes nothing;
 *   (6) a minted download URL streams the current version with no login header — as an attachment, with Range — and one
 *       for a replaced version serves that version;
 *   (7) a forged, expired or stale URL is the one 404; another account cannot mint one for the file, nor for a version of
 *       another file.
 *
 * The routes are called through the real controllers over a small express app. Not destructive: every row belongs to
 * users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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
import { DRIVE_DOWNLOAD_LINK_NOT_FOUND, DriveDownloadLinks } from './drive-download-links';
import { DriveUploadsService } from './drive-uploads.service';
import { DriveController, DriveDownloadController } from './drive.controller';
import { DriveService, OWNER_WRITER } from './drive.service';
import { DriveSyncsService } from './drive-syncs.service';
import { DriveActivity } from './drive-activity';

// Drive is off unless switched on (drive-switch.ts); this harness mounts its controller, so it switches it on.
process.env.ORBIT_DRIVE_ENABLED = 'true';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('Documents drive: restore one item out of Trash, and the minted download URL', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-item-dl-'));
  const files = new FilesService(db as never, { dir, storage: 'local' });
  const accountOf = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const owner = await accountOf('drive-item-owner');
  const stranger = await accountOf('drive-item-stranger');
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
      DriveService, DriveChunksService, DriveUploadsService, DriveContentService, DriveDownloadLinks, DriveSyncsService,
      DriveActivity,
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
  const chunks = app.get(DriveChunksService);

  const call = (who: string, method: string, route: string, body?: unknown) => {
    caller = who;
    return fetch(`${origin}/api/documents${route}`, {
      method,
      headers: { authorization: 'Bearer signed-in', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
  /** A file of `who`'s in `parentId` holding `bytes`, written as one overwrite through the chunk door. */
  const fileWith = async (who: string, parentId: string, name: string, bytes: Buffer) => {
    const entry = await drive.createFile(who, { parentId, name });
    const staging = await chunks.openStaging(who, { source: 'TOOL' });
    await chunks.putChunk(who, staging.id, 0, sha256(bytes), Readable.from([bytes]));
    await drive.commit(who, {
      commitId: randomUUID(), entryId: entry.id, mode: 'OVERWRITE', stagingId: staging.id,
      chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }], writer: OWNER_WRITER,
    });
    return entry.id;
  };
  const entryOf = (id: string) => db.driveEntry.findUniqueOrThrow({ where: { id } });
  const liveNames = async (who: string, parentId: string) =>
    (await db.driveEntry.findMany({ where: { ownerId: who, parentId, trashedAt: null }, orderBy: { name: 'asc' } })).map((e) => e.name);
  const rowsOf = async (who: string) => (await sql.query('SELECT count(*)::int AS n FROM drive_entry WHERE owner_id = $1', [who])).rows[0].n as number;
  const restoreItem = (who: string, groupId: string, entryId: string) => call(who, 'POST', `/trash/groups/${groupId}/items/${entryId}/restore`);

  const folder = await drive.createFolder(owner, { name: 'Orbit UI migration' });

  await t.test('(1) one item comes back to its folder; the rest stay in the group, recounted', async () => {
    // An agent's burst: three files deleted under one burst key make one group.
    const ids = [];
    for (const name of ['keep-a.md', 'keep-b.md', 'wanted.png']) ids.push(await fileWith(owner, folder.id, name, Buffer.from(name)));
    let groupId = '';
    for (const id of ids) groupId = (await drive.moveToTrash(owner, id, { burstKey: `burst-${RUN}` })).trashGroupId;
    const group = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: groupId } });
    assert.equal(group.itemCount, 3);

    const reply = await restoreItem(owner, groupId, ids[2]);
    assert.equal(reply.status, 200, await reply.clone().text());
    assert.deepEqual(((await reply.json()) as { entryIds: string[] }).entryIds, [ids[2]]);
    const back = await entryOf(ids[2]);
    assert.equal(back.trashedAt, null);
    assert.equal(back.parentId, folder.id);
    assert.equal(back.name, 'wanted.png');
    assert.deepEqual(await liveNames(owner, folder.id), ['wanted.png']);
    const left = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: groupId } });
    assert.equal(left.itemCount, 2);
    assert.equal(Number(left.sizeBytes), 'keep-a.md'.length + 'keep-b.md'.length);
    for (const id of ids.slice(0, 2)) assert.equal((await entryOf(id)).trashGroupId, groupId);
    // Cleaned for the next steps.
    await drive.deleteGroup(owner, groupId);
  });

  await t.test('(2) an item under a deleted folder comes back in that folder made again, with what is under it', async () => {
    const screens = await drive.createFolder(owner, { parentId: folder.id, name: 'screens' });
    const sub = await drive.createFolder(owner, { parentId: screens.id, name: 'final' });
    const inSub = await fileWith(owner, sub.id, 'login.png', Buffer.from('login'));
    await fileWith(owner, screens.id, 'other.png', Buffer.from('other'));
    const { trashGroupId } = await drive.moveToTrash(owner, screens.id);

    const reply = await restoreItem(owner, trashGroupId, sub.id);
    assert.equal(reply.status, 200, await reply.clone().text());
    const restored = ((await reply.json()) as { entryIds: string[] }).entryIds;
    assert.deepEqual(restored.sort(), [sub.id, inSub].sort());
    const subNow = await entryOf(sub.id);
    assert.equal(subNow.trashedAt, null);
    assert.equal(subNow.name, 'final');
    // Its folder was in Trash: a live `screens` is made again in the original's place, and the deleted one stays.
    const remade = await entryOf(subNow.parentId!);
    assert.notEqual(remade.id, screens.id);
    assert.equal(remade.name, 'screens');
    assert.equal(remade.parentId, folder.id);
    assert.equal(remade.trashedAt, null);
    assert.equal((await entryOf(inSub)).trashedAt, null);
    assert.equal((await entryOf(inSub)).parentId, sub.id);
    assert.equal((await entryOf(screens.id)).trashGroupId, trashGroupId);
    const left = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: trashGroupId } });
    assert.equal(left.itemCount, 2); // screens and other.png
    await drive.deleteGroup(owner, trashGroupId);
  });

  await t.test('(3) a name a live entry took meanwhile gets the first free suffix', async () => {
    const first = await fileWith(owner, folder.id, 'brief.md', Buffer.from('one'));
    const { trashGroupId } = await drive.moveToTrash(owner, first);
    await fileWith(owner, folder.id, 'brief.md', Buffer.from('two'));
    const reply = await restoreItem(owner, trashGroupId, first);
    assert.equal(reply.status, 200);
    assert.equal((await entryOf(first)).name, 'brief (2).md');
  });

  await t.test('(4) the last item restored deletes the group; again is 404 with nothing written', async () => {
    const only = await fileWith(owner, folder.id, 'alone.txt', Buffer.from('alone'));
    const { trashGroupId } = await drive.moveToTrash(owner, only);
    assert.equal((await restoreItem(owner, trashGroupId, only)).status, 200);
    assert.equal(await db.driveTrashGroup.findUnique({ where: { id: trashGroupId } }), null);
    const before = await rowsOf(owner);
    assert.equal((await restoreItem(owner, trashGroupId, only)).status, 404);
    assert.equal(await rowsOf(owner), before);
  });

  await t.test('(5) another account\'s group or item is not found, and B\'s own group with A\'s item writes nothing', async () => {
    const mine = await fileWith(owner, folder.id, 'private.txt', Buffer.from('private'));
    const { trashGroupId } = await drive.moveToTrash(owner, mine);
    const theirsFolder = await drive.createFolder(stranger, { name: 'theirs' });
    const theirs = await drive.createFile(stranger, { parentId: theirsFolder.id, name: 'x.txt' });
    const theirGroup = (await drive.moveToTrash(stranger, theirs.id)).trashGroupId;
    const ownerRows = await rowsOf(owner);
    assert.equal((await restoreItem(stranger, trashGroupId, mine)).status, 404);
    assert.equal((await restoreItem(stranger, theirGroup, mine)).status, 404);
    assert.equal(await rowsOf(owner), ownerRows);
    assert.equal((await entryOf(mine)).trashGroupId, trashGroupId);
    assert.equal((await restoreItem(stranger, theirGroup, theirs.id)).status, 200);
  });

  // ── the download URL ─────────────────────────────────────────────────────────────────────────

  const first = randomBytes(300_000);
  const second = randomBytes(200_000);
  const report = await fileWith(owner, folder.id, 'eval report.bin', first);
  const firstVersion = (await entryOf(report)).currentVersionId!;
  // An overwrite: the first version is replaced and goes to Trash.
  {
    const staging = await chunks.openStaging(owner, { source: 'TOOL' });
    await chunks.putChunk(owner, staging.id, 0, sha256(second), Readable.from([second]));
    await drive.commit(owner, {
      commitId: randomUUID(), entryId: report, mode: 'OVERWRITE', stagingId: staging.id,
      chunks: [{ idx: 0, sha256: sha256(second), size: second.length }], writer: OWNER_WRITER,
    });
  }
  const mint = async (who: string, id: string, body: Record<string, unknown> = {}) => call(who, 'POST', `/entries/${id}/download-link`, body);
  /** The URL opened as a browser opens it: no login header at all. */
  const open = (pathName: string, headers: Record<string, string> = {}) => fetch(`${origin}${pathName}`, { headers });

  await t.test('(6) a minted URL streams the current version with no login, as an attachment, with Range; a version too', async () => {
    const reply = await mint(owner, report);
    assert.equal(reply.status, 200, await reply.clone().text());
    const link = (await reply.json()) as { path: string; expiresAt: string };
    assert.match(link.path, /^\/api\/drive\/dl\/[^/]+$/);
    assert.ok(Date.parse(link.expiresAt) > Date.now() && Date.parse(link.expiresAt) <= Date.now() + 5 * 60_000 + 1000);
    const whole = await open(link.path);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('eval report.bin')}`);
    assert.equal(whole.headers.get('content-length'), String(second.length));
    assert.equal(sha256(Buffer.from(await whole.arrayBuffer())), sha256(second));
    const part = await open(link.path, { range: 'bytes=1000-1999' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${second.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), second.subarray(1000, 2000));

    const older = (await (await mint(owner, report, { versionId: firstVersion })).json()) as { path: string };
    const bytes = Buffer.from(await (await open(older.path)).arrayBuffer());
    assert.equal(sha256(bytes), sha256(first));
  });

  await t.test('(7) forged, expired or stale is the one 404; another account cannot mint', async () => {
    const link = (await (await mint(owner, report)).json()) as { path: string };
    const forged = link.path.slice(0, -4) + (link.path.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const answers = [];
    answers.push(await open(forged));
    answers.push(await open('/api/documents/dl/not-a-token'));
    // Minted ten minutes ago: expired five minutes later.
    const realNow = Date.now;
    Date.now = () => realNow() - 10 * 60_000;
    let expired: { path: string };
    try {
      expired = await app.get(DriveDownloadLinks).mint(owner, report);
    } finally {
      Date.now = realNow;
    }
    answers.push(await open(expired.path));
    // Stale: the version it names was deleted for good.
    const replaced = (await (await mint(owner, report, { versionId: firstVersion })).json()) as { path: string };
    await drive.deleteVersion(owner, firstVersion);
    answers.push(await open(replaced.path));
    for (const answer of answers) {
      assert.equal(answer.status, 404);
      assert.equal(((await answer.json()) as { code: string }).code, DRIVE_DOWNLOAD_LINK_NOT_FOUND);
    }

    // Another account: the file, and its own file with this file's version, are not found.
    assert.equal((await mint(stranger, report)).status, 404);
    const theirsFolder = await drive.createFolder(stranger, { name: 'theirs two' });
    const theirs = await fileWith(stranger, theirsFolder.id, 'mine.bin', Buffer.from('theirs'));
    const current = (await entryOf(report)).currentVersionId!;
    assert.equal((await mint(stranger, theirs, { versionId: current })).status, 404);
    // Nor the owner's own other file with this file's version.
    const other = await fileWith(owner, folder.id, 'other.bin', Buffer.from('other'));
    assert.equal((await mint(owner, other, { versionId: current })).status, 404);
  });
});
