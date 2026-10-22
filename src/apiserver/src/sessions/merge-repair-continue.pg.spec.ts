/**
 * THE MERGE REPAIR DOOR HANDS THE NEXT STEP TO THE SAME REPAIR SESSION — OVER A REAL POSTGRESQL.
 *
 * S2 of the merge-recovery repair loop (project 34hIv3wbdtsxpc5RzDlOk). Continue repair, Reply in repair
 * session and Prepare PR candidate all POST /sessions/:id/merge-repair, and that door now goes to the repair
 * session the parent's detail shows instead of opening a new one every time. One waiting for input, or ended
 * in a way that can be resumed, is sent where the recovery stands now — its check result and phase, the files
 * in conflict or left unresolved, the repair branch and worktree — through the doors the owner's own message
 * takes; one running is answered as it is; a failed one, one in Trash, one those doors refuse, or none at all
 * is replaced by a new one, opened as before. The cases are the task's named scenarios, through the
 * controller's door or SessionsService.startMergeRepair over real rows. The one seam is a SessionsService that
 * can hold two taps at the message doors until both have read the repair session, so a case can make them race.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/merge-repair-continue.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  SESSION_MERGE_RECOVERY_V1,
  mergeRecoveryContinuePrompt,
  mergeRecoveryPrompt,
  type MergeRecovery,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The production SessionsService, able to hold taps at the two message doors until every one of them is there. */
class TappedSessions extends SessionsService {
  private gate: { waiting: number; open: () => void; opened: Promise<void> } | null = null;

  /** The next `taps` calls of createTurn or resume each wait there until the last of them has arrived. */
  holdDoorsFor(taps: number): void {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    this.gate = { waiting: taps, open, opened };
  }

  private async atDoor(): Promise<void> {
    const gate = this.gate;
    if (!gate) return;
    gate.waiting -= 1;
    if (gate.waiting === 0) {
      this.gate = null;
      gate.open();
    }
    await gate.opened;
  }

  override async createTurn(...args: Parameters<SessionsService['createTurn']>) {
    await this.atDoor();
    return super.createTurn(...args);
  }

  override async resume(...args: Parameters<SessionsService['resume']>) {
    await this.atDoor();
    return super.resume(...args);
  }
}

/** One API replica: its own client, realtime, sessions and the sessions controller. */
function replica(url: string) {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const push = {
    scheduleBadgeSync: () => undefined,
    notifySessionSettled: async () => undefined,
  } as unknown as PushService;
  const realtime = new RealtimeService(prisma, push);
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new TappedSessions(prisma, queue, realtime);
  const controller = new SessionsController(sessions, prisma, realtime, {} as never, {} as never, {} as never);
  return { db, sessions, controller };
}

const HOUR = 3_600_000;

/** The runner's own clock format for `checkedAt`: RFC 3339 to the second, as merge_recovery.go writes it. */
const rfc3339 = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What the last check of a recovery left: by default a conflict in the repair's replay. */
function recovery(extra: Partial<MergeRecovery> = {}): MergeRecovery {
  const previewId = randomUUID().replace(/-/g, '');
  return {
    code: 'CONFLICT', targetBranch: 'main', repoRoot: '/repo', previewId,
    sourceSha: 'a'.repeat(40), localSha: 'b'.repeat(40), remoteSha: 'c'.repeat(40),
    repairBranch: `orbit/recovery/${previewId}`, repairWorktree: `/worktrees/recovery-${previewId}`,
    phase: 'SOURCE_REPLAY', conflicts: ['src/app.ts', 'Sources/AgentsModel.swift'], checkedAt: rfc3339(new Date()),
    ...extra,
  };
}

interface World { ownerId: string; runnerId: string; workspaceId: string }

/** One owner, one runner able to check recoveries (online unless told otherwise) and one workspace. */
async function world(db: PrismaClient, label: string, online = true): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@merge-repair.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: online ? RunnerStatus.ONLINE : RunnerStatus.OFFLINE,
      capabilities: [SESSION_MERGE_RECOVERY_V1], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: online ? new Date() : new Date(Date.now() - HOUR),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: '/repo' },
  });
  return { ownerId, runnerId, workspaceId };
}

/** The session whose merge needs recovering: a finished run with a worktree branch and its recovery. */
async function parentSession(db: PrismaClient, w: World, label: string, rec: MergeRecovery): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: `${label} parent`, prompt: 'ship the feature', provider: 'claude', providerBuiltin: true,
      dispatchOrigin: SessionDispatchOrigin.USER, status: RunStatus.SUCCEEDED, startedAt: new Date(Date.now() - 2 * HOUR),
      finishedAt: new Date(Date.now() - HOUR), runtimeSessionId: randomUUID(), numTurns: 1,
      branch: `orbit/${label}-${id.slice(0, 8)}`, isolationStatus: 'worktree',
      mergeRecovery: rec as never, mergeStatus: 'conflict', mergeRecoveryAction: 'preview',
    },
  });
  return id;
}

