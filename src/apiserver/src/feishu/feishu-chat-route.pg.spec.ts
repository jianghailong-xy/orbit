/**
 * Connecting a group to Orbit (docs/feishu-bot-design.md §8.1, §8.3; task F3-1), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty, the production apiserver (`build/main.js`), and the fake open platform
 * its long connection reaches (feishu/test-support/fake-open-platform.ts). Every event below is pushed down that
 * connection as Feishu would push it, and goes through the inbox and the router; every route is called over HTTP with a
 * login or a personal access token.
 *
 * Every table carries the write trap of the tenant isolation census (auth/tenant-isolation-fixtures.ts), so what the
 * database notes while an event is handled is the whole of what handling it wrote. What it is held to:
 *
 *   (1) a mention in a group that was never connected starts no session, gets one English sentence, and writes nothing
 *       beyond the inbox's own record of the event;
 *   (2) `connect` from anyone but the owner is not taken: one sentence, no feishu_chat_route row, nothing written;
 *   (3) `connect` from the owner in a group with members from another organization is refused alike;
 *   (4) the owner's `connect` makes the group's row, holding only a ticket bound to the owner's open_id and the group,
 *       and the bot answers with the `Connect this group to Orbit` card whose button carries that ticket; the same event
 *       processed again issues the same ticket and card (same Feishu uuid) and writes nothing;
 *   (5) until it is confirmed, a mention in the group still starts no session and gets the sentence;
 *   (6) the confirm page reads the ticket's group with a login, and a token is refused that read (ACCOUNT);
 *   (7) a personal access token is refused the confirm 403 OWNER_INTERACTIVE_CREDENTIAL_REQUIRED and writes nothing;
 *   (8) a login confirms: feishu_chat_route holds exactly what was submitted, switched on, and the ticket is gone; the
 *       ticket does not work a second time, and the connect event processed again does not bring it back;
 *   (9) a ticket that expired, or one issued to an open_id that is no longer the owner, connects nothing;
 *  (10) switched off by the owner, the group gets the switched-off sentence and starts no session;
 *  (11) the bot removed from the group (im.chat.member.bot.deleted_v1) switches the route off (BOT_REMOVED), processed
 *       twice writes once, and the route cannot be switched back on until the group is connected again;
 *  (12) DELETE removes the route.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-chat-route.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { toUuid } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { WRITE_TRAP } from '../auth/tenant-isolation-fixtures';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { hashChatTicket } from './feishu-chat-route.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-chat-route-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit group bot' };
const ALICE = 'ou_alice';
const MALLORY = 'ou_mallory';
const TEAM = `oc_team_${RUN}`;
const EXTERNAL = `oc_external_${RUN}`;
const OTHER = `oc_other_${RUN}`;

/** The sentences the bot answers with, spelled out here so the spec pins the words themselves. */
const NOT_CONNECTED = `This group isn't connected to Orbit, so nothing was started. The bot's owner can connect it by sending "@${X.botName} connect" here.`;
const SWITCHED_OFF =
  `This group's connection to Orbit is switched off, so nothing was started. The bot's owner can switch it back on in Orbit, or send "@${X.botName} connect" here.`;
const STRANGER_CONNECT = 'Only the owner of this bot can connect this group to Orbit.';
const EXTERNAL_GROUP = 'Orbit connects only groups inside your organization. This group has members from other organizations.';

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

