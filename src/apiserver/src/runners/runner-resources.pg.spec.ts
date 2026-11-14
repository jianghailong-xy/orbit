/**
 * A machine's CPU, memory and disk (migration 0720, runners/runner-resources.ts) against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, through the production apiserver where a route is held to:
 *
 *   (1) 0720 added a nullable JSONB runner_presence.resources;
 *   (2) a link beat's one statement (readLinkBeat) keeps the reading and adds a sample; a beat without one leaves the
 *       column as it was; a sample more than an hour older than the beat is dropped; the statement's text is the
 *       same with and without a reading, so it stays one prepared statement;
 *   (3) POST /api/runner/heartbeat with a reading records it, and GET /api/runners/:id/resources answers it to its
 *       owner — the latest reading and the hour's samples — nothing kept for a runner that has reported none, and a
 *       404 to anyone else.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-resources.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates, on the disposable database the script creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { Prisma, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { readLinkBeat } from '../runner-api/link-heartbeat';
import { runnerLinkCredential } from '../runner-api/runner-link-token';
import '../test-support/daemon-routes-over-http';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const GB = 1_000_000_000;

test('machine resources: kept beside presence by the beat, read by the machine page', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `runner-resources-spec-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | null = null;
  t.after(async () => {
    await server?.stop().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  async function owner(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}@runner-resources.test`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, login: () => jwt.signAsync({ sub: id, email }) };
  }
  async function runner(ownerId: string, name: string) {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    await db.runner.create({ data: { id, ownerId, name: `${name}-${RUN}`, tokenHash: sha256(token), status: 'ONLINE' } });
    return { id, token };
  }
  const stored = async (runnerId: string) =>
    (await sql.query<{ resources: { at: number; latest: unknown; samples: number[][] } | null }>(
      'SELECT resources FROM runner_presence WHERE runner_id = $1', [runnerId],
    )).rows[0]?.resources ?? null;

  await t.test('(1) 0720 added a nullable JSONB runner_presence.resources', async () => {
    const { rows } = await sql.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'runner_presence' AND column_name = 'resources'`,
    );
    assert.deepEqual(rows, [{ data_type: 'jsonb', is_nullable: 'YES' }]);
  });

  await t.test('(2) a link beat keeps the reading and its hour, in its one statement', async () => {
    const ann = await owner('ann');
    const r = await runner(ann.id, 'link');
    const { tokenHash } = await db.runner.findUniqueOrThrow({ where: { id: r.id }, select: { tokenHash: true } });
    const process = randomUUID();
    const texts = new Set<string>();
    const recording = db.$extends({
      query: { $queryRaw: ({ args, query }) => { texts.add((args as unknown as Prisma.Sql).sql); return query(args); } },
    });
    const beat = (resources: object | null) => readLinkBeat(recording as unknown as PrismaService, {
      runnerId: r.id, ownerId: ann.id, credential: runnerLinkCredential(tokenHash), processId: process, gatewayId: 'link-gateway-1',
      namedSessionIds: [], supervisedSessionIds: [], planUsageDigest: null, resources,
    });

    await beat(null);
    assert.equal(await stored(r.id), null, 'no reading: nothing kept');
    const reading = { cpuPercent: 38, cpuCores: 8, load1: 3.04, memTotalBytes: 32 * GB, memAvailableBytes: 8 * GB, diskTotalBytes: 926 * GB, diskFreeBytes: 198 * GB };
    const before = Date.now();
    await beat(reading);
    const first = await stored(r.id);
    assert.ok(first);
    assert.deepEqual(first.latest, reading);
    assert.ok(Math.abs(first.at - before) < 60_000, 'at is the database’s now');
    assert.deepEqual(first.samples.map((s) => s.slice(1)), [[38, 75, 78.6]]);

    await beat({ ...reading, cpuPercent: 50 });
    const second = await stored(r.id);
    assert.equal(second!.samples.length, 2);
    assert.deepEqual(second!.samples.map((s) => s[1]), [38, 50], 'oldest first');

    await beat(null);
    assert.deepEqual(await stored(r.id), second, 'a beat without a reading leaves the column as it was');

    // An hour and a minute older than the next beat: dropped by it.
    const old = [second!.at - 61 * 60_000, 1, 1, 1];
    await sql.query(
      `UPDATE runner_presence SET resources = jsonb_set(resources, '{samples}', jsonb_build_array($2::jsonb) || (resources->'samples')) WHERE runner_id = $1`,
      [r.id, JSON.stringify(old)],
    );
    assert.equal((await stored(r.id))!.samples.length, 3);
    await beat({ ...reading, cpuPercent: 60 });
    assert.deepEqual((await stored(r.id))!.samples.map((s) => s[1]), [38, 50, 60]);
    assert.equal(texts.size, 1, 'one statement text with a reading and without one: one prepared statement');
  });

  server = await startApiserver(url, jwtSecret);

  await t.test('(3) an HTTPS beat records the reading, and the machine page reads it', async () => {
    const bo = await owner('bo');
    const r = await runner(bo.id, 'https');
    const quiet = await runner(bo.id, 'quiet');
    const reading = { cpuPercent: 12.5, cpuCores: 4, memTotalBytes: 16 * GB, memAvailableBytes: 4 * GB };
    const beat = await call(server!, 'POST', '/api/runner/heartbeat', r.token, { status: 'ONLINE', idleCapacity: 1, leaseOwner: randomUUID(), resources: reading });
    assert.equal(beat.status, 201, beat.text);
    const token = await bo.login();
    const answer = await call(server!, 'GET', `/api/runners/${r.id}/resources`, token);
    assert.equal(answer.status, 200, answer.text);
    const body = answer.json as { at: string; latest: unknown; samples: { cpu: number; mem: number; disk: number | null }[] };
    assert.deepEqual(body.latest, reading);
    assert.ok(body.at);
    assert.deepEqual(body.samples.map(({ cpu, mem, disk }) => [cpu, mem, disk]), [[12.5, 75, null]]);

    await call(server!, 'POST', '/api/runner/heartbeat', quiet.token, { status: 'ONLINE', idleCapacity: 1 });
    const none = await call(server!, 'GET', `/api/runners/${quiet.id}/resources`, token);
    assert.deepEqual(none.json, { at: null, latest: null, samples: [] }, 'a runner that reports none: nothing kept');

    const eve = await owner('eve');
    const theirs = await call(server!, 'GET', `/api/runners/${r.id}/resources`, await eve.login());
    assert.equal(theirs.status, 404);
  });
});
