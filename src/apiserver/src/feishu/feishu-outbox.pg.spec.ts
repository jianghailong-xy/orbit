/**
 * A session's replies go back to its Feishu chain, and turn-complete never waits on Feishu nor fails for it
 * (docs/feishu-bot-design.md §7.5, §1.3 item 6; task F2-4), against a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty, the production apiserver (`build/main.js`), and the fake open platform its long connection and its
 * replies reach (feishu/test-support/fake-open-platform.ts). The owner's messages are pushed down that connection as
 * Feishu pushes them; the runner's half — events and /turn-complete — is posted over HTTP as a runner posts it. What it
 * is held to:
 *
 *   (1) end to end: a new direct message opens a session; when its turn completes, the turn's LAST assistant text — not
 *       an earlier one, not a sub-agent's — is a reply to that message, in a card's markdown with Open in Orbit, and
 *       the outbox row is SENT with Feishu's message id;
 *   (2) the same completion posted again writes no second row and sends nothing more;
 *   (3) fault injection: with the open platform answering 500 to every request, the owner replies to an alert card of
 *       the session and that turn completes — turn-complete answers 2xx, the turn is ANSWERED, and the outbox row is
 *       FAILED with Feishu's error and retried; once Feishu is back the worker sends it, once, to the card's chain (the
 *       chain spoken in last), not the first one;
 *   (4) a turn with no assistant text writes no row; a session with no chain writes no row;
 *   (5) in a group chat (a chain whose chat has a feishu_chat_route) the reply goes in the thread, with the words alone:
 *       no Open in Orbit, no Orbit link; and it is sent with the app in TITLES_ONLY as in FULL (§6.4).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-outbox.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { RunStatus, RunnerStatus, SessionDispatchOrigin, SessionRunSource, type PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import '../test-support/daemon-routes-over-http';
import { feishuDedupeUuid } from './feishu-outbound';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FEISHU_TEST_TIME_SCALE_ENV } from './feishu-timing';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-outbox-${randomUUID()}`;
/** The outbox's first retry after 250 ms instead of 5 s, and so on: the spec waits for retries, not minutes. */
const SCALE = '20';
process.env[FEISHU_TEST_TIME_SCALE_ENV] = SCALE;
const RUN = randomBytes(4).toString('hex');
const RUNNER_TOKEN = `feishu-outbox-runner-${randomUUID()}`;

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit outbox bot' };
const ALICE = 'ou_alice_outbox';
const CHAT = `oc_p2p_${RUN}`;
const GROUP = `oc_group_${RUN}`;

