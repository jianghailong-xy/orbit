/**
 * `managed` on the owner's runner rows, held against the production apiserver — `build/main.js`, the
 * whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-managed-flag.pg.spec.ts
 *
 * Every client labels the account's managed runner Orbit Cloud. They used to know which runner that is
 * only from GET /managed-runner, which arrives after the runner list, so a row showed its stored name
 * (`orbit-managed` before migration 1250) first. The row says it now (RunnerRowIdentity.managed):
 *
 *   (1) GET /runners marks the runner with the owner's ManagedRunner mapping `managed: true` and every
 *       other runner of theirs `managed: false`; another owner's managed runner changes nothing here;
 *   (2) GET /runners/:id says the same of each runner, and POST /runners/reorder answers with the flag.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

test('GET /runners marks the account managed runner, and only it', { skip: !URL, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  async function owner(tag: string) {
    const id = randomUUID();
    const email = `managed-flag-${tag}-${RUN}@runner-managed-flag.invalid`;
    await db.user.create({ data: { id, email, name: `Owner ${tag}`, passwordHash: 'x' } });
    return { id, email };
  }
  async function runner(ownerId: string, name: string, hoursAgo: number) {
    const id = randomUUID();
    await db.runner.create({
      data: { id, ownerId, name, tokenHash: `managed-flag-${id}`, enrolledAt: new Date(Date.now() - hoursAgo * 3_600_000) },
    });
    return id;
  }
  async function managedMapping(ownerId: string, runnerId: string) {
    await db.managedRunner.create({
      data: { ownerId, runnerId, clusterKey: 'managed-flag-spec', namespace: 'orbit', pvcName: `mr-data-${runnerId}` },
    });
  }

  // One account with a machine of its own, its managed runner and another machine; a second account
  // whose own managed runner must not leak into the first one's answers.
  const alice = await owner('alice');
  const laptop = await runner(alice.id, 'laptop', 3);
  const cloud = await runner(alice.id, 'Orbit Cloud', 2);
  const buildBox = await runner(alice.id, 'build-box', 1);
  await managedMapping(alice.id, cloud);
  const bob = await owner('bob');
  const bobCloud = await runner(bob.id, 'Orbit Cloud', 1);
  await managedMapping(bob.id, bobCloud);

  const jwtSecret = `managed-flag-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: alice.id, email: alice.email });
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, body?: unknown): Promise<Reply> => call(server!, method, `/api${path}`, login, body);
  const flags = (rows: Array<{ id: string; managed: unknown }>) => rows.map((r) => [toUuid(r.id), r.managed]);

  await t.test('(1) GET /runners says managed on the managed runner and on no other', async () => {
    const reply = await api('GET', '/runners');
    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(flags(reply.json), [
      [laptop, false],
      [cloud, true],
      [buildBox, false],
    ]);
    assert.ok(!reply.json.some((r: { id: string }) => toUuid(r.id) === bobCloud), "another owner's runner is not listed");
  });

  await t.test('(2) GET /runners/:id and POST /runners/reorder say the same', async () => {
    for (const [id, managed] of [[laptop, false], [cloud, true], [buildBox, false]] as const) {
      const one = await api('GET', `/runners/${id}`);
      assert.equal(one.status, 200, one.text);
      assert.equal(one.json.managed, managed, `GET /runners/:id for ${id}`);
    }
    const reordered = await api('POST', '/runners/reorder', { ids: [buildBox, cloud, laptop] });
    assert.equal(reordered.status, 201, reordered.text);
    assert.deepEqual(flags(reordered.json), [
      [buildBox, false],
      [cloud, true],
      [laptop, false],
    ]);
  });
});
