/**
 * `orbit register` through the browser, held against the production apiserver — `build/main.js`, the
 * whole AppModule — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty. What it
 * is held to:
 *
 *   (1) the approval page reads the request signed in — the machine's name, host and labels, PENDING,
 *       when it expires (ten minutes after it started), no runner yet and no same-name runner — while
 *       the CLI's poll, with no credential, answers pending;
 *   (2) approving mints the runner and answers its id; the next poll hands the CLI that runner's
 *       credential, once; the page then answers APPROVED with the runner's id; approving again is
 *       answered as it stands, and denying it is 409;
 *   (3) denying mints nothing and the CLI's poll answers denied, even past the ten minutes; approving a
 *       denied request is 409, and denying it again is answered as it stands;
 *   (4) a request decided by one account is 404 to every other — its page, approval and denial;
 *   (5) a runner of the same name already on the account: the page says so and when it was last heard
 *       from, and approving re-issues that runner's credential instead of adding a second runner;
 *   (6) a request past its ten minutes polls expired, and its page, approval and denial are 404;
 *   (7) the page says where the request came from — the person behind a trusted proxy, read from
 *       X-Forwarded-For past the proxies TRUSTED_PROXIES names, not the proxy, nor what the person wrote
 *       into the header — and whether the page itself is read from that address;
 *   (8) X-Forwarded-For from a peer TRUSTED_PROXIES does not name is not read, and an internal address
 *       (a proxy in front that it does not name) is never called the same network;
 *   (9) an IPv6 requester, and an IPv4 one a dual-stack socket names as IPv4-mapped IPv6, each kept and
 *       compared in one spelling;
 *  (10) a machine just approved reads offline, never heard from, until its own first heartbeat, which
 *       brings it online with what it declares; re-registering one neither revives it nor moves its
 *       last beat.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-device-enrollment.pg.spec.ts
 *
 * Not destructive: every row belongs to a user this run creates or to a request it starts.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** An answer's runner id in the one spelling the rows use: the API hands ids out base62. */
