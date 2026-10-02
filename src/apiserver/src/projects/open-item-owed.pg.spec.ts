import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  CreatorType,
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import type { IntegrationCheckResult } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { readOwnerDecisionSignals } from './owner-decision-signal';
import { criterionKeyOf } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { configureProjectIntegration } from './project-integration-line';
import { readProjectListAttention } from './project-list-attention';
import { readProjectFinish } from './project-looks-finished';
import { openItemOwed } from './project-open-item';
import { ProjectOpenItemService } from './project-open-item.service';
import { automaticLandingRefusal } from './project-promotion.service';
import { ProjectsService } from './projects.service';

/**
 * An open item is in front of somebody only while it is still owed (`openItemOwed`), and the
 * escalation tick closes the ones that are not (`ProjectOpenItemEscalationService.reconcile`).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/open-item-owed.pg.spec.ts
 *
 * WHY. An item is closed by the transaction that moves what it is about, one edge per fact, and a
 * door that misses its edge leaves a zombie: on 2026-10-02 an INTEGRATION_CHECK_FAILED about a
 * candidate that had since been superseded stayed open, was escalated to the owner, and kept M-T11
 * refusing every automatic merge of its project. `closePromotionItems` closed that edge. This file
 * is about the next one somebody misses: every reader leaves out an item nobody owes, and the tick
 * closes it.
 *
 * THE ZOMBIES ARE MADE BY HAND, ON PURPOSE. Each is an item row written open beside a fact that
 * should have closed it — a candidate superseded or cancelled, a merge card whose candidate is not
 * READY, a task cancelled or replaced — which is exactly what a missed edge leaves, and something
 * no door does on purpose. Beside each one is the item that IS still owed, so a reader that
 * counted nothing at all, or a backstop that closed everything, fails on the control:
 *
 *  (1) the backstop closes the zombies — the one already escalated to the owner too — with the
 *      ending the edge would have written and a `backstop:` note, warns once per item, recounts the
 *      owner's badge, writes no turn, session, wake or delivery, and finds nothing the second time;
 *      it leaves a truly BLOCKED candidate's failure, a READY candidate's card, a live task's
 *      conflict, a task's failure and a landed task's conflict open (the last one reported); and
 *      `scripts/project-liveness-audit.sql`'s count of them goes from five to none;
 *  (2) the sweep neither escalates a zombie nor announces it, and the tick closes it;
 *  (3) the open-items read, the session row's owner items and count, the workspace's needs-you,
 *      the APNs badge and the owner-item push, the Needs-you signals and the project list's
 *      attention all leave the zombies out — and all of them count the owed item beside it;
 *  (4) M-T11 does not hold an automatic landing back on a zombie, and does on the owed item;
 *  (5) a project that looks finished still does with a zombie open, and not with an owed item.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project. The
 * backstop is database-wide, so what each case reads of it is narrowed to its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 3_600_000;
const sha = (nibble: string) => nibble.repeat(40);

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sessions: SessionsService;
  tasks: TasksService;
  openItems: ProjectOpenItemService;
  projects: ProjectsService;
  acceptance: ProjectAcceptanceService;
  receipts: MergeReceiptService;
}

/** The services the readers live in, over one client. No completion-input router: nothing here is
 *  about which facts a write delivers, only about what reads count. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma);
  return {
    db,
    prisma,
    sessions,
    tasks: new TasksService(prisma, sessions, realtime),
    openItems: new ProjectOpenItemService(prisma, sessions),
    projects: new ProjectsService(prisma, acceptance, sessions),
    acceptance,
    receipts: new MergeReceiptService(prisma),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  codebaseId: string;
  integrationRef: string;
  upstreamRef: string;
}

/**
 * One owner, one project integrating on a branch of its own, and the parked conversation it is
 * coordinated from — the binding chosen at the owner's settings door, so the candidates below stand
 * on the codebase a real project has.
 */
