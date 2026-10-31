import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { PREREQUISITE_NOT_LANDED_MESSAGE, prerequisiteNotOnLineMessage } from '../tasks/task-dependencies';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemEscalationService } from './open-item-escalation.service';
import { readOwnerDecisionSignals } from './owner-decision-signal';
import { readProjectListAttention } from './project-list-attention';
import {
  ownerItemKind,
  recordLandedWithoutConfirmation,
  recordLandingUnobserved,
  type LandingUnobserved,
} from './project-open-item';
import {
  OPEN_ITEM_CONDITION_STANDS,
  OPEN_ITEM_HAS_ITS_OWN_DOOR,
  OPEN_ITEM_NOT_OPEN,
  OPEN_ITEM_NOT_RETURNABLE,
  OPEN_ITEM_OWNER_ONLY,
  ProjectOpenItemService,
} from './project-open-item.service';

/**
 * The two open items revision 29 adds, their doors, O-X1 and J9's refusal
 * (`docs/project-integration-line-contract.md` §10.7, §10.8, §10.9; §4.2 and §4.7 as revision 29
 * folded them).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-observation-open-items.pg.spec.ts
 *
 *  (1) §10.7: `LANDING_UNOBSERVED` opens for an Automatic project's live coordinator, once per
 *      delivered commit, with the title, key and payload the contract spells, and is delivered to it
 *      as a turn that names the doors its cell holds;
 *  (2) §10.7: it is the owner's at birth when Automatic is off or the conversation ended — an
 *      escalation as far as the owner's surfaces are concerned — and an unknown identity keys by
 *      `identity`;
 *  (3) §10.7 O-R1: a landing receipt on the line closes it RESOLVED / LANDED in the receipt's own
 *      transaction — the agent's `merge_receipt`, the Merge button's result and the platform's
 *      landing — while a receipt on some other branch does not;
 *  (4) §10.7: cancelled → TASK_CLOSED, replaced → SUCCESSOR_FILED, `task_reopen` → RETRIED,
 *      declared codeless → CODELESS through the task doors (`resolveByFact`), and the backstop writes
 *      the same ending as the edge when the edge was missed, LANDED included;
 *  (5) §10.7 §4.7: `open_item_resolve` refuses it (OPEN_ITEM_HAS_ITS_OWN_DOOR) for the coordinator
 *      and the owner, and `open_item_hand_over` gives it to the owner;
 *  (6) §10.7 §10.8: `LANDED_WITHOUT_CONFIRMATION` is the owner's from birth, never delivered to the
 *      coordinator, closed only by the owner's Accept (RESOLVED / ACCEPTED, USER) — not by a request
 *      from a session, not by `open_item_resolve`, not sent back to the coordinator — and by
 *      `resolveByFact` when its task is cancelled or replaced; pushed once after the receipt's commit
 *      and counted in Needs-you and the project list until then (owner 2026-10-28, §7.6 V12/V13);
 *  (7) O-X1 (§10.9 5): a task-landing `INTEGRATION_*` item — by `task_id`, or by a `TASK_BRANCH`
 *      candidate — is not closed by hand while its task is NOT_KNOWN and a dependent waits: 409
 *      OPEN_ITEM_CONDITION_STANDS naming only the doors its cell has; once the work lands, or the
 *      dependents are over, it closes as before;
 *  (8) J9 (§10.9): a refused start names an OPEN `LANDING_UNOBSERVED`, keeps the old sentence while
 *      a job is in flight, and writes the old sentence with a warn line when neither exists.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const HOUR = 3_600_000;
const sha = (nibble: string) => nibble.repeat(40);

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
  sessions: SessionsService;
  openItems: ProjectOpenItemService;
  tasks: TasksService;
  receipts: MergeReceiptService;
  /** The items the owner's phone was told about (`notifyOwnerItem`), in order. */
  pushed: string[];
  /** What `TasksService` warned about. */
  warned: string[];
}

/** The services the doors live in, over one client: the task doors reach the open items through
 *  `resolveByFact`, as they do in the app, and the push reaches no device. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const pushed: string[] = [];
  const push = new Proxy({}, {
    get: (_target, method) => (...args: unknown[]) => {
      if (method === 'notifyOwnerItem') pushed.push(String(args[0]));
      return Promise.resolve();
    },
  }) as unknown as PushService;
  const openItems = new ProjectOpenItemService(prisma, sessions, push);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  const warned: string[] = [];
  (tasks as unknown as { logger: object }).logger = new Proxy({}, {
    get: (_target, method) => (message: unknown) => {
      if (method === 'warn') warned.push(String(message));
    },
  });
  // The fifth argument is the owner-item notifier R29-9 adds (§7.6 V12); a tree without it ignores it.
  const receipts = new (MergeReceiptService as unknown as new (...args: unknown[]) => MergeReceiptService)(
    prisma, undefined, undefined, undefined, push,
  );
  return { db, sessions, openItems, tasks, receipts, pushed, warned };
}

type Coordinator = 'LIVE' | 'OFF' | 'ENDED';

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  coordinatorSessionId: string;
  codebaseId: string;
  upstreamRef: string;
  integrationRef: string;
  /** The line's short name: the branch the item's title and J9's sentence name. */
  line: string;
}

/**
 * One owner, one runner and workspace, the conversation the project is coordinated from, and a
 * project whose line has started — on main, or on a branch of its own.
 */
