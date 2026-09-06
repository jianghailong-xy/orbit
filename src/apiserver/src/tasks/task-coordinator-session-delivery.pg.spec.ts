import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { RunStatus as SharedRunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import {
  DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
  DELIVERY_NO_COORDINATOR_SESSION,
  CoordinatorDeliveryService,
  coordinatorDeliveryTurnId,
} from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  type WakeFact,
  criterionSubjectId,
  criterionUnlandedFact,
  wakeIdempotencyKey,
} from '../projects/coordinator-wake';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import {
  CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED,
  CriterionUnlandedProducer,
} from '../projects/criterion-unlanded.producer';
import { criteriaFromDefinitions } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { ProjectsService } from '../projects/projects.service';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';

/**
 * `DELIVERED`: the wake that reached the coordinator conversation this project already had.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/tasks/task-coordinator-session-delivery.pg.spec.js
 *
 * WHAT THIS FILE ASSERTS THAT ITS TWO SIBLINGS DO NOT
 * ===================================================
 * `task-criterion-unlanded-delivery.pg.spec.ts` is about which FACT is derived, and
 * `task-landing-wake-disposition.pg.spec.ts` about which TERMINAL that fact is worth. Both now see
 * `DELIVERED` and both check it. This one is about the delivery ITSELF: that a message was
 * actually written to the standing conversation, that the same fact does not write a second one,
 * that a DIFFERENT fact does — and what happens when there is no conversation to write to.
 *
 * WHY IDEMPOTENCY IS TESTED TWICE, AT TWO LAYERS
 * ==============================================
 * "Deliver the same fact again, and count the messages" passes over a working system and over one
 * that never sent anything at all, so every count below is paired: the same fixture delivers a
 * DIFFERENT fact and the count moves. And the repeat is done at both layers that can stop it,
 * because they fail in different windows —
 *
 *   * the ledger: 0174's partial unique index answers ALREADY_AWAKE, so the second delivery never
 *     reaches the conversation. That is the ordinary path and it is what case 2 drives;
 *   * the turn: `(session_id, client_turn_id)` is unique and the key is derived from the FACT, so
 *     a delivery that wrote the message and then lost its ledger row — the crash window between
 *     the send and the bind, which the index cannot cover — writes the same turn rather than a
 *     second one. Case 2 injects exactly that by deleting the committed wake row.
 *
 * WHAT SETTLES THE WORK
 * =====================
 * Nothing here writes a task status. Every serving task carries a declared acceptance command and
 * reaches DONE the way most tasks in production do: `turnComplete` queues the command, `dequeueTurn`
 * reserves it, bash runs it, and `turnComplete` compares the code it returned against the declared
 * one under the task's own row lock.
 *
 * Every fixture files one chore task that serves no criterion and never finishes, so no project
 * here can settle and nothing that lands in the ledger landed because a project ended.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';
/** The declaration every serving task carries, so its DONE is a comparison that happened. */
const ACCEPTANCE = { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 };

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
  /** The runner door, holding the one `TasksService` the production module gives it. */
  api: RunnerApiController;
  tasks: TasksService;
  projects: ProjectsService;
  /** The unit under test's caller, so one case can hand it the same fact twice. */
  disposition: WakeDispositionService;
}

/**
 * The production wiring, over one client.
 *
 * `silent` replaces the router with four doors that deliver nothing, for the reason its sibling
 * gives: a fact's idempotency key is a total function of the fact, so a case that let the write
 * path deliver first would find every later delivery answering ALREADY_AWAKE and could observe no
 * decision at all.
 */
