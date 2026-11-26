/**
 * The open bot in groups it was never connected to (docs/feishu-bot-design.md §14.2, §14.4, §14.6; task O4), against a
 * real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the production apiserver (`build/main.js`) and the
 * fake open platform its long connection reaches (feishu/test-support/fake-open-platform.ts). Every event is pushed
 * down that connection as Feishu would push it, and goes through the inbox and the router. Every table carries the
 * write trap of the tenant isolation census, so "writes nothing" is checked against what the database noted.
 *
 * The app is open (AVAILABILITY_SCOPE, a live open workspace, permission mode acceptEdits, one session at a time per
 * person); the account's default mode is plan and the connected group's is default, so the spec tells them apart.
 * What it is held to:
 *
 *   (1) someone in the availability scope mentions the bot at the top level of an internal group with no route: a
 *       session opens in the open workspace, in the open permission mode, its opening turn naming the sender; the
 *       group gets an implicit route (OPEN_ACCESS, on, unconfirmed, no settings of its own, the group's name, who used
 *       it first); the topic's row carries the sender for the limits; the receipt `Started · <title>` is a reply in a
 *       topic; one activity with credential_kind FEISHU. An approval of that session goes to the owner alone and says
 *       `Started by <name> in <group>` (O5);
 *   (2) the same event handled twice makes one session, one route, one topic row and one activity;
 *   (3) a mention inside the topic is a turn of the same session;
 *   (4) a connected group uses its own route: its workspace and mode, and its sessions do not count as the open bot's;
 *   (5) over a limit (the person already has a session running) nothing is started and nothing is written — no route
 *       either — and the topic gets the §14.6 sentence; the owner's own top-level mention in a group not connected
 *       gets today's sentence and writes nothing;
 *   (6) a group with people from another organization is refused with today's sentence and writes nothing;
 *   (7) an implicit route the owner switched off starts nothing, writes nothing, and answers the §14.6 sentence;
 *   (8) back to OWNER_ONLY: a mention in an implicit route's group, and in a group with no route, writes nothing and
 *       gets today's notConnected sentence; a connected group still works;
 *   (9) the bot removed from a group switches its implicit route off (BOT_REMOVED).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-group-open.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RunnerStatus, type PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { WRITE_TRAP } from '../auth/tenant-isolation-fixtures';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import '../test-support/daemon-routes-over-http';
import { feishuDerivedUuid } from './feishu-direct.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FEISHU_TEST_TIME_SCALE_ENV } from './feishu-timing';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-group-open-${randomUUID()}`;
const SCALE = '20';
const RUN = randomBytes(4).toString('hex');
const RUNNER_TOKEN = `feishu-group-open-runner-${randomUUID()}`;

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Helper' };
const ALICE = 'ou_alice_owner';
const BOB = 'ou_bob_member';
const CAROL = 'ou_carol_member';
const DAVE = 'ou_dave_member';
const DESIGN = `oc_design_${RUN}`;
const OPS = `oc_ops_${RUN}`;
const QA = `oc_qa_${RUN}`;
const PARTNERS = `oc_partners_${RUN}`;
const TEAM = `oc_team_${RUN}`;
const ACCOUNT_MODE = 'plan';
const OPEN_MODE = 'acceptEdits';
const ROUTE_MODE = 'default';

/** The sentences, spelled out here rather than imported, so the spec pins the words themselves. */
const NOT_CONNECTED = `This group isn't connected, so nothing was started. The bot's owner can connect it by sending "@${X.botName} connect" here.`;
const EXTERNAL = 'This bot works only in groups inside your organization. This group has members from other organizations.';
const SWITCHED_OFF = 'The owner has switched this bot off in this group, so nothing was started.';
const PERSON_RUNNING = 'You already have a session running. Wait for it to finish, then send this again.';

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