async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test('Feishu: a session\'s replies go back to its chain, and turn-complete never waits on Feishu', {
  skip: !URL, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  let server: Apiserver | undefined;
  let beating: ReturnType<typeof setInterval> | undefined;
  t.after(async () => {
    clearInterval(beating);
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
    data: { id: ownerId, email: `feishu-outbox-${RUN}@feishu-outbox.invalid`, name: 'owner', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'a runner', tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date() },
  });
  // The reaper ends a RUNNING session whose runner stopped heartbeating; this one stays online the whole run.
  beating = setInterval(() => void sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId]).catch(() => undefined), 3_000);
  const workspace = await db.workspace.create({ data: { ownerId, runnerId, name: `orbit ${RUN}`, enabled: true } });
  await db.feishuApp.create({
    data: {
      ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice Example',
      defaultWorkspaceId: workspace.id,
    },
  });

  server = await startApiserver(url, `feishu-outbox-${randomUUID()}`, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl, [FEISHU_TEST_TIME_SCALE_ENV]: SCALE });
  const said = () => server!.output().slice(-4000);
  const connection: FakeConnection = await until('X connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
  });
  const runner = (method: string, route: string, body?: unknown) => call(server!, method, route, RUNNER_TOKEN, body);
  const route = (sessionId: string, rest: string) => `/api/runner/sessions/${uuidToBase62(sessionId)}/${rest}`;

  const repliesTo = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);
  const contentOf = (m: FakeRequest) => JSON.parse((m.body as { content: string }).content) as Record<string, any>;
  const outbox = (turnId: string) => db.feishuOutbox.findUnique({ where: { turnId } });

  let seq = 0;
  /** Push one direct message from the owner and wait until the inbox processed it. */
  async function dm(text: string, reply?: { root: string }) {
    const eventId = `ev-outbox-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const ack = await fake.push(connection, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: ALICE }, sender_type: 'user' },
        message: {
          message_id: messageId, chat_id: CHAT, chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }),
          ...(reply ? { root_id: reply.root, parent_id: reply.root } : {}),
        },
      },
    });
    assert.equal(ack.code, 200);
    await until(`${eventId} processed`, async () => (await sql.query(
      `SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL`, [X.appId, eventId],
    )).rowCount).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
    });
    return { eventId, messageId };
  }

  const leases = new Map<string, { owner: string; generation: string }>();
  let eventSeq = 0;
  /**
   * The runner's half of one turn: the session held by an engine process of this runner, the turn handed out to it,
   * its events (assistant text as the engine streamed it), then /turn-complete. Returns turn-complete's answer.
   */
  async function runTurn(sessionId: string, turnId: string, events: Array<{ text: string; parentToolUseId?: string }>) {
    let lease = leases.get(sessionId);
    if (!lease) {
      lease = { owner: randomUUID(), generation: randomUUID() };
      leases.set(sessionId, lease);
      await sql.query(`INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [lease.generation, sessionId, lease.owner]);
    }
    // As the claim takes it: the claim's own marker lets the engine guard (0414) see a current replica.
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
    if (events.length > 0) {
      const posted = await runner('POST', route(sessionId, 'events'), {
        leaseOwner: lease.owner,
        events: events.map((e) => ({
          seq: ++eventSeq, type: 'assistant', turnId, ts: new Date().toISOString(),
          payload: { text: e.text, ...(e.parentToolUseId ? { parentToolUseId: e.parentToolUseId } : {}) },
        })),
      });
      assert.equal(posted.status, 202, posted.text);
    }
    return complete(sessionId, turnId);
  }
  const complete = (sessionId: string, turnId: string) => runner('POST', route(sessionId, 'turn-complete'), {
    turnId, leaseOwner: leases.get(sessionId)!.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1, costUsd: 0,
  });
  const turnStatus = async (turnId: string) => (await db.conversationTurn.findUniqueOrThrow({ where: { id: turnId } })).status;

  let session: { id: string; dm: string } | undefined;

  await t.test('(1) end to end: a session opened from a direct message answers in that message\'s chain', async () => {
    const m = await dm('Fix the export bug');
    await until('the receipt', () => repliesTo(m.messageId).length > 0);
    const opened = await db.session.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    session = { id: opened.id, dm: m.messageId };
    // The prompt's turn, as the claim seeds it (SessionsService.ensurePromptSeeded).
    const first = await db.conversationTurn.findFirst({ where: { sessionId: opened.id, clientTurnId: `initial-${opened.id}` } })
      ?? await db.conversationTurn.create({ data: { sessionId: opened.id, seq: 1, clientTurnId: `initial-${opened.id}`, kind: 'message', status: 'PENDING', content: opened.prompt } });

    const done = await runTurn(opened.id, first.id, [
      { text: 'Looking at the export code.' },
      { text: '**Fixed.** The header row is written once now.' },
      { text: 'Sub-agent report: 3 files read.', parentToolUseId: 'toolu_sub' },
    ]);
    assert.equal(done.status, 200, done.text);
    assert.equal(await turnStatus(first.id), 'ANSWERED');

    const row = await until('the reply sent', async () => {
      const r = await outbox(first.id);
      return r?.status === 'SENT' ? r : null;
    }).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
    });
    const replies = repliesTo(m.messageId).filter((r) => (r.body as { msg_type: string }).msg_type === 'interactive');
    assert.equal(replies.length, 1, 'one reply, in the chain the session was started from');
    const card = contentOf(replies[0]!);
    assert.deepEqual(card.body.elements[0], { tag: 'markdown', content: '**Fixed.** The header row is written once now.' }, "the turn's last words, not a sub-agent's");
    assert.equal(card.body.elements[1].text.content, 'Open in Orbit');
    assert.match(card.body.elements[1].behaviors[0].default_url, new RegExp(`/sessions/${uuidToBase62(opened.id)}$`));
    assert.equal((replies[0]!.body as { reply_in_thread: boolean }).reply_in_thread, false);
    assert.equal((replies[0]!.body as { uuid: string }).uuid, feishuDedupeUuid('session-reply', X.appId, row.id));
    assert.equal(row.messageId, replies[0]!.answeredWith);
    assert.deepEqual([row.chatId, row.rootMessageId, row.attempts, row.lastError], [CHAT, m.messageId, 1, null]);
  });

  await t.test('(2) the same completion posted again writes no second row and sends nothing more', async () => {
    const first = await db.conversationTurn.findFirstOrThrow({ where: { sessionId: session!.id, clientTurnId: `initial-${session!.id}` } });
    const before = fake.messages.length;
    const again = await complete(session!.id, first.id);
    assert.equal(again.status, 200, again.text);
    await sleep(500);
    assert.equal(await db.feishuOutbox.count({ where: { sessionId: session!.id } }), 1);
    assert.equal(fake.messages.length, before);
  });

  await t.test('(3) Feishu failing everything: turn-complete answers, the turn is ANSWERED, the row FAILED; back, sent once', async () => {
    // An alert card of the session, which the owner replies to: that chain is now the one spoken in last.
    const cardId = `om_card_${RUN}`;
    await db.feishuMessage.create({
      data: { ownerId, appId: X.appId, collapseKey: `finished-${cardId}`, kind: 'finished', receiveId: ALICE, chatId: CHAT, messageId: cardId, sessionId: session!.id, status: 'SENT', sentAt: new Date() },
    });
    // Parked, as a session whose turn ended is.
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [session!.id]);
    const r = await dm('Now add a test for it', { root: cardId });
    const turn = await until('the reply as a turn', () => db.conversationTurn.findFirst({ where: { sessionId: session!.id, content: 'Now add a test for it' } }));

    fake.mode = 'server-error';
    const requestsBefore = fake.requests.length;
    const done = await runTurn(session!.id, turn.id, [{ text: 'Added `export.spec.ts`.' }]);
    assert.ok(done.status >= 200 && done.status < 300, `turn-complete answered ${done.status}: ${done.text}`);
    assert.equal(await turnStatus(turn.id), 'ANSWERED');
    const failed = await until('the row failed, and tried again', async () => {
      const row = await outbox(turn.id);
      return row?.status === 'FAILED' && row.attempts >= 2 ? row : null;
    });
    assert.match(failed.lastError ?? '', /^Feishu error 500/);
    assert.ok(fake.requests.length > requestsBefore, 'the worker did try Feishu');
    assert.equal(repliesTo(cardId).length, 0, 'nothing reached the chain');

    fake.mode = 'ok';
    const sent = await until('the reply sent once Feishu is back', async () => {
      const row = await outbox(turn.id);
      return row?.status === 'SENT' ? row : null;
    }, 60_000);
    await sleep(500);
    const replies = repliesTo(cardId);
    assert.equal(replies.length, 1, 'sent once');
    assert.equal(contentOf(replies[0]!).body.elements[0].content, 'Added `export.spec.ts`.');
    assert.equal(sent.messageId, replies[0]!.answeredWith);
    assert.equal(sent.rootMessageId, cardId, 'the chain spoken in last');
    assert.equal(repliesTo(session!.dm).filter((m) => (m.body as { msg_type: string }).msg_type === 'interactive').length, 1, 'not the first chain');
    assert.deepEqual(repliesTo(r.messageId), [], 'and not the reply itself');
  });

  await t.test('(4) no assistant text, or no chain: no row', async () => {
    await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1::uuid`, [session!.id]);
    const quiet = await db.conversationTurn.create({ data: { sessionId: session!.id, seq: 100, clientTurnId: randomUUID(), kind: 'message', status: 'PENDING', content: 'quiet' } });
    const done = await runTurn(session!.id, quiet.id, []);
    assert.equal(done.status, 200, done.text);
    assert.equal(await outbox(quiet.id), null, 'no words, nothing to send');

    const plain = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, workspaceId: workspace.id, assignedRunnerId: runnerId, title: 'not from Feishu', prompt: 'x', provider: 'claude',
        status: RunStatus.AWAITING_INPUT, numTurns: 1, dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
      },
    });
    const turn = await db.conversationTurn.create({ data: { sessionId: plain.id, seq: 1, clientTurnId: randomUUID(), kind: 'message', status: 'PENDING', content: 'hi' } });
    const answered = await runTurn(plain.id, turn.id, [{ text: 'Hello.' }]);
    assert.equal(answered.status, 200, answered.text);
    assert.equal(await outbox(turn.id), null, 'a session with no chain sends nothing');
  });

  await t.test('(5) a group chain: in the thread, the words alone; sent in TITLES_ONLY and FULL alike', async () => {
    await db.feishuChatRoute.create({ data: { ownerId, appId: X.appId, chatId: GROUP, workspaceId: workspace.id, permissionMode: 'default', enabled: true, confirmedAt: new Date() } });
    for (const detail of ['TITLES_ONLY', 'FULL'] as const) {
      await db.feishuApp.update({ where: { appId: X.appId }, data: { messageDetail: detail } });
      const groupSession = await db.session.create({
        data: {
          ownerId, creatorId: ownerId, workspaceId: workspace.id, assignedRunnerId: runnerId, title: `group ${detail}`, prompt: 'x', provider: 'claude',
          status: RunStatus.AWAITING_INPUT, numTurns: 1, dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
        },
      });
      const topic = `om_topic_${detail}_${RUN}`;
      await db.feishuThread.create({ data: { ownerId, appId: X.appId, chatId: GROUP, rootMessageId: topic, sessionId: groupSession.id } });
      const turn = await db.conversationTurn.create({ data: { sessionId: groupSession.id, seq: 1, clientTurnId: randomUUID(), kind: 'message', status: 'PENDING', content: 'go' } });
      const done = await runTurn(groupSession.id, turn.id, [{ text: `Shipped (${detail}).` }]);
      assert.equal(done.status, 200, done.text);
      await until(`the group reply in ${detail}`, async () => (await outbox(turn.id))?.status === 'SENT');
      const [reply] = repliesTo(topic);
      assert.equal((reply!.body as { reply_in_thread: boolean }).reply_in_thread, true, 'in the topic');
      assert.deepEqual(contentOf(reply!).body.elements, [{ tag: 'markdown', content: `Shipped (${detail}).` }], 'the words alone');
      assert.ok(!JSON.stringify(reply!.body).includes('/sessions/'), 'no Orbit link in a group');
    }
  });
});
