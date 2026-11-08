/**
 * `TASK_RUN_STOPPED`: a task's run that stops working with its task still owed something reaches the
 * project's coordinator, which nothing else tells.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/task-run-stopped.pg.spec.ts
 *
 * WHAT WAS WRONG
 * ==============
 * 2026-11-02, project 34qLPXsdBbZQ5qfwmcDJM, task 34qLYVoEQQZipg3Hz3iZo: the run finished, had its
 * evidence refused with EVIDENCE_NO_RESOLVABLE_CITATION four times, said someone needs to submit it
 * and parked. The coordinator sat on `task_await` with nine of ten tasks done until a person told it.
 * The first case is that run's timeline, turn by turn.
 *
 * WHAT IS ASSERTED, AND HOW
 * =========================
 * Through the two production edges that end a turn — `RunnerApiController.turnComplete` and the event
 * ingest for a turn the engine started itself — over the real router, producer, ledger and
 * conversation table. Nothing here calls the producer directly. Every "told nothing" is paired in its
 * case with the one change that makes it told, so a producer nobody calls fails as well.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own project.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import {
  type Prisma,
  type PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  TaskStatus,
} from '@prisma/client';
import { RunEventType, RunStatus as SharedRunStatus, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import { CompletionInputRouter } from './completion-input-router.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import {
  CoordinatorDeliveryService,
  DELIVERY_COORDINATOR_SESSION_UNAVAILABLE,
} from './coordinator-delivery.service';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { CriterionReadyProducer } from './criterion-ready.producer';
import { CriterionUnlandedProducer } from './criterion-unlanded.producer';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { TaskDispatchRefusalProducer } from './task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { RUN_STOPPED_WAKE_COORDINATOR_DISABLED, TaskRunStoppedProducer } from './task-run-stopped.producer';
import { WakeDispositionService } from './wake-disposition.service';
import '../test-support/dequeue-under-lease';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A collaborator whose every method answers nothing: the broadcasts a turn's enqueue fires. */
const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