test('Feishu open access: a group nobody connected is served with the app\'s settings', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  let server: Apiserver | undefined;
  let beating: NodeJS.Timeout | undefined;
  t.after(async () => {
    if (beating) clearInterval(beating);
    await server?.stop();
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  fake.addApp(X);
  for (const openId of [BOB, CAROL, DAVE]) fake.availability.set(openId, 'IN');
  fake.userNames.set(BOB, 'Bob Chen');
  fake.userNames.set(CAROL, 'Carol Wu');
  fake.chats.set(DESIGN, { name: 'Design', external: false });
  fake.chats.set(OPS, { name: 'Ops', external: false });
  fake.chats.set(QA, { name: 'QA', external: false });
  fake.chats.set(PARTNERS, { name: 'Partners', external: true });
  fake.chats.set(TEAM, { name: 'Team', external: false });
  const fakeUrl = await fake.start();

  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `feishu-group-open-${RUN}@feishu-group-open.invalid`, name: 'owner', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER',
      preferences: { defaultPermissionMode: ACCOUNT_MODE },
    },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'a runner', tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
  });
  beating = setInterval(() => void sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId]).catch(() => undefined), 3_000);
  const personal = await db.workspace.create({ data: { ownerId, runnerId, name: `personal ${RUN}`, enabled: true } });
  const shared = await db.workspace.create({ data: { ownerId, runnerId, name: `shared ${RUN}`, enabled: true } });
  const team = await db.workspace.create({ data: { ownerId, runnerId, name: `team ${RUN}`, enabled: true } });
  await db.feishuApp.create({
    data: {
      ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice',
      botName: X.botName, defaultWorkspaceId: personal.id, accessMode: 'AVAILABILITY_SCOPE', openWorkspaceId: shared.id, openPermissionMode: OPEN_MODE,
      openMaxRunningPerPerson: 1,
    },
  });
  // A group the owner connected, with its own settings.
  await db.feishuChatRoute.create({
    data: {
      ownerId, appId: X.appId, chatId: TEAM, chatName: 'Team', workspaceId: team.id, permissionMode: ROUTE_MODE, allowedOpenIds: [],
      maxConcurrentSessions: 5, sessionsPerDay: 50, enabled: true, confirmedAt: new Date(),
    },
  });

  server = await startApiserver(url, `feishu-group-open-${randomUUID()}`, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE });
  const said = () => server!.output().slice(-4000);
  const connection: FakeConnection = await until('X connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
  });
  await until('the link reported connected', async () =>
    (await sql.query(`SELECT 1 FROM feishu_link WHERE app_id = $1 AND state = 'CONNECTED'`, [X.appId])).rowCount);

  // ── the write trap ───────────────────────────────────────────────────────────────────────────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  const appRow = async (): Promise<Row> => (await sql.query(`SELECT to_jsonb(a) AS r FROM feishu_app a WHERE app_id = $1`, [X.appId])).rows[0].r;
  const linkRows = async (): Promise<Row[]> => (await sql.query(`SELECT to_jsonb(l) AS r FROM feishu_link l WHERE app_id = $1`, [X.appId])).rows.map((r) => r.r);
  const sessionIds = async (): Promise<string[]> => (await db.session.findMany({ where: { ownerId }, select: { id: true } })).map((s) => s.id);
  /**
   * Every write since `since` beyond the inbox's record of `eventId`, the app's last_event_at, the heartbeats, and
   * whatever the dispatcher does with sessions that existed before (`known`).
   */
  const strayWrites = async (since: bigint, eventId: string, app: Row, links: Row[], known: string[]): Promise<string[]> => {
    const rows = (await sql.query<{ tbl: string; op: string; row: Row }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`, [since.toString()],
    )).rows;
    const linkBefore = JSON.stringify(links.map((l) => without(l, 'heartbeat_at')));
    return rows.filter(({ tbl, op, row }) => {
      if (tbl === 'feishu_inbound_event' && (op === 'INSERT' || op === 'UPDATE') && row.event_id === eventId && row.app_id === X.appId) return false;
      if (tbl === 'feishu_app' && op === 'UPDATE' && JSON.stringify(without(row, 'last_event_at')) === JSON.stringify(without(app, 'last_event_at'))) return false;
      if (tbl === 'feishu_link' && op === 'UPDATE' && linkBefore.includes(JSON.stringify(without(row, 'heartbeat_at')))) return false;
      if (tbl === 'runner' && op === 'UPDATE') return false;
      const text = JSON.stringify(row);
      if (known.some((id) => text.includes(id))) return false;
      return true;
    }).map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);
  };

  const processed = (eventId: string, attempts = 1) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts >= $3`,
        [X.appId, eventId, attempts])).rowCount)
      .catch((error) => {
        throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
      });
  const repliesTo = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);
  const textOf = (r: FakeRequest) => (JSON.parse((r.body as { content: string }).content) as { text: string }).text;

  let seq = 0;
  /**
   * Push one `@bot <text>` from `openId` in `chatId` (inside the topic `rootId` when given), wait until the inbox
   * processed it and — unless `quiet` — the bot answered it; resolve with what was written beyond the inbox's record,
   * and the bot's replies to it.
   */
  async function mention(chatId: string, openId: string, text: string, opts: { rootId?: string; quiet?: boolean } = {}) {
    const eventId = `ev-group-open-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const [app, links, known] = [await appRow(), await linkRows(), await sessionIds()];
    const before = await mark();
    const ack = await fake.push(connection, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: 'user' },
        message: {
          message_id: messageId, chat_id: chatId, chat_type: 'group', message_type: 'text',
          ...(opts.rootId ? { root_id: opts.rootId, parent_id: opts.rootId } : {}),
          content: JSON.stringify({ text: `@_user_1 ${text}` }), mentions: [{ key: '@_user_1', name: X.botName }],
        },
      },
    });
    assert.equal(ack.code, 200);
    await processed(eventId);
    if (!opts.quiet) await until(`a reply to ${messageId}`, () => repliesTo(messageId).length > 0);
    await sleep(300);
    return { eventId, messageId, stray: await strayWrites(before, eventId, app, links, known), replies: repliesTo(messageId) };
  }
  const routeOf = (chatId: string) => db.feishuChatRoute.findUnique({ where: { appId_chatId: { appId: X.appId, chatId } } });
  const sessionOf = (messageId: string) => feishuDerivedUuid('feishu-group-session', X.appId, messageId);

  // The runner's own routes, to file an approval in a session (O5's line).
  const runner = (method: string, rest: string, body?: unknown) =>
    call(server!, method, `/api/runner${rest}`, RUNNER_TOKEN, body, { 'x-orbit-runner-caller': 'mcp' });
  async function claim(sessionId: string) {
    const lease = { owner: randomUUID(), generation: randomUUID() };
    await sql.query(`INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [lease.generation, sessionId, lease.owner]);
    await sql.query('BEGIN');
    try {
      await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
      await sql.query(
        `UPDATE "session" SET "turn_state" = 'IN_FLIGHT', "assigned_runner_id" = $2::uuid, "inbox_lease_owner" = $3::uuid,
                "inbox_lease_generation" = $4::uuid, "started_at" = coalesce("started_at", now()),
                "engine_turn_active" = true, "runtime_session_id" = coalesce("runtime_session_id", $5)
          WHERE "id" = $1::uuid`,
        [sessionId, runnerId, lease.owner, lease.generation, randomUUID()]);
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
  }

  let first: { eventId: string; messageId: string; sessionId: string } | undefined;

  await t.test('(1) a top-level mention in a group with no route opens a session with the app\'s settings and an implicit route', async () => {
    const m = await mention(DESIGN, BOB, 'Draft the release notes');
    const sessionId = sessionOf(m.messageId);
    first = { eventId: m.eventId, messageId: m.messageId, sessionId };
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.deepEqual([session.ownerId, session.workspaceId, session.permissionMode], [ownerId, shared.id, OPEN_MODE],
      "the app's open workspace and mode, not the default workspace or the account's mode");
    const opening = await db.conversationTurn.findFirstOrThrow({ where: { sessionId }, orderBy: { seq: 'asc' } });
    assert.deepEqual([opening.externalSenderSource, opening.externalSenderId, opening.externalSenderName], ['FEISHU', BOB, 'Bob Chen']);

    const route = await routeOf(DESIGN);
    assert.ok(route, 'an implicit route');
    assert.deepEqual(
      [route.source, route.enabled, route.confirmedAt, route.workspaceId, route.permissionMode, route.chatName, route.firstUsedByOpenId, route.firstUsedByName],
      ['OPEN_ACCESS', true, null, null, null, 'Design', BOB, 'Bob Chen']);
    assert.ok(route.firstUsedAt);

    const thread = await db.feishuThread.findFirstOrThrow({ where: { appId: X.appId, chatId: DESIGN, rootMessageId: m.messageId } });
    assert.deepEqual([thread.sessionId, thread.openAccessOpenId], [sessionId, BOB], 'the topic is the session\'s, counted as Bob\'s');
    assert.notEqual(thread.lastSpokenAt.getTime(), 0, 'the reservation was stamped');

    assert.equal(m.replies.length, 1);
    const receipt = m.replies[0]!;
    assert.equal((receipt.body as { reply_in_thread?: boolean }).reply_in_thread, true, 'answered in a topic');
    assert.equal(textOf(receipt), `Started · ${session.title}`);

    const recorded = await db.activity.findMany({ where: { actorId: ownerId, type: { startsWith: 'feishu.group.' } } });
    assert.deepEqual(recorded.map((a) => [a.type, a.credentialKind]), [['feishu.group.session.created', 'FEISHU']]);
    assert.deepEqual((recorded[0]!.payload as Row).sessionId, sessionId);
    assert.deepEqual([(recorded[0]!.payload as Row).openId, (recorded[0]!.payload as Row).messageId], [BOB, m.messageId]);
  });

  await t.test('(1, O5) an approval of that session goes to the owner alone and says who started it, in which group', async () => {
    await claim(first!.sessionId);
    const from = fake.messages.length;
    const filed = await runner('POST', `/sessions/${uuidToBase62(first!.sessionId)}/approvals`, {
      toolName: 'Bash', input: { command: 'ls' }, toolUseId: `tu-${randomUUID()}`,
    });
    assert.equal(filed.status, 201, filed.text);
    const approvalId = filed.json.id as string;
    await until(`the card of approval ${approvalId} SENT`, () => db.feishuMessage.findFirst({ where: { appId: X.appId, approvalId, status: 'SENT' } }));
    await sleep(500);
    const sent = fake.messages.slice(from).filter((m) => m.path.startsWith('/open-apis/im/v1/messages'));
    assert.equal(sent.length, 1, 'one card');
    const [card] = sent;
    assert.equal(card!.path, '/open-apis/im/v1/messages');
    assert.equal(card!.query.get('receive_id_type'), 'open_id');
    assert.equal((card!.body as Row).receive_id, ALICE, "the owner's open_id, not the group");
    const content = JSON.parse((card!.body as { content: string }).content) as { body: { elements: Array<Row> } };
    assert.ok(JSON.stringify(content.body.elements[0]).includes('Started by Bob Chen in Design'), JSON.stringify(content.body.elements[0]));
    await db.approval.update({ where: { id: approvalId }, data: { status: 'DENIED', decidedAt: new Date() } });
  });

  await t.test('(2) the same event handled twice makes one session, one route, one topic row and one activity', async () => {
    await sql.query(`UPDATE feishu_inbound_event SET processed_at = NULL, attempts = 1, lease_until = NULL WHERE app_id = $1 AND event_id = $2`,
      [X.appId, first!.eventId]);
    await processed(first!.eventId, 2);
    const receipts = () => fake.requestsTo(`/open-apis/im/v1/messages/${first!.messageId}/reply`);
    await until('the receipt sent again', () => receipts().length === 2);
    await sleep(300);
    assert.equal(await db.session.count({ where: { id: first!.sessionId } }), 1);
    assert.equal(await db.session.count({ where: { ownerId, workspaceId: shared.id } }), 1, 'one session in the open workspace');
    assert.equal(await db.feishuChatRoute.count({ where: { appId: X.appId, chatId: DESIGN } }), 1);
    assert.equal(await db.feishuThread.count({ where: { appId: X.appId, chatId: DESIGN } }), 1);
    assert.equal(await db.activity.count({ where: { actorId: ownerId, type: 'feishu.group.session.created' } }), 1);
    const [a, b] = receipts();
    assert.equal((b!.body as { uuid: string }).uuid, (a!.body as { uuid: string }).uuid, 'the same uuid, so Feishu delivers the receipt once');
    assert.equal(repliesTo(first!.messageId).length, 1, 'one receipt delivered');
  });

  await t.test('(3) a mention inside the topic is a turn of the same session', async () => {
    const m = await mention(DESIGN, CAROL, 'Add the migration notes too', { rootId: first!.messageId, quiet: true });
    const turn = await until('the topic turn', () => db.conversationTurn.findFirst({ where: { sessionId: first!.sessionId, content: 'Add the migration notes too' } }));
    assert.deepEqual([turn.externalSenderSource, turn.externalSenderId, turn.externalSenderName], ['FEISHU', CAROL, 'Carol Wu']);
    assert.equal(await db.session.count({ where: { id: sessionOf(m.messageId) } }), 0, 'no session of its own');
    assert.equal(await db.activity.count({ where: { actorId: ownerId, type: 'feishu.group.session.turn' } }), 1);
  });

  await t.test('(4) a connected group uses its own route, and its sessions are not the open bot\'s', async () => {
    const m = await mention(TEAM, BOB, 'Rotate the logs');
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionOf(m.messageId) } });
    assert.deepEqual([session.workspaceId, session.permissionMode], [team.id, ROUTE_MODE], "the route's workspace and mode");
    const thread = await db.feishuThread.findFirstOrThrow({ where: { appId: X.appId, chatId: TEAM, rootMessageId: m.messageId } });
    assert.equal(thread.openAccessOpenId, null, 'not counted against the open bot');
    assert.equal((await routeOf(TEAM))!.source, 'CONNECT');
    assert.equal(textOf(m.replies[0]!), `Started · ${session.title}`, 'not refused by Bob\'s open limit');
  });

  await t.test('(5) over a limit nothing is started and nothing is written; the owner\'s own mention gets today\'s sentence', async () => {
    const over = await mention(OPS, BOB, 'Check the disk');
    assert.deepEqual(over.replies.map(textOf), [PERSON_RUNNING]);
    assert.equal((over.replies[0]!.body as { reply_in_thread?: boolean }).reply_in_thread, true, 'answered in a topic');
    assert.deepEqual(over.stray, [], 'no session, no route, no topic row, no activity');
    assert.equal(await routeOf(OPS), null);
    const owner = await mention(OPS, ALICE, 'Check the disk');
    assert.deepEqual(owner.replies.map(textOf), [NOT_CONNECTED]);
    assert.deepEqual(owner.stray, []);
  });

  await t.test('(6) a group with people from another organization is refused and nothing is written', async () => {
    const m = await mention(PARTNERS, CAROL, 'Share the roadmap');
    assert.deepEqual(m.replies.map(textOf), [EXTERNAL]);
    assert.deepEqual(m.stray, []);
    assert.equal(await routeOf(PARTNERS), null);
  });

  await t.test('(7) an implicit route the owner switched off starts nothing, writes nothing, and says so', async () => {
    const opened = await mention(QA, CAROL, 'Run the smoke tests');
    assert.ok(await db.session.findUnique({ where: { id: sessionOf(opened.messageId) } }), "Carol's session in QA");
    const route = await routeOf(QA);
    assert.equal(route!.source, 'OPEN_ACCESS');
    await db.feishuChatRoute.update({ where: { id: route!.id }, data: { enabled: false, disabledReason: 'OWNER' } });
    const m = await mention(QA, DAVE, 'Run them again');
    assert.deepEqual(m.replies.map(textOf), [SWITCHED_OFF]);
    assert.deepEqual(m.stray, []);
  });

  await t.test('(8) back to OWNER_ONLY: groups using the app\'s settings start nothing; a connected group still works', async () => {
    await db.feishuApp.update({ where: { appId: X.appId }, data: { accessMode: 'OWNER_ONLY' } });
    for (const chatId of [DESIGN, OPS]) {
      const m = await mention(chatId, DAVE, 'Summarize the week');
      assert.deepEqual(m.replies.map(textOf), [NOT_CONNECTED], chatId);
      assert.deepEqual(m.stray, [], chatId);
    }
    const still = await mention(TEAM, DAVE, 'Summarize the week');
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionOf(still.messageId) } });
    assert.equal(textOf(still.replies[0]!), `Started · ${session.title}`);
  });

  await t.test('(9) the bot removed from a group switches its implicit route off', async () => {
    const eventId = `ev-group-open-${RUN}-removed`;
    const ack = await fake.push(connection, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.chat.member.bot.deleted_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: { chat_id: DESIGN, operator_id: { open_id: ALICE } },
    });
    assert.equal(ack.code, 200);
    await processed(eventId);
    const route = await routeOf(DESIGN);
    assert.deepEqual([route!.source, route!.enabled, route!.disabledReason], ['OPEN_ACCESS', false, 'BOT_REMOVED']);
  });
});