async function world(stack: Stack, label: string): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${ownerId}@open-item-owed.invalid`, name: label, passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}.git`,
      workDir: `/srv/${label}`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId,
      ownerId,
      creatorId: ownerId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: `coordinator: ${label}`,
      prompt: `coordinator: ${label}`,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true,
      numTurns: 1,
      startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message',
      content: `coordinator: ${label}`,
      status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} project`,
      goal: 'only what somebody still owes is in front of anybody',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId,
    projectId,
    settings: { line: 'PROJECT_BRANCH' },
  }));
  const codebase = await db.projectCodebase.findFirstOrThrow({
    where: { projectId, slot: 'primary' },
    select: { id: true, integrationRef: true, upstreamRef: true },
  });
  return {
    ownerId, runnerId, workspaceId, projectId, coordinatorSessionId,
    codebaseId: codebase.id, integrationRef: codebase.integrationRef, upstreamRef: codebase.upstreamRef,
  };
}

/** A promotion candidate in `state`, on a source of its own unless `over` names one — one live
 *  candidate per source (0286), and the cases below hold several. */
async function candidate(
  stack: Stack,
  w: World,
  state: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await stack.db.projectPromotion.create({
    data: {
      id,
      projectId: w.projectId,
      ownerId: w.ownerId,
      codebaseId: w.codebaseId,
      sourceKind: 'PROJECT_BRANCH',
      sourceRef: `refs/heads/fixture/${id}`,
      sourceSha: sha('1'),
      upstreamRef: w.upstreamRef,
      state,
      ...over,
    } as never,
  });
  return id;
}

/** A task of the project in `status`, written as a row: the cases need where it stands, not how. */
async function task(stack: Stack, w: World, status: TaskStatus, title: string): Promise<string> {
  const id = randomUUID();
  await stack.db.task.create({
    data: {
      id,
      ownerId: w.ownerId,
      projectId: w.projectId,
      title,
      creatorType: CreatorType.USER,
      creatorId: w.ownerId,
      assigneeId: w.workspaceId,
      status,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    },
  });
  return id;
}

/** A run of that task, as the runner left it: a worktree on `branch`. */
async function workSession(stack: Stack, w: World, taskId: string, branch: string): Promise<string> {
  const id = randomUUID();
  await stack.db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      taskId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: `ran ${branch}`,
      prompt: 'do the work',
      provider: 'claude',
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
      startedAt: new Date(),
      branch,
      isolationStatus: 'worktree',
      baseSha: sha('b'),
    },
  });
  return id;
}

let keys = 0;
/**
 * One OPEN item, the coordinator's unless `over` says otherwise, with the columns a door writes.
 * `over` says what it is about — `promotionId` or `taskId` — and, for the owner's, why it is theirs.
 */
async function openItem(
  stack: Stack,
  w: World,
  over: Record<string, unknown> & { kind: string },
): Promise<string> {
  keys += 1;
  const now = new Date();
  const row = await stack.db.projectOpenItem.create({
    data: {
      projectId: w.projectId,
      ownerId: w.ownerId,
      state: 'OPEN',
      assignee: 'COORDINATOR',
      assigneeReason: 'DEFAULT',
      dedupeKey: `open-item-owed:${keys}`,
      title: `${over.kind} (fixture ${keys})`,
      payload: {},
      waitingSince: now,
      assignedAt: now,
      escalateAt: new Date(now.getTime() + 2 * HOUR),
      ...over,
    } as never,
    select: { id: true },
  });
  return row.id;
}

interface ItemRow {
  state: string;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  assignee: string;
  assigneeReason: string;
  escalatedAt: Date | null;
}

function reread(stack: Stack, id: string): Promise<ItemRow> {
  return stack.db.projectOpenItem.findUniqueOrThrow({
    where: { id },
    select: {
      state: true, resolution: true, resolvedBy: true, resolvedAt: true, resolutionNote: true,
      assignee: true, assigneeReason: true, escalatedAt: true,
    },
  });
}

/** What an agent would have been made to do. All of it, database-wide. */
async function agentWork(db: PrismaClient): Promise<Record<string, number>> {
  const [row] = await db.$queryRaw<Array<Record<string, bigint>>>(Prisma.sql`
    SELECT (SELECT count(*) FROM "conversation_turn") AS "turns",
           (SELECT count(*) FROM "session") AS "sessions",
           (SELECT count(*) FROM "project_coordinator_wake") AS "wakes",
           (SELECT count(*) FROM "project_open_item_delivery") AS "deliveries"`);
  return Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, Number(value)]));
}

/** Every call made on a push that reaches no device. */
function recordingPush(): { push: PushService; told: Array<{ method: string; args: unknown[] }> } {
  const told: Array<{ method: string; args: unknown[] }> = [];
  const push = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      told.push({ method: String(method), args });
      return Promise.resolve();
    },
  }) as unknown as PushService;
  return { push, told };
}

/** The backstop's log, kept rather than printed. */
function quietLog(clock: ProjectOpenItemEscalationService): { warned: string[]; errors: string[] } {
  const warned: string[] = [];
  const errors: string[] = [];
  (clock as unknown as { logger: object }).logger = {
    warn: (message: string) => warned.push(message),
    error: (message: string) => errors.push(message),
    log: () => undefined,
  };
  return { warned, errors };
}

/** The audit's own text, split into its statements with the comments taken out. */
function auditStatements(): string[] {
  const file = path.resolve(__dirname, '../../../../scripts/project-liveness-audit.sql');
  return readFileSync(file, 'utf8')
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** SQL text with its layout taken out, so two spellings of one statement compare equal. */
function layoutFree(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

/** The audit's §4.2 query, run as T3 and T13 run it, narrowed to one project. */
async function audit(stack: Stack, projectId: string) {
  const rows = await stack.db.$queryRawUnsafe<Array<{
    project_id: string; kind: string; open_not_owed: number; with_owner: number;
  }>>(auditStatements()[1]!);
  return rows
    .filter((row) => row.project_id === projectId)
    .map((row) => ({ kind: row.kind, openNotOwed: row.open_not_owed, withOwner: row.with_owner }));
}

// ═══ (1) the backstop ═════════════════════════════════════════════════════════════════════════════

test('(1) the backstop closes every item nobody owes, the escalated one too, once — and nothing owed',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'backstop');
      // The candidates: two nothing waits on any more, one BLOCKED — what a failure about it waits
      // on somebody to fix — and one READY, which its card still asks the owner to merge.
      const superseded = await candidate(stack, w, 'SUPERSEDED');
      const cancelled = await candidate(stack, w, 'CANCELLED');
      const blocked = await candidate(stack, w, 'BLOCKED');
      const ready = await candidate(stack, w, 'READY');
      // The tasks: one cancelled, one replaced by another that is still being worked, one landed.
      const gone = await task(stack, w, TaskStatus.CANCELLED, 'cancelled');
      const successor = await task(stack, w, TaskStatus.OPEN, 'successor');
      const replaced = await task(stack, w, TaskStatus.FAILED, 'replaced');
      await stack.db.task.update({
        where: { id: replaced },
        data: { supersededByTaskId: successor, terminalReason: 'SUPERSEDED', supersededAt: new Date() },
      });
      const landed = await task(stack, w, TaskStatus.DONE, 'landed');

      const zombie = {
        // The 2026-10-02 item: a failed check about a superseded candidate, already the owner's.
        escalated: await openItem(stack, w, {
          kind: 'INTEGRATION_CHECK_FAILED', promotionId: superseded,
          assignee: 'OWNER', assigneeReason: 'ESCALATED', escalatedAt: new Date(),
        }),
        cancelledCandidate: await openItem(stack, w, {
          kind: 'INTEGRATION_CONFLICT', promotionId: cancelled,
        }),
        card: await openItem(stack, w, {
          kind: 'PROMOTION_APPROVAL', promotionId: blocked, assignee: 'OWNER', escalateAt: null,
        }),
        cancelledTask: await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', taskId: gone }),
        replacedTask: await openItem(stack, w, { kind: 'INTEGRATION_ERROR', taskId: replaced }),
      };
      const owed = {
        blocked: await openItem(stack, w, { kind: 'INTEGRATION_CHECK_FAILED', promotionId: blocked }),
        card: await openItem(stack, w, {
          kind: 'PROMOTION_APPROVAL', promotionId: ready, assignee: 'OWNER', escalateAt: null,
        }),
        live: await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', taskId: successor }),
        // A task's own failure is answered by the task (`resolveByFact`), not by this predicate.
        failure: await openItem(stack, w, { kind: 'TASK_FAILED', taskId: gone }),
        landed: await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', taskId: landed }),
      };
      // The landed task's work reached a branch an hour after its conflict was opened — a branch
      // that says nothing about this project's line, so the conflict stays owed.
      await stack.db.$executeRaw(Prisma.sql`
        UPDATE "project_open_item" SET "created_at" = "created_at" - interval '1 hour'
         WHERE "id" = ${owed.landed}::uuid`);
      const work = await workSession(stack, w, landed, 'orbit/landed');
      await stack.receipts.record(w.ownerId, work, {
        result: 'MERGED',
        sourceSha: sha('4'),
        targetBranch: 'somewhere-else',
        targetShaBefore: sha('5'),
        targetShaAfter: sha('6'),
      }, 'RUNNER');

      // The audit says what the backstop is about to do, and is the same predicate as the readers.
      const [, owedAudit] = auditStatements();
      assert.ok(layoutFree(owedAudit!).includes(layoutFree(openItemOwed('item').sql)),
        'scripts/project-liveness-audit.sql spells openItemOwed as the TypeScript does');
      assert.deepEqual(
        (await audit(stack, w.projectId)).sort((a, b) => a.kind.localeCompare(b.kind)),
        [
          { kind: 'INTEGRATION_CHECK_FAILED', openNotOwed: 1, withOwner: 1 },
          { kind: 'INTEGRATION_CONFLICT', openNotOwed: 2, withOwner: 0 },
          { kind: 'INTEGRATION_ERROR', openNotOwed: 1, withOwner: 0 },
          { kind: 'PROMOTION_APPROVAL', openNotOwed: 1, withOwner: 1 },
        ],
        'before the backstop, the audit counts the five zombies by kind, two of them the owner\'s',
      );

      const { push, told } = recordingPush();
      const clock = new ProjectOpenItemEscalationService(stack.prisma, push);
      const log = quietLog(clock);
      const before = await agentWork(stack.db);
      const closed = (await clock.reconcile()).filter((row) => row.projectId === w.projectId);
      const after = await agentWork(stack.db);

      assert.deepEqual(closed.map((row) => row.itemId).sort(), Object.values(zombie).sort(),
        'the backstop closed the five zombies and reported each');
      const ended = async (id: string) => {
        const row = await reread(stack, id);
        return [row.state, row.resolution, row.resolvedBy, row.resolutionNote];
      };
      const tail = '; no edge closed this item when that happened';
      assert.deepEqual(await ended(zombie.escalated), [
        'SUPERSEDED', 'PROMOTION_MOVED_ON', 'PLATFORM',
        `backstop: promotion ${superseded}@SUPERSEDED is no longer live${tail}`,
      ], 'the escalated item ends as its candidate did, as `closePromotionItems` would have ended it');
      assert.deepEqual(await ended(zombie.cancelledCandidate), [
        'RESOLVED', 'PROMOTION_MOVED_ON', 'PLATFORM',
        `backstop: promotion ${cancelled}@CANCELLED is no longer live${tail}`,
      ]);
      assert.deepEqual(await ended(zombie.card), [
        'RESOLVED', 'PROMOTION_MOVED_ON', 'PLATFORM',
        `backstop: promotion ${blocked}@BLOCKED is not READY, so the card asks nothing${tail}`,
      ], 'a merge card whose candidate is not READY asks the owner nothing');
      assert.deepEqual(await ended(zombie.cancelledTask), [
        'RESOLVED', 'TASK_CLOSED', 'PLATFORM', `backstop: task ${gone}@CANCELLED was cancelled${tail}`,
      ]);
      assert.deepEqual(await ended(zombie.replacedTask), [
        'RESOLVED', 'TASK_CLOSED', 'PLATFORM',
        `backstop: task ${replaced}@FAILED was replaced by task ${successor}${tail}`,
      ]);
      for (const id of Object.values(zombie)) {
        assert.ok((await reread(stack, id)).resolvedAt, 'a closed item says when');
      }

      for (const [what, id] of Object.entries(owed)) {
        const row = await reread(stack, id);
        assert.deepEqual([row.state, row.resolution], ['OPEN', null],
          `the ${what} item is still owed and stays open`);
      }

      // One warning per item closed: its kind, what it was about and where that stands, how long it
      // was open, and whose it was. And one for the landed conflict it left open.
      const mine = log.warned.filter((line) => line.includes(w.projectId));
      assert.equal(mine.filter((line) => line.startsWith('backstop closed ')).length, 5, mine.join('\n'));
      const escalatedLine = mine.find((line) => line.includes(zombie.escalated));
      assert.ok(escalatedLine, 'the escalated zombie was warned about');
      assert.match(escalatedLine!, /^backstop closed INTEGRATION_CHECK_FAILED /);
      assert.ok(escalatedLine!.includes(`promotion ${superseded}@SUPERSEDED`), escalatedLine);
      assert.match(escalatedLine!, /open \d+m, with OWNER \(ESCALATED\)$/);
      const landedLines = mine.filter((line) => line.includes(owed.landed));
      assert.equal(landedLines.length, 1, 'the landed conflict is reported, not closed');
      assert.match(landedLines[0]!, new RegExp(
        `^backstop left INTEGRATION_CONFLICT ${owed.landed} of project ${w.projectId} open: `
        + `task ${landed}@DONE landed on somewhere-else after it was opened, `
        + 'open 1h\\dm, with COORDINATOR \\(DEFAULT\\)$',
      ));
      assert.deepEqual(log.errors, []);

      assert.deepEqual(told.filter((call) => call.args[0] === w.ownerId),
        [{ method: 'scheduleBadgeSync', args: [w.ownerId] }],
        'the owner whose items closed has their badge recounted, once');
      assert.deepEqual(after, before, 'the backstop writes nothing an agent would run: '
        + `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

      // Again: nothing left to close, the landed item not reported twice, and the closed rows as
      // they were — which is also what a second replica ticking at the same moment finds.
      const resolvedAt = (await reread(stack, zombie.escalated)).resolvedAt;
      const again = (await clock.reconcile()).filter((row) => row.projectId === w.projectId);
      assert.deepEqual(again, [], 'a second pass closes nothing');
      assert.equal(log.warned.filter((line) => line.includes(w.projectId)).length, mine.length,
        'and warns about nothing new');
      assert.deepEqual(told.filter((call) => call.args[0] === w.ownerId).length, 1,
        'nor recounts a badge nothing changed');
      assert.equal((await reread(stack, zombie.escalated)).resolvedAt?.getTime(), resolvedAt?.getTime());
      const otherReplica = new ProjectOpenItemEscalationService(stack.prisma, push);
      quietLog(otherReplica);
      assert.deepEqual(
        (await otherReplica.reconcile()).filter((row) => row.projectId === w.projectId), [],
        'nor does another replica',
      );

      assert.deepEqual(await audit(stack, w.projectId), [],
        'after the backstop, the audit counts no open item nobody owes');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) the sweep ════════════════════════════════════════════════════════════════════════════════