/**
 * A repair session of `parentId` as startMergeRepair opened it, after its first round: started, its opening
 * prompt answered, waiting for input unless `row` says otherwise.
 */
async function repairSession(
  db: PrismaClient,
  w: World,
  parentId: string,
  label: string,
  row: Partial<Prisma.SessionUncheckedCreateInput> = {},
): Promise<string> {
  const id = randomUUID();
  const prompt = mergeRecoveryPrompt(recovery());
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: `${label} repair`, prompt, provider: 'claude', providerBuiltin: true,
      dispatchOrigin: SessionDispatchOrigin.USER, source: 'merge-repair', parentSessionId: parentId,
      status: RunStatus.AWAITING_INPUT, startedAt: new Date(Date.now() - HOUR), runtimeSessionId: randomUUID(),
      numTurns: 1, lastTurnAt: new Date(Date.now() - 30 * 60_000),
      ...row,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: id, seq: 1, clientTurnId: `opening-${id}`, kind: 'message', content: prompt,
      ...(row.status === RunStatus.RUNNING
        ? { status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000), leaseGeneration: randomUUID() }
        : row.status === RunStatus.PENDING
          ? { status: 'PENDING' }
          : { status: 'ANSWERED', deliveredAt: new Date(Date.now() - HOUR), answeredAt: new Date(Date.now() - 30 * 60_000) }),
    },
  });
  return id;
}

/** An ended repair session that can be resumed: its run finished, the runner that holds it online. */
const ended = (extra: Partial<Prisma.SessionUncheckedCreateInput> = {}): Partial<Prisma.SessionUncheckedCreateInput> => ({
  status: RunStatus.SUCCEEDED, finishedAt: new Date(Date.now() - 20 * 60_000), ...extra,
});

/** Every repair session of `parentId`, oldest first. */
function repairsOf(db: PrismaClient, parentId: string) {
  return db.session.findMany({
    where: { parentSessionId: parentId, source: 'merge-repair' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, status: true, prompt: true, workspaceId: true, assignedRunnerId: true, deletedAt: true,
      finishedAt: true, completedAt: true, endReason: true, cancelRequestedAt: true,
    },
  });
}

/** The turns written for a session, in order. */
function turnsOf(db: PrismaClient, sessionId: string) {
  return db.conversationTurn.findMany({
    where: { sessionId },
    orderBy: { seq: 'asc' },
    select: { seq: true, kind: true, status: true, content: true, sendIntent: true },
  });
}

/** The fields the clients read off the door's answer (web `MergeRepairSession`, OrbitKit, Android). */
function assertRepairShape(answer: Record<string, unknown>, id: string, status: RunStatus) {
  assert.equal(answer.id, id);
  assert.equal(answer.status, status);
  assert.equal(answer.runStatus, status);
  for (const key of ['title', 'runState', 'sessionState', 'lifecycleState', 'filingState']) {
    assert.equal(typeof answer[key], 'string', `the answer carries ${key}`);
  }
  for (const key of ['error', 'completedAt', 'archivedAt']) assert.ok(key in answer, `the answer carries ${key}`);
  assert.equal(answer.source, 'merge-repair');
}

