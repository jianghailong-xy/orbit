/**
 * The runner drive door (docs/drive-technical-design.md §4.2, §4.3, §4.6, §8.2; drive/runner-drive.controller.ts,
 * drive/drive-mount-credential.ts), through the production apiserver (`node build/main.js`, every guard and pipe) over a
 * real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/runner-drive.pg.spec.ts
 *
 *   (1) a self-registered runner's credential puts, gets, lists, moves and deletes by path, as the drive tools do: mkdir -p,
 *       create, a staging's chunks, commit, stat, list (a one-chunk file carries its sha256), manifest, a chunk's bytes
 *       whole and by Range, overwrite making a version, a retried commit applied once, rename, a rename onto a file
 *       keeping the target's id and making a version of it (§3.2), utimens, delete to Trash;
 *   (2) the door has no Trash and no share operation: no route of it names either, a Trash path is not a route, a deleted
 *       entry is reached by no path or id, and the share-link routes refuse a runner credential;
 *   (3) another account is answered as nothing: its entry by id, its chunk by sha256, its staging, its commit id, a
 *       commit naming its chunk, and its bytes in the usage the mount's df shows;
 *   (4) a mount credential: accepted only here and only from the instance the manager recorded; a superseded generation
 *       loses write access (the guard, and the commit fence in the commit's own transaction); issuing a newer
 *       generation's credential revokes the older one;
 *   (5) a mount's deletes 2 s apart or less are one Trash group, a later one another;
 *   (6) the door answers at /runner/drive and at its /runner/documents alias, which runners and mount daemons already
 *       deployed call: one class mounted under both, a file written through either read back through the other.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_POD_UID_HEADER,
  toUuid,
} from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { issueDriveMountCredential, fenceManagedInstance } from './drive-mount-credential';
import { DriveService } from './drive.service';
import { DriveEnabledGuard } from './drive-switch';
import { RunnerDriveController } from './runner-drive.controller';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** One request with a raw body, or none, answered with its raw bytes. */
function raw(
  server: Apiserver,
  method: string,
  route: string,
  bearer: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders; json: () => any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path: route,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body ? { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (part: Buffer) => parts.push(part));
        res.on('end', () => {
          const all = Buffer.concat(parts);
          resolve({ status: res.statusCode ?? 0, body: all, headers: res.headers, json: () => JSON.parse(all.toString('utf8')) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const ok = (reply: Reply, what: string): Reply => {
  assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text}`);
  return reply;
};
const refused = (reply: Reply, status: number, code: string, what: string) => {
  assert.equal(reply.status, status, `${what}: ${reply.text}`);
  assert.equal(reply.json?.code, code, `${what}: ${reply.text}`);
};

test('Documents drive: the runner drive door — drive tools by path, no Trash or share, tenants, the mount credential', {
  skip: !URL, concurrency: 1, timeout: 600_000,
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
  const db: PrismaClient = prismaClientFor(url);
  t.after(() => db.$disconnect().catch(() => undefined));
  const filesDir = mkdtempSync(path.join(tmpdir(), 'runner-drive-files-'));
  t.after(() => rmSync(filesDir, { recursive: true, force: true }));

  const account = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@runner-drive.invalid`, name, passwordHash: 'x' } });
    return id;
  };
  const runnerOf = async (ownerId: string, name: string) => {
    const id = randomUUID();
    const token = `runner-drive-${randomUUID()}`;
    await db.runner.create({ data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(Buffer.from(token)) } });
    return { id, token };
  };
  const alice = await account('drive-alice');
  const bob = await account('drive-bob');
  const aliceRunner = await runnerOf(alice, 'alice-laptop');
  const bobRunner = await runnerOf(bob, 'bob-laptop');

  const server = await startApiserver(url, `runner-drive-${RUN}`, { ORBIT_DRIVE_DIR: filesDir });
  t.after(() => server.stop());
  /** A door request under `prefix`: /runner/drive, or the /runner/documents alias deployed runners call. */
  const at = (prefix: string) => (token: string, method: string, route: string, body?: unknown, headers: Record<string, string> = {}) =>
    call(server, method, `/api/${prefix}${route}`, token, body, headers);
  const as = at('runner/drive');
  const q = encodeURIComponent;

  /** What `documents_put` does: mkdir -p of the folder, create or overwrite, one staging, its chunks, one commit. */
  const put = async (
    token: string, drivePath: string, bytes: Buffer, commitId = randomUUID(), headers: Record<string, string> = {}, prefix = 'runner/drive',
  ) => {
    const as = at(prefix);
    const folder = drivePath.slice(0, drivePath.lastIndexOf('/')) || '/';
    if (folder !== '/') ok(await as(token, 'POST', '/mkdir', { path: folder, parents: true }, headers), `mkdir -p ${folder}`);
    const seen = await as(token, 'GET', `/stat?path=${q(drivePath)}`, undefined, headers);
    const handleId = randomUUID();
    let entry;
    let mode: 'CONTINUE' | 'OVERWRITE';
    if (seen.status === 404) {
      entry = ok(await as(token, 'POST', '/create', { path: drivePath, handleId }, headers), `create ${drivePath}`).json;
      mode = 'CONTINUE';
    } else {
      entry = ok(seen, `stat ${drivePath}`).json;
      mode = 'OVERWRITE';
    }
    const staging = ok(await as(token, 'POST', '/stagings', { entryId: entry.id }, headers), 'open a staging').json;
    const chunk = await raw(server, 'PUT', `/api/${prefix}/stagings/${staging.id}/chunks/0`, token, bytes, {
      'x-orbit-chunk-sha256': sha256(bytes), ...headers,
    });
    assert.equal(chunk.status, 200, chunk.body.toString());
    const body = {
      commitId, entryId: entry.id, handleId, mode, baseVersionId: entry.currentVersionId, stagingId: staging.id,
      chunks: [{ idx: 0, sha256: sha256(bytes), size: bytes.length }],
    };
    return { entry, body, reply: await as(token, 'POST', '/commit', body, headers) };
  };

  await t.test('(1) a runner credential puts, gets, lists, moves and deletes by path', async () => {
    const first = Buffer.from(`# Report ${RUN}\nfirst\n`);
    const written = await put(aliceRunner.token, '/Proj/sub/r.md', first);
    const commit = ok(written.reply, 'the first commit').json;
    assert.equal(commit.newVersion, false, 'the first commit fills the empty first version');
    assert.equal(commit.sizeBytes, first.length);

    const stat = ok(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Proj/sub/r.md')}`), 'stat').json;
    assert.equal(stat.path, '/Proj/sub/r.md');
    assert.equal(stat.kind, 'FILE');
    assert.equal(stat.sizeBytes, first.length);
    assert.equal(commit.mtime, stat.mtime, 'the commit returns the stored entry mtime');
    assert.equal(stat.lastWriter.kind, 'AGENT');
    assert.equal(toUuid(stat.lastWriter.runnerId), aliceRunner.id);
    assert.equal(ok(await as(aliceRunner.token, 'GET', `/stat?path=${q('Proj/sub/r.md')}`), 'stat without the slash').json.id, stat.id);

    const listing = ok(await as(aliceRunner.token, 'GET', `/list?path=${q('/Proj/sub')}`), 'list').json;
    assert.deepEqual(listing.entries.map((e: { name: string }) => e.name), ['r.md']);
    assert.equal(listing.entries[0].sha256, sha256(first), 'a one-chunk file carries its chunk');
    assert.equal(listing.entries[0].path, '/Proj/sub/r.md', 'a listed entry carries its path');
    assert.equal(listing.folder.path, '/Proj/sub');
    assert.deepEqual(
      ok(await as(aliceRunner.token, 'GET', '/list'), 'the root').json.entries.map((e: { name: string }) => e.name),
      ['Proj'],
    );

    // get: the manifest, then each chunk, whole and by Range.
    const manifest = ok(await as(aliceRunner.token, 'GET', `/manifest?path=${q('/Proj/sub/r.md')}`), 'manifest').json;
    assert.deepEqual(manifest.chunks, [{ idx: 0, offset: 0, size: first.length, sha256: sha256(first) }]);
    const whole = await raw(server, 'GET', `/api/runner/drive/chunks/${sha256(first)}`, aliceRunner.token);
    assert.equal(whole.status, 200);
    assert.deepEqual(whole.body, first);
    const part = await raw(server, 'GET', `/api/runner/drive/chunks/${sha256(first)}`, aliceRunner.token, undefined, { range: 'bytes=2-7' });
    assert.equal(part.status, 206);
    assert.deepEqual(part.body, first.subarray(2, 8));
    assert.equal(part.headers['content-range'], `bytes 2-7/${first.length}`);

    // An overwrite makes a version, and the replaced one goes to the owner's Trash; a retried commit is applied once.
    const second = Buffer.from(`# Report ${RUN}\nsecond\n`);
    const over = await put(aliceRunner.token, '/Proj/sub/r.md', second);
    const overwritten = ok(over.reply, 'the overwrite').json;
    assert.equal(overwritten.newVersion, true);
    assert.equal(toUuid(overwritten.replacedVersionId), toUuid(stat.currentVersionId));
    const again = ok(await as(aliceRunner.token, 'POST', '/commit', over.body), 'the same commit again').json;
    assert.equal(again.replayed, true);
    assert.equal(again.versionId, overwritten.versionId);
    assert.equal(again.mtime, overwritten.mtime);
    assert.equal(await db.driveVersion.count({ where: { entryId: toUuid(stat.id) } }), 2, 'two versions, not three');
    const status = ok(await as(aliceRunner.token, 'GET', `/commits/${q(over.body.commitId)}`), 'commit status').json;
    assert.equal(status.applied, true);
    assert.equal(status.result.mtime, overwritten.mtime);
    assert.equal(ok(await as(aliceRunner.token, 'GET', `/commits/${randomUUID()}`), 'an unknown commit').json.applied, false);
    const now = await raw(server, 'GET', `/api/runner/drive/chunks/${sha256(second)}`, aliceRunner.token);
    assert.deepEqual(now.body, second);

    // move, utimens, delete.
    const moved = ok(await as(aliceRunner.token, 'POST', '/rename', { from: '/Proj/sub/r.md', to: '/Proj/r2.md' }), 'move').json;
    assert.equal(moved.id, stat.id, 'a move keeps the entry');
    assert.equal(moved.path, '/Proj/r2.md');
    refused(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Proj/sub/r.md')}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'the old path');
    const touched = ok(await as(aliceRunner.token, 'POST', '/utimens', { path: '/Proj/r2.md', mtime: '2020-01-02T03:04:05.000Z' }), 'utimens').json;
    assert.equal(new Date(touched.mtime).toISOString(), '2020-01-02T03:04:05.000Z');

    const other = await put(aliceRunner.token, '/Proj/other.md', Buffer.from('other'));
    ok(other.reply, 'another file');
    // A move onto a file (§3.2, a write-then-os.replace save): the target keeps its id and takes the source's content as
    // a new version, its previous one going to Trash as a version; the source is gone, not in Trash.
    const r2Was = (await db.driveEntry.findUniqueOrThrow({ where: { id: toUuid(stat.id) } })).currentVersionId!;
    const onto = ok(await as(aliceRunner.token, 'POST', '/rename', { from: '/Proj/other.md', to: '/Proj/r2.md' }), 'a move onto a file').json;
    assert.equal(onto.path, '/Proj/r2.md');
    assert.equal(onto.id, stat.id, 'the target keeps its entry id');
    const ontoManifest = ok(await as(aliceRunner.token, 'GET', `/manifest?id=${stat.id}`), 'the manifest after the move').json;
    assert.deepEqual(ontoManifest.chunks.map((c: { sha256: string }) => c.sha256), [sha256(Buffer.from('other'))], "the source's content");
    const r2Previous = await db.driveVersion.findUniqueOrThrow({ where: { id: r2Was } });
    assert.equal(r2Previous.entryId, toUuid(stat.id));
    assert.equal((await db.driveTrashGroup.findUniqueOrThrow({ where: { id: r2Previous.trashGroupId! } })).kind, 'VERSION', 'the previous version is in Trash');
    refused(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Proj/other.md')}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'the source by path');
    refused(await as(aliceRunner.token, 'GET', `/stat?id=${other.entry.id}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'the source by id');
    assert.equal(await db.driveEntry.count({ where: { ownerId: alice, name: 'other.md' } }), 0, 'and not in Trash');
    // A handle still bound to the source opens a staging and commits: a new file in Trash named after it.
    const lateBytes = Buffer.from('written after the move');
    const lateStaging = ok(await as(aliceRunner.token, 'POST', '/stagings', { entryId: other.entry.id }), 'a staging for the removed source').json;
    const lateChunk = await raw(server, 'PUT', `/api/runner/drive/stagings/${lateStaging.id}/chunks/0`, aliceRunner.token, lateBytes, {
      'x-orbit-chunk-sha256': sha256(lateBytes),
    });
    assert.equal(lateChunk.status, 200, lateChunk.body.toString());
    const late = ok(await as(aliceRunner.token, 'POST', '/commit', {
      commitId: randomUUID(), entryId: other.entry.id, handleId: randomUUID(), mode: 'OVERWRITE', baseVersionId: other.body.baseVersionId,
      stagingId: lateStaging.id, chunks: [{ idx: 0, sha256: sha256(lateBytes), size: lateBytes.length }],
    }), 'a commit for the removed source').json;
    const lateRow = await db.driveEntry.findUniqueOrThrow({ where: { id: toUuid(late.entryId) } });
    assert.equal(lateRow.name, 'other.md');
    assert.notEqual(lateRow.trashedAt, null, 'in the owner\'s Trash');
    assert.equal(ok(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Proj/r2.md')}`), 'r2.md after').json.id, stat.id, 'r2.md untouched by it');
    refused(
      await as(aliceRunner.token, 'POST', '/rename', { from: '/Proj/r2.md', to: '/Proj/sub', noReplace: true }),
      409, 'DRIVE_NAME_TAKEN', 'noReplace onto a taken name',
    );

    const gone = ok(await as(aliceRunner.token, 'POST', '/delete', { path: '/Proj/r2.md' }), 'delete').json;
    assert.equal(gone.deleted, true);
    assert.equal('trashGroupId' in gone, false, 'no Trash group is named to an agent');
    const row = await db.driveEntry.findUniqueOrThrow({ where: { id: toUuid(gone.id) } });
    assert.ok(row.trashedAt, 'in the owner\'s Trash');
    refused(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Proj/r2.md')}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'a deleted path');
    refused(await as(aliceRunner.token, 'GET', `/stat?id=${gone.id}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'a deleted id');
    // The owner can still restore it: it is in Trash, not gone.
    await new DriveService(db as never).restoreGroup(alice, row.trashGroupId!);
    ok(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Proj/r2.md')}`), 'restored by the owner');
  });

  await t.test('(2) no Trash and no share operation', async () => {
    const proto = RunnerDriveController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto)
      .filter((name) => typeof proto[name] === 'function' && Reflect.getMetadata(METHOD_METADATA, proto[name] as object) !== undefined)
      .map((name) => String(Reflect.getMetadata(PATH_METADATA, proto[name] as object)));
    assert.ok(routes.length >= 15, `the door's routes: ${routes.join(', ')}`);
    for (const route of routes) assert.doesNotMatch(route, /trash|share|restore|purge/i, route);
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, RunnerDriveController), [RunnerAuthGuard, DriveEnabledGuard]);

    for (const [method, route] of [['GET', '/trash'], ['POST', '/trash/restore'], ['POST', '/share'], ['POST', '/share-links']]) {
      const reply = await as(aliceRunner.token, method, route, {});
      assert.equal(reply.status, 404, `${method} ${route}: ${reply.text}`);
      assert.match(reply.text, /Cannot (GET|POST)/, 'not a route at all');
    }
    const share = await call(server, 'POST', `/api/sessions/${randomUUID()}/share`, aliceRunner.token, {});
    assert.equal(share.status, 401, `a runner credential creates no share link: ${share.text}`);
  });

  await t.test('(3) another account is answered as nothing', async () => {
    const secret = Buffer.from(`alice's ${RUN} secret`);
    const written = await put(aliceRunner.token, '/Private/secret.txt', secret);
    ok(written.reply, 'alice writes');
    const entryId = written.entry.id;

    // What the mount's df shows as used: this account's live files, never another's.
    const live = await db.driveEntry.aggregate({ where: { ownerId: alice, kind: 'FILE', trashedAt: null }, _sum: { sizeBytes: true } });
    assert.equal(ok(await as(aliceRunner.token, 'GET', '/usage'), 'alice\'s usage').json.driveBytes, Number(live._sum.sizeBytes ?? 0));
    assert.equal(ok(await as(bobRunner.token, 'GET', '/usage'), 'bob\'s usage').json.driveBytes, 0, 'alice\'s bytes are not bob\'s');

    const unknown = await as(bobRunner.token, 'GET', `/stat?id=${randomUUID()}`);
    refused(unknown, 404, 'DRIVE_ENTRY_NOT_FOUND', 'an id that names nothing');
    const theirs = await as(bobRunner.token, 'GET', `/stat?id=${entryId}`);
    assert.deepEqual({ status: theirs.status, json: theirs.json }, { status: unknown.status, json: unknown.json }, 'alice\'s entry by id');
    refused(await as(bobRunner.token, 'GET', `/stat?path=${q('/Private/secret.txt')}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'the same path is bob\'s own');
    refused(await as(bobRunner.token, 'GET', `/manifest?id=${entryId}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'alice\'s manifest');

    const chunk = await raw(server, 'GET', `/api/runner/drive/chunks/${sha256(secret)}`, bobRunner.token);
    assert.equal(chunk.status, 404, 'alice\'s chunk, by its sha256');
    assert.equal(chunk.json().code, 'DRIVE_CHUNK_NOT_FOUND');

    const stagingOfAlice = ok(await as(aliceRunner.token, 'POST', '/stagings', { entryId }), 'alice opens a staging').json;
    const intoTheirs = await raw(server, 'PUT', `/api/runner/drive/stagings/${stagingOfAlice.id}/chunks/0`, bobRunner.token, Buffer.from('x'), {
      'x-orbit-chunk-sha256': sha256(Buffer.from('x')),
    });
    assert.equal(intoTheirs.status, 404);
    assert.equal(intoTheirs.json().code, 'DRIVE_STAGING_NOT_FOUND');
    refused(await as(bobRunner.token, 'POST', `/stagings/${stagingOfAlice.id}/keepalive`, { dirty: true }), 404, 'DRIVE_STAGING_NOT_FOUND', 'keepalive');
    refused(await as(bobRunner.token, 'POST', '/stagings', { entryId }), 404, 'DRIVE_ENTRY_NOT_FOUND', 'a staging on alice\'s entry');
    assert.equal((await as(bobRunner.token, 'GET', `/commits/${q(written.body.commitId)}`)).json.applied, false, 'alice\'s commit id');

    // Bob's own file, committed naming alice's chunk: refused, as content addressing is not authorisation.
    const bobs = ok(await as(bobRunner.token, 'POST', '/create', { path: '/mine.txt', handleId: randomUUID() }), 'bob creates').json;
    refused(
      await as(bobRunner.token, 'POST', '/commit', {
        commitId: randomUUID(), entryId: bobs.id, mode: 'OVERWRITE', chunks: [{ idx: 0, sha256: sha256(secret), size: secret.length }],
      }),
      409, 'DRIVE_CHUNK_NOT_HELD', 'a commit naming alice\'s chunk',
    );
    refused(await as(bobRunner.token, 'POST', '/delete', { id: entryId }), 404, 'DRIVE_ENTRY_NOT_FOUND', 'deleting alice\'s entry');
    refused(await as(bobRunner.token, 'POST', '/rename', { id: entryId, to: '/stolen.txt' }), 404, 'DRIVE_ENTRY_NOT_FOUND', 'moving it');
    const still = await db.driveEntry.findUniqueOrThrow({ where: { id: toUuid(entryId) } });
    assert.equal(still.trashedAt, null);
    assert.equal(still.name, 'secret.txt');
  });

  await t.test('(4) a mount credential: the drive door only, its instance only, and a superseded generation loses write access', async () => {
    const managed = await runnerOf(alice, 'alice-cloud');
    const podUid = randomUUID();
    const mapping = await db.managedRunner.create({
      data: {
        ownerId: alice, runnerId: managed.id, clusterKey: 'runner-drive-spec', namespace: 'orbit', pvcName: `mr-data-${managed.id}`,
        desiredState: 'SLEEPING', managementState: 'SLEEPING', generation: 1, podUid,
      },
    });
    const instance = (generation: number, pod: string = podUid) => ({
      'x-orbit-runner-capabilities': MANAGED_RUNNER_INSTANCE_CAPABILITY,
      [MANAGED_RUNNER_GENERATION_HEADER]: String(generation),
      [MANAGED_RUNNER_POD_UID_HEADER]: pod,
    });
    const first = await issueDriveMountCredential(db as never, { ownerId: alice, runnerId: managed.id, generation: 1 });
    const stored = await db.driveMountCredential.findUniqueOrThrow({ where: { id: first.id } });
    assert.notEqual(stored.tokenHash, first.token, 'only its hash is kept');

    const stat = await as(first.token, 'GET', `/stat?path=${q('/Proj')}`, undefined, instance(1));
    assert.equal(ok(stat, 'the mount reads alice\'s drive').json.path, '/Proj');
    const written = await put(first.token, '/Cloud/a.txt', Buffer.from('from the mount'), randomUUID(), instance(1));
    ok(written.reply, 'the mount writes');
    const staging = await db.driveStaging.findFirstOrThrow({ where: { entryId: toUuid(written.entry.id) } });
    assert.equal(staging.source, 'MOUNT');
    assert.equal(staging.generation, 1);

    const elsewhere = await call(server, 'GET', '/api/runner/files', first.token, undefined, instance(1));
    refused(elsewhere, 401, 'DRIVE_MOUNT_CREDENTIAL_OUTSIDE_DRIVE', 'another runner route');
    refused(await as(first.token, 'GET', '/list', undefined, {}), 403, 'MANAGED_RUNNER_INSTANCE_REQUIRED', 'no instance named');
    refused(await as(first.token, 'GET', '/list', undefined, instance(1, randomUUID())), 403, 'MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED', 'another Pod');
    refused(await as(first.token, 'GET', '/list', undefined, instance(2)), 403, 'MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED', 'another generation');

    // A commit that passed the guard while the generation moves on: its own transaction refuses it, and writes nothing.
    const pending = await put(first.token, '/Cloud/a.txt', Buffer.from('racing the generation'), randomUUID(), instance(1));
    assert.equal(pending.reply.status, 200);
    const versionsBefore = await db.driveVersion.count({ where: { entryId: toUuid(written.entry.id) } });
    await db.managedRunner.update({ where: { id: mapping.id }, data: { generation: 2, podUid: randomUUID() } });
    const drive = new DriveService(db as never);
    await assert.rejects(
      drive.commit(alice, {
        ...pending.body, commitId: randomUUID(), entryId: toUuid(pending.body.entryId), baseVersionId: null, stagingId: null, mode: 'OVERWRITE',
        writer: { kind: 'AGENT', runnerId: managed.id },
      }, { fence: (tx) => fenceManagedInstance(tx, { mappingId: mapping.id, generation: 1, podUid }) }),
      (error) => error instanceof HttpException && error.getStatus() === 403
        && (error.getResponse() as { code: string }).code === 'MANAGED_RUNNER_INSTANCE_SUPERSEDED',
    );
    assert.equal(await db.driveVersion.count({ where: { entryId: toUuid(written.entry.id) } }), versionsBefore, 'nothing committed');

    // At the door: the superseded generation is refused every write and read.
    for (const [method, route, body] of [
      ['POST', '/commit', { ...pending.body, commitId: randomUUID() }],
      ['POST', '/create', { path: '/Cloud/late.txt' }],
      ['POST', '/delete', { path: '/Cloud/a.txt' }],
      ['GET', '/list', undefined],
    ] as const) {
      refused(await as(first.token, method, route, body, instance(1)), 403, 'MANAGED_RUNNER_INSTANCE_SUPERSEDED', `${method} ${route}`);
    }
    const second = await issueDriveMountCredential(db as never, { ownerId: alice, runnerId: managed.id, generation: 2 });
    const newPod = (await db.managedRunner.findUniqueOrThrow({ where: { id: mapping.id } })).podUid!;
    refused(await as(first.token, 'GET', '/list', undefined, instance(1)), 401, 'DRIVE_MOUNT_CREDENTIAL_REFUSED', 'revoked by the next generation');
    ok(await as(second.token, 'GET', `/stat?path=${q('/Cloud/a.txt')}`, undefined, instance(2, newPod)), 'the new generation reads');
    await db.managedRunner.update({ where: { id: mapping.id }, data: { managementState: 'FENCING' } });
    refused(await as(second.token, 'GET', '/list', undefined, instance(2, newPod)), 403, 'MANAGED_RUNNER_INSTANCE_FENCED', 'a fenced mapping');
    await db.managedRunner.update({ where: { id: mapping.id }, data: { managementState: 'SLEEPING' } });

    // (5) A mount's deletes 2 s apart or less are one Trash group; one after a longer pause is another.
    const mounted = instance(2, newPod);
    for (const name of ['x1', 'x2', 'x3', 'y1']) {
      ok((await put(second.token, `/Burst/${name}.txt`, Buffer.from(name), randomUUID(), mounted)).reply, `write ${name}`);
    }
    const deleteOf = async (name: string) => {
      const gone = ok(await as(second.token, 'POST', '/delete', { path: `/Burst/${name}.txt` }, mounted), `delete ${name}`).json;
      return (await db.driveEntry.findUniqueOrThrow({ where: { id: toUuid(gone.id) } })).trashGroupId;
    };
    const g1 = await deleteOf('x1');
    const g2 = await deleteOf('x2');
    const g3 = await deleteOf('x3');
    assert.equal(g2, g1, 'one burst');
    assert.equal(g3, g1, 'one burst');
    await sleep(2_300);
    const g4 = await deleteOf('y1');
    assert.notEqual(g4, g1, 'a pause of more than 2 s starts another group');
    const group = await db.driveTrashGroup.findUniqueOrThrow({ where: { id: g1! } });
    assert.equal(group.itemCount, 3);
    assert.equal(group.actorKind, 'AGENT');
    assert.equal(group.actorRunnerId, managed.id);
    // A runner credential's tool delete is a group of its own, as the owner's is.
    ok((await put(aliceRunner.token, '/Burst/t1.txt', Buffer.from('t1'))).reply, 't1');
    ok((await put(aliceRunner.token, '/Burst/t2.txt', Buffer.from('t2'))).reply, 't2');
    const t1 = ok(await as(aliceRunner.token, 'POST', '/delete', { path: '/Burst/t1.txt' }), 'tool delete').json;
    const t2 = ok(await as(aliceRunner.token, 'POST', '/delete', { path: '/Burst/t2.txt' }), 'tool delete').json;
    const [r1, r2] = await Promise.all([t1, t2].map((g) => db.driveEntry.findUniqueOrThrow({ where: { id: toUuid(g.id) } })));
    assert.notEqual(r1.trashGroupId, r2.trashGroupId);
  });

  await t.test('(6) /runner/drive and its /runner/documents alias answer the same handlers', async () => {
    assert.deepEqual(Reflect.getMetadata(PATH_METADATA, RunnerDriveController), ['runner/drive', 'runner/documents']);
    const documents = at('runner/documents');

    // A runner already deployed writes through /runner/documents; the new runner reads it at /runner/drive.
    const old = Buffer.from(`written by an older runner ${RUN}`);
    const viaAlias = await put(aliceRunner.token, '/Alias/old.txt', old, randomUUID(), {}, 'runner/documents');
    const committed = ok(viaAlias.reply, 'a commit through /runner/documents').json;
    const stat = ok(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Alias/old.txt')}`), 'stat at /runner/drive').json;
    assert.equal(stat.id, committed.entryId);
    assert.equal(stat.sizeBytes, old.length);
    const bytes = await raw(server, 'GET', `/api/runner/drive/chunks/${sha256(old)}`, aliceRunner.token);
    assert.deepEqual(bytes.body, old, 'its bytes at /runner/drive');

    // And the other way round: written at /runner/drive, listed, moved and deleted through /runner/documents.
    ok((await put(aliceRunner.token, '/Alias/new.txt', Buffer.from('new'))).reply, 'a commit at /runner/drive');
    const listed = ok(await documents(aliceRunner.token, 'GET', `/list?path=${q('/Alias')}`), 'list through /runner/documents').json;
    assert.deepEqual(listed.entries.map((e: { name: string }) => e.name).sort(), ['new.txt', 'old.txt']);
    const chunk = await raw(server, 'GET', `/api/runner/documents/chunks/${sha256(Buffer.from('new'))}`, aliceRunner.token);
    assert.equal(chunk.body.toString(), 'new', 'its bytes through /runner/documents');
    ok(await documents(aliceRunner.token, 'POST', '/rename', { from: '/Alias/new.txt', to: '/Alias/moved.txt' }), 'rename through /runner/documents');
    ok(await documents(aliceRunner.token, 'POST', '/delete', { path: '/Alias/moved.txt' }), 'delete through /runner/documents');
    refused(await as(aliceRunner.token, 'GET', `/stat?path=${q('/Alias/moved.txt')}`), 404, 'DRIVE_ENTRY_NOT_FOUND', 'deleted through the alias');

    // The alias holds the same rules: another account's entry is nothing there either.
    const theirs = await documents(bobRunner.token, 'GET', `/stat?path=${q('/Alias/old.txt')}`);
    assert.equal(theirs.status, 404, `bob through /runner/documents: ${theirs.text}`);
    for (const [method, route] of [['GET', '/trash'], ['POST', '/share']]) {
      const reply = await documents(aliceRunner.token, method, route, {});
      assert.equal(reply.status, 404, `${method} /runner/documents${route}: ${reply.text}`);
    }
  });
});
