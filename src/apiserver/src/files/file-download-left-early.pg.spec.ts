/**
 * A client may leave a file download at any moment. Whenever it goes, what the download held — the stored file, or
 * the connection to the bucket — is closed, and the server goes on answering.
 *
 * Held against the production apiserver (build/main.js, the whole AppModule) over raw sockets and a real, fully
 * migrated PostgreSQL, once with each store, on every door that streams a stored file: each client leaves at a chosen
 * point of the request. Collections run all the time, so that nothing a request leaves behind outlives its case; one
 * case stops them, to show that the download itself gives back what it held.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/files/file-download-left-early.pg.spec.ts
 *
 * A case that fails ends its server and the next starts another, so that nothing it held is carried over and one run
 * reads the whole table. Not destructive: the server writes to the database run-pg-spec.sh made for this spec.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { bootScrubbedApiserver, type ScrubbedApiserver } from '../test-support/managed-runner-apiserver';
import { startS3 } from '../test-support/s3-test-server';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const JWT_SECRET = randomBytes(32).toString('hex');

/** Well past what a socket's buffers hold, so that a client who stops reading stops the download. */
const FILE_BYTES = 20 * 1024 * 1024;
/** How many clients each case sends, all at once. */
const CLIENTS = 3;
/** Collections a case waits for after its clients have left. */
const COLLECTIONS = 3;

/** Preloaded into the server: a full collection every 100 ms, counted in $COLLECTIONS_LOG, unless that file has a .paused beside it. */
const COLLECTOR = String.raw`'use strict';
const { existsSync, writeFileSync } = require('node:fs');
let collections = 0;
setInterval(() => {
  if (existsSync(process.env.COLLECTIONS_LOG + '.paused')) return;
  global.gc();
  writeFileSync(process.env.COLLECTIONS_LOG, String(++collections));
}, 100).unref();
`;

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function until(condition: () => boolean, what: string, within = 15_000): Promise<void> {
  for (const deadline = Date.now() + within; Date.now() < deadline; await sleep(20)) {
    if (condition()) return;
  }
  assert.fail(`${what}: not within ${within} ms`);
}

// ── The clients ────────────────────────────────────────────────────────────────────────────────
interface Moment {
  name: string;
  /** Sees a body to leave in the middle of, which a HEAD has not. */
  needsBody?: boolean;
  /** Called with the socket once the request is written. */
  sent?(socket: net.Socket, gone: () => void): void;
  /** Called with everything received so far. */
  received?(socket: net.Socket, bytes: number, gone: () => void): void;
}

const leaveWhenHeadersArrive: Moment['received'] = (socket, _bytes, gone) => {
  socket.destroy();
  gone();
};

const MOMENTS: Moment[] = [
  {
    name: 'closing as soon as the request is sent',
    sent(socket, gone) {
      socket.destroy();
      gone();
    },
  },
  {
    name: 'resetting as soon as the request is sent',
    sent(socket, gone) {
      socket.resetAndDestroy();
      gone();
    },
  },
  {
    name: 'shutting its side down as the request is sent',
    sent(socket) {
      socket.end();
    },
    // Whatever the server still sends, it is told at once that nobody reads it.
    received: leaveWhenHeadersArrive,
  },
  { name: 'closing when the headers arrive', received: leaveWhenHeadersArrive },
  {
    name: 'closing halfway through the body',
    needsBody: true,
    received(socket, bytes, gone) {
      if (bytes < FILE_BYTES / 2) return;
      socket.destroy();
      gone();
    },
  },
  {
    name: 'closing after it has stopped reading',
    needsBody: true,
    received(socket, _bytes, gone) {
      socket.pause();
      setTimeout(() => {
        socket.destroy();
        gone();
      }, 300);
    },
  },
];

interface Answered {
  /** The answer's first line, when any of it arrived. */
  statusLine: string;
}

/** One raw request, left at `moment`. */
function leave(port: number, request: string | Buffer, moment: Moment): Promise<Answered> {
  return new Promise((resolve, reject) => {
    let received = 0;
    let head = Buffer.alloc(0);
    const gone = () => resolve({ statusLine: head.toString('latin1').split('\r\n', 1)[0] });
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(60_000, () => {
      socket.destroy();
      reject(new Error(`no answer to ${String(request).slice(0, 80)} within 60 s`));
    });
    socket.on('error', () => undefined);
    socket.on('close', gone);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (head.length < 64 * 1024) head = Buffer.concat([head, chunk]);
      if (head.includes('\r\n\r\n')) moment.received?.(socket, received, gone);
    });
    socket.once('connect', () => socket.write(request, () => moment.sent?.(socket, gone)));
  });
}