test('S2 the merge repair door hands the next step to the same repair session on PostgreSQL', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { db, sessions, controller } = replica(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const owner = (w: World) => ({ userId: w.ownerId, email: 'owner@merge-repair.invalid' });

  await t.test('S2 a repair session waiting for input is reused and gets one message with the current conflicts and its repair branch and worktree', async () => {
    const w = await world(db, 'waiting');
    const rec = recovery({ phase: 'TARGET_SYNC', conflicts: ['src/app.ts', 'Sources/AgentsModel.swift'] });
    const parent = await parentSession(db, w, 'waiting', rec);
    const repair = await repairSession(db, w, parent, 'waiting');

    const answer = await controller.mergeRepair(owner(w), parent, {}) as unknown as Record<string, unknown>;
    assertRepairShape(answer, repair, RunStatus.PENDING);
    assert.deepEqual((await repairsOf(db, parent)).map((r) => r.id), [repair], 'no new repair session');

    const turns = await turnsOf(db, repair);
    assert.equal(turns.length, 2, 'one message, after its first round');
    const [, message] = turns;
    assert.equal(message.kind, 'message');
    assert.equal(message.status, 'PENDING');
    assert.equal(message.sendIntent, 'NEXT_TURN', 'queued as its next turn, never steered into one');
    assert.equal(message.content, mergeRecoveryContinuePrompt(rec));
    for (const part of [
      'This is the next step of the same merge recovery for main', 'Check result: CONFLICT', 'Phase: TARGET_SYNC',
      'Conflicting files: src/app.ts, Sources/AgentsModel.swift', `Repair branch: ${rec.repairBranch}`,
      `Repair worktree: ${rec.repairWorktree}`,
    ]) assert.ok(message.content?.includes(part), `the message says ${part}`);
    assert.ok(!message.content?.includes('PR candidate'), 'no PR candidate was asked for');

    // The parent's detail goes on showing that same repair session.
    const detail = await sessions.get(w.ownerId, parent);
    assert.equal((detail.mergeRepairSession as unknown as Record<string, unknown>).id, repair);

    // One the owner stopped mid-turn (INTERRUPTED) waits for input the same way.
    const stopped = await world(db, 'interrupted');
    const stoppedParent = await parentSession(db, stopped, 'interrupted', rec);
    const stoppedRepair = await repairSession(db, stopped, stoppedParent, 'interrupted', { status: RunStatus.INTERRUPTED });
    const again = await sessions.startMergeRepair(stopped.ownerId, stoppedParent) as unknown as Record<string, unknown>;
    assertRepairShape(again, stoppedRepair, RunStatus.PENDING);
    const stoppedTurns = await turnsOf(db, stoppedRepair);
    assert.equal(stoppedTurns.length, 2);
    assert.equal(stoppedTurns[1].content, mergeRecoveryContinuePrompt(rec));
    assert.equal((await repairsOf(db, stoppedParent)).length, 1);
  });

  await t.test('S2 an ended repair session that can be resumed is resumed and reused', async () => {
    // Its run finished, and the recovery it left is a repair not yet finished: the files still unresolved.
    const w = await world(db, 'ended');
    const rec = recovery({ code: 'REPAIR_IN_PROGRESS', phase: 'SOURCE_REPLAY', conflicts: ['Sources/AgentsModel.swift'] });
    const parent = await parentSession(db, w, 'ended', rec);
    const repair = await repairSession(db, w, parent, 'ended', ended());

    const answer = await sessions.startMergeRepair(w.ownerId, parent) as unknown as Record<string, unknown>;
    assertRepairShape(answer, repair, RunStatus.PENDING);
    assert.equal(answer.finishedAt, null, 'resumed: its run is on its way again');
    const [row] = await repairsOf(db, parent);
    assert.equal(row.id, repair, 'and no new repair session');
    assert.equal(row.status, RunStatus.PENDING);
    assert.equal(row.finishedAt, null);
    const turns = await turnsOf(db, repair);
    assert.equal(turns.length, 2);
    assert.equal(turns[1].status, 'PENDING');
    assert.equal(turns[1].content, mergeRecoveryContinuePrompt(rec));
    for (const part of ['Check result: REPAIR_IN_PROGRESS', 'Phase: SOURCE_REPLAY', 'Unresolved files: Sources/AgentsModel.swift',
      `Repair branch: ${rec.repairBranch}`, `Repair worktree: ${rec.repairWorktree}`]) {
      assert.ok(turns[1].content?.includes(part), `the message says ${part}`);
    }

    // One the owner ended and filed in Completed is resumed back into Open the same way.
    const filed = await world(db, 'completed');
    const filedRec = recovery();
    const filedParent = await parentSession(db, filed, 'completed', filedRec);
    const filedRepair = await repairSession(db, filed, filedParent, 'completed', ended({
      status: RunStatus.CANCELLED, endReason: 'completed', completedAt: new Date(Date.now() - 10 * 60_000),
    }));
    const again = await sessions.startMergeRepair(filed.ownerId, filedParent) as unknown as Record<string, unknown>;
    assertRepairShape(again, filedRepair, RunStatus.PENDING);
    assert.equal(again.completedAt, null, 'back in Open');
    const [filedRow] = await repairsOf(db, filedParent);
    assert.equal(filedRow.endReason, null);
    assert.equal(filedRow.completedAt, null);
    assert.equal((await turnsOf(db, filedRepair))[1]?.content, mergeRecoveryContinuePrompt(filedRec));
    assert.equal((await repairsOf(db, filedParent)).length, 1);
  });

  await t.test('S2 a running repair session is returned as it is and sent no message', async () => {
    for (const status of [RunStatus.RUNNING, RunStatus.PENDING]) {
      const w = await world(db, `busy-${status}`);
      const parent = await parentSession(db, w, `busy-${status}`, recovery());
      const repair = await repairSession(db, w, parent, `busy-${status}`, { status });
      const before = await turnsOf(db, repair);

      const answer = await sessions.startMergeRepair(w.ownerId, parent) as unknown as Record<string, unknown>;
      assertRepairShape(answer, repair, status);
      assert.deepEqual(await turnsOf(db, repair), before, `${status}: no message`);
      assert.deepEqual((await repairsOf(db, parent)).map((r) => [r.id, r.status]), [[repair, status]], `${status}: nothing else`);
    }
  });

  await t.test('S2 a new repair session is started when the latest one failed or was deleted, or there is none', async () => {
    const cases: Array<[string, Partial<Prisma.SessionUncheckedCreateInput> | null]> = [
      ['none', null],
      // Its run failed; it could still be resumed, but a failed repair is not continued.
      ['failed', ended({ status: RunStatus.FAILED, error: 'the engine exited' })],
      // In Trash: ended when it was moved there, and resumable once restored.
      ['deleted', ended({ status: RunStatus.CANCELLED, endReason: 'deleted', deletedAt: new Date(Date.now() - 5 * 60_000) })],
    ];
    for (const [label, row] of cases) {
      const w = await world(db, `new-${label}`);
      const rec = recovery();
      const parent = await parentSession(db, w, `new-${label}`, rec);
      const old = row ? await repairSession(db, w, parent, `new-${label}`, row) : null;
      const oldTurns = old ? await turnsOf(db, old) : [];

      const answer = await sessions.startMergeRepair(w.ownerId, parent) as unknown as Record<string, unknown>;
      const repairs = await repairsOf(db, parent);
      assert.equal(repairs.length, old ? 2 : 1, `${label}: one new repair session`);
      const opened = repairs[repairs.length - 1];
      assert.notEqual(opened.id, old, label);
      assertRepairShape(answer, opened.id, RunStatus.PENDING);
      // Opened as it always was: the parent's workspace and runner, the recovery's own first prompt.
      assert.equal(opened.prompt, mergeRecoveryPrompt(rec), label);
      assert.equal(opened.workspaceId, w.workspaceId, label);
      assert.equal(opened.assignedRunnerId, w.runnerId, label);
      if (old) {
        assert.deepEqual(await turnsOf(db, old), oldTurns, `${label}: the old one is sent nothing`);
        assert.equal(repairs[0].status, (row?.status ?? RunStatus.AWAITING_INPUT), `${label}: and left as it was`);
      }
      // The parent's detail now shows the new one.
      assert.equal(((await sessions.get(w.ownerId, parent)).mergeRepairSession as unknown as Record<string, unknown>).id, opened.id, label);
    }
  });

  await t.test('S2 a repair session whose doors refuse the message is replaced by a new one', async () => {
    const cases: Array<[string, Partial<Prisma.SessionUncheckedCreateInput>, boolean]> = [
      // Ended before it ever started: resume refuses NOT_STARTED.
      ['never-started', ended({ status: RunStatus.CANCELLED, startedAt: null, numTurns: 0, endReason: 'cancelled' }), true],
      // Being ended: a message to it is refused, "the session has ended".
      ['ending', { cancelRequestedAt: new Date() }, true],
      // Ended on a runner that has stopped heartbeating: resume refuses RUNNER_OFFLINE.
      ['runner-offline', ended(), false],
    ];
    for (const [label, row, online] of cases) {
      const w = await world(db, `refused-${label}`, online);
      const rec = recovery();
      const parent = await parentSession(db, w, `refused-${label}`, rec);
      const old = await repairSession(db, w, parent, `refused-${label}`, row);
      const oldTurns = await turnsOf(db, old);
      const oldRow = (await repairsOf(db, parent))[0];

      const answer = await sessions.startMergeRepair(w.ownerId, parent) as unknown as Record<string, unknown>;
      const repairs = await repairsOf(db, parent);
      assert.equal(repairs.length, 2, `${label}: a new repair session`);
      assert.equal(repairs[1].prompt, mergeRecoveryPrompt(rec), label);
      assertRepairShape(answer, repairs[1].id, RunStatus.PENDING);
      assert.deepEqual(await turnsOf(db, old), oldTurns, `${label}: nothing was written to the refused one`);
      assert.deepEqual(repairs[0], oldRow, `${label}: which is left as it was`);
    }
  });

  await t.test('S2 two taps in a row send one message', async () => {
    // One after the other: the second finds the first one's message queued, and is answered with it.
    {
      const w = await world(db, 'twice');
      const rec = recovery();
      const parent = await parentSession(db, w, 'twice', rec);
      const repair = await repairSession(db, w, parent, 'twice');
      const first = await controller.mergeRepair(owner(w), parent, {}) as unknown as Record<string, unknown>;
      const second = await controller.mergeRepair(owner(w), parent, {}) as unknown as Record<string, unknown>;
      assertRepairShape(first, repair, RunStatus.PENDING);
      assertRepairShape(second, repair, RunStatus.PENDING);
      assert.deepEqual((await turnsOf(db, repair)).slice(1).map((turn) => turn.content), [mergeRecoveryContinuePrompt(rec)]);
      assert.equal((await repairsOf(db, parent)).length, 1);
    }
    // At once, each having read the repair session waiting for input before either wrote: the second
    // joins the message the first queued.
    {
      const w = await world(db, 'race-waiting');
      const rec = recovery();
      const parent = await parentSession(db, w, 'race-waiting', rec);
      const repair = await repairSession(db, w, parent, 'race-waiting');
      sessions.holdDoorsFor(2);
      const answers = await Promise.all([
        sessions.startMergeRepair(w.ownerId, parent), sessions.startMergeRepair(w.ownerId, parent),
      ]) as unknown as Array<Record<string, unknown>>;
      for (const answer of answers) assertRepairShape(answer, repair, RunStatus.PENDING);
      assert.deepEqual((await turnsOf(db, repair)).slice(1).map((turn) => turn.content), [mergeRecoveryContinuePrompt(rec)]);
      assert.equal((await repairsOf(db, parent)).length, 1);
    }
    // At once on one that ended: one resume, one message, and no new repair session for the tap that lost.
    {
      const w = await world(db, 'race-ended');
      const rec = recovery();
      const parent = await parentSession(db, w, 'race-ended', rec);
      const repair = await repairSession(db, w, parent, 'race-ended', ended());
      sessions.holdDoorsFor(2);
      const answers = await Promise.all([
        sessions.startMergeRepair(w.ownerId, parent), sessions.startMergeRepair(w.ownerId, parent),
      ]) as unknown as Array<Record<string, unknown>>;
      for (const answer of answers) assertRepairShape(answer, repair, RunStatus.PENDING);
      assert.deepEqual((await turnsOf(db, repair)).slice(1).map((turn) => turn.content), [mergeRecoveryContinuePrompt(rec)]);
      assert.deepEqual((await repairsOf(db, parent)).map((r) => r.id), [repair]);
    }
    // With none yet: the second tap is answered with the session the first opened.
    {
      const w = await world(db, 'twice-new');
      const parent = await parentSession(db, w, 'twice-new', recovery());
      const first = await sessions.startMergeRepair(w.ownerId, parent) as unknown as Record<string, unknown>;
      const second = await sessions.startMergeRepair(w.ownerId, parent) as unknown as Record<string, unknown>;
      assert.equal(second.id, first.id);
      assert.deepEqual((await repairsOf(db, parent)).map((r) => r.id), [first.id]);
      assert.deepEqual(await turnsOf(db, first.id as string), [], 'and the second tap wrote it no message');
    }
  });

  await t.test('S2 with preparePR the message carries the PR candidate requirements', async () => {
    for (const [label, row] of [['waiting', {}], ['ended', ended()]] as const) {
      const w = await world(db, `pr-${label}`);
      const rec = recovery();
      const parent = await parentSession(db, w, `pr-${label}`, rec);
      const repair = await repairSession(db, w, parent, `pr-${label}`, row);

      const answer = await controller.mergeRepair(owner(w), parent, { preparePR: true }) as unknown as Record<string, unknown>;
      assertRepairShape(answer, repair, RunStatus.PENDING);
      const [, message] = await turnsOf(db, repair);
      assert.equal(message.content, mergeRecoveryContinuePrompt(rec, true), label);
      for (const part of [
        'This is the next step of the same merge recovery for main: prepare a reviewable PR candidate',
        'organize commits on a separate PR candidate according to repository policy',
        'Respect required linear history and branch protection.',
        'Prepare a candidate branch and complete diff for review; do not claim it is merged.',
        `Conflicting files: ${rec.conflicts!.join(', ')}`, `Repair branch: ${rec.repairBranch}`, `Repair worktree: ${rec.repairWorktree}`,
      ]) assert.ok(message.content?.includes(part), `${label}: the message says ${part}`);
      assert.equal((await repairsOf(db, parent)).length, 1, label);
    }
  });
});
