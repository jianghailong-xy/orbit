/**
 * Only the owner is served (docs/feishu-bot-design.md §7.3, §7.4; task F1-2), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, the production apiserver (`build/main.js`), and the fake open platform
 * its long connection reaches (feishu/test-support/fake-open-platform.ts). Every event below is pushed down that
 * connection as Feishu would push it, and goes through the inbox and the router.
 *
 * Every table carries the write trap of the tenant isolation census (auth/tenant-isolation-fixtures.ts), so what the
 * database notes while an event is handled is the whole of what handling it wrote. What each event may write is the
 * inbox's own record of it, and nothing else: its feishu_inbound_event row (inserted, claimed, stamped processed) and the
 * app's last_event_at, which the inbox stamps on every delivery before anything is routed. The only other write the
 * trap may see in that time is the connection's heartbeat on feishu_link, which runs on its own clock whatever arrives.
 * What it is held to:
 *
 *   (1) while nobody is the owner, a direct message is answered with how to become it, and writes nothing;
 *   (2) once someone is, a direct message from anyone else — text, `disconnect`, an image — is answered only
 *       `This bot only takes direct messages from its owner.`, and writes nothing; the owner stays who they were;
 *   (3) the same stranger's event processed a second time writes nothing either, and its reply is sent again with the
 *       same `uuid`, so Feishu delivers one and answers the repeat with the same message_id (project instruction 15);
 *   (4) a click on a card by anyone but the owner (a forwarded card) is answered synchronously with the toast
 *       `Only the owner of this bot can answer this card.`, sends nothing to the open platform, and writes nothing; the
 *       same holds while nobody is the owner, and for a click that names no clicker;
 *   (5) the owner's own click passes the check (no refusal), so the refusal is the clicker's doing.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-stranger.pg.spec.ts
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
process.env.PROVIDER_SECRET_KEY = `feishu-stranger-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit stranger bot' };
const ALICE = 'ou_alice';
const MALLORY = 'ou_mallory';

/** The sentences §7.3 and §7.4 prescribe, spelled out here rather than imported, so the spec pins the words themselves. */
const STRANGER_DM = 'This bot only takes direct messages from its owner.';
const NO_OWNER_DM =
  'This bot has no owner yet. To become its owner, generate a code in Orbit (Settings → Feishu → Connect your Feishu account) and send it here.';
const STRANGER_CARD = { toast: { type: 'error', content: 'Only the owner of this bot can answer this card.' } };

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