// ── What the server holds ──────────────────────────────────────────────────────────────────────
function descriptorTargets(server: ScrubbedApiserver): string[] {
  const dir = `/proc/${server.child.pid}/fd`;
  return readdirSync(dir).flatMap((fd) => {
    try {
      return [readlinkSync(path.join(dir, fd))];
    } catch {
      return []; // Closed since the directory was read.
    }
  });
}

/** Stands between the server and the bucket, so that the connections it keeps can be counted from outside it. */
async function bucketConnections(endpoint: string, after: (fn: () => void) => void) {
  const { hostname, port } = new globalThis.URL(endpoint);
  const open = new Set<net.Socket>();
  const forwarder = net.createServer((server) => {
    open.add(server);
    const bucket = net.connect(Number(port), hostname);
    const drop = () => {
      open.delete(server);
      server.destroy();
      bucket.destroy();
    };
    for (const end of [server, bucket]) {
      end.on('error', drop);
      end.on('close', drop);
    }
    server.pipe(bucket);
    bucket.pipe(server);
  });
  await new Promise<void>((resolve) => forwarder.listen(0, '127.0.0.1', resolve));
  after(() => {
    for (const socket of open) socket.destroy();
    forwarder.close();
  });
  return {
    endpoint: `http://127.0.0.1:${(forwarder.address() as net.AddressInfo).port}`,
    open: () => open.size,
  };
}

// ── One store ──────────────────────────────────────────────────────────────────────────────────
interface Leg {
  storage: 'local' | 's3';
  env: Record<string, string>;
  bucket?: { open(): number };
}