const runnerOf = (id: string | null) => (id === null ? null : toUuid(id));
/** An approval's answer, its runner id in the rows' spelling and without the public-id echo beside it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const approval = ({ runnerId, runnerPublicId: _echo, ...rest }: any) => ({ ...rest, runnerId: runnerOf(runnerId) });

test('orbit register through the browser: approved or denied signed in, the CLI told either way, decided once, and closed to every other account', {
  skip: !URL, concurrency: 1, timeout: 600_000,
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

  const jwtSecret = `runner-device-enrollment-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret });
  /** A user of this run, signed in. Each case has its own: the page's lookups are throttled per user. */
  async function user(name: string) {
    const id = randomUUID();
    const email = `${name}-${RUN}-${id}@runner-device-enrollment.invalid`;
    await db.user.create({ data: { id, email, name, role: 'MEMBER', passwordHash: hashPassword(`${name}-password-1`) } });
    return { id, login: await jwt.signAsync({ sub: id, email }) };
  }
  // 198.51.100.0/24 and 2001:db8:cf::/48 stand for a CDN's edges in front of the gateway.
  server = await startApiserver(url, jwtSecret, { TRUSTED_PROXIES: '198.51.100.0/24, 2001:db8:cf::/48' });

  const api = (method: string, path: string, bearer?: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> =>
    call(server!, method, `/api${path}`, bearer, body, headers);
  const expect = (reply: Reply, status: number, what: string) => {
    assert.equal(reply.status, status, `${what} answered ${reply.status}: ${reply.text}`);
    return reply.json;
  };
  /** `orbit register` from the spec's own connection, or, given `via`, through the proxies those headers name. */
  const start = async (name: string, via?: Record<string, string>) =>
    expect(
      await api('POST', '/runner/device/start', undefined, { name, hostname: `${name}-host`, labels: ['gpu'], maxConcurrent: 4, version: '0.1.0' }, via),
      201,
      `starting ${name}`,
    );
  const poll = async (deviceCode: string) => expect(await api('POST', '/runner/device/poll', undefined, { deviceCode }), 200, 'polling');
  const page = (bearer: string, userCode: string, via?: Record<string, string>) =>
    api('GET', `/runners/device/${encodeURIComponent(userCode)}`, bearer, undefined, via);
  /** What the gateway sends behind a CDN edge: the edge as X-Real-IP, the chain with the edge appended. */
  const viaEdge = (edge: string, chain: string) => ({ 'x-real-ip': edge, 'x-forwarded-for': `${chain}, ${edge}` });
  const requesterIpOf = async (userCode: string) =>
    (await sql.query('SELECT requester_ip FROM device_enrollment WHERE user_code = $1', [userCode])).rows[0].requester_ip;
  const decide = (bearer: string, userCode: string, decision: 'approve' | 'deny') =>
    api('POST', `/runners/device/${encodeURIComponent(userCode)}/${decision}`, bearer);
  const runnersOf = async (owner: { id: string }) =>
    (await sql.query('SELECT id, name, token_hash FROM runner WHERE owner_id = $1 ORDER BY enrolled_at', [owner.id])).rows;
  const machine = (what: string) => `${what}-${RUN}`;

  await t.test('(1) the page reads the request signed in while the CLI polls pending', async () => {
    const owner = await user('reader');
    const before = Date.now();
    const started = await start(machine('reader'));
    const read = expect(await page(owner.login, started.userCode), 200, 'the page');
    assert.equal(read.userCode, started.userCode);
    assert.equal(read.name, machine('reader'));
    assert.equal(read.hostname, `${machine('reader')}-host`);
    assert.deepEqual(read.labels, ['gpu']);
    assert.equal(read.status, 'PENDING');
    assert.equal(read.nameConflict, false);
    assert.equal(read.existingLastSeenAt, null);
    assert.equal(read.runnerId, null);
    // From the spec's own connection, which a dual-stack listener names ::ffff:127.0.0.1: kept as people write
    // it, and, loopback being internal, not called the same network although the page is read from it too.
    assert.equal(read.requesterIp, '127.0.0.1');
    assert.equal(read.sameNetwork, false);
    const expiresIn = new Date(read.expiresAt).getTime() - before;
    assert.ok(expiresIn > 590_000 && expiresIn <= 610_000, `expires ${expiresIn} ms after it started`);
    assert.equal((await poll(started.deviceCode)).status, 'pending');
  });

  await t.test('(2) approving mints the runner, the next poll hands the CLI its credential once, and the decision stands', async () => {
    const owner = await user('approver');
    const started = await start(machine('approved'));
    const approved = expect(await decide(owner.login, started.userCode, 'approve'), 201, 'approving');
    const [runner] = await runnersOf(owner);
    assert.deepEqual(approval(approved), { ok: true, name: machine('approved'), replaced: false, runnerId: runner.id });

    const collected = await poll(started.deviceCode);
    assert.equal(collected.status, 'approved');
    assert.equal(runnerOf(collected.runnerId), runner.id);
    assert.equal(sha256(collected.runnerToken), runner.token_hash, 'the credential handed over is the runner\'s');
    assert.equal((await poll(started.deviceCode)).status, 'pending', 'the credential is handed over once');

    const read = expect(await page(owner.login, started.userCode), 200, 'the page after approving');
    assert.equal(read.status, 'APPROVED');
    assert.equal(runnerOf(read.runnerId), runner.id);
    assert.deepEqual(expect(await decide(owner.login, started.userCode, 'approve'), 201, 'approving again'), approved);
    const denied = expect(await decide(owner.login, started.userCode, 'deny'), 409, 'denying an approved request');
    assert.equal(denied.code, 'DEVICE_ENROLLMENT_DECIDED');
    assert.equal((await runnersOf(owner)).length, 1, 'one runner, minted once');
  });

  await t.test('(3) denying mints nothing, the CLI polls denied even past the ten minutes, and the decision stands', async () => {
    const owner = await user('denier');
    const started = await start(machine('denied'));
    assert.deepEqual(expect(await decide(owner.login, started.userCode, 'deny'), 201, 'denying'), { ok: true, name: machine('denied') });
    assert.equal((await poll(started.deviceCode)).status, 'denied');
    assert.equal(expect(await page(owner.login, started.userCode), 200, 'the page after denying').status, 'DENIED');
    const approving = expect(await decide(owner.login, started.userCode, 'approve'), 409, 'approving a denied request');
    assert.equal(approving.code, 'DEVICE_ENROLLMENT_DECIDED');
    assert.match(approving.message, /denied/);
    assert.deepEqual(expect(await decide(owner.login, started.userCode, 'deny'), 201, 'denying again'), { ok: true, name: machine('denied') });
    assert.deepEqual(await runnersOf(owner), [], 'nothing minted');

    await sql.query("UPDATE device_enrollment SET expires_at = now() - interval '1 minute' WHERE user_code = $1", [started.userCode]);
    assert.equal((await poll(started.deviceCode)).status, 'denied', 'a denial says so past the ten minutes');
  });

  await t.test('(4) a decided request is 404 to every other account', async () => {
    const [approver, denier, other] = [await user('decider-a'), await user('decider-d'), await user('stranger')];
    const approvedOne = await start(machine('decided-a'));
    const deniedOne = await start(machine('decided-d'));
    expect(await decide(approver.login, approvedOne.userCode, 'approve'), 201, 'approving');
    expect(await decide(denier.login, deniedOne.userCode, 'deny'), 201, 'denying');
    for (const { userCode } of [approvedOne, deniedOne]) {
      expect(await page(other.login, userCode), 404, 'another account\'s page');
      expect(await decide(other.login, userCode, 'approve'), 404, 'another account\'s approval');
      expect(await decide(other.login, userCode, 'deny'), 404, 'another account\'s denial');
    }
    assert.deepEqual(await runnersOf(other), []);
  });

  await t.test('(5) a same-name runner: the page says when it was last heard from, and approving re-issues its credential', async () => {
    const owner = await user('reregister');
    const lastSeen = new Date(Date.now() - 3 * 86_400_000);
    const existing = await db.runner.create({
      data: { ownerId: owner.id, name: machine('devbox'), tokenHash: sha256(`old-${RUN}`), lastHeartbeatAt: lastSeen },
    });
    const started = await start(machine('devbox'));
    const read = expect(await page(owner.login, started.userCode), 200, 'the page');
    assert.equal(read.nameConflict, true);
    assert.equal(new Date(read.existingLastSeenAt).getTime(), lastSeen.getTime());

    const approved = expect(await decide(owner.login, started.userCode, 'approve'), 201, 'approving');
    assert.deepEqual(approval(approved), { ok: true, name: machine('devbox'), replaced: true, runnerId: existing.id });
    const collected = await poll(started.deviceCode);
    const runners = await runnersOf(owner);
    assert.equal(runners.length, 1, 'no second runner');
    assert.equal(runners[0].token_hash, sha256(collected.runnerToken), 'the old credential is replaced');
  });

  await t.test('(6) a request past its ten minutes polls expired, and its page, approval and denial are 404', async () => {
    const owner = await user('late');
    const started = await start(machine('late'));
    await sql.query("UPDATE device_enrollment SET expires_at = now() - interval '1 minute' WHERE user_code = $1", [started.userCode]);
    assert.equal((await poll(started.deviceCode)).status, 'expired');
    expect(await page(owner.login, started.userCode), 404, 'the page');
    expect(await decide(owner.login, started.userCode, 'approve'), 404, 'the approval');
    expect(await decide(owner.login, started.userCode, 'deny'), 404, 'the denial');
    assert.deepEqual(await runnersOf(owner), []);
  });

  await t.test('(7) the page says where the request came from: the person behind a trusted proxy, and whether the page is read from there', async () => {
    const owner = await user('from');
    // The person at 203.0.113.24 wrote 203.0.113.66 into their own X-Forwarded-For; the edge appended them.
    const started = await start(machine('from'), viaEdge('198.51.100.7', '203.0.113.66, 203.0.113.24'));
    assert.equal(await requesterIpOf(started.userCode), '203.0.113.24', 'the person, not the edge nor what they wrote');

    const same = expect(await page(owner.login, started.userCode, viaEdge('198.51.100.9', '203.0.113.24')), 200, 'the page from the same address');
    assert.equal(same.requesterIp, '203.0.113.24');
    assert.equal(same.sameNetwork, true, 'read from the address that started it, through another edge');

    const elsewhere = expect(await page(owner.login, started.userCode, viaEdge('198.51.100.9', '192.0.2.50')), 200, 'the page from elsewhere');
    assert.equal(elsewhere.requesterIp, '203.0.113.24');
    assert.equal(elsewhere.sameNetwork, false);
    // Claiming the requester's address in a header that no trusted proxy passed on does not make it the same.
    const claimed = expect(await page(owner.login, started.userCode, { 'x-forwarded-for': '203.0.113.24' }), 200, 'the page claiming it');
    assert.equal(claimed.sameNetwork, false);
  });

  await t.test('(8) X-Forwarded-For from a peer TRUSTED_PROXIES does not name is not read, and an internal address is never the same network', async () => {
    const owner = await user('untrusted');
    const fromPeer = await start(machine('peer'), { 'x-real-ip': '192.0.2.77', 'x-forwarded-for': '203.0.113.24, 192.0.2.77' });
    assert.equal(await requesterIpOf(fromPeer.userCode), '192.0.2.77', 'the peer that reached the gateway');
    const fromSocket = await start(machine('socket'), { 'x-forwarded-for': '203.0.113.24' });
    assert.equal(await requesterIpOf(fromSocket.userCode), '127.0.0.1', 'the connection itself, its header unread');

    // A TLS proxy on the host that TRUSTED_PROXIES does not name: every request comes from its address.
    const behindProxy = await start(machine('hostproxy'), { 'x-real-ip': '172.17.0.1', 'x-forwarded-for': '203.0.113.24, 172.17.0.1' });
    const read = expect(await page(owner.login, behindProxy.userCode, { 'x-real-ip': '172.17.0.1', 'x-forwarded-for': '192.0.2.50, 172.17.0.1' }), 200, 'the page');
    assert.equal(read.requesterIp, '172.17.0.1');
    assert.equal(read.sameNetwork, false, 'one proxy address for everyone says nothing about where either came from');
  });

  await t.test('(9) an IPv6 requester, and an IPv4 one named as IPv4-mapped IPv6, each kept and compared in one spelling', async () => {
    const owner = await user('ipv6');
    const v6 = await start(machine('v6'), viaEdge('2001:db8:cf::7', '2001:DB8:ABCD:0:0:0:0:24'));
    assert.equal(await requesterIpOf(v6.userCode), '2001:db8:abcd::24');
    const sameV6 = expect(await page(owner.login, v6.userCode, viaEdge('198.51.100.7', '2001:db8:abcd::24')), 200, 'the page from the same IPv6 address');
    assert.equal(sameV6.requesterIp, '2001:db8:abcd::24');
    assert.equal(sameV6.sameNetwork, true);
    const otherV6 = expect(await page(owner.login, v6.userCode, viaEdge('2001:db8:cf::7', '2001:db8:abcd::25')), 200, 'the page from its neighbour');
    assert.equal(otherV6.sameNetwork, false);

    const mapped = await start(machine('mapped'), { 'x-real-ip': '::ffff:203.0.113.9' });
    assert.equal(await requesterIpOf(mapped.userCode), '203.0.113.9', 'no ::ffff: prefix');
    const sameV4 = expect(await page(owner.login, mapped.userCode, { 'x-real-ip': '203.0.113.9' }), 200, 'the page from the same IPv4 address');
    assert.equal(sameV4.requesterIp, '203.0.113.9');
    assert.equal(sameV4.sameNetwork, true);
  });

  await t.test('(10) a machine just approved is not online until its own heartbeat, and re-registering one revives nothing', async () => {
    const owner = await user('first-beat');
    const listed = async (runnerId: string) => {
      const list = expect(await api('GET', '/runners', owner.login), 200, 'the runner list');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return list.find((r: any) => toUuid(r.id) === runnerId);
    };
    const rowOf = async (runnerId: string) =>
      (await sql.query('SELECT status, last_heartbeat_at FROM runner WHERE id = $1', [runnerId])).rows[0];

    const started = await start(machine('first-beat'));
    const approved = approval(expect(await decide(owner.login, started.userCode, 'approve'), 201, 'approving'));
    const runnerId: string = approved.runnerId;
    const collected = await poll(started.deviceCode);
    assert.deepEqual(await rowOf(runnerId), { status: 'OFFLINE', last_heartbeat_at: null }, 'approving says nothing for the machine');
    const waiting = await listed(runnerId);
    assert.equal(waiting.online, false);
    assert.equal(waiting.lastHeartbeatAt, null);
    assert.deepEqual(waiting.capabilities, []);
    assert.equal(waiting.engines, null);
    const asking = expect(await api('POST', `/runners/${runnerId}/dir-probe`, owner.login, { path: '~/code' }), 400, 'asking before it beats');
    assert.match(asking.message, /offline/);
    assert.equal((await rowOf(runnerId)).status, 'OFFLINE');

    const beat = await api('POST', '/runner/heartbeat', collected.runnerToken, {
      status: 'ONLINE',
      engines: [{ engine: 'claude', installed: true, auth: 'no', version: '2.3.0' }],
    }, { 'x-orbit-runner-capabilities': 'dir-probe/v1' });
    assert.equal(beat.status, 201, beat.text);
    const connected = await listed(runnerId);
    assert.equal(connected.online, true, 'its first beat brings it online');
    assert.ok(connected.capabilities.includes('dir-probe/v1'), 'with what it declares');
    assert.deepEqual(connected.engines.map((e: { engine: string }) => e.engine), ['claude']);
    assert.ok(connected.lastHeartbeatAt);

    // Long silent: an approval is not a beat, whatever the row says about the machine. Its last beat is the real one.
    const heardLast = new Date(Date.now() - 3_600_000);
    await sql.query(
      `WITH cleared AS (DELETE FROM runner_presence WHERE runner_id = $1) UPDATE runner SET last_heartbeat_at = $2 WHERE id = $1`,
      [runnerId, heardLast],
    );
    assert.equal((await listed(runnerId)).online, false, 'silent for an hour');
    const again = await start(machine('first-beat'));
    assert.equal(approval(expect(await decide(owner.login, again.userCode, 'approve'), 201, 're-approving')).replaced, true);
    const reread = await listed(runnerId);
    assert.equal(reread.online, false, 'still offline after it is registered again');
    assert.equal(new Date(reread.lastHeartbeatAt).getTime(), heardLast.getTime(), 'and last heard from when it was');

    // Heard a moment ago: it reads as its beats say, as with a rotated credential, and ages out if nothing comes back.
    const heardNow = new Date(Date.now() - 10_000);
    await sql.query('UPDATE runner SET last_heartbeat_at = $2 WHERE id = $1', [runnerId, heardNow]);
    const third = await start(machine('first-beat'));
    expect(await decide(owner.login, third.userCode, 'approve'), 201, 're-approving');
    const still = await listed(runnerId);
    assert.equal(still.online, true);
    assert.equal(new Date(still.lastHeartbeatAt).getTime(), heardNow.getTime(), 'approving does not move a beat');
  });
});