test('Feishu: a group is connected only by the owner\'s connect and the confirm page, and nothing runs before', {
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
  fake.chats.set(TEAM, { name: 'Release team', external: false });
  fake.chats.set(OTHER, { name: 'Other team', external: false });
  fake.chats.set(EXTERNAL, { name: 'With a vendor', external: true });
  const fakeUrl = await fake.start();

  const ownerId = randomUUID();
  const email = `feishu-chat-route-${RUN}@feishu-chat-route.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'Feishu groups', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' } });
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'group runner', tokenHash: `feishu-chat-route-${runnerId}` } });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `groups ${RUN}`, enabled: true } });
  await db.feishuApp.create({
    data: { ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice', botName: X.botName },
  });

  const token = (await new PatService(db as unknown as PrismaService).issue(ownerId, {
    name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB',
  })).token;
  const jwtSecret = `feishu-chat-route-${randomUUID()}`;
  const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });
  server = await startApiserver(url, jwtSecret, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
  const api = (method: string, path: string, bearer: string, body?: unknown): Promise<Reply> => call(server!, method, `/api${path}`, bearer, body);
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
  /** Every write since `since` beyond the inbox's record of `eventId`, the app's last_event_at, and the heartbeat. */
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
  const sessions = () => db.session.count({ where: { ownerId } });
  const routeOf = (chatId: string) => db.feishuChatRoute.findUnique({ where: { appId_chatId: { appId: X.appId, chatId } } });

  const processedTimes = (eventId: string, times: number) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(
        `SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts >= $3`,
        [X.appId, eventId, times],
      )).rowCount);
  const repliesTo = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);
  const textsTo = (messageId: string) =>
    repliesTo(messageId).map((m) => {
      const body = m.body as { msg_type: string; content: string };
      return body.msg_type === 'text' ? (JSON.parse(body.content) as { text: string }).text : `<${body.msg_type}>`;
    });

  let seq = 0;
  const envelopeOf = (eventId: string, chatId: string, openId: string, text: string) => ({
    schema: '2.0',
    header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
    event: {
      sender: { sender_id: { open_id: openId }, sender_type: 'user' },
      message: {
        message_id: `om_${eventId}`,
        chat_id: chatId,
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: `@_user_1 ${text}` }),
        mentions: [{ key: '@_user_1', name: X.botName }],
      },
    },
  });
  /** Push one group message that @-mentions the bot; resolve once processed and answered, with what it wrote. */
  async function mention(chatId: string, openId: string, text: string) {
    const eventId = `ev-group-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const [app, links] = [await appRow(), await linkRows()];
    const sessionsBefore = await sessions();
    const before = await mark();
    const ack = await fake.push(connection, envelopeOf(eventId, chatId, openId, text));
    assert.equal(ack.code, 200);
    await processedTimes(eventId, 1);
    await until(`a reply to ${messageId}`, () => repliesTo(messageId).length > 0);
    await sleep(300);
    return {
      eventId, messageId,
      stray: await strayWrites(before, eventId, app, links),
      replies: textsTo(messageId),
      sessionsStarted: (await sessions()) - sessionsBefore,
    };
  }
  /** Process an event already in the inbox once more, as a worker whose lease ran out would. */
  async function reprocess(eventId: string) {
    const { attempts } = (await sql.query<{ attempts: number }>(
      `UPDATE feishu_inbound_event SET processed_at = NULL, lease_until = NULL WHERE app_id = $1 AND event_id = $2 RETURNING attempts`, [X.appId, eventId],
    )).rows[0];
    await processedTimes(eventId, attempts + 1);
    await sleep(300);
  }
  /** The ticket the card's button carries. */
  const ticketOf = (reply: FakeRequest): string => {
    const body = reply.body as { msg_type: string; content: string };
    assert.equal(body.msg_type, 'interactive');
    const match = /[?&]ticket=([^"&]+)/.exec(body.content);
    assert.ok(match, 'the card carries a link with a ticket');
    return decodeURIComponent(match[1]);
  };

  await t.test('(1) a mention in a group never connected starts nothing, gets one sentence, and writes nothing', async () => {
    const m = await mention(TEAM, MALLORY, 'please deploy the release');
    assert.deepEqual(m.replies, [NOT_CONNECTED]);
    assert.equal(m.sessionsStarted, 0);
    assert.deepEqual(m.stray, []);
    const owner = await mention(TEAM, ALICE, 'fix the build');
    assert.deepEqual(owner.replies, [NOT_CONNECTED], 'the owner too: nothing runs before the group is connected');
    assert.equal(owner.sessionsStarted, 0);
    assert.deepEqual(owner.stray, []);
  });

  await t.test('(2) connect from anyone but the owner is not taken, and writes nothing', async () => {
    const m = await mention(TEAM, MALLORY, 'connect');
    assert.deepEqual(m.replies, [STRANGER_CONNECT]);
    assert.deepEqual(m.stray, []);
    assert.equal(await routeOf(TEAM), null);
    assert.equal(fake.requests.filter((r) => r.path.startsWith('/open-apis/im/v1/chats/')).length, 0, 'not even the group was looked up');
  });

  await t.test('(3) connect in a group with members from another organization is refused, and writes nothing', async () => {
    const m = await mention(EXTERNAL, ALICE, 'connect');
    assert.deepEqual(m.replies, [EXTERNAL_GROUP]);
    assert.deepEqual(m.stray, []);
    assert.equal(await routeOf(EXTERNAL), null);
  });

  let connectEvent = '';
  let ticket = '';
  await t.test('(4) the owner\'s connect makes a ticket bound to the owner and the group, and answers with the card', async () => {
    const m = await mention(TEAM, ALICE, 'connect');
    connectEvent = m.eventId;
    const [card] = repliesTo(m.messageId);
    assert.match((card.body as { content: string }).content, /Connect this group to Orbit/);
    ticket = ticketOf(card);
    const row = await routeOf(TEAM);
    assert.ok(row);
    assert.deepEqual(
      { owner: row.ownerId, chatName: row.chatName, ticketHash: row.ticketHash, ticketOpenId: row.ticketOpenId, confirmedAt: row.confirmedAt, enabled: row.enabled, workspaceId: row.workspaceId },
      { owner: ownerId, chatName: 'Release team', ticketHash: hashChatTicket(ticket), ticketOpenId: ALICE, confirmedAt: null, enabled: false, workspaceId: null },
    );
    assert.ok(row.ticketExpiresAt && row.ticketExpiresAt.getTime() > Date.now());
    assert.deepEqual(m.stray.map((w) => w.split(' ').slice(0, 2).join(' ')), ['INSERT feishu_chat_route'], 'one row, and nothing else');

    // The same event processed again: the same ticket, the same card under the same uuid, and no write.
    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    await reprocess(connectEvent);
    await until('the card again', () => repliesTo(m.messageId).length === 2);
    const [first, second] = repliesTo(m.messageId);
    assert.equal(ticketOf(second), ticket);
    assert.equal((second.body as { uuid?: string }).uuid, (first.body as { uuid?: string }).uuid);
    assert.ok((first.body as { uuid?: string }).uuid, 'the card carries a Feishu uuid');
    assert.deepEqual(await strayWrites(before, connectEvent, app, links), []);
  });

  await t.test('(5) until confirmed, a mention in the group still starts nothing', async () => {
    const m = await mention(TEAM, MALLORY, 'please deploy the release');
    assert.deepEqual(m.replies, [NOT_CONNECTED]);
    assert.equal(m.sessionsStarted, 0);
    assert.deepEqual(m.stray, []);
  });

  await t.test('(6) the confirm page reads the ticket\'s group with a login; a token is refused the read', async () => {
    const read = await api('GET', `/integrations/feishu/chats?ticket=${encodeURIComponent(ticket)}`, login);
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.json.routes, []);
    assert.deepEqual(without(read.json.pending, 'expiresAt'), { chatId: TEAM, chatName: 'Release team', connected: false });
    const byToken = await api('GET', `/integrations/feishu/chats?ticket=${encodeURIComponent(ticket)}`, token);
    assert.equal(byToken.status, 403);
    assert.equal(byToken.json.code, 'PAT_FORBIDDEN');
    assert.equal(byToken.json.reason, 'ACCOUNT');
    const unknown = await api('GET', '/integrations/feishu/chats?ticket=not-a-ticket', login);
    assert.equal(unknown.json.pending, null);
  });

  const submission = {
    workspaceId,
    permissionMode: 'acceptEdits',
    allowedOpenIds: ['ou_bob', 'ou_carol'],
    maxConcurrentSessions: 3,
    sessionsPerDay: 12,
  };
  await t.test('(7) a personal access token is refused the confirm, and writes nothing', async () => {
    const before = await routeOf(TEAM);
    const reply = await api('POST', '/integrations/feishu/chats/confirm', token, { ticket, ...submission });
    assert.equal(reply.status, 403, reply.text);
    assert.equal(reply.json.code, 'OWNER_INTERACTIVE_CREDENTIAL_REQUIRED');
    assert.equal(reply.json.requiredAction, 'OPEN_ORBIT');
    assert.deepEqual(await routeOf(TEAM), before);
  });

  let routeId = '';
  await t.test('(8) a login confirms: the route holds what was submitted, and the ticket works once', async () => {
    const reply = await api('POST', '/integrations/feishu/chats/confirm', login, { ticket, ...submission });
    assert.equal(reply.status, 201, reply.text);
    const row = await routeOf(TEAM);
    assert.ok(row);
    routeId = row.id;
    assert.equal(toUuid(reply.json.id), row.id);
    assert.deepEqual(
      {
        workspaceId: row.workspaceId, permissionMode: row.permissionMode, allowedOpenIds: row.allowedOpenIds,
        maxConcurrentSessions: row.maxConcurrentSessions, sessionsPerDay: row.sessionsPerDay,
        enabled: row.enabled, disabledReason: row.disabledReason, ticketHash: row.ticketHash, ticketOpenId: row.ticketOpenId, ticketExpiresAt: row.ticketExpiresAt,
        ownerId: row.ownerId, appId: row.appId, chatId: row.chatId,
      },
      { ...submission, enabled: true, disabledReason: null, ticketHash: null, ticketOpenId: null, ticketExpiresAt: null, ownerId, appId: X.appId, chatId: TEAM },
    );
    assert.ok(row.confirmedAt);
    const listed = await api('GET', '/integrations/feishu/chats', login);
    assert.equal(listed.json.routes.length, 1);
    assert.equal(toUuid(listed.json.routes[0].id), routeId);
    assert.equal(toUuid(listed.json.routes[0].workspaceId), workspaceId);

    const again = await api('POST', '/integrations/feishu/chats/confirm', login, { ticket, ...submission, maxConcurrentSessions: 9 });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, 'FEISHU_CHAT_TICKET_INVALID');
    assert.equal((await routeOf(TEAM))?.maxConcurrentSessions, 3);

    // The connect event processed again does not bring the used ticket back.
    await reprocess(connectEvent);
    assert.equal((await routeOf(TEAM))?.ticketHash, null);
    assert.equal((await api('POST', '/integrations/feishu/chats/confirm', login, { ticket, ...submission })).status, 409);
  });

  await t.test('(9) an expired ticket, or one issued to someone no longer the owner, connects nothing', async () => {
    const m = await mention(OTHER, ALICE, 'connect');
    const other = ticketOf(repliesTo(m.messageId)[0]);
    await db.feishuChatRoute.update({ where: { appId_chatId: { appId: X.appId, chatId: OTHER } }, data: { ticketExpiresAt: new Date(Date.now() - 1_000) } });
    const expired = await api('POST', '/integrations/feishu/chats/confirm', login, { ticket: other, ...submission });
    assert.equal(expired.status, 409);
    assert.equal((await routeOf(OTHER))?.confirmedAt, null);

    await db.feishuChatRoute.update({ where: { appId_chatId: { appId: X.appId, chatId: OTHER } }, data: { ticketExpiresAt: new Date(Date.now() + 600_000) } });
    await db.feishuApp.update({ where: { appId: X.appId }, data: { ownerOpenId: 'ou_new_owner' } });
    const replaced = await api('POST', '/integrations/feishu/chats/confirm', login, { ticket: other, ...submission });
    assert.equal(replaced.status, 409);
    assert.equal((await routeOf(OTHER))?.confirmedAt, null);
    await db.feishuApp.update({ where: { appId: X.appId }, data: { ownerOpenId: ALICE } });

    const elsewhere = await api('POST', '/integrations/feishu/chats/confirm', login, { ticket: other, ...submission, workspaceId: randomUUID() });
    assert.equal(elsewhere.status, 404, 'a workspace that is not the account\'s');
    assert.equal((await routeOf(OTHER))?.confirmedAt, null);
  });

  await t.test('(10) switched off by the owner, the group gets the switched-off sentence and starts nothing', async () => {
    const off = await api('PATCH', `/integrations/feishu/chats/${routeId}`, login, { enabled: false });
    assert.equal(off.status, 200, off.text);
    assert.deepEqual([off.json.enabled, off.json.disabledReason], [false, 'OWNER']);
    const m = await mention(TEAM, ALICE, 'fix the build');
    assert.deepEqual(m.replies, [SWITCHED_OFF]);
    assert.equal(m.sessionsStarted, 0);
    assert.deepEqual(m.stray, []);
    const on = await api('PATCH', `/integrations/feishu/chats/${routeId}`, login, { enabled: true });
    assert.deepEqual([on.json.enabled, on.json.disabledReason], [true, null]);
  });

  await t.test('(11) the bot removed from the group switches its route off, once, until the group is connected again', async () => {
    const eventId = `ev-removed-${RUN}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.chat.member.bot.deleted_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: { chat_id: TEAM, operator_id: { open_id: MALLORY }, name: 'Release team', external: false },
    };
    assert.equal((await fake.push(connection, envelope)).code, 200);
    await processedTimes(eventId, 1);
    const row = await routeOf(TEAM);
    assert.deepEqual([row?.enabled, row?.disabledReason], [false, 'BOT_REMOVED']);

    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    await reprocess(eventId);
    assert.deepEqual(await strayWrites(before, eventId, app, links), [], 'processed again, it writes nothing');

    const on = await api('PATCH', `/integrations/feishu/chats/${routeId}`, login, { enabled: true });
    assert.equal(on.status, 409);
    assert.equal(on.json.code, 'FEISHU_CHAT_BOT_REMOVED');
    assert.equal((await routeOf(TEAM))?.enabled, false);
  });

  await t.test('(12) DELETE removes the route', async () => {
    const removed = await api('DELETE', `/integrations/feishu/chats/${routeId}`, login);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(await routeOf(TEAM), null);
    assert.equal((await api('DELETE', `/integrations/feishu/chats/${routeId}`, login)).status, 404);
  });
});