async function connect(options: { silent?: boolean } = {}): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const disposition = new WakeDispositionService(
    prisma,
    new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
    new CoordinatorDeliveryService(prisma, new CoordinatorWakeService(prisma), sessions),
  );
  const wired = new CompletionInputRouter(
    new CoordinatorWakeService(prisma),
    new ProjectTasksSettledProducer(
      prisma,
      new CoordinatorJudgmentService(prisma, new CoordinatorWakeService(prisma), sessions),
      new CoordinatorConvergenceService(prisma),
    ),
    new TaskExceptionInputProducer(prisma, new CoordinatorConvergenceService(prisma)),
    new CriterionReadyProducer(prisma, new CoordinatorConvergenceService(prisma)),
    disposition,
    new CriterionUnlandedProducer(prisma, new CoordinatorConvergenceService(prisma)),
  );
  const silent = {
    routeSettledProjects: async () => [],
    routeTaskExceptions: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
  } as unknown as CompletionInputRouter;
  const tasks = new TasksService(
    prisma, sessions, realtime, undefined, options.silent ? silent : wired,
  );
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    {} as never,
    {} as never,
    {} as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
  );
  const projects = new ProjectsService(prisma, new ProjectAcceptanceService(prisma));
  return { db, api, tasks, projects, disposition };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  /** The task that serves no criterion and never finishes, so the project cannot settle. */
  choreTaskId: string;
  /** The standing conversation this project is coordinated from, or null when it has none. */
  coordinatorSessionId: string | null;
}

/**
 * One project with a standing coordinator conversation, in the state one is really in.
 *
 * `coordinator` decides what this project's `coordinator_session_id` points at:
 *
 *   * `PARKED`  — a live conversation between turns (`AWAITING_INPUT`), which is one of
 *     `SessionsService.LIVE` and therefore the state in which a delivery APPENDS a turn;
 *   * `ENDED`   — the same conversation after it finished, which a notification may not resurrect;
 *   * `NONE`    — a project nobody has opened a coordinator for yet.
 *
 * `dispatch_origin` is USER because that is what `ProjectsService.coordinator` writes: it is the
 * column that tells a person's conversation apart from a judgment session, and every judgment
 * count below depends on the difference.
 */
async function fixture(
  stack: Stack,
  label: string,
  options: {
    coordinatorEnabled?: boolean;
    coordinator?: 'PARKED' | 'ENDED' | 'NONE';
  } = {},
): Promise<Fixture> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@coordinator-delivery.invalid`,
      name: label,
      passwordHash: 'x',
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
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });

  const wanted = options.coordinator ?? 'PARKED';
  let coordinatorSessionId: string | null = null;
  if (wanted !== 'NONE') {
    coordinatorSessionId = randomUUID();
    await db.session.create({
      data: {
        id: coordinatorSessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: `协调：${label}`,
        prompt: `协调：${label}`,
        provider: 'claude',
        status: wanted === 'PARKED' ? RunStatus.AWAITING_INPUT : RunStatus.SUCCEEDED,
        dispatchOrigin: SessionDispatchOrigin.USER,
        titleManagedByProject: true,
        ...(wanted === 'ENDED' ? { completedAt: new Date() } : {}),
      },
    });
    // A conversation that has been running has its opening prompt on the row as a turn: the first
    // thing `createTurn` does for a session with none is seed one (`ensurePromptSeeded`). Written
    // here so that the state under test is a coordinator somebody has actually been talking to,
    // and so that the delivery below is not the thing that seeds it.
    await db.conversationTurn.create({
      data: {
        sessionId: coordinatorSessionId,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
        kind: 'message',
        content: `协调：${label}`,
        status: 'ANSWERED',
      },
    });
  }
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 常驻投递项目`,
      goal: '干完但没落 main 的成果，交给已经在协调的那条会话',
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorWorkspaceId: workspaceId,
      ...(coordinatorSessionId ? { coordinatorSessionId } : {}),
    },
  });
  await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });

  const chore = await stack.tasks.create(ownerId, {
    title: `${label} 与任何标准无关的杂活`,
    assigneeId: workspaceId,
    projectId,
    completionCriterion: 'EVIDENCE_JUDGMENT',
    // This fixture settles its own tasks, one at a time, by hand. Left opted in, the release pass
    // on the completion edge would start whichever of them is still OPEN when the previous one
    // finishes, and the run it then creates collides with the one this fixture is driving.
    autoRunWhenReady: false,
  } as never);
  return { ownerId, runnerId, workspaceId, projectId, choreTaskId: chore.id, coordinatorSessionId };
}