async function world(
  stack: Stack,
  label: string,
  options: { line?: 'MAIN' | 'PROJECT_BRANCH'; coordinator?: Coordinator } = {},
): Promise<World> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const coordinator = options.coordinator ?? 'LIVE';
  await db.user.create({
    data: {
      id: ownerId, email: `${label}-${ownerId}@landing-items.invalid`, name: label, passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}.git`, workDir: `/srv/${label}`,
    },
  });
  await db.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
      title: `coordinator: ${label}`, prompt: `coordinator: ${label}`, provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
      // An ended conversation is one somebody filed as Completed: over, and not merely down.
      ...(coordinator === 'ENDED' ? { completedAt: new Date() } : {}),
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message', content: `coordinator: ${label}`, status: 'ANSWERED',
    },
  });
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, goal: 'every wait has somebody behind it',
      coordinatorEnabled: coordinator !== 'OFF', coordinatorWorkspaceId: workspaceId,
      coordinatorSessionId,
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  const line = options.line ?? 'PROJECT_BRANCH';
  const integrationRef = line === 'MAIN' ? 'refs/heads/main' : `refs/heads/project/${projectId.slice(0, 8)}`;
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId, projectId, canonicalRepoUrl: `https://git.invalid/orbit/${label}`,
      upstreamRef: 'refs/heads/main', integrationRef, refAuthority: 'REMOTE', remoteName: 'origin',
      integrationRefSource: 'EXPLICIT', integrationStartedAt: new Date(),
    },
    select: { id: true },
  });
  return {
    ownerId, runnerId, workspaceId, projectId, coordinatorSessionId, codebaseId: codebase.id,
    upstreamRef: 'refs/heads/main', integrationRef,
    line: integrationRef.slice('refs/heads/'.length),
  };
}

/** A task filed under the project through the door a person and an agent both use. */
async function filed(stack: Stack, w: World, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await stack.tasks.create(w.ownerId, {
    title,
    projectId: w.projectId,
    assigneeId: w.workspaceId,
    autoRunWhenReady: false,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    ...extra,
  } as never);
  return created.id;
}

interface Done {
  taskId: string;
  sessionId: string;
  branch: string;
  title: string;
}

/** Finished code work: DONE, and the worktree session whose branch did it. The session reports no
 *  changed files, so the task may still be declared codeless (`readTaskCommitEvidence`). */
async function doneTask(stack: Stack, w: World, title: string): Promise<Done> {
  const taskId = await filed(stack, w, title);
  const branch = `orbit/${title}`;
  const sessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, provider: 'claude', status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, isolationStatus: 'worktree',
      branch, baseSha: sha('b'), completedAt: new Date(),
    },
  });
  await stack.db.task.update({ where: { id: taskId }, data: { status: TaskStatus.DONE } });
  return { taskId, sessionId, branch, title };
}

/** The dependent: waits on one prerequisite and is started by hand. */
function dependentOf(stack: Stack, w: World, title: string, prerequisiteId: string): Promise<string> {
  return filed(stack, w, title, { dependsOnTaskIds: [prerequisiteId] });
}

/** §10.7's `LANDING_UNOBSERVED`, opened the way the observation's result (O-R4) and the identity
 *  freeze (O-T1) open it: in a transaction of the caller's. */
function openUnobserved(stack: Stack, t: Done, over: Partial<LandingUnobserved> = {}) {
  return stack.db.$transaction((tx) => recordLandingUnobserved(tx, {
    taskId: t.taskId,
    reason: 'NOT_ON_LINE',
    deliveredSha: sha('a'),
    baseSha: sha('b'),
    branch: t.branch,
    sessionId: t.sessionId,
    observedUpstreamSha: sha('c'),
    observedLineSha: sha('d'),
    observedAt: new Date('2026-10-28T12:33:00.000Z'),
    jobId: null,
    ...over,
  }));
}

/** A receipt as the agent's own `merge_receipt` door records it, optionally inside `tx`. */
function agentReceipt(
  stack: Stack,
  w: World,
  t: Done,
  targetBranch: string,
  tx?: Prisma.TransactionClient,
) {
  return stack.receipts.record(w.ownerId, t.sessionId, {
    result: 'ALREADY_MERGED',
    sourceSha: sha('e'),
    targetBranch,
  }, 'AGENT', tx);
}

interface ItemRow {
  id: string;
  kind: string;
  state: string;
  assignee: string;
  assigneeReason: string;
  dedupeKey: string;
  title: string;
  payload: unknown;
  sessionId: string | null;
  integrationJobId: string | null;
  waitingSince: Date;
  escalateAt: Date | null;
  remindAt: Date | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedByUserId: string | null;
  resolvedBySessionId: string | null;
  resolutionNote: string | null;
}

const ITEM_SELECT = {
  id: true, kind: true, state: true, assignee: true, assigneeReason: true, dedupeKey: true, title: true,
  payload: true, sessionId: true, integrationJobId: true, waitingSince: true, escalateAt: true, remindAt: true,
  resolution: true, resolvedBy: true, resolvedByUserId: true, resolvedBySessionId: true, resolutionNote: true,
} as const;

function item(db: Prisma.TransactionClient | PrismaClient, id: string): Promise<ItemRow> {
  return db.projectOpenItem.findUniqueOrThrow({ where: { id }, select: ITEM_SELECT });
}

function itemsOf(stack: Stack, taskId: string, kind: string): Promise<ItemRow[]> {
  return stack.db.projectOpenItem.findMany({ where: { taskId, kind }, select: ITEM_SELECT, orderBy: { createdAt: 'asc' } });
}

/** One open item written as a row, the coordinator's unless `over` says otherwise. */
async function rawItem(stack: Stack, w: World, over: Record<string, unknown> & { kind: string }): Promise<string> {
  const now = new Date();
  const row = await stack.db.projectOpenItem.create({
    data: {
      projectId: w.projectId, ownerId: w.ownerId, state: 'OPEN', assignee: 'COORDINATOR',
      assigneeReason: 'DEFAULT', dedupeKey: `fixture:${randomUUID()}`, title: `${over.kind} fixture`,
      payload: {}, waitingSince: now, assignedAt: now, escalateAt: new Date(now.getTime() + 2 * HOUR),
      ...over,
    } as never,
    select: { id: true },
  });
  return row.id;
}

interface Refusal {
  status: number;
  code: string | undefined;
  message: string;
}

/** What a door answered, when it refused. */
async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as string | { code?: string; message?: unknown };
      return typeof body === 'string'
        ? { status: error.getStatus(), code: undefined, message: body }
        : { status: error.getStatus(), code: body.code, message: String(body.message ?? '') };
    }
    throw error;
  }
  return assert.fail('the door did not refuse');
}

