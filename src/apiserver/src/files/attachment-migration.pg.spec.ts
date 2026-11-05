/**
 * Moving old attachments out of Postgres in two steps (attachment-migration.ts; docs/orbit-files-design.md §2.1), held
 * against the production apiserver — `build/main.js`, the whole AppModule, which runs the copy after a start — and the
 * real command that clears, as separate processes, over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty, once with each store:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/attachment-migration.pg.spec.ts
 *
 *   local  the files directory, a directory of this run's (ORBIT_FILES_DIR);
 *   s3     a real S3-compatible server (test-support/s3-test-server.ts) with a bucket of the run's.
 *
 * What is held, with each store, on a batch of rows written as an apiserver before Orbit Files wrote them:
 *   (1) what every read door answers before anything moves is the baseline: GET /attachments/:id,
 *       GET /runner/sessions/:id/attachments/:attId, GET /shared/:token/attachments/:id on a session link and a task link;
 *   (2) a start does not wait for the copy: with the copy stalled on a row, the server answers, and it answers every door
 *       as before with rows in all three states (copied, in the store but not yet named, waiting), and takes uploads;
 *   (3) killed partway (SIGKILL, with the bytes of one row stored and the row not yet naming them), the next start carries
 *       on from the rows and redoes none of them, with reads and uploads going on while it does, and logs its counts;
 *   (4) the copy alone leaves `data` as it was and writes `sha256`, one file_blob row per content, the store holding
 *       the same bytes, so a client of the schema before Orbit Files (a generated Prisma client) still reads every row;
 *   (5) a start after the copy writes nothing;
 *   (6) the clear, killed partway and run again under reads and uploads, reads each row's bytes back from the store first,
 *       and leaves and reports a row whose bytes the store lacks, a row whose bytes under that name are others, a row whose
 *       blob names a store it cannot read, and a row whose `data` is not those bytes; put right, they clear too;
 *   (7) after it `data` is NULL on every row, every door answers as before, and that older client reads none of them;
 *   (8) running it again, and starting again, write nothing;
 *   (9) a batch stops at its limit of rows or of bytes, a row over the limit is a batch of its own, a stopped copy
 *       is carried on by the next one, and two processes copying at once agree: the batches as they fall, on a real store;
 *  (10) a store that fails stops nothing but the row at hand, a row that fails is tried again, and a row deleted under the
 *       copy is no failure; on a disk short of room the copy waits, and it never waits for a bucket, and the clear stops;
 *  (11) a read between `FilesService.open`'s two statements, as the row is copied and cleared, finds the bytes in the store;
 *  (12) a copied row whose store fails is read from `data` for as long as it has any, and the log says which row, which
 *       store and what failed;
 *  (13) so too for one whose store has lost its bytes, through a door of the real server, at most once a minute;
 *  (14) a process killed while writing a temporary file (stopped from outside partway, then SIGKILL) leaves that file; a
 *       start the same day leaves it too, and a start a day later (its time moved back by hand), with no row waiting for
 *       the copy, removes it, and leaves the stored bytes, a fresher file and a link;
 *  (15) a start whose temporary directory cannot be read says so, and answers.
 *
 * Not destructive: every row belongs to users this run creates, and each store gets bytes of its own.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { test } from 'node:test';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';

import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { pgAdapterFor, prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { startS3 } from '../test-support/s3-test-server';
import { AttachmentMigration, MIGRATION_LIMITS, type MigrationLimits } from './attachment-migration';
import { LocalFileStore, type FilesConfig, type S3FilesConfig } from './file-store';
import { FilesService } from './files.service';
import { S3FileStore, sigV4Authorization } from './s3-file-store';

const PG_URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CLI = path.resolve(__dirname, 'attachment-migration.cli.js');

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const b62 = (id: string) => uuidToBase62(id);

async function until(condition: () => Promise<boolean>, what: string, withinMs = 90_000): Promise<void> {
  for (const deadline = Date.now() + withinMs; Date.now() < deadline; await sleep(25)) {
    if (await condition()) return;
  }
  assert.fail(`${what}: not within ${withinMs / 1000} s`);
}

// ── HTTP, binary-safe ──────────────────────────────────────────────────────────────────────────
interface Answer {
  status: number;
  body: Buffer;
  headers: http.IncomingHttpHeaders;
}

let visitors = 0;

/** A door's answer, to a visitor of its own: a share link allows one address 120 requests a minute, and this reads far more. */
function get(server: Apiserver, route: string, bearer?: string): Promise<Answer> {
  visitors += 1;
  const headers = { 'x-real-ip': `10.${visitors >> 16 & 255}.${visitors >> 8 & 255}.${visitors & 255}`, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path: route, agent: false, headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), headers: res.headers }));
        res.on('error', reject);
      },
    );
    req.setTimeout(60_000, () => req.destroy(new Error(`GET ${route} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function upload(server: Apiserver, route: string, bearer: string, bytes: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'new.png');
  const answer = await fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: form });
  const text = await answer.text();
  assert.equal(answer.status, 201, `an upload answered ${answer.status}: ${text.slice(0, 300)}`);
  return toUuid(JSON.parse(text).id);
}

async function readAll(stream: Readable | null): Promise<Buffer | null> {
  if (!stream) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// ── The client of the last schema before Orbit Files ───────────────────────────────────────────
/**
 * `model Attachment` as it stood before migration 0462 (schema.prisma at 1ab75589f^), less its relations: `data` is
 * required, and `sha256` and the columns beside it do not exist.
 */
const PRE_ORBIT_FILES_SCHEMA = (output: string) => `
generator client {
  provider = "prisma-client-js"
  output   = ${JSON.stringify(output)}
}

datasource db {
  provider = "postgresql"
}

model Attachment {
  id        String   @id @default(uuid(7)) @db.Uuid
  ownerId   String   @map("owner_id") @db.Uuid
  sessionId String?  @map("session_id") @db.Uuid
  turnId    String?  @map("turn_id") @db.Uuid
  taskId    String?  @map("task_id") @db.Uuid
  mimeType  String   @map("mime_type")
  sizeBytes Int      @map("size_bytes")
  fileName  String?  @map("file_name")
  data      Bytes
  createdAt DateTime @default(now()) @map("created_at")

  @@map("attachment")
}
`;

type PreOrbitFilesClient = {
  attachment: { findFirst(args: unknown): Promise<{ data: Uint8Array; mimeType: string } | null> };
  $disconnect(): Promise<void>;
};

/** A client generated from that schema, under build/ so that it finds @prisma/client: the older apiserver's reads, for real. */
function preOrbitFilesClient(url: string): PreOrbitFilesClient {
  const dir = path.join(__dirname, 'pre-orbit-files-client');
  mkdirSync(dir, { recursive: true });
  const schema = path.join(dir, 'schema.prisma');
  writeFileSync(schema, PRE_ORBIT_FILES_SCHEMA(dir));
  execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'generate', `--schema=${schema}`], { cwd: dir, stdio: 'pipe' });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: Generated } = require(dir) as { PrismaClient: new (options: unknown) => PreOrbitFilesClient };
  return new Generated({ adapter: pgAdapterFor(url) });
}

/** The read every door of that version made: AttachmentsService.getForOwner, at 1ab75589f^. */
async function readAsBeforeOrbitFiles(client: PreOrbitFilesClient, ownerId: string, id: string): Promise<Buffer> {
  const row = await client.attachment.findFirst({ where: { id, ownerId }, select: { data: true, mimeType: true } });
  assert.ok(row, 'the row is found');
  return Buffer.from(row.data);
}

// ── One store, the same cases ──────────────────────────────────────────────────────────────────
interface Leg {
  storage: 'local' | 's3';
  dir: string;
  config: FilesConfig;
  env: Record<string, string>;
  /** Behind the store's back: its bytes under `sha`, or none. */
  put(sha: string, bytes: Buffer): Promise<void>;
  drop(sha: string): Promise<void>;
}

/** One object of the bucket, written as any client could, signing what it sends: the store refuses bytes that are not its name's. */
function s3Object(config: S3FilesConfig, method: 'PUT' | 'DELETE', key: string, body: Buffer = Buffer.alloc(0)): Promise<void> {
  const endpoint = new globalThis.URL(config.endpoint);
  const requestPath = `/${config.bucket}/${key}`;
  const payloadSha256 = sha256(body);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const headers = { host: endpoint.host, 'x-amz-content-sha256': payloadSha256, 'x-amz-date': amzDate, 'content-length': String(body.length) };
  const authorization = sigV4Authorization(
    { method, path: requestPath, headers, payloadSha256 },
    { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: config.region, service: 's3' },
    amzDate,
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: endpoint.hostname, port: endpoint.port, method, path: requestPath, headers: { ...headers, authorization } },
      (res) => {
        res.resume();
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 300) reject(new Error(`S3 ${method} ${key} answered ${res.statusCode}`));
          else resolve();
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** An old row: its id, and the bytes every door has to go on answering. */
interface OldRow {
  id: string;
  bytes: Buffer<ArrayBuffer>;
  sha: string;
  /** `size_bytes`, which an old row may have wrong: nothing read it to serve the bytes. */
  sizeBytes: number;
  doors: { door: string; route: string; who: string | undefined; before?: Answer }[];
}

const quiet = { log: () => undefined, warn: () => undefined };

function storeCases(leg: Leg) {
  return async (t: import('node:test').TestContext) => {
    const url = PG_URL!;
    const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    const db: PrismaClient = prismaClientFor(url);
    const older = preOrbitFilesClient(url);
    let server: Apiserver | undefined;
    const booted: Apiserver[] = [];
    t.after(async () => {
      await Promise.all(booted.map((one) => one.stop()));
      await db.$disconnect().catch(() => undefined);
      await older.$disconnect().catch(() => undefined);
      await sql.end().catch(() => undefined);
    });
    const jwtSecret = `attachment-migration-${randomUUID()}`;
    const jwt = new JwtService({ secret: jwtSecret });
    const boot = async () => {
      const started = await startApiserver(url, jwtSecret, {
        PROVIDER_SECRET_KEY: `attachment-migration-${RUN}`,
        // No reaching models.dev from a spec: the catalogue keeps the lists this build shipped.
        MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
        ...leg.env,
      });
      booted.push(started);
      return started;
    };
    // Each step stands on the one before: after a failure the rest would only wait out their timeouts on the wrong rows.
    let failed = false;
    const step = (name: string, work: () => Promise<void>) => t.test(name, async (s) => {
      if (failed) {
        s.skip('an earlier step failed');
        return;
      }
      await work().catch((error: unknown) => {
        failed = true;
        throw error;
      });
    });
    const store = leg.config.s3 ? new S3FileStore(leg.config.s3) : new LocalFileStore(leg.dir);

    // The owner, a runner, a session on it, a task and a link to each.
    const ownerId = randomUUID();
    const email = `migration-${leg.storage}-${RUN}@orbit-files.invalid`;
    await db.user.create({ data: { id: ownerId, email, name: `migration ${leg.storage}`, passwordHash: 'x' } });
    const bearer = await jwt.signAsync({ sub: ownerId, email });
    const runnerId = randomUUID();
    const runnerToken = `${runnerId}-${RUN}`;
    await db.runner.create({
      data: { id: runnerId, ownerId, name: `migration-${leg.storage}`, tokenHash: createHash('sha256').update(runnerToken).digest('hex') },
    });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `migration-${leg.storage}`, enabled: true } });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, title: 'migration', prompt: 'migration', ownerId, creatorId: ownerId, workspaceId,
        assignedRunnerId: runnerId, status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${sessionId}`,
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

    // ── What a process does to the rows ────────────────────────────────────────────────────────
    const kill = async (victim: { child?: Apiserver['child'] } | ChildProcessByStdio<null, Readable, Readable>) => {
      const child = 'child' in victim ? victim.child! : (victim as ChildProcessByStdio<null, Readable, Readable>);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    };

    /** A side connection's lock on one row: whoever comes to write that row stops there until it is let go. */
    const hold = async (id: string): Promise<() => Promise<void>> => {
      const locker = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
      await locker.connect();
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM attachment WHERE id = $1::uuid FOR UPDATE', [id]);
      return async () => {
        await locker.query('ROLLBACK');
        await locker.end();
      };
    };

    /** The command as an operator runs it, with what the apiserver's container has in its environment. */
    const command = (...args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url, NO_COLOR: '1', ...leg.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      const ended = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
      return { child, ended, output: () => output };
    };
    const run = async (...args: string[]) => {
      const process = command(...args);
      const code = await process.ended;
      return { code, output: process.output() };
    };

    /** Every row's physical version: a row anything wrote to, even to the same values, has another. */
    const versions = async () => ({
      attachments: (await sql.query('SELECT id::text, ctid::text, xmin::text FROM attachment ORDER BY id')).rows,
      blobs: (await sql.query('SELECT sha256, ctid::text, xmin::text FROM file_blob ORDER BY sha256')).rows,
    });

    // ── The batch of old rows ──────────────────────────────────────────────────────────────────
    const shapes: { scope: 'session' | 'task'; bytes: Buffer<ArrayBuffer>; mimeType: string; fileName: string | null; sizeBytes?: number }[] = [];
    const image = (bytes: Buffer<ArrayBuffer>, scope: 'session' | 'task' = 'session') => shapes.push({ scope, bytes, mimeType: 'image/png', fileName: 'old.png' });
    // More rows than a batch, so the copy pauses between two of them.
    for (let i = 0; i < 125; i += 1) image(randomBytes(1024 + i * 300));
    // Every byte value, then a megabyte of noise: what a text-only round trip would mangle.
    image(Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(1024 * 1024)]));
    // One content on three rows, of a session and of a task: one blob, one object.
    const twin = randomBytes(300_000);
    image(twin);
    image(twin);
    image(twin, 'task');
    shapes.push({ scope: 'session', bytes: Buffer.alloc(0), mimeType: 'text/plain', fileName: 'empty.txt' });
    shapes.push({ scope: 'task', bytes: Buffer.from('# a spec\n'), mimeType: 'text/markdown', fileName: 'spec.md' });
    // A row whose `size_bytes` was wrong: a door answers with the bytes' own length, before and after.
    shapes.push({ scope: 'session', bytes: randomBytes(1000), mimeType: 'application/pdf', fileName: 'report.pdf', sizeBytes: 7 });

    const ids = shapes.map(() => randomUUID()).sort();
    const rows: OldRow[] = shapes.map((shape, i) => {
      const id = ids[i];
      const shared = shape.scope === 'session' ? sessionLink : taskLink;
      return {
        id,
        bytes: shape.bytes,
        sha: sha256(shape.bytes),
        sizeBytes: shape.sizeBytes ?? shape.bytes.length,
        doors: [
          { door: 'GET /attachments/:id', route: `/api/attachments/${b62(id)}`, who: bearer },
          { door: 'GET /shared/:token/attachments/:id', route: `/api/shared/${shared}/attachments/${b62(id)}`, who: undefined },
          ...(shape.scope === 'session'
            ? [{ door: 'GET /runner/sessions/:id/attachments/:attId', route: `/api/runner/sessions/${b62(sessionId)}/attachments/${b62(id)}`, who: runnerToken }]
            : []),
        ],
      };
    });
    const everyId = rows.map((row) => row.id);
    const contents = new Map(rows.map((row) => [row.sha, row.bytes]));

    const copiedCount = async () => (await sql.query(
      'SELECT count(*)::int AS n FROM attachment WHERE id = ANY($1::uuid[]) AND sha256 IS NOT NULL', [everyId],
    )).rows[0].n as number;
    const clearedCount = async () => (await sql.query(
      'SELECT count(*)::int AS n FROM attachment WHERE id = ANY($1::uuid[]) AND data IS NULL', [everyId],
    )).rows[0].n as number;

    const assertDoors = async (via: Apiserver, when: string, some: OldRow[] = rows) => {
      for (const row of some) {
        for (const door of row.doors) {
          const answer = await get(via, door.route, door.who);
          assert.equal(answer.status, 200, `${when}: ${door.door} answered ${answer.status}: ${answer.body.toString('utf8').slice(0, 300)}`);
          assert.ok(answer.body.equals(row.bytes), `${when}: ${door.door} answers the bytes of ${row.id}`);
          for (const header of ['content-type', 'content-length', 'content-disposition']) {
            assert.equal(answer.headers[header], door.before?.headers[header], `${when}: ${door.door}, ${header}, as before anything moved`);
          }
        }
      }
    };

    /**
     * `work`, with uploads and reads of every door going on around it until it ends, over `changing`, the rows it is about
     * to change, so that a read meets a row as it changes. Every one of them has to be right.
     */
    const underTraffic = async <T>(via: Apiserver, changing: OldRow[], work: () => Promise<T>): Promise<T> => {
      let working = true;
      const wrong: string[] = [];
      let reads = 0;
      let uploads = 0;
      const reader = async (offset: number) => {
        for (let i = offset; working; i += 1) {
          const row = changing[i % changing.length];
          const door = row.doors[i % row.doors.length];
          const answer = await get(via, door.route, door.who).catch((error: Error) => ({ status: 0, body: Buffer.from(error.message), headers: {} }));
          reads += 1;
          if (answer.status !== 200 || !answer.body.equals(row.bytes)) wrong.push(`${door.door} on ${row.id}: ${answer.status} ${answer.body.toString('utf8').slice(0, 200)}`);
        }
      };
      const readers = Array.from({ length: 6 }, (_, i) => reader(i * 11));
      const uploader = (async () => {
        while (working) {
          const bytes = randomBytes(2048);
          try {
            const id = await upload(via, `/api/attachments?sessionId=${b62(sessionId)}`, bearer, bytes);
            const answer = await get(via, `/api/attachments/${b62(id)}`, bearer);
            uploads += 1;
            if (answer.status !== 200 || !answer.body.equals(bytes)) wrong.push(`an upload read back ${answer.status}`);
          } catch (error) {
            wrong.push(`an upload: ${String(error)}`);
          }
        }
      })();
      try {
        return await work();
      } finally {
        working = false;
        await Promise.all([...readers, uploader]);
        assert.deepEqual(wrong, [], 'every read and every upload while it ran');
        assert.ok(reads > 0 && uploads > 0, `reads and uploads went on around it (${reads}, ${uploads})`);
        // eslint-disable-next-line no-console
        console.log(`${leg.storage}: ${reads} reads and ${uploads} uploads went on around it`);
      }
    };

    await step(`${leg.storage}: a start with nothing waiting starts no copy, and the doors' answers are the baseline`, async () => {
      server = await boot();
      for (const [i, row] of rows.entries()) {
        const shape = shapes[i];
        await db.attachment.create({
          data: {
            id: row.id, ownerId, ...(shape.scope === 'session' ? { sessionId } : { taskId }),
            mimeType: shape.mimeType, sizeBytes: row.sizeBytes, fileName: shape.fileName, data: row.bytes,
          },
        });
        for (const door of row.doors) {
          door.before = await get(server, door.route, door.who);
          assert.equal(door.before.status, 200, door.door);
          assert.ok(door.before.body.equals(row.bytes), door.door);
        }
      }
      await sleep(MIGRATION_LIMITS.pauseMs * 2);
      assert.equal(await copiedCount(), 0, 'rows written after a start are not that start\'s to copy');
      assert.doesNotMatch(server.output(), /attachment copy:/);
      await server.stop();
    });

    const stalledAt = 30;
    let copiedByTheKilled: Set<string>;
    let versionsOfTheKilled: Awaited<ReturnType<typeof versions>>['attachments'];

    await step(`${leg.storage}: a start does not wait for the copy, and everything answers while it is partway`, async () => {
      const release = await hold(rows[stalledAt].id);
      try {
        server = await boot();
        assert.ok((await copiedCount()) <= stalledAt, 'the server answers with the copy not done');
        await until(async () => (await copiedCount()) === stalledAt, `the copy reaches row ${stalledAt}`);
        await sleep(300);
        assert.equal(await copiedCount(), stalledAt, 'and stops at the row it cannot write');

        // Rows in all three states: named, stored and not named yet, and waiting.
        await until(() => store.has(rows[stalledAt].sha), 'the row it stopped at has its bytes in the store');
        assert.equal(await store.has(rows[stalledAt + 40].sha), false, 'and a later one does not');
        await assertDoors(server, 'with the copy partway');
        const bytes = randomBytes(4096);
        const id = await upload(server, `/api/attachments?sessionId=${b62(sessionId)}`, bearer, bytes);
        assert.ok((await get(server, `/api/attachments/${b62(id)}`, bearer)).body.equals(bytes), 'and an upload is kept and read back');

        // The bytes stored and the row not yet naming them: the worst moment for a process to die.
        await kill(server);
      } finally {
        await release();
      }
      // The row's UPDATE was already with the database: it goes through, or not, with the process gone.
      await until(
        async () => (await sql.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%attachment%sha256%' AND state <> 'idle' AND pid <> pg_backend_pid()`)).rows[0].n === 0,
        'the row the process was writing is settled',
      );
      const copied = await sql.query('SELECT id::text FROM attachment WHERE id = ANY($1::uuid[]) AND sha256 IS NOT NULL', [everyId]);
      copiedByTheKilled = new Set(copied.rows.map((row) => row.id as string));
      assert.ok(copiedByTheKilled.size === stalledAt || copiedByTheKilled.size === stalledAt + 1, 'the rows it reached, and nothing else');
      versionsOfTheKilled = (await versions()).attachments.filter((row) => copiedByTheKilled.has(row.id));
    });

    await step(`${leg.storage}: the next start carries on from the rows, under reads and uploads, and logs its counts`, async () => {
      const left = rows.filter((row) => !copiedByTheKilled.has(row.id));
      const release = await hold(left[1].id);
      server = await boot();
      await until(async () => (await copiedCount()) === copiedByTheKilled.size + 1, 'the copy carries on, as far as the next hold');
      await underTraffic(server, left, async () => {
        await release();
        await until(async () => (await copiedCount()) === rows.length, 'every row is copied');
      });

      const [batch, rest] = [left.slice(0, MIGRATION_LIMITS.rows), left.slice(MIGRATION_LIMITS.rows)];
      const bytesOf = (some: OldRow[]) => some.reduce((sum, row) => sum + row.sizeBytes, 0);
      await until(async () => /0 \(0 bytes\) left/.test(server!.output()), 'the last line of progress');
      const lines = server.output().split('\n').filter((line) => line.includes('attachment copy:'));
      assert.equal(lines.length, 2, `a line after each batch: ${lines.join('\n')}`);
      assert.match(lines[0], new RegExp(`attachment copy: ${batch.length} \\(${bytesOf(batch)} bytes\\) copied this run, ${rest.length} \\(${bytesOf(rest)} bytes\\) left`));
      assert.match(lines[1], new RegExp(`attachment copy: ${left.length} \\(${bytesOf(left)} bytes\\) copied this run, 0 \\(0 bytes\\) left`));

      assert.deepEqual(
        (await versions()).attachments.filter((row) => copiedByTheKilled.has(row.id)),
        versionsOfTheKilled,
        'and no row the killed process reached is written again',
      );
    });

    await step(`${leg.storage}: the copy alone leaves data as it was, so a client from before Orbit Files reads every row`, async () => {
      const seen = await sql.query(
        `SELECT id::text, sha256, encode(pg_catalog.sha256(data), 'hex') AS in_data, octet_length(data) AS length FROM attachment WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [everyId],
      );
      assert.deepEqual(
        seen.rows,
        rows.map((row) => ({ id: row.id, sha256: row.sha, in_data: row.sha, length: row.bytes.length })),
        'every row names its bytes, and still holds them',
      );
      const blobs = await db.fileBlob.findMany({ where: { sha256: { in: [...contents.keys()] } }, select: { sha256: true, sizeBytes: true, storage: true } });
      assert.deepEqual(
        blobs.sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
        [...contents].map(([sha, bytes]) => ({ sha256: sha, sizeBytes: bytes.length, storage: leg.storage })).sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1)),
        'one file_blob row per content, three rows of one content being one of them',
      );
      for (const [sha, bytes] of contents) {
        assert.ok((await readAll(await store.open(sha)))?.equals(bytes), `the store holds ${sha}`);
      }
      await assertDoors(server!, 'after the copy');
      for (const row of rows) {
        assert.ok((await readAsBeforeOrbitFiles(older, ownerId, row.id)).equals(row.bytes), `the older client reads ${row.id}`);
      }
      const status = await run('status');
      assert.equal(status.code, 0, status.output);
      assert.match(status.output, /attachments waiting for the copy: 0 \(0 bytes\)/);
      assert.equal((await run()).code, 2, 'no command is no clear');
      assert.equal((await run('clean')).code, 2, 'and neither is a mistyped one');
    });

    await step(`${leg.storage}: a start after the copy writes nothing`, async () => {
      await server!.stop();
      const before = await versions();
      server = await boot();
      await sleep(MIGRATION_LIMITS.pauseMs * 2);
      assert.deepEqual(await versions(), before, 'not a row, of either table');
      assert.doesNotMatch(server.output(), /attachment copy:/);
    });

    const clearStalledAt = 40;
    await step(`${leg.storage}: the clear can be killed partway, with everything answering meanwhile`, async () => {
      const release = await hold(rows[clearStalledAt].id);
      const clearing = command('clear');
      try {
        await until(async () => (await clearedCount()) === clearStalledAt, `the clear reaches row ${clearStalledAt}`);
        await sleep(300);
        assert.equal(await clearedCount(), clearStalledAt, 'and stops at the row it cannot write');
        await assertDoors(server!, 'with the clear partway');
        const bytes = randomBytes(4096);
        const id = await upload(server!, `/api/attachments?sessionId=${b62(sessionId)}`, bearer, bytes);
        assert.ok((await get(server!, `/api/attachments/${b62(id)}`, bearer)).body.equals(bytes), 'and an upload is kept and read back');
        await kill(clearing.child);
      } finally {
        await release();
      }
      await until(
        async () => (await sql.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%UPDATE attachment%' AND state <> 'idle' AND pid <> pg_backend_pid()`)).rows[0].n === 0,
        'the row the command was writing is settled',
      );
      const cleared = await clearedCount();
      assert.ok(cleared === clearStalledAt || cleared === clearStalledAt + 1, 'the rows it reached, and nothing else');
    });

    await step(`${leg.storage}: a row the store cannot vouch for is not cleared, and is reported, and the rest are`, async () => {
      // Each its own content, past where the killed run got to.
      const [missing, others, truncated, wrongStore, wrongData] = [rows[70], rows[75], rows[80], rows[85], rows[90]];
      await leg.drop(missing.sha);
      await leg.put(others.sha, randomBytes(others.bytes.length));
      await leg.put(truncated.sha, truncated.bytes.subarray(0, truncated.bytes.length - 1));
      const otherStorage = leg.storage === 'local' ? 's3' : 'local';
      await db.fileBlob.update({ where: { sha256: wrongStore.sha }, data: { storage: otherStorage } });
      const notTheBytes = randomBytes(wrongData.bytes.length);
      await sql.query('UPDATE attachment SET data = $1 WHERE id = $2::uuid', [notTheBytes, wrongData.id]);

      // The rest of the rows, with reads and uploads around it: a hold keeps it running until they have started.
      const release = await hold(rows[60].id);
      const clearing = command('clear');
      await until(async () => (await clearedCount()) >= 60, 'the clear reaches the hold');
      // Not the rows just spoiled: a door reads the store, whose bytes under those names are now wrong.
      const spoiled = [missing, others, truncated, wrongStore, wrongData];
      const code = await underTraffic(server!, rows.slice(60).filter((row) => !spoiled.includes(row)), async () => {
        await sleep(500);
        await release();
        return clearing.ended;
      });
      const output = clearing.output();
      assert.equal(code, 1, `rows are left, so it does not say it is done:\n${output}`);
      const refused = (row: OldRow, reason: string) => {
        const line = output.split('\n').find((said) => said.startsWith(`refused ${row.id} `));
        assert.ok(line, `${row.id} is reported:\n${output}`);
        assert.ok(line.includes(`sha256 ${row.sha}`), line);
        assert.ok(line.includes(reason), line);
      };
      refused(missing, `the ${leg.storage} file store does not hold these bytes`);
      refused(others, `the ${leg.storage} file store holds other bytes under this name: ${others.bytes.length} bytes, sha256 `);
      refused(truncated, `the ${leg.storage} file store holds other bytes under this name: ${truncated.bytes.length - 1} bytes, sha256 ${sha256(truncated.bytes.subarray(0, -1))}`);
      refused(wrongStore, `the ${otherStorage} file store does not hold these bytes`);
      refused(wrongData, 'its data in Postgres does not hash to this sha256');
      assert.equal(output.split('\n').filter((line) => line.startsWith('refused ')).length, 5, output);
      assert.match(output, /cleared this run: \d+ \(\d+ bytes\), refused: 5/);
      assert.match(output, /attachment clear: \d+ \(\d+ bytes\) cleared this run, 5 refused/);
      assert.match(output, /attachments copied and still in Postgres: 5 \(/);

      const left = await sql.query(
        `SELECT id::text, encode(pg_catalog.sha256(data), 'hex') AS in_data FROM attachment WHERE id = ANY($1::uuid[]) AND data IS NOT NULL ORDER BY id`,
        [everyId],
      );
      assert.deepEqual(
        left.rows,
        spoiled.map((row) => ({ id: row.id, in_data: row === wrongData ? sha256(notTheBytes) : row.sha })),
        'those five keep their data, whatever it is, and no other row does',
      );

      // Put right: the bytes back in the store, and in the row.
      await leg.put(missing.sha, missing.bytes);
      await leg.put(truncated.sha, truncated.bytes);
      await db.fileBlob.update({ where: { sha256: wrongStore.sha }, data: { storage: leg.storage } });
      await sql.query('UPDATE attachment SET data = $1 WHERE id = $2::uuid', [wrongData.bytes, wrongData.id]);
      // And the recipe docs/self-hosting.md gives an operator: the store's wrong bytes removed, the row back to before the
      // copy, a restart. The bytes are copied again from `data`.
      await leg.drop(others.sha);
      await sql.query('UPDATE attachment SET sha256 = NULL WHERE id = $1::uuid', [others.id]);
      await server!.stop();
      server = await boot();
      await until(async () => (await copiedCount()) === rows.length, 'the copy takes the row again');
      assert.ok((await readAll(await store.open(others.sha)))?.equals(others.bytes), 'and the store holds its bytes');

      const again = await run('clear');
      assert.equal(again.code, 0, again.output);
      assert.doesNotMatch(again.output, /^refused /m);
      assert.match(again.output, /cleared this run: 5 \(\d+ bytes\), refused: 0/);
    });

    await step(`${leg.storage}: after the clear data is NULL everywhere, every door answers as before, and an older client reads nothing`, async () => {
      assert.equal(await clearedCount(), rows.length, 'data is NULL on every row');
      assert.equal(await db.fileBlob.count({ where: { sha256: { in: [...contents.keys()] } } }), contents.size, 'every content keeps its file_blob row');
      await assertDoors(server!, 'after the clear');
      for (const row of rows.slice(0, 3)) {
        await assert.rejects(readAsBeforeOrbitFiles(older, ownerId, row.id), (error: Error) => {
          // eslint-disable-next-line no-console
          console.log(`${leg.storage}: the older client on a cleared row: ${error.message.trim().split('\n').at(-1)}`);
          return true;
        });
      }
      if (leg.storage === 'local') {
        assert.deepEqual(readdirSync(path.join(leg.dir, 'tmp')), [], 'nothing is left in the temporary directory');
      }
    });

    await step(`${leg.storage}: running it again, and starting again, write nothing`, async () => {
      const before = await versions();
      const again = await run('clear');
      assert.equal(again.code, 0, again.output);
      assert.match(again.output, /cleared this run: 0 \(0 bytes\), refused: 0/);
      assert.deepEqual(await versions(), before, 'a second clear');
      await server!.stop();
      server = await boot();
      await sleep(MIGRATION_LIMITS.pauseMs * 2);
      assert.deepEqual(await versions(), before, 'a start');
      assert.doesNotMatch(server.output(), /attachment copy:/);
      await assertDoors(server, 'after a start', rows.slice(0, 5));
      await server.stop();
    });

    // ── What a batch is, and what stops one ────────────────────────────────────────────────────
    const files = new FilesService(db as unknown as PrismaService, leg.config);
    const seed = async (sizes: number[]) => {
      const seeded = sizes.map(() => randomUUID()).sort().map((id, i) => ({ id, bytes: randomBytes(sizes[i]) }));
      for (const { id, bytes } of seeded) {
        await db.attachment.create({ data: { id, ownerId, sessionId, mimeType: 'application/octet-stream', sizeBytes: bytes.length, data: bytes } });
      }
      return seeded;
    };
    const copiedOf = async (seeded: { id: string }[]) => db.attachment.count({ where: { id: { in: seeded.map((row) => row.id) }, sha256: { not: null } } });
    const finish = async () => {
      await new AttachmentMigration(db, files, quiet, { ...MIGRATION_LIMITS, pauseMs: 1, minFreeBytes: 0 }).copy(new AbortController().signal);
      const refused: string[] = [];
      await new AttachmentMigration(db, files, quiet).clear((row) => refused.push(row.reason));
      assert.deepEqual(refused, []);
    };
    const limits: MigrationLimits = { rows: 3, bytes: 1000, pauseMs: 1, retryMs: 10, minFreeBytes: 0 };

    await step(`${leg.storage}: a batch ends at its rows or its bytes, and a stopped copy is carried on by the next`, async () => {
      const seeded = await seed([400, 400, 400, 5000, 300, 300, 300, 300]);
      const lines: string[] = [];
      const stop = new AbortController();
      const first = new AttachmentMigration(db, files, {
        log: (line: string) => {
          lines.push(line);
          if (lines.length === 3) stop.abort();
        },
        warn: quiet.warn,
      }, limits);
      await first.copy(stop.signal);
      assert.deepEqual(lines, [
        'attachment copy: 2 (800 bytes) copied this run, 6 (6600 bytes) left',
        'attachment copy: 3 (1200 bytes) copied this run, 5 (6200 bytes) left',
        // A row over the limit is a batch of its own.
        'attachment copy: 4 (6200 bytes) copied this run, 4 (1200 bytes) left',
      ]);
      assert.equal(await copiedOf(seeded), 4, 'stopped after that batch');
      lines.length = 0;
      await new AttachmentMigration(db, files, { log: (line: string) => lines.push(line), warn: quiet.warn }, limits).copy(new AbortController().signal);
      assert.deepEqual(lines, [
        // Three rows fit in the bytes: this one ends at its rows.
        'attachment copy: 3 (900 bytes) copied this run, 1 (300 bytes) left',
        'attachment copy: 4 (1200 bytes) copied this run, 0 (0 bytes) left',
      ]);
      await finish();
    });

    await step(`${leg.storage}: two processes copying at once agree`, async () => {
      const seeded = await seed([300, 300, 300, 300, 300, 300, 300]);
      const copyOf = () => new AttachmentMigration(db, new FilesService(db as unknown as PrismaService, leg.config), quiet, limits).copy(new AbortController().signal);
      await Promise.all([copyOf(), copyOf()]);
      const rows = await db.attachment.findMany({ where: { id: { in: seeded.map((row) => row.id) } }, orderBy: { id: 'asc' }, select: { id: true, sha256: true } });
      assert.deepEqual(rows, seeded.map((row) => ({ id: row.id, sha256: sha256(row.bytes) })), 'every row names its own bytes');
      assert.equal(await db.fileBlob.count({ where: { sha256: { in: seeded.map((row) => sha256(row.bytes)) } } }), seeded.length, 'one file_blob row each');
      await finish();
    });

    await step(`${leg.storage}: a store that is down leaves every row as it was, and the copy carries on when it is back`, async () => {
      const seeded = await seed([100, 100]);
      // A file where its temporary directory has to go: every write to the store fails, on the row at hand.
      const broken = mkdtempSync(path.join(leg.dir, 'broken-'));
      writeFileSync(path.join(broken, 'tmp'), '');
      const warnings: string[] = [];
      const stop = new AbortController();
      const down = new FilesService(db as unknown as PrismaService, { dir: broken, storage: 'local' });
      const copying = new AttachmentMigration(db, down, { log: quiet.log, warn: (line: string) => warnings.push(line) }, limits).copy(stop.signal);
      await until(async () => warnings.length >= 3, 'it keeps trying', 10_000);
      stop.abort();
      await copying;
      assert.match(warnings[0], new RegExp(`attachment copy: stopped at row ${seeded[0].id}: EEXIST`));
      assert.equal(await copiedOf(seeded), 0, 'no row names bytes that were not kept');
      await finish();
      assert.equal(await copiedOf(seeded), 2);
    });

    await step(`${leg.storage}: the copy waits for room on a local store's disk, and never for a bucket's`, async () => {
      const seeded = await seed([100, 100]);
      const warnings: string[] = [];
      const stop = new AbortController();
      const crowded = { ...limits, minFreeBytes: Number.MAX_SAFE_INTEGER };
      if (leg.storage === 's3') {
        await new AttachmentMigration(db, files, quiet, crowded).copy(stop.signal);
        assert.equal(await copiedOf(seeded), 2, 'a bucket is not this host\'s disk');
      } else {
        const copying = new AttachmentMigration(db, files, { log: quiet.log, warn: (line: string) => warnings.push(line) }, crowded).copy(stop.signal);
        await until(async () => warnings.length >= 2, 'it says why it waits', 10_000);
        stop.abort();
        await copying;
        assert.match(warnings[0], new RegExp(`attachment copy: stopped at row none: the disk under the files directory has \\d+ bytes free, and this leaves it ${Number.MAX_SAFE_INTEGER}`));
        assert.equal(await copiedOf(seeded), 0, 'and copies nothing meanwhile');
        await new AttachmentMigration(db, files, quiet, limits).copy(new AbortController().signal);
        assert.equal(await copiedOf(seeded), 2, 'and carries on when there is room');
      }

      // Whichever store holds the bytes the clear stops: what it fills is Postgres's disk.
      const refused: string[] = [];
      const result = await new AttachmentMigration(db, files, quiet, crowded).clear((row) => refused.push(row.reason));
      assert.equal(result.cleared.rows, 0);
      assert.match(result.stopped ?? '', /the disk under the files directory has \d+ bytes free/);
      assert.deepEqual(refused, []);
      assert.equal(await db.attachment.count({ where: { id: { in: seeded.map((row) => row.id) }, data: { not: null } } }), 2, 'and no row is cleared');
      await finish();
    });

    await step(`${leg.storage}: a row that fails is tried again after the others, and a row deleted under the copy is no failure`, async () => {
      const [fails, , deleted, last] = await seed([100, 100, 100, 100]);
      const flaky = new FilesService(db as unknown as PrismaService, leg.config);
      const referenceOf = flaky.referenceOf.bind(flaky);
      let failed = false;
      flaky.referenceOf = async (row) => {
        if (row.id === fails.id && !failed) {
          failed = true;
          throw new Error('the disk is full');
        }
        if (row.id === deleted.id) await db.attachment.delete({ where: { id: deleted.id } });
        return referenceOf(row);
      };
      const lines: string[] = [];
      const warnings: string[] = [];
      await new AttachmentMigration(db, flaky, { log: (line: string) => lines.push(line), warn: (line: string) => warnings.push(line) }, limits)
        .copy(new AbortController().signal);
      assert.deepEqual(warnings, [`attachment copy: stopped at row ${fails.id}: the disk is full`], 'one failure, and the deleted row is none');
      assert.equal(lines.at(-1), 'attachment copy: 3 (300 bytes) copied this run, 0 (0 bytes) left', 'the failed row with the others, the deleted row not counted');
      assert.equal((await db.attachment.findUniqueOrThrow({ where: { id: last.id }, select: { sha256: true } })).sha256, sha256(last.bytes));
      await finish();
    });

    await step(`${leg.storage}: a copied row whose store fails is read from data for as long as it has any`, async () => {
      const [row] = await seed([1024]);
      await new AttachmentMigration(db, files, quiet, limits).copy(new AbortController().signal);
      const sha = sha256(row.bytes);
      const before = await db.fileBlob.findUniqueOrThrow({ where: { sha256: sha }, select: { storage: true } });
      // A bucket that refuses every connection, named by the row's blob.
      await db.fileBlob.update({ where: { sha256: sha }, data: { storage: 's3' } });
      const failing = new FilesService(db as unknown as PrismaService, {
        dir: leg.dir, storage: 's3',
        s3: { endpoint: 'http://127.0.0.1:9', bucket: 'none', accessKeyId: 'none', secretAccessKey: 'none', region: 'none' },
      });
      const warned: string[] = [];
      const warn = t.mock.method(Logger.prototype, 'warn', (line: string) => {
        warned.push(line);
      });
      const opened = await failing.open({ id: row.id });
      warn.mock.restore();
      assert.ok(Buffer.isBuffer(opened?.content) && opened.content.equals(row.bytes), 'answered from data');
      assert.equal(warned.length, 1, warned.join('\n'));
      assert.match(warned[0], new RegExp(`^attachment ${row.id} was answered from Postgres: the s3 file store could not be read: .*(ECONNREFUSED|connect)`));
      await db.fileBlob.update({ where: { sha256: sha }, data: { storage: before.storage } });
      await finish();
      await db.fileBlob.update({ where: { sha256: sha }, data: { storage: 's3' } });
      await assert.rejects(failing.open({ id: row.id }), 'with no data left, the store\'s failure stands');
      await db.fileBlob.update({ where: { sha256: sha }, data: { storage: before.storage } });
    });

    await step(`${leg.storage}: a read between open's two statements, as the row is copied and cleared, finds the bytes in the store`, async () => {
      const [row] = await seed([2048]);
      const raced = {
        attachment: new Proxy(db.attachment, {
          get(model, method, receiver) {
            if (method !== 'findUnique') return Reflect.get(model, method, receiver);
            return async (args: Parameters<typeof db.attachment.findUnique>[0]) => {
              await finish();
              return db.attachment.findUnique(args);
            };
          },
        }),
      };
      const opened = await new FilesService(raced as unknown as PrismaService, leg.config).open({ id: row.id });
      assert.ok(opened && !Buffer.isBuffer(opened.content), 'answered from the store');
      assert.ok((await readAll(opened.content as Readable))?.equals(row.bytes));
      assert.equal(opened.sizeBytes, row.bytes.length);
    });

    await step(`${leg.storage}: a copied row whose store has lost its bytes is answered from data, and the log says so, once`, async () => {
      const [lost, alsoLost] = await seed([2048, 2048]);
      server = await boot();
      await until(async () => (await copiedOf([lost, alsoLost])) === 2, 'the copy takes both');
      for (const row of [lost, alsoLost]) await leg.drop(sha256(row.bytes));
      for (const row of [lost, alsoLost, lost]) {
        const answer = await get(server, `/api/attachments/${b62(row.id)}`, bearer);
        assert.equal(answer.status, 200, answer.body.toString('utf8').slice(0, 300));
        assert.ok(answer.body.equals(row.bytes), 'the same bytes, from data');
      }
      const warnings = server.output().split('\n').filter((line) => line.includes('was answered from Postgres'));
      assert.equal(warnings.length, 1, warnings.join('\n'));
      assert.ok(warnings[0].includes(`attachment ${lost.id} was answered from Postgres: the ${leg.storage} file store does not hold these bytes.`), warnings[0]);
      for (const row of [lost, alsoLost]) await leg.put(sha256(row.bytes), row.bytes);
      await server.stop();
      await finish();
    });

    const tempDir = path.join(leg.dir, 'tmp');

    await step(`${leg.storage}: what a process killed while writing a temporary file leaves stays for a day, and then a start removes it and nothing else`, async () => {
      // One row for a lock to stop the copy at while the server comes up, and then rows large enough to catch it writing.
      const [held, ...large] = await seed([100, ...Array.from({ length: 4 }, () => 20 * 1024 * 1024)]);
      const release = await hold(held.id);
      server = await boot();
      await until(() => store.has(sha256(held.bytes)), 'the copy reaches the row held');
      await release();

      // Stopped from outside at a large file still in the directory, so that it cannot move the file on; killed once that
      // has held. A file seen a moment before it moved is let go, and the next row's is caught.
      let left: string | undefined;
      let seenBytes = 0;
      for (const deadline = Date.now() + 90_000; !left && Date.now() < deadline; await nextTurn()) {
        for (const name of readdirSync(tempDir)) {
          const file = path.join(tempDir, name);
          seenBytes = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
          if (seenBytes <= 1024 * 1024) continue;
          server.child.kill('SIGSTOP');
          await sleep(50);
          if (existsSync(file)) left = file;
          else server.child.kill('SIGCONT');
          break;
        }
      }
      assert.ok(left, 'the copy is caught writing a temporary file');
      await kill(server);
      const leftBytes = statSync(left).size;
      // eslint-disable-next-line no-console
      console.log(`${leg.storage}: killed with ${seenBytes} bytes seen in ${left}; ${leftBytes} there after the kill`);

      // The next start takes that row again. It leaves the file: for all it can tell, another apiserver is writing it.
      server = await boot();
      await until(async () => (await copiedOf([held, ...large])) === large.length + 1, 'the copy finishes');
      assert.equal(statSync(left).size, leftBytes, 'a start the same day leaves it');
      assert.doesNotMatch(server.output(), /temporary files:/);
      await server.stop();

      // A day on, by hand, with what a start has to leave alone beside it.
      const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      utimesSync(left, longAgo, longAgo);
      const fresh = path.join(tempDir, 'upload-under-way');
      writeFileSync(fresh, 'an apiserver is writing this');
      const outside = path.join(leg.dir, 'outside-the-temporary-directory');
      writeFileSync(outside, 'not a temporary file');
      utimesSync(outside, longAgo, longAgo);
      const link = path.join(tempDir, 'a-link');
      symlinkSync(outside, link);
      lutimesSync(link, longAgo, longAgo);

      // The usual start from now on: no copy to run, and it removes the file all the same.
      assert.equal(await db.attachment.count({ where: { sha256: null } }), 0, 'no row waits for the copy');
      server = await boot();
      await until(async () => !existsSync(left), 'a start a day later removes it');
      await until(async () => server!.output().includes(`temporary files: removed 1 (${leftBytes} bytes) not written for a day from ${tempDir}`), 'and says so');
      assert.equal(existsSync(fresh), true, 'a fresher file stays');
      assert.equal(readlinkSync(link), outside, 'a link stays');
      assert.equal(readFileSync(outside, 'utf8'), 'not a temporary file', 'and what it points at');

      for (const row of large) {
        assert.ok((await readAll(await store.open(sha256(row.bytes))))?.equals(row.bytes), 'the stored bytes are intact');
      }
      await finish();
      for (const row of large) {
        const answer = await get(server, `/api/attachments/${b62(row.id)}`, bearer);
        assert.equal(answer.status, 200);
        assert.ok(answer.body.equals(row.bytes), 'and answered, with data cleared');
      }
      await server.stop();
      for (const file of [fresh, link, outside]) unlinkSync(file);
    });

    await step(`${leg.storage}: a start whose temporary directory cannot be read says so, and answers`, async () => {
      rmSync(tempDir, { recursive: true, force: true });
      writeFileSync(tempDir, 'a file where the directory goes');
      server = await boot();
      await until(async () => server!.output().includes(`temporary files: could not read ${tempDir}: it is a link, or not a directory`), 'it says so');
      await assertDoors(server, 'with its temporary directory unreadable', rows.slice(0, 5));
      await server.stop();
      unlinkSync(tempDir);
    });
  };
}

