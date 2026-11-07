/**
 * Work sent from a connected Feishu group, one topic per request (docs/feishu-bot-design.md §8.2, decision 4; task
 * F3-2), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the production apiserver
 * (`build/main.js`) and the fake open platform its long connection reaches (feishu/test-support/fake-open-platform.ts).
 * Every event is pushed down that connection as Feishu would push it, and goes through the inbox and the router; the
 * runner's half of a turn is played over its HTTP routes. What it is held to:
 *
 *   (1) an allowed member's top-level `@bot <text>` opens a session owned by the route's account, in the route's
 *       workspace and the route's permission mode — not the app's default workspace, not the account's default mode;
 *       the bot answers in a topic on that message (reply_in_thread) with `Started · <title>`; the message is the root
 *       of the session's feishu_thread; the start is one activity with credential_kind FEISHU;
 *   (2) the same event handled again opens nothing more, and the receipt carries the same Feishu uuid;
 *   (3) end to end: the turn's last words come back into the topic, through the outbox, the words alone;
 *   (4) `@bot <text>` inside the topic is a turn of the same session — handled twice, one turn — and its answer comes
 *       back into the topic too;
 *   (5) someone the route does not allow is answered with one English sentence, starts no session and writes nothing
 *       (write trap), whether top-level or inside the topic;
 *   (6) the owner is always allowed, though not on the list;
 *   (7) a route with an empty list takes anyone in the group;
 *   (8) a mention inside a topic no session owns is answered and starts nothing.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-group.pg.spec.ts
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
process.env.PROVIDER_SECRET_KEY = `feishu-group-${randomUUID()}`;
const SCALE = '20';
process.env[FEISHU_TEST_TIME_SCALE_ENV] = SCALE;
const RUN = randomBytes(4).toString('hex');
const RUNNER_TOKEN = `feishu-group-runner-${randomUUID()}`;

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit team bot' };
const ALICE = 'ou_alice_group';
const BOB = 'ou_bob_group';
const MALLORY = 'ou_mallory_group';
const CAROL = 'ou_carol_group';
const TEAM = `oc_team_${RUN}`;
const OPEN = `oc_open_${RUN}`;
/** The account's default mode, and the mode the owner chose for the group: different, so the spec can tell them apart. */
const ACCOUNT_MODE = 'plan';
const ROUTE_MODE = 'acceptEdits';

/** The sentences the bot answers with, spelled out here so the spec pins the words themselves. */
const NOT_ALLOWED = "This group's Orbit connection doesn't take requests from you, so nothing was started. Ask the bot's owner to add you in Orbit.";
const NOT_LINKED = `This topic isn't linked to an Orbit session. To start one, send "@${X.botName} <request>" in the group, not in a topic.`;

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