/** The production wiring over one client, with the router's ninth door in place. */
async function connect() {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!) as PrismaClient;
  const prisma = db as unknown as PrismaService;
  const queue = { notifySessionQueued: () => undefined };
  const realtime = silent();
  const sessions = new SessionsService(prisma, queue as never, realtime as never);
  const wakes = new CoordinatorWakeService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const delivery = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, delivery),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, delivery),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, delivery),
    undefined,
    undefined,
    undefined,
    new TaskRunStoppedProducer(prisma, convergence, delivery),
  );
  const tasks = new TasksService(prisma, sessions, realtime as never, undefined, router);
  const api = new RunnerApiController(
    prisma,
    queue as never,
    realtime as never,
    {} as never,
    new RunnerOrchestrationAuthorizer(prisma, new JwtService({ secret: 'task-run-stopped-pg' })),
    { expand: async (_owner: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _id: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    sessions,
  );
  return { db, sessions, api };
}

type Stack = Awaited<ReturnType<typeof connect>>;

/** The shape of the conversation the project is coordinated from. */
type Coordinator = 'PARKED' | 'ENDED';

/** One account, one machine, a coordinated project, and the doors over them. */
async function world(
  stack: Stack,
  label: string,
  options: { coordinatorEnabled?: boolean; coordinator?: Coordinator } = {},
) {
  const { db, sessions, api } = stack;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@run-stopped.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: sha256(`token-${runnerId}`),
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true } });

  async function conversation(title: string, data: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<string> {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId,
        title, prompt: title, provider: 'claude', status: RunStatus.AWAITING_INPUT,
        numTurns: 1, startedAt: new Date(), runtimeSessionId: `runtime-${id}`,
        dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
        ...data,
      },
    });
    return id;
  }

  const coordinator = await conversation(`coordinator: ${label}`, {
    titleManagedByProject: true,
    ...(options.coordinator === 'ENDED' ? { status: RunStatus.SUCCEEDED, completedAt: new Date() } : {}),
  });
  const projectId = randomUUID();
  await db.project.create({
    data: {
      id: projectId, ownerId, title: `${label} project`, startedAt: new Date(),
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      coordinatorSessionId: coordinator, coordinatorWorkspaceId: workspaceId,
    },
  });

  /** A task of this project with a run of its own, parked and yet to be handed its first turn. */
  async function run(
    title: string,
    taskData: Partial<Prisma.TaskUncheckedCreateInput> = {},
  ): Promise<{ taskId: string; sessionId: string }> {
    const task = await db.task.create({
      data: {
        ownerId, projectId, title, creatorType: 'USER', creatorId: ownerId, assigneeId: workspaceId,
        completionCriterion: 'EVIDENCE_JUDGMENT', ...taskData,
      },
      select: { id: true },
    });
    const sessionId = await conversation(`Task: ${title}`, { taskId: task.id, startsTaskWork: true });
    return { taskId: task.id, sessionId };
  }

  /** Queues a message for the run under `clientTurnId`, as whichever door writes that key. */
  async function send(sessionId: string, clientTurnId: string, senderSessionId?: string): Promise<void> {
    await sessions.createTurn(
      ownerId,
      sessionId,
      { clientTurnId, content: `message under ${clientTurnId}`, intent: 'NEXT_TURN' },
      senderSessionId ? { senderSessionId } : undefined,
    );
  }

  const seqs = new Map<string, number>();
  const nextSeq = (sessionId: string) => {
    const seq = (seqs.get(sessionId) ?? 100) + 1;
    seqs.set(sessionId, seq);
    return seq;
  };

  /** What the runner's claim does to the queued run, then the inbox poll that hands the turn out. */
  async function deliver(sessionId: string): Promise<string> {
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.RUNNING } });
    for (;;) {
      const handed = await (api as unknown as {
        dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) => Promise<Record<string, unknown> | null>;
      }).dequeueTurn.call(api, sessionId, runnerId, null);
      assert.ok(handed, `the inbox of ${sessionId} handed nothing out`);
      const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: String(handed.turnId) } });
      if (turn.kind === 'message') return turn.id;
    }
  }

  /** The turn ends as the runner reports it: its last words, then the completion. */
  async function finish(sessionId: string, turnId: string, words = 'Done.') {
    await api.events({ id: runnerId } as never, sessionId, {
      events: [{
        seq: nextSeq(sessionId), type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId, payload: { text: words },
      }],
    } as never);
    return api.turnComplete({ id: runnerId } as never, sessionId, {
      turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0,
    } as never);
  }

  /** Hands the run a message under this key and ends that turn. */
  async function oneTurn(sessionId: string, clientTurnId: string, words?: string, senderSessionId?: string): Promise<string> {
    await send(sessionId, clientTurnId, senderSessionId);
    const turnId = await deliver(sessionId);
    await finish(sessionId, turnId, words);
    return turnId;
  }

  /** A turn the engine started itself ends: no turn id, so it is only ever an event. */
  function engineTurnEnds(sessionId: string, words: string) {
    const ts = new Date().toISOString();
    return api.events({ id: runnerId } as never, sessionId, {
      events: [
        { seq: nextSeq(sessionId), type: RunEventType.ASSISTANT, ts, payload: { text: words } },
        { seq: nextSeq(sessionId), type: RunEventType.TURN_END, ts, payload: { subtype: 'success', numTurns: 1 } },
      ],
    } as never);
  }

  /** What the coordinator was told about stopped runs, oldest first. */
  function told() {
    return db.conversationTurn.findMany({
      where: { sessionId: coordinator, kind: 'message' },
      select: { clientTurnId: true, content: true, status: true, sendIntent: true },
      orderBy: { seq: 'asc' },
    });
  }

  function wakes() {
    return db.projectCoordinatorWake.findMany({
      where: { projectId, event: 'TASK_RUN_STOPPED' },
      select: { subjectId: true, subjectVersion: true, status: true, refusalCode: true, sessionId: true, delivery: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /** The latest revision of a task's evidence, as a submission leaves it. */
  async function submitEvidence(taskId: string, sessionId: string, revision: bigint) {
    return db.taskCompletionEvidence.create({
      data: {
        taskId, ownerId, actorType: 'AGENT', actorId: workspaceId, sourceSessionId: sessionId,
        criterionRevision: 'a'.repeat(64), criterion: {}, evidence: { revision: revision.toString() },
        evidenceDigest: revision.toString().padStart(64, '0'), revision,
      },
      select: { id: true, criterionRevision: true, evidenceDigest: true },
    });
  }

  return {
    ownerId, runnerId, workspaceId, projectId, coordinator,
    run, send, deliver, finish, oneTurn, engineTurnEnds, told, wakes, submitEvidence,
  };
}

const judgmentSessions = (db: PrismaClient, ownerId: string) => db.session.findMany({
  where: { ownerId, dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR, deletedAt: null },
  select: { id: true },
});

async function withStack(body: (stack: Stack) => Promise<void>): Promise<void> {
  const stack = await connect();
  try {
    await body(stack);
  } finally {
    await stack.db.$disconnect();
  }
}

test('the run from the incident: it stops once with nothing to show, and the coordinator is told then and only then',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'incident');
    const { taskId, sessionId } = await w.run('P4-T7 new content blocks');

    // The long first turn: refused, so it schedules a wake-up to try again. It will come back by
    // itself, so nobody is told it has stopped.
    await w.send(sessionId, `initial-${sessionId}`);
    const brief = await w.deliver(sessionId);
    const wakeup = await stack.db.sessionScheduledWakeup.create({
      data: { sessionId, delaySeconds: 90, reason: 'retry the submission', dueAt: new Date(Date.now() + 90_000) },
      select: { id: true },
    });
    await w.finish(sessionId, brief, 'Refused three times. I set a wakeup to retry.');
    assert.deepEqual(await w.told(), [], 'a run with a wake-up pending was reported as stopped');

    // The wake-up's own turn, refused again. Now nothing will give it another turn.
    await stack.db.sessionScheduledWakeup.update({ where: { id: wakeup.id }, data: { state: 'DELIVERED' } });
    const lastWords = 'The work is finished.\nSomeone needs to submit the evidence once the commits are recorded.';
    const stopped = await w.oneTurn(sessionId, `bg-wake:wakeup:${wakeup.id}`, lastWords);

    const messages = await w.told();
    assert.equal(messages.length, 1, 'the coordinator was not told exactly once');
    const [message] = messages;
    assert.equal(message!.sendIntent, 'NEXT_TURN');
    assert.match(message!.content!, /P4-T7 new content blocks/);
    assert.ok(message!.content!.includes(uuidToBase62(taskId)), 'the message does not name the task');
    assert.ok(message!.content!.includes(uuidToBase62(sessionId)), 'the message does not name the run');
    assert.match(message!.content!, /> The work is finished\.\n> Someone needs to submit the evidence/);
    assert.match(message!.content!, /bg_run/);
    const [wake] = await w.wakes();
    assert.equal(wake!.status, 'DELIVERED');
    assert.equal(wake!.subjectId, taskId);
    assert.equal(wake!.subjectVersion, `${sessionId}:${stopped}`);
    assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), [], 'a judgment session was opened beside a live run');

    // The coordinator tells it what to cite. It reruns its checks with bg_run and ends that turn to
    // wait for them: going, so nobody is told.
    await w.send(sessionId, randomUUID(), w.coordinator);
    const rerun = await w.deliver(sessionId);
    await stack.db.session.update({ where: { id: sessionId }, data: { runningBgJobs: ['bgj_rerun'] } });
    await w.finish(sessionId, rerun, 'Rerunning the checks with bg_run.');
    assert.equal((await w.told()).length, 1, 'a run waiting for its own job was reported as stopped');

    // The jobs end, and it submits: the revision is on its own way to the decider.
    await stack.db.session.update({ where: { id: sessionId }, data: { runningBgJobs: [] } });
    await w.submitEvidence(taskId, sessionId, 1n);
    await w.oneTurn(sessionId, 'bg-wake:job:bgj_rerun', 'Evidence submitted.');
    assert.equal((await w.told()).length, 1, 'a run with evidence waiting for a decision was reported as stopped');
  }));

