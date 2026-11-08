/**
 * What a group session sends where (docs/feishu-bot-design.md §8.3 rules 3 and 4; task F3-3), end to end against a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the production apiserver (`build/main.js`) and the fake
 * open platform its long connection reaches (feishu/test-support/fake-open-platform.ts). The sessions are opened as a
 * group member opens them, by an `@bot` pushed down the long connection; the runner's half is its own HTTP routes. The
 * app is in FULL detail, so the cards carry the most they ever do. What it is held to:
 *
 *   (1) a tool approval of a group session is one card sent to the owner's open_id — `receive_id_type=open_id`,
 *       `receive_id` the owner's — never to the group's chat_id, and nothing at all reaches the group: no send to its
 *       chat, no reply to any of its messages; the card's row is addressed to the owner;
 *   (2) the agent's question (AskUserQuestion) of a group session likewise goes to the owner's direct messages alone;
 *   (3) the reply that comes back into the group's topic is the turn's last words and nothing else, its request body
 *       pinned field by field: no tool input or output, no sub-agent's words, no earlier text, no file, no Orbit link
 *       (no Open in Orbit, no session URL);
 *   (4) after the group's route is removed, a later turn's reply into the topic still carries no Orbit link.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-group-boundary.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RunnerStatus, type PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
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
process.env.PROVIDER_SECRET_KEY = `feishu-group-boundary-${randomUUID()}`;
const SCALE = '20';
process.env[FEISHU_TEST_TIME_SCALE_ENV] = SCALE;
const RUN = randomBytes(4).toString('hex');
const RUNNER_TOKEN = `feishu-group-boundary-runner-${randomUUID()}`;

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit team bot' };
/** The app's owner, and a member of the group the route allows. */
const ALICE = 'ou_alice_boundary';
const BOB = 'ou_bob_boundary';
const TEAM = `oc_team_${RUN}`;

const QUESTION = {
  questions: [{
    question: 'Which branch should the fix go to?', header: 'Branch', multiSelect: false,
    options: [{ label: 'main', description: 'the release line' }, { label: 'next', description: 'the next release' }],
  }],
};

