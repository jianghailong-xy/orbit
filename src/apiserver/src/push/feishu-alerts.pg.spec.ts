/**
 * Approval alerts in the owner's Feishu direct messages (docs/feishu-bot-design.md §6.1, §6.2; task F1-4; migration
 * 0495), against a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty and the fake open platform
 * (feishu/test-support/fake-open-platform.ts). Every apiserver here is a process of its own
 * (push/test-support/feishu-alert-worker.ts): PushService with the real FeishuTransport over its own connection pool. No
 * device is registered and neither APNs nor FCM is configured, so Feishu is the only channel. What it is held to:
 *
 *   (1) 0495 made feishu_message as it says — keys and indexes — and wrote no row;
 *   (2) three approvals of one turn, announced through two processes at the same moment: the fake open platform gets
 *       one send, to the owner's open_id, and that card lists all three, each with its own Allow once; one
 *       feishu_message row, SENT, with Feishu's message_id; five times over, each a session of its own;
 *   (3) an approval that arrives while the stretch is still pending updates that card in place (one PATCH listing four),
 *       through the other process, and sends nothing;
 *   (4) the next stretch, after the owner answered, is a card of its own;
 *   (5) a card re-sent after its answer was lost (the row taken over with no message_id) carries the same `uuid`, so
 *       Feishu delivers it once (project instruction 15).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/push/feishu-alerts.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ConfigService } from '@nestjs/config';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { FeishuAppService } from '../feishu/feishu-app.service';
import { FEISHU_TEST_OPEN_PLATFORM_ENV } from '../feishu/feishu-open-platform';
import { FeishuOutbound } from '../feishu/feishu-outbound';
import { FakeOpenPlatform, type FakeRequest } from '../feishu/test-support/fake-open-platform';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { encryptSecret } from '../providers/provider-crypto';
import { FeishuTransport } from './feishu-transport';
import { PushService } from './push.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const SECRET_KEY = `feishu-alerts-${randomUUID()}`;
process.env.PROVIDER_SECRET_KEY = SECRET_KEY;
const RUN = randomBytes(4).toString('hex');
const APP = { platform: 'FEISHU' as const, appId: `cli_${randomBytes(8).toString('hex')}`, appSecret: `secret-${randomUUID()}` };
const OWNER_OPEN_ID = 'ou_the_owner';

/** One apiserver process: `go` announces approvals and resolves when it has. */
class Worker {
  private readonly lines: string[] = [];
  private waiters: (() => void)[] = [];
  private constructor(readonly child: ChildProcessWithoutNullStreams, readonly stderr: string[]) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.lines.push(line);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static async start(env: Record<string, string>): Promise<Worker> {
    const child = spawn(process.execPath, [path.join(__dirname, 'test-support/feishu-alert-worker.js')], {
      env: { ...process.env, ...env },
    });
    const stderr: string[] = [];
    child.stderr.on('data', (d) => stderr.push(String(d)));
    const worker = new Worker(child, stderr);
    await worker.next('ready');
    return worker;
  }