/** The backstop's log, kept rather than printed. */
function quiet(clock: ProjectOpenItemEscalationService): string[] {
  const warned: string[] = [];
  (clock as unknown as { logger: object }).logger = {
    warn: (message: string) => warned.push(message),
    error: (message: string) => warned.push(message),
    log: () => undefined,
  };
  return warned;
}

/** What the projects list and the Needs-you signal count for one project (§7.1 V1, §7.6 V13): the
 *  coordinator's lead kind, the owner's four kinds, and the items behind the owner's signal. */
async function counted(stack: Stack, w: World) {
  const attention = (await readProjectListAttention(stack.db as unknown as PrismaService, w.ownerId)).get(w.projectId);
  const signals = (await readOwnerDecisionSignals(stack.db as never, w.ownerId))
    .filter((signal) => signal.projectId === w.projectId && signal.kind === 'OWNER_ITEM');
  return {
    coordinatorLead: attention?.coordinatorItems?.leadKind ?? null,
    ownerItems: (attention?.ownerItems ?? []).map((owned) => [owned.kind, owned.count]),
    needsYou: signals.flatMap((signal) => (signal.items ?? []).map((owned) => owned.itemId)),
  };
}

/** Every turn on the coordinator conversation after its first. */
async function coordinatorTurns(stack: Stack, w: World): Promise<string[]> {
  const turns = await stack.db.conversationTurn.findMany({
    where: { sessionId: w.coordinatorSessionId, seq: { gt: 1 } },
    orderBy: { seq: 'asc' },
    select: { content: true },
  });
  return turns.map((turn) => turn.content ?? '');
}

// ═══ (1) LANDING_UNOBSERVED opens for the coordinator ════════════════════════════════════════════

test('(1) §10.7: LANDING_UNOBSERVED opens for an Automatic project\'s live coordinator, once per delivered commit, and is delivered naming its cell\'s doors',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'lu-opens', { line: 'MAIN' });
      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: w.projectId }, select: { exceptionEscalationSeconds: true },
      });
      const t = await doneTask(stack, w, 'pushed-a-rebase');
      const jobId = randomUUID();
      const opened = await openUnobserved(stack, t, { reason: 'APPLIED_AS_OTHER_COMMITS', jobId });
      assert.ok(opened, 'nothing was opened');
      assert.equal(opened.assignee, 'COORDINATOR');
      assert.equal(opened.taskId, t.taskId);
      assert.equal(opened.projectId, w.projectId);

      const row = await item(stack.db, opened.itemId);
      assert.equal(row.kind, 'LANDING_UNOBSERVED');
      assert.equal(row.state, 'OPEN');
      assert.equal(row.assignee, 'COORDINATOR');
      assert.equal(row.assigneeReason, 'DEFAULT');
      assert.equal(row.dedupeKey, `LU:${t.taskId}:${sha('a')}`);
      assert.equal(row.title, 'Not on main yet: pushed-a-rebase');
      assert.equal(row.sessionId, t.sessionId, 'the item names the work session that delivered');
      assert.equal(row.integrationJobId, null, 'the observation is named in the payload, not as the item\'s job');
      assert.equal(row.remindAt, null);
      assert.equal(row.escalateAt?.getTime(), row.waitingSince.getTime() + project.exceptionEscalationSeconds * 1_000,
        'a coordinator\'s item escalates on the project\'s window');
      assert.deepEqual(row.payload, {
        reason: 'APPLIED_AS_OTHER_COMMITS',
        deliveredSha: sha('a'),
        baseSha: sha('b'),
        branch: 'orbit/pushed-a-rebase',
        upstreamRef: 'refs/heads/main',
        integrationRef: 'refs/heads/main',
        observedUpstreamSha: sha('c'),
        observedLineSha: sha('d'),
        observedAt: '2026-10-28T12:33:00.000Z',
        jobId,
      });

      // The same delivered commit seen again opens nothing (`LU:<taskId>:<deliveredSha>`).
      assert.equal(await openUnobserved(stack, t, { reason: 'NOT_ON_LINE' }), null);
      assert.equal((await itemsOf(stack, t.taskId, 'LANDING_UNOBSERVED')).length, 1);

      // Delivered to the coordinator once the opening committed, as every item it owes is.
      await stack.openItems.deliverForTasks([t.taskId]);
      const turns = await coordinatorTurns(stack, w);
      assert.equal(turns.length, 1, 'the coordinator was not handed the item');
      const message = turns[0]!;
      assert.match(message, /^From Orbit · exception item: Not on main yet: pushed-a-rebase/);
      for (const door of ['merge_receipt', 'task_reopen', 'open_item_hand_over']) {
        assert.match(message, new RegExp(`\\b${door}\\b`), `the message does not name ${door}`);
      }
      assert.doesNotMatch(message, /\bopen_item_resolve\b/, 'the message offers the hand-close the item refuses');
      assert.doesNotMatch(message, /\bintegration_retry\b/);
      assert.deepEqual(stack.pushed, [], 'an item still the coordinator\'s rang the owner\'s phone');

      // The project page draws it with the coordinator, and the owner's surfaces leave it out.
      const list = await stack.openItems.list(w.ownerId, w.projectId);
      const drawn = list.withCoordinator.find((candidate) => candidate.itemId === opened.itemId);
      assert.ok(drawn, 'the open-items read does not draw it with the coordinator');
      assert.equal(drawn.kind, 'LANDING_UNOBSERVED');
      assert.equal(drawn.actions.includes('RETRY'), false);
      assert.equal(ownerItemKind(row), null);
      assert.deepEqual(await counted(stack, w), { coordinatorLead: 'LANDING_UNOBSERVED', ownerItems: [], needsYou: [] },
        'the projects list does not name what the coordinator holds, or counts it as the owner\'s');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (2) …or the owner's at birth ════════════════════════════════════════════════════════════════

