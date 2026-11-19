/**
 * Open access checks every sender with Feishu first (docs/feishu-bot-design.md §14.3; task O2), against a real PostgreSQL
 * that `scripts/run-pg-spec.sh` migrates from empty, the production apiserver (`build/main.js`), and the fake open
 * platform its long connection reaches (feishu/test-support/fake-open-platform.ts), whose availability check answers
 * per open_id (`fake.availability`). Every event is pushed down that connection as Feishu would push it, and goes through
 * the inbox and the router.
 *
 * Every table carries the write trap of the tenant isolation census (auth/tenant-isolation-fixtures.ts), so what the
 * database notes while an event is handled is the whole of what handling it wrote. An event may write only the inbox's
 * own record of it (its feishu_inbound_event row, the app's last_event_at) and the connection's heartbeat, as in
 * feishu-stranger.pg.spec.ts. What it is held to, with the app's access_mode AVAILABILITY_SCOPE:
 *
 *   (1) a direct message, and a group mention (a request and a `connect`), from someone Feishu answers is not in the
 *       app's availability scope gets the one §14.6 sentence and writes nothing; Feishu was asked once per message, with
 *       the sender's open_id;
 *   (2) the same when Feishu answers the check with a 5xx, in a direct message and in a group;
 *   (3) the same refused event processed a second time writes nothing either, asks Feishu again (nothing is cached),
 *       and its reply carries the same uuid, so Feishu delivers it once;
 *   (4) a sender in the scope passes the gate: until O3 and O4 land, a direct message gets today's stranger sentence and
 *       a mention in a group that is not connected gets today's sentence;
 *   (5) the owner's own messages are not checked;
 *   (6) under OWNER_ONLY nothing is checked, and a stranger's messages get today's sentences.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-availability.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { WRITE_TRAP } from '../auth/tenant-isolation-fixtures';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-availability-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Helper' };
const ALICE = 'ou_alice_owner';
const OUTSIDER = 'ou_outsider';
const BROKEN = 'ou_feishu_5xx';
const INSIDER = 'ou_insider';
const TEAM = `oc_team_${RUN}`;

/** The sentences, spelled out here rather than imported, so the spec pins the words themselves. */
const NOT_AVAILABLE = "You can't use this bot. Ask its owner to make the app available to you in Feishu.";
const STRANGER_DM = 'This bot only takes direct messages from its owner.';
const NOT_CONNECTED = `This group isn't connected, so nothing was started. The bot's owner can connect it by sending "@${X.botName} connect" here.`;
const CHECK_PATH = `/open-apis/application/v6/applications/${X.appId}/visibility/check_white_black_list`;

async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

