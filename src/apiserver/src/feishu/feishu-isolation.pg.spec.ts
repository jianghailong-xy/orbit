/**
 * Every Feishu action acts only on the account its app belongs to (docs/feishu-bot-design.md §1.3 2, §7.2; task F3-6),
 * against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the production apiserver
 * (`build/main.js`), and the fake open platform both apps' long connections reach (feishu/test-support/fake-open-platform.ts).
 *
 * Two accounts, A and B, each with its own app. B holds one of everything a Feishu event can name: a running session
 * with a pending tool approval and a pending AskUserQuestion, the alert card of those approvals, a direct-message chain,
 * a workspace, two connected groups (one of them a group A's app is connected in as well) with a topic, a pending
 * group ticket and an owner code. Each case below pushes an event down A's connection that names one of B's objects,
 * and the same event naming an object that does not exist, and holds both to the same two things:
 *
 *   - what the bot answers — the synchronous answer of a card callback, and every request sent to the open platform
 *     because of the event — is the same, its own message ids and de-duplication keys aside;
 *   - the write trap of the tenant isolation census (auth/tenant-isolation-fixtures.ts) sees nothing written but the
 *     inbox's own record of the event (its feishu_inbound_event row, the app's last_event_at) and the clocks that run
 *     whatever arrives (the connection's heartbeat, the runner's).
 *
 * The one action that writes for any chat it names is `@bot connect` (§8.1): it makes or refreshes the pending row of
 * the app's own group — A's, never B's. Its case holds it to writing exactly that, and to B's rows staying as they
 * were; the ticket that row carries is used on the confirm page, whose case holds A's login to B's ticket as to an
 * unknown one.
 *
 * Each case's name carries `[isolation:<key>]`, one per action of FEISHU_ACTIONS (feishu-actions.ts); feishu-actions.spec.ts
 * holds the two lists to each other. Last, the same events sent through B's own app act (the controls): so what A's app
 * was refused is refused because it is A's, not because the fixture could not be acted on.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-isolation.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { WRITE_TRAP } from '../auth/tenant-isolation-fixtures';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FEISHU_CARD_ACTIONS } from './cards/feishu-cards';
import { DEFAULT_WORKSPACE_ACTION } from './cards/feishu-direct-cards';
import { hashChatTicket } from './feishu-chat-route.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { generateConnectCode, hashConnectCode } from './feishu-owner.service';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL_ = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-isolation-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');
const JWT_SECRET = `feishu-isolation-${randomUUID()}`;

const APP_A = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit A bot' };
const APP_B = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit B bot' };
/** The owners' open_ids. Feishu gives each app its own open_ids, so the two never meet. */
const A_OWNER = 'ou_a_owner';
const B_OWNER = 'ou_b_owner';
const STRANGER = 'ou_stranger';

/** Chats: B's direct-message chat; a group both apps are connected in; one only B's is; one nobody's; one fresh. */
const B_DM = 'oc_p2p_b_owner';
const A_DM = 'oc_p2p_a_owner';
const SHARED = 'oc_shared_group';
const B_ONLY = 'oc_b_only_group';
const NOWHERE = 'oc_nowhere_group';
const FRESH = 'oc_fresh_group';
const B_PENDING = 'oc_b_pending_group';