test('every wake source holds it back, and the same stop without one tells the coordinator',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'wake-sources');
    const sources: Array<[string, (sessionId: string) => Promise<() => Promise<unknown>>]> = [
      ['a job', async (sessionId) => {
        await stack.db.session.update({ where: { id: sessionId }, data: { runningBgJobs: ['bgj_a'] } });
        return () => stack.db.session.update({ where: { id: sessionId }, data: { runningBgJobs: [] } });
      }],
      ['a sub-agent', async (sessionId) => {
        await stack.db.session.update({ where: { id: sessionId }, data: { runningSubagents: ['agent-a'] } });
        return () => stack.db.session.update({ where: { id: sessionId }, data: { runningSubagents: [] } });
      }],
      ['a wake-up', async (sessionId) => {
        const { id } = await stack.db.sessionScheduledWakeup.create({
          data: { sessionId, delaySeconds: 60, reason: 'later', dueAt: new Date(Date.now() + 60_000) },
          select: { id: true },
        });
        return () => stack.db.sessionScheduledWakeup.update({ where: { id }, data: { state: 'CANCELLED' } });
      }],
    ];
    let expected = 0;
    for (const [what, arm] of sources) {
      const { sessionId } = await w.run(`held by ${what}`);
      const disarm = await arm(sessionId);
      await w.oneTurn(sessionId, `initial-${sessionId}`);
      assert.equal((await w.told()).length, expected, `a run holding ${what} was reported as stopped`);
      await disarm();
      await w.oneTurn(sessionId, `bg-wake:wakeup:${randomUUID()}`);
      expected += 1;
      assert.equal((await w.told()).length, expected, `the same run without ${what} was not reported`);
    }
  }));

test('a turn the owner typed is not a stop, and the next turn anybody else put on the run is',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'owner-chat');
    const { sessionId } = await w.run('talked to by its owner');
    await w.oneTurn(sessionId, randomUUID(), 'Here is where it stands.');
    assert.deepEqual(await w.told(), [], 'the coordinator walked in on the owner’s conversation');

    await w.oneTurn(sessionId, randomUUID(), 'Still stuck.', w.coordinator);
    assert.equal((await w.told()).length, 1, 'a run that stopped after the coordinator spoke was not reported');
  }));

