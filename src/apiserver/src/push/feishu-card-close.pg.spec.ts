/**
 * A Feishu card whose matter was settled elsewhere is drawn in place as its outcome, with no buttons
 * (docs/feishu-bot-design.md §6.2; task F1-5), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from
 * empty and the fake open platform (feishu/test-support/fake-open-platform.ts). One apiserver in this process: PushService
 * with the real FeishuTransport, RealtimeService (its listener not started) and SessionsService with the web app's
 * SessionsController in front, as the route builds them. No device is registered and neither APNs nor FCM is
 * configured, so Feishu is the only channel — and the badge reconcile still runs. What it is held to:
 *
 *   (1) an approval answered through the web app's decision route: its card's row becomes CLOSED, the fake open platform
 *       gets one PATCH of that message, and the card it carries has no button, form or callback and says
 *       `Allowed in Orbit · hh:mm UTC`;
 *   (2) one of two approvals of a stretch answered: the card is drawn again listing the one still pending, with its
 *       buttons, and stays SENT; the second answered (Deny) closes it;
 *   (3) an owner item resolved (the coordinator question answered, then the coordinator conversation running again):
 *       its card becomes `Answered in Orbit · …`, with no buttons, and CLOSED;
 *   (4) a session that left needs-you with its approval still pending (the runner reported it parked): its card says
 *       `No longer waiting in Orbit`, and CLOSED;
 *   (5) a card sent more than 14 days ago is not touched: no PATCH, still SENT, though its approval was answered.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/push/feishu-card-close.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ConfigService } from '@nestjs/config';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { Client } from 'pg';

import type { AuthUser } from '../common/current-user.decorator';
import { FeishuAppService } from '../feishu/feishu-app.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from '../feishu/feishu-open-platform';
import { FeishuOutbound } from '../feishu/feishu-outbound';
import { FakeOpenPlatform, type FakeRequest } from '../feishu/test-support/fake-open-platform';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import type { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsController } from '../sessions/sessions.controller';
import { SessionsService } from '../sessions/sessions.service';
import { FeishuTransport } from './feishu-transport';
import { PushService } from './push.service';

const URL_ = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY = `feishu-card-close-${randomUUID()}`;
const RUN = randomBytes(4).toString('hex');
const APP = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}` };
const OWNER_OPEN_ID = 'ou_the_owner';

test('a card whose matter was settled elsewhere is drawn as its outcome, without buttons', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const fake = new FakeOpenPlatform();
  fake.addApp(APP);
  process.env[FEISHU_TEST_OPEN_PLATFORM_ENV] = await fake.start();
  t.after(async () => {
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const transport = new FeishuTransport(prisma, new FeishuAppService(prisma), new FeishuOutbound());
  transport.wait = async () => undefined;
  const push = new PushService(prisma, { get: () => undefined } as unknown as ConfigService, transport);
  const realtime = new RealtimeService(prisma, push);
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, realtime);
  // The web app's route, in front of the service as Nest builds it; the decision door reads nothing else.
  const web = new SessionsController(sessions, prisma, realtime, undefined as never, undefined as never, undefined as never);

  // ── the account: its own app with its owner bound, no device, and the machine its sessions run on ──────────────────
  const ownerId = randomUUID();
  const owner = { userId: ownerId } as AuthUser;
  await db.user.create({ data: { id: ownerId, email: `owner-${RUN}@feishu-card-close.invalid`, name: 'The owner', passwordHash: 'x' } });
  await db.feishuApp.create({
    data: { ownerId, platform: APP.platform, appId: APP.appId, appSecretEnc: encryptSecret(APP.appSecret), ownerOpenId: OWNER_OPEN_ID },
  });
  const runnerId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `runner-${RUN}`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `workspace-${RUN}`, enabled: true } });
  assert.equal(await db.deviceToken.count({ where: { userId: ownerId } }), 0, 'no device: Feishu is the only target');

  const session = async (title: string, status: RunStatus = RunStatus.RUNNING) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'the work',
        provider: 'claude', status, engineTurnActive: status === RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(), runtimeSessionId: randomUUID(),
      },
    });
    return id;
  };
  const ask = async (sessionId: string, tool: string) =>
    (await db.approval.create({
      data: { sessionId, toolName: tool, input: { command: `${tool} ${randomUUID()}` }, toolUseId: `tu-${randomUUID()}` },
      select: { id: true },
    })).id;
  const sends = () => fake.messages.filter((m: FakeRequest) => m.method === 'POST' && m.path === '/open-apis/im/v1/messages');
  const patches = (messageId: string) =>
    fake.messages.filter((m: FakeRequest) => m.method === 'PATCH' && m.path === `/open-apis/im/v1/messages/${messageId}`);
  const cardOf = (m: FakeRequest) => (m.body as { content: string }).content;
  const rowOf = (where: { sessionId?: string; openItemId?: string }) => db.feishuMessage.findFirstOrThrow({ where, orderBy: { createdAt: 'desc' } });
  /** No button, no form, nothing that calls back: what is left is the outcome and a link. */
  const assertNoButtons = (card: string) => {
    const parsed = JSON.parse(card) as unknown;
    const tags: string[] = [];
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const tag = (v as { tag?: unknown }).tag;
        if (typeof tag === 'string') tags.push(tag);
        Object.values(v).forEach(walk);
      }
    };
    walk(parsed);
    for (const tag of ['button', 'form', 'select_static', 'multi_select_static', 'input']) {
      assert.ok(!tags.includes(tag), `no ${tag} on the card: ${card}`);
    }
    assert.ok(!card.includes('"callback"'), 'nothing calls back');
    assert.ok(!card.includes('approval.allow') && !card.includes('approval.deny'));
  };
  /** The debounced reconcile ran, and every card it started is sent, updated or given up on. */
  const reconciled = async () => {
    await sleep(600);
    await push.feishuIdle();
  };
  /** A card sent through PushService's own approval alert. */
  const approvalCard = async (sessionId: string, approvalIds: string[]) => {
    for (const id of approvalIds) await push.notifyApprovalRequest(sessionId, id, 'Bash');
    await push.feishuIdle();
    const row = await rowOf({ sessionId });
    assert.equal(row.status, 'SENT');
    assert.ok(row.messageId);
    return row;
  };

  await t.test('(0) 0498 lets a card be CLOSED, and nothing else new', async () => {
    const applied = await sql.query(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0498_feishu_message_closed'`);
    assert.deepEqual(applied.rows, [{ done: true }]);
    const chk = await sql.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'feishu_message_status_chk'`);
    assert.equal(chk.rows.length, 1);
    for (const status of ['PENDING', 'SENT', 'FAILED', 'CLOSED']) assert.ok(chk.rows[0].def.includes(`'${status}'`), status);
  });

  await t.test('(1) an approval answered through the web route: its card is closed in place, without buttons', async () => {
    const s = await session('a web answer');
    const id = await ask(s, 'Bash');
    const sentBefore = sends().length;
    const row = await approvalCard(s, [id]);
    assert.equal(sends().length - sentBefore, 1, 'the alert was one card');
    assert.equal(patches(row.messageId!).length, 0);

    await web.decideApproval(owner, s, id, { behavior: 'allow' } as never);
    await reconciled();

    const updated = patches(row.messageId!);
    assert.equal(updated.length, 1, 'one PATCH of that card');
    const card = cardOf(updated[0]!);
    assertNoButtons(card);
    assert.match(card, /Allowed in Orbit · \d\d:\d\d UTC/);
    assert.match(card, /a web answer/, 'still the card it was: its session');
    const after = await rowOf({ sessionId: s });
    assert.equal(after.id, row.id);
    assert.equal(after.status, 'CLOSED');
    assert.equal(after.leaseToken, null, 'let go');
    assert.equal(sends().length - sentBefore, 1, 'nothing new sent');

    // Another reconcile finds nothing to do: the card is closed once.
    push.scheduleBadgeSync(ownerId);
    await reconciled();
    assert.equal(patches(row.messageId!).length, 1);
  });

  await t.test('(2) one of two answered: drawn again with the other; the second answered closes it', async () => {
    const s = await session('two at once');
    const first = await ask(s, 'Bash');
    const second = await ask(s, 'Write');
    const row = await approvalCard(s, [first, second]);
    const before = patches(row.messageId!).length;

    await web.decideApproval(owner, s, first, { behavior: 'allow' } as never);
    await reconciled();
    const redrawn = patches(row.messageId!).slice(before);
    assert.equal(redrawn.length, 1, 'drawn again');
    const live = cardOf(redrawn[0]!);
    assert.ok(!live.includes(first), 'without the answered one');
    assert.ok(live.includes(second));
    assert.equal((live.match(/approval\.allow/g) ?? []).length, 1, 'the one still pending keeps its buttons');
    assert.equal((await rowOf({ sessionId: s })).status, 'SENT');

    await web.decideApproval(owner, s, second, { behavior: 'deny' } as never);
    await reconciled();
    const closing = patches(row.messageId!).slice(before + 1);
    assert.equal(closing.length, 1);
    assertNoButtons(cardOf(closing[0]!));
    assert.match(cardOf(closing[0]!), /Denied in Orbit · \d\d:\d\d UTC/);
    assert.equal((await rowOf({ sessionId: s })).status, 'CLOSED');
  });

  await t.test('(3) an owner item resolved: its card says so, without buttons', async () => {
    const coordinator = await session(`coordinate ${RUN}`, RunStatus.AWAITING_INPUT);
    const projectId = randomUUID();
    await db.project.create({
      data: { id: projectId, ownerId, title: `project ${RUN}`, coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId: coordinator },
    });
    await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    const itemId = randomUUID();
    await db.projectOpenItem.create({
      data: {
        id: itemId, projectId, ownerId, kind: 'COORDINATOR_QUESTION', state: 'OPEN', assignee: 'OWNER', assigneeReason: 'DEFAULT',
        dedupeKey: `feishu-card-close-${itemId}`, title: 'Coordinator asks: Take the slower fix?',
        payload: { question: 'Take the slower fix?', options: [], blocksTaskIds: [], ifUnanswered: null },
        waitingSince: new Date(), assignedAt: new Date(),
      },
    });
    assert.ok((await push.needsYouSessions(ownerId)).includes(coordinator), 'the item puts its conversation in needs-you');
    await push.notifyOwnerItem(itemId);
    await push.feishuIdle();
    const row = await rowOf({ openItemId: itemId });
    assert.equal(row.kind, 'owner-item');
    assert.equal(row.status, 'SENT');

    // A reconcile while the item is open leaves its card alone.
    push.scheduleBadgeSync(ownerId);
    await reconciled();
    assert.equal(patches(row.messageId!).length, 0);

    // The owner answers (ProjectOpenItemService.answerOpenItem's write), and the answer delivered runs the coordinator
    // conversation again: the runner's STATUS is the badge event that reconciles.
    await db.projectOpenItem.update({
      where: { id: itemId },
      data: { state: 'RESOLVED', resolution: 'ANSWERED', resolvedAt: new Date(), resolvedBy: 'USER', resolvedByUserId: ownerId, answer: { option: 0 } },
    });
    await db.session.update({ where: { id: coordinator }, data: { status: RunStatus.RUNNING } });
    realtime.publish(coordinator, { seq: 0, type: RunEventType.STATUS, payload: { status: RunStatus.RUNNING }, ts: new Date().toISOString() });
    await reconciled();

    const updated = patches(row.messageId!);
    assert.equal(updated.length, 1);
    assertNoButtons(cardOf(updated[0]!));
    assert.match(cardOf(updated[0]!), /Answered in Orbit · \d\d:\d\d UTC/);
    assert.equal((await rowOf({ openItemId: itemId })).status, 'CLOSED');
  });

  await t.test('(4) a session that left needs-you with its approval pending: no longer waiting, without buttons', async () => {
    const s = await session('parked with a card');
    const id = await ask(s, 'Bash');
    const row = await approvalCard(s, [id]);

    // The runner reports the session parked: it is not RUNNING, so nothing on it is waiting on the owner.
    await db.session.update({ where: { id: s }, data: { status: RunStatus.AWAITING_INPUT, engineTurnActive: false } });
    realtime.publish(s, { seq: 0, type: RunEventType.STATUS, payload: { status: RunStatus.AWAITING_INPUT }, ts: new Date().toISOString() });
    await reconciled();

    const updated = patches(row.messageId!);
    assert.equal(updated.length, 1);
    assertNoButtons(cardOf(updated[0]!));
    assert.match(cardOf(updated[0]!), /No longer waiting in Orbit · \d\d:\d\d UTC/);
    assert.equal((await rowOf({ sessionId: s })).status, 'CLOSED');
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id } })).status, 'PENDING', 'the approval itself is not touched');
  });

  await t.test('(5) a card sent more than 14 days ago is left as it is', async () => {
    const s = await session('an old card');
    const id = await ask(s, 'Bash');
    const row = await approvalCard(s, [id]);
    await sql.query(`UPDATE "feishu_message" SET "sent_at" = now() - interval '15 days' WHERE "id" = $1::uuid`, [row.id]);

    await web.decideApproval(owner, s, id, { behavior: 'allow' } as never);
    await reconciled();
    assert.equal(patches(row.messageId!).length, 0, 'Feishu would refuse it: not asked');
    assert.equal((await rowOf({ sessionId: s })).status, 'SENT');

    // The same card a day younger than the limit is closed.
    await sql.query(`UPDATE "feishu_message" SET "sent_at" = now() - interval '13 days' WHERE "id" = $1::uuid`, [row.id]);
    push.scheduleBadgeSync(ownerId);
    await reconciled();
    assert.equal(patches(row.messageId!).length, 1);
    assert.equal((await rowOf({ sessionId: s })).status, 'CLOSED');
  });
});
