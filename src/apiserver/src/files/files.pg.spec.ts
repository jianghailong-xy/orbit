/**
 * Orbit Files' storage layer (docs/orbit-files-design.md §2.1, §2.10; migration 0462; files/), held against the
 * production apiserver — `build/main.js`, the whole AppModule, multer and every guard and pipe in front of the routes —
 * over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, once with each store:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/files.pg.spec.ts
 *
 *   local  the files directory, a directory of this run's (ORBIT_FILES_DIR);
 *   s3     a real S3-compatible server — VersityGW, the image pinned in test-support/s3-test-server.ts — started on Docker the way
 *          scripts/run-pg-spec.sh starts its PostgreSQL, with a bucket of the run's (ORBIT_FILES_BACKEND=s3). It checks
 *          every request's signature and every PUT's payload hash, as AWS S3 does.
 *
 * The same cases with each store:
 *   (1) the same bytes uploaded through both doors (POST /attachments, POST /runner/sessions/:id/attachments) are
 *       kept once: one file_blob row, one object in the store, and an attachment row per upload that names it and
 *       keeps no bytes in Postgres;
 *   (2) every read door — GET /attachments/:id, GET /runner/sessions/:id/attachments/:attId, and GET
 *       /shared/:token/attachments/:id on a session link and on a task link — answers those bytes, byte for byte;
 *   (3) a row from before Orbit Files, its bytes in `data`, is answered from there through the same doors;
 *   (4) an upload goes through a temporary file on disk, never a buffer: halfway through the request its bytes are
 *       already in a file under <files dir>/tmp, and once it is answered that file is gone into the store;
 *   (5) a single file is still capped at 25 MiB: exactly that much is kept, one byte more is refused 413, and a
 *       refused upload — too large, or another runner's session — leaves nothing behind, on disk or in the database;
 *   (6) a dispatch copies a task's inputs as rows naming the same bytes (tasks.service.ts#copyTaskAttachments): no
 *       bytes copied and no file_blob row added; an input from before Orbit Files has its bytes kept the first time
 *       it is copied, and is copied the same way from then on;
 *   (7) a client that hangs up in the middle of an upload leaves nothing behind;
 *   (8) nor does an upload refused before its handler is entered — a malformed id, which PublicIdPipe turns down after
 *       multer has written the whole file: it is answered 400 on every upload door, with no file and no row, while the
 *       same upload with a well-formed id is kept;
 *   (9) evidence citing an image reads its size off the head of whichever store holds it, leaving the rest unread.
 *
 * Not destructive: every row belongs to users this run creates, and each store gets bytes of its own.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { MAX_UPLOAD_BYTES } from '../attachments/attachments.media';
import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { TasksService } from '../tasks/tasks.service';
import { startS3 } from '../test-support/s3-test-server';
import { LocalFileStore, type FilesConfig } from './file-store';
import { FilesService } from './files.service';
import { IMAGE_HEADER_BYTES } from './image-size';
import { S3FileStore } from './s3-file-store';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `orbit-files-${RUN}`;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const b62 = (id: string) => uuidToBase62(id);

// ── The sources the upload doors are, cited ───────────────────────────────────────────────────
// `../..` is the package root from either src/ or build/, as task-attachments.pg.spec.ts reads its sources.
const source = (rel: string) => readFileSync(path.resolve(__dirname, '../..', 'src', rel), 'utf8');

test('every upload door streams to disk through FILE_UPLOAD_STORAGE, under the 25 MiB cap, and keeps no buffer', () => {
  for (const [rel, doors] of [['attachments/attachments.controller.ts', 1], ['runner-api/runner-api.controller.ts', 2]] as const) {
    const code = source(rel);
    assert.equal(code.split('FileInterceptor(').length - 1, doors, `${rel}: the upload doors counted`);
    assert.equal(
      code.split("FileInterceptor('file', { storage: FILE_UPLOAD_STORAGE, limits: { fileSize: MAX_UPLOAD_BYTES } })").length - 1,
      doors,
      `${rel}: every upload door's multer storage is the disk engine; without \`storage\`, multer holds the file in memory`,
    );
    assert.equal(
      code.match(/@UseInterceptors\(\s*FileUploadCleanupInterceptor,\s*FileInterceptor\('file'/g)?.length,
      doors,
      `${rel}: on every door the cleanup is declared before multer, so that the pipes and the handler end inside it`,
    );
    assert.doesNotMatch(code, /toBytes\(|\.buffer\)/, `${rel}: no upload's bytes are read out of a buffer`);
  }
  // The engine itself: each part piped to a file opened under the files directory's tmp/, hashed on the way.
  assert.match(source('files/file-upload-storage.ts'), /writeHashedTempFile\(file\.stream, tempDir\(\)/);
  assert.match(source('files/file-store.ts'), /await pipeline\(source, hashing, closedWhenDropped\(createWriteStream\(tempPath, \{ fd, flush: true \}\), fd\)\)/);
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
});

// ── HTTP, binary-safe ──────────────────────────────────────────────────────────────────────────
interface Answer {
  status: number;
  body: Buffer;
  headers: http.IncomingHttpHeaders;
}

function answerOf(req: http.ClientRequest): Promise<Answer> {
  return new Promise((resolve, reject) => {
    req.on('response', (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

function open(server: Apiserver, method: string, route: string, headers: Record<string, string | number>): http.ClientRequest {
  const req = http.request({ host: '127.0.0.1', port: server.port, path: route, method, agent: false, headers });
  req.setTimeout(120_000, () => req.destroy(new Error(`${method} ${route} timed out`)));
  return req;
}

async function get(server: Apiserver, route: string, bearer?: string): Promise<Answer> {
  const req = open(server, 'GET', route, bearer ? { authorization: `Bearer ${bearer}` } : {});
  const answer = answerOf(req);
  req.end();
  return answer;
}

/** A multipart/form-data body with the one `file` field the upload doors read. */
function multipart(bytes: Buffer, fileName: string, type: string) {
  const boundary = `orbit-files-${randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { contentType: `multipart/form-data; boundary=${boundary}`, head, tail, length: head.length + bytes.length + tail.length };
}

async function upload(server: Apiserver, route: string, bearer: string, bytes: Buffer, fileName = 'shot.png', type = 'image/png'): Promise<Answer> {
  const body = multipart(bytes, fileName, type);
  const req = open(server, 'POST', route, {
    authorization: `Bearer ${bearer}`, 'content-type': body.contentType, 'content-length': body.length,
  });
  const answer = answerOf(req);
  req.end(Buffer.concat([body.head, bytes, body.tail]));
  return answer;
}

const idOf = (answer: Answer, what: string): string => {
  assert.equal(answer.status, 201, `${what} answered ${answer.status}: ${answer.body.toString('utf8').slice(0, 500)}`);
  return toUuid(JSON.parse(answer.body.toString('utf8')).id);
};

// ── One store, the same cases ──────────────────────────────────────────────────────────────────
interface Leg {
  storage: 'local' | 's3';
  dir: string;
  config: FilesConfig;
  env: Record<string, string>;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(20)) {
    if (condition()) return;
  }
  assert.fail(`${what}: not within 30 s`);
}

async function readAll(stream: NodeJS.ReadableStream | null): Promise<Buffer | null> {
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function storeCases(leg: Leg) {
  return async (t: import('node:test').TestContext) => {
    const url = URL!;
    const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    const db: PrismaClient = prismaClientFor(url);
    let server: Apiserver | undefined;
    t.after(async () => {
      await server?.stop();
      await db.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    });
    const jwtSecret = `orbit-files-${randomUUID()}`;
    const jwt = new JwtService({ secret: jwtSecret });
    server = await startApiserver(url, jwtSecret, {
      PROVIDER_SECRET_KEY,
      // No reaching models.dev from a spec: the catalogue keeps the lists this build shipped.
      MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
      ...leg.env,
    });
    const tempDir = path.join(leg.dir, 'tmp');
    const store = leg.config.s3 ? new S3FileStore(leg.config.s3) : new LocalFileStore(leg.dir);
    const stored = async (sha: string) => readAll(await store.open(sha));
    const tempFiles = () => {
      try {
        return readdirSync(tempDir);
      } catch {
        return [];
      }
    };

    // An owner with a runner, a session on it, a task and a link to each; and a second runner, not the session's.
    const ownerId = randomUUID();
    const email = `files-${leg.storage}-${RUN}@orbit-files.invalid`;
    await db.user.create({ data: { id: ownerId, email, name: `files ${leg.storage}`, passwordHash: 'x' } });
    const bearer = await jwt.signAsync({ sub: ownerId, email });
    const runner = async (name: string) => {
      const id = randomUUID();
      const token = `${id}-${RUN}`;
      await db.runner.create({
        data: { id, ownerId, name, tokenHash: createHash('sha256').update(token).digest('hex') },
      });
      return { id, token };
    };
    const machine = await runner(`files-${leg.storage}-runner`);
    const otherMachine = await runner(`files-${leg.storage}-other-runner`);
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: machine.id, name: `files-${leg.storage}`, enabled: true } });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, title: 'files', prompt: 'files', ownerId, creatorId: ownerId, workspaceId,
        assignedRunnerId: machine.id, status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${sessionId}`,
      },
    });
    const taskId = randomUUID();
    await db.task.create({
      data: { id: taskId, title: 'implement the mock', ownerId, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT' },
    });
    const sessionLink = randomBytes(24).toString('base64url');
    const taskLink = randomBytes(24).toString('base64url');
    await db.shareLink.create({ data: { ownerId, token: sessionLink, sessionId } });
    await db.shareLink.create({ data: { ownerId, token: taskLink, taskId, include: { commentsAndFiles: true } } });

    const userDoor = `/api/attachments?sessionId=${b62(sessionId)}`;
    const taskDoor = `/api/attachments?taskId=${b62(taskId)}`;
    const runnerDoor = `/api/runner/sessions/${b62(sessionId)}/attachments`;
    const fileDoor = `/api/runner/sessions/${b62(sessionId)}/files`;

    // Every byte value, then a megabyte of noise: what a text-only round trip would mangle.
    const bytes = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(1024 * 1024)]);
    const sha = sha256(bytes);
    const ids: Record<'user' | 'task' | 'runner', string> = { user: '', task: '', runner: '' };

    await t.test(`${leg.storage}: the same bytes uploaded through both doors are kept once — one file_blob row, one object, a row per upload`, async () => {
      ids.user = idOf(await upload(server!, userDoor, bearer, bytes), 'POST /attachments?sessionId');
      ids.task = idOf(await upload(server!, taskDoor, bearer, bytes, 'mock.png'), 'POST /attachments?taskId');
      ids.runner = idOf(await upload(server!, runnerDoor, machine.token, bytes, 'reply.png'), 'POST /runner/sessions/:id/attachments');

      const blobs = await db.fileBlob.findMany({ where: { sha256: sha }, select: { sizeBytes: true, storage: true } });
      assert.deepEqual(blobs, [{ sizeBytes: bytes.length, storage: leg.storage }], 'one file_blob row for one content');
      const rows = await sql.query<{ id: string; sha256: string | null; in_postgres: boolean; size_bytes: number }>(
        `SELECT id::text, sha256, data IS NOT NULL AS in_postgres, size_bytes FROM attachment WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
        [[ids.user, ids.task, ids.runner]],
      );
      assert.deepEqual(
        rows.rows.map((row) => ({ sha256: row.sha256, inPostgres: row.in_postgres, sizeBytes: row.size_bytes })),
        Array(3).fill({ sha256: sha, inPostgres: false, sizeBytes: bytes.length }),
        'three attachment rows, each naming the bytes and keeping none of them',
      );
      assert.ok((await stored(sha))?.equals(bytes), `the ${leg.storage} store holds the bytes under their sha256`);
      if (leg.storage === 'local') {
        assert.deepEqual(readdirSync(path.join(leg.dir, sha.slice(0, 2))), [sha], 'one file, at <sha256[0:2]>/<sha256>');
      }
      assert.deepEqual(tempFiles(), [], 'nothing is left in the temporary directory');
    });

    await t.test(`${leg.storage}: every read door answers the stored bytes, byte for byte`, async () => {
      const reads: Array<[string, string, string | undefined]> = [
        ['GET /attachments/:id', `/api/attachments/${b62(ids.user)}`, bearer],
        ['GET /attachments/:id (a task input)', `/api/attachments/${b62(ids.task)}`, bearer],
        ['GET /runner/sessions/:id/attachments/:attId', `${runnerDoor}/${b62(ids.runner)}`, machine.token],
        ['GET /shared/:token/attachments/:id (a session link)', `/api/shared/${sessionLink}/attachments/${b62(ids.user)}`, undefined],
        ['GET /shared/:token/attachments/:id (a task link)', `/api/shared/${taskLink}/attachments/${b62(ids.task)}`, undefined],
      ];
      for (const [door, route, who] of reads) {
        const answer = await get(server!, route, who);
        assert.equal(answer.status, 200, `${door} answered ${answer.status}: ${answer.body.toString('utf8').slice(0, 300)}`);
        assert.ok(answer.body.equals(bytes), `${door} answers the bytes that were uploaded`);
        assert.equal(answer.headers['content-type'], 'image/png', door);
        assert.equal(answer.headers['content-length'], String(bytes.length), door);
      }
    });

    const old = randomBytes(300_000);
    const oldSha = sha256(old);
    const legacy: Record<'session' | 'task', string> = { session: '', task: '' };

    await t.test(`${leg.storage}: a row from before Orbit Files is answered from its own bytes, through the same doors`, async () => {
      legacy.session = (await db.attachment.create({
        data: { ownerId, sessionId, mimeType: 'image/png', sizeBytes: old.length, fileName: 'old.png', data: old },
      })).id;
      legacy.task = (await db.attachment.create({
        data: { ownerId, taskId, mimeType: 'image/png', sizeBytes: old.length, fileName: 'old-mock.png', data: old },
      })).id;
      for (const [door, route, who] of [
        ['GET /attachments/:id', `/api/attachments/${b62(legacy.session)}`, bearer],
        ['GET /runner/sessions/:id/attachments/:attId', `${runnerDoor}/${b62(legacy.session)}`, machine.token],
        ['GET /shared/:token/attachments/:id (a session link)', `/api/shared/${sessionLink}/attachments/${b62(legacy.session)}`, undefined],
        ['GET /shared/:token/attachments/:id (a task link)', `/api/shared/${taskLink}/attachments/${b62(legacy.task)}`, undefined],
      ] as const) {
        const answer = await get(server!, route, who);
        assert.equal(answer.status, 200, `${door} answered ${answer.status}: ${answer.body.toString('utf8').slice(0, 300)}`);
        assert.ok(answer.body.equals(old), `${door} answers the row's own bytes`);
        assert.equal(answer.headers['content-length'], String(old.length), door);
      }
      assert.equal(await db.fileBlob.count({ where: { sha256: oldSha } }), 0, 'reading an old row stores nothing');
    });

    await t.test(`${leg.storage}: an upload goes through a temporary file on disk — half a request in, its bytes are already there`, async () => {
      const big = randomBytes(8 * 1024 * 1024);
      const body = multipart(big, 'trace.zip', 'application/zip');
      const req = open(server!, 'POST', userDoor, {
        authorization: `Bearer ${bearer}`, 'content-type': body.contentType, 'content-length': body.length,
      });
      let answered = false;
      const answer = answerOf(req).finally(() => {
        answered = true;
      });
      const half = big.length / 2;
      req.write(body.head);
      req.write(big.subarray(0, half));
      // The request is still open: nothing past the first half has been sent. Its bytes are being written to a
      // file under <files dir>/tmp as they arrive, not gathered in memory.
      let temp: string | undefined;
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(20)) {
        const [name, ...more] = tempFiles();
        assert.equal(more.length, 0, 'one upload, one temporary file');
        if (name && statSync(path.join(tempDir, name)).size >= 1024 * 1024) {
          temp = path.join(tempDir, name);
          break;
        }
      }
      assert.ok(temp, 'half the upload was sent and no temporary file under <files dir>/tmp held it');
      assert.equal(answered, false, 'the request has not been answered: the rest of it has not been sent');
      const onDisk = readFileSync(temp);
      assert.ok(onDisk.length <= half && onDisk.equals(big.subarray(0, onDisk.length)), 'the temporary file holds the upload as sent so far');
      req.end(Buffer.concat([big.subarray(half), body.tail]));
      const id = idOf(await answer, 'the upload sent in two halves');
      assert.deepEqual(tempFiles(), [], 'answered, the temporary file is gone into the store');
      assert.ok((await stored(sha256(big)))?.equals(big), 'the store holds the whole upload');
      const row = await db.attachment.findUniqueOrThrow({ where: { id }, select: { sha256: true, sizeBytes: true } });
      assert.deepEqual(row, { sha256: sha256(big), sizeBytes: big.length });
    });

    await t.test(`${leg.storage}: a file is capped at 25 MiB, and a refused upload leaves nothing behind`, async () => {
      const atCap = randomBytes(MAX_UPLOAD_BYTES);
      const kept = idOf(await upload(server!, userDoor, bearer, atCap, 'cap.bin', 'application/octet-stream'), 'an upload of exactly 25 MiB');
      assert.deepEqual(
        await db.fileBlob.findUnique({ where: { sha256: sha256(atCap) }, select: { sizeBytes: true, storage: true } }),
        { sizeBytes: MAX_UPLOAD_BYTES, storage: leg.storage },
      );
      assert.ok((await stored(sha256(atCap)))?.equals(atCap));
      assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: kept } })).sizeBytes, MAX_UPLOAD_BYTES);

      const blobsBefore = await db.fileBlob.count();
      const attachmentsBefore = await db.attachment.count({ where: { ownerId } });
      const over = Buffer.concat([atCap, Buffer.from([0x2a])]);
      const tooLarge = await upload(server!, userDoor, bearer, over, 'over.bin', 'application/octet-stream');
      assert.equal(tooLarge.status, 413, `one byte over the cap: ${tooLarge.body.toString('utf8').slice(0, 300)}`);
      const notTheirs = await upload(server!, runnerDoor, otherMachine.token, bytes, 'reply.png');
      assert.equal(notTheirs.status, 403, 'a runner the session is not assigned to');
      const noSession = await upload(server!, `/api/attachments?sessionId=${b62(randomUUID())}`, bearer, bytes);
      assert.equal(noSession.status, 404, 'a session that is not the caller\'s');
      assert.deepEqual(tempFiles(), [], 'every refused upload\'s temporary file is removed');
      assert.equal(await db.fileBlob.count(), blobsBefore, 'no file_blob row');
      assert.equal(await db.fileBlob.count({ where: { sha256: sha256(over) } }), 0);
      assert.equal(await db.attachment.count({ where: { ownerId } }), attachmentsBefore, 'no attachment row');
      assert.equal(await stored(sha256(over)), null, 'and nothing in the store');
    });

    await t.test(`${leg.storage}: a dispatch copies a task's inputs as rows naming the same bytes, never the bytes`, async () => {
      // The dispatch's own copy (tasks.service.ts#copyTaskAttachments, which both dispatch paths call — pinned in
      // attachments/task-attachments.pg.spec.ts), over the store this server keeps files in.
      const files = new FilesService(db as unknown as PrismaService, leg.config);
      const tasks = new TasksService(
        db as unknown as PrismaService, {} as never, {} as never,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, files,
      );
      const copyInputs = (sessionScope: string | null) =>
        (tasks as unknown as { copyTaskAttachments(task: string, session: string | null): Promise<string[]> })
          .copyTaskAttachments(taskId, sessionScope);
      const blob = (name: string) => db.fileBlob.findUnique({ where: { sha256: name } });
      const shaBlob = await blob(sha);

      const first = await copyInputs(null);
      const copies = await sql.query<{ id: string; sha256: string | null; in_postgres: boolean; task_id: string | null }>(
        `SELECT id::text, sha256, data IS NOT NULL AS in_postgres, task_id::text FROM attachment WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
        [first],
      );
      assert.deepEqual(
        copies.rows.map((row) => ({ sha256: row.sha256, inPostgres: row.in_postgres, taskId: row.task_id })),
        [
          { sha256: sha, inPostgres: false, taskId: null },
          { sha256: oldSha, inPostgres: false, taskId: null },
        ],
        'one copy per input, in order, each a row that names the bytes and carries none',
      );
      assert.deepEqual(await blob(sha), shaBlob, 'copying a stored input writes nothing about its bytes');
      // The input from before Orbit Files: its bytes kept once, the first time it was copied, and named on the row.
      assert.deepEqual(
        await db.attachment.findUniqueOrThrow({ where: { id: legacy.task }, select: { sha256: true } }),
        { sha256: oldSha },
      );
      const oldBlob = await blob(oldSha);
      assert.equal(oldBlob?.storage, leg.storage);
      assert.ok((await stored(oldSha))?.equals(old));

      // The next dispatch, into a session: the same rows again, and nothing stored again.
      const second = await copyInputs(sessionId);
      const again = await db.attachment.findMany({ where: { id: { in: second } }, select: { sha256: true, sessionId: true } });
      assert.deepEqual(new Set(again.map((row) => row.sha256)), new Set([sha, oldSha]));
      assert.ok(again.every((row) => row.sessionId === sessionId));
      assert.deepEqual(await blob(oldSha), oldBlob, 'a copied input is not stored twice');
      assert.equal(await db.attachment.count({ where: { taskId } }), 2, 'the task keeps its two inputs');

      // And a run is handed the bytes through the copy, as through the input.
      const answer = await get(server!, `/api/attachments/${b62(first[1])}`, bearer);
      assert.equal(answer.status, 200);
      assert.ok(answer.body.equals(old));
    });

    await t.test(`${leg.storage}: a client that hangs up in the middle of an upload leaves nothing behind`, async () => {
      const dropped = randomBytes(2 * 1024 * 1024);
      const blobsBefore = await db.fileBlob.count();
      const attachmentsBefore = await db.attachment.count({ where: { ownerId } });
      for (const [door, route, who] of [
        ['POST /attachments', userDoor, bearer],
        ['POST /runner/sessions/:id/attachments', runnerDoor, machine.token],
      ] as const) {
        const body = multipart(dropped, 'dropped.bin', 'application/octet-stream');
        const req = open(server!, 'POST', route, {
          authorization: `Bearer ${who}`, 'content-type': body.contentType, 'content-length': body.length,
        });
        req.on('error', () => undefined); // The hang-up below.
        req.write(body.head);
        req.write(dropped.subarray(0, dropped.length / 2));
        await until(() => tempFiles().length === 1, `${door}: half an upload was sent and no temporary file holds it`);
        req.destroy();
        await until(() => tempFiles().length === 0, `${door}: the client left and its temporary file is still there`);
      }
      assert.equal(await db.fileBlob.count(), blobsBefore, 'no file_blob row');
      assert.equal(await db.attachment.count({ where: { ownerId } }), attachmentsBefore, 'no attachment row');
      assert.equal(await stored(sha256(dropped)), null, 'and nothing in the store');
    });

    const refused = randomBytes(1024 * 1024);

    for (const [door, route, who] of [
      ['POST /attachments with a malformed sessionId', '/api/attachments?sessionId=not-a-public-id!', bearer],
      ['POST /attachments with a malformed taskId', '/api/attachments?taskId=not-a-public-id!', bearer],
      ['POST /runner/sessions/:id/attachments with a malformed :id', '/api/runner/sessions/not-a-public-id!/attachments', machine.token],
      ['POST /runner/sessions/:id/files with a malformed :id', '/api/runner/sessions/not-a-public-id!/files', machine.token],
    ] as const) {
      await t.test(`${leg.storage}: ${door} is refused before its handler, and leaves nothing behind`, async () => {
        const blobsBefore = await db.fileBlob.count();
        const attachmentsBefore = await db.attachment.count({ where: { ownerId } });
        const answer = await upload(server!, route, who, refused);
        const left = tempFiles();
        // So that a file this door leaves is not read as the next door's.
        for (const name of left) rmSync(path.join(tempDir, name));
        assert.equal(answer.status, 400, `answered ${answer.status}: ${answer.body.toString('utf8').slice(0, 300)}`);
        assert.deepEqual(left, [], 'by the time it is answered, the refused upload\'s temporary file is gone');
        assert.equal(await db.fileBlob.count(), blobsBefore, 'no file_blob row');
        assert.equal(await db.attachment.count({ where: { ownerId } }), attachmentsBefore, 'no attachment row');
        assert.equal(await stored(sha256(refused)), null, 'and nothing in the store');
      });
    }

    await t.test(`${leg.storage}: the same upload with well-formed ids is kept, and leaves the temporary directory empty`, async () => {
      for (const [door, route, who] of [
        ['POST /attachments?sessionId', userDoor, bearer],
        ['POST /attachments?taskId', taskDoor, bearer],
        ['POST /runner/sessions/:id/attachments', runnerDoor, machine.token],
        ['POST /runner/sessions/:id/files', fileDoor, machine.token],
      ] as const) {
        idOf(await upload(server!, route, who, refused), door);
        assert.deepEqual(tempFiles(), [], `${door}: nothing is left in the temporary directory`);
      }
      assert.ok((await stored(sha256(refused)))?.equals(refused), 'the store holds the bytes');
    });

    await t.test(`${leg.storage}: evidence citing an image reads its size off the head of the store's bytes`, async () => {
      const standard = 'the image shows it';
      const citingTask = randomUUID();
      await db.task.create({
        data: {
          id: citingTask, title: 'cite an image', ownerId, creatorType: 'USER', creatorId: ownerId, status: 'IN_PROGRESS',
          completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: standard,
        },
      });
      const run = randomUUID();
      await db.session.create({
        data: {
          id: run, title: 'a run', prompt: 'a run', ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: machine.id, taskId: citingTask,
          startsTaskWork: true, status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${run}`,
        },
      });
      const head = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
      head.writeUInt32BE(13, 8);
      head.write('IHDR', 12, 'latin1');
      head.writeUInt32BE(1280, 16);
      head.writeUInt32BE(800, 20);
      // Past what is read of it, so that the stream is left part way, which a bucket's connection has to survive.
      const image = Buffer.concat([head, randomBytes(2 * IMAGE_HEADER_BYTES)]);
      const file = idOf(await upload(server!, `/api/runner/sessions/${b62(run)}/files`, machine.token, image, 'large.png'), 'the upload');
      const answer = await fetch(`http://127.0.0.1:${server!.port}/api/runner/tasks/${b62(citingTask)}/evidence`, {
        method: 'POST',
        headers: { authorization: `Bearer ${machine.token}`, 'content-type': 'application/json', 'x-orbit-session-id': run },
        body: JSON.stringify({
          evidence: { claim: 'it does', criterion: { key: b62(citingTask), text: standard }, checks: [{ kind: 'FILE', ref: file }], gaps: [] },
        }),
      });
      const receipt = await answer.json() as { evidence: { checks: unknown[] } };
      assert.equal(answer.status, 201, JSON.stringify(receipt));
      assert.deepEqual(receipt.evidence.checks, [{ kind: 'FILE', ref: b62(toUuid(file)), sha256: sha256(image), width: 1280, height: 800 }]);
      assert.ok((await stored(sha256(image)))?.equals(image), 'and the store answers the whole of it after that');
    });
  };
}

