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
 *   (4) the body: a source name with a slash, an unknown status and more than 100 failed paths are refused.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Reply } from '../auth/pat-test-apiserver';
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

  const account = async (name: string) => {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${name}-${RUN}@drive-syncs.invalid`, name, passwordHash: 'x' } });
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
    assert.deepEqual(view?.session, { id: aliceSession, title: 'Weekly report' });
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
});
