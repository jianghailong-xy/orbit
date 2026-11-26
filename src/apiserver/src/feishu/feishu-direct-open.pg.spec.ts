/**
 * Someone other than the owner, in the app's availability scope, direct-messages the open bot (docs/feishu-bot-design.md
 * §14.2 direct messages, §14.4, §14.6; task O3), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty, the production apiserver (`build/main.js`), and the fake open platform its long connection reaches. Every event
 * is pushed down that connection as Feishu would push it, and goes through the inbox, the router (O2's availability
 * check first) and FeishuDirectService. Every table carries the write trap of the tenant isolation census. What it is
 * held to, with the app's access_mode AVAILABILITY_SCOPE:
 *
 *   (1) a top-level message opens a session in open_workspace_id, in open_permission_mode, opened by FEISHU, whose first
 *       turn records the sender (Feishu, the open_id, the name); its chain is a feishu_thread row with the sender as
 *       open_access_open_id; one activity row (credential_kind FEISHU); the receipt `Started · <title>` is a reply to the
 *       message, its request body pinned field by field: no URL, no Open in Orbit, no workspace name;
 *   (2) the same event processed a second time makes no second session, no second activity, and its receipt carries the
 *       same uuid;
 *   (3) the turn's last words come back to the sender's chain through the outbox, the words alone, pinned field by field;
 *   (4) a reply in the chain is a turn of the same session, recording the sender, once even when handled twice; a reply
 *       to a message no chain of theirs starts from is answered and writes nothing; a new top-level message opens a new
 *       session;
 *   (5) each of the four limits — per person at a time, per person a day, in all at a time, in all a day — refuses a
 *       request: no session, nothing written but the inbox's record and one activity row, and the §14.6 sentence; the
 *       refusal handled again writes nothing more and is delivered once;
 *   (6) an approval of such a session goes to the owner alone, its card's first line `Started by <name> in a direct
 *       message` (O5);
 *   (7) the owner's own direct message still opens a session in the default workspace, with today's receipt; a click on
 *       a card by someone else is still refused;
 *   (8) under OWNER_ONLY a stranger's direct message, top-level or in their old chain, gets today's stranger sentence and
 *       writes nothing.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-direct-open.pg.spec.ts
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
import { feishuDedupeUuid } from './feishu-outbound';
import { FEISHU_TEST_TIME_SCALE_ENV } from './feishu-timing';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-direct-open-${randomUUID()}`;
const SCALE = '20';
process.env[FEISHU_TEST_TIME_SCALE_ENV] = SCALE;
const RUN = randomBytes(4).toString('hex');
const RUNNER_TOKEN = `feishu-direct-open-runner-${randomUUID()}`;

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Helper' };
const ALICE = 'ou_alice_open_owner';
const CAROL = 'ou_carol_open';
const DAVE = 'ou_dave_open';
const ERIN = 'ou_erin_open';
const FRANK = 'ou_frank_open';
const GRACE = 'ou_grace_open';
const chatOf = (openId: string) => `oc_p2p_${openId}_${RUN}`;

/** The sentences, spelled out here rather than imported, so the spec pins the words themselves. */
const STRANGER_DM = 'This bot only takes direct messages from its owner.';
const NOT_LINKED = "This message isn't linked to a session. To start a new session, send a new message rather than a reply.";
const PERSON_RUNNING_1 = 'You already have a session running. Wait for it to finish, then send this again.';
const PERSON_DAILY_1 = "You've started 1 session today, the most this bot allows one person. Try again after midnight UTC.";
const totalRunning = (n: number) => `This bot is already running ${n === 1 ? '1 session' : `${n} sessions`}, the most it allows at a time. Try again when one finishes.`;
const totalDaily = (n: number) => `This bot has started ${n === 1 ? '1 session' : `${n} sessions`} today, the most it allows in a day. Try again after midnight UTC.`;
const STRANGER_CARD = 'Only the owner of this bot can answer this card.';

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