/** State the whole collection through the owner's own path, and read the stable keys back. */
async function state(stack: Stack, f: Fixture, texts: string[]) {
  const written = await stack.projects.update(f.ownerId, f.projectId, {
    acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  return criteriaFromDefinitions(written.acceptanceCriteriaItems);
}

/** File one piece of EXECUTABLE work against a criterion, through the door that resolves the key. */
async function serve(stack: Stack, f: Fixture, criterionKey: string, title: string) {
  const declared = await stack.tasks.create(f.ownerId, {
    title,
    assigneeId: f.workspaceId,
    projectId: f.projectId,
    criterionKey,
    ...ACCEPTANCE,
    autoRunWhenReady: false,
  } as never);
  assert.equal(declared.completionCriterion, 'EXECUTABLE');
  assert.equal(declared.status, TaskStatus.OPEN, 'the declaration is not a status');
  return declared.id;
}

/**
 * Settle one task the way production settles most of them: an acceptance command that ran.
 *
 * The whole route is the product's own — an attempt session, the model turn that ends, the shell
 * turn the same transaction queues, a real bash exit code, and the comparison `turnComplete` makes
 * under the task's row lock. This function never writes `task.status`.
 */
async function settleByAcceptance(stack: Stack, f: Fixture, taskId: string, label: string) {
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sessionId,
      ownerId: f.ownerId,
      creatorId: f.ownerId,
      taskId,
      workspaceId: f.workspaceId,
      assignedRunnerId: f.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await stack.db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'execute the task',
      status: 'IN_FLIGHT',
    },
  });
  const opened = await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: messageTurnId,
    status: SharedRunStatus.SUCCEEDED,
  });
  assert.deepEqual(opened, { ok: true, status: RunStatus.RUNNING });

  const next = await (stack.api as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
    ) => Promise<{ turnId: string; kind: string; content?: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, f.runnerId, null);
  assert.ok(next);
  assert.equal(next.kind, 'shell');
  assert.equal(next.taskAcceptance, true);

  const shell = spawnSync('bash', ['-lc', next.content!], { encoding: 'utf8' });
  assert.equal(shell.error, undefined);
  assert.equal(shell.status, ACCEPTANCE.acceptanceExpectedExitCode);
  await stack.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId: next.turnId,
    status: SharedRunStatus.SUCCEEDED,
    subtype: 'shell',
    shellExitCode: shell.status!,
    shellOutput: `${shell.stdout}${shell.stderr}`,
  });

  assert.equal(
    (await stack.db.task.findUniqueOrThrow({ where: { id: taskId } })).status,
    TaskStatus.DONE,
    'the comparison between the declared code and the one bash returned is what wrote this status',
  );
}

const WAKE_COLUMNS = {
  event: true,
  subjectType: true,
  subjectId: true,
  subjectVersion: true,
  status: true,
  refusalCode: true,
  consumerType: true,
  sessionId: true,
  delivery: true,
} as const;

function unlandedWakes(db: PrismaClient, projectId: string) {
  return db.projectCoordinatorWake.findMany({
    where: { projectId, event: 'CRITERION_UNLANDED' },
    select: WAKE_COLUMNS,
    orderBy: { id: 'asc' },
  });
}

/**
 * Every message this project's standing conversation has been SENT, oldest first.
 *
 * The seeded opening turn is excluded, exactly as `SessionsService`'s own queued-turn reader
 * excludes it: it is the conversation's own prompt rather than something anybody told it, and
 * counting it would make "was this coordinator told about the merge" answer yes for a conversation
 * nobody has said a word to.
 */
function coordinatorMessages(db: PrismaClient, f: Fixture) {
  const sessionId = f.coordinatorSessionId ?? '00000000-0000-0000-0000-000000000000';
  return db.conversationTurn.findMany({
    where: {
      sessionId,
      kind: 'message',
      clientTurnId: { not: SessionsService.initialTurnClientId(sessionId) },
    },
    select: { clientTurnId: true, content: true },
    orderBy: { seq: 'asc' },
  });
}

/**
 * The runner picks the message up, answers it, and the conversation parks again.
 *
 * Written on the row rather than driven through the runner door, and named so the shortcut is
 * visible: what a delivery does to a parked conversation is move it to PENDING
 * (`statusAfterTurnEnqueued` — a queued message needs a fresh runner slot), and what ENDS that
 * state is a runner claiming the session and completing the turn. Nothing in this file is about
 * that half. What it is about is the state a coordinator is in when the NEXT fact arrives, which
 * is this one — parked, having read what it was told.
 */
