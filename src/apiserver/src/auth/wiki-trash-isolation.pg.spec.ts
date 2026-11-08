/**
 * The wiki Trash census (contract `space.trash`, docs/mocks/wiki-trash): a wiki in Trash is in no door. Held against the
 * production apiserver — `build/main.js`, the whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty, with the tenant census's own cases and fixtures:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/auth/wiki-trash-isolation.pg.spec.ts
 *
 * One account holds a full set of objects, its wiki among them (`Tenant`), and every table carries the census's write
 * trigger. The owner moves the wiki to Trash, and then:
 *
 *   (1) every case of TENANT_ISOLATION_CASES and TENANT_ISOLATION_FIELD_CASES whose request names the wiki or anything in
 *       it, sent by the owner: answered exactly as the same request whose every wiki id names nothing, and nothing
 *       written at all — so a door that forgot the Trash shows here, whatever it reads;
 *   (2) the owner's list and Trash: the wiki is in the one and not the other; its public link is paused, answered as one
 *       that never was, and listed to the owner as paused because it is in Trash;
 *   (3) restored, its public link opens again, and every one of those cases again is NOT answered 401, 403 or 404 — the
 *       wiki came back whole, and the answers in (1) were the Trash's doing.
 *
 * A route added later that names a wiki is in this census by being in the tenant census, which its own unit spec makes
 * every route be. Not destructive: every row belongs to the user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { startApiserver, type Apiserver, type Reply } from './pat-test-apiserver';
import { TENANT_ISOLATION_CASES, TENANT_ISOLATION_FIELD_CASES, type Tenant, type TenantCase, type TenantRequest } from './tenant-isolation-cases';
import { WRITE_TRAP, answerOf, censusFixtures, methodOf, pathOf, upload } from './tenant-isolation-fixtures';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `wiki-trash-${RUN}`;

/** The Trash's own doors: they answer a wiki in Trash by design, and are proved in wiki-trash.pg.spec.ts. */
const TRASH_DOORS = new Set(['POST /wiki/spaces/:id/restore', 'DELETE /wiki/spaces/:id/purge']);

/** The ids of a tenant that name the wiki or something in it. */
const WIKI_IDS = [
  'wikiSpaceId', 'wikiEntryId', 'wikiChangesetId', 'wikiChangesetOpId', 'wikiPlanProposalId', 'wikiDocVersionId', 'wikiChatId',
  'wikiChatDraftId', 'wikiPlanCardId',
] as const satisfies ReadonlyArray<keyof Tenant>;

/** `value` with every string that is a key of `swap` swapped for its value, however deep. */
function swapped<T>(value: T, swap: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') return (swap.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((item) => swapped(item, swap)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swapped(item, swap)])) as T;
  }
  return value;
}

