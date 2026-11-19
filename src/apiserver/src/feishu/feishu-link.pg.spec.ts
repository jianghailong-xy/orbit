/**
 * Every replica's long connection of every app, and the inbound inbox (docs/feishu-bot-design.md §4.4, §7.1; task
 * F0-2; migration 0492), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, TWO production
 * apiservers (`build/main.js`, two processes on one database), and one fake open platform both connect to
 * (feishu/test-support/fake-open-platform.ts), which speaks the SDK's long-connection protocol. What it is held to:
 *
 *   (1) 0492 made the two tables it describes, keyed as it says, and writes no row;
 *   (2) the inbox worker, in this process against the same database: a failure keeps its error and is retried, up to
 *       five claims, then given up on; two workers claiming at once take each row once (SKIP LOCKED); the purge
 *       deletes what was settled more than 7 days ago and nothing else;
 *   (3) an enabled app is connected once by EACH apiserver: two open connections on the platform, two CONNECTED
 *       feishu_link rows with different replicas, and either apiserver's GET /api/integrations/feishu answers
 *       `connectedReplicas: 2`, the bot's name, when it connected, and no error;
 *   (4) one event delivered twice — once down each process's connection — is processed once: one inbox row, one
 *       attempt, one "routed" line across both processes' logs, and both deliveries acknowledged with code 200; the
 *       same holds when both deliveries arrive at the same moment, and for a card callback, which is routed at once;
 *       the app's last_event_at is written;
 *   (5) an app whose stored secret Feishu refuses backs off on each process — 1, 2, 4 units of the base wait — with
 *       `Feishu error 10014: app secret invalid` in last_error and in each process's feishu_link row, and connects once
 *       the right secret is saved, clearing the error;
 *   (6) an app Feishu says is gone (the token trade's 10003) stops reconnecting on both processes: STOPPED, its error
 *       recorded, and no further endpoint request;
 *   (7) switched off, turned off by the administrators, or removed, an app is disconnected by both processes, and its
 *       feishu_link and inbox rows go with its removal;
 *   (8) no answer, log or row carries an App Secret or a tenant_access_token.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-link.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FEISHU_INBOX_MAX_ATTEMPTS, FeishuInboxService } from './feishu-inbox.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import type { FeishuRouter, InboundEvent } from './feishu-router';
import { FEISHU_TEST_TIME_SCALE_ENV, backoffMs, feishuTiming } from './feishu-timing';
import { FakeOpenPlatform, type FakeConnection } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-link-${randomUUID()}`;
// Every clock of the module 50 times faster, in this process and in both apiservers: the backoff starts at 1.2 s.
const SCALE = '50';
process.env[FEISHU_TEST_TIME_SCALE_ENV] = SCALE;
const TIMING = feishuTiming();
const ENDPOINT = '/callback/ws/endpoint';

const appId = () => `cli_${randomBytes(8).toString('hex')}`;
const secret = () => `secret-${randomUUID()}`;
/** X: connected throughout (3, 4, 7). W: its stored secret is wrong (5). Z: deleted from Feishu (6). I: the in-process inbox (2). */
const X = { platform: 'FEISHU' as const, appId: appId(), appSecret: secret(), botName: 'Orbit test bot' };
const W = { platform: 'FEISHU' as const, appId: appId(), appSecret: secret() };
const W_STORED_WRONG = secret();
const Z = { platform: 'FEISHU' as const, appId: appId(), appSecret: secret() };
const I = { platform: 'FEISHU' as const, appId: appId(), appSecret: secret() };
const SECRETS = [X.appSecret, W.appSecret, W_STORED_WRONG, Z.appSecret, I.appSecret];

/** Poll `probe` until it answers something truthy, or fail with `what` after `ms`. */
async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function message(eventId: string, chatType = 'p2p') {
  return {
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: '1794067200000', token: '' },
    event: {
      sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
      message: { message_id: `om_${eventId}`, chat_type: chatType, message_type: 'text', content: '{"text":"hello"}' },
    },
  };
}