async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test('Feishu: a group session asks the owner in private and answers the group with its words alone', {
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
    data: { id: ownerId, email: `feishu-group-boundary-${RUN}@feishu-group-boundary.invalid`, name: 'owner', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' },
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
      botName: X.botName, defaultWorkspaceId: personal.id, messageDetail: 'FULL',
    },
  });
  const route = await db.feishuChatRoute.create({
    data: {
      ownerId, appId: X.appId, chatId: TEAM, chatName: 'Team', workspaceId: team.id, permissionMode: 'default', allowedOpenIds: [BOB],
      maxConcurrentSessions: 5, sessionsPerDay: 50, enabled: true, confirmedAt: new Date(),
    },
  });

  server = await startApiserver(url, `feishu-group-boundary-${randomUUID()}`, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE });
  const said = () => server!.output().slice(-4000);
  const connection: FakeConnection = await until('X connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
  });
  await until('the link reported connected', async () =>
    (await sql.query(`SELECT 1 FROM feishu_link WHERE app_id = $1 AND state = 'CONNECTED'`, [X.appId])).rowCount);

  const processed = (eventId: string) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL`, [X.appId, eventId])).rowCount)
      .catch((error) => {
        throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
      });
  /** Every message the bot sent or replied with, as the fake open platform received it. */
  const messageRequests = (from = 0): FakeRequest[] => fake.messages.slice(from).filter((m) => m.path.startsWith('/open-apis/im/v1/messages'));
  const repliesTo = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);

  let seq = 0;
  /** Bob, a member the route allows, opens a session with a top-level `@bot` in the group. */
  async function openGroupSession(text: string) {
    const eventId = `ev-group-boundary-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const ack = await fake.push(connection, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: BOB }, sender_type: 'user' },
        message: {
          message_id: messageId, chat_id: TEAM, chat_type: 'group', message_type: 'text',
          content: JSON.stringify({ text: `@_user_1 ${text}` }), mentions: [{ key: '@_user_1', name: X.botName }],
        },
      },
    });
    assert.equal(ack.code, 200);
    await processed(eventId);
    await until('the receipt in the topic', () => repliesTo(messageId).length > 0);
    const sessionId = feishuDerivedUuid('feishu-group-session', X.appId, messageId);
    await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    return { messageId, sessionId };
  }

  // The runner's own routes.
  const runner = (method: string, rest: string, body?: unknown) =>
    call(server!, method, `/api/runner${rest}`, RUNNER_TOKEN, body, { 'x-orbit-runner-caller': 'mcp' });
  const runnerRoute = (sessionId: string, rest: string) => `/sessions/${uuidToBase62(sessionId)}/${rest}`;

  // The runner claims a session as the dispatcher's claim does: under the inbox lease, in one transaction.
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
        `UPDATE "session" SET "status" = 'RUNNING', "assigned_runner_id" = $2::uuid, "inbox_lease_owner" = $3::uuid,
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

  /**
   * The runner files an approval in a group session. Resolves with the one alert request Feishu received for it, once
   * the card's row is SENT, and every message request made in between.
   */
  async function fileApproval(sessionId: string, toolName: string, input: unknown) {
    await claim(sessionId, true);
    const from = fake.messages.length;
    const filed = await runner('POST', runnerRoute(sessionId, 'approvals'), { toolName, input, toolUseId: `tu-${randomUUID()}` });
    assert.equal(filed.status, 201, filed.text);
    const approvalId = filed.json.id as string;
    const row = await until(`the card of approval ${approvalId} SENT`, () =>
      db.feishuMessage.findFirst({ where: { appId: X.appId, approvalId, status: 'SENT' } })).catch(async (error) => {
      throw new Error(`${(error as Error).message}; session ${JSON.stringify(await db.session.findUnique({ where: { id: sessionId }, select: { status: true, engineTurnActive: true, assignedRunnerId: true } }))}`
        + `; approvals ${JSON.stringify(await db.approval.findMany({ where: { sessionId }, select: { status: true } }))}`
        + `; feishu_message ${JSON.stringify(await db.feishuMessage.findMany({ where: { appId: X.appId } }))}`
        + `; requests ${JSON.stringify(fake.messages.slice(from).map((m) => m.path))}; the apiserver said:\n${said()}`);
    });
    await sleep(500); // anything else this approval would send has had its chance
    return { approvalId, row, requests: messageRequests(from) };
  }

  /** Where every request went: (1) and (2) hold each request to the owner's direct messages. */
  function assertOnlyToOwner(requests: FakeRequest[], what: string) {
    assert.ok(requests.length > 0, `${what}: a card was sent`);
    for (const r of requests) {
      const body = r.body as Record<string, unknown>;
      assert.equal(r.method, 'POST', `${what}: a send, not a reply or an update`);
      assert.equal(r.path, '/open-apis/im/v1/messages', `${what}: a send to a receiver, not a reply into a chain`);
      assert.equal(r.query.get('receive_id_type'), 'open_id', `${what}: addressed to a person`);
      assert.equal(body.receive_id, ALICE, `${what}: the owner's open_id`);
      assert.notEqual(body.receive_id, TEAM, `${what}: not the group's chat_id`);
      assert.ok(!JSON.stringify({ query: r.query.toString(), body }).includes(TEAM), `${what}: the group is not named anywhere in the request`);
    }
  }

  await t.test('(1) a tool approval of a group session goes to the owner\'s open_id, never into the group', async () => {
    const opened = await openGroupSession('Delete the stale branches');
    const groupRepliesBefore = repliesTo(opened.messageId).length;
    const { requests, row } = await fileApproval(opened.sessionId, 'Bash', { command: 'git branch -D old-feature' });
    assertOnlyToOwner(requests, 'the approval');
    assert.equal(requests.length, 1, 'one card');
    assert.equal((requests[0]!.body as { msg_type: string }).msg_type, 'interactive');
    assert.equal(row.receiveId, ALICE, 'the card\'s row is addressed to the owner');
    assert.equal(row.sessionId, opened.sessionId, 'it is the group session\'s card');
    assert.equal(repliesTo(opened.messageId).length, groupRepliesBefore, 'nothing more in the group\'s topic');
  });

  await t.test('(2) the agent\'s question of a group session goes to the owner\'s open_id, never into the group', async () => {
    const opened = await openGroupSession('Fix the release script');
    const groupRepliesBefore = repliesTo(opened.messageId).length;
    const { requests, row } = await fileApproval(opened.sessionId, 'AskUserQuestion', QUESTION);
    assertOnlyToOwner(requests, 'the question');
    assert.equal(requests.length, 1, 'one card');
    assert.equal(row.receiveId, ALICE);
    assert.ok(JSON.parse((requests[0]!.body as { content: string }).content), 'a card');
    assert.equal(repliesTo(opened.messageId).length, groupRepliesBefore, 'nothing more in the group\'s topic');
  });

  // ── the runner's half of a turn, with tool calls, a sub-agent and words before the last ──────────────────────────
  let eventSeq = 0;
  async function runTurn(sessionId: string, turnId: string, events: Array<{ type: string; payload: Record<string, unknown> }>) {
    const lease = await claim(sessionId, false);
    await sql.query(
      `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT', "delivered_at" = now(), "lease_deadline_at" = now() + interval '5 minutes',
              "lease_generation" = $2::uuid
        WHERE "id" = $1::uuid`,
      [turnId, lease.generation]);
    const posted = await call(server!, 'POST', `/api/runner${runnerRoute(sessionId, 'events')}`, RUNNER_TOKEN, {
      leaseOwner: lease.owner,
      events: events.map((e) => ({ seq: ++eventSeq, type: e.type, turnId, ts: new Date().toISOString(), payload: e.payload })),
    });
    assert.equal(posted.status, 202, posted.text);
    const done = await call(server!, 'POST', `/api/runner${runnerRoute(sessionId, 'turn-complete')}`, RUNNER_TOKEN, {
      turnId, leaseOwner: lease.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1, costUsd: 0,
    });
    assert.equal(done.status, 200, done.text);
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [sessionId]);
  }
  const sentOutbox = (turnId: string) => until(`the reply of turn ${turnId} sent`, async () => {
    const row = await db.feishuOutbox.findUnique({ where: { turnId } });
    return row?.status === 'SENT' ? row : null;
  }).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
  });
  const SECRET_OUTPUT = `secret-tool-output-${RUN}`;
  /** A turn as an engine reports it: words, a tool call and its output naming a file, a sub-agent, then the last words. */
  const busyTurn = (finalWords: string) => [
    { type: 'assistant', payload: { text: 'Let me look at the branches first.' } },
    { type: 'tool_use', payload: { id: 'tu-1', name: 'Bash', input: { command: 'git branch --merged > /tmp/merged.txt' } } },
    { type: 'tool_result', payload: { toolUseId: 'tu-1', content: `${SECRET_OUTPUT} wrote /tmp/merged.txt`, isError: false } },
    { type: 'assistant', payload: { text: `Sub-agent notes: ${SECRET_OUTPUT}`, parentToolUseId: 'tu-1' } },
    { type: 'assistant', payload: { text: finalWords } },
  ];
  /** The turn's reply into the group's topic, its request body pinned field by field. */
  function assertWordsAlone(reply: FakeRequest, rowId: string, finalWords: string) {
    assert.equal(reply.method, 'POST');
    assert.equal(reply.query.toString(), '', 'no query beyond the path');
    const body = reply.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['content', 'msg_type', 'reply_in_thread', 'uuid'], 'nothing beyond these four fields');
    assert.equal(body.msg_type, 'interactive');
    assert.equal(body.reply_in_thread, true, 'in the topic');
    assert.equal(body.uuid, feishuDedupeUuid('session-reply', X.appId, rowId));
    assert.deepEqual(JSON.parse(body.content as string), {
      schema: '2.0',
      config: { summary: { content: finalWords } },
      body: { direction: 'vertical', elements: [{ tag: 'markdown', content: finalWords }] },
    }, 'the last words, and nothing else: no button, no link');
    const all = JSON.stringify(body);
    for (const absent of [SECRET_OUTPUT, 'git branch', '/tmp/merged.txt', 'Let me look', 'Open in Orbit', '/sessions/', 'open_url', 'http']) {
      assert.ok(!all.includes(absent), `the reply does not carry ${absent}`);
    }
  }

  let topic: { messageId: string; sessionId: string } | undefined;

  await t.test('(3) the reply into the group\'s topic is the turn\'s last words alone, pinned field by field', async () => {
    topic = await openGroupSession('Tidy up the branches');
    const session = await db.session.findUniqueOrThrow({ where: { id: topic.sessionId } });
    const first = await db.conversationTurn.findFirst({ where: { sessionId: session.id, clientTurnId: `initial-${session.id}` } })
      ?? await db.conversationTurn.create({ data: { sessionId: session.id, seq: 1, clientTurnId: `initial-${session.id}`, kind: 'message', status: 'PENDING', content: session.prompt } });
    const finalWords = 'Deleted 3 merged branches.';
    await runTurn(session.id, first.id, busyTurn(finalWords));
    const row = await sentOutbox(first.id);
    assert.equal(row.text, finalWords, 'the outbox holds the last words alone');
    assert.deepEqual([row.chatId, row.rootMessageId], [TEAM, topic.messageId]);
    const answers = repliesTo(topic.messageId).filter((r) => (r.body as { msg_type: string }).msg_type === 'interactive');
    assert.equal(answers.length, 1);
    assertWordsAlone(answers[0]!, row.id, finalWords);
  });

  await t.test('(4) after the group\'s route is removed, a reply into its topic still carries no Orbit link', async () => {
    await db.feishuChatRoute.delete({ where: { id: route.id } });
    const turn = await db.conversationTurn.create({ data: { sessionId: topic!.sessionId, seq: 100, clientTurnId: randomUUID(), kind: 'message', status: 'PENDING', content: 'and the tags?' } });
    const finalWords = 'Tags are left as they were.';
    await runTurn(topic!.sessionId, turn.id, busyTurn(finalWords));
    const row = await sentOutbox(turn.id);
    const answers = repliesTo(topic!.messageId).filter((r) => (r.body as { msg_type: string }).msg_type === 'interactive');
    assert.equal(answers.length, 2);
    assertWordsAlone(answers[1]!, row.id, finalWords);
  });
});
