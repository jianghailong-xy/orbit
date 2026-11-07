/**
 * A connected group's limits, and a session that cannot be started (docs/feishu-bot-design.md §8.1 the limits, §8.2;
 * task F3-4), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, TWO production apiservers
 * (`build/main.js`) and the fake open platform both reach over their long connections. Every event is pushed down a
 * connection as Feishu would push it, and goes through the inbox, the router and FeishuGroupService. What it is held to:
 *
 *   (1) with `maxConcurrentSessions` 1, a second request while the first session is running starts no session, writes
 *       nothing (write trap) and is answered in its topic with one English sentence; handled again, the same;
 *   (2) the slot comes back when that session is no longer running: the next request starts one;
 *   (3) two requests arriving at the same time, on two replicas, both waiting at the route's lock, open one session:
 *       the other is answered with the same sentence;
 *   (4) with `sessionsPerDay` 2, a third request of the day starts nothing and is answered; a topic opened before
 *       midnight UTC does not count;
 *   (5) a refusal of SessionsService.create's preflight (the route's workspace has no runner) starts no session, leaves
 *       no topic and no activity behind, and is answered with the reason; the slot is given back, so the next request is
 *       refused for the same reason, not for the limit.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-group-limits.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RunnerStatus, type PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { WRITE_TRAP } from '../auth/tenant-isolation-fixtures';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { feishuDerivedUuid } from './feishu-direct.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { feishuDedupeUuid } from './feishu-outbound';
import { FEISHU_TEST_TIME_SCALE_ENV } from './feishu-timing';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-group-limits-${randomUUID()}`;
const SCALE = '20';
const RUN = randomBytes(4).toString('hex');
const RUNNER_TOKEN = `feishu-group-limits-runner-${randomUUID()}`;

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit team bot' };
const ALICE = 'ou_alice_limits';
const BOB = 'ou_bob_limits';
const CAROL = 'ou_carol_limits';
const ONE = `oc_one_${RUN}`;
const RACE = `oc_race_${RUN}`;
const DAY = `oc_day_${RUN}`;
const BARE = `oc_bare_${RUN}`;

/** The sentences the bot answers with, spelled out here so the spec pins the words themselves. */
const BUSY_1 = "Orbit didn't start a session: this group already has 1 session running, the most its connection allows at a time. Try again when one finishes.";
const DAILY_2 = "Orbit didn't start a session: this group has started 2 sessions today, the most its connection allows in a day. Try again after midnight UTC.";
const NO_RUNNER = "Orbit didn't start a session: pick a workspace bound to a runner, or pass assignedRunnerId.";

async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

