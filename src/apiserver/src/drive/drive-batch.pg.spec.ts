/**
 * What a directory sync sends less of (docs/drive-directory-sync-design.md, "Sending what is not there yet" and "Many
 * small files"), through the production apiserver over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-batch.pg.spec.ts
 *
 *   (1) `chunks/held` answers only content this account holds, of the size asked about: never another account's, and
 *       nothing that was never sent;
 *   (2) `batch` writes several files in one request from a staging bound to no entry: folders made, files created and
 *       overwritten (a version kept), modification times set; a replayed commitId is answered as the first;
 *   (3) each file is answered on its own: one naming content the account does not hold, or a path that is a folder,
 *       fails with its reason while the others land;
 *   (4) a batch can name content already in Drive with no staging at all (a renamed or copied file sends nothing);
 *   (5) another account's runner cannot name this account's staging.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';

import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** One chunk PUT: the raw bytes with their sha256. */
function putChunk(server: Apiserver, bearer: string, stagingId: string, idx: number, bytes: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: server.port, method: 'PUT', path: `/api/runner/drive/stagings/${stagingId}/chunks/${idx}`,
        headers: {
          authorization: `Bearer ${bearer}`, 'content-type': 'application/octet-stream',
          'content-length': String(bytes.length), 'x-orbit-chunk-sha256': sha256(bytes),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(bytes);
  });
}

function ok(reply: Reply, what: string): Reply {
  assert.ok(reply.status >= 200 && reply.status < 300, `${what}: ${reply.status} ${JSON.stringify(reply.json)}`);
  return reply;
}