/** B's messages: the alert card of its approvals, the root of its direct-message chain, the root of its group topic. */
const B_CARD = `om_b_card_${RUN}`;
const B_CHAIN = `om_b_chain_${RUN}`;
const B_TOPIC = `om_b_topic_${RUN}`;
const B_TICKET = `b-ticket-${randomUUID()}`;

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
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const without = (row: Row, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

test('Feishu: an app acts only on its own account — naming another account\'s object is naming nothing', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
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
  fake.addApp(APP_A);
  fake.addApp(APP_B);
  // `connect` reads the group from Feishu; the two it is sent in look alike, so the answers can be compared.
  for (const chatId of [B_ONLY, FRESH]) fake.chats.set(chatId, { name: 'A group', external: false });
  const fakeUrl = await fake.start();

  // ── two accounts, each with its own app, runner and workspace ─────────────────────────────────────────────────────
  const account = async (who: 'a' | 'b', app: typeof APP_A, ownerOpenId: string) => {
    const id = randomUUID();
    const email = `feishu-isolation-${who}-${RUN}@feishu-isolation.invalid`;
    await db.user.create({ data: { id, email, name: `Feishu isolation ${who}`, passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' } });
    const runnerId = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId: id, name: `runner-${who}-${RUN}`, tokenHash: sha256(`runner-${randomUUID()}`), maxConcurrent: 8,
        status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
        // Far ahead, so no sweep of the server under test takes the runner for gone while the spec runs.
        lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000),
      },
    });
    const workspace = await db.workspace.create({ data: { ownerId: id, runnerId, name: `workspace-${who}-${RUN}`, enabled: true } });
    // FULL detail with approvals on cards: every card action is open to the owner, so a refusal is only the account's.
    await db.feishuApp.create({
      data: {
        ownerId: id, platform: app.platform, appId: app.appId, appSecretEnc: encryptSecret(app.appSecret), ownerOpenId, ownerName: who,
        botName: app.botName, messageDetail: 'FULL', approvalsInFeishu: true,
      },
    });
    const login = await new JwtService({ secret: JWT_SECRET }).signAsync({ sub: id, email });
    return { id, runnerId, workspaceId: workspace.id, workspaceName: workspace.name, login };
  };
  const A = await account('a', APP_A, A_OWNER);
  const B = await account('b', APP_B, B_OWNER);

  // ── B's objects ──────────────────────────────────────────────────────────────────────────────────────────────────
  const bSession = randomUUID();
  await db.session.create({
    data: {
      id: bSession, ownerId: B.id, creatorId: B.id, workspaceId: B.workspaceId, assignedRunnerId: B.runnerId, title: `B's secret session ${RUN}`,
      prompt: 'the work', provider: 'claude', status: RunStatus.RUNNING, engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(), runtimeSessionId: randomUUID(),
    },
  });
  const bTool = await db.approval.create({
    data: { sessionId: bSession, toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: `tu-${randomUUID()}` },
  });
  const bQuestion = await db.approval.create({
    data: {
      sessionId: bSession, toolName: 'AskUserQuestion', toolUseId: `tu-${randomUUID()}`,
      input: { questions: [{ question: 'Ship it?', header: 'Ship', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }] },
    },
  });
  await db.feishuMessage.create({
    data: {
      ownerId: B.id, appId: APP_B.appId, collapseKey: `approval-${bTool.id}`, kind: 'approval', receiveId: B_OWNER, chatId: B_DM,
      messageId: B_CARD, sessionId: bSession, approvalId: bTool.id, status: 'SENT', revision: 1, renderedRevision: 1, sentAt: new Date(),
    },
  });
  await db.feishuThread.create({ data: { ownerId: B.id, appId: APP_B.appId, chatId: B_DM, rootMessageId: B_CHAIN, sessionId: bSession } });
  await db.feishuThread.create({ data: { ownerId: B.id, appId: APP_B.appId, chatId: SHARED, rootMessageId: B_TOPIC, sessionId: bSession } });
  const route = (ownerId: string, appId: string, chatId: string, workspaceId: string) => db.feishuChatRoute.create({
    data: {
      ownerId, appId, chatId, chatName: chatId, workspaceId, permissionMode: 'acceptEdits', allowedOpenIds: [],
      maxConcurrentSessions: 5, sessionsPerDay: 50, enabled: true, confirmedAt: new Date(),
    },
  });
  await route(B.id, APP_B.appId, SHARED, B.workspaceId);
  await route(B.id, APP_B.appId, B_ONLY, B.workspaceId);
  await route(A.id, APP_A.appId, SHARED, A.workspaceId);
  await db.feishuChatRoute.create({
    data: {
      ownerId: B.id, appId: APP_B.appId, chatId: B_PENDING, chatName: 'B pending', ticketHash: hashChatTicket(B_TICKET), ticketOpenId: B_OWNER,
      ticketEventId: `ev-b-${RUN}`, ticketExpiresAt: new Date(Date.now() + 10 * 60_000),
    },
  });
  const bCode = generateConnectCode();
  await db.feishuConnectCode.create({ data: { ownerId: B.id, codeHash: hashConnectCode(bCode), expiresAt: new Date(Date.now() + 10 * 60_000) } });

  server = await startApiserver(url, JWT_SECRET, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
  const said = () => server!.output().slice(-4000);
  const api = (method: string, path: string, bearer: string, body?: unknown) => call(server!, method, `/api${path}`, bearer, body);
  const connections: Record<string, FakeConnection> = {};
  for (const app of [APP_A, APP_B]) {
    connections[app.appId] = await until(`${app.botName} connected`, () => fake.openConnections(app.appId)[0]).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
    });
    await until(`${app.botName}'s link reported connected`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_link WHERE app_id = $1 AND state = 'CONNECTED'`, [app.appId])).rowCount);
  }

  // ── the write trap ───────────────────────────────────────────────────────────────────────────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  const appRows = async (): Promise<Row[]> => (await sql.query(`SELECT to_jsonb(a) AS r FROM feishu_app a ORDER BY app_id`)).rows.map((r) => r.r);
  const linkRows = async (): Promise<Row[]> => (await sql.query(`SELECT to_jsonb(l) AS r FROM feishu_link l ORDER BY app_id`)).rows.map((r) => r.r);
  /** Every row B's account holds in the Feishu tables and the tables its objects live in. */
  const bState = async () => (await sql.query(
    `SELECT jsonb_build_object(
       'app', (SELECT to_jsonb(a) FROM feishu_app a WHERE owner_id = $1::uuid),
       'routes', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM feishu_chat_route r WHERE owner_id = $1::uuid),
       'threads', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM feishu_thread t WHERE owner_id = $1::uuid),
       'messages', (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM feishu_message m WHERE owner_id = $1::uuid),
       'codes', (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM feishu_connect_code c WHERE owner_id = $1::uuid),
       'approvals', (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM approval p WHERE session_id = $2::uuid),
       'turns', (SELECT count(*) FROM conversation_turn WHERE session_id = $2::uuid),
       'sessions', (SELECT count(*) FROM session WHERE owner_id = $1::uuid)) AS s`,
    [B.id, bSession])).rows[0].s;

  /**
   * Every row written since `since` that is not the inbox's own record of `eventId` (its feishu_inbound_event row, the
   * app's last_event_at), nor a clock that runs whatever arrives (a connection's heartbeat, a runner's).
   */
  const strayRows = async (since: bigint, appId: string, eventId: string | null, apps: Row[], links: Row[]) => {
    const rows = (await sql.query<{ tbl: string; op: string; row: Row }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`, [since.toString()],
    )).rows;
    const appsBefore = JSON.stringify(apps.map((a) => without(a, 'last_event_at')));
    const linksBefore = JSON.stringify(links.map((l) => without(l, 'heartbeat_at')));
    return rows.filter(({ tbl, op, row }) => {
      if (tbl === 'feishu_inbound_event' && (op === 'INSERT' || op === 'UPDATE') && row.event_id === eventId && row.app_id === appId) return false;
      if (tbl === 'feishu_app' && op === 'UPDATE' && row.app_id === appId && appsBefore.includes(JSON.stringify(without(row, 'last_event_at')))) return false;
      if (tbl === 'feishu_link' && op === 'UPDATE' && linksBefore.includes(JSON.stringify(without(row, 'heartbeat_at')))) return false;
      if (tbl === 'runner' && op === 'UPDATE') return false;
      return true;
    });
  };
  const strayWrites = async (since: bigint, appId: string, eventId: string | null, apps: Row[], links: Row[]): Promise<string[]> =>
    (await strayRows(since, appId, eventId, apps, links)).map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);

  /**
   * What the bot sent to the open platform because of one event, comparable across events: the messaging and contact
   * requests in order, each with the event's own message id and the de-duplication key left out, and a card's ticket
   * link (one per event, §8.1) reduced to its shape.
   */
  const sentSince = (before: number, messageId: string): Json[] =>
    fake.requests.slice(before).filter((r: FakeRequest) => r.path.startsWith('/open-apis/im/') || r.path.startsWith('/open-apis/contact/')).map((r) => {
      const body = { ...((r.body as Json | null) ?? {}) };
      delete body.uuid;
      if (typeof body.content === 'string') {
        body.content = JSON.parse(body.content.replace(/ticket=[^"&\\]+/g, 'ticket=<ticket>'));
      }
      return { method: r.method, path: r.path.split(messageId).join('<message>'), body };
    });

  let seq = 0;
  const processed = (appId: string, eventId: string, attempts = 1) =>
    until(`${eventId} processed`, async () =>
      (await sql.query(
        `SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts >= $3`,
        [appId, eventId, attempts],
      )).rowCount).catch((error) => {
      throw new Error(`${(error as Error).message}; the apiserver said:\n${said()}`);
    });

  /** Push one event down `app`'s connection, wait until handled, and resolve with what it answered, sent and wrote. */
  async function push(app: typeof APP_A, eventType: string, event: (eventId: string, messageId: string) => Json) {
    const eventId = `ev-isolation-${RUN}-${++seq}`;
    const messageId = `om_${eventId}`;
    const [apps, links] = [await appRows(), await linkRows()];
    const sentBefore = fake.requests.length;
    const before = await mark();
    const ack = await fake.push(connections[app.appId]!, {
      schema: '2.0',
      header: { event_id: eventId, event_type: eventType, app_id: app.appId, create_time: String(Date.now()), token: '' },
      event: event(eventId, messageId),
    });
    assert.equal(ack.code, 200);
    await processed(app.appId, eventId);
    // What the event sends is sent before the inbox stamps it processed; a moment more for any straggler.
    await sleep(400);
    const rows = await strayRows(before, app.appId, eventId, apps, links);
    return {
      eventId, messageId,
      answer: (ack.data ?? null) as Json | null,
      sent: sentSince(sentBefore, messageId),
      stray: rows.map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`),
      written: rows.map(({ tbl, op, row }) => ({ op, tbl, owner: row.owner_id, app: row.app_id })),
    };
  }
  /** Handle an event already in the inbox once more, as a worker whose lease ran out would (§7.1). */
  async function again(appId: string, eventId: string, messageId: string) {
    const [apps, links] = [await appRows(), await linkRows()];
    const sentBefore = fake.requests.length;
    const before = await mark();
    const { attempts } = (await sql.query<{ attempts: number }>(
      `UPDATE feishu_inbound_event SET processed_at = NULL, lease_until = NULL WHERE app_id = $1 AND event_id = $2 RETURNING attempts`, [appId, eventId],
    )).rows[0];
    await processed(appId, eventId, attempts + 1);
    await sleep(400);
    return { sent: sentSince(sentBefore, messageId), stray: await strayWrites(before, appId, eventId, apps, links) };
  }

  const message = (app: typeof APP_A, openId: string, chat: { id: string; type: 'p2p' | 'group' }, text: string, reply?: { root: string; parent?: string }) =>
    push(app, 'im.message.receive_v1', (_eventId, messageId) => ({
      sender: { sender_id: { open_id: openId }, sender_type: 'user' },
      message: {
        message_id: messageId, chat_id: chat.id, chat_type: chat.type, message_type: 'text',
        content: JSON.stringify({ text: chat.type === 'group' ? `@_user_1 ${text}` : text }),
        ...(chat.type === 'group' ? { mentions: [{ key: '@_user_1', name: app.botName }] } : {}),
        ...(reply ? { root_id: reply.root, parent_id: reply.parent ?? reply.root, ...(chat.type === 'group' ? { thread_id: `omt_${reply.root}` } : {}) } : {}),
      },
    }));
  const click = (app: typeof APP_A, openId: string, onMessage: string, value: Json, formValue?: Json) =>
    push(app, 'card.action.trigger', () => ({
      operator: { open_id: openId },
      token: fake.cardToken(),
      action: { tag: 'button', value, ...(formValue ? { form_value: formValue } : {}) },
      context: { open_message_id: onMessage, open_chat_id: openId === A_OWNER ? A_DM : B_DM },
    }));

  /** The two events agree on what the bot did, and neither wrote beyond the inbox's record; B's rows are as they were. */
  const sameAsNothing = async (
    named: Awaited<ReturnType<typeof push>>, nothing: Awaited<ReturnType<typeof push>>, bBefore: unknown,
  ) => {
    assert.deepEqual(named.stray, [], 'naming B\'s object wrote nothing beyond the inbox\'s record');
    assert.deepEqual(nothing.stray, [], 'naming nothing wrote nothing beyond the inbox\'s record');
    assert.deepEqual(named.answer, nothing.answer, 'the synchronous answer is the same');
    assert.deepEqual(named.sent, nothing.sent, 'what went to Feishu is the same');
    assert.deepEqual(await bState(), bBefore, 'B\'s rows are as they were');
  };
  const textOf = (sent: Json[]) => sent.filter((s) => s.body.msg_type === 'text').map((s) => s.body.content.text as string);

  // ── direct messages ──────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('[isolation:direct-reply] a reply whose root is B\'s alert card or chain is a reply to nothing', async () => {
    const bBefore = await bState();
    const nothing = await message(APP_A, A_OWNER, { id: B_DM, type: 'p2p' }, 'go on', { root: `om_nothing_${RUN}` });
    assert.deepEqual(textOf(nothing.sent), ["This message isn't linked to an Orbit session. To start a new session, send a new message rather than a reply."]);
    for (const root of [B_CARD, B_CHAIN]) {
      const named = await message(APP_A, A_OWNER, { id: B_DM, type: 'p2p' }, 'go on', { root });
      await sameAsNothing(named, nothing, bBefore);
      // In A's own chat too, and as the message replied to rather than the chain's root.
      const own = await message(APP_A, A_OWNER, { id: A_DM, type: 'p2p' }, 'go on', { root: `om_x_${RUN}`, parent: root });
      await sameAsNothing(own, nothing, bBefore);
    }
  });

  await t.test('[isolation:direct-reply] the same event handled a second time writes nothing either', async () => {
    const bBefore = await bState();
    const first = await message(APP_A, A_OWNER, { id: B_DM, type: 'p2p' }, 'once more', { root: B_CARD });
    const second = await again(APP_A.appId, first.eventId, first.messageId);
    assert.deepEqual(second.stray, []);
    assert.deepEqual(second.sent, first.sent, 'answered again alike');
    assert.deepEqual(await bState(), bBefore);
  });

  await t.test('[isolation:direct-start] a default workspace that is B\'s opens nothing in it: answered as no default', async () => {
    const bBefore = await bState();
    // No route lets A's app hold B's workspace (the settings PATCH and the picker both refuse it); written here directly,
    // so what the message does with it is held on its own. A default that does not exist is no default: the column is
    // emptied when its workspace goes (ON DELETE SET NULL).
    await db.feishuApp.update({ where: { appId: APP_A.appId }, data: { defaultWorkspaceId: null } });
    const nothing = await message(APP_A, A_OWNER, { id: A_DM, type: 'p2p' }, 'build the thing');
    await db.feishuApp.update({ where: { appId: APP_A.appId }, data: { defaultWorkspaceId: B.workspaceId } });
    const named = await message(APP_A, A_OWNER, { id: A_DM, type: 'p2p' }, 'build the thing');
    await db.feishuApp.update({ where: { appId: APP_A.appId }, data: { defaultWorkspaceId: null } });
    await sameAsNothing(named, nothing, bBefore);
    // The answer is the picker of A's own workspaces: B's is not on it.
    const card = JSON.stringify(named.sent);
    assert.ok(card.includes(A.workspaceName), 'A is offered its own workspace');
    assert.ok(!card.includes(B.workspaceName) && !card.includes(B.workspaceId), 'B\'s workspace is not named');
    assert.equal(await db.session.count({ where: { ownerId: A.id } }), 0, 'no session was opened');
  });

  await t.test('[isolation:direct-status] `status` lists A\'s own waiting sessions, never B\'s', async () => {
    const bBefore = await bState();
    const status = await message(APP_A, A_OWNER, { id: A_DM, type: 'p2p' }, 'status');
    assert.deepEqual(status.stray, []);
    assert.equal(status.sent.length, 1, 'one card');
    const card = JSON.stringify(status.sent);
    assert.ok(!card.includes(`B's secret session`) && !card.includes(bSession), 'B\'s session waiting on its owner is not listed');
    assert.deepEqual(await bState(), bBefore);
  });

  await t.test('[isolation:direct-workspace-pick] a picker click naming B\'s workspace is a workspace that is gone', async () => {
    const bBefore = await bState();
    const nothing = await click(APP_A, A_OWNER, `om_picker_${RUN}`, { kind: DEFAULT_WORKSPACE_ACTION, workspaceId: randomUUID() });
    const named = await click(APP_A, A_OWNER, `om_picker_${RUN}`, { kind: DEFAULT_WORKSPACE_ACTION, workspaceId: B.workspaceId });
    assert.deepEqual(named.answer, { toast: { type: 'error', content: 'That workspace is no longer in Orbit. Send a new message to choose another.' } });
    await sameAsNothing(named, nothing, bBefore);
    assert.equal((await db.feishuApp.findUniqueOrThrow({ where: { appId: APP_A.appId } })).defaultWorkspaceId, null);
  });

  await t.test('[isolation:settings-default-workspace] the settings page refuses B\'s workspace as A\'s default, as an unknown one', async () => {
    const [apps, links] = [await appRows(), await linkRows()];
    const before = await mark();
    const named = await api('PATCH', '/integrations/feishu', A.login, { defaultWorkspaceId: B.workspaceId });
    const nothing = await api('PATCH', '/integrations/feishu', A.login, { defaultWorkspaceId: randomUUID() });
    assert.equal(named.status, 404, named.text);
    assert.deepEqual({ status: named.status, json: named.json }, { status: nothing.status, json: nothing.json });
    assert.deepEqual(await strayWrites(before, APP_A.appId, null, apps, links), []);
  });

  await t.test('[isolation:owner-code] B\'s owner code sent to A\'s bot is a code that does not exist', async () => {
    const bBefore = await bState();
    for (const sender of [STRANGER, A_OWNER]) {
      const nothing = await message(APP_A, sender, { id: `oc_p2p_${sender}`, type: 'p2p' }, generateConnectCode());
      const named = await message(APP_A, sender, { id: `oc_p2p_${sender}`, type: 'p2p' }, bCode);
      await sameAsNothing(named, nothing, bBefore);
      // In a group, where a code is dropped as seen (§5.1): only a code of A's own would be.
      const inGroupNothing = await message(APP_A, sender, { id: SHARED, type: 'group' }, generateConnectCode());
      const inGroup = await message(APP_A, sender, { id: SHARED, type: 'group' }, bCode);
      await sameAsNothing(inGroup, inGroupNothing, bBefore);
    }
    assert.equal((await db.feishuApp.findUniqueOrThrow({ where: { appId: APP_A.appId } })).ownerOpenId, A_OWNER);
  });

  // ── card callbacks ───────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('[isolation:card-approval] Allow once and Deny naming B\'s approval are an approval that is not there', async () => {
    const bBefore = await bState();
    for (const action of [FEISHU_CARD_ACTIONS.allow, FEISHU_CARD_ACTIONS.deny]) {
      const nothing = await click(APP_A, A_OWNER, `om_nothing_card_${RUN}`, { action, approvalId: randomUUID() });
      assert.deepEqual(nothing.answer, { toast: { type: 'info', content: 'Already answered in Orbit.' } });
      // On B's card, and on a card of nobody's.
      for (const onMessage of [B_CARD, `om_nothing_card_${RUN}`]) {
        const named = await click(APP_A, A_OWNER, onMessage, { action, approvalId: bTool.id });
        await sameAsNothing(named, nothing, bBefore);
      }
    }
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: bTool.id } })).status, 'PENDING');
  });

  await t.test('[isolation:card-question] an answer form naming B\'s question is a question that is not there', async () => {
    const bBefore = await bState();
    const nothing = await click(APP_A, A_OWNER, `om_nothing_card_${RUN}`, { action: FEISHU_CARD_ACTIONS.answer, approvalId: randomUUID() }, { a0_q0: '0' });
    assert.deepEqual(nothing.answer, { toast: { type: 'info', content: 'Already answered in Orbit.' } });
    for (const onMessage of [B_CARD, `om_nothing_card_${RUN}`]) {
      const named = await click(APP_A, A_OWNER, onMessage, { action: FEISHU_CARD_ACTIONS.answer, approvalId: bQuestion.id }, { a0_q0: '0' });
      await sameAsNothing(named, nothing, bBefore);
    }
    // And Allow once naming the question, the form naming the tool: still nothing, not "use the other button".
    const allowOnQuestion = await click(APP_A, A_OWNER, B_CARD, { action: FEISHU_CARD_ACTIONS.allow, approvalId: bQuestion.id });
    await sameAsNothing(allowOnQuestion, nothing, bBefore);
    const formOnTool = await click(APP_A, A_OWNER, B_CARD, { action: FEISHU_CARD_ACTIONS.answer, approvalId: bTool.id }, { a0_q0: '0' });
    await sameAsNothing(formOnTool, nothing, bBefore);
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: bQuestion.id } })).status, 'PENDING');
  });

  // ── groups ───────────────────────────────────────────────────────────────────────────────────────────────────────
  await t.test('[isolation:group-start] a mention of A\'s bot in a group only B connected is a group nobody connected', async () => {
    const bBefore = await bState();
    const nothing = await message(APP_A, A_OWNER, { id: NOWHERE, type: 'group' }, 'fix the build');
    assert.deepEqual(textOf(nothing.sent), [
      `This group isn't connected to Orbit, so nothing was started. The bot's owner can connect it by sending "@${APP_A.botName} connect" here.`,
    ]);
    for (const sender of [A_OWNER, STRANGER]) {
      const named = await message(APP_A, sender, { id: B_ONLY, type: 'group' }, 'fix the build');
      const nobody = sender === A_OWNER ? nothing : await message(APP_A, sender, { id: NOWHERE, type: 'group' }, 'fix the build');
      await sameAsNothing(named, nobody, bBefore);
    }
  });

  await t.test('[isolation:group-turn] a mention in a topic whose root is B\'s topic is a topic linked to nothing', async () => {
    const bBefore = await bState();
    const nothing = await message(APP_A, A_OWNER, { id: SHARED, type: 'group' }, 'and the tests', { root: `om_nothing_topic_${RUN}` });
    assert.deepEqual(textOf(nothing.sent), [
      `This topic isn't linked to an Orbit session. To start one, send "@${APP_A.botName} <request>" in the group, not in a topic.`,
    ]);
    const named = await message(APP_A, A_OWNER, { id: SHARED, type: 'group' }, 'and the tests', { root: B_TOPIC });
    await sameAsNothing(named, nothing, bBefore);
    const stranger = await message(APP_A, STRANGER, { id: SHARED, type: 'group' }, 'and the tests', { root: B_TOPIC });
    const strangerNothing = await message(APP_A, STRANGER, { id: SHARED, type: 'group' }, 'and the tests', { root: `om_nothing_topic_${RUN}` });
    await sameAsNothing(stranger, strangerNothing, bBefore);
    const again_ = await again(APP_A.appId, named.eventId, named.messageId);
    assert.deepEqual(again_.stray, []);
    assert.deepEqual(again_.sent, named.sent);
  });

  await t.test('[isolation:bot-removed] A\'s bot removed from a group only B connected switches off nothing', async () => {
    const bBefore = await bState();
    const removed = (chatId: string) => push(APP_A, 'im.chat.member.bot.deleted_v1', () => ({ chat_id: chatId, operator_id: { open_id: A_OWNER } }));
    const nothing = await removed(NOWHERE);
    for (const chatId of [B_ONLY, B_PENDING]) await sameAsNothing(await removed(chatId), nothing, bBefore);
  });

  await t.test('[isolation:group-connect] `connect` in a group B connected writes only A\'s own pending row, as in a fresh group', async () => {
    const bBefore = await bState();
    const fresh = await message(APP_A, A_OWNER, { id: FRESH, type: 'group' }, 'connect');
    const named = await message(APP_A, A_OWNER, { id: B_ONLY, type: 'group' }, 'connect');
    assert.deepEqual(fresh.written, [{ op: 'INSERT', tbl: 'feishu_chat_route', owner: A.id, app: APP_A.appId }]);
    assert.deepEqual(named.written, fresh.written, 'the same one write, of A\'s own row');
    // The group is read from Feishu by its own chat_id; that aside, the same requests and the same card, its ticket aside.
    const inChat = (sent: Json[], chatId: string) => JSON.parse(JSON.stringify(sent).split(chatId).join('<chat>')) as Json[];
    assert.deepEqual(inChat(named.sent, B_ONLY), inChat(fresh.sent, FRESH), 'the same card, its ticket aside');
    assert.deepEqual(await bState(), bBefore, 'B\'s connected route is as it was');
    const aRoute = await db.feishuChatRoute.findUniqueOrThrow({ where: { appId_chatId: { appId: APP_A.appId, chatId: B_ONLY } } });
    assert.deepEqual({ owner: aRoute.ownerId, confirmed: aRoute.confirmedAt, workspace: aRoute.workspaceId }, { owner: A.id, confirmed: null, workspace: null });
    // A stranger's `connect` in B's group: refused as in any group, nothing written.
    const strangerFresh = await message(APP_A, STRANGER, { id: NOWHERE, type: 'group' }, 'connect');
    const strangerNamed = await message(APP_A, STRANGER, { id: B_PENDING, type: 'group' }, 'connect');
    await sameAsNothing(strangerNamed, strangerFresh, bBefore);
  });

  await t.test('[isolation:group-connect] A\'s login reads and confirms B\'s live ticket as an unknown one, writing nothing', async () => {
    const bBefore = await bState();
    const [apps, links] = [await appRows(), await linkRows()];
    const before = await mark();
    const read = await api('GET', `/integrations/feishu/chats?ticket=${encodeURIComponent(B_TICKET)}`, A.login);
    const readNothing = await api('GET', `/integrations/feishu/chats?ticket=${encodeURIComponent(`no-${randomUUID()}`)}`, A.login);
    assert.equal(read.status, 200, read.text);
    assert.equal(read.json.pending, null);
    assert.deepEqual(read.json, readNothing.json);
    const submission = { workspaceId: A.workspaceId, permissionMode: 'acceptEdits', allowedOpenIds: [], maxConcurrentSessions: 1, sessionsPerDay: 1 };
    const confirm = await api('POST', '/integrations/feishu/chats/confirm', A.login, { ticket: B_TICKET, ...submission });
    const confirmNothing = await api('POST', '/integrations/feishu/chats/confirm', A.login, { ticket: `no-${randomUUID()}`, ...submission });
    assert.equal(confirm.status, 409, confirm.text);
    assert.deepEqual({ status: confirm.status, json: confirm.json }, { status: confirmNothing.status, json: confirmNothing.json });
    // B's ticket with B's own workspace in it: still B's ticket, still nothing.
    const withB = await api('POST', '/integrations/feishu/chats/confirm', A.login, { ticket: B_TICKET, ...submission, workspaceId: B.workspaceId });
    assert.equal(withB.status, 404, withB.text);
    assert.deepEqual(await strayWrites(before, APP_A.appId, null, apps, links), []);
    assert.deepEqual(await bState(), bBefore);
  });

  // ── controls: the same events through B's own app act ────────────────────────────────────────────────────────────
  await t.test('control: through B\'s own app, the same objects are acted on', async () => {
    const turns = () => db.conversationTurn.count({ where: { sessionId: bSession } });
    const turnsBefore = await turns();
    const reply = await message(APP_B, B_OWNER, { id: B_DM, type: 'p2p' }, 'go on', { root: B_CARD });
    const afterReply = await turns();
    assert.ok(afterReply > turnsBefore, `B's reply to its card is a turn of its session (${JSON.stringify(reply.sent)})`);
    const topic = await message(APP_B, B_OWNER, { id: SHARED, type: 'group' }, 'and the tests', { root: B_TOPIC });
    assert.ok(await turns() > afterReply, `B's mention in its topic is a turn of its session (${JSON.stringify(topic.sent)})`);
    const turnActivity = await db.activity.count({ where: { actorId: B.id, credentialKind: 'FEISHU', type: { in: ['feishu.session.turn', 'feishu.group.session.turn'] } } });
    assert.equal(turnActivity, 2, 'each recorded once as a FEISHU action of B');

    const pick = await click(APP_B, B_OWNER, `om_picker_${RUN}`, { kind: DEFAULT_WORKSPACE_ACTION, workspaceId: B.workspaceId });
    assert.equal(pick.answer?.toast?.type, 'success', JSON.stringify(pick.answer));
    assert.equal((await db.feishuApp.findUniqueOrThrow({ where: { appId: APP_B.appId } })).defaultWorkspaceId, B.workspaceId);

    const answered = await click(APP_B, B_OWNER, B_CARD, { action: FEISHU_CARD_ACTIONS.answer, approvalId: bQuestion.id }, { a0_q0: '0' });
    assert.equal(answered.answer?.toast?.content, 'Answer sent.', JSON.stringify(answered.answer));
    const question = await db.approval.findUniqueOrThrow({ where: { id: bQuestion.id } });
    assert.deepEqual({ status: question.status, answers: question.answers, kind: question.decidedCredentialKind }, {
      status: 'ALLOWED', answers: { 'Ship it?': ['Yes'] }, kind: 'FEISHU',
    });
    const allowed = await click(APP_B, B_OWNER, B_CARD, { action: FEISHU_CARD_ACTIONS.allow, approvalId: bTool.id });
    assert.equal(allowed.answer?.toast?.content, 'Allowed.', JSON.stringify(allowed.answer));
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: bTool.id } })).status, 'ALLOWED');

    const confirm = await api('POST', '/integrations/feishu/chats/confirm', B.login, {
      ticket: B_TICKET, workspaceId: B.workspaceId, permissionMode: 'acceptEdits', allowedOpenIds: [], maxConcurrentSessions: 1, sessionsPerDay: 1,
    });
    assert.equal(confirm.status, 201, confirm.text);

    await message(APP_B, 'ou_b_new_owner', { id: 'oc_p2p_b_new', type: 'p2p' }, bCode);
    assert.equal((await db.feishuApp.findUniqueOrThrow({ where: { appId: APP_B.appId } })).ownerOpenId, 'ou_b_new_owner', 'B\'s code binds B\'s bot');

    const removed = await push(APP_B, 'im.chat.member.bot.deleted_v1', () => ({ chat_id: B_ONLY, operator_id: { open_id: B_OWNER } }));
    assert.ok(removed.stray.length > 0);
    assert.equal((await db.feishuChatRoute.findUniqueOrThrow({ where: { appId_chatId: { appId: APP_B.appId, chatId: B_ONLY } } })).enabled, false);
  });
});