  private async next(word: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const at = this.lines.indexOf(word);
      if (at >= 0) {
        this.lines.splice(at, 1);
        return;
      }
      if (this.child.exitCode !== null || Date.now() > deadline) {
        assert.fail(`worker did not say ${word}: ${this.stderr.join('')}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  }

  go(sessionId: string, approvalIds: string[]): Promise<void> {
    this.child.stdin.write(`go ${sessionId} ${approvalIds.join(',')}\n`);
    return this.next('done');
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.child.stdin.write('exit\n');
    await Promise.race([new Promise((resolve) => this.child.once('exit', resolve)), sleep(5_000)]);
    this.child.kill();
  }
}

test('one stretch of approvals is one Feishu card, between two apiserver processes', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const fake = new FakeOpenPlatform();
  fake.addApp(APP);
  const fakeUrl = await fake.start();
  const env = { COORDINATOR_PG_URL: url, PROVIDER_SECRET_KEY: SECRET_KEY, [FEISHU_TEST_OPEN_PLATFORM_ENV]: fakeUrl };
  const workers: Worker[] = [];
  t.after(async () => {
    await Promise.all(workers.map((w) => w.stop()));
    await fake.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the account: its own app with its owner bound, no device, and the machine its sessions run on ──────────────────
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `owner-${RUN}@feishu-alerts.invalid`, name: 'The owner', passwordHash: 'x' } });
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

  const session = async (title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: 'the work',
        provider: 'claude', status: RunStatus.RUNNING, engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER,
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
  const patches = (messageId: string) => fake.messages.filter((m: FakeRequest) => m.method === 'PATCH' && m.path === `/open-apis/im/v1/messages/${messageId}`);
  const cardOf = (m: FakeRequest) => (m.body as { content: string }).content;
  const rows = (sessionId: string) => db.feishuMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });

  workers.push(await Worker.start(env), await Worker.start(env));
  const [one, two] = workers;

  await t.test('(1) 0495 made feishu_message, keyed as it says, and wrote no row', async () => {
    const applied = await sql.query(`SELECT finished_at IS NOT NULL AS done FROM _prisma_migrations WHERE migration_name = '0495_feishu_message'`);
    assert.deepEqual(applied.rows, [{ done: true }]);
    const indexes = (await sql.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'feishu_message' ORDER BY indexname`)).rows.map((r) => r.indexname);
    assert.deepEqual(indexes, [
      'feishu_message_app_id_collapse_key_key',
      'feishu_message_message_id_key',
      'feishu_message_open_item_id_idx',
      'feishu_message_owner_id_idx',
      'feishu_message_pkey',
      'feishu_message_session_id_idx',
    ]);
    assert.equal(await db.feishuMessage.count({ where: { ownerId } }), 0);
  });

  let kept: { sessionId: string; approvals: string[]; messageId: string } | undefined;

  await t.test('(2) three approvals of one turn through two processes at once: one card, listing all three', async () => {
    for (let round = 0; round < 5; round++) {
      const s = await session(`parallel tool calls ${round}`);
      const approvals = await Promise.all(['Bash', 'Write', 'Edit'].map((tool) => ask(s, tool)));
      const before = sends().length;
      // The runner's three calls, spread over the two apiservers as the link gateway spreads them.
      await Promise.all([one.go(s, [approvals[0]!, approvals[2]!]), two.go(s, [approvals[1]!])]);

      const sent = sends().slice(before);
      assert.equal(sent.length, 1, `round ${round}: one send between both processes`);
      assert.equal(sent[0]!.query.get('receive_id_type'), 'open_id');
      assert.equal((sent[0]!.body as { receive_id: string }).receive_id, OWNER_OPEN_ID, 'to the owner');
      const card = cardOf(sent[0]!);
      for (const id of approvals) assert.ok(card.includes(id), `round ${round}: the card lists approval ${id}`);
      assert.equal((card.match(/approval\.allow/g) ?? []).length, 3, 'each its own Allow once');
      assert.match(card, /3 approvals need your reply/);

      const [row, ...more] = await rows(s);
      assert.equal(more.length, 0, 'one row');
      assert.equal(row!.kind, 'approval');
      assert.equal(row!.status, 'SENT');
      assert.equal(row!.receiveId, OWNER_OPEN_ID);
      assert.ok(row!.messageId?.startsWith('om_fake_'));
      assert.ok(row!.sentAt);
      assert.equal(row!.leaseToken, null, 'let go');
      assert.equal(row!.renderedRevision, row!.revision, 'nothing announced is left undrawn');
      assert.ok(approvals.includes(row!.approvalId!), 'keyed on the approval that opened the stretch');
      // Whichever announcements came after the send updated the card to what it already showed, if at all.
      for (const patch of patches(row!.messageId!)) for (const id of approvals) assert.ok(cardOf(patch).includes(id));
      kept = { sessionId: s, approvals, messageId: row!.messageId! };
    }
  });

  await t.test('(3) one more approval while the stretch is pending updates that card, and sends nothing', async () => {
    const { sessionId, approvals, messageId } = kept!;
    const before = sends().length;
    const patchesBefore = patches(messageId).length;
    const late = await ask(sessionId, 'Read');
    await two.go(sessionId, [late]);
    assert.equal(sends().length, before, 'no second card');
    const updated = patches(messageId).slice(patchesBefore);
    assert.equal(updated.length, 1, 'one update');
    const card = cardOf(updated[0]!);
    for (const id of [...approvals, late]) assert.ok(card.includes(id));
    assert.match(card, /4 approvals need your reply/);
    assert.equal((await rows(sessionId)).length, 1);
  });

  await t.test('(4) the next stretch, after the owner answered, is a card of its own', async () => {
    const { sessionId } = kept!;
    await sql.query(`UPDATE "approval" SET "status" = 'ALLOWED', "decided_at" = now() WHERE "session_id" = $1::uuid AND "status" = 'PENDING'`, [sessionId]);
    await sleep(20);
    const before = sends().length;
    const next = await ask(sessionId, 'Bash');
    await one.go(sessionId, [next]);
    const sent = sends().slice(before);
    assert.equal(sent.length, 1);
    assert.ok(cardOf(sent[0]!).includes(next));
    assert.equal((await rows(sessionId)).length, 2);
  });

  await t.test('(5) a card re-sent after its answer was lost carries the same uuid: Feishu delivers it once', async () => {
    const s = await session('a lost answer');
    const id = await ask(s, 'Bash');
    // In this process: the sender, with Feishu's answer to the first send lost on the way back.
    process.env[FEISHU_TEST_OPEN_PLATFORM_ENV] = fakeUrl;
    const local = prismaClientFor(url) as unknown as PrismaService;
    t.after(() => (local as unknown as PrismaClient).$disconnect());
    const outbound = new FeishuOutbound();
    const transport = new FeishuTransport(local, new FeishuAppService(local), outbound);
    const push = new PushService(local, { get: () => undefined } as unknown as ConfigService, transport);
    const send = outbound.send.bind(outbound);
    let lose = true;
    outbound.send = async (...args) => {
      const result = await send(...args);
      if (!lose) return result;
      lose = false;
      return { ok: false, status: null, feishuCode: null, feishuMsg: 'ETIMEDOUT' };
    };
    transport.wait = async () => undefined;
    const before = fake.messages.length;
    const requestsBefore = fake.requestsTo('/open-apis/im/v1/messages').length;
    await push.notifyApprovalRequest(s, id, 'Bash');
    const tried = fake.requestsTo('/open-apis/im/v1/messages').slice(requestsBefore);
    assert.equal(tried.length, 2, 'sent, its answer lost, sent again');
    const uuids = tried.map((r) => (r.body as { uuid?: string }).uuid);
    assert.ok(uuids[0] && uuids[0].length <= 50);
    assert.equal(uuids[0], uuids[1], 'one de-duplication key');
    assert.equal(fake.messages.length - before, 1, 'one message delivered');
    const [row] = await rows(s);
    assert.equal(row!.status, 'SENT');
    assert.equal(row!.attempts, 2);
  });
});