test('wiki Trash: every door that names a wiki in Trash answers as for one that does not exist, and writes nothing; restored, each answers again', {
  skip: !URL, concurrency: 1, timeout: 1_800_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  const filesDir = mkdtempSync(path.join(tmpdir(), 'wiki-trash-files-'));
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(filesDir, { recursive: true, force: true });
  });
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;

  const jwtSecret = `wiki-trash-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  server = await startApiserver(url, jwtSecret, {
    ORBIT_WIKI: 'on',
    PROVIDER_SECRET_KEY,
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
    ORBIT_FILES_DIR: filesDir,
  });
  const { api, ok, account, tenant } = censusFixtures({ run: RUN, db, sql, server, jwt });
  // An administrator, as the tenant census's A is, so the administrators' wiki routes are asked too.
  const owner = await account('a', 'ADMIN');
  const a = await tenant(owner, 'a');

  // ── which cases name the wiki ──────────────────────────────────────────────────────────────
  const wikiIds = new Set(WIKI_IDS.map((key) => a[key] as string));
  const namesTheWiki = (request: TenantRequest) => JSON.stringify(request).split('"').some((part) => wikiIds.has(part));
  const cases = (Object.entries(TENANT_ISOLATION_CASES) as Array<[string, TenantCase]>)
    .filter(([route, kase]) => !TRASH_DOORS.has(route) && namesTheWiki(kase.request(a, a)));
  const routeOfField = (key: string) => key.split(' ').slice(0, 2).join(' ');
  const fieldCases = (Object.entries(TENANT_ISOLATION_FIELD_CASES) as Array<[string, TenantCase]>)
    .filter(([key, kase]) => !TRASH_DOORS.has(routeOfField(key)) && namesTheWiki(kase.request(a, a)));
  assert.ok(cases.length >= 50, `the census found the wiki's routes: ${cases.length} of them`);

  /** The same request with every id of the wiki's swapped for one that names nothing. */
  const nothing = new Map([...wikiIds].map((id) => [id, randomUUID()]));
  const control = (request: TenantRequest) => swapped(request, nothing);

  // ── the write trap ─────────────────────────────────────────────────────────────────────────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  const writtenSince = async (since: bigint) =>
    (await sql.query<{ tbl: string; op: string; row: unknown }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`,
      [since.toString()],
    )).rows.map((w) => `${w.op} ${w.tbl} ${JSON.stringify(w.row)}`.slice(0, 300));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const quiet = async () => {
    for (let still = 0, last = await mark(); still < 3;) {
      await sleep(1_000);
      const now = await mark();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  };
  const send = (route: string, request: TenantRequest): Promise<Reply> =>
    request.file
      ? upload(server!, methodOf(route), pathOf(route, request), { authorization: `Bearer ${owner.bearer}` }, request.file)
      : api(owner, methodOf(route), pathOf(route, request), request.body);
  /** Both ids of the wiki, as rows spell them. */
  const spaceNames = [a.wikiSpaceId, uuidToBase62(a.wikiSpaceId)];

  // The wiki's public link, open before the move.
  const link = ok(await api(owner, 'PUT', `/api/wiki/spaces/${a.wikiSpaceId}/share`, {}), 'sharing the wiki').json as { token: string };
  const visitor = () => fetch(`http://127.0.0.1:${server!.port}/api/shared/${encodeURIComponent(link.token)}`);
  assert.equal((await visitor()).status, 200, 'a visitor opens the shared wiki');

  // ── into Trash ─────────────────────────────────────────────────────────────────────────────
  ok(await api(owner, 'DELETE', `/api/wiki/spaces/${a.wikiSpaceId}`), 'moving the wiki to Trash');
  await quiet();

  // ── (1) every door on the wiki in Trash ────────────────────────────────────────────────────
  const attacked = await mark();
  for (const [label, route, request] of [
    ...cases.map(([route, kase]) => [route, route, kase.request(a, a)] as const),
    ...fieldCases.map(([key, kase]) => [key, routeOfField(key), kase.request(a, a)] as const),
  ]) {
    await t.test(`${label}: on a wiki in Trash, answered as for one that does not exist, and nothing written`, async () => {
      const before = await mark();
      const reply = await send(route, request);
      await sleep(25);
      const written = await writtenSince(before);
      const nobody = await send(route, control(request));
      assert.deepEqual({ answer: answerOf(reply), written }, { answer: answerOf(nobody), written: [] }, reply.text.slice(0, 600));
    });
  }
  await t.test('nothing was written late either, of the wiki or anything in it', async () => {
    await sleep(2_000);
    const late = (await writtenSince(attacked)).filter((row) => spaceNames.some((id) => row.includes(id)));
    assert.deepEqual(late, []);
  });

  // ── (2) the lists ──────────────────────────────────────────────────────────────────────────
  await t.test('the wiki is in Trash and not among the owner\'s wikis', async () => {
    const spaces = ok(await api(owner, 'GET', '/api/wiki/spaces'), 'the wikis').json as Array<{ id: string }>;
    assert.ok(!spaces.some((space) => toUuid(space.id) === a.wikiSpaceId), 'not among the wikis');
    const trash = ok(await api(owner, 'GET', '/api/wiki/trash'), 'the Trash').json as { spaces: Array<{ id: string; slug: string }> };
    const row = trash.spaces.find((space) => toUuid(space.id) === a.wikiSpaceId);
    assert.ok(row, 'in Trash');
    assert.equal(row.slug, 'a-wiki', 'under the name it had');
  });

  await t.test('its public link is paused: a visitor is answered as for a link that never was, and the owner is told why', async () => {
    const paused = await visitor();
    assert.deepEqual({ status: paused.status, text: await paused.text() }, {
      status: 404,
      text: await (await fetch(`http://127.0.0.1:${server!.port}/api/shared/${randomUUID()}`)).text(),
    });
    const links = ok(await api(owner, 'GET', '/api/share-links?kind=WIKI'), 'the owner\'s links').json as {
      links: Array<{ token: string; state: string; stateReason: string | null }>;
    };
    const row = links.links.find((one) => one.token === link.token);
    assert.deepEqual(row && { state: row.state, stateReason: row.stateReason }, { state: 'PAUSED', stateReason: 'IN_TRASH' });
  });

  // ── (3) restored: every door answers again ─────────────────────────────────────────────────
  const restored = ok(await api(owner, 'POST', `/api/wiki/spaces/${a.wikiSpaceId}/restore`), 'restoring the wiki').json as { slug: string };
  assert.equal(restored.slug, 'a-wiki', 'it is back under its name');
  await t.test('restored, its public link opens again', async () => {
    assert.equal((await visitor()).status, 200);
  });
  const depth = (route: string) => route.split('/').length;
  const ordered = [...cases].sort(([x], [y]) => {
    const dx = methodOf(x) === 'DELETE' ? 1 : 0;
    const dy = methodOf(y) === 'DELETE' ? 1 : 0;
    return dx - dy || (dx ? depth(y) - depth(x) : 0);
  });
  for (const [route, kase] of ordered) {
    await t.test(`${route}: on the restored wiki, answered by the route`, async () => {
      const reply = await send(route, kase.request(a, a));
      assert.ok(![401, 403, 404].includes(reply.status), `answered ${reply.status}: ${reply.text.slice(0, 600)}`);
    });
  }
});