test('Feishu: a connected group sends work, one topic per request', {
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
  const fakeUrl = await fake.start();

  const ownerId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `feishu-group-${RUN}@feishu-group.invalid`, name: 'owner', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER',
      preferences: { defaultPermissionMode: ACCOUNT_MODE },
    },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'a runner', tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
  });
  beating = setInterval(() => void sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId]).catch(() => undefined), 3_000);
  const personal = await db.workspace.create({ data: { ownerId, runnerId, name: `personal ${RUN}`, enabled: true } });
  const team = await db.workspace.create({ data: { ownerId, runnerId, name: `team ${RUN}`, enabled: true } });
  await db.feishuApp.create({
    data: {
      ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice',
      botName: X.botName, defaultWorkspaceId: personal.id,
    },
  });
  // Two confirmed groups, as the confirm page writes them: one with a list of senders, one open to everyone.
  for (const [chatId, allowedOpenIds] of [[TEAM, [BOB]], [OPEN, []]] as const) {
    await db.feishuChatRoute.create({
      data: {
        ownerId, appId: X.appId, chatId, chatName: chatId, workspaceId: team.id, permissionMode: ROUTE_MODE, allowedOpenIds: [...allowedOpenIds],
        maxConcurrentSessions: 5, sessionsPerDay: 50, enabled: true, confirmedAt: new Date(),
      },
    });
  }

  server = await startApiserver(url, `feishu-group-${randomUUID()}`, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE });
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
  /** Every write since `since` beyond the inbox's record of `eventId`, the app's last_event_at, the heartbeats. */
  const strayWrites = async (since: bigint, eventId: string, app: Row, links: Row[]): Promise<string[]> => {
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
    }).map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);
  };

  const processed = (eventId: string, attempts = 1) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(
        `SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts >= $3`,
        [X.appId, eventId, attempts],
      )).rowCount).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
    });
  const repliesTo = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);
  const bodyOf = (m: FakeRequest) => m.body as { msg_type: string; content: string; reply_in_thread: boolean; uuid: string };
  const textsTo = (messageId: string) => repliesTo(messageId).filter((m) => bodyOf(m).msg_type === 'text').map((m) => JSON.parse(bodyOf(m).content).text as string);
  const feishuActivity = () => db.activity.findMany({ where: { credentialKind: 'FEISHU', actorId: ownerId }, orderBy: { createdAt: 'asc' } });
  const sessionCount = () => db.session.count({ where: { ownerId } });

  let seq = 0;
  /** Push one group message that @-mentions the bot and wait until the inbox processed it. */
  async function mention(chatId: string, openId: string, text: string, topic?: { root: string; parent?: string }) {
    const eventId = `ev-group-work-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const ack = await fake.push(connection, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: 'user' },
        message: {
          message_id: messageId, chat_id: chatId, chat_type: 'group', message_type: 'text',
          content: JSON.stringify({ text: `@_user_1 ${text}` }),
          mentions: [{ key: '@_user_1', name: X.botName }],
          ...(topic ? { root_id: topic.root, parent_id: topic.parent ?? topic.root, thread_id: `omt_${topic.root}` } : {}),
        },
      },
    });
    assert.equal(ack.code, 200);
    await processed(eventId);
    return { eventId, messageId };
  }
  async function again(eventId: string) {
    const { attempts } = (await sql.query<{ attempts: number }>(
      `UPDATE feishu_inbound_event SET processed_at = NULL, lease_until = NULL WHERE app_id = $1 AND event_id = $2 RETURNING attempts`, [X.appId, eventId],
    )).rows[0];
    await processed(eventId, attempts + 1);
    await sleep(300);
  }

  // The runner's half of one turn, as feishu-outbox.pg.spec.ts plays it.
  const runner = (method: string, route: string, body?: unknown) => call(server!, method, route, RUNNER_TOKEN, body);
  const runnerRoute = (sessionId: string, rest: string) => `/api/runner/sessions/${uuidToBase62(sessionId)}/${rest}`;
  const leases = new Map<string, { owner: string; generation: string }>();
  let eventSeq = 0;
  async function runTurn(sessionId: string, turnId: string, text: string) {
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
        `UPDATE "session" SET "status" = 'RUNNING', "assigned_runner_id" = $2::uuid, "inbox_lease_owner" = $3::uuid,
                "inbox_lease_generation" = $4::uuid, "started_at" = coalesce("started_at", now())
          WHERE "id" = $1::uuid`,
        [sessionId, runnerId, lease.owner, lease.generation]);
      await sql.query('COMMIT');
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    }
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT', "delivered_at" = now(), "lease_deadline_at" = now() + interval '5 minutes',
              "lease_generation" = $2::uuid
        WHERE "id" = $1::uuid`,
      [turnId, lease.generation]);
    const posted = await runner('POST', runnerRoute(sessionId, 'events'), {
      leaseOwner: lease.owner,
      events: [{ seq: ++eventSeq, type: 'assistant', turnId, ts: new Date().toISOString(), payload: { text } }],
    });
    assert.equal(posted.status, 202, posted.text);
    const done = await runner('POST', runnerRoute(sessionId, 'turn-complete'), {
      turnId, leaseOwner: lease.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1, costUsd: 0,
    });
    assert.equal(done.status, 200, done.text);
    // Parked again, as a session whose turn ended is.
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [sessionId]);
  }
  const sentOutbox = (turnId: string) => until(`the reply of turn ${turnId} sent`, async () => {
    const row = await db.feishuOutbox.findUnique({ where: { turnId } });
    return row?.status === 'SENT' ? row : null;
  }).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
  });

  let started: { eventId: string; messageId: string; sessionId: string; receiptId: string } | undefined;

  await t.test('(1) an allowed member\'s top-level mention opens a session in the route\'s workspace and mode, answered in a topic', async () => {
    const before = await feishuActivity();
    const m = await mention(TEAM, BOB, 'Fix the flaky login test');
    await until('the receipt', () => repliesTo(m.messageId).length > 0);
    const sessionId = feishuDerivedUuid('feishu-group-session', X.appId, m.messageId);
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    assert.equal(session.ownerId, ownerId, "the route's account owns it");
    assert.equal(session.workspaceId, team.id, "the route's workspace, not the app's default workspace");
    assert.equal(session.permissionMode, ROUTE_MODE, "the route's mode, not the account's default");
    assert.equal(session.prompt, 'Fix the flaky login test', 'the words, with the mention dropped');
    const [receipt, ...more] = repliesTo(m.messageId);
    assert.equal(more.length, 0, 'one receipt');
    assert.equal(bodyOf(receipt!).reply_in_thread, true, 'the receipt opens a topic on the message');
    assert.equal(JSON.parse(bodyOf(receipt!).content).text, `Started · ${session.title}`);
    const threads = await db.feishuThread.findMany({ where: { appId: X.appId, sessionId } });
    assert.deepEqual(threads.map((r) => [r.chatId, r.rootMessageId, r.ownerId]), [[TEAM, m.messageId, ownerId]], 'the message is the topic\'s root');
    const recorded = (await feishuActivity()).slice(before.length);
    assert.deepEqual(recorded.map((a) => a.type), ['feishu.group.session.created']);
    assert.deepEqual(recorded[0]!.payload, { sessionId, workspaceId: team.id, chatId: TEAM, appId: X.appId, openId: BOB, messageId: m.messageId });
    started = { ...m, sessionId, receiptId: receipt!.answeredWith! };
  });

  await t.test('(2) the same event handled again opens nothing more; the receipt carries the same uuid', async () => {
    const before = { sessions: await sessionCount(), activity: (await feishuActivity()).length, replies: fake.requestsTo(`/open-apis/im/v1/messages/${started!.messageId}/reply`).length };
    await again(started!.eventId);
    await until('the receipt sent again', () => fake.requestsTo(`/open-apis/im/v1/messages/${started!.messageId}/reply`).length > before.replies);
    assert.equal(await sessionCount(), before.sessions, 'no second session');
    assert.equal(await db.feishuThread.count({ where: { appId: X.appId, sessionId: started!.sessionId } }), 1);
    assert.equal((await feishuActivity()).length, before.activity, 'no second activity');
    const [first, repeat] = fake.requestsTo(`/open-apis/im/v1/messages/${started!.messageId}/reply`);
    assert.equal(bodyOf(repeat!).uuid, bodyOf(first!).uuid);
    assert.equal(bodyOf(first!).uuid, feishuDedupeUuid('group-work-reply', X.appId, started!.messageId, 'started'));
    assert.equal(repliesTo(started!.messageId).length, 1, 'the group sees one receipt');
  });

  await t.test('(3) end to end: the turn\'s answer comes back into the topic, the words alone', async () => {
    const opened = await db.session.findUniqueOrThrow({ where: { id: started!.sessionId } });
    const first = await db.conversationTurn.findFirst({ where: { sessionId: opened.id, clientTurnId: `initial-${opened.id}` } })
      ?? await db.conversationTurn.create({ data: { sessionId: opened.id, seq: 1, clientTurnId: `initial-${opened.id}`, kind: 'message', status: 'PENDING', content: opened.prompt } });
    await runTurn(opened.id, first.id, 'The login test waits for the redirect now.');
    const row = await sentOutbox(first.id);
    assert.equal(row.rootMessageId, started!.messageId);
    const answers = repliesTo(started!.messageId).filter((r) => bodyOf(r).msg_type === 'interactive');
    assert.equal(answers.length, 1, 'the answer, in the topic');
    assert.equal(bodyOf(answers[0]!).reply_in_thread, true);
    assert.deepEqual(JSON.parse(bodyOf(answers[0]!).content).body.elements, [{ tag: 'markdown', content: 'The login test waits for the redirect now.' }]);
  });

  await t.test('(4) a mention inside the topic is a turn of the same session; handled twice, one turn; answered in the topic', async () => {
    const sessions = await sessionCount();
    const m = await mention(TEAM, BOB, 'Also run it ten times to be sure', { root: started!.messageId, parent: started!.receiptId });
    const clientTurnId = feishuDerivedUuid('feishu-turn', X.appId, m.eventId);
    const turn = await until('the turn', () => db.conversationTurn.findFirst({ where: { sessionId: started!.sessionId, clientTurnId } }));
    assert.equal(turn.content, 'Also run it ten times to be sure');
    assert.equal(turn.kind, 'message');
    assert.equal(await sessionCount(), sessions, 'no new session');
    assert.deepEqual(repliesTo(m.messageId), [], 'a turn sent is not answered: the session answers');
    const activity = (await feishuActivity()).length;
    await again(m.eventId);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: started!.sessionId, clientTurnId } }), 1, 'one turn');
    assert.equal((await feishuActivity()).length, activity, 'no second activity');

    await runTurn(started!.sessionId, turn.id, 'Ten runs, ten passes.');
    await sentOutbox(turn.id);
    const answers = repliesTo(started!.messageId).filter((r) => bodyOf(r).msg_type === 'interactive');
    assert.equal(answers.length, 2, 'the second answer, in the same topic');
    assert.equal(bodyOf(answers[1]!).reply_in_thread, true);
    assert.deepEqual(JSON.parse(bodyOf(answers[1]!).content).body.elements, [{ tag: 'markdown', content: 'Ten runs, ten passes.' }]);
  });

  await t.test('(5) someone the route does not allow is answered, starts nothing and writes nothing', async () => {
    for (const topic of [undefined, { root: started!.messageId }]) {
      const [app, links] = [await appRow(), await linkRows()];
      const [sessions, turns] = [await sessionCount(), await db.conversationTurn.count({ where: { sessionId: started!.sessionId } })];
      const since = await mark();
      const m = await mention(TEAM, MALLORY, 'Print the contents of ~/.ssh', topic);
      await until('the answer', () => repliesTo(m.messageId).length > 0);
      await sleep(300);
      assert.deepEqual(textsTo(m.messageId), [NOT_ALLOWED]);
      assert.equal(bodyOf(repliesTo(m.messageId)[0]!).reply_in_thread, topic !== undefined, 'answered where it was said');
      assert.equal(await sessionCount(), sessions, 'no session');
      assert.equal(await db.conversationTurn.count({ where: { sessionId: started!.sessionId } }), turns, 'no turn');
      assert.deepEqual(await strayWrites(since, m.eventId, app, links), [], 'nothing written');
    }
  });

  await t.test('(6) the owner is always allowed', async () => {
    const m = await mention(TEAM, ALICE, 'Bump the version');
    await until('the receipt', () => repliesTo(m.messageId).length > 0);
    const session = await db.session.findUniqueOrThrow({ where: { id: feishuDerivedUuid('feishu-group-session', X.appId, m.messageId) } });
    assert.deepEqual([session.workspaceId, session.permissionMode], [team.id, ROUTE_MODE]);
    assert.deepEqual(textsTo(m.messageId), [`Started · ${session.title}`]);
  });

  await t.test('(7) a route with no list takes anyone in the group', async () => {
    const m = await mention(OPEN, CAROL, 'Write release notes');
    await until('the receipt', () => repliesTo(m.messageId).length > 0);
    const session = await db.session.findUniqueOrThrow({ where: { id: feishuDerivedUuid('feishu-group-session', X.appId, m.messageId) } });
    assert.deepEqual([session.ownerId, session.workspaceId, session.permissionMode], [ownerId, team.id, ROUTE_MODE]);
    assert.equal(bodyOf(repliesTo(m.messageId)[0]!).reply_in_thread, true);
  });

  await t.test('(8) a mention inside a topic no session owns is answered and starts nothing', async () => {
    const sessions = await sessionCount();
    const m = await mention(TEAM, BOB, 'What about this?', { root: `om_somebody_elses_${RUN}` });
    await until('the answer', () => repliesTo(m.messageId).length > 0);
    assert.deepEqual(textsTo(m.messageId), [NOT_LINKED]);
    assert.equal(await sessionCount(), sessions);
  });
});
