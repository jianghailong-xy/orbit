/**
 * Replying to a session and starting one from the owner's Feishu direct messages (docs/feishu-bot-design.md §7.2, §7.3;
 * task F2-3), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the production apiserver
 * (`build/main.js`), and the fake open platform its long connection reaches (feishu/test-support/fake-open-platform.ts).
 * Every event is pushed down that connection as Feishu would push it, and goes through the inbox and the router. What it
 * is held to:
 *
 *   (1) with no default workspace, a new message is answered with a card to choose one; the owner's click on a
 *       workspace of their own writes defaultWorkspaceId, and a click naming another account's workspace writes nothing;
 *   (2) a new message opens a session in the default workspace, in the account's default permission mode, and the bot
 *       answers that message with `Started · <title> · <workspace>`; the chain is the session's (feishu_thread) and the
 *       start is recorded as an activity with credential_kind FEISHU;
 *   (3) the same event handled again opens no second session, writes no second chain or activity, and its receipt
 *       carries the same Feishu uuid;
 *   (4) a reply in that chain (to the receipt) is a turn of the session;
 *   (5) a reply to an alert card (feishu_message) is a turn of the card's session — the same handled twice is one turn —
 *       and the card's chain becomes the session's;
 *   (6) a reply to a card of an ended session sends nothing and is answered as the App is answered: the session has ended;
 *   (7) a refusal before the session is written (the default workspace has no runner) is answered with the reason and
 *       opens no session;
 *   (8) `help`, `status` (the session waiting on an approval, with Open in Orbit), a reply to a message no session
 *       owns, and an image each get their answer and write nothing;
 *   (9) PATCH /api/integrations/feishu sets and clears the default workspace, and refuses another account's as one
 *       that does not exist.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-direct.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { RunStatus, SessionDispatchOrigin, SessionRunSource, type PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { feishuDerivedUuid } from './feishu-direct.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-direct-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');

const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit direct bot' };
const ALICE = 'ou_alice_direct';
const CHAT = `oc_p2p_${RUN}`;
/** The account's default mode: not the floor, so a session that took it can be told from one that took the floor. */
const ACCOUNT_MODE = 'plan';

/** The words §7.3 prescribes, spelled out here so the spec pins the words themselves. */
const NON_TEXT = 'Only text messages are supported for now.';
const ENDED = "Orbit didn't send this to the session: the session has ended.";
const NOT_LINKED = "This message isn't linked to an Orbit session. To start a new session, send a new message rather than a reply.";