test('Orbit Files storage, on the local files directory and on an S3-compatible server', {
  skip: !URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  try {
    await verifyCoordinatorPgIdentity(sql);
  } finally {
    await sql.end();
  }
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;

  const localDir = mkdtempSync(path.join(tmpdir(), 'orbit-files-local-'));
  const s3Dir = mkdtempSync(path.join(tmpdir(), 'orbit-files-s3-'));
  t.after(() => {
    rmSync(localDir, { recursive: true, force: true });
    rmSync(s3Dir, { recursive: true, force: true });
  });

  await t.test('local', storeCases({
    storage: 'local',
    dir: localDir,
    config: { dir: localDir, storage: 'local' },
    env: { ORBIT_FILES_BACKEND: 'local', ORBIT_FILES_DIR: localDir },
  }));

  const s3 = await startS3((fn) => t.after(fn));
  await t.test('s3', storeCases({
    storage: 's3',
    dir: s3Dir,
    config: { dir: s3Dir, storage: 's3', s3 },
    env: {
      ORBIT_FILES_BACKEND: 's3',
      ORBIT_FILES_DIR: s3Dir,
      ORBIT_FILES_S3_ENDPOINT: s3.endpoint,
      ORBIT_FILES_S3_BUCKET: s3.bucket,
      ORBIT_FILES_S3_ACCESS_KEY_ID: s3.accessKeyId,
      ORBIT_FILES_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      ORBIT_FILES_S3_REGION: s3.region,
    },
  }));
});
