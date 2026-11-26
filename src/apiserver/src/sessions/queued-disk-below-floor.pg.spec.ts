/**
 * Keep Free's hold on a session that has never run (common/runner-disk-gate.ts), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, through the production apiserver's GET /api/sessions and the runner's
 * GET /api/runner/sessions/claim. What it is held to:
 *
 *   (1) a new session on a workspace with less free than its runner's floor is not claimed, and the list says
 *       disk_below_floor; once the runner reports space above the floor it is claimed;
 *   (2) a session that has run before takes its next message whatever the disk;
 *   (3) a runner with Keep Free Off, or a workspace whose free space was never measured, holds nothing;
 *   (4) a new runner's floor is 10 GB (the column default).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/queued-disk-below-floor.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { toUuid } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const GB = 1024n * 1024n * 1024n;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

test('queuedReason disk_below_floor: a new session waits while its runner is below Keep Free', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `queued-disk-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  server = await startApiserver(url, jwtSecret);

  const ownerId = randomUUID();
  const email = `alice-${RUN}@queued-disk.test`;
  await db.user.create({ data: { id: ownerId, email, name: 'alice', passwordHash: 'x' } });
  const ownerToken = await jwt.signAsync({ sub: ownerId, email });

  async function runner(name: string, data: Partial<Prisma.RunnerUncheckedCreateInput>, freeBytes: bigint | null) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({
      data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date(), maxConcurrent: 4, ...data },
    });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: id, name: `${name}-${RUN}`, enabled: true, workDirFreeBytes: freeBytes } });
    return { id, workspaceId, token };
  }
  async function session(r: { id: string; workspaceId: string }, title: string, ranBefore = false) {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId: r.workspaceId, assignedRunnerId: r.id, title,
        prompt: title, provider: 'claude', providerBuiltin: true, turnState: 'QUEUED',
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...(ranBefore ? { startedAt: new Date(Date.now() - 60_000), runtimeSessionId: randomUUID(), numTurns: 1 } : {}),
      },
    });
    return id;
  }
  async function queuedReason(sessionId: string) {
    const list = await call(server!, 'GET', '/api/sessions?view=open', ownerToken);
    assert.equal(list.status, 200, list.text);
    const found = (list.json as Array<Record<string, any>>).find((x) => toUuid(String(x.id)) === sessionId);
    assert.ok(found, 'the queued session is in the list');
    return found.queuedReason;
  }
  async function claim(r: { token: string }) {
    const reply = await call(server!, 'GET', '/api/runner/sessions/claim', r.token);
    assert.ok(reply.status === 200 || reply.status === 204, reply.text);
    return reply.json?.sessionId ? toUuid(reply.json.sessionId) : null;
  }

  await t.test('(1) a new session waits below the floor and is claimed once space is back', async () => {
    const r = await runner('low', { minFreeDiskMb: 10240 }, 5n * GB);
    const fresh = await session(r, 'a new session');
    assert.equal(await queuedReason(fresh), 'disk_below_floor');
    assert.equal(await claim(r), null, 'below the floor: not claimed');
    await db.workspace.update({ where: { id: r.workspaceId }, data: { workDirFreeBytes: 20n * GB } });
    assert.equal(await queuedReason(fresh), null);
    assert.equal(await claim(r), fresh, 'above the floor: claimed');
  });

  await t.test('(2) a session that has run takes its next message whatever the disk', async () => {
    const r = await runner('low-followup', { minFreeDiskMb: 10240 }, 5n * GB);
    const followUp = await session(r, 'a reply to a running conversation', true);
    assert.equal(await queuedReason(followUp), null);
    assert.equal(await claim(r), followUp);
  });

  await t.test('(3) Keep Free Off, or no reading, holds nothing', async () => {
    const off = await runner('off', { minFreeDiskMb: null }, 1n * GB);
    const offSession = await session(off, 'on a runner with Keep Free Off');
    assert.equal(await queuedReason(offSession), null);
    assert.equal(await claim(off), offSession);
    const unknown = await runner('unmeasured', { minFreeDiskMb: 10240 }, null);
    const unknownSession = await session(unknown, 'on a workspace never measured');
    assert.equal(await queuedReason(unknownSession), null);
    assert.equal(await claim(unknown), unknownSession);
  });

  await t.test('(4) a new runner keeps 10 GB free', async () => {
    const id = randomUUID();
    await db.runner.create({ data: { id, ownerId, name: `fresh-${RUN}`, tokenHash: sha256(randomBytes(32).toString('base64url')) } });
    assert.equal((await db.runner.findUniqueOrThrow({ where: { id } })).minFreeDiskMb, 10240);
  });
});
