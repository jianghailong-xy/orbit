/**
 * The owner's resumable upload and ranged download (docs/drive-technical-design.md §4.1;
 * drive/drive-uploads.service.ts, drive-content.service.ts, drive.controller.ts), over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, with the chunks on a files directory of this run's:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-uploads.pg.spec.ts
 *
 *   (1) an upload interrupted after some parts is read back by its status, resumes with the rest, completes, and the
 *       file downloads with the sha256 it was sent with; completing again answers the same file;
 *   (2) a ranged download returns the requested bytes, across chunk edges, with Content-Range and 206; a range past the
 *       end is 416; If-None-Match answers 304; a version downloads by its own route;
 *   (3) the chunk route refuses a part above 8 MiB (by its Content-Length and by its bytes) with a readable 413, and a
 *       part whose bytes are not its sha256 with 400;
 *   (4) an upload that is not complete is refused 409 naming the chunks to send; abandon removes the staging;
 *   (5) a dropped folder's files share one top folder: the first takes a suffix when the name is taken, the rest send
 *       its `dropRootId` back, and missing sub-folders are made once;
 *   (6) another account's upload and file are not found;
 *   (7) two completes of one upload, forced to overlap inside the file's creation, make one entry and one version, and
 *       both answer that entry.
 *
 * The routes are called through the real controller over a small express app, so the headers and statuses are the ones
 * a client sees. Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type INestApplication, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { json } from 'express';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { FilesService } from '../files/files.service';
import { UserFileResponseInterceptor } from '../files/user-file-response';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { DriveChunksService, DRIVE_CHUNK_MAX } from './drive-chunks.service';
import { DriveContentService } from './drive-content.service';
import { DriveDownloadLinks } from './drive-download-links';
import { DriveUploadsService } from './drive-uploads.service';
import { DriveController, DriveDownloadController } from './drive.controller';
import { DriveService } from './drive.service';
import { DriveSyncsService } from './drive-syncs.service';
import { DriveActivity } from './drive-activity';

// Drive is off unless switched on (drive-switch.ts); this harness mounts its controller, so it switches it on.
process.env.ORBIT_DRIVE_ENABLED = 'true';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('Documents drive: resumable upload and ranged download', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-drive-uploads-'));
  const files = new FilesService(db as never, { dir, storage: 'local' });
  const accountOf = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@orbit-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const owner = await accountOf('drive-up-owner');
  const stranger = await accountOf('drive-up-stranger');
  let caller: string = owner;

  @Module({
    controllers: [DriveController, DriveDownloadController],
    providers: [
      JwtAuthGuard,
      Reflector,
      // As FilesModule registers it: every StreamableFile leaves under the user-file rule.
      { provide: APP_INTERCEPTOR, useClass: UserFileResponseInterceptor },
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: caller }) } },
      { provide: PrismaService, useValue: db },
      { provide: FilesService, useValue: files },
      // The controller's download-link route needs its signer; this spec does not call it.
      { provide: ConfigService, useValue: new ConfigService({ JWT_SECRET: `secret-${RUN}` }) },
      DriveService, DriveChunksService, DriveUploadsService, DriveContentService, DriveDownloadLinks, DriveSyncsService,
      DriveActivity,
    ],
  })
  class DriveHarness {}
  const app: INestApplication = await NestFactory.create(DriveHarness, { bodyParser: false, logger: false });
  app.use(json());
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/documents`;
  t.after(async () => {
    await app.close();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const as = async <T>(who: string, fn: () => Promise<T>): Promise<T> => {
    caller = who;
    return fn();
  };
  const call = (method: string, route: string, init: { body?: unknown; headers?: Record<string, string>; raw?: Buffer } = {}) =>
    fetch(`${base}${route}`, {
      method,
      headers: { authorization: 'Bearer signed-in', ...(init.body !== undefined ? { 'content-type': 'application/json' } : init.raw ? { 'content-type': 'application/octet-stream' } : {}), ...init.headers },
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    });
  const open = async (body: Record<string, unknown>) => {
    const reply = await call('POST', '/uploads', { body });
    assert.equal(reply.status, 201, await reply.clone().text());
    return (await reply.json()) as { id: string; chunkSize: number; parentId: string; dropRootId: string | null };
  };
  const putChunk = (id: string, idx: number, bytes: Buffer, sha = sha256(bytes)) =>
    call('PUT', `/uploads/${id}/chunks/${idx}`, { raw: bytes, headers: { 'x-orbit-chunk-sha256': sha } });
  const download = async (id: string, range?: string, headers: Record<string, string> = {}) => {
    const reply = await call('GET', `/entries/${id}/content`, { headers: { ...(range ? { range } : {}), ...headers } });
    return { reply, bytes: Buffer.from(await reply.arrayBuffer()) };
  };

  // A 20 MiB + 123 byte file: three chunks (8 MiB, 8 MiB, the rest).
  const whole = randomBytes(2 * DRIVE_CHUNK_MAX + 123);
  const parts = [whole.subarray(0, DRIVE_CHUNK_MAX), whole.subarray(DRIVE_CHUNK_MAX, 2 * DRIVE_CHUNK_MAX), whole.subarray(2 * DRIVE_CHUNK_MAX)];
  let entryId = '';
  let versionId = '';

  await t.test('(1) an interrupted upload resumes and completes with the right sha256', async () => {
    const upload = await open({ name: 'big.bin', size: whole.length });
    assert.equal(upload.chunkSize, DRIVE_CHUNK_MAX);
    assert.equal((await putChunk(upload.id, 0, parts[0])).status, 200);
    assert.equal((await putChunk(upload.id, 2, parts[2])).status, 200); // out of order, then the connection is lost
    // A reload: the status says what arrived.
    const status = (await (await call('GET', `/uploads/${upload.id}`)).json()) as { chunks: Array<{ idx: number }>; completed: boolean };
    assert.deepEqual(status.chunks.map((c) => c.idx), [0, 2]);
    assert.equal(status.completed, false);
    // Completing now says which chunk to send.
    const early = await call('POST', `/uploads/${upload.id}/complete`);
    assert.equal(early.status, 409);
    const refusal = (await early.json()) as { code: string; message: string; missing: number[] };
    assert.equal(refusal.code, 'DRIVE_UPLOAD_INCOMPLETE');
    assert.deepEqual(refusal.missing, [1]);
    assert.match(refusal.message, /send chunks 1/);
    // Resume: the missing chunk, and chunk 0 again (idempotent).
    assert.equal((await putChunk(upload.id, 1, parts[1])).status, 200);
    assert.equal((await putChunk(upload.id, 0, parts[0])).status, 200);
    const done = await call('POST', `/uploads/${upload.id}/complete`);
    assert.equal(done.status, 200, await done.clone().text());
    const entry = (await done.json()) as { id: string; sizeBytes: number; name: string; currentVersionId: string };
    entryId = entry.id;
    versionId = entry.currentVersionId;
    assert.equal(entry.sizeBytes, whole.length);
    assert.equal(entry.name, 'big.bin');
    const again = (await (await call('POST', `/uploads/${upload.id}/complete`)).json()) as { id: string };
    assert.equal(again.id, entryId, 'a second complete answers the same file');
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner, name: 'big.bin' } }), 1);
    const got = await download(entryId);
    assert.equal(got.reply.status, 200);
    assert.equal(sha256(got.bytes), sha256(whole));
    assert.equal(got.reply.headers.get('accept-ranges'), 'bytes');
    assert.equal(got.reply.headers.get('etag')?.startsWith(`"${versionId}.`), true);
  });

  await t.test('(1b) every content reply names the file it saves, under the user-file rule', async () => {
    const name = 'résumé 日本語.bin';
    const upload = await open({ name, size: 5 });
    assert.equal((await putChunk(upload.id, 0, Buffer.from('hello'))).status, 200);
    const done = (await (await call('POST', `/uploads/${upload.id}/complete`)).json()) as { id: string; currentVersionId: string };
    const expected = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    const link = (await (await call('POST', `/entries/${done.id}/download-link`, { body: {} })).json()) as { path: string };
    const routes = [
      await fetch(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}${link.path}`),
      (await download(done.id)).reply,
      await call('GET', `/versions/${done.currentVersionId}/content`),
    ];
    for (const reply of routes) {
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get('content-disposition'), expected);
      assert.equal(reply.headers.get('content-security-policy'), 'sandbox');
      assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  await t.test('(2) a ranged download returns the requested bytes', async () => {
    const cases: Array<[string, number, number]> = [
      ['bytes=0-9', 0, 9],
      [`bytes=${DRIVE_CHUNK_MAX - 5}-${DRIVE_CHUNK_MAX + 4}`, DRIVE_CHUNK_MAX - 5, DRIVE_CHUNK_MAX + 4], // across a chunk edge
      [`bytes=${DRIVE_CHUNK_MAX + 100}-${2 * DRIVE_CHUNK_MAX + 10}`, DRIVE_CHUNK_MAX + 100, 2 * DRIVE_CHUNK_MAX + 10], // across two edges
      [`bytes=${whole.length - 20}-`, whole.length - 20, whole.length - 1],
      ['bytes=-7', whole.length - 7, whole.length - 1],
    ];
    for (const [range, start, end] of cases) {
      const { reply, bytes } = await download(entryId, range);
      assert.equal(reply.status, 206, range);
      assert.equal(reply.headers.get('content-range'), `bytes ${start}-${end}/${whole.length}`);
      assert.equal(reply.headers.get('content-length'), String(end - start + 1));
      assert.ok(bytes.equals(whole.subarray(start, end + 1)), `the bytes of ${range}`);
    }
    const past = await download(entryId, `bytes=${whole.length}-`);
    assert.equal(past.reply.status, 416);
    assert.equal(past.reply.headers.get('content-range'), `bytes */${whole.length}`);
    const etag = (await download(entryId)).reply.headers.get('etag')!;
    assert.equal((await download(entryId, undefined, { 'if-none-match': etag })).reply.status, 304);
    const stale = await download(entryId, 'bytes=0-3', { 'if-range': '"other"' });
    assert.equal(stale.reply.status, 200, 'a stale If-Range serves the whole file');
    const version = await call('GET', `/versions/${versionId}/content`, { headers: { range: 'bytes=3-5' } });
    assert.equal(version.status, 206);
    assert.ok(Buffer.from(await version.arrayBuffer()).equals(whole.subarray(3, 6)));
  });

  await t.test('(3) a part above the limit is refused readably; a wrong sha256 is refused', async () => {
    const upload = await open({ name: 'limit.bin', size: DRIVE_CHUNK_MAX + 1 });
    const tooBig = Buffer.alloc(DRIVE_CHUNK_MAX + 1, 1);
    const byLength = await putChunk(upload.id, 0, tooBig);
    assert.equal(byLength.status, 413);
    const body = (await byLength.json()) as { code: string; message: string };
    assert.equal(body.code, 'DRIVE_CHUNK_TOO_LARGE');
    assert.match(body.message, /at most 8388608 bytes \(8 MiB\)/);
    // A body that streams past the limit with no honest length is refused as well (chunked transfer).
    const streamed = await fetch(`${base}/uploads/${upload.id}/chunks/0`, {
      method: 'PUT',
      headers: { authorization: 'Bearer signed-in', 'content-type': 'application/octet-stream', 'x-orbit-chunk-sha256': sha256(tooBig) },
      body: new ReadableStream({ start(c) { c.enqueue(tooBig); c.close(); } }),
      duplex: 'half',
    });
    assert.equal(streamed.status, 413);
    assert.equal(((await streamed.json()) as { code: string }).code, 'DRIVE_CHUNK_TOO_LARGE');
    const wrong = await putChunk(upload.id, 0, Buffer.from('abc'), sha256(Buffer.from('xyz')));
    assert.equal(wrong.status, 400);
    assert.equal(((await wrong.json()) as { code: string }).code, 'DRIVE_CHUNK_SHA256_MISMATCH');
    assert.equal(await db.driveStagingChunk.count({ where: { stagingId: upload.id } }), 0, 'nothing was kept');
  });

  await t.test('(4) abandon removes the upload and its chunk rows', async () => {
    const upload = await open({ name: 'gone.bin', size: 3 });
    assert.equal((await putChunk(upload.id, 0, Buffer.from('abc'))).status, 200);
    assert.equal((await call('DELETE', `/uploads/${upload.id}`)).status, 200);
    assert.equal((await call('GET', `/uploads/${upload.id}`)).status, 404);
    assert.equal(await db.driveStagingChunk.count({ where: { stagingId: upload.id } }), 0);
  });

  await t.test('(5) a dropped folder shares one top folder, suffixed once', async () => {
    const existing = await call('POST', '/folders', { body: { name: 'Photos' } });
    assert.equal(existing.status, 201);
    const send = async (relativePath: string, content: string, dropRootId?: string) => {
      const name = relativePath.split('/').pop()!;
      const upload = await open({ name, size: content.length, relativePath, dropRootId });
      assert.equal((await putChunk(upload.id, 0, Buffer.from(content))).status, 200);
      const done = (await (await call('POST', `/uploads/${upload.id}/complete`)).json()) as { id: string; parentId: string };
      return { upload, done };
    };
    const first = await send('Photos/2026/a.txt', 'aaa');
    assert.ok(first.upload.dropRootId);
    const top = await db.driveEntry.findFirstOrThrow({ where: { id: first.upload.dropRootId!, ownerId: owner } });
    assert.equal(top.name, 'Photos (2)', 'the taken name gets one suffix');
    const second = await send('Photos/2026/b.txt', 'bbb', first.upload.dropRootId!);
    const third = await send('Photos/c.txt', 'ccc', first.upload.dropRootId!);
    assert.equal(second.upload.dropRootId, top.id);
    assert.equal(second.done.parentId, first.done.parentId, 'the same sub-folder');
    assert.equal(third.done.parentId, top.id);
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner, name: { startsWith: 'Photos' }, parentId: top.parentId } }), 2);
    assert.equal(await db.driveEntry.count({ where: { ownerId: owner, name: '2026', parentId: top.id } }), 1);
  });

  await t.test('(6) another account sees none of it', async () => {
    const mine = await open({ name: 'private.bin', size: 3 });
    await as(stranger, async () => {
      assert.equal((await call('GET', `/uploads/${mine.id}`)).status, 404);
      assert.equal((await putChunk(mine.id, 0, Buffer.from('abc'))).status, 404);
      assert.equal((await call('POST', `/uploads/${mine.id}/complete`)).status, 404);
      assert.equal((await call('DELETE', `/uploads/${mine.id}`)).status, 404);
      assert.equal((await call('GET', `/entries/${entryId}/content`)).status, 404);
      assert.equal((await call('GET', `/versions/${versionId}/content`)).status, 404);
      assert.equal((await call('POST', '/uploads', { body: { name: 'x', size: 1, parentId: (await db.driveEntry.findFirstOrThrow({ where: { ownerId: owner, parentId: { not: null }, kind: 'FOLDER' } })).id } })).status, 404);
    });
    caller = owner;
  });

  await t.test('(7) two overlapping completes of one upload make one file', async () => {
    const drive = app.get(DriveService);
    const upload = await open({ name: 'race.bin', size: 3 });
    assert.equal((await putChunk(upload.id, 0, Buffer.from('abc'))).status, 200);
    const original = drive.createFile.bind(drive);
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    drive.createFile = async (...args: Parameters<typeof original>) => {
      entered();
      await gate; // the first complete holds here, creation not yet done
      return original(...args);
    };
    try {
      const first = call('POST', `/uploads/${upload.id}/complete`);
      await inside;
      const second = call('POST', `/uploads/${upload.id}/complete`);
      const early = await Promise.race([second.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 500))]);
      assert.equal(early, 'waiting', 'the second complete waits for the first');
      release();
      const [a, b] = await Promise.all([first, second]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      const [ea, eb] = [(await a.json()) as { id: string }, (await b.json()) as { id: string }];
      assert.equal(ea.id, eb.id, 'both callers end on the same entry');
      assert.equal(await db.driveEntry.count({ where: { ownerId: owner, name: { startsWith: 'race' } } }), 1, 'one entry');
      assert.equal(await db.driveVersion.count({ where: { entryId: ea.id } }), 1);
    } finally {
      drive.createFile = original;
    }
  });
});
