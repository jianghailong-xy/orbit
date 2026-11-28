/**
 * An agent's directory sync as the upload tray shows it (docs/drive-directory-sync-design.md S4;
 * drive/drive-syncs.service.ts, drive/runner-drive-syncs.controller.ts), through the production apiserver over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/drive/drive-syncs.pg.spec.ts
 *
 *   (1) a runner opens a sync, reports into it and ends it; the owner's list reads each step, with the session's title;
 *   (2) only the runner that opened a sync reports into it: another runner of the same account and another account's
 *       runner are answered 404, and an ended sync 409, each writing nothing;
 *   (3) the owner's list and read by id: another account's syncs never, a session of another account by no title, a running sync with
 *       no report for two minutes as STOPPED, a sync ended over a day ago not at all (and pruned by the next open);
 *   (4) the body: a source name with a slash, an unknown status and more than 100 failed paths are refused;
 *   (5) a sync that ended with failures is kept and listed past the day until it is handled: by the owner's
 *       POST /drive/syncs/:id/handled (idempotent, another account's sync not found), or by a later clean sync of the same
 *       source into the same destination; a handled one and a clean one age out as before.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { DRIVE_SYNC_KEEP_MS, DRIVE_SYNC_STALE_MS, DriveSyncsService } from './drive-syncs.service';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function ok(reply: Reply, what: string): Reply {
  assert.ok(reply.status >= 200 && reply.status < 300, `${what}: ${reply.status} ${JSON.stringify(reply.json)}`);
  return reply;
}

test('Documents: an agent directory sync reported for the upload tray', { skip: !URL, concurrency: 1, timeout: 300_000 }, async (t) => {
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
  const syncs = new DriveSyncsService(db as never);

  const emailOf = (name: string) => `${name}-${RUN}@drive-syncs.invalid`;
  const passwordOf = (name: string) => `pw-${name}-${RUN}`;
  const account = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: emailOf(name), name, passwordHash: hashPassword(passwordOf(name)) } });
    return id;
  };
  const runnerOf = async (ownerId: string, name: string) => {
    const id = randomUUID();
    const token = `drive-syncs-${randomUUID()}`;
    await db.runner.create({ data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token) } });
    return { id, token };
  };
  const sessionOf = async (ownerId: string, runnerId: string, title: string) => {
    const workspace = await db.workspace.create({ data: { ownerId, runnerId, name: `${title}-${RUN}`, enabled: true } });
    return (await db.session.create({
      data: { ownerId, creatorId: ownerId, workspaceId: workspace.id, assignedRunnerId: runnerId, title, prompt: 'sync', provider: 'claude' },
    })).id;
  };
  const alice = await account('sync-alice');
  const bob = await account('sync-bob');
  const aliceRunner = await runnerOf(alice, 'alice-laptop');
  const aliceOther = await runnerOf(alice, 'alice-desktop');
  const bobRunner = await runnerOf(bob, 'bob-laptop');
  const aliceSession = await sessionOf(alice, aliceRunner.id, 'Weekly report');
  const bobSession = await sessionOf(bob, bobRunner.id, 'Bob private work');

  const server = await startApiserver(url, `drive-syncs-${RUN}`);
  t.after(() => server.stop());
  const as = (token: string, method: string, route: string, body?: unknown) => call(server, method, `/api/runner/documents/syncs${route}`, token, body);
  const listed = async (ownerId: string, id: string) => (await syncs.list(ownerId)).syncs.find((sync) => sync.id === id);
  /** A sync's id as the database keys it: the door answers the base62 public id. */
  const opened = (reply: Reply, what: string): string => toUuid(ok(reply, what).json.id as string);

  await t.test('(1) open, report, end: the owner reads each step', async () => {
    const id = opened(await as(aliceRunner.token, 'POST', '', { sourceName: 'out', destPath: '/Reports/out', sessionId: aliceSession }), 'open');
    let view = await listed(alice, id);
    assert.equal(view?.status, 'CHECKING');
    assert.deepEqual(view?.session, { id: aliceSession, title: 'Weekly report', open: true });
    assert.equal(view?.sourceName, 'out');

    ok(await as(aliceRunner.token, 'PATCH', `/${id}`, {
      status: 'UPLOADING', filesSeen: 42, filesTotal: 12, filesSame: 30, filesDone: 3, bytesTotal: 900, bytesSent: 90, currentPath: 'charts/q3.png',
    }), 'report');
    view = await listed(alice, id);
    assert.equal(view?.status, 'UPLOADING');
    assert.equal(view?.filesDone, 3);
    assert.equal(view?.bytesSent, 90);
    assert.equal(view?.currentPath, 'charts/q3.png');
    assert.equal(view?.endedAt, null);

    ok(await as(aliceRunner.token, 'PATCH', `/${id}`, {
      status: 'DONE', filesDone: 11, bytesSent: 880, failed: [{ path: 'raw/export.zip', error: 'Changed while uploading.' }], failedCount: 1,
    }), 'end');
    view = await listed(alice, id);
    assert.equal(view?.status, 'DONE');
    assert.equal(view?.currentPath, null);
    assert.ok(view?.endedAt);
    assert.equal(view?.failedCount, 1);
    assert.deepEqual(view?.failed, [{ path: 'raw/export.zip', error: 'Changed while uploading.' }]);
  });

  await t.test('(2) only the runner that opened it reports into it, and never after it ended', async () => {
    const id = opened(await as(aliceRunner.token, 'POST', '', { sourceName: 'data', destPath: '/Datasets' }), 'open');
    for (const [who, token] of [['another runner of the account', aliceOther.token], ['another account', bobRunner.token]] as const) {
      const reply = await as(token, 'PATCH', `/${id}`, { status: 'UPLOADING', filesDone: 99 });
      assert.equal(reply.status, 404, `${who}: ${JSON.stringify(reply.json)}`);
    }
    assert.equal((await listed(alice, id))?.filesDone, 0, 'a refused report writes nothing');
    ok(await as(aliceRunner.token, 'PATCH', `/${id}`, { status: 'STOPPED' }), 'stop');
    const late = await as(aliceRunner.token, 'PATCH', `/${id}`, { status: 'UPLOADING', filesDone: 5 });
    assert.equal(late.status, 409);
    assert.equal((late.json as { code: string }).code, 'DOCUMENTS_SYNC_ENDED');
    assert.equal((await listed(alice, id))?.status, 'STOPPED');
  });

  await t.test('(3) the owner list: own syncs only, own sessions only, stale reads STOPPED, a day-old end is gone', async () => {
    const bobs = opened(await as(bobRunner.token, 'POST', '', { sourceName: 'secret', destPath: '/Private' }), 'bob opens');
    assert.equal(await listed(alice, bobs), undefined);
    // Read by id, as the conversation's card does: the owner's own, and another account's as not found.
    assert.equal((await syncs.get(bob, bobs)).sourceName, 'secret');
    await assert.rejects(syncs.get(alice, bobs), (error: { getStatus?: () => number }) => error.getStatus?.() === 404);
    const foreign = opened(await as(aliceRunner.token, 'POST', '', { sourceName: 'x', destPath: '/X', sessionId: bobSession }), 'open');
    assert.equal((await listed(alice, foreign))?.session, null, "another account's session is neither kept nor named");

    const stale = opened(await as(aliceRunner.token, 'POST', '', { sourceName: 'old', destPath: '/Old' }), 'open');
    await db.driveSync.update({ where: { id: stale }, data: { updatedAt: new Date(Date.now() - DRIVE_SYNC_STALE_MS - 1_000), currentPath: 'a.txt' } });
    const staleView = await listed(alice, stale);
    assert.equal(staleView?.status, 'STOPPED');
    assert.equal(staleView?.currentPath, null);
    assert.ok(staleView?.endedAt);

    const dayOld = opened(await as(aliceRunner.token, 'POST', '', { sourceName: 'ancient', destPath: '/Ancient' }), 'open');
    const longAgo = new Date(Date.now() - DRIVE_SYNC_KEEP_MS - 60_000);
    await db.driveSync.update({ where: { id: dayOld }, data: { status: 'DONE', endedAt: longAgo, updatedAt: longAgo } });
    assert.equal(await listed(alice, dayOld), undefined, 'not listed');
    ok(await as(aliceRunner.token, 'POST', '', { sourceName: 'next', destPath: '/Next' }), 'the next open prunes it');
    assert.equal(await db.driveSync.count({ where: { id: dayOld } }), 0);
    assert.equal(await db.driveSync.count({ where: { id: bobs } }), 1, "another account's rows are not pruned");
  });

  await t.test('(4) the body is held to its shape', async () => {
    assert.equal((await as(aliceRunner.token, 'POST', '', { sourceName: 'home/me/out', destPath: '/R' })).status, 400);
    const id = opened(await as(aliceRunner.token, 'POST', '', { sourceName: 'out', destPath: '/R' }), 'open');
    assert.equal((await as(aliceRunner.token, 'PATCH', `/${id}`, { status: 'PAUSED' })).status, 400);
    const failed = Array.from({ length: 101 }, (_, i) => ({ path: `f${i}`, error: 'x' }));
    assert.equal((await as(aliceRunner.token, 'PATCH', `/${id}`, { status: 'DONE', failed })).status, 400);
  });

  await t.test('(5) a failed sync stays until it is handled; a handled one and a clean one age out', async () => {
    const signIn = async (name: string): Promise<string> => {
      const reply = ok(await call(server, 'POST', '/api/auth/login', undefined, { email: emailOf(name), password: passwordOf(name) }), `${name} signs in`);
      return reply.json.accessToken as string;
    };
    const aliceToken = await signIn('sync-alice');
    const bobToken = await signIn('sync-bob');
    const handle = (token: string, id: string) => call(server, 'POST', `/api/drive/syncs/${uuidToBase62(id)}/handled`, token);
    const handledAt = async (id: string) => (await db.driveSync.findUniqueOrThrow({ where: { id } })).handledAt;
    const longAgo = new Date(Date.now() - DRIVE_SYNC_KEEP_MS - 60_000);
    /** A sync of Alice's that ended a day and a minute ago, as the runner left it. */
    const endedLongAgo = async (sourceName: string, destPath: string, data: Record<string, unknown>) => {
      const id = opened(await as(aliceRunner.token, 'POST', '', { sourceName, destPath }), `open ${sourceName}`);
      await db.driveSync.update({ where: { id }, data: { startedAt: longAgo, updatedAt: longAgo, endedAt: longAgo, ...data } });
      return id;
    };
    const failedFiles = await endedLongAgo('books-stage', '/Books', {
      status: 'DONE', failedCount: 4, failed: [{ path: '0412/scan.tiff', error: 'File changed while reading.' }],
    });
    const failedWhole = await endedLongAgo('exports', '/Lab evidence', { status: 'FAILED', error: '/Lab evidence is a file in Drive.' });
    const handledFailure = await endedLongAgo('scratch', '/scratch', { status: 'DONE', failedCount: 2, handledAt: longAgo });
    const clean = await endedLongAgo('clean', '/Clean', { status: 'DONE', filesDone: 9 });
    const stopped = await endedLongAgo('stopped', '/Stopped', { status: 'STOPPED' });

    for (const id of [failedFiles, failedWhole]) {
      const view = await listed(alice, id);
      assert.ok(view, 'an unhandled failure older than DRIVE_SYNC_KEEP_MS is listed');
      assert.equal(view.handledAt, null);
      assert.equal(view.fixSessionId, null);
      assert.equal(view.fixRequestedAt, null);
    }
    for (const id of [handledFailure, clean, stopped]) assert.equal(await listed(alice, id), undefined, 'a handled, clean or stopped one is not');
    ok(await as(aliceRunner.token, 'POST', '', { sourceName: 'next', destPath: '/Next' }), 'the next open prunes');
    assert.equal(await db.driveSync.count({ where: { id: { in: [failedFiles, failedWhole] } } }), 2, 'the unhandled failures stay');
    assert.equal(await db.driveSync.count({ where: { id: { in: [handledFailure, clean, stopped] } } }), 0, 'the rest age out');

    // Fifty newer syncs fill the tray's page; the old failures are still in it.
    const now = new Date();
    await db.driveSync.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        ownerId: alice, runnerId: aliceRunner.id, sourceName: `filler-${i}`, destPath: '/Filler', status: 'DONE',
        startedAt: now, updatedAt: now, endedAt: now,
      })),
    });
    const tray = (await syncs.list(alice)).syncs;
    assert.ok(tray.some((sync) => sync.id === failedFiles) && tray.some((sync) => sync.id === failedWhole), 'not pushed out by newer syncs');
    const starts = tray.map((sync) => sync.startedAt);
    assert.deepEqual(starts, [...starts].sort().reverse(), 'still newest first');
    await db.driveSync.deleteMany({ where: { ownerId: alice, destPath: '/Filler' } });

    // The owner's Clear: another account's is not found and writes nothing; saying it twice keeps the first time.
    const refused = await handle(bobToken, failedFiles);
    assert.equal(refused.status, 404, JSON.stringify(refused.json));
    assert.equal(await handledAt(failedFiles), null, "another account's Clear writes nothing");
    const first = ok(await handle(aliceToken, failedFiles), 'clear').json;
    assert.ok(first.handledAt, 'the answer carries handledAt');
    assert.equal(first.id, uuidToBase62(failedFiles));
    const again = ok(await handle(aliceToken, failedFiles), 'clear again').json;
    assert.equal(again.handledAt, first.handledAt, 'idempotent: the first time is kept');
    assert.equal((await handledAt(failedFiles))?.toISOString(), first.handledAt);
    assert.equal(await listed(alice, failedFiles), undefined, 'once handled it ages out like any other');
    ok(await as(aliceRunner.token, 'POST', '', { sourceName: 'next', destPath: '/Next' }), 'the next open prunes it');
    assert.equal(await db.driveSync.count({ where: { id: failedFiles } }), 0);
    assert.equal(await handledAt(failedWhole), null, 'the other failure is untouched');
    assert.ok(await listed(alice, failedWhole));
    assert.equal((await handle(aliceToken, randomUUID())).status, 404, 'no such sync');

    // A later clean sync of the same source into the same destination settles the earlier failures, and only those.
    const run = async (runner: { token: string }, sourceName: string, destPath: string, end: Record<string, unknown>) => {
      const id = opened(await as(runner.token, 'POST', '', { sourceName, destPath }), `open ${sourceName}`);
      ok(await as(runner.token, 'PATCH', `/${id}`, end), `end ${sourceName}`);
      return id;
    };
    const failing = { status: 'DONE', failed: [{ path: 'cover-001.jpg', error: 'Permission denied.' }], failedCount: 1 };
    const earlier = await run(aliceRunner, 'photos', '/Photos', failing);
    const broken = await run(aliceRunner, 'photos', '/Photos', { status: 'FAILED', error: 'Disk gone.' });
    const elsewhere = await run(aliceRunner, 'photos', '/Elsewhere', failing);
    const bobs = await run(bobRunner, 'photos', '/Photos', failing);
    const stillFailing = await run(aliceRunner, 'photos', '/Photos', failing);
    assert.equal(await handledAt(earlier), null, 'a later sync with failures settles nothing');
    const stop = await run(aliceRunner, 'photos', '/Photos', { status: 'STOPPED' });
    assert.equal(await handledAt(earlier), null, 'a stopped sync settles nothing');
    const fixed = await run(aliceRunner, 'photos', '/Photos', { status: 'DONE', filesDone: 1 });
    for (const id of [earlier, broken, stillFailing]) {
      assert.ok(await handledAt(id), 'an earlier failure of the same source and destination is handled');
      assert.ok((await listed(alice, id))?.handledAt, 'and reads so');
    }
    for (const id of [elsewhere, fixed, stop]) assert.equal(await handledAt(id), null, 'another destination, the clean one, a stopped one');
    assert.equal(await handledAt(bobs), null, "another account's failure is not");
    assert.equal(await handledAt(failedWhole), null, 'another source is not');
  });
});