function storeCases(leg: Leg, filesDir: string, scratch: string) {
  return async (t: TestContext) => {
    const url = URL!;
    const db: PrismaClient = prismaClientFor(url);
    let current: ScrubbedApiserver | undefined;
    t.after(async () => {
      await current?.stop();
      await db.$disconnect().catch(() => undefined);
    });

    const collectionsLog = path.join(scratch, `${leg.storage}-collections`);
    const collector = path.join(scratch, `${leg.storage}-collector.cjs`);
    writeFileSync(collector, COLLECTOR);
    const stopped = (server: ScrubbedApiserver) => server.child.exitCode !== null || server.child.signalCode !== null;
    let boots = 0;
    const serving = async (): Promise<ScrubbedApiserver> => {
      if (!current || stopped(current)) {
        writeFileSync(collectionsLog, '0');
        current = await bootScrubbedApiserver(scratch, `${leg.storage}-${(boots += 1)}`, {
          DATABASE_URL: url,
          JWT_SECRET,
          ORBIT_FILES_DIR: filesDir,
          // No reaching models.dev from a spec: the catalogue keeps the lists this build shipped.
          MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
          NODE_OPTIONS: `--expose-gc --require ${collector}`,
          COLLECTIONS_LOG: collectionsLog,
          ...leg.env,
        });
      }
      return current;
    };
    const collections = () => Number(readFileSync(collectionsLog, 'utf8') || 0);
    const openFiles = (server: ScrubbedApiserver) => descriptorTargets(server).filter((target) => target.startsWith(filesDir));

    /** After a case's clients have left: collected, still serving, and holding nothing of theirs. */
    async function settled(server: ScrubbedApiserver, connectionsBefore: number): Promise<void> {
      const seen = collections();
      await until(() => stopped(server) || collections() >= seen + COLLECTIONS, 'collections kept running');
      // What a collection leaves to finish, finishes in the turn after it.
      await sleep(50);
      if (!stopped(server)) await call(server, 'GET', '/api/auth/setup-status').catch(() => undefined);
      assert.ok(!stopped(server), `the server stopped (${server.child.exitCode ?? server.child.signalCode}):\n${server.output().slice(-1_500)}`);
      const answer = await call(server, 'GET', '/api/auth/setup-status');
      assert.equal(answer.status, 200, answer.text);
      await until(() => openFiles(server).length === 0, `no stored file stays open (${openFiles(server).length} are)`);
      const { bucket } = leg;
      if (bucket) await until(() => bucket.open() <= connectionsBefore, `no connection to the bucket stays open (${bucket.open()} are, ${connectionsBefore} before)`);
    }

    // An owner with a runner, a session on it, a task, and a link to each.
    const server = await serving();
    const ownerId = randomUUID();
    const email = `left-early-${leg.storage}-${RUN}@example.invalid`;
    await db.user.create({ data: { id: ownerId, email, name: 'Left early', passwordHash: 'x' } });
    const bearer = await new JwtService({ secret: JWT_SECRET }).signAsync({ sub: ownerId, email });
    const runnerId = randomUUID();
    const runnerToken = `${runnerId}-${RUN}`;
    await db.runner.create({ data: { id: runnerId, ownerId, name: `left-early-${leg.storage}`, tokenHash: sha256(Buffer.from(runnerToken)) } });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `left-early-${leg.storage}`, enabled: true } });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, title: 'left early', prompt: 'left early', ownerId, creatorId: ownerId, workspaceId,
        assignedRunnerId: runnerId, status: 'AWAITING_INPUT', startedAt: new Date(), runtimeSessionId: `runtime-${sessionId}`,
      },
    });
    const taskId = randomUUID();
    await db.task.create({ data: { id: taskId, title: 'left early', ownerId, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'EVIDENCE_JUDGMENT' } });
    const sessionLink = randomBytes(24).toString('base64url');
    const taskLink = randomBytes(24).toString('base64url');
    await db.shareLink.create({ data: { ownerId, token: sessionLink, sessionId } });
    await db.shareLink.create({ data: { ownerId, token: taskLink, taskId, include: { commentsAndFiles: true } } });

    async function upload(route: string, bytes: Buffer): Promise<string> {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'shot.png');
      const reply = await fetch(`http://127.0.0.1:${server.port}${route}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}` }, body: form });
      assert.equal(reply.status, 201, await reply.clone().text());
      return ((await reply.json()) as { id: string }).id;
    }
    const bytes = randomBytes(FILE_BYTES);
    const inSession = await upload(`/api/attachments?sessionId=${uuidToBase62(sessionId)}`, bytes);
    const onTask = await upload(`/api/attachments?taskId=${uuidToBase62(taskId)}`, bytes);

    const DOORS = [
      { name: 'GET /attachments/:id', route: `/api/attachments/${inSession}`, bearer },
      { name: 'a public session link', route: `/api/shared/${sessionLink}/attachments/${inSession}` },
      { name: 'a public task link', route: `/api/shared/${taskLink}/attachments/${onTask}` },
      { name: 'GET /runner/sessions/:id/attachments/:attId', route: `/api/runner/sessions/${uuidToBase62(sessionId)}/attachments/${inSession}`, bearer: runnerToken },
    ];
    const ASKED = [
      { name: 'GET', method: 'GET', headers: [] },
      { name: 'HEAD', method: 'HEAD', headers: [] },
      { name: 'a Range', method: 'GET', headers: ['Range: bytes=1048576-2097151'] },
    ];
    const requestFor = (door: (typeof DOORS)[number], asked: (typeof ASKED)[number]) => [
      `${asked.method} ${door.route} HTTP/1.1`,
      'Host: 127.0.0.1',
      ...(door.bearer ? [`Authorization: Bearer ${door.bearer}`] : []),
      ...asked.headers,
      '',
      '',
    ].join('\r\n');

    /** A case on a server of its own if the last one failed. Connections a failure left open would otherwise pile up. */
    const onServer = (body: (live: ScrubbedApiserver) => Promise<void>) => async () => {
      const live = await serving();
      try {
        await body(live);
      } catch (error) {
        await live.stop();
        throw error;
      }
    };

    // ── Every door, every way of asking, every moment ────────────────────────────────────────────
    for (const door of DOORS) {
      for (const asked of ASKED) {
        for (const moment of MOMENTS) {
          if (moment.needsBody && asked.method === 'HEAD') continue;
          await t.test(`${door.name}, ${asked.name}, ${moment.name}`, onServer(async (live) => {
            const connectionsBefore = leg.bucket?.open() ?? 0;
            const answers = await Promise.all(
              Array.from({ length: CLIENTS }, () => leave(live.port, requestFor(door, asked), moment)),
            );
            for (const { statusLine } of answers) {
              // Whatever a client stayed to see of the answer is the file's. One that left at once may have seen nothing.
              if (statusLine) assert.match(statusLine, /^HTTP\/1\.1 200 /);
            }
            if (moment.received && !moment.sent) assert.ok(answers.every(({ statusLine }) => statusLine), 'the door answered');
            await settled(live, connectionsBefore);
          }));
        }
      }
    }

    await t.test('a download in progress holds what these cases say is given back', onServer(async (live) => {
      const { bucket } = leg;
      const holding = () => (bucket ? bucket.open() > 0 : openFiles(live).length > 0);
      let seen = false;
      await leave(live.port, requestFor(DOORS[0], ASKED[0]), {
        name: 'watched',
        received(socket, _bytes, gone) {
          socket.pause();
          until(holding, 'the download holds its file or its connection')
            .then(() => {
              seen = true;
            }, () => undefined)
            .finally(() => {
              socket.destroy();
              gone();
            });
        },
      });
      assert.ok(seen, 'seen while it was in progress');
      await settled(live, 0);
    }));

    await t.test('a download gives back what it held by itself, with no collection to do it', onServer(async (live) => {
      const paused = `${collectionsLog}.paused`;
      writeFileSync(paused, '');
      try {
        await Promise.all(DOORS.flatMap((door) => Array.from({ length: CLIENTS }, () => leave(live.port, requestFor(door, ASKED[0]), MOMENTS[0]))));
        await sleep(500); // The server has reached the store for every one of them.
        await until(() => openFiles(live).length === 0, `no stored file stays open (${openFiles(live).length} are)`, 3_000);
        const { bucket } = leg;
        if (bucket) await until(() => bucket.open() === 0, `no connection to the bucket stays open (${bucket.open()} are)`, 7_000);
      } finally {
        rmSync(paused);
      }
    }));

    await t.test('leaving an upload halfway through closes what it held too', onServer(async (live) => {
      const boundary = `left-early-${RUN}`;
      const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shot.png"\r\nContent-Type: image/png\r\n\r\n`);
      const request = Buffer.concat([
        Buffer.from([
          `POST /api/attachments?sessionId=${uuidToBase62(sessionId)} HTTP/1.1`,
          'Host: 127.0.0.1',
          `Authorization: Bearer ${bearer}`,
          `Content-Type: multipart/form-data; boundary=${boundary}`,
          `Content-Length: ${head.length + FILE_BYTES}`,
          '',
          '',
        ].join('\r\n')),
        head,
        randomBytes(256 * 1024),
      ]);
      await Promise.all(Array.from({ length: CLIENTS }, () => leave(live.port, request, MOMENTS[0])));
      await settled(live, leg.bucket?.open() ?? 0);
      await until(() => readdirSync(path.join(filesDir, 'tmp')).length === 0, 'no temporary file stays');
    }));

    await t.test('leaving again and again brings the count of open files back to where it was', onServer(async (live) => {
      const asked = ASKED[0];
      const rounds = async () => {
        for (let round = 0; round < 5; round += 1) {
          await Promise.all(MOMENTS.flatMap((moment) => DOORS.slice(0, 2).map((door) => leave(live.port, requestFor(door, asked), moment))));
        }
      };
      await rounds(); // Whatever a server opens for its first requests is its baseline, not a leak.
      await settled(live, 0);
      const baseline = descriptorTargets(live).length;
      await rounds();
      await settled(live, 0);
      const after = descriptorTargets(live).length;
      t.diagnostic(`${leg.storage}: ${baseline} descriptors before, ${after} after; of them ${openFiles(live).length} stored files${leg.bucket ? `, ${leg.bucket.open()} connections to the bucket` : ''}`);
      // Room for the database pool to open a connection more. Anything a client's going left behind is at least one per
      // client, sixty here.
      assert.ok(after <= baseline + 5, `open descriptors grew from ${baseline} to ${after}:\n${descriptorTargets(live).join('\n')}`);
    }));

    await t.test('a client that stays gets the whole file, on every door', onServer(async (live) => {
      for (const door of DOORS) {
        const url = `http://127.0.0.1:${live.port}${door.route}`;
        const headers = door.bearer ? { authorization: `Bearer ${door.bearer}` } : undefined;
        const reply = await fetch(url, { headers });
        assert.equal(reply.status, 200, door.name);
        const body = Buffer.from(await reply.arrayBuffer());
        assert.equal(sha256(body), sha256(bytes), `${door.name}: the same bytes`);
        const head = await fetch(url, { method: 'HEAD', headers });
        assert.equal(head.status, 200, `${door.name}: HEAD`);
        assert.equal(head.headers.get('content-length'), String(FILE_BYTES), `${door.name}: HEAD says how long it is`);
      }
    }));
  };
}

test('a client may leave a file download at any moment', { skip: !URL, concurrency: 1, timeout: 1_800_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  try {
    await verifyCoordinatorPgIdentity(sql);
  } finally {
    await sql.end();
  }
  // Resolved, because what /proc says the server holds is compared with it.
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'orbit-left-early-')));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const localDir = path.join(scratch, 'local-files');
  await t.test('local', storeCases({ storage: 'local', env: { ORBIT_FILES_BACKEND: 'local' } }, localDir, scratch));

  const s3 = await startS3((fn) => t.after(fn));
  const bucket = await bucketConnections(s3.endpoint, (fn) => t.after(fn));
  await t.test('s3', storeCases({
    storage: 's3',
    bucket,
    env: {
      ORBIT_FILES_BACKEND: 's3',
      ORBIT_FILES_S3_ENDPOINT: bucket.endpoint,
      ORBIT_FILES_S3_BUCKET: s3.bucket,
      ORBIT_FILES_S3_ACCESS_KEY_ID: s3.accessKeyId,
      ORBIT_FILES_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      ORBIT_FILES_S3_REGION: s3.region,
    },
  }, path.join(scratch, 's3-files'), scratch));
});