test('(2) §10.7: with Automatic off or the conversation ended it is the owner\'s at birth — told as an escalation — and an unknown identity keys by identity',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const off = await world(stack, 'lu-automatic-off', { coordinator: 'OFF' });
      const offTask = await doneTask(stack, off, 'automatic-off');
      const unknown = await openUnobserved(stack, offTask, {
        reason: 'IDENTITY_UNKNOWN', deliveredSha: null, baseSha: null, observedUpstreamSha: null,
        observedLineSha: null, observedAt: null,
      });
      assert.ok(unknown);
      assert.equal(unknown.assignee, 'OWNER');
      const row = await item(stack.db, unknown.itemId);
      assert.equal(row.assigneeReason, 'NO_COORDINATOR');
      assert.equal(row.escalateAt, null, 'an item already the owner\'s has no clock');
      assert.equal(row.dedupeKey, `LU:${offTask.taskId}:identity`);
      assert.equal(row.title, `Not on ${off.line} yet: automatic-off`);
      assert.equal((row.payload as { reason?: string }).reason, 'IDENTITY_UNKNOWN');
      assert.equal((row.payload as { deliveredSha?: unknown }).deliveredSha, null);
      // An unknown identity is one item however often it is reported.
      assert.equal(await openUnobserved(stack, offTask, {
        reason: 'IDENTITY_UNKNOWN', deliveredSha: null, baseSha: null,
      }), null);

      const ended = await world(stack, 'lu-coordinator-ended', { coordinator: 'ENDED' });
      const endedTask = await doneTask(stack, ended, 'conversation-ended');
      const endedItem = await openUnobserved(stack, endedTask);
      assert.ok(endedItem);
      assert.equal(endedItem.assignee, 'OWNER');
      assert.equal((await item(stack.db, endedItem.itemId)).assigneeReason, 'COORDINATOR_ENDED');

      // The owner is told the way every item that became theirs is told (§7.6 V12).
      await stack.openItems.deliverForTasks([offTask.taskId, endedTask.taskId]);
      assert.deepEqual(stack.pushed.sort(), [unknown.itemId, endedItem.itemId].sort());
      assert.equal(ownerItemKind(row), 'ESCALATED');
      assert.deepEqual(await coordinatorTurns(stack, off), [], 'a switched-off coordinator was handed it');
      const list = await stack.openItems.list(off.ownerId, off.projectId);
      assert.ok(list.needsYou.some((candidate) => candidate.itemId === unknown.itemId));
      assert.deepEqual(await counted(stack, off), {
        coordinatorLead: null, ownerItems: [['ESCALATED', 1]], needsYou: [unknown.itemId],
      }, 'the owner\'s surfaces do not count it the way they count every item that became theirs');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (3) the landing edge ════════════════════════════════════════════════════════════════════════

test('(3) §10.7 O-R1: a receipt on the line closes it RESOLVED / LANDED in the receipt\'s own transaction — merge_receipt, the Merge button and the platform\'s landing — and one off the line does not',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'lu-landed');

      // merge_receipt (the agent's door), first on a branch that says nothing about this line.
      const agent = await doneTask(stack, w, 'agent-records');
      const agentItem = (await openUnobserved(stack, agent))!;
      await agentReceipt(stack, w, agent, 'somewhere-else');
      assert.equal((await item(stack.db, agentItem.itemId)).state, 'OPEN',
        'a receipt off the line closed the item while the task is still NOT_KNOWN');
      // Then on the line, inside a transaction this case holds open: the ending is part of it.
      await stack.db.$transaction(async (tx) => {
        await agentReceipt(stack, w, agent, w.line, tx);
        const inside = await item(tx, agentItem.itemId);
        assert.equal(inside.state, 'RESOLVED', 'the receipt\'s transaction did not close the item');
        assert.equal((await item(stack.db, agentItem.itemId)).state, 'OPEN',
          'the ending was visible before the receipt committed');
      });
      const landed = await item(stack.db, agentItem.itemId);
      assert.equal(landed.resolution, 'LANDED');
      assert.equal(landed.resolvedBy, 'PLATFORM');

      // The Merge button: the runner's merge result, written in the runner's own transaction.
      const button = await doneTask(stack, w, 'merge-button');
      const buttonItem = (await openUnobserved(stack, button))!;
      await stack.db.$transaction((tx) => MergeReceiptService.fromRunnerMergeResult(tx, {
        ownerId: w.ownerId, sessionId: button.sessionId, taskId: button.taskId, projectId: w.projectId,
        result: 'MERGED', sourceBranch: button.branch, sourceSha: sha('6'), targetBranch: 'main',
        targetShaBefore: sha('7'), targetShaAfter: sha('8'), rebaseBaseSha: null, conflicts: [],
        message: null, operationId: null,
      }));
      assert.equal((await item(stack.db, buttonItem.itemId)).resolution, 'LANDED');

      // The platform's landing (J8 / J-T5): the receipt the integration job's result writes.
      const platform = await doneTask(stack, w, 'platform-lands');
      const platformItem = (await openUnobserved(stack, platform))!;
      await stack.db.$transaction(async (tx) => {
        await MergeReceiptService.fromIntegrationJob(tx, {
          ownerId: w.ownerId, sessionId: platform.sessionId, taskId: platform.taskId, projectId: w.projectId,
          jobId: randomUUID(), state: 'LANDED', sourceBranch: platform.branch, targetBranch: w.line,
          sourceSha: sha('9'), targetShaBefore: sha('7'), landedSha: sha('5'), rebaseBaseSha: null,
          testedTreeSha: sha('4'), landedTreeSha: sha('4'), mainSyncSha: null,
        });
        assert.equal((await item(tx, platformItem.itemId)).state, 'RESOLVED');
      });
      assert.equal((await item(stack.db, platformItem.itemId)).resolution, 'LANDED');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (4) the task's own facts, and the backstop ══════════════════════════════════════════════════

test('(4) §10.7: cancelled → TASK_CLOSED, replaced → SUCCESSOR_FILED, task_reopen → RETRIED, codeless → CODELESS through the task doors; the backstop writes the same endings, LANDED included',
  { skip, timeout: 240_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'lu-task-facts');
      const ending = async (taskId: string) => {
        const [row] = await itemsOf(stack, taskId, 'LANDING_UNOBSERVED');
        return { state: row!.state, resolution: row!.resolution, resolvedBy: row!.resolvedBy };
      };

      const cancelled = await doneTask(stack, w, 'cancelled');
      await openUnobserved(stack, cancelled);
      await stack.tasks.update(w.ownerId, cancelled.taskId, { status: TaskStatus.CANCELLED } as never);
      assert.deepEqual(await ending(cancelled.taskId),
        { state: 'RESOLVED', resolution: 'TASK_CLOSED', resolvedBy: 'PLATFORM' });

      const replaced = await doneTask(stack, w, 'replaced');
      await openUnobserved(stack, replaced);
      const successor = await filed(stack, w, 'successor');
      await stack.tasks.update(w.ownerId, replaced.taskId, {
        status: TaskStatus.CANCELLED, supersededByTaskId: successor,
      } as never);
      assert.deepEqual(await ending(replaced.taskId),
        { state: 'RESOLVED', resolution: 'SUCCESSOR_FILED', resolvedBy: 'PLATFORM' });

      const reopened = await doneTask(stack, w, 'reopened');
      await openUnobserved(stack, reopened);
      // `task_reopen`'s own body (src/runner-go/task_reopen.go).
      await stack.tasks.update(w.ownerId, reopened.taskId, {
        status: TaskStatus.OPEN, supersededByTaskId: null, terminalReason: null,
      } as never);
      assert.deepEqual(await ending(reopened.taskId),
        { state: 'RESOLVED', resolution: 'RETRIED', resolvedBy: 'PLATFORM' });

      const codeless = await doneTask(stack, w, 'codeless');
      await openUnobserved(stack, codeless);
      await stack.tasks.update(w.ownerId, codeless.taskId, {
        codeless: true, codelessReason: 'its changes live in another repository',
      } as never);
      assert.deepEqual(await ending(codeless.taskId),
        { state: 'RESOLVED', resolution: 'CODELESS', resolvedBy: 'PLATFORM' });

      // The backstop: the same facts written with no edge behind them, an item each — and beside
      // each one an item of the same shape that `resolveByFact` closes, so the two endings compare.
      const shapes: Array<{ name: string; make: (t: Done) => Promise<void>; resolution: string }> = [
        {
          name: 'cancelled',
          make: async (t) => { await stack.db.task.update({ where: { id: t.taskId }, data: { status: TaskStatus.CANCELLED } }); },
          resolution: 'TASK_CLOSED',
        },
        {
          name: 'reopened',
          make: async (t) => { await stack.db.task.update({ where: { id: t.taskId }, data: { status: TaskStatus.OPEN } }); },
          resolution: 'RETRIED',
        },
        {
          name: 'codeless',
          make: async (t) => {
            await stack.db.task.update({ where: { id: t.taskId }, data: { codeless: true, codelessReason: 'not code' } });
          },
          resolution: 'CODELESS',
        },
        {
          name: 'landed',
          make: async (t) => {
            await stack.db.sessionMergeReceipt.create({
              data: {
                ownerId: w.ownerId, sessionId: t.sessionId, taskId: t.taskId, projectId: w.projectId,
                result: 'ALREADY_MERGED', sourceBranch: t.branch, sourceSha: sha('f'), targetBranch: w.line,
                recordedBy: 'AGENT', idempotencyKey: `fixture:${randomUUID()}`,
              },
            });
          },
          resolution: 'LANDED',
        },
      ];
      const zombies: Array<{ itemId: string; resolution: string }> = [];
      for (const shape of shapes) {
        const zombie = await doneTask(stack, w, `zombie-${shape.name}`);
        const zombieItem = (await openUnobserved(stack, zombie))!;
        await shape.make(zombie);
        zombies.push({ itemId: zombieItem.itemId, resolution: shape.resolution });

        const edged = await doneTask(stack, w, `edged-${shape.name}`);
        const edgedItem = (await openUnobserved(stack, edged))!;
        await shape.make(edged);
        await stack.openItems.resolveByFact([edged.taskId]);
        const byEdge = await item(stack.db, edgedItem.itemId);
        assert.equal(byEdge.resolution, shape.resolution, `resolveByFact wrote the wrong ending for ${shape.name}`);
        assert.equal(byEdge.resolutionNote, null);
      }
      // And one still owed: DONE, not landed, not replaced.
      const owed = await doneTask(stack, w, 'still-owed');
      const owedItem = (await openUnobserved(stack, owed))!;

      const clock = new ProjectOpenItemEscalationService(stack.db as unknown as PrismaService);
      const warned = quiet(clock);
      await clock.reconcile();
      for (const zombie of zombies) {
        const closed = await item(stack.db, zombie.itemId);
        assert.equal(closed.state, 'RESOLVED');
        assert.equal(closed.resolution, zombie.resolution, 'the backstop and the edge disagree');
        assert.equal(closed.resolvedBy, 'PLATFORM');
        assert.match(closed.resolutionNote ?? '', /^backstop: task /);
        assert.ok(warned.some((line) => line.includes(zombie.itemId)), 'the backstop did not report the missed edge');
      }
      assert.equal((await item(stack.db, owedItem.itemId)).state, 'OPEN', 'the backstop closed an item still owed');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (5) open_item_resolve refuses it; the hand-over takes it ════════════════════════════════════

test('(5) §10.7 §4.7: open_item_resolve refuses LANDING_UNOBSERVED (OPEN_ITEM_HAS_ITS_OWN_DOOR) and open_item_hand_over gives it to the owner',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'lu-doors');
      const t = await doneTask(stack, w, 'not-seen');
      const opened = (await openUnobserved(stack, t))!;

      const byCoordinator = await refusal(() => stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, opened.itemId, { note: 'I checked, it is fine' },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(byCoordinator.status, 409);
      assert.equal(byCoordinator.code, OPEN_ITEM_HAS_ITS_OWN_DOOR);
      assert.match(byCoordinator.message, /\bmerge_receipt\b/);
      assert.match(byCoordinator.message, /\btask_reopen\b/);
      const byOwner = await refusal(() => stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, opened.itemId, { note: 'close it' }, { kind: 'OWNER' }));
      assert.equal(byOwner.status, 409);
      assert.equal(byOwner.code, OPEN_ITEM_HAS_ITS_OWN_DOOR);
      assert.equal((await item(stack.db, opened.itemId)).state, 'OPEN');

      const handed = await stack.openItems.handOver(
        w.ownerId, w.projectId, opened.itemId, { note: 'the owner has to push from their machine' },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId });
      assert.equal(handed.assignee, 'OWNER');
      assert.equal(handed.assigneeReason, 'HANDED_OVER');
      const row = await item(stack.db, opened.itemId);
      assert.equal(row.state, 'OPEN');
      assert.equal(row.assignee, 'OWNER');
      assert.equal(row.escalateAt, null);
      assert.equal(ownerItemKind(row), 'ESCALATED');
      assert.deepEqual(stack.pushed, [opened.itemId], 'the owner was not told it is theirs now');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (6) LANDED_WITHOUT_CONFIRMATION and its Accept ══════════════════════════════════════════════

/** The LANDED_WITHOUT_CONFIRMATION an agent's receipt onto main opened (§10.6 O-R3, R29-5). */
async function raisedFor(stack: Stack, w: World, taskId: string, receiptId: string): Promise<{ itemId: string }> {
  const raised = await stack.db.projectOpenItem.findFirst({
    where: { projectId: w.projectId, dedupeKey: `UL:${taskId}:${receiptId}` },
    select: { id: true },
  });
  assert.ok(raised, 'the agent\'s receipt onto main opened LANDED_WITHOUT_CONFIRMATION');
  return { itemId: raised.id };
}

test('(6) §10.7 §10.8: LANDED_WITHOUT_CONFIRMATION is the owner\'s from birth, and only the owner\'s Accept ends it ACCEPTED',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'ul-accept', { line: 'MAIN' });
      const t = await doneTask(stack, w, 'pushed-to-main');
      const { receipt } = await agentReceipt(stack, w, t, 'main');
      // §10.6 O-R3 (R29-5): an agent's receipt onto a PLATFORM project's main opens it, in the
      // receipt's own transaction, through `recordLandedWithoutConfirmation`.
      const raised = await stack.db.projectOpenItem.findFirst({
        where: { projectId: w.projectId, dedupeKey: `UL:${t.taskId}:${receipt.id}` },
        select: { id: true, assignee: true },
      });
      assert.ok(raised, 'the agent\'s receipt onto main opened it');
      const opened = { itemId: raised.id, assignee: raised.assignee };
      assert.equal(opened.assignee, 'OWNER');
      // §7.6 V12 (owner 2026-10-28): the receipt's commit pushed it, once.
      assert.deepEqual(stack.pushed, [opened.itemId], 'the owner\'s phone was not told once');
      const row = await item(stack.db, opened.itemId);
      assert.equal(row.kind, 'LANDED_WITHOUT_CONFIRMATION');
      assert.equal(row.assignee, 'OWNER');
      assert.equal(row.assigneeReason, 'DEFAULT');
      assert.equal(row.escalateAt, null, 'it never escalates');
      assert.equal(row.remindAt, null, 'nobody is reminded of it');
      assert.equal(row.dedupeKey, `UL:${t.taskId}:${receipt.id}`);
      assert.equal(row.title, 'Reached main without your confirmation: pushed-to-main');
      assert.equal(row.sessionId, t.sessionId);
      assert.deepEqual(row.payload, {
        receiptId: receipt.id, recordedBy: 'AGENT', targetBranch: 'main', sourceSha: sha('e'), observed: false,
      });
      assert.equal(await stack.db.$transaction((tx) =>
        recordLandedWithoutConfirmation(tx, { taskId: t.taskId, receiptId: receipt.id })), null,
      'the same receipt opened a second item');

      // Never delivered to a coordinator conversation, and never pushed a second time by a later
      // delivery; the fifth thing the owner's surfaces count, by its own name (§7.6 V12/V13, owner
      // 2026-10-28: the owner's by DEFAULT, like a merge approval, not by escalation).
      await stack.openItems.deliverForTasks([t.taskId]);
      await stack.openItems.deliverOwed(w.projectId);
      assert.deepEqual(await coordinatorTurns(stack, w), []);
      assert.equal(await stack.db.projectOpenItemDelivery.count({ where: { itemId: opened.itemId } }), 0);
      assert.deepEqual(stack.pushed, [opened.itemId], 'a later delivery pushed it again');
      assert.equal(ownerItemKind(row), 'LANDED_WITHOUT_CONFIRMATION');
      const list = await stack.openItems.list(w.ownerId, w.projectId);
      const drawn = list.needsYou.find((candidate) => candidate.itemId === opened.itemId);
      assert.ok(drawn, 'the owner\'s open items do not draw it');
      assert.deepEqual(drawn.actions, ['ACCEPT', 'OPEN_TASK_SESSION']);
      assert.equal(drawn.primaryAction, 'ACCEPT');
      assert.deepEqual(await counted(stack, w), {
        coordinatorLead: null, ownerItems: [['LANDED_WITHOUT_CONFIRMATION', 1]], needsYou: [opened.itemId],
      }, 'the project list and the Needs-you signal count it, as they count a merge approval');

      // Its doors are Accept and nothing that ends it another way.
      const resolved = await refusal(() => stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, opened.itemId, { note: 'fine' }, { kind: 'OWNER' }));
      assert.equal(resolved.code, OPEN_ITEM_HAS_ITS_OWN_DOOR);
      const returned = await refusal(() => stack.openItems.returnToCoordinator(w.ownerId, w.projectId, opened.itemId));
      assert.equal(returned.code, OPEN_ITEM_NOT_RETURNABLE);

      // Only the owner presses Accept: a request made from a session is refused whatever credential
      // came with it, another account finds nothing, and Accept answers no other kind.
      const fromSession = await refusal(() => stack.openItems.acceptOpenItem(
        w.ownerId, w.projectId, opened.itemId, w.coordinatorSessionId));
      assert.equal(fromSession.status, 403);
      assert.equal(fromSession.code, OPEN_ITEM_OWNER_ONLY);
      const stranger = await world(stack, 'ul-stranger');
      const notTheirs = await refusal(() => stack.openItems.acceptOpenItem(stranger.ownerId, w.projectId, opened.itemId));
      assert.equal(notTheirs.status, 404);
      const unobserved = (await openUnobserved(stack, await doneTask(stack, w, 'another')))!;
      const wrongKind = await refusal(() => stack.openItems.acceptOpenItem(w.ownerId, w.projectId, unobserved.itemId));
      assert.equal(wrongKind.status, 409);
      assert.equal(wrongKind.code, OPEN_ITEM_HAS_ITS_OWN_DOOR);
      assert.equal((await item(stack.db, opened.itemId)).state, 'OPEN', 'a refused Accept wrote something');

      const accepted = await stack.openItems.acceptOpenItem(w.ownerId, w.projectId, opened.itemId);
      assert.deepEqual(accepted, { itemId: opened.itemId, state: 'RESOLVED', resolution: 'ACCEPTED' });
      const ended = await item(stack.db, opened.itemId);
      assert.equal(ended.state, 'RESOLVED');
      assert.equal(ended.resolution, 'ACCEPTED');
      assert.equal(ended.resolvedBy, 'USER');
      assert.equal(ended.resolvedByUserId, w.ownerId);
      assert.equal(ended.resolvedBySessionId, null);
      const again = await refusal(() => stack.openItems.acceptOpenItem(w.ownerId, w.projectId, opened.itemId));
      assert.equal(again.code, OPEN_ITEM_NOT_OPEN);
      // The owner's surfaces only: the LANDING_UNOBSERVED opened above for the wrong-kind press is the
      // coordinator's, and the list names it as such.
      const ownersAfterAccept = await counted(stack, w);
      assert.deepEqual({ ownerItems: ownersAfterAccept.ownerItems, needsYou: ownersAfterAccept.needsYou },
        { ownerItems: [], needsYou: [] }, 'an accepted item is still counted');

      // Its task cancelled, or replaced: `resolveByFact` ends it the way it ends the others.
      const cancelled = await doneTask(stack, w, 'cancelled-after');
      const cancelledReceipt = (await agentReceipt(stack, w, cancelled, 'main')).receipt;
      const cancelledItem = await raisedFor(stack, w, cancelled.taskId, cancelledReceipt.id);
      await stack.tasks.update(w.ownerId, cancelled.taskId, { status: TaskStatus.CANCELLED } as never);
      const closed = await item(stack.db, cancelledItem.itemId);
      assert.deepEqual([closed.state, closed.resolution, closed.resolvedBy], ['RESOLVED', 'TASK_CLOSED', 'PLATFORM']);

      const replaced = await doneTask(stack, w, 'replaced-after');
      const replacedReceipt = (await agentReceipt(stack, w, replaced, 'main')).receipt;
      const replacedItem = await raisedFor(stack, w, replaced.taskId, replacedReceipt.id);
      const successor = await filed(stack, w, 'successor-after');
      await stack.tasks.update(w.ownerId, replaced.taskId, {
        status: TaskStatus.CANCELLED, supersededByTaskId: successor,
      } as never);
      const superseded = await item(stack.db, replacedItem.itemId);
      assert.deepEqual([superseded.state, superseded.resolution], ['RESOLVED', 'SUCCESSOR_FILED']);
      const ownersAtTheEnd = await counted(stack, w);
      assert.deepEqual({ ownerItems: ownersAtTheEnd.ownerItems, needsYou: ownersAtTheEnd.needsYou },
        { ownerItems: [], needsYou: [] }, 'an item whose task was cancelled or replaced is still counted');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (7) O-X1 ════════════════════════════════════════════════════════════════════════════════════