test('Feishu open access: someone in the availability scope direct-messages the bot and gets a session of their own', {
  skip: !URL, concurrency: 1, timeout: 600_000,
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
  for (const who of [CAROL, DAVE, ERIN, FRANK, GRACE]) fake.availability.set(who, 'IN');
  fake.userNames.set(CAROL, 'Carol Wu');
  fake.userNames.set(DAVE, 'Dave Li');
  const fakeUrl = await fake.start();

  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `feishu-direct-open-${RUN}@feishu-direct-open.invalid`, name: 'owner', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'a runner', tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
  });
  beating = setInterval(() => void sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId]).catch(() => undefined), 3_000);
  const personal = await db.workspace.create({ data: { ownerId, runnerId, name: `personal ${RUN}`, enabled: true } });
  const open = await db.workspace.create({ data: { ownerId, runnerId, name: `open ${RUN}`, enabled: true } });
  await db.feishuApp.create({
    data: {
      ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), botName: X.botName, ownerOpenId: ALICE, ownerName: 'Alice',
      defaultWorkspaceId: personal.id, messageDetail: 'TITLES_ONLY',
      accessMode: 'AVAILABILITY_SCOPE', openWorkspaceId: open.id, openPermissionMode: 'acceptEdits',
      openMaxRunningPerPerson: 5, openSessionsPerDayPerPerson: 100, openMaxRunningTotal: 50, openSessionsPerDayTotal: 1000,
    },
  });

  server = await startApiserver(url, `feishu-direct-open-${randomUUID()}`, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE });
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
  /** Every row written since `since`, beyond the inbox's own record of `eventId`, the connection's heartbeat and the runner's. */
  const writesSince = async (since: bigint, eventId: string, app: Row, links: Row[]) => {
    const rows = (await sql.query<{ tbl: string; op: string; row: Row }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`, [since.toString()],
    )).rows;
    const linkBefore = JSON.stringify(links.map((l) => without(l, 'heartbeat_at')));
    return rows.filter(({ tbl, op, row }) => {
      if (tbl === 'feishu_inbound_event' && (op === 'INSERT' || op === 'UPDATE') && row.event_id === eventId && row.app_id === X.appId) return false;
      if (tbl === 'feishu_app' && op === 'UPDATE' && JSON.stringify(without(row, 'last_event_at')) === JSON.stringify(without(app, 'last_event_at'))) return false;
      if (tbl === 'feishu_link' && op === 'UPDATE' && linkBefore.includes(JSON.stringify(without(row, 'heartbeat_at')))) return false;
      if (tbl === 'runner' && op === 'UPDATE') return false;
      return true;
    });
  };
  const describe = (rows: Array<{ tbl: string; op: string; row: Row }>) => rows.map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);

  const processed = (eventId: string, attempts = 1) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts >= $3`,
        [X.appId, eventId, attempts])).rowCount).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
    });
  const replyRequests = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);
  const repliesTo = (messageId: string) => replyRequests(messageId)
    .filter((m) => (m.body as { msg_type: string }).msg_type === 'text')
    .map((m) => (JSON.parse((m.body as { content: string }).content) as { text: string }).text);

  let seq = 0;
  /**
   * Push one direct message from `openId` and wait until the inbox processed it and the bot answered it. `inReplyTo` makes
   * it a reply in the chain that message starts. Resolves with what was written beyond the inbox's record.
   */
  async function dm(openId: string, text: string, inReplyTo?: string, opts: { expectReply?: boolean } = {}) {
    const eventId = `ev-direct-open-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: 'user' },
        message: {
          message_id: messageId, chat_id: chatOf(openId), chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }),
          ...(inReplyTo ? { root_id: inReplyTo, parent_id: inReplyTo } : {}),
        },
      },
    };
    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    const ack = await fake.push(connection, envelope);
    assert.equal(ack.code, 200);
    await processed(eventId);
    if (opts.expectReply !== false) await until(`a reply to ${messageId}`, () => replyRequests(messageId).length > 0);
    await sleep(300);
    return { eventId, messageId, before, writes: await writesSince(before, eventId, app, links), replies: repliesTo(messageId) };
  }

  /** Process `eventId` once more, as the inbox does when a lease ran out; resolves with what that wrote. */
  async function again(eventId: string) {
    await sql.query(`UPDATE feishu_inbound_event SET processed_at = NULL, attempts = 1, lease_until = NULL WHERE app_id = $1 AND event_id = $2`, [X.appId, eventId]);
    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    await processed(eventId, 2);
    await sleep(500);
    return writesSince(before, eventId, app, links);
  }

  const openSessionOf = (messageId: string) => feishuDerivedUuid('feishu-open-session', X.appId, messageId);
  const activities = (type: string, messageId: string) =>
    db.activity.findMany({ where: { type, credentialKind: 'FEISHU', payload: { path: ['messageId'], equals: messageId } } });

  /** A receipt or a refusal: a text reply to the message, pinned field by field, carrying no link. */
  function assertPlainReply(r: FakeRequest, messageId: string, purpose: string, words: string) {
    assert.equal(r.method, 'POST');
    assert.equal(r.query.toString(), '', 'no query beyond the path');
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['content', 'msg_type', 'reply_in_thread', 'uuid']);
    assert.equal(body.msg_type, 'text');
    assert.equal(body.reply_in_thread, false, 'a reply in the direct chat, not a topic');
    assert.equal(body.uuid, feishuDedupeUuid('direct-reply', X.appId, messageId, purpose));
    assert.deepEqual(JSON.parse(body.content as string), { text: words });
    const all = JSON.stringify(body);
    for (const absent of ['http', 'Open in Orbit', 'Orbit', '/sessions/', open.name, personal.name]) assert.ok(!all.includes(absent), `the reply carries no ${absent}`);
  }

  // The runner claims a session and completes one turn with the given events, as in feishu-group-boundary.pg.spec.ts.
  const runnerRoute = (sessionId: string, rest: string) => `/api/runner/sessions/${uuidToBase62(sessionId)}/${rest}`;
  const leases = new Map<string, { owner: string; generation: string }>();
  async function claim(sessionId: string, engineTurnActive: boolean) {
    let lease = leases.get(sessionId);
    if (!lease) {
      lease = { owner: randomUUID(), generation: randomUUID() };
      leases.set(sessionId, lease);
      await sql.query(`INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [lease.generation, sessionId, lease.owner]);
    }
    await sql.query('BEGIN');
    try {
      await sql.query(`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`);
      await sql.query(
        `UPDATE "session" SET "turn_state" = 'IN_FLIGHT', "assigned_runner_id" = $2::uuid, "inbox_lease_owner" = $3::uuid,
                "inbox_lease_generation" = $4::uuid, "started_at" = coalesce("started_at", now()),
                "engine_turn_active" = $5, "runtime_session_id" = coalesce("runtime_session_id", $6)
          WHERE "id" = $1::uuid`,
        [sessionId, runnerId, lease.owner, lease.generation, engineTurnActive, randomUUID()]);
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
    return lease;
  }
  let eventSeq = 0;
  async function runTurn(sessionId: string, turnId: string, events: Array<{ type: string; payload: Record<string, unknown> }>) {
    const lease = await claim(sessionId, false);
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT', "delivered_at" = now(), "lease_deadline_at" = now() + interval '5 minutes',
              "lease_generation" = $2::uuid
        WHERE "id" = $1::uuid`,
      [turnId, lease.generation]);
    const posted = await call(server!, 'POST', runnerRoute(sessionId, 'events'), RUNNER_TOKEN, {
      leaseOwner: lease.owner,
      events: events.map((e) => ({ seq: ++eventSeq, type: e.type, turnId, ts: new Date().toISOString(), payload: e.payload })),
    }, { 'x-orbit-runner-caller': 'mcp' });
    assert.equal(posted.status, 202, posted.text);
    const done = await call(server!, 'POST', runnerRoute(sessionId, 'turn-complete'), RUNNER_TOKEN, {
      turnId, leaseOwner: lease.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1, costUsd: 0,
    }, { 'x-orbit-runner-caller': 'mcp' });
    assert.equal(done.status, 200, done.text);
    await sql.query(`UPDATE "session" SET "turn_state" = NULL WHERE "id" = $1::uuid`, [sessionId]);
  }
  /** The session is no longer running, so it holds no "at a time" slot. */
  const settle = (sessionId: string) => sql.query(`UPDATE "session" SET "turn_state" = NULL WHERE "id" = $1::uuid`, [sessionId]);

  let carol: { messageId: string; sessionId: string; eventId: string } | undefined;

  await t.test('(1) a top-level message opens a session in the open settings, recording the sender, answered with the title alone', async () => {
    const sent = await dm(CAROL, 'Check the disk usage on the build host');
    const sessionId = openSessionOf(sent.messageId);
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    carol = { messageId: sent.messageId, sessionId, eventId: sent.eventId };
    assert.equal(session.ownerId, ownerId, 'owned by the account');
    assert.equal(session.workspaceId, open.id, 'in open_workspace_id');
    assert.equal(session.permissionMode, 'acceptEdits', 'in open_permission_mode');
    assert.equal(session.openedBy, 'FEISHU');
    const turns = await db.conversationTurn.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } });
    assert.ok(turns.length >= 1, 'a first turn');
    assert.deepEqual([turns[0]!.externalSenderSource, turns[0]!.externalSenderId, turns[0]!.externalSenderName], ['FEISHU', CAROL, 'Carol Wu'],
      'the first turn records the sender');
    const thread = await db.feishuThread.findFirstOrThrow({ where: { appId: X.appId, chatId: chatOf(CAROL), rootMessageId: sent.messageId } });
    assert.equal(thread.sessionId, sessionId);
    assert.equal(thread.openAccessOpenId, CAROL, 'the chain counts toward the open limits');
    assert.ok(thread.lastSpokenAt.getTime() > 0, 'the reservation was stamped once the session was made');
    assert.equal(await db.feishuChatRoute.count({ where: { appId: X.appId, chatId: chatOf(CAROL) } }), 0, 'a direct chat: no route');
    const made = await activities('feishu.open.session.created', sent.messageId);
    assert.equal(made.length, 1, 'one activity');
    assert.equal(made[0]!.actorId, ownerId);
    assert.deepEqual(made[0]!.payload, {
      sessionId, workspaceId: open.id, chatId: chatOf(CAROL), appId: X.appId, openId: CAROL, messageId: sent.messageId,
    });
    const receipts = replyRequests(sent.messageId);
    assert.equal(receipts.length, 1, 'one receipt');
    assertPlainReply(receipts[0]!, sent.messageId, 'started', `Started · ${session.title}`);
    // What the event wrote: the session, its first turn, the chain and the activity — and nothing of the owner's
    // settings or of any group.
    const wrote = (tbl: string, op: string) => sent.writes.some((w) => w.tbl === tbl && w.op === op);
    for (const [tbl, op] of [['session', 'INSERT'], ['conversation_turn', 'INSERT'], ['feishu_thread', 'INSERT'], ['activity', 'INSERT']]) {
      assert.ok(wrote(tbl!, op!), `${op} ${tbl}`);
    }
    for (const tbl of ['feishu_app', 'feishu_chat_route', 'feishu_message', 'feishu_connect_code']) {
      assert.deepEqual(describe(sent.writes.filter((w) => w.tbl === tbl)), [], `nothing written to ${tbl}`);
    }
  });

  await t.test('(2) the same event processed again makes no second session or activity, and its receipt is delivered once', async () => {
    const writes = await again(carol!.eventId);
    assert.deepEqual(describe(writes), [], 'nothing written');
    assert.equal(await db.session.count({ where: { ownerId, workspaceId: open.id } }), 1, 'one session');
    assert.equal((await activities('feishu.open.session.created', carol!.messageId)).length, 1, 'one activity');
    // Every request Feishu was sent; fake.messages holds only what it delivered, once per uuid.
    const [first, second] = fake.requestsTo(`/open-apis/im/v1/messages/${carol!.messageId}/reply`);
    assert.ok(second, 'the receipt was asked again');
    assert.equal(replyRequests(carol!.messageId).length, 1, 'and delivered once');
    assert.equal((second!.body as { uuid: string }).uuid, (first!.body as { uuid: string }).uuid, 'with the same uuid, so Feishu delivers it once');
  });

  await t.test('(3) the turn\'s last words come back to the sender\'s chain alone: no link, no button, no tool output', async () => {
    const first = await db.conversationTurn.findFirstOrThrow({ where: { sessionId: carol!.sessionId }, orderBy: { seq: 'asc' } });
    const finalWords = 'The build host has 41 GB free.';
    const secret = `secret-tool-output-${RUN}`;
    await runTurn(carol!.sessionId, first.id, [
      { type: 'assistant', payload: { text: 'Let me look.' } },
      { type: 'tool_use', payload: { id: 'tu-1', name: 'Bash', input: { command: 'df -h > /tmp/df.txt' } } },
      { type: 'tool_result', payload: { toolUseId: 'tu-1', content: `${secret} wrote /tmp/df.txt`, isError: false } },
      { type: 'assistant', payload: { text: finalWords } },
    ]);
    const row = await until('the reply sent', async () => {
      const r = await db.feishuOutbox.findUnique({ where: { turnId: first.id } });
      return r?.status === 'SENT' ? r : null;
    }).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
    });
    assert.deepEqual([row.chatId, row.rootMessageId, row.text], [chatOf(CAROL), carol!.messageId, finalWords]);
    const answers = replyRequests(carol!.messageId).filter((r) => (r.body as { msg_type: string }).msg_type === 'interactive');
    assert.equal(answers.length, 1);
    const reply = answers[0]!;
    assert.equal(reply.method, 'POST');
    assert.equal(reply.query.toString(), '');
    const body = reply.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['content', 'msg_type', 'reply_in_thread', 'uuid']);
    assert.equal(body.reply_in_thread, false, 'a reply in the direct chat');
    assert.equal(body.uuid, feishuDedupeUuid('session-reply', X.appId, row.id));
    assert.deepEqual(JSON.parse(body.content as string), {
      schema: '2.0',
      config: { summary: { content: finalWords } },
      body: { direction: 'vertical', elements: [{ tag: 'markdown', content: finalWords }] },
    }, 'the last words, and nothing else');
    const all = JSON.stringify(body);
    for (const absent of [secret, 'df -h', '/tmp/df.txt', 'Let me look', 'Open in Orbit', 'Orbit', '/sessions/', 'open_url', 'http']) {
      assert.ok(!all.includes(absent), `the reply carries no ${absent}`);
    }
  });

  await t.test('(4) a reply in the chain is a turn of the same session; a stray reply is answered; a new message opens a new session', async () => {
    const before = await db.conversationTurn.count({ where: { sessionId: carol!.sessionId } });
    const reply = await dm(CAROL, 'And the logs directory?', carol!.messageId, { expectReply: false });
    const turns = await db.conversationTurn.findMany({ where: { sessionId: carol!.sessionId }, orderBy: { seq: 'asc' } });
    assert.equal(turns.length, before + 1, 'one more turn in the same session');
    const turn = turns[turns.length - 1]!;
    assert.equal(turn.content, 'And the logs directory?');
    assert.deepEqual([turn.externalSenderSource, turn.externalSenderId, turn.externalSenderName], ['FEISHU', CAROL, 'Carol Wu']);
    assert.deepEqual(reply.replies, [], 'a turn is not answered with a sentence');
    const turned = await activities('feishu.open.session.turn', reply.messageId);
    assert.equal(turned.length, 1);
    assert.deepEqual(turned[0]!.payload, { sessionId: carol!.sessionId, turnId: turn.id, chatId: chatOf(CAROL), appId: X.appId, openId: CAROL, messageId: reply.messageId });
    assert.equal(await db.feishuThread.count({ where: { sessionId: carol!.sessionId } }), 1, 'no second chain');
    // The same reply handled again: no second turn, no second activity.
    await again(reply.eventId);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: carol!.sessionId } }), before + 1, 'still one more turn');
    assert.equal((await activities('feishu.open.session.turn', reply.messageId)).length, 1, 'still one activity');

    // A reply to a message no chain of hers starts from.
    const stray = await dm(CAROL, 'what about this?', `om_unknown_${RUN}`);
    assert.deepEqual(stray.replies, [NOT_LINKED]);
    assert.deepEqual(describe(stray.writes), []);
    assertPlainReply(replyRequests(stray.messageId)[0]!, stray.messageId, 'not-linked', NOT_LINKED);
    // Nor can she reach someone else's chain: Dave's.
    await settle(carol!.sessionId);
    const daves = await dm(DAVE, 'Rotate the logs');
    await settle(openSessionOf(daves.messageId));
    const intrude = await dm(CAROL, 'let me in', daves.messageId);
    assert.deepEqual(intrude.replies, [NOT_LINKED]);
    assert.deepEqual(describe(intrude.writes), []);

    // A new top-level message: a new session.
    const fresh = await dm(CAROL, 'Now check the memory');
    const freshId = openSessionOf(fresh.messageId);
    assert.notEqual(freshId, carol!.sessionId);
    const made = await db.session.findUniqueOrThrow({ where: { id: freshId } });
    assert.equal(made.workspaceId, open.id);
    assert.deepEqual(fresh.replies, [`Started · ${made.title}`]);
    await settle(freshId);
  });

  /** Set the four limits, then push one request from `openId` that one of them refuses. */
  async function refused(openId: string, limits: { perRun: number; perDay: number; allRun: number; allDay: number }, words: string, limit: string) {
    await db.feishuApp.update({
      where: { appId: X.appId },
      data: {
        openMaxRunningPerPerson: limits.perRun, openSessionsPerDayPerPerson: limits.perDay,
        openMaxRunningTotal: limits.allRun, openSessionsPerDayTotal: limits.allDay,
      },
    });
    const sessionsBefore = await db.session.count({ where: { ownerId } });
    const sent = await dm(openId, `please run job for ${limit}`);
    assert.deepEqual(sent.replies, [words], `${limit}: the sentence`);
    assertPlainReply(replyRequests(sent.messageId)[0]!, sent.messageId, 'over-limit', words);
    assert.equal(await db.session.count({ where: { ownerId } }), sessionsBefore, `${limit}: no session`);
    assert.equal(await db.session.count({ where: { id: openSessionOf(sent.messageId) } }), 0, `${limit}: not the derived one either`);
    // Nothing written but the inbox's record and one activity row.
    assert.equal(sent.writes.length, 1, `${limit}: one write: ${describe(sent.writes).join('\n')}`);
    const [w] = sent.writes;
    assert.deepEqual([w!.tbl, w!.op, w!.row.type, w!.row.credential_kind], ['activity', 'INSERT', 'feishu.open.refused', 'FEISHU'], `${limit}: the activity row`);
    const payload = w!.row.payload as Row;
    assert.deepEqual(without(payload, 'max'), { chatId: chatOf(openId), limit, appId: X.appId, openId, messageId: sent.messageId });
    // Handled again: nothing more written, the same uuid.
    assert.deepEqual(describe(await again(sent.eventId)), [], `${limit}: a second handling writes nothing`);
    const [first, second] = fake.requestsTo(`/open-apis/im/v1/messages/${sent.messageId}/reply`);
    assert.ok(second, `${limit}: the refusal was asked again`);
    assert.equal((second!.body as { uuid: string }).uuid, (first!.body as { uuid: string }).uuid, `${limit}: with the same uuid`);
    assert.deepEqual(repliesTo(sent.messageId), [words], `${limit}: delivered once`);
  }
  const openCounts = async () => (await sql.query<{ running: number; today: number }>(
    `SELECT count(*) FILTER (WHERE s."status" IN ('PENDING', 'RUNNING') AND s."deleted_at" IS NULL)::int AS "running",
            count(*) FILTER (WHERE s."id" IS NOT NULL)::int AS "today"
       FROM "feishu_thread" t LEFT JOIN "session" s ON s."id" = t."session_id"
      WHERE t."app_id" = $1 AND t."open_access_open_id" IS NOT NULL`, [X.appId])).rows[0]!;

  await t.test('(5) each limit refuses a request: no session, one activity row, the §14.6 sentence', async () => {
    // Per person at a time: Erin has one session running.
    const erins = await dm(ERIN, 'Build the docs');
    await refused(ERIN, { perRun: 1, perDay: 100, allRun: 50, allDay: 1000 }, PERSON_RUNNING_1, 'PERSON_RUNNING');
    // Per person a day: Erin's session finished; she has started one today.
    await settle(openSessionOf(erins.messageId));
    await refused(ERIN, { perRun: 5, perDay: 1, allRun: 50, allDay: 1000 }, PERSON_DAILY_1, 'PERSON_DAILY');
    // In all at a time: Frank has none, but everyone together has as many running as the bot allows.
    const frank = await dm(FRANK, 'Warm the cache');
    const { running } = await openCounts();
    assert.ok(running >= 1, 'a session is running');
    assert.ok(frank.replies[0]!.startsWith('Started · '));
    await refused(GRACE, { perRun: 5, perDay: 100, allRun: running, allDay: 1000 }, totalRunning(running), 'TOTAL_RUNNING');
    // In all a day: everyone together has started as many today as the bot allows.
    const { today } = await openCounts();
    await refused(GRACE, { perRun: 5, perDay: 100, allRun: 50, allDay: today }, totalDaily(today), 'TOTAL_DAILY');
    await db.feishuApp.update({
      where: { appId: X.appId },
      data: { openMaxRunningPerPerson: 5, openSessionsPerDayPerPerson: 100, openMaxRunningTotal: 50, openSessionsPerDayTotal: 1000 },
    });
  });

  await t.test('(6) an approval of such a session goes to the owner, saying who started it in a direct message', async () => {
    const sessionId = carol!.sessionId;
    await claim(sessionId, true);
    const from = fake.messages.length;
    const filed = await call(server!, 'POST', runnerRoute(sessionId, 'approvals'), RUNNER_TOKEN,
      { toolName: 'Bash', input: { command: 'du -sh /var/log' }, toolUseId: `tu-${randomUUID()}` }, { 'x-orbit-runner-caller': 'mcp' });
    assert.equal(filed.status, 201, filed.text);
    const approvalId = filed.json.id as string;
    const row = await until(`the card of approval ${approvalId} SENT`, () => db.feishuMessage.findFirst({ where: { appId: X.appId, approvalId, status: 'SENT' } }))
      .catch((error) => {
        throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
      });
    await sleep(500);
    const sent = fake.messages.slice(from).filter((m) => m.path.startsWith('/open-apis/im/v1/messages'));
    assert.equal(sent.length, 1, 'one card');
    const r = sent[0]!;
    assert.equal(r.path, '/open-apis/im/v1/messages');
    assert.equal(r.query.get('receive_id_type'), 'open_id');
    assert.equal((r.body as { receive_id: string }).receive_id, ALICE, 'to the owner, not to Carol');
    assert.equal(row.receiveId, ALICE);
    const card = JSON.parse((r.body as { content: string }).content) as { body: { elements: unknown[] } };
    assert.deepEqual(card.body.elements[0], {
      tag: 'div', text: { tag: 'plain_text', content: 'Started by Carol Wu in a direct message', text_size: 'notation', text_color: 'grey' },
    });
    await db.approval.update({ where: { id: approvalId }, data: { status: 'DENIED', decidedAt: new Date() } });
    await settle(sessionId);
  });

  await t.test('(7) the owner\'s own direct message is today\'s path; someone else\'s card click is still refused', async () => {
    const mine = await dm(ALICE, 'My own work');
    const sessionId = feishuDerivedUuid('feishu-session', X.appId, mine.messageId);
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.workspaceId, personal.id, 'the default workspace');
    assert.deepEqual(mine.replies, [`Started · ${session.title} · ${personal.name}`]);
    const thread = await db.feishuThread.findFirstOrThrow({ where: { sessionId } });
    assert.equal(thread.openAccessOpenId, null, 'the owner\'s chain counts toward no limit');
    const turn = await db.conversationTurn.findFirst({ where: { sessionId }, orderBy: { seq: 'asc' } });
    assert.equal(turn?.externalSenderSource ?? null, null, 'the owner\'s words are the owner\'s');

    const eventId = `ev-direct-open-card-${RUN}`;
    const [app, links] = [await appRow(), await linkRows()];
    const before = await mark();
    const ack = await fake.push(connection, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'card.action.trigger', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        operator: { open_id: CAROL },
        action: { tag: 'button', value: { kind: 'approval', approvalId: randomUUID(), decision: 'allow' } },
        context: { open_message_id: `om_card_${RUN}`, open_chat_id: chatOf(CAROL) },
      },
    });
    assert.deepEqual(ack.data, { toast: { type: 'error', content: STRANGER_CARD } });
    await processed(eventId);
    await sleep(300);
    assert.deepEqual(describe(await writesSince(before, eventId, app, links)), []);
  });

  await t.test('(8) under OWNER_ONLY a stranger gets today\'s sentence and nothing is written, in their old chain too', async () => {
    await db.feishuApp.update({ where: { appId: X.appId }, data: { accessMode: 'OWNER_ONLY' } });
    const top = await dm(CAROL, 'Check the disk again');
    assert.deepEqual(top.replies, [STRANGER_DM]);
    assert.deepEqual(describe(top.writes), []);
    const inChain = await dm(CAROL, 'and again', carol!.messageId);
    assert.deepEqual(inChain.replies, [STRANGER_DM]);
    assert.deepEqual(describe(inChain.writes), []);
  });
});