test('moving old attachments out of Postgres, on the local files directory and on an S3-compatible server', {
  skip: !PG_URL, concurrency: 1, timeout: 900_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  try {
    await verifyCoordinatorPgIdentity(sql);
  } finally {
    await sql.end();
  }

  const localDir = mkdtempSync(path.join(tmpdir(), 'orbit-migration-local-'));
  const s3Dir = mkdtempSync(path.join(tmpdir(), 'orbit-migration-s3-'));
  t.after(() => {
    rmSync(localDir, { recursive: true, force: true });
    rmSync(s3Dir, { recursive: true, force: true });
  });

  const local = new LocalFileStore(localDir);
  await t.test('local', storeCases({
    storage: 'local',
    dir: localDir,
    config: { dir: localDir, storage: 'local' },
    env: { ORBIT_FILES_BACKEND: 'local', ORBIT_FILES_DIR: localDir },
    put: async (sha, bytes) => {
      mkdirSync(path.dirname(local.pathOf(sha)), { recursive: true });
      writeFileSync(local.pathOf(sha), bytes);
    },
    drop: async (sha) => unlinkSync(local.pathOf(sha)),
  }));

  const s3 = await startS3((fn) => t.after(fn));
  const bucket = new S3FileStore(s3);
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
    put: (sha, bytes) => s3Object(s3, 'PUT', bucket.keyOf(sha), bytes),
    drop: (sha) => s3Object(s3, 'DELETE', bucket.keyOf(sha)),
  }));
});