type Row = Record<string, unknown>;
const without = (row: Row, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

test('Feishu open access: every sender but the owner is checked against the app\'s availability first', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  fake.addApp(X);
  fake.availability.set(OUTSIDER, 'OUT');
  fake.availability.set(BROKEN, 'SERVER_ERROR');
  fake.availability.set(INSIDER, 'IN');
  fake.chats.set(TEAM, { name: 'Team', external: false });
  const fakeUrl = await fake.start();

  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `feishu-availability-${RUN}@feishu-availability.invalid`, name: 'Feishu availability', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' },
  });
  await db.feishuApp.create({
    data: { ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), botName: X.botName, ownerOpenId: ALICE, ownerName: 'Alice', accessMode: 'AVAILABILITY_SCOPE' },
  });

  server = await startApiserver(url, `feishu-availability-${randomUUID()}`, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
  const connection: FakeConnection = await until('X connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${server!.output().slice(-4000)}`);
  });
  await until('the link reported connected', async () =>
    (await sql.query(`SELECT 1 FROM feishu_link WHERE app_id = $1 AND state = 'CONNECTED'`, [X.appId])).rowCount);

  // ── the write trap ───────────────────────────────────────────────────────────────────────────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  const appRow = async (): Promise<Row> => (await sql.query(`SELECT to_jsonb(a) AS r FROM feishu_app a WHERE app_id = $1`, [X.appId])).rows[0].r;
  const linkRows = async (): Promise<Row[]> => (await sql.query(`SELECT to_jsonb(l) AS r FROM feishu_link l WHERE app_id = $1`, [X.appId])).rows.map((r) => r.r);

  /** Every row written since `since` beyond the inbox's own record of `eventId` and the connection's heartbeat. */
  const strayWrites = async (since: bigint, eventId: string, app: Row, links: Row[]): Promise<string[]> => {
    const rows = (await sql.query<{ tbl: string; op: string; row: Row }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`, [since.toString()],
    )).rows;
    const linkBefore = JSON.stringify(links.map((l) => without(l, 'heartbeat_at')));
    return rows.filter(({ tbl, op, row }) => {
      if (tbl === 'feishu_inbound_event' && (op === 'INSERT' || op === 'UPDATE') && row.event_id === eventId && row.app_id === X.appId) return false;
      if (tbl === 'feishu_app' && op === 'UPDATE' && JSON.stringify(without(row, 'last_event_at')) === JSON.stringify(without(app, 'last_event_at'))) return false;
      if (tbl === 'feishu_link' && op === 'UPDATE' && linkBefore.includes(JSON.stringify(without(row, 'heartbeat_at')))) return false;
      return true;
    }).map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);
  };

  const processed = (eventId: string, attempts = 1) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts >= $3`,
        [X.appId, eventId, attempts])).rowCount);
  const repliesTo = (messageId: string) =>
    fake.messages
      .filter((m: FakeRequest) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`)
      .map((m) => (JSON.parse((m.body as { content: string }).content) as { text: string }).text);
  const checks = () => fake.requestsTo(CHECK_PATH);

  let seq = 0;
  /**
   * Push one text message from `openId` — in its direct chat with the bot, or as a mention in TEAM — and wait until the
   * inbox processed it and the bot answered; resolve with what was written beyond the inbox's record, the replies, and
   * the availability checks it made.
   */
  async function send(where: 'dm' | 'group', openId: string, text: string) {
    const eventId = `ev-availability-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const message = where === 'dm'
      ? { message_id: messageId, chat_id: `oc_p2p_${openId}`, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) }
      : {
        message_id: messageId, chat_id: TEAM, chat_type: 'group', message_type: 'text',
        content: JSON.stringify({ text: `@_user_1 ${text}` }), mentions: [{ key: '@_user_1', name: X.botName }],
      };
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: { sender: { sender_id: { open_id: openId }, sender_type: 'user' }, message },
    };
    const [app, links] = [await appRow(), await linkRows()];
    const checksBefore = checks().length;
    const before = await mark();
    const ack = await fake.push(connection, envelope);
    assert.equal(ack.code, 200);
    await processed(eventId);
    await until(`a reply to ${messageId}`, () => repliesTo(messageId).length > 0);
    await sleep(300);
    return {
      eventId,
      messageId,
      stray: await strayWrites(before, eventId, app, links),
      replies: repliesTo(messageId),
      checks: checks().slice(checksBefore),
    };
  }

  const askedAbout = (requests: FakeRequest[], openId: string) => {
    assert.equal(requests.length, 1, 'Feishu was asked once');
    const [r] = requests;
    assert.equal(r!.method, 'POST');
    assert.equal(r!.query.get('user_id_type'), 'open_id');
    assert.deepEqual(r!.body, { user_ids: [openId] });
  };

  let refusedEvent = '';
  await t.test('(1) not in the availability scope: a direct message and a group mention get one sentence and write nothing', async () => {
    const dm = await send('dm', OUTSIDER, 'please run my job');
    refusedEvent = dm.eventId;
    assert.deepEqual(dm.replies, [NOT_AVAILABLE]);
    assert.deepEqual(dm.stray, []);
    askedAbout(dm.checks, OUTSIDER);
    for (const text of ['please run my job', 'connect']) {
      const group = await send('group', OUTSIDER, text);
      assert.deepEqual(group.replies, [NOT_AVAILABLE], text);
      assert.deepEqual(group.stray, [], text);
      askedAbout(group.checks, OUTSIDER);
    }
  });

  await t.test('(2) Feishu answers the check with a 5xx: a direct message and a group mention get the same sentence and write nothing', async () => {
    const dm = await send('dm', BROKEN, 'please run my job');
    assert.deepEqual(dm.replies, [NOT_AVAILABLE]);
    assert.deepEqual(dm.stray, []);
    askedAbout(dm.checks, BROKEN);
    const group = await send('group', BROKEN, 'please run my job');
    assert.deepEqual(group.replies, [NOT_AVAILABLE]);
    assert.deepEqual(group.stray, []);
    askedAbout(group.checks, BROKEN);
  });

  await t.test('(3) the same refused event processed a second time writes nothing, asks again, and is delivered once', async () => {
    const messageId = `om_${refusedEvent}`;
    const checksBefore = checks().length;
    await sql.query(`UPDATE feishu_inbound_event SET processed_at = NULL, attempts = 1, lease_until = NULL WHERE app_id = $1 AND event_id = $2`, [X.appId, refusedEvent]);
    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    await processed(refusedEvent, 2);
    const replyPath = `/open-apis/im/v1/messages/${messageId}/reply`;
    await until('the second reply', () => fake.requestsTo(replyPath).length === 2);
    await sleep(300);
    assert.deepEqual(await strayWrites(before, refusedEvent, app, links), []);
    askedAbout(checks().slice(checksBefore), OUTSIDER);
    assert.deepEqual(repliesTo(messageId), [NOT_AVAILABLE], 'delivered once');
    const [first, again] = fake.requestsTo(replyPath);
    assert.ok((first!.body as { uuid?: string }).uuid);
    assert.equal((again!.body as { uuid?: string }).uuid, (first!.body as { uuid?: string }).uuid);
  });

  await t.test('(4) in the availability scope: the gate passes, and today\'s answers follow', async () => {
    const dm = await send('dm', INSIDER, 'please run my job');
    assert.deepEqual(dm.replies, [STRANGER_DM]);
    assert.deepEqual(dm.stray, []);
    askedAbout(dm.checks, INSIDER);
    const group = await send('group', INSIDER, 'please run my job');
    assert.deepEqual(group.replies, [NOT_CONNECTED]);
    assert.deepEqual(group.stray, []);
    askedAbout(group.checks, INSIDER);
  });

  await t.test('(5) the owner is not checked', async () => {
    const group = await send('group', ALICE, 'please run my job');
    assert.deepEqual(group.replies, [NOT_CONNECTED]);
    assert.deepEqual(group.checks, []);
  });

  // Back to Only you, written before the trap is read again.
  await db.feishuApp.update({ where: { appId: X.appId }, data: { accessMode: 'OWNER_ONLY' } });

  await t.test('(6) under OWNER_ONLY nothing is checked, and a stranger gets today\'s sentences', async () => {
    const dm = await send('dm', OUTSIDER, 'please run my job');
    assert.deepEqual(dm.replies, [STRANGER_DM]);
    assert.deepEqual(dm.stray, []);
    assert.deepEqual(dm.checks, []);
    const group = await send('group', OUTSIDER, 'please run my job');
    assert.deepEqual(group.replies, [NOT_CONNECTED]);
    assert.deepEqual(group.stray, []);
    assert.deepEqual(group.checks, []);
  });
});
