import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { chargeOpenRequest, hasPendingWakeSource } from './session-request';
import { SessionRequestWorker } from './session-request.worker';

const url = process.env.COORDINATOR_PG_URL;

test('R4 migration, R10/M6 once-only ring across passes and replicas, R11 close, R12 MESSAGE isolation', { skip: !url }, async () => {
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  const secondDb = prismaClientFor(url);
  const ownerId = randomUUID();
  const now = new Date();
  try {
    const migration = await sql.query(`SELECT migration_name FROM _prisma_migrations WHERE migration_name = '0505_run_item_requests' AND finished_at IS NOT NULL`);
    assert.equal(migration.rowCount, 1, 'the R4 migration was applied by the spec harness');
    const constraints = await sql.query(`
      SELECT conname, convalidated FROM pg_constraint
      WHERE (conrelid = 'session_request'::regclass AND conname IN ('session_request_kind_chk', 'session_request_state_chk'))
         OR (conrelid = 'approval'::regclass AND conname = 'approval_decided_via_chk')
      ORDER BY conname
    `);
    assert.deepEqual(constraints.rows, [
      { conname: 'approval_decided_via_chk', convalidated: true },
      { conname: 'session_request_kind_chk', convalidated: true },
      { conname: 'session_request_state_chk', convalidated: true },
    ], 'all three CHECKs are present and validated after migration');
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@fallback.invalid`, name: 'Fallback', passwordHash: 'x' } });
    const from = await db.session.create({ data: { ownerId, creatorId: ownerId, title: 'Run', prompt: 'Run', provider: 'codex', status: 'RUNNING' } });
    const to = await db.session.create({ data: { ownerId, creatorId: ownerId, title: 'Coordinator', prompt: 'Coordinate', provider: 'codex', status: 'AWAITING_INPUT' } });
    async function approval(status = 'PENDING', decidedById: string | null = null) {
      return db.approval.create({ data: { sessionId: from.id, toolName: 'AskUserQuestion', input: {}, status, decidedById } });
    }
    async function request(kind: string, state = 'OPEN', approvalId: string | null = null) {
      return db.sessionRequest.create({ data: {
        ownerId, fromSessionId: from.id, toSessionId: to.id, turnId: randomUUID(), clientTurnId: randomUUID(),
        requestPreview: 'Please decide', kind, state, approvalId,
        replyBy: new Date(now.getTime() + 60_000), closedAt: state === 'OPEN' ? null : now,
      } });
    }
    // New terminal values cannot leak into MESSAGE or the other run kind.
    await assert.rejects(request('MESSAGE', 'READ'), /session_request_state_chk/);
    await assert.rejects(request('MESSAGE', 'OWNER_ANSWERED'), /session_request_state_chk/);
    await assert.rejects(request('RUN_NOTIFY', 'OWNER_ANSWERED'), /session_request_state_chk/);
    await assert.rejects(request('RUN_QUESTION', 'READ'), /session_request_state_chk/);
    const read = await request('RUN_NOTIFY', 'READ');
    for (let i = 0; i < 30; i++) await request('RUN_NOTIFY', 'READ');
    const answered = await request('RUN_QUESTION', 'OWNER_ANSWERED', (await approval('ALLOWED', ownerId)).id);
    const pending = await approval();
    const question = await request('RUN_QUESTION', 'OPEN', pending.id);
    await db.sessionRequest.update({ where: { id: question.id }, data: { replyBy: now } });
    await assert.rejects(request('RUN_QUESTION', 'OPEN', pending.id), /session_request_approval_key/);
    await db.approval.update({ where: { id: pending.id }, data: { decidedCredentialKind: 'COORDINATOR' } });
    const notice = await request('RUN_NOTIFY', 'UNDELIVERED');
    const open = await request('RUN_NOTIFY');
    const replied = await request('RUN_NOTIFY');
    await db.sessionRequest.update({ where: { id: replied.id }, data: { state: 'REPLIED', replyText: 'Received', closedAt: now } });

    const pushes: unknown[][] = [];
    const frames: unknown[][] = [];
    const handoffs: string[] = [];
    const push = {
      notifyApprovalRequest: async (...args: unknown[]) => { pushes.push(args); },
      notifyAgentMessage: async (...args: unknown[]) => { pushes.push(args); },
    };
    const realtime = { publish: (...args: unknown[]) => { frames.push(args); } };
    const requests = { handOff: async (id: string) => { handoffs.push(id); return 'ALREADY'; } };
    function worker(client = db) {
      return new SessionRequestWorker(client as unknown as PrismaService, requests as never, {}, push as never, realtime as never);
    }
    const pass = worker();
    await pass.drain(now);
    await pass.drain(now);
    assert.equal(pushes.length, 2, 'two passes ring each fallback exactly once');
    assert.ok(pushes.some((args) => args[0] === from.id && args[1] === pending.id && args[2] === 'AskUserQuestion' && args[3] === true));
    assert.deepEqual(pushes.find((args) => typeof args[0] === 'object'), [{ ownerId, sessionId: from.id, fallbackTitle: 'Orbit', message: 'Not reviewed by the coordinator · Please decide' }, true]);
    assert.equal(frames.length, 1);
    assert.equal((frames[0][1] as { payload: { coordinatorFallback: string } }).payload.coordinatorFallback, 'TIMED_OUT');
    for (const id of [question.id, notice.id]) assert.ok((await db.sessionRequest.findUniqueOrThrow({ where: { id } })).ownerAlertedAt);
    for (const id of [read.id, answered.id, replied.id, open.id]) assert.equal((await db.sessionRequest.findUniqueOrThrow({ where: { id } })).ownerAlertedAt, null);
    assert.deepEqual(handoffs, [], 'run outcomes never enter MESSAGE hand-back');

    // Both replicas reach the claim before either executes it, over independent database pools.
    const racedApproval = await approval();
    const raced = await request('RUN_QUESTION', 'NO_REPLY', racedApproval.id);
    const racedNotice = await request('RUN_NOTIFY', 'RECIPIENT_ENDED');
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    function racing(client: typeof db) {
      return new Proxy(client, { get(target, key) {
        if (key === '$queryRaw') return async (...args: unknown[]) => {
          if (++arrived === 2) release();
          await gate;
          return Reflect.apply(target.$queryRaw, target, args);
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    await Promise.all([worker(racing(db)).drain(now), worker(racing(secondDb)).drain(now)]);
    assert.equal(pushes.length, 4, 'racing replicas produce exactly one ring per question and notice');
    assert.equal(frames.length, 2);
    assert.ok((await db.sessionRequest.findUniqueOrThrow({ where: { id: raced.id } })).ownerAlertedAt);
    assert.ok((await db.sessionRequest.findUniqueOrThrow({ where: { id: racedNotice.id } })).ownerAlertedAt);

    for (const [status, decider, expected] of [
      ['ALLOWED', ownerId, 'OWNER_ANSWERED'], ['DENIED', ownerId, 'OWNER_ANSWERED'],
      ['ABANDONED', null, 'UNDELIVERED'],
    ] as const) {
      const card = await approval(status, decider);
      const q = await request('RUN_QUESTION', 'OPEN', card.id);
      await pass.drain(now);
      const closed = await db.sessionRequest.findUniqueOrThrow({ where: { id: q.id } });
      assert.equal(closed.state, expected);
      assert.equal(closed.closeReason, decider ? null : 'QUESTION_ABANDONED');
      assert.equal(closed.ownerAlertedAt, null);
    }
    assert.equal(pushes.length, 4, 'owner answered and abandoned questions never ring');

    // R12: 50 platform requests consume neither the MESSAGE cap nor a wake source.
    for (let i = 0; i < 50; i++) await request('RUN_NOTIFY');
    await chargeOpenRequest(db, from.id);
    assert.equal(await hasPendingWakeSource(db, { id: from.id, runningBgJobs: [], retryAt: null }), false);
    const message = await request('MESSAGE');
    assert.equal(message.kind, 'MESSAGE');
    assert.equal(await hasPendingWakeSource(db, { id: from.id, runningBgJobs: [], retryAt: null }), true);
    await db.sessionRequest.update({ where: { id: message.id }, data: { state: 'UNDELIVERED', closedAt: now } });
    assert.equal(await hasPendingWakeSource(db, { id: from.id, runningBgJobs: [], retryAt: null }), true, 'MESSAGE hand-back remains a wake source');
    await pass.drain(now);
    assert.deepEqual(handoffs, [message.id], 'only MESSAGE is handed back, even behind many run rows');
  } finally {
    await db.sessionRequest.deleteMany({ where: { ownerId } });
    await db.session.deleteMany({ where: { ownerId } });
    await db.user.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
    await secondDb.$disconnect();
    await sql.end();
  }
});