type Row = Record<string, unknown>;
const without = (row: Row, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

test('Feishu: a connected group\'s limits, and a session that cannot be started', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const locker = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await locker.connect();
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  const servers: Apiserver[] = [];
  let beating: NodeJS.Timeout | undefined;
  t.after(async () => {
    if (beating) clearInterval(beating);
    await Promise.all(servers.map((s) => s.stop()));
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await locker.end().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  fake.addApp(X);
  const fakeUrl = await fake.start();

  const ownerId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `feishu-group-limits-${RUN}@feishu-group.invalid`, name: 'owner', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'a runner', tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
  });
  beating = setInterval(() => void sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId]).catch(() => undefined), 3_000);
  const team = await db.workspace.create({ data: { ownerId, runnerId, name: `team ${RUN}`, enabled: true } });
  const bare = await db.workspace.create({ data: { ownerId, runnerId: null, name: `no runner ${RUN}`, enabled: true } });
  await db.feishuApp.create({
    data: {
      ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice',
      botName: X.botName, defaultWorkspaceId: team.id,
    },
  });
  // Four confirmed groups, open to everyone, as the confirm page writes them.
  for (const [chatId, workspaceId, maxConcurrentSessions, sessionsPerDay] of [
    [ONE, team.id, 1, 50], [RACE, team.id, 1, 50], [DAY, team.id, 5, 2], [BARE, bare.id, 1, 50],
  ] as const) {
    await db.feishuChatRoute.create({
      data: {
        ownerId, appId: X.appId, chatId, chatName: chatId, workspaceId, permissionMode: 'acceptEdits', allowedOpenIds: [],
        maxConcurrentSessions, sessionsPerDay, enabled: true, confirmedAt: new Date(),
      },
    });
  }

  const env = { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE };
  const jwtSecret = `feishu-group-limits-${randomUUID()}`;
  servers.push(...(await Promise.all([startApiserver(url, jwtSecret, env), startApiserver(url, jwtSecret, env)])));
  const said = () => servers.map((s, i) => `── apiserver ${i + 1}:\n${s.output().slice(-3000)}`).join('\n');
  const connections: FakeConnection[] = await until('X connected on both', () => {
    const open = fake.openConnections(X.appId);
    return open.length === 2 ? open : null;
  }).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiservers said:\n${said()}`);
  });

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
      throw new Error(`${(error as Error).message}; the apiservers said:\n${said()}`);
    });
  const repliesTo = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);
  const bodyOf = (m: FakeRequest) => m.body as { msg_type: string; content: string; reply_in_thread: boolean; uuid: string };
  const textsTo = (messageId: string) => repliesTo(messageId).filter((m) => bodyOf(m).msg_type === 'text').map((m) => JSON.parse(bodyOf(m).content).text as string);
  const feishuActivity = () => db.activity.count({ where: { credentialKind: 'FEISHU', actorId: ownerId } });
  const sessionCount = () => db.session.count({ where: { ownerId } });
  const sessionOf = (messageId: string) => db.session.findUnique({ where: { id: feishuDerivedUuid('feishu-group-session', X.appId, messageId) } });
  const topicsOf = (chatId: string) => db.feishuThread.count({ where: { appId: X.appId, chatId } });

  let seq = 0;
  /** Push one top-level group message that @-mentions the bot, down connection `via`; `wait` until the inbox processed it. */
  async function push(chatId: string, openId: string, text: string, via = 0) {
    const eventId = `ev-group-limits-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const ack = await fake.push(connections[via]!, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: openId }, sender_type: 'user' },
        message: {
          message_id: messageId, chat_id: chatId, chat_type: 'group', message_type: 'text',
          content: JSON.stringify({ text: `@_user_1 ${text}` }),
          mentions: [{ key: '@_user_1', name: X.botName }],
        },
      },
    });
    assert.equal(ack.code, 200);
    return { eventId, messageId };
  }
  async function mention(chatId: string, openId: string, text: string) {
    const m = await push(chatId, openId, text);
    await processed(m.eventId);
    await until(`the answer to ${m.messageId}`, () => repliesTo(m.messageId).length > 0);
    return m;
  }
  async function again(eventId: string) {
    const { attempts } = (await sql.query<{ attempts: number }>(
      `UPDATE feishu_inbound_event SET processed_at = NULL, lease_until = NULL WHERE app_id = $1 AND event_id = $2 RETURNING attempts`, [X.appId, eventId],
    )).rows[0];
    await processed(eventId, attempts + 1);
    await sleep(300);
  }
  const park = (sessionId: string) => sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [sessionId]);

  await t.test('(1) at the concurrency limit, a second request starts nothing, writes nothing and is answered in English', async () => {
    const first = await mention(ONE, BOB, 'Fix the flaky login test');
    const opened = await sessionOf(first.messageId);
    assert.ok(opened, 'the first request opened a session');
    assert.equal(opened.status, 'PENDING', 'and it is running (not yet claimed)');
    assert.deepEqual(textsTo(first.messageId), [`Started · ${opened.title}`]);

    const [app, links, sessions, topics, activity] = [await appRow(), await linkRows(), await sessionCount(), await topicsOf(ONE), await feishuActivity()];
    const since = await mark();
    const second = await mention(ONE, CAROL, 'Write the release notes');
    assert.deepEqual(textsTo(second.messageId), [BUSY_1]);
    const [answer] = repliesTo(second.messageId);
    assert.equal(bodyOf(answer!).reply_in_thread, true, 'answered in a topic on the request');
    assert.equal(bodyOf(answer!).uuid, feishuDedupeUuid('group-work-reply', X.appId, second.messageId, 'over-limit'));
    assert.equal(await sessionOf(second.messageId), null, 'no session');
    assert.equal(await sessionCount(), sessions, 'no session');
    assert.equal(await topicsOf(ONE), topics, 'no topic');
    assert.equal(await feishuActivity(), activity, 'no activity');
    assert.deepEqual(await strayWrites(since, second.eventId, app, links), [], 'nothing written');

    await again(second.eventId);
    assert.equal(await sessionCount(), sessions, 'handled again, still no session');
    const answers = fake.requestsTo(`/open-apis/im/v1/messages/${second.messageId}/reply`);
    assert.equal(answers.length, 2);
    assert.equal(bodyOf(answers[1]!).uuid, bodyOf(answers[0]!).uuid, 'the same Feishu uuid, so the group sees one answer');
    assert.deepEqual(await strayWrites(since, second.eventId, app, links), [], 'nothing written');
  });

  await t.test('(2) the slot comes back when the session is no longer running', async () => {
    const running = await db.session.findMany({ where: { ownerId }, select: { id: true } });
    for (const { id } of running) await park(id);
    const third = await mention(ONE, CAROL, 'Write the release notes, now');
    const opened = await sessionOf(third.messageId);
    assert.ok(opened, 'a session');
    assert.deepEqual(textsTo(third.messageId), [`Started · ${opened.title}`]);
  });

  await t.test('(3) two requests arriving at the same time on two replicas open one session', async () => {
    const sessions = await sessionCount();
    const waiting = async () => Number((await sql.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%feishu_chat_route%FOR UPDATE%'`,
    )).rows[0].n);
    // Hold the route's row, so both requests are sure to be in flight together, then let them go at once.
    await locker.query('BEGIN');
    await locker.query(`SELECT 1 FROM feishu_chat_route WHERE app_id = $1 AND chat_id = $2 FOR UPDATE`, [X.appId, RACE]);
    let a: { eventId: string; messageId: string };
    let b: { eventId: string; messageId: string };
    try {
      a = await push(RACE, BOB, 'Bump the version', 0);
      await until('the first request waiting at the route', async () => (await waiting()) >= 1, 10_000);
      b = await push(RACE, CAROL, 'Update the changelog', 1);
      await until('both requests waiting at the route', async () => (await waiting()) >= 2, 10_000);
    } finally {
      await locker.query('COMMIT');
    }
    await processed(a.eventId);
    await processed(b.eventId);
    await until('both answered', () => repliesTo(a.messageId).length > 0 && repliesTo(b.messageId).length > 0);
    const replicas = (await sql.query<{ processed_by: string }>(
      `SELECT DISTINCT processed_by FROM feishu_inbound_event WHERE app_id = $1 AND event_id = ANY($2)`, [X.appId, [a.eventId, b.eventId]],
    )).rows;
    assert.equal(replicas.length, 2, 'each request was handled by its own replica');
    const made = [await sessionOf(a.messageId), await sessionOf(b.messageId)].filter((s) => s !== null);
    assert.equal(made.length, 1, 'one session, not two');
    assert.equal(await sessionCount(), sessions + 1);
    assert.equal(await topicsOf(RACE), 1, 'one topic');
    const answers = [...textsTo(a.messageId), ...textsTo(b.messageId)].sort();
    assert.deepEqual(answers, [BUSY_1, `Started · ${made[0]!.title}`].sort());
  });

  await t.test('(4) at the daily limit a request starts nothing and is answered; yesterday\'s topics do not count', async () => {
    for (const text of ['First of the day', 'Second of the day']) {
      const m = await mention(DAY, BOB, text);
      const opened = await sessionOf(m.messageId);
      assert.ok(opened, text);
      await park(opened.id); // not running, so only the daily limit can refuse the next one
    }
    const sessions = await sessionCount();
    const [app, links] = [await appRow(), await linkRows()];
    const since = await mark();
    const third = await mention(DAY, BOB, 'Third of the day');
    assert.deepEqual(textsTo(third.messageId), [DAILY_2]);
    assert.equal(bodyOf(repliesTo(third.messageId)[0]!).reply_in_thread, true);
    assert.equal(await sessionCount(), sessions, 'no session');
    assert.equal(await topicsOf(DAY), 2, 'no topic');
    assert.deepEqual(await strayWrites(since, third.eventId, app, links), [], 'nothing written');

    // One of today's two was opened before midnight UTC after all: the day has room for one more.
    await sql.query(
      `UPDATE feishu_thread SET created_at = date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 hour'
        WHERE id = (SELECT id FROM feishu_thread WHERE app_id = $1 AND chat_id = $2 ORDER BY created_at LIMIT 1)`, [X.appId, DAY]);
    const fourth = await mention(DAY, BOB, 'Fourth try');
    const opened = await sessionOf(fourth.messageId);
    assert.ok(opened, 'a session');
    assert.deepEqual(textsTo(fourth.messageId), [`Started · ${opened.title}`]);
  });

  await t.test('(5) a preflight refusal starts nothing, leaves nothing behind, answers the reason and gives the slot back', async () => {
    const [sessions, topics, activity] = [await sessionCount(), await topicsOf(BARE), await feishuActivity()];
    const first = await mention(BARE, BOB, 'Start something');
    assert.deepEqual(textsTo(first.messageId), [NO_RUNNER]);
    assert.equal(bodyOf(repliesTo(first.messageId)[0]!).reply_in_thread, true);
    assert.equal(await sessionCount(), sessions, 'the number of sessions is unchanged');
    assert.equal(await topicsOf(BARE), topics, 'the reservation was given back');
    assert.equal(await feishuActivity(), activity, 'no activity');

    // The route allows one at a time: had the refused request kept its slot, this one would be refused for the limit.
    const second = await mention(BARE, CAROL, 'Start something else');
    assert.deepEqual(textsTo(second.messageId), [NO_RUNNER]);
    await again(first.eventId);
    assert.equal(await sessionCount(), sessions, 'handled again, still none');
    assert.equal(await topicsOf(BARE), topics);
    assert.equal(textsTo(first.messageId).length, 1, 'the group sees one answer');
  });
});
