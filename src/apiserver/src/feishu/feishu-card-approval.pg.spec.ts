/**
 * The owner answers a tool approval on its Feishu card (docs/feishu-bot-design.md §7.1, §7.2, §7.4; decision 1; task
 * F2-1), end to end against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty, the production
 * apiserver (`build/main.js`), and the fake open platform its long connection reaches
 * (feishu/test-support/fake-open-platform.ts). The runner's side is its own HTTP door: it files each approval with
 * `POST /api/runner/sessions/:id/approvals`, which makes PushService send the card, and long-polls the decision with
 * `GET /api/runner/sessions/:id/approvals/:approvalId` as the engine's permission prompt (`orbit mcp`) does. Each click is pushed
 * down the long connection as Feishu would push it, built from the button on the card Feishu received. What it is held
 * to:
 *
 *   (1) Allow once: answered within Feishu's 3 seconds with the toast `Allowed.` and the card drawn as its outcome with no
 *       button; the runner's long poll gets allow; the decision records credentialKind FEISHU, the clicker's open_id
 *       and the card's message_id; the card's row is CLOSED, and nothing PATCHes it after;
 *   (2) what the runner gets is what a decision through the web app's route gives it, id aside;
 *   (3) Deny: the long poll gets deny, recorded as FEISHU;
 *   (4) a click that carries "always allow" (`rememberRules`) is refused with a toast and writes nothing: the
 *       approval stays PENDING, no standing grant is made — the write trap sees only the inbox's own record;
 *   (5) the same click's event handled a second time decides nothing more: one decision, its time unchanged;
 *   (6) a stale card — its approval answered elsewhere, or its session no longer running — is answered
 *       `Already answered in Orbit.` and drawn as its outcome; the approval is left as it was;
 *   (7) approvalsInFeishu off: the card has no Allow or Deny, and a click naming the approval is refused, writing
 *       nothing; Orbit's own confirmation cards are refused likewise;
 *   (8) a click whose answer is not ready within the budget is answered `Working…`, and its card follows once through
 *       the callback's update token (in process: the inbox with a slow router, then FeishuCardActions.deliverLate).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/feishu/feishu-card-approval.pg.spec.ts
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
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FeishuTransport } from '../push/feishu-transport';
import type { SessionsService } from '../sessions/sessions.service';
import { FeishuAppService } from './feishu-app.service';
import { FeishuCardActions } from './feishu-card-actions';
import { CARD_WORKING, FeishuInboxService } from './feishu-inbox.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from './feishu-open-platform';
import { FeishuOutbound } from './feishu-outbound';
import type { FeishuChatRouteService } from './feishu-chat-route.service';
import type { FeishuOwnerService } from './feishu-owner.service';
import { FeishuRouter, type InboundEvent } from './feishu-router';
import { FakeOpenPlatform, type FakeConnection, type FakeRequest } from './test-support/fake-open-platform';

const URL_ = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-card-approval-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');
const JWT_SECRET = `feishu-card-approval-${randomUUID()}`;
const X = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}`, botName: 'Orbit approvals bot' };
const ALICE = 'ou_alice_owner';

/** The words §7.4 prescribes, spelled out here so the spec pins the words themselves. */
const STALE = 'Already answered in Orbit.';

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

/** Every element of `tag`, at any depth. */
function tagged(value: unknown, tag: string): Json[] {
  if (Array.isArray(value)) return value.flatMap((v) => tagged(v, tag));
  if (!value || typeof value !== 'object') return [];
  const self = (value as { tag?: unknown }).tag === tag ? [value as Json] : [];
  return [...self, ...Object.values(value).flatMap((v) => tagged(v, tag))];
}
/** The callback values of a card's buttons. */
const callbacks = (card: unknown): Json[] =>
  tagged(card, 'button').flatMap((b) => ((b.behaviors as Json[]) ?? []).filter((x) => x.type === 'callback').map((x) => x.value as Json));
const allText = (card: unknown) => JSON.stringify(card);