test('(7) O-X1 (§10.9 5): a task-landing INTEGRATION_* item is not closed by hand while its task is NOT_KNOWN and a dependent waits, and closes as before once the work lands',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'ox1-task');
      const t = await doneTask(stack, w, 'failed-landing');
      await dependentOf(stack, w, 'waits-for-it', t.taskId);
      const error = await rawItem(stack, w, {
        kind: 'INTEGRATION_ERROR', taskId: t.taskId, sessionId: t.sessionId,
        payload: { jobKind: 'LAND_TASK', failureClass: 'ERROR', errorCode: 'TARGET_MOVED' },
      });
      const conflict = await rawItem(stack, w, {
        kind: 'INTEGRATION_CONFLICT', taskId: t.taskId, sessionId: t.sessionId,
        payload: { jobKind: 'LAND_TASK', phase: 'MERGE', failureClass: 'CONFLICT', files: ['src/a.ts'] },
      });

      const stands = await refusal(() => stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, error, { note: 'dealt with it' },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(stands.status, 409);
      assert.equal(stands.code, OPEN_ITEM_CONDITION_STANDS);
      // The doors this cell really has, and none it has not.
      for (const door of ['integration_retry', 'task_reopen', 'open_item_hand_over']) {
        assert.match(stands.message, new RegExp(`\\b${door}\\b`), `the refusal does not name ${door}`);
      }
      for (const door of ['integration_observe', 'merge_receipt']) {
        assert.doesNotMatch(stands.message, new RegExp(`\\b${door}\\b`), `the refusal names ${door}, which this cell has not`);
      }
      const conflictStands = await refusal(() => stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, conflict, { note: 'dealt with it' },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId }));
      assert.equal(conflictStands.code, OPEN_ITEM_CONDITION_STANDS);
      assert.doesNotMatch(conflictStands.message, /\bintegration_retry\b/, 'a conflict\'s refusal offers the rerun it is refused');
      assert.match(conflictStands.message, /\btask_reopen\b/);
      const ownerStands = await refusal(() => stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, error, { note: 'dealt with it' }, { kind: 'OWNER' }));
      assert.equal(ownerStands.code, OPEN_ITEM_CONDITION_STANDS);
      assert.equal((await item(stack.db, error)).state, 'OPEN');

      // The work lands on the line: the condition is gone and the item closes as it always did.
      await agentReceipt(stack, w, t, w.line);
      const closed = await stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, error, { note: 'the work is on the line' },
        { kind: 'SESSION', sessionId: w.coordinatorSessionId });
      assert.deepEqual(closed, { itemId: error, state: 'RESOLVED', resolution: 'HANDLED' });

      // A task nothing waits on is closed by hand as before.
      const alone = await doneTask(stack, w, 'nothing-waits');
      const aloneItem = await rawItem(stack, w, {
        kind: 'INTEGRATION_CHECK_FAILED', taskId: alone.taskId, sessionId: alone.sessionId,
        payload: { jobKind: 'LAND_TASK', failureClass: 'CHECK_FAILED' },
      });
      assert.equal((await stack.openItems.resolveOpenItem(
        w.ownerId, w.projectId, aloneItem, { note: 'no one waits' }, { kind: 'OWNER' })).resolution, 'HANDLED');

      // A TASK_BRANCH candidate's failure is a task-landing item too (MAIN line).
      const main = await world(stack, 'ox1-candidate', { line: 'MAIN' });
      const u = await doneTask(stack, main, 'offered-to-main');
      const dependent = await dependentOf(stack, main, 'waits-on-main', u.taskId);
      const promotionId = randomUUID();
      await stack.db.projectPromotion.create({
        data: {
          id: promotionId, projectId: main.projectId, ownerId: main.ownerId, codebaseId: main.codebaseId,
          sourceKind: 'TASK_BRANCH', taskId: u.taskId, sessionId: u.sessionId,
          sourceRef: `refs/heads/${u.branch}`, sourceSha: sha('3'), upstreamRef: main.upstreamRef, state: 'BLOCKED',
        } as never,
      });
      const checkFailed = await rawItem(stack, main, {
        kind: 'INTEGRATION_CHECK_FAILED', promotionId,
        payload: { jobKind: 'CHECK_PROMOTION', failureClass: 'CHECK_FAILED' },
      });
      const candidateStands = await refusal(() => stack.openItems.resolveOpenItem(
        main.ownerId, main.projectId, checkFailed, { note: 'dealt with it' },
        { kind: 'SESSION', sessionId: main.coordinatorSessionId }));
      assert.equal(candidateStands.code, OPEN_ITEM_CONDITION_STANDS);
      assert.match(candidateStands.message, /\bintegration_retry\b/);
      assert.doesNotMatch(candidateStands.message, /\btask_reopen\b/, 'a candidate\'s cell has no task_reopen');
      // Every dependent over: nothing waits, so it closes.
      await stack.db.task.update({ where: { id: dependent }, data: { status: TaskStatus.CANCELLED } });
      assert.equal((await stack.openItems.resolveOpenItem(
        main.ownerId, main.projectId, checkFailed, { note: 'nobody waits any more' },
        { kind: 'SESSION', sessionId: main.coordinatorSessionId })).resolution, 'HANDLED');
    } finally {
      await stack.db.$disconnect();
    }
  });

