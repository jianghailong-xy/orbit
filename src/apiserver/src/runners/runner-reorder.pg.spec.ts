/**
 * Reordering runners by the ids GET /runners hands out, held against the production apiserver —
 * `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-reorder.pg.spec.ts
 *
 * GET /runners spells every id the public way (base62, PublicIdInterceptor), and every client — web,
 * iOS, Android — sends those ids straight back to POST /runners/reorder. While ReorderRunnersDto took
 * them as plain strings, none of them matched the UUIDs RunnersService compares: the service appended
 * every runner as one the request had left out, and the order never moved (A13d, on A11's stack).
 * Only the real pipes show it, which is why this goes through the production server:
 *
 *   (1) a Move down sent in the ids GET /runners gave: the answer, the next GET and the stored
 *       positions all have the new order;
 *   (2) the same runner twice, once in each spelling, is refused and writes nothing;
 *   (3) raw UUIDs, which no client is handed any more but the route still takes, reorder too.
 *
 * Not destructive: every row belongs to a user this run creates.
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('POST /runners/reorder takes the ids GET /runners hands out', { skip: !URL, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  // One account with three runners enrolled an hour apart: never reordered, they list in that order.
  const ownerId = randomUUID();
  const email = `runner-reorder-${RUN}@runner-reorder.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'Runner owner', passwordHash: 'x' } });
  const uuidOf: Record<string, string> = {};
  for (const [i, name] of ['alpha', 'bravo', 'charlie'].entries()) {
    uuidOf[name] = randomUUID();
    await db.runner.create({
      data: { id: uuidOf[name], ownerId, name, tokenHash: `runner-reorder-${uuidOf[name]}`, enrolledAt: new Date(Date.now() - (3 - i) * 3_600_000) },
    });
  }

  const jwtSecret = `runner-reorder-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });
  server = await startApiserver(url, jwtSecret);
  const api = (method: string, path: string, body?: unknown): Promise<Reply> => call(server!, method, `/api${path}`, login, body);

  /** The list as a client reads it. */
  const listed = async (): Promise<Array<{ id: string; name: string }>> => {
    const reply = await api('GET', '/runners');
    assert.equal(reply.status, 200, reply.text);
    return reply.json;
  };
  /** Each runner's stored position, by name: what the next GET sorts on. */
  const stored = async () =>
    Object.fromEntries((await sql.query<{ name: string; position: number | null }>(
      `SELECT "name", "position" FROM "runner" WHERE "owner_id" = $1::uuid ORDER BY "name"`,
      [ownerId],
    )).rows.map((r) => [r.name, r.position]));

  await t.test('(1) a Move down in the ids GET /runners gave is answered, read back and stored in the new order', async () => {
    const before = await listed();
    assert.deepEqual(before.map((r) => r.name), ['alpha', 'bravo', 'charlie']);
    // The spelling every client holds: base62, never the UUID the rows key by.
    for (const r of before) {
      assert.doesNotMatch(r.id, UUID, `${r.name} is listed by its public id`);
      assert.equal(toUuid(r.id), uuidOf[r.name]);
    }
    // alpha one place down, sent as the apps send it: the whole list, in the ids they were given.
    const [alpha, bravo, charlie] = before.map((r) => r.id);
    const moved = await api('POST', '/runners/reorder', { ids: [bravo, alpha, charlie] });
    assert.equal(moved.status, 201, moved.text);
    assert.deepEqual(moved.json.map((r: { name: string }) => r.name), ['bravo', 'alpha', 'charlie']);
    assert.deepEqual((await listed()).map((r) => r.name), ['bravo', 'alpha', 'charlie']);
    assert.deepEqual(await stored(), { alpha: 1, bravo: 0, charlie: 2 });
  });

  await t.test('(2) the same runner twice, once in each spelling, is refused and writes nothing', async () => {
    const before = await stored();
    const [first, second] = await listed();
    const refused = await api('POST', '/runners/reorder', { ids: [second.id, toUuid(second.id), first.id] });
    assert.equal(refused.status, 400, refused.text);
    assert.deepEqual(await stored(), before);
  });

  await t.test('(3) raw UUIDs reorder as well', async () => {
    const reversed = (await listed()).reverse();
    const answered = await api('POST', '/runners/reorder', { ids: reversed.map((r) => toUuid(r.id)) });
    assert.equal(answered.status, 201, answered.text);
    assert.deepEqual((await listed()).map((r) => r.name), reversed.map((r) => r.name));
  });
});