test('Feishu: the owner answers a tool approval on its card — Allow once and Deny reach the runner, recorded as FEISHU', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
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
  fake.addApp(X);
  const fakeUrl = await fake.start();
  process.env[FEISHU_TEST_OPEN_PLATFORM_ENV] = fakeUrl;

  // ── the account: its own app with Alice as its owner, a runner and a workspace; no device ─────────────────────────
  const ownerId = randomUUID();
  const email = `feishu-card-approval-${RUN}@feishu-card-approval.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'Feishu approvals', passwordHash: hashPassword(`password-${RUN}`), role: 'MEMBER' } });
  await db.feishuApp.create({
    data: { ownerId, platform: X.platform, appId: X.appId, appSecretEnc: encryptSecret(X.appSecret), ownerOpenId: ALICE, ownerName: 'Alice' },
  });
  const runnerId = randomUUID();
  const runnerToken = `runner-${randomUUID()}`;
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `runner-${RUN}`, tokenHash: createHash('sha256').update(runnerToken).digest('hex'),
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      // Far ahead, so no sweep of the server under test takes the runner for gone while the spec runs.
      lastHeartbeatAt: new Date(Date.now() + 2 * 3_600_000),
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `workspace-${RUN}`, enabled: true } });
  const bearer = await new JwtService({ secret: JWT_SECRET }).signAsync({ sub: ownerId, email });

  server = await startApiserver(url, JWT_SECRET, { [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl });
  const connection: FakeConnection = await until('the app connected', () => fake.openConnections(X.appId)[0]).catch((error) => {
    throw new Error(`${(error as Error).message}; the apiserver said:\n${server!.output().slice(-4000)}`);
  });

  // As `orbit mcp` calls them: the permission prompt files the approval and long-polls it, naming itself (runner-link-required.ts).
  const runner = (method: string, path: string, body?: unknown) =>
    call(server!, method, `/api/runner${path}`, runnerToken, body, { 'x-orbit-runner-caller': 'mcp' });
  const session = async (title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'the work', provider: 'claude',
        status: RunStatus.RUNNING, engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    return id;
  };
  /** The runner files an approval; resolves with its id and the card Feishu received for it. */
  const ask = async (sessionId: string, toolName = 'Bash') => {
    const sentBefore = fake.messages.length;
    const filed = await runner('POST', `/sessions/${sessionId}/approvals`, { toolName, input: { command: `ls ${randomUUID()}` }, toolUseId: `tu-${randomUUID()}` });
    assert.equal(filed.status, 201, filed.text);
    const sent = await until(`the card for ${filed.json.id}`, () =>
      fake.messages.slice(sentBefore).find((m) => m.method === 'POST' && m.path === '/open-apis/im/v1/messages'));
    await until('the card row SENT', async () =>
      (await db.feishuMessage.findFirst({ where: { messageId: sent.answeredWith!, status: 'SENT' } })) !== null);
    return { approvalId: filed.json.id as string, messageId: sent.answeredWith!, card: JSON.parse((sent.body as { content: string }).content) as Json };
  };
  /** The runner's long poll of one approval, as the engine's permission prompt waits on it. */
  const poll = (sessionId: string, approvalId: string) => runner('GET', `/sessions/${sessionId}/approvals/${approvalId}`);

  let seq = 0;
  const events: Record<string, unknown> = {};
  /** Push one click by `openId` on `messageId` with the button `value`; resolve with the synchronous answer and its time. */
  async function click(messageId: string, value: Json, openId = ALICE) {
    const eventId = `ev-card-approval-${RUN}-${++seq}`;
    const envelope = {
      schema: '2.0',
      header: { event_id: eventId, event_type: 'card.action.trigger', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: {
        operator: { open_id: openId },
        token: fake.cardToken(),
        action: { tag: 'button', value },
        context: { open_message_id: messageId, open_chat_id: `oc_p2p_${openId}` },
      },
    };
    events[eventId] = envelope;
    const started = Date.now();
    const ack = await fake.push(connection, envelope);
    const ms = Date.now() - started;
    assert.equal(ack.code, 200);
    return { eventId, answer: ack.data as Json, ms };
  }
  const approvalRow = (id: string) => db.approval.findUniqueOrThrow({ where: { id } });
  const patchesOf = (messageId: string) =>
    fake.messages.filter((m: FakeRequest) => m.method === 'PATCH' && m.path === `/open-apis/im/v1/messages/${messageId}`);

  await t.test('(1) Allow once: toast and outcome card within 3 s, the runner gets allow, recorded as FEISHU', async () => {
    const s = await session('Deploy the docs');
    const { approvalId, messageId, card } = await ask(s);
    const buttons = callbacks(card);
    assert.deepEqual(buttons.map((b) => b.action), ['approval.allow', 'approval.deny'], 'the card offers Allow once and Deny');
    assert.ok(!/always/i.test(allText(card)), 'and never "always allow"');
    const waiting = poll(s, approvalId);
    const c = await click(messageId, buttons[0]!);
    assert.ok(c.ms < 3_000, `answered in ${c.ms}ms`);
    assert.deepEqual(c.answer.toast, { type: 'success', content: 'Allowed.' });
    assert.equal(c.answer.card?.type, 'raw');
    const drawn = c.answer.card.data;
    assert.deepEqual(callbacks(drawn), [], 'the card is drawn with no button');
    assert.match(allText(drawn), /Allowed in Orbit · \d\d:\d\d UTC/);
    const decision = await waiting;
    assert.equal(decision.status, 200, decision.text);
    assert.equal(decision.json.behavior, 'allow');
    assert.equal(decision.json.status, 'ALLOWED');
    const row = await approvalRow(approvalId);
    assert.equal(row.decidedCredentialKind, 'FEISHU');
    assert.equal(row.decidedFeishuOpenId, ALICE);
    assert.equal(row.decidedFeishuMessageId, messageId);
    assert.equal(row.decidedById, ownerId);
    assert.equal(row.rememberRule, null);
    assert.equal((await db.feishuMessage.findFirstOrThrow({ where: { messageId } })).status, 'CLOSED');
    await sleep(1_500); // the badge reconcile the decision schedules has run: it leaves a CLOSED card alone.
    assert.deepEqual(patchesOf(messageId), [], 'nothing PATCHes the card after');
    events.allowed = { eventId: c.eventId, approvalId };

    // (2) What the runner gets is what the web app's decision route gives it.
    const { approvalId: viaWeb } = await ask(s);
    const webWaiting = poll(s, viaWeb);
    const web = await call(server!, 'POST', `/api/sessions/${s}/approvals/${viaWeb}/decision`, bearer, { behavior: 'allow' });
    assert.equal(web.status, 201, web.text);
    const webDecision = await webWaiting;
    assert.deepEqual(without(decision.json, 'id', 'publicId'), without(webDecision.json, 'id', 'publicId'), 'the same decision, whichever door it came in by');
    assert.equal((await approvalRow(viaWeb)).decidedCredentialKind, 'LOGIN', 'the web app\'s decision is recorded as LOGIN');
  });

  await t.test('(3) Deny: the runner gets deny, recorded as FEISHU', async () => {
    const s = await session('Delete the cache');
    const { approvalId, messageId, card } = await ask(s);
    const waiting = poll(s, approvalId);
    const c = await click(messageId, callbacks(card)[1]!);
    assert.deepEqual(c.answer.toast, { type: 'success', content: 'Denied.' });
    assert.match(allText(c.answer.card.data), /Denied in Orbit/);
    const decision = await waiting;
    assert.equal(decision.json.behavior, 'deny');
    assert.equal(decision.json.status, 'DENIED');
    const row = await approvalRow(approvalId);
    assert.equal(row.decidedCredentialKind, 'FEISHU');
    assert.equal(row.decidedFeishuOpenId, ALICE);
    assert.equal(row.decidedFeishuMessageId, messageId);
  });

  // ── the write trap, for what a refused click may write: the inbox's own record of it, and nothing else ───────────
  await sql.query(WRITE_TRAP);
  const mark = async (): Promise<bigint> =>
    BigInt((await sql.query<{ seq: string }>(`SELECT coalesce(max("seq"), 0)::text AS "seq" FROM "tenant_census_write"`)).rows[0].seq);
  const appRow = async (): Promise<Row> => (await sql.query(`SELECT to_jsonb(a) AS r FROM feishu_app a WHERE app_id = $1`, [X.appId])).rows[0].r;
  /** Every row written since `since` beyond the inbox's record of `eventId`, the app's last_event_at, and heartbeats. */
  const strayWrites = async (since: bigint, eventId: string, app: Row): Promise<string[]> => {
    const rows = (await sql.query<{ tbl: string; op: string; row: Row }>(
      `SELECT "tbl", "op", "row" FROM "tenant_census_write" WHERE "seq" > $1 ORDER BY "seq"`, [since.toString()],
    )).rows;
    return rows.filter(({ tbl, op, row }) => {
      if (tbl === 'feishu_inbound_event' && (op === 'INSERT' || op === 'UPDATE') && row.event_id === eventId) return false;
      if (tbl === 'feishu_app' && op === 'UPDATE' && JSON.stringify(without(row, 'last_event_at')) === JSON.stringify(without(app, 'last_event_at'))) return false;
      if (tbl === 'feishu_link' && op === 'UPDATE') return false; // the connection's heartbeat, on its own clock
      return true;
    }).map(({ tbl, op, row }) => `${op} ${tbl} ${JSON.stringify(row).slice(0, 300)}`);
  };
  /** One click that must be refused: its answer, and what it wrote beyond its own record. */
  async function refusedClick(messageId: string, value: Json) {
    const app = await appRow();
    const before = await mark();
    const c = await click(messageId, value);
    await until(`${c.eventId} processed`, async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL`, [X.appId, c.eventId])).rowCount);
    await sleep(300);
    return { ...c, stray: await strayWrites(before, c.eventId, app) };
  }

  await t.test('(4) a click carrying "always allow" is refused and writes nothing', async () => {
    const s = await session('Install a package');
    const { approvalId, messageId, card } = await ask(s);
    const allow = callbacks(card)[0]!;
    for (const value of [
      { ...allow, rememberRules: [{ toolName: 'Bash' }] },
      { ...allow, rememberRules: [] },
      { ...allow, remember: true },
    ]) {
      const c = await refusedClick(messageId, value);
      assert.deepEqual(c.answer, { toast: { type: 'error', content: '"Always allow" is not available in Feishu. Open it in Orbit to choose it.' } });
      assert.deepEqual(c.stray, [], JSON.stringify(value));
    }
    const row = await approvalRow(approvalId);
    assert.equal(row.status, 'PENDING');
    assert.equal(row.decidedCredentialKind, null);
    assert.equal(await db.workspacePermissionRule.count({ where: { workspaceId } }), 0, 'no standing grant');
    // The plain Allow once still works on the same card afterwards.
    const ok = await click(messageId, allow);
    assert.deepEqual(ok.answer.toast, { type: 'success', content: 'Allowed.' });
    assert.equal((await approvalRow(approvalId)).rememberRule, null);
    assert.equal(await db.workspacePermissionRule.count({ where: { workspaceId } }), 0);
  });

  await t.test('(5) the same click handled a second time decides nothing more', async () => {
    const { eventId, approvalId } = events.allowed as { eventId: string; approvalId: string };
    const first = await approvalRow(approvalId);
    const app = await appRow();
    const before = await mark();
    await sql.query(`UPDATE feishu_inbound_event SET processed_at = NULL, attempts = 1, lease_until = NULL WHERE app_id = $1 AND event_id = $2`, [X.appId, eventId]);
    await until('handled again', async () =>
      (await sql.query(`SELECT 1 FROM feishu_inbound_event WHERE app_id = $1 AND event_id = $2 AND processed_at IS NOT NULL AND attempts = 2`, [X.appId, eventId])).rowCount);
    await sleep(300);
    const again = await approvalRow(approvalId);
    assert.equal(again.status, 'ALLOWED');
    assert.equal(again.decidedAt?.getTime(), first.decidedAt?.getTime(), 'one decision: its time is the first one\'s');
    assert.deepEqual(
      (await strayWrites(before, eventId, app)).filter((w) => !w.includes('UPDATE feishu_inbound_event')),
      [],
      'nothing written beyond the inbox row the spec reset',
    );
  });

  await t.test('(6) a stale card is answered "Already answered in Orbit." and drawn as its outcome', async () => {
    // Answered elsewhere: written straight to the row, so no reconcile closes the card before the click.
    const s = await session('Answered elsewhere');
    const answered = await ask(s);
    await db.approval.update({ where: { id: answered.approvalId }, data: { status: 'DENIED', decidedAt: new Date(), decidedById: ownerId } });
    const c = await click(answered.messageId, callbacks(answered.card)[0]!);
    assert.deepEqual(c.answer.toast, { type: 'info', content: STALE });
    assert.deepEqual(callbacks(c.answer.card.data), []);
    assert.match(allText(c.answer.card.data), /Denied in Orbit/);
    const row = await approvalRow(answered.approvalId);
    assert.equal(row.status, 'DENIED', 'left as it was');
    assert.equal(row.decidedCredentialKind, null);
    assert.equal((await db.feishuMessage.findFirstOrThrow({ where: { messageId: answered.messageId } })).status, 'CLOSED');

    // The session no longer running: nothing waits on the card's answer any more.
    const ended = await session('Ended');
    const gone = await ask(ended);
    await db.session.update({ where: { id: ended }, data: { status: RunStatus.SUCCEEDED, engineTurnActive: false } });
    const g = await click(gone.messageId, callbacks(gone.card)[0]!);
    assert.deepEqual(g.answer.toast, { type: 'info', content: STALE });
    assert.match(allText(g.answer.card.data), /No longer waiting in Orbit/);
    assert.equal((await approvalRow(gone.approvalId)).status, 'PENDING', 'no decision was written');

    // An approval of no account's, or another account's, is answered the same.
    const n = await refusedClick(answered.messageId, { action: 'approval.allow', approvalId: randomUUID() });
    assert.deepEqual(n.answer.toast, { type: 'info', content: STALE });
    assert.deepEqual(n.stray, []);
  });

  await t.test('(7) approvals in Feishu off, and Orbit\'s own cards: no buttons, and a click is refused', async () => {
    const s = await session('Orchestrate');
    const live = await ask(s);
    await db.feishuApp.update({ where: { appId: X.appId }, data: { approvalsInFeishu: false } });
    const off = await refusedClick(live.messageId, callbacks(live.card)[0]!);
    assert.deepEqual(off.answer, { toast: { type: 'info', content: 'Answering approvals in Feishu is turned off. Open it in Orbit to answer.' } });
    assert.deepEqual(off.stray, []);
    assert.equal((await approvalRow(live.approvalId)).status, 'PENDING');
    await db.approval.update({ where: { id: live.approvalId }, data: { status: 'DENIED', decidedAt: new Date() } });
    // A card drawn while it is off has no Allow or Deny.
    const s2 = await session('Off');
    const drawnOff = await ask(s2);
    assert.deepEqual(callbacks(drawnOff.card), [], 'no Allow once or Deny while approvalsInFeishu is off');
    await db.feishuApp.update({ where: { appId: X.appId }, data: { approvalsInFeishu: true } });
    await db.approval.update({ where: { id: drawnOff.approvalId }, data: { status: 'DENIED', decidedAt: new Date() } });

    // Orbit's own confirmation card: a click naming it (no such button is drawn) is refused, and writes nothing.
    const s3 = await session('Create a task');
    const orbitCard = await db.approval.create({ data: { sessionId: s3, toolName: 'orbit_task_create', input: { title: 'x' }, toolUseId: `tu-${randomUUID()}` } });
    const r = await refusedClick(live.messageId, { action: 'approval.allow', approvalId: orbitCard.id });
    assert.deepEqual(r.answer, { toast: { type: 'info', content: 'Answer this in Orbit.' } });
    assert.deepEqual(r.stray, []);
    assert.equal((await approvalRow(orbitCard.id)).status, 'PENDING');
  });

  await t.test('(8) an answer later than the budget: "Working…", then the card once through the update token', async () => {
    const prisma = db as unknown as PrismaService;
    const router = new FeishuRouter(prisma, {} as FeishuOwnerService, {} as FeishuChatRouteService);
    const transport = new FeishuTransport(prisma, new FeishuAppService(prisma), new FeishuOutbound());
    const actions = new FeishuCardActions(prisma, router, {} as SessionsService, transport, new FeishuOutbound());
    const lateCard = { schema: '2.0', header: { title: { tag: 'plain_text', content: 'late' } } };
    const late: Array<{ event: InboundEvent; answer: unknown }> = [];
    router.useCardActions({
      answer: async () => {
        await sleep(400);
        return { toast: { type: 'success', content: 'Allowed.' }, card: { type: 'raw', data: lateCard } };
      },
      deliverLate: async (event, answer, clickedAt) => {
        late.push({ event, answer });
        await actions.deliverLate(event, answer, clickedAt);
      },
    });
    const inbox = new FeishuInboxService(prisma, router);
    inbox.cardAnswerBudgetMs = 50;
    const token = fake.cardToken();
    const envelope = {
      schema: '2.0',
      header: { event_id: `ev-card-late-${RUN}`, event_type: 'card.action.trigger', app_id: X.appId, create_time: String(Date.now()), token: '' },
      event: { operator: { open_id: ALICE }, token, action: { tag: 'button', value: { action: 'approval.allow', approvalId: randomUUID() } }, context: { open_message_id: 'om_late' } },
    };
    const updatesBefore = fake.cardUpdates.length;
    assert.deepEqual(await inbox.record(X.appId, envelope), CARD_WORKING);
    assert.deepEqual(CARD_WORKING, { toast: { type: 'info', content: 'Working…' } });
    await until('the late card', () => fake.cardUpdates.length > updatesBefore);
    await sleep(200);
    const updates = fake.cardUpdates.slice(updatesBefore);
    assert.equal(updates.length, 1, 'the token is used once');
    assert.deepEqual(updates[0]!.body, { token, card: lateCard });
    assert.equal(late.length, 1);
    // An answer within the budget is the answer itself, and no update follows.
    inbox.cardAnswerBudgetMs = 5_000;
    const quick = { ...envelope, header: { ...envelope.header, event_id: `ev-card-quick-${RUN}` }, event: { ...envelope.event, token: fake.cardToken() } };
    assert.deepEqual(await inbox.record(X.appId, quick), { toast: { type: 'success', content: 'Allowed.' }, card: { type: 'raw', data: lateCard } });
    await sleep(200);
    assert.equal(fake.cardUpdates.length, updatesBefore + 1, 'no update for an answer given in time');
  });
});