test('(2) the sweep neither escalates nor announces an item nobody owes, and the tick closes it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'sweep');
      const superseded = await candidate(stack, w, 'SUPERSEDED');
      const blocked = await candidate(stack, w, 'BLOCKED');
      // Both opened five hours ago with the default two-hour window, and never put on the
      // conversation: due three hours ago, by the item's own clock.
      const opened = new Date(Date.now() - 5 * HOUR);
      const due = {
        waitingSince: opened, assignedAt: opened, escalateAt: new Date(opened.getTime() + 2 * HOUR),
      };
      const zombie = await openItem(stack, w, {
        kind: 'INTEGRATION_CHECK_FAILED', promotionId: superseded, ...due,
      });
      const owed = await openItem(stack, w, {
        kind: 'INTEGRATION_CHECK_FAILED', promotionId: blocked, ...due,
      });

      const clock = new ProjectOpenItemEscalationService(stack.prisma);
      const escalated = (await clock.sweep()).filter((row) => row.projectId === w.projectId);
      assert.deepEqual(escalated.map((row) => row.itemId), [owed],
        'the sweep hands over and reports the owed item, which is what gets pushed — not the zombie');
      const left = await reread(stack, zombie);
      assert.deepEqual([left.state, left.assignee, left.assigneeReason, left.escalatedAt],
        ['OPEN', 'COORDINATOR', 'DEFAULT', null], 'the zombie was not handed to anybody');
      const handed = await reread(stack, owed);
      assert.deepEqual([handed.assignee, handed.assigneeReason], ['OWNER', 'ESCALATED']);

      // The tick as production runs it, on the interval the service installs, with a push that
      // records every call: the backstop closes the zombie before the sweep can see it, the owner's
      // badge is recounted, and nobody is told about the zombie.
      const { push, told } = recordingPush();
      const ticking = new ProjectOpenItemEscalationService(stack.prisma, push);
      const log = quietLog(ticking);
      let swept = false;
      const sweep = ticking.sweep.bind(ticking);
      ticking.sweep = async () => {
        try {
          return await sweep();
        } finally {
          swept = true;
        }
      };
      const before = await agentWork(stack.db);
      mock.timers.enable({ apis: ['setInterval'] });
      try {
        ticking.onModuleInit();
        mock.timers.tick(60_000);
      } finally {
        ticking.onModuleDestroy();
        mock.timers.reset();
      }
      for (let waited = 0; waited < 15_000 && !swept; waited += 50) await sleep(50);
      await sleep(200);
      const after = await agentWork(stack.db);

      assert.ok(swept, 'the tick ran its sweep');
      assert.deepEqual(log.errors, []);
      const closed = await reread(stack, zombie);
      assert.deepEqual([closed.state, closed.resolution, closed.resolvedBy],
        ['SUPERSEDED', 'PROMOTION_MOVED_ON', 'PLATFORM'], 'the tick closed the zombie');
      assert.match(closed.resolutionNote ?? '', /^backstop: /);
      assert.deepEqual(told.filter((call) => call.args[0] === zombie), [],
        'nobody was told about the zombie');
      assert.deepEqual(told.filter((call) => call.args[0] === w.ownerId),
        [{ method: 'scheduleBadgeSync', args: [w.ownerId] }]);
      assert.deepEqual(after, before, 'the tick writes nothing an agent would run: '
        + `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) the readers ══════════════════════════════════════════════════════════════════════════════

test('(3) every reader leaves out an item nobody owes, and counts the owed one beside it',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'readers');
      const push = new PushService(stack.prisma, {
        get: (key: string) => ({
          APNS_KEY_ID: 'key-id',
          APNS_TEAM_ID: 'team-id',
          APNS_KEY: Buffer.from('test-key').toString('base64'),
        } as Record<string, string>)[key],
      } as never);
      // A device for the owner, and the APNs round trip replaced by a record of what was sent.
      const pushed: string[] = [];
      (push as unknown as { authToken: () => string }).authToken = () => 'auth-token';
      (push as unknown as { deliver: (tokens: unknown, body: string) => Promise<number> }).deliver =
        async (_tokens, body) => {
          pushed.push((JSON.parse(body) as { openItemID?: string }).openItemID ?? 'badge');
          return 1;
        };
      await stack.db.deviceToken.create({
        data: {
          userId: w.ownerId,
          token: `device-${randomUUID()}`,
          environment: 'sandbox',
          bundleId: 'app.orbit.test',
        },
      });

      /** Every reader of open items, as the owner's screens and phone receive them. */
      const reads = async () => {
        const listed = await stack.openItems.list(w.ownerId, w.projectId);
        const rows = await stack.sessions.list(w.ownerId, {}) as unknown as Array<{
          id: string; pendingApprovals: number; ownerItems: Array<{ itemId: string }>;
        }>;
        const row = rows.find((session) => session.id === w.coordinatorSessionId);
        assert.ok(row, 'the coordinator conversation is in the owner’s Open list');
        const tally = (await stack.sessions.workspaceSessionCounts(w.ownerId))
          .find((counts: { workspaceId: string }) => counts.workspaceId === w.workspaceId);
        const signals = (await readOwnerDecisionSignals(stack.db as never, w.ownerId))
          .filter((signal) => signal.projectId === w.projectId && signal.kind === 'OWNER_ITEM');
        const attention = (await readProjectListAttention(stack.prisma, w.ownerId)).get(w.projectId);
        return {
          needsYou: listed.needsYou.map((item) => item.itemId),
          withCoordinator: listed.withCoordinator.map((item) => item.itemId),
          rowOwnerItems: row.ownerItems.map((item) => item.itemId),
          rowCount: row.pendingApprovals,
          workspaceNeedsYou: tally?.needsYou ?? 0,
          badge: (await push.needsYouSessions(w.ownerId)).includes(w.coordinatorSessionId),
          signals: signals.flatMap((signal) => (signal.items ?? []).map((item) => item.itemId)),
          listOwnerItems: (attention?.ownerItems ?? []).map((item) => [item.kind, item.count]),
          listCoordinatorItems: attention?.coordinatorItems?.count ?? 0,
        };
      };

      // The zombies: the 2026-10-02 item, escalated to the owner about a superseded candidate, and a
      // conflict the coordinator holds about a task that was cancelled.
      const superseded = await candidate(stack, w, 'SUPERSEDED');
      const gone = await task(stack, w, TaskStatus.CANCELLED, 'cancelled');
      const zombie = await openItem(stack, w, {
        kind: 'INTEGRATION_CHECK_FAILED', promotionId: superseded,
        assignee: 'OWNER', assigneeReason: 'ESCALATED', escalatedAt: new Date(),
      });
      await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', taskId: gone });

      assert.deepEqual(await reads(), {
        needsYou: [],
        withCoordinator: [],
        rowOwnerItems: [],
        rowCount: 0,
        workspaceNeedsYou: 0,
        badge: false,
        signals: [],
        listOwnerItems: [],
        listCoordinatorItems: 0,
      }, 'an item nobody owes is in front of nobody — not the project page, the session row, the '
        + 'workspace, the badge, Needs you or the project list');
      await push.notifyOwnerItem(zombie);
      assert.deepEqual(pushed, [], 'and nobody’s phone rings about it');

      // The same two, owed: a failed check about a candidate that is truly BLOCKED, and a conflict
      // about a task still being worked. Every reader counts exactly these.
      const blocked = await candidate(stack, w, 'BLOCKED');
      const live = await task(stack, w, TaskStatus.OPEN, 'live');
      const escalated = await openItem(stack, w, {
        kind: 'INTEGRATION_CHECK_FAILED', promotionId: blocked,
        assignee: 'OWNER', assigneeReason: 'ESCALATED', escalatedAt: new Date(),
      });
      const held = await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', taskId: live });

      assert.deepEqual(await reads(), {
        needsYou: [escalated],
        withCoordinator: [held],
        rowOwnerItems: [escalated],
        rowCount: 1,
        workspaceNeedsYou: 1,
        badge: true,
        signals: [escalated],
        listOwnerItems: [['ESCALATED', 1]],
        listCoordinatorItems: 1,
      }, 'every reader counts the owed items, and only those');
      await push.notifyOwnerItem(escalated);
      assert.deepEqual(pushed, [escalated], 'the owed one rings the phone');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) M-T11 ════════════════════════════════════════════════════════════════════════════════════

test('(4) an item nobody owes does not hold an automatic landing back; an owed one does',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'automatic');
      // The 2026-10-02 shape: a failed check about the candidate the branch had before, escalated
      // and left open, and the candidate after it confirmed by the project's Automatic setting.
      const superseded = await candidate(stack, w, 'SUPERSEDED', { sourceRef: w.integrationRef });
      await openItem(stack, w, {
        kind: 'INTEGRATION_CHECK_FAILED', promotionId: superseded,
        assignee: 'OWNER', assigneeReason: 'ESCALATED', escalatedAt: new Date(),
      });
      const confirmed = await candidate(stack, w, 'CONFIRMED', {
        sourceRef: w.integrationRef,
        confirmedAutomatically: true,
        confirmedAt: new Date(),
        checks: [GREEN_CHECK],
        upstreamShaChecked: sha('f'),
        mergeTreeSha: sha('3'),
      });
      const refusal = () => stack.db.$transaction((tx) => automaticLandingRefusal(tx, confirmed, true));

      assert.equal(await refusal(), null,
        'the landing goes out: the only open integration item is about a candidate that is gone');

      const blocked = await candidate(stack, w, 'BLOCKED');
      await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', promotionId: blocked });
      assert.equal(await refusal(), 'an integration exception is still open on this project',
        'an owed integration item still holds it back');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (5) a project that looks finished ════════════════════════════════════════════════════════════

test('(5) a project that looks finished still does with an item nobody owes open, not with an owed one',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'finished');
      // One criterion, stated and confirmed at the owner's doors, and the task serving it DONE with
      // its work on the project branch: met, and not on main — the shape that looks finished.
      await stack.projects.update(w.ownerId, w.projectId, {
        acceptanceCriteriaItems: [{
          text: 'only what somebody owes is in front of anybody',
          verificationMethod: 'A person reads it and says whether it holds',
        }],
      } as never);
      const standing = await stack.acceptance.standardSetConfirmation(w.ownerId, w.projectId);
      await stack.acceptance.confirmStandardSet(w.ownerId, w.projectId, {
        criteriaDigest: standing.currentVersion.digest,
      });
      const [definition] = await stack.db.projectAcceptanceCriterionDefinition.findMany({
        where: { projectId: w.projectId }, select: { id: true },
      });
      const served = await stack.tasks.create(w.ownerId, {
        title: 'the backstop',
        projectId: w.projectId,
        criterionKey: criterionKeyOf(definition!.id),
        completionCriterion: 'EXECUTABLE',
        acceptanceCommand: 'true',
        acceptanceExpectedExitCode: 0,
        autoRunWhenReady: false,
      } as never);
      const work = await workSession(stack, w, served.id, 'orbit/the-backstop');
      const settled = await stack.db.$executeRaw`
        UPDATE "task" SET "status" = 'DONE'
         WHERE "id" = ${served.id}::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`;
      assert.equal(settled, 1, 'the serving task reached DONE');
      await stack.receipts.record(w.ownerId, work, {
        result: 'MERGED',
        sourceSha: sha('4'),
        targetBranch: w.integrationRef.replace(/^refs\/heads\//, ''),
        targetShaBefore: sha('5'),
        targetShaAfter: sha('6'),
      }, 'RUNNER');
      const finish = async () => (await readProjectFinish(stack.prisma, w.projectId)).state;
      assert.equal(await finish(), 'LOOKS_FINISHED', 'the fixture looks finished before any item');

      // A conflict left open about a task that was cancelled: nobody is handling anything.
      const gone = await task(stack, w, TaskStatus.CANCELLED, 'cancelled');
      await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', taskId: gone });
      assert.equal(await finish(), 'LOOKS_FINISHED',
        'an item about a task that is gone does not keep the project from looking finished');

      // The same item about the task that is done and not yet landed is somebody's work.
      await openItem(stack, w, { kind: 'INTEGRATION_CONFLICT', taskId: served.id });
      assert.equal(await finish(), 'NOT_FINISHED', 'an owed item does');
    } finally {
      await stack.db.$disconnect();
    }
  });
