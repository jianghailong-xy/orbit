/**
 * The tenant isolation census (docs/google-sign-in-design.md §5.6, §11 T1), held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/tenant-isolation.pg.spec.ts
 *
 * Three accounts each hold a full set of objects (`Tenant`): A, an administrator, and B and B2,
 * members, as everybody open sign-up admits is. Every table carries a trigger for the run, so what
 * the database notes between a request and its answer is the whole of what that request wrote. Then:
 *
 *   (1)  every case in TENANT_ISOLATION_CASES, sent by B on A's objects: answered 404 or 403, and no
 *        write at all — nor any after the last of them was answered;
 *   (1b) every one whose path names one object under another, sent by B on its own parent with A's
 *        child in it, and again with an id that names nothing in that place: answered the same, and
 *        nothing written that names anything of A's;
 *   (1c) every case in TENANT_ISOLATION_FIELD_CASES, sent by B with A's object in the field, and by B2
 *        with an id that names nothing there — B's twin, sent each of these requests beside B, so its
 *        objects have had the same done to them: answered the same, and nothing written that names
 *        anything of A's;
 *   (2)  every case again, by its owner on its own objects (A, and B on its own nested and field
 *        cases): NOT answered 401, 403 or 404. The same request answered otherwise for the owner is
 *        what makes B's refusal the account's doing — not a path, a body or a state that refuses
 *        everybody.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';
import {
  TENANT_ISOLATION_CASES,
  TENANT_ISOLATION_FIELD_CASES,
  type Tenant,
  type TenantCase,
  type TenantRequest,
} from './tenant-isolation-cases';
import { WRITE_TRAP, answerOf, censusFixtures, methodOf, pathOf, upload, type CensusAccount } from './tenant-isolation-fixtures';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `tenant-isolation-${RUN}`;

const refused = (status: number) => status === 403 || status === 404;

test('tenant isolation: every route that names something by path refuses another account its objects, and writes nothing', {
  skip: !URL, concurrency: 1, timeout: 1_800_000,
}, async (t) => {
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
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;

  const jwtSecret = `tenant-isolation-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  server = await startApiserver(url, jwtSecret, {
    ORBIT_WIKI: 'on',
    PROVIDER_SECRET_KEY,
    // No reaching models.dev from a spec: the catalogue keeps the lists this build shipped.
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
  });
  const { api, account, tenant } = censusFixtures({ run: RUN, db, sql, server, jwt });
  type Account = CensusAccount;

  const userA = await account('a', 'ADMIN');
  const userB = await account('b', 'MEMBER');
  const a = await tenant(userA, 'a');
  const b = await tenant(userB, 'b');
  // B's twin, for what an id that names nothing is answered: a request of B's own changes B's own
  // objects, so the request it is compared with goes to an account that has had the same done to it.
  const userB2 = await account('b2', 'MEMBER');
  const b2 = await tenant(userB2, 'b2');

  // ── the write trap ─────────────────────────────────────────────────────────────────────────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  /** Every row written since `since`, as a person reads it: A's and B's ids spelled <A> and <B>. */
  const writtenSince = async (since: bigint) =>
    (await sql.query<{ tbl: string; op: string; row: unknown }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`,
      [since.toString()],
    )).rows.map((w) => `${w.op} ${w.tbl} ${JSON.stringify(w.row).split(userA.userId).join('<A>').split(userB.userId).join('<B>')}`);
  /** The same rows, cut short for a failure message. */
  const shown = (written: string[]) => written.map((row) => row.slice(0, 300));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  // Quiet before anything is asked: what making the fixtures set going has finished writing.
  for (let quiet = 0, last = await mark(); quiet < 3;) {
    await sleep(1_000);
    const now = await mark();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }

  /** A route's request, as JSON or, carrying a file, as multipart. */
  const send = (who: Account, route: string, request: TenantRequest): Promise<Reply> =>
    request.file
      ? upload(server!, methodOf(route), pathOf(route, request), { authorization: `Bearer ${who.bearer}` }, request.file)
      : api(who, methodOf(route), pathOf(route, request), request.body);
  /** One request from B (or another account), and every row the database recorded while it was answered. */
  const fromB = async (route: string, request: TenantRequest, who: Account = userB) => {
    const before = await mark();
    const reply = await send(who, route, request);
    await sleep(25);
    return { reply, written: await writtenSince(before) };
  };

  const cases = Object.entries(TENANT_ISOLATION_CASES) as Array<[string, TenantCase]>;
  /** The request on B's own objects with A's in the nested params — or, given one, an id that names nothing. */
  const crossed = (kase: TenantCase, nobody?: string): TenantRequest => {
    const own = kase.request(b, b);
    const theirs = kase.request(a, b);
    const params = { ...own.params };
    for (const nested of kase.nested ?? []) params[nested] = nobody ?? theirs.params[nested];
    return { ...own, params };
  };

  /** Every id of A's, as a row would spell it: what a write of B's must never name. */
  const idsOfA = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) idsOfA.add(value).add(uuidToBase62(value));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(a);
  const namingA = (written: string[]) =>
    shown(written.filter((row) => row.includes('<A>') || [...idsOfA].some((id) => row.includes(id))));

  // ── (1) B on A's objects: refused, and nothing written ─────────────────────────────────────
  let attacked = await mark();
  for (const [route, kase] of cases) {
    await t.test(`${route}: B on A's is answered 404 or 403 and writes nothing`, async () => {
      const { reply, written } = await fromB(route, kase.request(a, b));
      assert.deepEqual(
        { answered: refused(reply.status) ? '404 or 403' : reply.status, written: shown(written) },
        { answered: '404 or 403', written: [] },
        reply.text.slice(0, 600),
      );
    });
  }
  await t.test('nothing B asked of A\'s objects was written late either', async () => {
    await sleep(2_000);
    assert.deepEqual(shown(await writtenSince(attacked)), []);
  });

  // ── (1b) B's own parent, A's child: a check on the parent alone lets this through ─────────────
  // What it must answer is exactly what it answers for an id that names nothing — so it says nothing
  // about A's — and nothing it writes may name anything of A's. It may write B's own: a request on
  // B's own task wakes B's own watch on it, as it would for any request there.
  attacked = await mark();
  for (const [route, kase] of cases) {
    if (!kase.nested) continue;
    await t.test(`${route}: B on its own with A's ${kase.nested.join(', ')} writes nothing of A's and is answered as for an id that names nothing`, async () => {
      const theirs = crossed(kase);
      const nobody = crossed(kase, randomUUID());
      const { reply, written } = await fromB(route, theirs);
      const control = await fromB(route, nobody);
      assert.deepEqual(
        { answer: answerOf(reply), writtenOfA: namingA(written) },
        { answer: answerOf(control.reply), writtenOfA: [] },
      );
    });
  }
  // ── (1c) B's own request with A's object in a field of its body or query ─────────────────────
  // Held to the same: answered exactly as the same request with an id that names nothing in that
  // field, and nothing written that names anything of A's.
  /** A tenant whose every object is one nobody has: a fresh id each, the same id each time it is read. */
  const nobody = (): Tenant => {
    const fresh = (cache: Map<PropertyKey, string>) => (_: object, key: PropertyKey) => {
      if (!cache.has(key)) cache.set(key, randomUUID());
      return cache.get(key);
    };
    const spare = new Proxy({}, { get: fresh(new Map()) });
    const own = fresh(new Map());
    return new Proxy({} as Tenant, { get: (target, key) => (key === 'spare' ? spare : own(target, key)) });
  };
  /**
   * B's own receipt of a Run press (`task_run_request`, owner B): it records the ids the press named —
   * A's among them, when B named one — and is answered alike for an id that names nothing. It is B's
   * record of what B sent, and links nothing; it is not a write of A's.
   */
  const ownRunReceipt = (row: string) => /^\w+ task_run_request /.test(row) && row.includes('"owner_id":"<B>"');
  const fieldCases = Object.entries(TENANT_ISOLATION_FIELD_CASES);
  const routeOfField = (key: string) => key.split(' ').slice(0, 2).join(' ');
  for (const [key, kase] of fieldCases) {
    await t.test(`${key}: B's own request with A's in it writes nothing of A's and is answered as for an id that names nothing`, async () => {
      const route = routeOfField(key);
      const { reply, written } = await fromB(route, kase.request(a, b));
      const control = await fromB(route, kase.request(nobody(), b2), userB2);
      assert.deepEqual(
        { answer: answerOf(reply), writtenOfA: namingA(written.filter((row) => !ownRunReceipt(row))) },
        { answer: answerOf(control.reply), writtenOfA: [] },
      );
    });
  }
  await t.test('nothing B asked with A\'s ids in it wrote anything of A\'s late either', async () => {
    await sleep(2_000);
    assert.deepEqual(namingA((await writtenSince(attacked)).filter((row) => !ownRunReceipt(row))), []);
  });

  // ── (2) the same requests from the owner: answered by the route itself ──────────────────────
  // Deletes last, and a path's deeper deletes before its shallower ones, so that no case takes away
  // what a later one asks for.
  const depth = (route: string) => route.split('/').length;
  const ordered = [...cases].sort(([x], [y]) => {
    const dx = methodOf(x) === 'DELETE' ? 1 : 0;
    const dy = methodOf(y) === 'DELETE' ? 1 : 0;
    return dx - dy || (dx ? depth(y) - depth(x) : 0);
  });
  for (const [route, kase] of ordered) {
    const controls: Array<[string, Account, TenantRequest]> = [['A on its own', userA, kase.request(a, a)]];
    if (kase.nested) controls.push(['B on its own', userB, kase.request(b, b)]);
    for (const [what, who, request] of controls) {
      await t.test(`${route}: ${what} is answered by the route`, async () => {
        const reply = await send(who, route, request);
        assert.ok(![401, 403, 404].includes(reply.status), `answered ${reply.status}: ${reply.text.slice(0, 600)}`);
      });
    }
  }
  // And each field case with B's own object in its field: read by the route, not stripped before it.
  for (const [key, kase] of fieldCases) {
    await t.test(`${key}: B's own request with its own in it is answered by the route`, async () => {
      const reply = await send(userB, routeOfField(key), kase.request(b, b));
      assert.ok(![401, 403, 404].includes(reply.status), `answered ${reply.status}: ${reply.text.slice(0, 600)}`);
    });
  }
});