async function coordinatorReadsIt(db: PrismaClient, f: Fixture) {
  await db.conversationTurn.updateMany({
    where: { sessionId: f.coordinatorSessionId!, status: 'PENDING' },
    data: { status: 'ANSWERED', answeredAt: new Date() },
  });
  await db.session.update({
    where: { id: f.coordinatorSessionId! },
    data: { status: RunStatus.AWAITING_INPUT },
  });
}

function judgmentSessions(db: PrismaClient, ownerId: string) {
  return db.session.findMany({
    where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
    select: { id: true },
  });
}

/** Every session row this owner has, judgment or not — the count "no session was created" is about. */
function allSessions(db: PrismaClient, ownerId: string) {
  return db.session.count({ where: { ownerId } });
}

test('finished work off main is handed to the standing coordinator, and no session is created',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      const f = await fixture(stack, 'delivered-to-standing');
      const [criterion] = await state(stack, f, ['这条标准的活干完了，但还在分支上']);
      const only = await serve(stack, f, criterion!.key, '干完了但没合的那件活');

      // Counted BEFORE the settlement, so "no session was created" is a comparison rather than a
      // guess about how many rows a fixture leaves behind.
      const sessionsBefore = await allSessions(stack.db, f.ownerId);
      await settleByAcceptance(stack, f, only, 'delivered');

      const wakes = await unlandedWakes(stack.db, f.projectId);
      assert.equal(wakes.length, 1, 'the finished-but-unlanded criterion never reached the ledger');
      const row = wakes[0]!;
      assert.equal(row.status, 'DELIVERED');
      assert.equal(row.subjectId, criterionSubjectId(f.projectId, criterion!.key));
      assert.equal(row.consumerType, null, 'a delivered fact is not recorded against a consumer');
      assert.equal(row.refusalCode, null);

      // The row names the conversation the PROJECT names, read back off the project rather than
      // out of the fixture: what the criterion asks is that those two are the same row.
      const project = await stack.db.project.findUniqueOrThrow({
        where: { id: f.projectId },
        select: { coordinatorSessionId: true },
      });
      assert.equal(row.sessionId, project.coordinatorSessionId);
      assert.equal(row.sessionId, f.coordinatorSessionId);

      // And no session was made to carry it — neither a judgment session nor any other row. The
      // settlement above creates exactly one session (the attempt that ran the command), which is
      // why this is `+ 1` rather than unchanged.
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
      assert.equal(
        await allSessions(stack.db, f.ownerId), sessionsBefore + 1,
        'the delivery created a session instead of writing to the one that was already there',
      );

      // The message is really there, under the key derived from the fact, and it carries the merge
      // order — which is the whole reason this fact is worth a coordinator's context at all.
      const said = await coordinatorMessages(stack.db, f);
      assert.equal(said.length, 1);
      assert.equal(
        said[0]!.clientTurnId,
        coordinatorDeliveryTurnId(wakeIdempotencyKey({
          event: 'CRITERION_UNLANDED',
          subjectType: 'CRITERION',
          subjectId: row.subjectId,
          subjectVersion: row.subjectVersion,
        })),
        'the turn was written under a key that is not the fact\'s own identity',
      );
      assert.match(
        said[0]!.content ?? '', /project_merge_evidence/,
        'the message left out the merge order, which is the only reason it is worth sending',
      );
      assert.match(
        said[0]!.content ?? '', /这是一条通知，不是打断/,
        'the message does not say it is a notification, which is the one thing about the carrier '
          + 'its reader cannot check for itself',
      );

      // What the row records about the delivery, which `detail` could not hold: `detail` is written
      // by the INSERT that claims the key, before the wake is authorized, and this only exists once
      // it is. It is also the pointer that makes "it was not silently dropped" checkable.
      assert.deepEqual(row.delivery, { clientTurnId: said[0]!.clientTurnId });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the same fact says it once; a different fact says it again',
  { skip, timeout: 300_000 }, async () => {
    // Silent, so the facts below are delivered by hand: a fact's key is a total function of the
    // fact, so a write path that delivered first would leave every delivery here ALREADY_AWAKE.
    const stack = await connect({ silent: true });
    try {
      const f = await fixture(stack, 'said-once');
      const [first, second] = await state(stack, f, [
        '第一条标准的活干完了但没合', '第二条标准的活也干完了但没合',
      ]);
      const firstWork = await serve(stack, f, first!.key, '第一条标准的那件活');
      const secondWork = await serve(stack, f, second!.key, '第二条标准的那件活');
      await settleByAcceptance(stack, f, firstWork, 'first');
      await settleByAcceptance(stack, f, secondWork, 'second');
      assert.deepEqual(
        await unlandedWakes(stack.db, f.projectId), [],
        'the silent router delivered something, so the deliveries below are not the only ones',
      );

      const allowed = async () => ({ allowed: true as const });
      const factFor = (key: string, taskId: string) => criterionUnlandedFact(
        f.projectId, key, [{ taskId, status: TaskStatus.DONE }], 'UNKNOWN',
      ) as WakeFact;

      // ── the delivery ──────────────────────────────────────────────────────────────────────────
      // Counted either side of the delivery ALONE, which is what a by-hand one buys: no attempt
      // session is being created around it, so "no session row was made to carry this fact" is the
      // table not moving at all rather than a number a reader has to reconcile.
      const sessionsBefore = await allSessions(stack.db, f.ownerId);
      const one = factFor(first!.key, firstWork);
      assert.deepEqual(
        await stack.disposition.openIfDecisive(one, allowed), { outcome: 'DELIVERED' },
      );
      assert.equal(
        await allSessions(stack.db, f.ownerId), sessionsBefore,
        'the delivery created a session row instead of writing to the one already there',
      );
      const afterFirst = await coordinatorMessages(stack.db, f);
      assert.equal(afterFirst.length, 1);
      assert.equal((await unlandedWakes(stack.db, f.projectId)).length, 1);

      // ── the same fact again: the ledger stops it before it reaches the conversation ───────────
      assert.deepEqual(
        await stack.disposition.openIfDecisive(one, allowed), { outcome: 'ALREADY_AWAKE' },
      );
      assert.deepEqual(
        await coordinatorMessages(stack.db, f), afterFirst,
        'the same fact was delivered twice and said it twice',
      );
      assert.equal(
        (await unlandedWakes(stack.db, f.projectId)).length, 1,
        'the same fact was delivered twice and left two ledger rows',
      );

      // ── the same fact again with the ledger row GONE ──────────────────────────────────────────
      // Fault injection standing in for the one window 0174's index cannot cover: a delivery that
      // wrote the message and died before binding it, leaving the key claimable again. Deleting the
      // committed row is how that world is reached from here, and what it proves is the second
      // layer — the turn's own key is derived from the fact, so the re-delivery writes the SAME
      // turn instead of a second one.
      await stack.db.projectCoordinatorWake.deleteMany({
        where: { projectId: f.projectId, event: 'CRITERION_UNLANDED' },
      });
      assert.deepEqual(
        await stack.disposition.openIfDecisive(one, allowed), { outcome: 'DELIVERED' },
        'the released key was not re-claimable, so the assertion below proves nothing',
      );
      assert.deepEqual(
        await coordinatorMessages(stack.db, f), afterFirst,
        'a re-delivery of one fact wrote a second message to the conversation',
      );

      // ── a different fact, while the first message is still unread ────────────────────────────
      // The deliveries above moved the conversation from AWAITING_INPUT to PENDING
      // (`statusAfterTurnEnqueued`: a queued message needs a fresh runner slot), and `resume`
      // refuses to queue a second one behind it. §2.1: that refusal is translated rather than
      // worked around, and it gives the key back — so this fact is not lost, it comes round.
      const two = factFor(second!.key, secondWork);
      assert.deepEqual(
        await stack.disposition.openIfDecisive(two, allowed),
        { outcome: 'REFUSED', refusalCode: DELIVERY_COORDINATOR_SESSION_UNAVAILABLE },
      );
      assert.deepEqual(
        await coordinatorMessages(stack.db, f), afterFirst,
        'a message was queued behind one the coordinator has not read',
      );

      // ── the paired control: the same different fact, once the conversation has read the first ─
      // Without this every count above is equally true of a delivery that never happened. The only
      // thing that changed between the refusal and this line is that the coordinator read what it
      // was told, which is also the answer to "does a released key really come round".
      await coordinatorReadsIt(stack.db, f);
      assert.deepEqual(
        await stack.disposition.openIfDecisive(two, allowed),
        { outcome: 'DELIVERED' },
      );
      const afterSecond = await coordinatorMessages(stack.db, f);
      assert.equal(afterSecond.length, afterFirst.length + 1, 'a second fact said nothing');
      assert.notEqual(
        afterSecond[1]!.clientTurnId, afterSecond[0]!.clientTurnId,
        'two facts wrote one turn key',
      );
      // Three rows for two facts, and the third is the point: the refusal above LEFT one saying
      // why, and released the key it was holding, so the same fact could claim it again. A refusal
      // that had burned the key would leave two rows and one undelivered fact for ever.
      const ledger = await unlandedWakes(stack.db, f.projectId);
      assert.deepEqual(
        ledger.map((row) => row.status).sort(), ['DELIVERED', 'DELIVERED', 'REFUSED'],
      );
      assert.deepEqual(
        ledger.filter((row) => row.status === 'DELIVERED').map((row) => row.sessionId),
        [f.coordinatorSessionId, f.coordinatorSessionId],
        'two facts named one standing conversation, which the partial index has to allow',
      );
      assert.deepEqual(await judgmentSessions(stack.db, f.ownerId), []);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a coordinator conversation that is not there, or is over, is a readable end and not a throw',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      // ── nobody has opened one ─────────────────────────────────────────────────────────────────
      const none = await fixture(stack, 'no-coordinator', { coordinator: 'NONE' });
      const [never] = await state(stack, none, ['还没人给这个项目开过协调会话']);
      const neverWork = await serve(stack, none, never!.key, '干完了但没人可通知的那件活');
      const noneBefore = await allSessions(stack.db, none.ownerId);
      // The delivery happens INSIDE this call. A throw would surface here, on the write path of a
      // task that already committed — which is the failure this end exists to prevent.
      await settleByAcceptance(stack, none, neverWork, 'no-coordinator');

      const unheard = await unlandedWakes(stack.db, none.projectId);
      assert.equal(unheard.length, 1, 'the fact never reached the ledger at all');
      assert.equal(unheard[0]!.status, 'REFUSED', 'the fact was dropped without saying so');
      assert.equal(unheard[0]!.refusalCode, DELIVERY_NO_COORDINATOR_SESSION);
      assert.equal(unheard[0]!.sessionId, null);
      assert.equal(unheard[0]!.delivery, null);
      assert.deepEqual(await judgmentSessions(stack.db, none.ownerId), []);
      assert.equal(
        await allSessions(stack.db, none.ownerId), noneBefore + 1,
        'a project with no coordinator conversation had one opened for it',
      );

      // ── it exists and it is over ──────────────────────────────────────────────────────────────
      const over = await fixture(stack, 'ended-coordinator', { coordinator: 'ENDED' });
      const [gone] = await state(stack, over, ['协调会话已经结束了']);
      const goneWork = await serve(stack, over, gone!.key, '协调会话结束后干完的那件活');
      const overBefore = await allSessions(stack.db, over.ownerId);
      await settleByAcceptance(stack, over, goneWork, 'ended-coordinator');

      const unread = await unlandedWakes(stack.db, over.projectId);
      assert.equal(unread.length, 1);
      assert.equal(unread[0]!.status, 'REFUSED');
      assert.equal(unread[0]!.refusalCode, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
      assert.equal(unread[0]!.sessionId, null);
      assert.deepEqual(await judgmentSessions(stack.db, over.ownerId), []);
      assert.equal(
        await allSessions(stack.db, over.ownerId), overBefore + 1,
        'an ended coordinator conversation was replaced by a session opened here',
      );
      // And it was not resurrected either: the conversation is exactly as the person left it.
      assert.deepEqual(await coordinatorMessages(stack.db, over), []);
      assert.equal(
        (await stack.db.session.findUniqueOrThrow({
          where: { id: over.coordinatorSessionId! }, select: { status: true },
        })).status,
        RunStatus.SUCCEEDED,
        'a notification revived the conversation its owner had ended',
      );

      // Both refusals released the key rather than burning it, which is what makes them a state of
      // the world rather than a verdict: the same fact is claimable again once somebody opens a
      // coordinator. 0174's index excludes REFUSED, so a second claim of that key must win.
      for (const f of [none, over]) {
        const again = await stack.db.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO "project_coordinator_wake" (
             "id", "project_id", "event", "subject_type", "subject_id", "subject_version",
             "idempotency_key", "status"
           )
           SELECT gen_random_uuid(), "project_id", "event", "subject_type", "subject_id",
                  "subject_version", "idempotency_key", 'CLAIMED'
             FROM "project_coordinator_wake"
            WHERE "project_id" = $1::uuid AND "event" = 'CRITERION_UNLANDED'
           ON CONFLICT ("idempotency_key") WHERE "status" <> 'REFUSED' DO NOTHING
           RETURNING "id"`,
          f.projectId,
        );
        assert.equal(again.length, 1, 'the refusal kept the key, so this fact can never come round');
      }

      // The two ends are DIFFERENT, so a reader can tell "nobody has opened one" from "the one
      // there is has ended" without opening the session table.
      assert.notEqual(unheard[0]!.refusalCode, unread[0]!.refusalCode);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('a switched-off coordinator is refused once, told nothing, and opened nothing',
  { skip, timeout: 300_000 }, async () => {
    const stack = await connect();
    try {
      // ── the control, and it is what makes the negative mean anything ──────────────────────────
      // "Nothing was delivered" is equally true of a switched-off project, of a delivery point that
      // was never wired, and of a producer nobody calls. So the same shape runs first with the
      // switch ON, in the same case, over the same code.
      const on = await fixture(stack, 'switch-on-delivery');
      const [live] = await state(stack, on, ['开关开着，活干完了但还在分支上']);
      const liveWork = await serve(stack, on, live!.key, '开关开着时干完的那件活');
      await settleByAcceptance(stack, on, liveWork, 'switched-on');

      const control = await unlandedWakes(stack.db, on.projectId);
      assert.equal(control.length, 1, 'the control never reached the wake ledger');
      assert.equal(control[0]!.status, 'DELIVERED');
      assert.equal(control[0]!.sessionId, on.coordinatorSessionId);
      assert.equal(
        (await coordinatorMessages(stack.db, on)).length, 1,
        'the control told the standing coordinator nothing, so the negative proves nothing',
      );

      // ── the same shape with the switch off ────────────────────────────────────────────────────
      const off = await fixture(stack, 'switch-off-delivery', { coordinatorEnabled: false });
      const [dark] = await state(stack, off, ['开关关着，活干完了但还在分支上']);
      const darkWork = await serve(stack, off, dark!.key, '开关关着时干完的那件活');
      const darkBefore = await allSessions(stack.db, off.ownerId);
      await settleByAcceptance(stack, off, darkWork, 'switched-off');

      // Not "zero rows": the ledger claims before it authorizes, so a fact that travelled the whole
      // way and was refused leaves EXACTLY ONE row saying so. Asserting an empty table here would
      // be green over a delivery point nobody wired, which is precisely what this case is for.
      const refused = await unlandedWakes(stack.db, off.projectId);
      assert.equal(refused.length, 1, 'the unlanded criterion never reached the wake ledger');
      assert.equal(refused[0]!.status, 'REFUSED');
      assert.equal(refused[0]!.refusalCode, CRITERION_UNLANDED_WAKE_COORDINATOR_DISABLED);
      assert.equal(refused[0]!.sessionId, null);
      assert.equal(refused[0]!.consumerType, null);
      assert.equal(refused[0]!.delivery, null);
      assert.notEqual(refused[0]!.status, 'DELIVERED');

      // 0 messages, and 0 sessions: the switch stops the delivery before the conversation is
      // written to, and nothing was opened in its place either.
      assert.deepEqual(
        await coordinatorMessages(stack.db, off), [],
        'a switched-off project\'s standing conversation was written to anyway',
      );
      assert.deepEqual(
        await judgmentSessions(stack.db, off.ownerId), [],
        'a switched-off coordinator was woken about a merge',
      );
      assert.equal(
        await allSessions(stack.db, off.ownerId), darkBefore + 1,
        'a switched-off project gained a session it did not have',
      );

      // The switch is not read by the door that delivers: the work settled exactly as it would
      // have with the switch on, and only the wake was refused.
      assert.equal(
        (await stack.db.task.findUniqueOrThrow({ where: { id: darkWork } })).status,
        TaskStatus.DONE,
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the coordinator-delivery PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
