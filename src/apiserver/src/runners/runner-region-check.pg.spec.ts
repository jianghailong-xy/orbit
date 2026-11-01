/**
 * The Claude region check on the control plane (docs/claude-region-check-contract.md §3–§7), held against the
 * production apiserver — `build/main.js`, the whole AppModule, with the runner link's internal listener — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. TRUSTED_PROXIES names 198.51.100.0/24 and
 * 2001:db8:cf::/48, which stand for Cloudflare's edges; 203.0.113.24 is the runner's own address.
 *
 *   1. CF-IPCountry and cf-region-code decide only on a request whose hop nginx saw (X-Real-IP) is a trusted proxy:
 *      forged from the runner's own address, from the spec's own connection or behind a forged X-Forwarded-For, the
 *      answer is unknown and nothing is kept. Through an edge they answer the country; XX and T1 are unknown, Ukraine
 *      is decided by its region, and an excluded one is blocked.
 *   2. runner.region: an unknown answer moves checkedAt alone and leaves the decided fields; blockedChecks counts
 *      consecutive blocked answers, also arriving together, and an allowed one resets it; the row holds the eight
 *      fields and no address.
 *   3. GET /api/runners and /api/runners/:id carry the effective verdict, allowed once a blocked one is 24 hours old,
 *      and null for a runner that does not declare claude-region/v1 or that no check has decided.
 *   4. Check again: the owner's alone, refused offline and for a runner without the capability; the request reaches the
 *      runner in every heartbeat answer, over HTTPS and over the link, until a check at or after it reaches the route,
 *      and not past ten minutes. A newer request outlives an older check.
 *   5. A link call to the route is unknown, whatever its headers say: its connection is the link's.
 *   6. The route answers while RUNNER_LINK_REQUIRED is on, when the daemon's own routes answer 426.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-region-check.pg.spec.ts
 *
 * Not destructive: every row belongs to the accounts this run creates, and the switch is left off.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import net from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { CLAUDE_REGION_V1, CLAUDE_REGIONS_AS_OF, toUuid, uuidToBase62 } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const GATEWAY_TOKEN = `runner-region-check-gateway-${randomUUID()}`;
/** Cloudflare's edges, as TRUSTED_PROXIES names them; the runner's own address, which it does not. */
const EDGE = '198.51.100.7';
const EDGE6 = '2001:db8:cf::7';
const ORIGIN = '203.0.113.24';
const CAPABLE = { 'x-orbit-runner-capabilities': `cursor-key-check/v1,${CLAUDE_REGION_V1}` };
const DECIDED_KEYS = ['blockedChecks', 'checkedAt', 'country', 'decidedAt', 'name', 'regionCode', 'verdict', 'viaProxy'];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test('the Claude region check: trusted headers only, kept without an address, read as the effective verdict, checked again on request', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await sql.query(`UPDATE "runner_link_switch" SET "required" = false WHERE "id" = 1`).catch(() => undefined);
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the production apiserver, behind "Cloudflare", with the runner link's internal listener ──────────────────────────
  const { privateKey } = generateKeyPairSync('ed25519');
  const signingKey = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64');
  const internalPort = await freePort();
  const jwtSecret = `runner-region-check-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, {
    TRUSTED_PROXIES: '198.51.100.0/24, 2001:db8:cf::/48',
    RUNNER_LINK_SIGNING_KEY: signingKey,
    RUNNER_LINK_URL: 'wss://link.runner-region-check.invalid',
    RUNNER_LINK_GATEWAY_TOKEN: GATEWAY_TOKEN,
    RUNNER_LINK_INTERNAL_PORT: String(internalPort),
    RUNNER_LINK_INTERNAL_HOST: '127.0.0.1',
  });
  const linkListener: Apiserver = { ...server, port: internalPort };
  const jwt = new JwtService({ secret: jwtSecret });
  const api = (method: string, path: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body, headers);
  const expect = (reply: Reply, status: number, what: string) => {
    assert.equal(reply.status, status, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };

  /** A person of this run, signed in. */
  const person = async (name: string) => {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@runner-region-check.invalid`;
    await db.user.create({ data: { id, email, name, role: 'MEMBER', passwordHash: hashPassword(`${name}-password-1`) } });
    return { id, login: await jwt.signAsync({ sub: id, email }) };
  };
  const owner = await person('owner');
  const stranger = await person('stranger');
  /** A machine of the owner's, never heard from until it beats. */
  const machine = async (name: string) => {
    const id = randomUUID();
    const token = `runner-region-check-${name}-${randomUUID()}`;
    await db.runner.create({ data: { id, ownerId: owner.id, name: `${name} ${RUN}`, tokenHash: sha256(token) } });
    return { id, token };
  };

  /** One check, with the headers the hop in front of the apiserver would send. */
  const check = (runner: { token: string }, headers: Record<string, string>, viaProxy = '0') =>
    api('GET', `/runner/region-check?viaProxy=${viaProxy}`, runner.token, undefined, headers);
  /** What the gateway sends for a request that came through a Cloudflare edge, with Cloudflare's two headers. */
  const throughEdge = (country?: string, regionCode?: string, edge = EDGE): Record<string, string> => ({
    'x-real-ip': edge,
    'x-forwarded-for': `${ORIGIN}, ${edge}`,
    ...(country === undefined ? {} : { 'cf-ipcountry': country }),
    ...(regionCode === undefined ? {} : { 'cf-region-code': regionCode }),
  });
  const answerOf = async (runner: { token: string }, headers: Record<string, string>, viaProxy = '0') =>
    expect(await check(runner, headers, viaProxy), 200, `a check with ${JSON.stringify(headers)}`);
  const unknown = (viaProxy = false) => ({ verdict: 'unknown', country: null, regionCode: null, name: null, viaProxy, asOf: CLAUDE_REGIONS_AS_OF });
  /** runner.region as stored, read through Prisma. */
  const stored = async (runner: { id: string }) =>
    (await db.runner.findUniqueOrThrow({ where: { id: runner.id }, select: { region: true } })).region as Record<string, unknown> | null;
  const requestedAtOf = async (runner: { id: string }) =>
    (await db.runner.findUniqueOrThrow({ where: { id: runner.id }, select: { regionCheckRequestedAt: true } })).regionCheckRequestedAt;
  /** One HTTPS heartbeat, declaring the capability or not. */
  const beat = async (runner: { token: string }, capable = true) =>
    expect(await api('POST', '/runner/heartbeat', runner.token, { status: 'ONLINE', idleCapacity: 1 }, capable ? CAPABLE : {}), 201, 'a heartbeat');

  await t.test('1. Cloudflare\'s headers decide only on a request a trusted proxy passed on', async () => {
    const forged = await machine('forged');
    // From the runner's own address, as it would reach an origin with no CDN in front: the client's own words.
    assert.deepEqual(await answerOf(forged, { 'x-real-ip': ORIGIN, 'cf-ipcountry': 'CN' }), unknown());
    assert.deepEqual(await answerOf(forged, { 'x-real-ip': ORIGIN, 'cf-ipcountry': 'UA', 'cf-region-code': '43' }, '1'), unknown(true));
    // Behind a forged X-Forwarded-For that names an edge: the hop nginx saw is still the runner.
    assert.deepEqual(await answerOf(forged, { 'x-real-ip': ORIGIN, 'x-forwarded-for': EDGE, 'cf-ipcountry': 'RU' }), unknown());
    // With no X-Real-IP at all, the hop is the socket's peer: this spec's own connection.
    assert.deepEqual(await answerOf(forged, { 'cf-ipcountry': 'IR' }), unknown());
    assert.equal(await stored(forged), null, 'an unknown answer keeps nothing where no check has decided');

    const trusted = await machine('trusted');
    assert.deepEqual(await answerOf(trusted, throughEdge('SG')), {
      verdict: 'allowed', country: 'SG', regionCode: null, name: 'Singapore', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
    });
    assert.deepEqual(await answerOf(trusted, throughEdge('TW', undefined, EDGE6), '1'), {
      verdict: 'allowed', country: 'TW', regionCode: null, name: 'Taiwan', viaProxy: true, asOf: CLAUDE_REGIONS_AS_OF,
    });
    assert.deepEqual(await answerOf(trusted, throughEdge('CN')), {
      verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
    });
    // Cloudflare's no-data and Tor codes, and no country at all, cannot decide.
    for (const code of ['XX', 'T1', undefined]) assert.deepEqual(await answerOf(trusted, throughEdge(code)), unknown(), String(code));
    // Ukraine is decided by its region: an excluded one is blocked under its own name, any other allowed, none unknown.
    assert.deepEqual(await answerOf(trusted, throughEdge('UA', '43')), {
      verdict: 'blocked', country: 'UA', regionCode: 'UA-43', name: 'Crimea', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
    });
    assert.deepEqual(await answerOf(trusted, throughEdge('UA', 'UA-40')), {
      verdict: 'blocked', country: 'UA', regionCode: 'UA-40', name: 'Sevastopol', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
    });
    assert.deepEqual(await answerOf(trusted, throughEdge('UA', '30')), {
      verdict: 'allowed', country: 'UA', regionCode: 'UA-30', name: 'Ukraine', viaProxy: false, asOf: CLAUDE_REGIONS_AS_OF,
    });
    assert.deepEqual(await answerOf(trusted, throughEdge('UA')), unknown());
    // The last decided answer is what is kept.
    assert.deepEqual(
      { ...(await stored(trusted)), decidedAt: undefined, checkedAt: undefined },
      { verdict: 'allowed', country: 'UA', regionCode: 'UA-30', name: 'Ukraine', viaProxy: false, decidedAt: undefined, checkedAt: undefined, blockedChecks: 0 },
    );
    // Without the runner's credential there is no check.
    assert.equal((await api('GET', '/runner/region-check?viaProxy=0', undefined, undefined, throughEdge('SG'))).status, 401);
  });

  await t.test('2. an unknown answer moves checkedAt alone; blockedChecks counts and resets; no address is kept', async () => {
    const runner = await machine('stored');
    await answerOf(runner, throughEdge('CN'));
    const first = await stored(runner);
    assert.deepEqual(Object.keys(first ?? {}).sort(), DECIDED_KEYS);
    assert.deepEqual({ ...first, decidedAt: undefined, checkedAt: undefined }, {
      verdict: 'blocked', country: 'CN', regionCode: null, name: 'mainland China', viaProxy: false, blockedChecks: 1,
      decidedAt: undefined, checkedAt: undefined,
    });
    assert.equal(first!.decidedAt, first!.checkedAt, 'a decided check is decided and checked at once');

    await sleep(5);
    await answerOf(runner, throughEdge('CN'), '1');
    const second = await stored(runner);
    assert.equal(second!.blockedChecks, 2, 'two blocked checks in a row');
    assert.equal(second!.viaProxy, true);
    assert.ok(Date.parse(second!.decidedAt as string) > Date.parse(first!.decidedAt as string), 'decidedAt moves with a decided check');

    // Unknown, from an edge (XX) and from a hop nobody trusts: checkedAt moves, every decided field stays.
    for (const headers of [throughEdge('XX'), { 'x-real-ip': ORIGIN, 'cf-ipcountry': 'SG' }]) {
      await sleep(5);
      const before = await stored(runner);
      await answerOf(runner, headers);
      const after = await stored(runner);
      assert.ok(Date.parse(after!.checkedAt as string) > Date.parse(before!.checkedAt as string), 'checkedAt moves');
      assert.deepEqual({ ...after, checkedAt: undefined }, { ...before, checkedAt: undefined }, 'and nothing else does');
    }

    await answerOf(runner, throughEdge('RU'));
    assert.deepEqual([(await stored(runner))!.blockedChecks, (await stored(runner))!.name], [3, 'Russia'],
      'an unknown answer between blocked ones does not break the count');
    // Checks arriving together are each counted: one statement each.
    await Promise.all(Array.from({ length: 5 }, () => answerOf(runner, throughEdge('CN'))));
    assert.equal((await stored(runner))!.blockedChecks, 8);
    await answerOf(runner, throughEdge('SG'));
    assert.deepEqual([(await stored(runner))!.verdict, (await stored(runner))!.blockedChecks], ['allowed', 0], 'an allowed check resets it');
    await answerOf(runner, throughEdge('UA', '43'), '1');
    const last = await stored(runner);
    assert.deepEqual([last!.verdict, last!.regionCode, last!.blockedChecks], ['blocked', 'UA-43', 1], 'and the next blocked one counts from one');
    assert.deepEqual(Object.keys(last!).sort(), DECIDED_KEYS, 'the eight fields and nothing else');

    // No address anywhere in the runner's row, in any spelling it was sent in.
    const row = (await sql.query(`SELECT to_jsonb(r)::text AS row FROM "runner" r WHERE r."id" = $1`, [runner.id])).rows[0].row as string;
    for (const address of [EDGE, EDGE6, '2001:db8:cf:0:0:0:0:7', ORIGIN, '127.0.0.1']) {
      assert.equal(row.includes(address), false, `the runner row holds ${address}`);
    }
  });

  await t.test('3. the runner list and detail carry the effective verdict, and null without claude-region/v1', async () => {
    const regionOf = async (runner: { id: string }) => {
      const listed = expect(await api('GET', '/runners', owner.login), 200, 'the runner list') as Array<{ id: string; region: unknown }>;
      const row = listed.find((r) => toUuid(r.id) === runner.id);
      assert.ok(row, 'the runner is listed');
      const detail = expect(await api('GET', `/runners/${uuidToBase62(runner.id)}`, owner.login), 200, 'the runner');
      assert.deepEqual(detail.region, row.region, 'the detail reads as the list does');
      return row.region as Record<string, unknown> | null;
    };
    const runner = await machine('listed');
    await beat(runner);
    assert.equal(await regionOf(runner), null, 'no check has decided yet');
    await answerOf(runner, throughEdge('HK'), '1');
    const kept = await stored(runner);
    assert.deepEqual(await regionOf(runner), {
      verdict: 'blocked', country: 'HK', regionCode: null, name: 'Hong Kong', viaProxy: true, checkedAt: kept!.checkedAt,
    });
    // Decided 25 hours ago: still stored blocked, read allowed.
    const dayOld = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await db.runner.update({ where: { id: runner.id }, data: { region: { ...kept, decidedAt: dayOld } as never } });
    assert.equal((await regionOf(runner))?.verdict, 'allowed');
    assert.equal((await stored(runner))!.verdict, 'blocked');
    // A process that does not declare the capability is never gated, whatever the row holds.
    await db.runner.update({ where: { id: runner.id }, data: { region: kept as never } });
    await beat(runner, false);
    assert.equal(await regionOf(runner), null);
    await beat(runner);
    assert.equal((await regionOf(runner))?.verdict, 'blocked', 'declared again, the row reads again');
  });

  await t.test('4. Check again reaches the runner in a heartbeat answer, over HTTPS and over the link, until a check answers it', async () => {
    const runner = await machine('again');
    const ask = (who = owner.login, id = runner.id) => api('POST', `/runners/${uuidToBase62(id)}/region-check`, who);
    // Refused while it is offline: it has never beaten.
    assert.match(expect(await ask(), 400, 'Check again offline').message, /offline/);
    // Online, but too old to check.
    await beat(runner, false);
    assert.match(expect(await ask(), 400, 'Check again too old').message, /too old to check its Claude region/);
    // Another account's runner is no runner at all.
    expect(await ask(stranger.login), 404, 'Check again by a stranger');
    assert.equal(await requestedAtOf(runner), null, 'nothing was asked');

    await beat(runner);
    const asked = expect(await ask(), 201, 'Check again');
    assert.equal((await requestedAtOf(runner))?.toISOString(), asked.requestedAt);
    // Over HTTPS: every answer carries it while it waits, and only to a process that declares the capability.
    for (let i = 0; i < 2; i += 1) assert.deepEqual((await beat(runner)).regionCheckRequest, { requestedAt: asked.requestedAt });
    assert.equal((await beat(runner, false)).regionCheckRequest, undefined, 'not to a process that would not check');

    // Over the link: the gateway forwards a beat to the internal listener with the runner's link token.
    const leaseOwner = randomUUID();
    const minted = expect(await api('POST', '/runner/link-token', runner.token, { leaseOwner }), 200, 'minting a link token');
    const viaLink = (path: string, method: string, body: unknown, n: number) =>
      call(linkListener, method, `/api${path}`, GATEWAY_TOKEN, body, {
        'x-orbit-runner-link-token': minted.token, 'x-orbit-link-request-id': `r:${leaseOwner}:${n}`, ...CAPABLE,
      });
    const linkBeat = async (n: number) => {
      const reply = await viaLink('/runner/heartbeat', 'POST', { leaseOwner, status: 'ONLINE', idleCapacity: 1 }, n);
      assert.ok(reply.status === 200 || reply.status === 201, `a link heartbeat: ${reply.status} ${reply.text}`);
      return reply.json;
    };
    for (let n = 0; n < 2; n += 1) {
      const answer = await linkBeat(n);
      assert.deepEqual(answer.regionCheckRequest, { requestedAt: asked.requestedAt }, `link beat ${n}: ${JSON.stringify(answer)}`);
      assert.ok(answer.linkHints, 'a link call\'s answer, which the gateway parts into reconcile_json and its hints');
    }

    // A check at or after the request answers it, whatever it decided; then no answer carries it, by either road.
    assert.deepEqual(await answerOf(runner, { 'x-real-ip': ORIGIN }), unknown());
    assert.equal(await requestedAtOf(runner), null);
    assert.equal((await beat(runner)).regionCheckRequest, undefined);
    for (let n = 2; n < 5; n += 1) assert.equal((await linkBeat(n)).regionCheckRequest, undefined, `link beat ${n}`);

    // A request newer than the check that arrives stands; one no check answered in ten minutes is no longer handed out.
    const later = new Date(Date.now() + 60_000);
    await db.runner.update({ where: { id: runner.id }, data: { regionCheckRequestedAt: later } });
    await answerOf(runner, throughEdge('SG'));
    assert.equal((await requestedAtOf(runner))?.toISOString(), later.toISOString(), 'a check before the request does not answer it');
    assert.deepEqual((await beat(runner)).regionCheckRequest, { requestedAt: later.toISOString() });
    await db.runner.update({ where: { id: runner.id }, data: { regionCheckRequestedAt: new Date(Date.now() - 11 * 60_000) } });
    assert.equal((await beat(runner)).regionCheckRequest, undefined, 'eleven minutes on, it is no longer handed out');
  });

  await t.test('5. a link call to the route is unknown, whatever its headers say', async () => {
    const runner = await machine('linked');
    const leaseOwner = randomUUID();
    const minted = expect(await api('POST', '/runner/link-token', runner.token, { leaseOwner }), 200, 'minting a link token');
    const reply = await call(linkListener, 'GET', '/api/runner/region-check?viaProxy=0', GATEWAY_TOKEN, undefined, {
      'x-orbit-runner-link-token': minted.token, 'x-orbit-link-request-id': `r:${leaseOwner}:region`, ...throughEdge('CN'),
    });
    assert.deepEqual(expect(reply, 200, 'a link call to the region check'), unknown());
    assert.equal(await stored(runner), null);
  });

  await t.test('6. the route answers while RUNNER_LINK_REQUIRED is on', async () => {
    const runner = await machine('required');
    await sql.query(
      `INSERT INTO "runner_link_switch" ("id", "required", "updated_at") VALUES (1, true, now())
       ON CONFLICT ("id") DO UPDATE SET "required" = true, "updated_at" = now()`,
    );
    // The switch is read again at most a second later (RUNNER_LINK_SWITCH_TTL_MS): wait for a daemon route to say so.
    const started = Date.now();
    for (;;) {
      const me = await api('GET', '/runner/me', runner.token);
      if (me.status === 426) break;
      assert.ok(Date.now() - started < 10_000, `GET /runner/me still answers ${me.status}: ${me.text}`);
      await sleep(100);
    }
    assert.equal((await api('POST', '/runner/heartbeat', runner.token, { status: 'ONLINE' }, CAPABLE)).status, 426, 'the daemon\'s beat is refused');
    assert.deepEqual(await answerOf(runner, throughEdge('SG'), '1'), {
      verdict: 'allowed', country: 'SG', regionCode: null, name: 'Singapore', viaProxy: true, asOf: CLAUDE_REGIONS_AS_OF,
    });
    assert.equal((await stored(runner))!.country, 'SG', 'and kept');
    await sql.query(`UPDATE "runner_link_switch" SET "required" = false WHERE "id" = 1`);
  });
});