// ═══ (8) J9's refusal ════════════════════════════════════════════════════════════════════════════

test('(8) J9 (§10.9): a refused start names an OPEN LANDING_UNOBSERVED, keeps the old sentence while a job is in flight, and writes it with a warn when neither',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'j9-words');
      const refused = async (taskId: string) => {
        try {
          await stack.tasks.execute(w.ownerId, taskId);
        } catch (error) {
          return (error as Error).message;
        }
        return assert.fail('the start was not refused');
      };

      // (a) An OPEN LANDING_UNOBSERVED on the prerequisite: the refusal says where to look.
      const seen = await doneTask(stack, w, 'not-on-the-line');
      await openUnobserved(stack, seen);
      const a = await dependentOf(stack, w, 'waits-a', seen.taskId);
      assert.equal(await refused(a), prerequisiteNotOnLineMessage(w.line));
      assert.equal(prerequisiteNotOnLineMessage(w.line),
        `A prerequisite is finished but its work is not on ${w.line} yet — see “Not on ${w.line} yet” in open items`);

      // (b) No item, but a job in flight that will answer: the old sentence.
      const queued = await doneTask(stack, w, 'being-observed');
      const generation = 1;
      await stack.db.$executeRaw(Prisma.sql`
        INSERT INTO "project_integration_job" (
          "id", "project_id", "owner_id", "codebase_id", "kind", "generation", "state", "serial_key",
          "target_ref", "upstream_ref", "source_ref", "idempotency_key", "updated_at")
        VALUES (${randomUUID()}::uuid, ${w.projectId}::uuid, ${w.ownerId}::uuid, ${w.codebaseId}::uuid,
                'OBSERVE_LANDING', ${generation}, 'QUEUED', ${`https://git.invalid/orbit/j9-words#observe:${w.projectId}`},
                ${w.integrationRef}, ${w.upstreamRef}, ${w.integrationRef},
                ${`ij:v1:OBSERVE_LANDING:${w.projectId}:${generation}`}, now())`);
      const b = await dependentOf(stack, w, 'waits-b', queued.taskId);
      assert.equal(await refused(b), PREREQUISITE_NOT_LANDED_MESSAGE);
      assert.deepEqual(stack.warned.filter((line) => line.includes(queued.taskId)), [],
        'a wait with a job behind it was reported as having none');
      // (a) again, with the job in flight beside the item: the item is what it names.
      assert.equal(await refused(a), prerequisiteNotOnLineMessage(w.line));

      // (c) Neither, in a project with no job in flight: the old sentence, and one warn line naming it.
      const lone = await world(stack, 'j9-nobody');
      const nobody = await doneTask(stack, lone, 'nobody-behind-it');
      const c = await dependentOf(stack, lone, 'waits-c', nobody.taskId);
      let message: string | null = null;
      try {
        await stack.tasks.execute(lone.ownerId, c);
      } catch (error) {
        message = (error as Error).message;
      }
      assert.equal(message, PREREQUISITE_NOT_LANDED_MESSAGE);
      const lines = stack.warned.filter((line) => line.includes(nobody.taskId));
      assert.equal(lines.length, 1, `expected one warn line naming the prerequisite, got ${JSON.stringify(stack.warned)}`);
      assert.match(lines[0]!, /J9/);
      // And the cases with somebody behind the wait wrote none about their prerequisites.
      assert.deepEqual(stack.warned.filter((line) => line.includes(seen.taskId)), []);
    } finally {
      await stack.db.$disconnect();
    }
  });