test('a task that owes nothing tells nobody: a revision waiting, a settled task, another criterion, a verifier',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'owes-nothing');
    const stopsSilently = async (what: string, sessionId: string) => {
      await w.oneTurn(sessionId, `initial-${sessionId}`);
      assert.deepEqual(await w.told(), [], `${what} was reported as stopped`);
    };

    const waiting = await w.run('a revision is waiting');
    const revision = await w.submitEvidence(waiting.taskId, waiting.sessionId, 1n);
    await stopsSilently('a run with evidence waiting', waiting.sessionId);

    const settled = await w.run('settled', { status: TaskStatus.DONE });
    await stopsSilently('a run of a DONE task', settled.sessionId);

    const confirmed = await w.run('owner confirms', { completionCriterion: 'OWNER_CONFIRMED' });
    await stopsSilently('a run of another criterion', confirmed.sessionId);

    const verifier = await w.run('verifier', { verifiesTaskId: waiting.taskId });
    await stopsSilently('a verifier', verifier.sessionId);

    // Sent back, the same run owes a new revision, and stopping without one is this fact.
    await stack.db.taskEvidenceDecision.create({
      data: {
        taskId: waiting.taskId, ownerId: w.ownerId, evidenceId: revision.id,
        criterionRevision: revision.criterionRevision, evidenceDigest: revision.evidenceDigest,
        decision: 'SEND_BACK', note: 'show the audit', decidedByType: 'AGENT', decidedById: w.workspaceId,
        decidingSessionId: w.coordinator,
      },
    });
    await w.oneTurn(waiting.sessionId, `evidence-send-back:${revision.id}`);
    assert.equal((await w.told()).length, 1, 'a run that stopped owing a new revision was not reported');
  }));

test('a turn the engine started itself is a stop too, once for each',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'engine-turn');
    const { sessionId } = await w.run('woken by its own engine');
    const live = () => stack.db.session.update({ where: { id: sessionId }, data: { engineTurnActive: true } });

    await live();
    await w.engineTurnEnds(sessionId, 'The background tests passed, and nothing is left to do.');
    const [message] = await w.told();
    assert.match(message!.content!, /> The background tests passed/);

    await live();
    await w.engineTurnEnds(sessionId, 'Still nothing to do.');
    assert.equal((await w.told()).length, 2, 'a second stop was not a second fact');
  }));

test('one stop is one message however often its completion is reported',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'repeat');
    const { sessionId } = await w.run('reported twice');
    const turnId = await w.oneTurn(sessionId, `initial-${sessionId}`);
    await w.finish(sessionId, turnId);
    assert.equal((await w.told()).length, 1);
    assert.equal((await w.wakes()).length, 1);
  }));

test('a coordinator that has ended is not written to or revived, and the key goes back',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'ended', { coordinator: 'ENDED' });
    const { sessionId } = await w.run('nobody to tell');
    await w.oneTurn(sessionId, `initial-${sessionId}`);
    assert.deepEqual(await w.told(), []);
    const [wake] = await w.wakes();
    assert.equal(wake!.status, 'REFUSED');
    assert.equal(wake!.refusalCode, DELIVERY_COORDINATOR_SESSION_UNAVAILABLE);
    const coordinator = await stack.db.session.findUniqueOrThrow({ where: { id: w.coordinator } });
    assert.equal(coordinator.status, RunStatus.SUCCEEDED);
  }));

test('a run that stops under a switched-off coordinator is refused once, told nothing, and opens nothing',
  { skip, timeout: 120_000 }, () => withStack(async (stack) => {
    const w = await world(stack, 'switched-off', { coordinatorEnabled: false });
    const { taskId, sessionId } = await w.run('switched off');
    await w.oneTurn(sessionId, `initial-${sessionId}`);

    assert.deepEqual(await judgmentSessions(stack.db, w.ownerId), []);
    // Exactly one row, and not zero: the ledger claims before it authorizes, so a fact refused on the
    // switch travelled the whole way, and zero would also be a producer nobody calls.
    const wakes = await w.wakes();
    assert.equal(wakes.length, 1, 'the stop never reached the ledger');
    const [row] = wakes;
    assert.equal(row!.status, 'REFUSED');
    assert.equal(row!.refusalCode, RUN_STOPPED_WAKE_COORDINATOR_DISABLED);
    assert.equal(row!.sessionId, null);
    assert.equal(row!.subjectId, taskId);
    assert.deepEqual(await w.told(), [], 'the switched-off coordinator was told anyway');
    assert.equal(await stack.db.projectConvergenceDecision.count({ where: { projectId: w.projectId } }), 0);
  }));