test('Drive: held chunks and batched writes for a directory sync', { skip: !URL, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  try {
    await verifyCoordinatorPgIdentity(sql);
  } finally {
    await sql.end();
  }
  const db: PrismaClient = prismaClientFor(url);
  t.after(() => db.$disconnect().catch(() => undefined));

  const account = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@drive-batch.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const runnerOf = async (ownerId: string, name: string) => {
    const id = randomUUID();
    const token = `drive-batch-${randomUUID()}`;
    await db.runner.create({ data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token) } });
    return { id, token };
  };
  const alice = await account('batch-alice');
  const bob = await account('batch-bob');
  const aliceRunner = await runnerOf(alice, 'alice-laptop');
  const bobRunner = await runnerOf(bob, 'bob-laptop');

  const server = await startApiserver(url, `drive-batch-${RUN}`);
  t.after(() => server.stop());
  const as = (token: string, method: string, route: string, body?: unknown) => call(server, method, `/api/runner/drive${route}`, token, body);
  const held = async (token: string, chunks: Array<{ sha256: string; size: number }>) =>
    (ok(await as(token, 'POST', '/chunks/held', { chunks }), 'held').json as { held: string[] }).held;
  const stat = (token: string, path: string) => as(token, 'GET', `/stat?path=${encodeURIComponent(path)}`);
  const batchStaging = async (token: string) => toUuid((ok(await as(token, 'POST', '/stagings', {}), 'a batch staging').json as { id: string }).id);

  const a = Buffer.from(`alpha ${RUN}\n`);
  const b = Buffer.from(`beta ${RUN}\n`);
  const c = Buffer.from(`gamma ${RUN}\n`);
  const ref = (bytes: Buffer, idx = 0) => ({ idx, sha256: sha256(bytes), size: bytes.length });

  await t.test('(1) held answers only this account\'s own content, of the size asked', async () => {
    assert.deepEqual(await held(aliceRunner.token, [ref(a), ref(b)]), [], 'nothing sent yet');
    const staging = await batchStaging(aliceRunner.token);
    assert.equal(await putChunk(server, aliceRunner.token, staging, 0, a), 200);
    assert.deepEqual(await held(aliceRunner.token, [ref(a), ref(b)]), [sha256(a)]);
    assert.deepEqual(await held(aliceRunner.token, [{ sha256: sha256(a), size: a.length + 1 }]), [], 'another size is not the same content');
    assert.deepEqual(await held(bobRunner.token, [ref(a)]), [], "another account's content is never counted");
  });

  await t.test('(2) one batch makes folders, creates and overwrites files, and sets their times', async () => {
    const staging = await batchStaging(aliceRunner.token);
    assert.equal(await putChunk(server, aliceRunner.token, staging, 0, a), 200);
    assert.equal(await putChunk(server, aliceRunner.token, staging, 1, b), 200);
    const mtime = '2026-11-20T10:00:00.000Z';
    const first = ok(await as(aliceRunner.token, 'POST', '/batch', {
      stagingId: staging,
      items: [
        { path: '/Batch/a.txt', commitId: `b1-a-${RUN}`, chunks: [ref(a)], mtime },
        { path: '/Batch/sub/b.txt', commitId: `b1-b-${RUN}`, chunks: [ref(b)], mtime },
      ],
    }), 'the first batch').json as { results: Array<{ ok: boolean; sizeBytes: number; versionId: string }> };
    assert.deepEqual(first.results.map((r) => r.ok), [true, true]);
    const made = ok(await stat(aliceRunner.token, '/Batch/sub/b.txt'), 'b.txt').json as { sizeBytes: number; mtime: string };
    assert.equal(made.sizeBytes, b.length);
    assert.equal(new Date(made.mtime).toISOString(), mtime);

    // The same commitId again is answered as the first, writing nothing new.
    const replay = ok(await as(aliceRunner.token, 'POST', '/batch', {
      stagingId: staging, items: [{ path: '/Batch/a.txt', commitId: `b1-a-${RUN}`, chunks: [ref(a)], mtime }],
    }), 'a replay').json as { results: Array<{ ok: boolean; versionId: string }> };
    assert.equal(replay.results[0].versionId, first.results[0].versionId);

    // Overwriting a.txt with b's content keeps a version.
    const over = ok(await as(aliceRunner.token, 'POST', '/batch', {
      items: [{ path: '/Batch/a.txt', commitId: `b2-a-${RUN}`, chunks: [ref(b)] }],
    }), 'an overwrite').json as { results: Array<{ ok: boolean; newVersion: boolean; sizeBytes: number }> };
    assert.equal(over.results[0].ok, true);
    assert.equal(over.results[0].newVersion, true);
    assert.equal(over.results[0].sizeBytes, b.length);
  });

  await t.test('(3) each file is answered on its own', async () => {
    const answer = ok(await as(aliceRunner.token, 'POST', '/batch', {
      items: [
        { path: '/Batch/c.txt', commitId: `b3-c-${RUN}`, chunks: [ref(c)] },
        { path: '/Batch/sub', commitId: `b3-folder-${RUN}`, chunks: [ref(a)] },
        { path: '/Batch/copy-of-a.txt', commitId: `b3-copy-${RUN}`, chunks: [ref(a)] },
      ],
    }), 'a mixed batch').json as { results: Array<{ ok: boolean; status: number; code: string; idx: number | null }> };
    assert.equal(answer.results[0].ok, false);
    assert.equal(answer.results[0].code, 'DRIVE_CHUNK_NOT_HELD', 'content never sent');
    assert.equal(answer.results[0].idx, 0);
    assert.equal(answer.results[1].ok, false);
    assert.equal(answer.results[1].code, 'DRIVE_NOT_A_FILE', 'a folder is not overwritten');
    assert.equal(answer.results[2].ok, true, 'the others still land');
  });

  await t.test('(4) content already in Drive is named with no staging: a copy sends nothing', async () => {
    const answer = ok(await as(aliceRunner.token, 'POST', '/batch', {
      items: [{ path: '/Elsewhere/b-again.txt', commitId: `b4-${RUN}`, chunks: [ref(b)] }],
    }), 'a copy').json as { results: Array<{ ok: boolean; sizeBytes: number }> };
    assert.equal(answer.results[0].ok, true);
    assert.equal(answer.results[0].sizeBytes, b.length);
  });

  await t.test('(5) another account cannot name this account\'s staging', async () => {
    const staging = await batchStaging(aliceRunner.token);
    const reply = await as(bobRunner.token, 'POST', '/batch', {
      stagingId: staging, items: [{ path: '/x.txt', commitId: `b5-${RUN}`, chunks: [] }],
    });
    assert.equal(reply.status, 404);
    assert.equal((await stat(bobRunner.token, '/x.txt')).status, 404, 'nothing was written');
  });
});