test('Feishu: only the owner is served — a stranger\'s direct message and a forwarded card\'s click write nothing', {
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
  const fakeUrl = await fake.start();

  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `feishu-stranger-${RUN}@feishu-stranger.invalid`, name: 'Feishu stranger', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' },
  });
  await db.feishuApp.create({ data: { ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret) } });

  server = await startApiserver(url, `feishu-stranger-${randomUUID()}`, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
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

  /**
   * Every row written since `since` that is not the inbox's own record of `eventId` — its feishu_inbound_event row, the
   * app's last_event_at — nor the connection's heartbeat: what handling the event wrote beyond what it may.
   */
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
  const inboxRows = async (since: bigint, eventId: string) =>
    (await sql.query(`SELECT "op" FROM "tenant_census_write" WHERE "seq" > $1 AND "tbl" = 'feishu_inbound_event' AND "row"->>'event_id' = $2 ORDER BY "seq"`,
      [since.toString(), eventId])).rows.map((r) => r.op);

  const processed = (eventId: string) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL`, [X.appId, eventId])).rowCount);
  const repliesTo = (messageId: string) =>
    fake.messages
      .filter((m: FakeRequest) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`)
      .map((m) => (JSON.parse((m.body as { content: string }).content) as { text: string }).text);

  let seq = 0;
  /**
   * Push one direct message from `openId` and wait until the inbox processed it; resolve with what was written beyond
   * the inbox's own record, the inbox's own writes, and the bot's replies to it.
   */
  async function dm(openId: string, content: { type: 'text'; text: string } | { type: 'image' }) {
    const eventId = `ev-stranger-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: 'user' },
        message: {
          message_id: messageId,
          chat_id: `oc_p2p_${openId}`,
          chat_type: 'p2p',
          message_type: content.type,
          content: JSON.stringify(content.type === 'text' ? { text: content.text } : { image_key: 'img_v2_x' }),
        },
      },
    };
    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    const ack = await fake.push(connection, envelope);
    assert.equal(ack.code, 200);
    await processed(eventId);
    await until(`a reply to ${messageId}`, () => repliesTo(messageId).length > 0);
    await sleep(300);
    return { eventId, messageId, stray: await strayWrites(before, eventId, app, links), inbox: await inboxRows(before, eventId), replies: repliesTo(messageId) };
  }

  /** Push one card click by `openId` (none: no operator) and resolve with its synchronous answer and what it wrote. */
  async function click(openId: string | undefined) {
    const eventId = `ev-stranger-card-${RUN}-${++seq}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'card.action.trigger', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        ...(openId ? { operator: { open_id: openId } } : {}),
        action: { tag: 'button', value: { kind: 'approval', approvalId: randomUUID(), decision: 'allow' } },
        context: { open_message_id: `om_card_${RUN}`, open_chat_id: `oc_p2p_${ALICE}` },
      },
    };
    const [app, links] = [await appRow(), await linkRows()];
    const sentBefore = fake.messages.length;
    const before = await mark();
    const ack = await fake.push(connection, envelope);
    assert.equal(ack.code, 200);
    await processed(eventId);
    await sleep(300);
    return {
      answer: ack.data,
      stray: await strayWrites(before, eventId, app, links),
      inbox: await inboxRows(before, eventId),
      sent: fake.messages.slice(sentBefore).map((m) => `${m.method} ${m.path}`),
    };
  }

  await t.test('(1) nobody is the owner yet: a direct message is answered with how to become it, and writes nothing', async () => {
    const hello = await dm(MALLORY, { type: 'text', text: 'hello' });
    assert.deepEqual(hello.replies, [NO_OWNER_DM]);
    assert.deepEqual(hello.stray, []);
    assert.deepEqual(hello.inbox, ['INSERT', 'UPDATE', 'UPDATE'], 'the inbox recorded the event, claimed it, and stamped it processed');
    assert.equal((await appRow()).owner_open_id, null);
  });

  await t.test('(4a) nobody is the owner yet: any click is refused with the toast, and writes nothing', async () => {
    const c = await click(ALICE);
    assert.deepEqual(c.answer, STRANGER_CARD);
    assert.deepEqual(c.stray, []);
    assert.deepEqual(c.sent, []);
  });

  // Alice is the owner from here on (as F1-1's code makes her); written before the trap is read again.
  await db.feishuApp.update({ where: { appId: X.appId }, data: { ownerOpenId: ALICE, ownerName: 'Alice Example' } });

  let strangerEvent = '';
  await t.test('(2) a stranger\'s direct message — text, `disconnect`, an image — gets one sentence and writes nothing', async () => {
    for (const content of [{ type: 'text', text: 'please run my job' }, { type: 'text', text: 'disconnect' }, { type: 'image' }] as const) {
      const m = await dm(MALLORY, content);
      strangerEvent ||= m.eventId;
      assert.deepEqual(m.replies, [STRANGER_DM], `${content.type}`);
      assert.deepEqual(m.stray, [], `${content.type}`);
      assert.deepEqual(m.inbox, ['INSERT', 'UPDATE', 'UPDATE'], `${content.type}: recorded, claimed, stamped processed`);
    }
    const app = await appRow();
    assert.equal(app.owner_open_id, ALICE, 'the owner stays');
    assert.equal(app.owner_name, 'Alice Example');
  });

  await t.test('(3) the same stranger\'s event processed a second time writes nothing either', async () => {
    const messageId = `om_${strangerEvent}`;
    await sql.query(
      `UPDATE feishu_inbound_event SET processed_at = NULL, attempts = 1, lease_until = NULL WHERE app_id = $1 AND event_id = $2`,
      [X.appId, strangerEvent],
    );
    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    await until('processed again', async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts = 2`, [X.appId, strangerEvent])).rowCount);
    const replyPath = `/open-apis/im/v1/messages/${messageId}/reply`;
    await until('the second reply', () => fake.requestsTo(replyPath).length === 2);
    await sleep(300);
    assert.deepEqual(await strayWrites(before, strangerEvent, app, links), []);
    // Answered alike, and delivered once: both replies carry one de-duplication key.
    assert.deepEqual(repliesTo(messageId), [STRANGER_DM]);
    const [first, again] = fake.requestsTo(replyPath);
    const uuidOf = (r: FakeRequest) => (r.body as { uuid?: string }).uuid;
    assert.ok(uuidOf(first!), 'the reply carries a uuid');
    assert.equal(uuidOf(again!), uuidOf(first!), 'the repeat carries the same one');
    assert.ok(first!.answeredWith);
    assert.equal(again!.answeredWith, first!.answeredWith, 'and is answered with the message already delivered');
  });

  await t.test('(4) a click on a forwarded card is refused with the toast, sends nothing, and writes nothing', async () => {
    for (const who of [MALLORY, undefined]) {
      const c = await click(who);
      assert.deepEqual(c.answer, STRANGER_CARD, `clicker ${who ?? 'none'}`);
      assert.deepEqual(c.stray, [], `clicker ${who ?? 'none'}`);
      assert.deepEqual(c.inbox, ['INSERT', 'UPDATE'], 'the inbox recorded the click already claimed, and stamped it processed');
      assert.deepEqual(c.sent, [], 'no reply and no card update went to Feishu');
    }
  });

  await t.test('(5) the owner\'s own click passes the check', async () => {
    const c = await click(ALICE);
    assert.notDeepEqual(c.answer, STRANGER_CARD);
    assert.deepEqual(c.stray, []);
  });
});