test('Feishu long connections: one per app on every apiserver, and each event processed once wherever it lands', {
  skip: !URL, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  const servers: Apiserver[] = [];
  t.after(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  for (const app of [X, W, Z, I]) fake.addApp(app);
  const fakeUrl = await fake.start();
  const jwtSecret = `feishu-link-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  const run = randomUUID().slice(0, 8);

  async function account(name: string) {
    const id = randomUUID();
    const email = `feishu-link-${name}-${run}@feishu-link.invalid`;
    await db.user.create({ data: { id, email, name: `Feishu ${name}`, passwordHash: hashPassword(`password-${run}`), role: 'MEMBER' } });
    return { id, bearer: await jwt.signAsync({ sub: id, email }) };
  }
  const connect = (ownerId: string, app: { platform: 'FEISHU'; appId: string }, stored: string, enabled = true) =>
    db.feishuApp.create({ data: { ownerId, platform: app.platform, appId: app.appId, appSecretEnc: encryptSecret(stored), enabled } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const links = async (id: string): Promise<any[]> =>
    (await sql.query(`SELECT * FROM feishu_link WHERE app_id = $1 ORDER BY replica_id`, [id])).rows;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inbox = async (id: string, eventId: string): Promise<any[]> =>
    (await sql.query(`SELECT * FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2`, [id, eventId])).rows;
  const logs = () => servers.map((s) => s.output()).join('\n');
  const count = (text: string, needle: string) => text.split(needle).length - 1;
  const endpointRequests = (id: string) =>
    fake.requestsTo(ENDPOINT).filter((r) => (r.body as { AppID?: string } | null)?.AppID === id);

  await t.test('(1) 0492 made feishu_inbound_event and feishu_link, keyed as it says, and wrote no row', async () => {
    const applied = await sql.query(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0492_feishu_inbound_event'`);
    assert.deepEqual(applied.rows, [{ done: true }]);
    const indexes = (await sql.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('feishu_inbound_event', 'feishu_link') ORDER BY indexname`,
    )).rows.map((r) => r.indexname);
    assert.deepEqual(indexes, [
      'feishu_inbound_event_app_id_event_id_key',
      'feishu_inbound_event_pending_idx',
      'feishu_inbound_event_pkey',
      'feishu_link_pkey',
    ]);
    const fks = (await sql.query(
      `SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' AND conrelid IN ('feishu_inbound_event'::regclass, 'feishu_link'::regclass) ORDER BY conname`,
    )).rows;
    assert.deepEqual(fks, [
      { conname: 'feishu_inbound_event_app_id_fkey', confdeltype: 'c' },
      { conname: 'feishu_link_app_id_fkey', confdeltype: 'c' },
    ]);
    const rows = await sql.query(`SELECT (SELECT count(*) FROM feishu_inbound_event)::int AS e, (SELECT count(*) FROM feishu_link)::int AS l`);
    assert.deepEqual(rows.rows, [{ e: 0, l: 0 }]);
  });

  await t.test('(2) the inbox worker retries a failure, gives up after five claims, claims each row once, and purges after 7 days', async () => {
    const owner = await account('inbox');
    // Off, so neither apiserver (started later) connects it or competes for its rows once they run.
    await connect(owner.id, I, I.appSecret, false);
    const routed: string[] = [];
    let failuresLeft = new Map<string, number>([['ev-retry', 2], ['ev-hopeless', 99]]);
    const router = {
      async route(event: InboundEvent) {
        const left = failuresLeft.get(event.eventId) ?? 0;
        if (left > 0) {
          failuresLeft.set(event.eventId, left - 1);
          throw new Error(`stand-in failure of ${event.eventId}`);
        }
        routed.push(event.eventId);
        return null;
      },
    } as unknown as FeishuRouter;
    const prisma = db as unknown as PrismaService;
    const one = new FeishuInboxService(prisma, router);
    const two = new FeishuInboxService(prisma, router);
    const envelope = (eventId: string) => ({ schema: '2.0', header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: I.appId } });
    // record() wakes a worker of its own; the drains below are this spec's, so its kick is stopped from running.
    (one as unknown as { stopped: boolean }).stopped = true;
    for (const id of ['ev-retry', 'ev-hopeless']) assert.equal(await one.record(I.appId, envelope(id)), undefined);
    assert.equal(await one.record(I.appId, envelope('ev-retry')), undefined, 'a duplicate is acknowledged');
    assert.equal((await inbox(I.appId, 'ev-retry')).length, 1);

    for (let claim = 1; claim <= FEISHU_INBOX_MAX_ATTEMPTS + 1; claim++) {
      await one.drain();
      await sleep(TIMING.inboxPollMs * 2 ** claim + 50);
    }
    const [retried] = await inbox(I.appId, 'ev-retry');
    assert.equal(retried.attempts, 3, 'two failures, then processed on the third claim');
    assert.ok(retried.processed_at && retried.error === null);
    const [hopeless] = await inbox(I.appId, 'ev-hopeless');
    assert.equal(hopeless.attempts, FEISHU_INBOX_MAX_ATTEMPTS, 'given up on after five claims');
    assert.equal(hopeless.processed_at, null);
    assert.equal(hopeless.error, 'stand-in failure of ev-hopeless');
    assert.deepEqual(routed, ['ev-retry']);

    // Two workers draining forty rows at once: each row is routed exactly once.
    failuresLeft = new Map();
    routed.length = 0;
    const many = Array.from({ length: 40 }, (_, i) => `ev-many-${i}`);
    for (const id of many) await one.record(I.appId, envelope(id));
    await Promise.all([
      (async () => { while ((await one.drain()) > 0); })(),
      (async () => { while ((await two.drain()) > 0); })(),
    ]);
    assert.deepEqual([...routed].sort(), [...many].sort());
    const settled = await sql.query(
      `SELECT count(*)::int AS n FROM feishu_inbound_event WHERE app_id = $1 AND event_id LIKE 'ev-many-%' AND processed_at IS NOT NULL AND attempts = 1`,
      [I.appId],
    );
    assert.equal(settled.rows[0].n, 40);

    // The purge: settled more than 7 days ago goes; settled since, or still to be retried, stays.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await sql.query(`UPDATE feishu_inbound_event SET processed_at = $2 WHERE app_id = $1 AND event_id = 'ev-retry'`, [I.appId, eightDaysAgo]);
    await sql.query(`UPDATE feishu_inbound_event SET received_at = $2 WHERE app_id = $1 AND event_id = 'ev-hopeless'`, [I.appId, eightDaysAgo]);
    await one.record(I.appId, envelope('ev-pending'));
    await sql.query(`UPDATE feishu_inbound_event SET received_at = $2 WHERE app_id = $1 AND event_id = 'ev-pending'`, [I.appId, eightDaysAgo]);
    assert.equal(await one.purge(), 2);
    assert.equal((await inbox(I.appId, 'ev-retry')).length, 0);
    assert.equal((await inbox(I.appId, 'ev-hopeless')).length, 0);
    assert.equal((await inbox(I.appId, 'ev-pending')).length, 1, 'not processed and attempts left: kept');
    assert.equal((await inbox(I.appId, 'ev-many-0')).length, 1, 'processed today: kept');
    await sql.query(`DELETE FROM feishu_inbound_event WHERE app_id = $1`, [I.appId]);
  });

  const a = await account('a');
  await connect(a.id, X, X.appSecret);
  const env = { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE };
  servers.push(...(await Promise.all([startApiserver(url, jwtSecret, env), startApiserver(url, jwtSecret, env)])));
  let connections: FakeConnection[] = [];

  await t.test('(3) each apiserver holds one connection of the app, and both answer two connected replicas', async () => {
    connections = await until('two connections of X', () => {
      const open = fake.openConnections(X.appId);
      return open.length === 2 ? open : null;
    });
    const rows = await until('two CONNECTED feishu_link rows of X', async () => {
      const r = await links(X.appId);
      return r.length === 2 && r.every((l) => l.state === 'CONNECTED') ? r : null;
    });
    assert.notEqual(rows[0].replica_id, rows[1].replica_id);
    for (const server of servers) {
      const reply = await until('the bot name', async () => {
        const r = await call(server, 'GET', '/api/integrations/feishu', a.bearer);
        return r.json?.app?.botName ? r : null;
      });
      assert.equal(reply.status, 200);
      assert.equal(reply.json.app.connectedReplicas, 2);
      assert.equal(reply.json.app.botName, X.botName);
      assert.ok(reply.json.app.lastConnectedAt);
      assert.equal(reply.json.app.lastError, null);
    }
    await sleep(TIMING.reconcileMs * 4);
    assert.equal(fake.openConnections(X.appId).length, 2, 'reconciling does not open more');
  });

  await t.test('(4) one event delivered to both processes is processed once', async () => {
    const [first, second] = connections;
    // One after the other: Feishu's redelivery of an event it did not see acknowledged.
    const acks = [await fake.push(first, message('ev-twice')), await fake.push(second, message('ev-twice'))];
    assert.deepEqual(acks.map((x) => x.code), [200, 200]);
    const [row] = await until('ev-twice processed', async () => {
      const r = await inbox(X.appId, 'ev-twice');
      return r.length === 1 && r[0].processed_at ? r : null;
    });
    assert.equal(row.attempts, 1);
    assert.equal(row.event_type, 'im.message.receive_v1');
    assert.deepEqual(row.payload, message('ev-twice'));
    await sleep(TIMING.inboxPollMs * 10);
    assert.equal((await inbox(X.appId, 'ev-twice')).length, 1);
    // The app has no owner, so routing the message also logs its refusal (F1-2): once, since it is routed once.
    const refused = `feishu event ev-twice of app ${X.appId}: a direct message from someone other than the owner, refused`;
    assert.equal(count(logs(), refused), 1);
    assert.equal(count(logs(), 'feishu event ev-twice of app') - 1, 2, 'one route and one redelivery, across both processes');
    assert.equal(count(logs(), `feishu event ev-twice of app ${X.appId} routed as DIRECT_MESSAGE for account ${a.id}`), 1);
    assert.equal(count(logs(), 'feishu event ev-twice of app ' + X.appId + ' was delivered again'), 1);

    // At the same moment, down both connections, and once more down the first.
    const together = await Promise.all([fake.push(first, message('ev-race', 'group')), fake.push(second, message('ev-race', 'group'))]);
    assert.deepEqual(together.map((x) => x.code), [200, 200]);
    assert.equal((await fake.push(first, message('ev-race', 'group'))).code, 200);
    await until('ev-race processed', async () => (await inbox(X.appId, 'ev-race'))[0]?.processed_at);
    await sleep(TIMING.inboxPollMs * 10);
    assert.equal((await inbox(X.appId, 'ev-race')).length, 1);
    assert.equal((await inbox(X.appId, 'ev-race'))[0].attempts, 1);
    assert.equal(count(logs(), `feishu event ev-race of app ${X.appId} routed as GROUP_MENTION`), 1);

    // A card callback is routed as it arrives, its row inserted already claimed; the redelivery is not routed again.
    const card = {
      schema: '2.0',
      header: { event_id: 'ev-card', event_type: 'card.action.trigger', app_id: X.appId },
      event: { operator: { open_id: 'ou_owner' }, action: { value: { k: 'v' } }, context: { open_message_id: 'om_card' } },
    };
    assert.equal((await fake.push(second, card)).code, 200);
    const [cardRow] = await inbox(X.appId, 'ev-card');
    assert.ok(cardRow.processed_at, 'processed before the acknowledgement');
    assert.equal(cardRow.attempts, 1);
    assert.equal((await fake.push(first, card)).code, 200);
    assert.equal(count(logs(), `feishu event ev-card of app ${X.appId} routed as CARD_ACTION`), 1);

    const app = await db.feishuApp.findUniqueOrThrow({ where: { appId: X.appId } });
    assert.ok(app.lastEventAt, 'last_event_at written');
    // Both processes received events: the first delivery of ev-twice went to one, ev-card's to the other.
    const receivers = (await sql.query(`SELECT DISTINCT received_by FROM feishu_inbound_event WHERE app_id = $1`, [X.appId])).rows;
    assert.equal(receivers.length, 2);
  });

  await t.test('(5) a secret Feishu refuses backs off 1, 2, 4 units on each process, recorded, and recovers once saved again', async () => {
    const w = await account('w');
    await connect(w.id, W, W_STORED_WRONG);
    // Each process's row as first seen at each count of failures: how long after that moment its next attempt is due.
    // A row is polled every 50 ms, so the wait read is the backoff less at most a poll and a token trade.
    const seen = new Map<string, Map<number, number>>();
    await until('three failures on both processes', async () => {
      const now = Date.now();
      for (const row of await links(W.appId)) {
        if (row.state !== 'BACKOFF' || !row.next_attempt_at) continue;
        const of = seen.get(row.replica_id) ?? new Map<number, number>();
        if (!of.has(row.failures)) of.set(row.failures, new Date(row.next_attempt_at).getTime() - now);
        seen.set(row.replica_id, of);
      }
      return seen.size === 2 && [...seen.values()].every((m) => m.has(3)) ? true : null;
    }, 60_000);
    for (const [replica, waits] of seen) {
      for (const failures of [2, 3]) {
        const wait = waits.get(failures);
        assert.ok(wait !== undefined, `${replica}: failure ${failures} was seen`);
        const due = backoffMs(failures, TIMING);
        assert.ok(wait <= due + 20 && wait > due - 400, `${replica}: failure ${failures} waits ${wait}ms, not ${due}ms`);
      }
    }
    const rows = await links(W.appId);
    for (const row of rows) assert.equal(row.last_error, 'Feishu error 10014: app secret invalid');
    const app = await db.feishuApp.findUniqueOrThrow({ where: { appId: W.appId } });
    assert.equal(app.lastError, 'Feishu error 10014: app secret invalid');
    assert.equal(fake.openConnections(W.appId).length, 0);
    // The attempts themselves are spaced as the backoff says: 2 processes × 3 attempts, and a 4th each only after 4 units.
    assert.ok(endpointRequests(W.appId).length <= 8);

    await db.feishuApp.update({ where: { appId: W.appId }, data: { appSecretEnc: encryptSecret(W.appSecret) } });
    await until('W connected on both', () => fake.openConnections(W.appId).length === 2);
    await until('W error cleared', async () => (await db.feishuApp.findUniqueOrThrow({ where: { appId: W.appId } })).lastError === null);
    const reply = await until('W connected replicas', async () => {
      const r = await call(servers[0], 'GET', '/api/integrations/feishu', w.bearer);
      return r.json?.app?.connectedReplicas === 2 ? r : null;
    });
    assert.equal(reply.json.app.lastError, null);
  });

  await t.test('(6) an app Feishu says is gone stops reconnecting on both processes', async () => {
    const z = await account('z');
    await connect(z.id, Z, Z.appSecret);
    await until('Z connected on both', () => fake.openConnections(Z.appId).length === 2);
    fake.removeApp(Z.platform, Z.appId);
    fake.drop(Z.appId);
    const rows = await until('Z stopped on both', async () => {
      const r = await links(Z.appId);
      return r.length === 2 && r.every((l) => l.state === 'STOPPED') ? r : null;
    });
    for (const row of rows) assert.equal(row.last_error, 'Feishu error 10003: invalid param');
    const app = await db.feishuApp.findUniqueOrThrow({ where: { appId: Z.appId } });
    assert.equal(app.lastError, 'Feishu error 10003: invalid param');
    const asked = endpointRequests(Z.appId).length;
    await sleep(backoffMs(3, TIMING) + TIMING.reconcileMs * 3);
    assert.equal(endpointRequests(Z.appId).length, asked, 'no endpoint request after Feishu said the app is gone');
    const reply = await call(servers[1], 'GET', '/api/integrations/feishu', z.bearer);
    assert.equal(reply.json.app.connectedReplicas, 0);
  });

  await t.test('(7) switched off, turned off by the administrators, or removed, the app is disconnected by both', async () => {
    const off = await call(servers[0], 'PATCH', '/api/integrations/feishu', a.bearer, { enabled: false });
    assert.equal(off.status, 200);
    await until('X disconnected', () => fake.openConnections(X.appId).length === 0);
    await until('X feishu_link rows gone', async () => (await links(X.appId)).length === 0);
    assert.equal((await call(servers[1], 'GET', '/api/integrations/feishu', a.bearer)).json.app.connectedReplicas, 0);

    await call(servers[1], 'PATCH', '/api/integrations/feishu', a.bearer, { enabled: true });
    await until('X connected again', () => fake.openConnections(X.appId).length === 2);
    await sql.query(`INSERT INTO feishu_deployment_setting (id, allowed) VALUES (1, false) ON CONFLICT (id) DO UPDATE SET allowed = false`);
    await until('every app disconnected', () => fake.openConnections().length === 0);
    await sql.query(`UPDATE feishu_deployment_setting SET allowed = true WHERE id = 1`);
    await until('X connected once more', () => fake.openConnections(X.appId).length === 2);

    assert.ok((await sql.query(`SELECT count(*)::int AS n FROM feishu_inbound_event WHERE app_id = $1`, [X.appId])).rows[0].n > 0);
    const removed = await call(servers[0], 'DELETE', '/api/integrations/feishu', a.bearer);
    assert.equal(removed.status, 200);
    await until('X disconnected after removal', () => fake.openConnections(X.appId).length === 0);
    assert.equal((await sql.query(`SELECT count(*)::int AS n FROM feishu_inbound_event WHERE app_id = $1`, [X.appId])).rows[0].n, 0);
    await until('X links gone', async () => (await links(X.appId)).length === 0);
  });

  await t.test('(8) no log or stored row carries an App Secret or a tenant_access_token', async () => {
    assert.ok(fake.tenantAccessTokens.length > 0);
    const text = logs();
    const stored = JSON.stringify([
      ...(await sql.query(`SELECT * FROM feishu_link`)).rows,
      ...(await sql.query(`SELECT * FROM feishu_inbound_event`)).rows,
      ...(await sql.query(`SELECT bot_name, last_error FROM feishu_app`)).rows,
    ]);
    for (const value of [...SECRETS, ...fake.tenantAccessTokens]) {
      assert.ok(!text.includes(value), 'a secret or token is in an apiserver log');
      assert.ok(!stored.includes(value), 'a secret or token is stored');
    }
  });
});