async function until<T>(what: string, probe: () => Promise<T> | T, ms = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

test('Feishu: the owner replies to a session and starts one from their direct messages', {
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

  const user = async (name: string, preferences: object) => {
    const id = randomUUID();
    await db.user.create({
      data: { id, email: `feishu-direct-${name}-${RUN}@feishu-direct.invalid`, name, passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER', preferences },
    });
    return id;
  };
  const ownerId = await user('owner', { defaultPermissionMode: ACCOUNT_MODE });
  const otherId = await user('other', {});
  const runnerId = randomUUID();
  await db.runner.create({ data: { id: runnerId, ownerId, name: 'a runner', tokenHash: `feishu-direct-${runnerId}` } });
  const workspace = (owner: string, name: string, runner: string | null) =>
    db.workspace.create({ data: { ownerId: owner, runnerId: runner, name, enabled: true } });
  const main = await workspace(ownerId, `orbit ${RUN}`, runnerId);
  const bare = await workspace(ownerId, `no runner ${RUN}`, null);
  const theirs = await workspace(otherId, `theirs ${RUN}`, null);
  await db.feishuApp.create({
    data: { ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice Example' },
  });

  const jwtSecret = `feishu-direct-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
  const connection: FakeConnection = await until('X connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${server!.output().slice(-4000)}`);
  });
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  const ownerBearer = await jwt.signAsync({ sub: ownerId, email: `feishu-direct-owner-${RUN}@feishu-direct.invalid` });

  const processed = (eventId: string, attempts = 1) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(
        `SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts >= $3`,
        [X.appId, eventId, attempts],
      )).rowCount).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${server!.output().slice(-4000)}`);
    });
  const repliesTo = (messageId: string): FakeRequest[] => fake.messages.filter((m) => m.path === `/open-apis/im/v1/messages/${messageId}/reply`);
  const contentOf = (m: FakeRequest) => JSON.parse((m.body as { content: string }).content) as Record<string, unknown>;
  const textsTo = (messageId: string) => repliesTo(messageId).map((m) => contentOf(m).text as string);

  let seq = 0;
  /** Push one direct message from the owner and wait until the inbox processed it and the bot answered it. */
  async function dm(content: { text: string } | { image: true }, reply?: { root: string; parent?: string }, { answered = true } = {}) {
    const eventId = `ev-direct-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'im.message.receive_v1', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        sender: { sender_id: { open_id: ALICE }, sender_type: 'user' },
        message: {
          message_id: messageId,
          chat_id: CHAT,
          chat_type: 'p2p',
          ...(reply ? { root_id: reply.root, parent_id: reply.parent ?? reply.root } : {}),
          message_type: 'image' in content ? 'image' : 'text',
          content: JSON.stringify('image' in content ? { image_key: 'img_v2_x' } : { text: content.text }),
        },
      },
    };
    const ack = await fake.push(connection, envelope);
    assert.equal(ack.code, 200);
    await processed(eventId);
    if (answered) await until(`a reply to ${messageId}`, () => repliesTo(messageId).length > 0);
    return { eventId, messageId };
  }
  /** Handle an event once more, as the inbox does when a worker's lease ran out (§7.1). */
  async function again(eventId: string) {
    await sql.query(`UPDATE feishu_inbound_event SET processed_at = NULL, lease_until = NULL WHERE app_id = $1 AND event_id = $2`, [X.appId, eventId]);
    const { attempts } = (await sql.query(`SELECT attempts FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2`, [X.appId, eventId])).rows[0];
    await processed(eventId, attempts + 1);
    await sleep(300);
  }
  async function click(value: Record<string, string>) {
    const eventId = `ev-direct-card-${RUN}-${++seq}`;
    const ack = await fake.push(connection, {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'card.action.trigger', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: { operator: { open_id: ALICE }, action: { tag: 'button', value }, context: { open_message_id: `om_picker_${RUN}`, open_chat_id: CHAT } },
    });
    assert.equal(ack.code, 200);
    return ack.data as { toast?: { type: string; content: string }; card?: { data: unknown } };
  }
  const sessionsIn = async (workspaceId: string) => db.session.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  const appRow = () => db.feishuApp.findUniqueOrThrow({ where: { appId: X.appId } });
  const feishuActivity = () => db.activity.findMany({ where: { credentialKind: 'FEISHU', actorId: ownerId }, orderBy: { createdAt: 'asc' } });
  /** A session parked in `status` on the owner's runner, as one that ran a turn. */
  const parked = async (title: string, status: RunStatus) => db.session.create({
    data: {
      ownerId, creatorId: ownerId, workspaceId: main.id, assignedRunnerId: runnerId, title, prompt: title, provider: 'claude', status,
      numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${randomUUID()}`,
      dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
      ...(status === RunStatus.SUCCEEDED ? { completedAt: new Date() } : {}),
    },
  });
  /** An alert card the transport sent the owner about a session. */
  const card = async (sessionId: string, kind: string) => {
    const messageId = `om_card_${kind}_${RUN}_${++seq}`;
    await db.feishuMessage.create({
      data: { ownerId, appId: X.appId, collapseKey: `${kind}-${messageId}`, kind, receiveId: ALICE, chatId: CHAT, messageId, sessionId, status: 'SENT', sentAt: new Date() },
    });
    return messageId;
  };

  let started: { messageId: string; eventId: string; sessionId: string } | undefined;

  await t.test('(1) no default workspace: a card to choose one; the click writes it, another account\'s workspace writes nothing', async () => {
    const hello = await dm({ text: 'Fix the export bug' });
    const [picker] = repliesTo(hello.messageId);
    assert.equal(picker!.body && (picker!.body as { msg_type: string }).msg_type, 'interactive');
    const buttons = (contentOf(picker!).body as { elements: Array<Record<string, any>> }).elements.filter((e) => e.tag === 'button');
    assert.deepEqual(new Set(buttons.map((b) => b.text.content)), new Set([main.name, bare.name]), 'the account\'s own workspaces, and only them');
    assert.equal((await sessionsIn(main.id)).length, 0, 'no session was started');

    const refused = await click({ kind: 'default-workspace', workspaceId: theirs.id });
    assert.equal(refused.toast?.type, 'error');
    assert.equal((await appRow()).defaultWorkspaceId, null, "another account's workspace is not written");

    const chosen = await click(buttons.find((b) => b.text.content === main.name)!.behaviors[0].value);
    assert.equal(chosen.toast?.type, 'success');
    assert.ok(chosen.card, 'the picker is redrawn');
    assert.ok(!JSON.stringify(chosen.card).includes('"button"'), 'with no buttons');
    assert.equal((await appRow()).defaultWorkspaceId, main.id);
  });

  await t.test('(2) a new message opens a session in the default workspace, in the account\'s mode, answered in the same chain', async () => {
    const before = await feishuActivity();
    const m = await dm({ text: 'Fix the export bug' });
    const sessions = await sessionsIn(main.id);
    assert.equal(sessions.length, 1, 'one session in the default workspace');
    const session = sessions[0]!;
    assert.equal(session.id, feishuDerivedUuid('feishu-session', X.appId, m.messageId));
    assert.equal(session.prompt, 'Fix the export bug');
    assert.equal(session.permissionMode, ACCOUNT_MODE, "the account's default mode: the bot names none");
    const receipts = repliesTo(m.messageId);
    assert.equal(receipts.length, 1, 'the receipt is a reply to that message');
    assert.equal(contentOf(receipts[0]!).text, `Started · ${session.title} · ${main.name}`);
    const thread = await db.feishuThread.findMany({ where: { appId: X.appId, rootMessageId: m.messageId } });
    assert.deepEqual(thread.map((r) => [r.chatId, r.sessionId, r.ownerId]), [[CHAT, session.id, ownerId]]);
    const recorded = (await feishuActivity()).slice(before.length);
    assert.deepEqual(recorded.map((a) => a.type), ['feishu.session.created']);
    assert.deepEqual(recorded[0]!.payload, { sessionId: session.id, workspaceId: main.id, appId: X.appId, openId: ALICE, messageId: m.messageId });
    started = { ...m, sessionId: session.id };
  });

  await t.test('(3) the same new message handled again opens nothing more', async () => {
    const before = { activity: (await feishuActivity()).length, replies: fake.requestsTo(`/open-apis/im/v1/messages/${started!.messageId}/reply`).length };
    await again(started!.eventId);
    await until('the receipt sent again', () => fake.requestsTo(`/open-apis/im/v1/messages/${started!.messageId}/reply`).length > before.replies);
    assert.equal((await sessionsIn(main.id)).length, 1, 'still one session');
    assert.equal(await db.feishuThread.count({ where: { appId: X.appId } }), 1, 'still one chain');
    assert.equal((await feishuActivity()).length, before.activity, 'no second activity');
    const [first, repeat] = fake.requestsTo(`/open-apis/im/v1/messages/${started!.messageId}/reply`);
    assert.equal((repeat!.body as { uuid: string }).uuid, (first!.body as { uuid: string }).uuid, 'the receipt carries the same uuid, so Feishu delivers it once');
    assert.equal(repliesTo(started!.messageId).length, 1, 'and the owner has one receipt');
  });

  await t.test('(4) a reply to the receipt is a turn of the session', async () => {
    const receiptId = repliesTo(started!.messageId)[0]!.answeredWith!;
    const m = await dm({ text: 'Also update the changelog' }, { root: started!.messageId, parent: receiptId }, { answered: false });
    const turn = await until('the turn', () => db.conversationTurn.findFirst({
      where: { sessionId: started!.sessionId, clientTurnId: feishuDerivedUuid('feishu-turn', X.appId, m.eventId) },
    }));
    assert.equal(turn.content, 'Also update the changelog');
    assert.equal(turn.kind, 'message');
    assert.deepEqual(textsTo(m.messageId), [], 'a turn sent is not answered: the session answers');
  });

  await t.test('(5) a reply to an alert card is a turn of its session; handled twice, one turn', async () => {
    const waiting = await parked(`waiting ${RUN}`, RunStatus.AWAITING_INPUT);
    const alert = await card(waiting.id, 'finished');
    const before = (await feishuActivity()).length;
    const m = await dm({ text: 'Now ship it' }, { root: alert }, { answered: false });
    const turnKey = feishuDerivedUuid('feishu-turn', X.appId, m.eventId);
    const turn = await until('the turn', () => db.conversationTurn.findFirst({ where: { sessionId: waiting.id, clientTurnId: turnKey } }));
    assert.equal(turn.content, 'Now ship it');
    const chain = await db.feishuThread.findUnique({ where: { appId_chatId_rootMessageId: { appId: X.appId, chatId: CHAT, rootMessageId: alert } } });
    assert.equal(chain?.sessionId, waiting.id, "the card's chain is now the session's");
    const recorded = (await feishuActivity()).slice(before);
    assert.deepEqual(recorded.map((a) => [a.type, (a.payload as { sessionId: string }).sessionId, (a.payload as { turnId: string }).turnId]),
      [['feishu.session.turn', waiting.id, turn.id]]);

    await again(m.eventId);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: waiting.id, clientTurnId: turnKey } }), 1, 'one turn');
    assert.equal((await feishuActivity()).length, before + 1, 'one activity');
    assert.deepEqual(textsTo(m.messageId), []);
  });

  await t.test('(6) a reply to a card of an ended session is answered as the App is, and sends nothing', async () => {
    const ended = await parked(`ended ${RUN}`, RunStatus.SUCCEEDED);
    const alert = await card(ended.id, 'finished');
    const turnsBefore = await db.conversationTurn.count({ where: { sessionId: ended.id } });
    const m = await dm({ text: 'One more thing' }, { root: alert });
    assert.deepEqual(textsTo(m.messageId), [ENDED]);
    assert.equal(await db.conversationTurn.count({ where: { sessionId: ended.id } }), turnsBefore);
  });

  await t.test('(7) a refusal before the session is written is answered, and no session is made', async () => {
    await db.feishuApp.update({ where: { appId: X.appId }, data: { defaultWorkspaceId: bare.id } });
    const [sessionsBefore, threadsBefore, activityBefore] = [await db.session.count({ where: { ownerId } }), await db.feishuThread.count(), (await feishuActivity()).length];
    const m = await dm({ text: 'Start something' });
    assert.deepEqual(textsTo(m.messageId), ["Orbit didn't start a session: pick a workspace bound to a runner, or pass assignedRunnerId."]);
    assert.equal(await db.session.count({ where: { ownerId } }), sessionsBefore, 'no session');
    assert.equal(await db.feishuThread.count(), threadsBefore, 'no chain');
    assert.equal((await feishuActivity()).length, activityBefore, 'no activity');
    await db.feishuApp.update({ where: { appId: X.appId }, data: { defaultWorkspaceId: main.id } });
  });

  await t.test('(8) help, status, a reply nobody owns and an image each get their answer and write nothing', async () => {
    const running = await parked(`needs approval ${RUN}`, RunStatus.RUNNING);
    await db.approval.create({ data: { sessionId: running.id, toolName: 'Bash', input: { command: 'ls' }, status: 'PENDING' } });
    const counts = async () => [await db.session.count({ where: { ownerId } }), await db.conversationTurn.count(), await db.feishuThread.count(), (await feishuActivity()).length];
    const before = await counts();

    const help = await dm({ text: 'help' });
    assert.match(textsTo(help.messageId)[0]!, /^What you can send here:/);

    const status = await dm({ text: 'Status' });
    const [answer] = repliesTo(status.messageId);
    const statusCard = contentOf(answer!) as { header: { title: { content: string } }; body: { elements: Array<Record<string, any>> } };
    assert.equal(statusCard.header.title.content, 'Waiting on you · 1');
    const elements = statusCard.body.elements;
    assert.deepEqual(elements.filter((e) => e.tag === 'div').map((e) => e.text.content), [running.title]);
    const open = elements.find((e) => e.tag === 'button')!;
    assert.equal(open.text.content, 'Open in Orbit');
    assert.match(open.behaviors[0].default_url, new RegExp(`/sessions/${uuidToBase62(running.id)}$`));

    const stray = await dm({ text: 'what about this?' }, { root: `om_unknown_${RUN}` });
    assert.deepEqual(textsTo(stray.messageId), [NOT_LINKED]);

    const image = await dm({ image: true });
    assert.deepEqual(textsTo(image.messageId), [NON_TEXT]);

    assert.deepEqual(await counts(), before, 'nothing was written');
  });

  await t.test('(9) the settings page sets and clears the default workspace; another account\'s is refused as not there', async () => {
    const set = await call(server!, 'PATCH', '/api/integrations/feishu', ownerBearer, { defaultWorkspaceId: uuidToBase62(bare.id) });
    assert.equal(set.status, 200, set.text);
    assert.equal((await appRow()).defaultWorkspaceId, bare.id);
    const foreign = await call(server!, 'PATCH', '/api/integrations/feishu', ownerBearer, { defaultWorkspaceId: uuidToBase62(theirs.id) });
    const missing = await call(server!, 'PATCH', '/api/integrations/feishu', ownerBearer, { defaultWorkspaceId: uuidToBase62(randomUUID()) });
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json, missing.json, "another account's workspace is answered as one that does not exist");
    assert.equal((await appRow()).defaultWorkspaceId, bare.id, 'and nothing is written');
    const cleared = await call(server!, 'PATCH', '/api/integrations/feishu', ownerBearer, { defaultWorkspaceId: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.app.defaultWorkspaceId, null);
    assert.equal((await appRow()).defaultWorkspaceId, null);
  });
});
