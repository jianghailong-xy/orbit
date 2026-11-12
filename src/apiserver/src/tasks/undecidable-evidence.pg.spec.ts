import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { uuidToBase62 } from '@orbit/shared';

import { CompletionEvidenceProducer } from '../projects/completion-evidence.producer';
import { CompletionInputRouter } from '../projects/completion-input-router.service';
import { CoordinatorConvergenceService } from '../projects/coordinator-convergence.service';
import { CoordinatorDeliveryService } from '../projects/coordinator-delivery.service';
import { CoordinatorJudgmentService } from '../projects/coordinator-judgment.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { CoordinatorWakeService } from '../projects/coordinator-wake.service';
import { CriterionReadyProducer } from '../projects/criterion-ready.producer';
import { CriterionUnlandedProducer } from '../projects/criterion-unlanded.producer';
import { DependentReadyProducer } from '../projects/dependent-ready.producer';
import { criterionKeyOf } from '../projects/project-acceptance';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectHandoffService } from '../projects/project-handoff.service';
import { ProjectTasksSettledProducer } from '../projects/project-tasks-settled.producer';
import { ProjectsService } from '../projects/projects.service';
import { TaskDispatchRefusalProducer } from '../projects/task-dispatch-refusal.producer';
import { TaskExceptionInputProducer } from '../projects/task-exception-input.producer';
import { WakeDispositionService } from '../projects/wake-disposition.service';
import { SESSION_ENDING_SELECT, sessionHasEnded } from '../projects/project-open-item';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { readPendingEvidenceJudgments, type PendingEvidenceJudgmentQueue } from './pending-evidence-judgments';
import {
  EVIDENCE_RESTART_NOT_OFFERED_CODE,
  TaskCompletionEvidenceService,
} from './task-completion-evidence.service';
import { TasksService } from './tasks.service';
import { standardDigest, undecidableEvidenceTurnId, type HeldStandard } from './undecidable-evidence';

/**
 * ONE SHARED PATH WHEN AN UNANSWERED REVISION BECOMES UNDECIDABLE
 * (docs/evidence-always-has-an-addressee-design.md §3, criterion 3 of project 34w9J4ycWBHKATEW1R7Pr).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/undecidable-evidence.pg.spec.ts
 *
 * One spec per trigger — the declared criterion REWORDED (an owner-approved criteria edit), the
 * declared criterion DELETED (the same door), the task MOVED (the owner-confirmed hand-off) — each
 * driven through the real write and its post-commit delivery, over the production wiring of the
 * evidence door, the wake ledger and the conversation turns. Each asserts:
 *
 *   (live) the task's live run gets exactly one steer naming the new standard, the Automatic
 *          coordinator exactly one message saying the run was told, and firing the trigger again
 *          with the same standard writes nothing more;
 *   (idle) with no live run the coordinator gets it to act on (task_start, or change the standard),
 *          and nothing is started by itself;
 *   (none) with no coordinator to tell — Manual, or none at all — nobody is messaged, the owner's
 *          pending row carries `ownerAction: RESTART_TASK`, and pressing it starts the task;
 *
 * and in every state, no row the pending read returns has a required action its reader cannot take.
 *
 * Not destructive: every case owns freshly generated ids and asserts over its own rows.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const METHOD = 'A person reads the evidence and the checks it cites';
const OWN = 'the task its own acceptance criteria: the shared path is taken by every trigger';
const WANTS_1 = 'criterion one: the undecidable revision reaches whoever can file it again';
const WANTS_1_REWORDED = 'criterion one, reworded: the undecidable revision reaches whoever can file it again, exactly once';
const WANTS_2 = 'criterion two: nothing else changes';
const WANTS_3 = 'criterion three: added later, touching nobody';
const WANTS_B = 'project B: the moved task is decided where it lands';

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
  tasks: TasksService;
  projects: ProjectsService;
  handoffs: ProjectHandoffService;
  evidence: TaskCompletionEvidenceService;
}

/** The production wiring, over one client. The notification transports are the only stand-ins. */
async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const wakes = new CoordinatorWakeService(prisma);
  const convergence = new CoordinatorConvergenceService(prisma);
  const deliveries = new CoordinatorDeliveryService(prisma, wakes, sessions);
  const judgments = new CoordinatorJudgmentService(prisma, wakes, sessions);
  const router = new CompletionInputRouter(
    wakes,
    new ProjectTasksSettledProducer(prisma, judgments, convergence, deliveries),
    new TaskExceptionInputProducer(prisma, convergence),
    new CriterionReadyProducer(prisma, convergence),
    new WakeDispositionService(prisma, judgments, deliveries),
    new CriterionUnlandedProducer(prisma, convergence),
    new TaskDispatchRefusalProducer(prisma, convergence, deliveries),
    new DependentReadyProducer(prisma, convergence, deliveries),
    undefined,
    new CompletionEvidenceProducer(prisma, convergence, deliveries),
  );
  const handoffs = new ProjectHandoffService(prisma as never);
  const tasks = new TasksService(prisma as never, sessions, realtime, handoffs, router);
  return {
    db,
    prisma,
    tasks,
    projects: new ProjectsService(prisma, new ProjectAcceptanceService(prisma), sessions, realtime),
    handoffs,
    evidence: new TaskCompletionEvidenceService(prisma, tasks, router),
  };
}

interface Ids { ownerId: string; runnerId: string; workspaceId: string }

interface World extends Ids {
  label: string;
  project: string;
  /** Its coordinator conversation, or null for a project that has none. */
  coord: string | null;
  criterion1: string;
  criterion2: string;
  task: string;
  title: string;
  run: string;
  cited: string;
  /** The revision submitted before the trigger. */
  evidenceId: string;
}

/** One conversation with its opening prompt as a turn, so nothing below is what seeds it. */
async function conversation(
  db: PrismaClient,
  w: Ids,
  title: string,
  options: { status?: RunStatus; ended?: boolean; taskId?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId: options.taskId,
      startsTaskWork: options.taskId !== undefined,
      title,
      prompt: title,
      provider: 'claude',
      status: options.status ?? RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      ...(options.taskId === undefined ? { titleManagedByProject: true } : {}),
      ...(options.ended ? { completedAt: new Date() } : {}),
    },
  });
  await db.conversationTurn.create({
    data: {
      sessionId: id,
      seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(id),
      kind: 'message',
      content: title,
      status: 'ANSWERED',
    },
  });
  return id;
}

async function owner(db: PrismaClient, label: string): Promise<Ids> {
  const ids = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: { id: ids.ownerId, email: `${label}-${ids.ownerId}@undecidable.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: ids.runnerId,
      ownerId: ids.ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${ids.runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: ids.workspaceId,
      ownerId: ids.ownerId,
      runnerId: ids.runnerId,
      name: `${label}-ws`,
      enabled: true,
      canCreateTasks: true,
      canDelegate: true,
    },
  });
  return ids;
}

/** A project with a coordinator conversation (unless `coordinator: 'none'`), stating `criteria`. */
async function project(
  stack: Stack,
  ids: Ids,
  title: string,
  coordinator: 'automatic' | 'manual' | 'none',
  criteria: readonly string[],
): Promise<{ id: string; coord: string | null; criteria: string[] }> {
  const coord = coordinator === 'none' ? null : await conversation(stack.db, ids, `Coordinator: ${title}`);
  const id = randomUUID();
  await stack.db.project.create({
    data: {
      id,
      ownerId: ids.ownerId,
      title,
      coordinatorEnabled: coordinator === 'automatic',
      coordinatorWorkspaceId: ids.workspaceId,
      coordinatorSessionId: coord,
    },
  });
  await stack.db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
  // Stated through the owner's own edit, from none: ADDITIVE, so it applies where it is made.
  await stack.projects.update(ids.ownerId, id, {
    acceptanceCriteriaItems: criteria.map((text) => ({ text, verificationMethod: METHOD })),
  } as never);
  const rows = await stack.db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId: id }, orderBy: { ordinal: 'asc' }, select: { id: true },
  });
  return { id, coord, criteria: rows.map((row) => row.id) };
}

/**
 * The task under test: IN_PROGRESS, EVIDENCE_JUDGMENT, declaring criterion one of its project, with
 * a run that is live or has ended, and one revision that run submitted while it was decidable.
 */
async function world(
  stack: Stack,
  label: string,
  options: { coordinator?: 'automatic' | 'manual' | 'none'; runEnded?: boolean } = {},
): Promise<World> {
  const db = stack.db;
  const ids = await owner(db, label);
  const p = await project(stack, ids, `${label} project`, options.coordinator ?? 'automatic', [WANTS_1, WANTS_2]);
  const [criterion1, criterion2] = p.criteria;
  const definition = await db.projectAcceptanceCriterionDefinition.findUniqueOrThrow({ where: { id: criterion1! } });
  const task = randomUUID();
  const title = `${label} task`;
  await db.task.create({
    data: {
      id: task,
      ownerId: ids.ownerId,
      projectId: p.id,
      title,
      creatorType: CreatorType.USER,
      creatorId: ids.ownerId,
      assigneeId: ids.workspaceId,
      status: TaskStatus.IN_PROGRESS,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: OWN,
      criterionDefinitionId: criterion1!,
      criterionRevision: definition.revision,
    },
  });
  const run = await conversation(db, ids, `${label} run`, options.runEnded
    ? { taskId: task, status: RunStatus.SUCCEEDED, ended: true }
    : { taskId: task, status: RunStatus.RUNNING });
  const cited = `toolu_${label}_${task.slice(0, 8)}`;
  await db.toolCall.create({
    data: {
      sessionId: run,
      name: 'Bash',
      toolUseId: cited,
      input: { command: 'npm test', description: 'the command this evidence is about' },
      isError: false,
    },
  });
  const w: World = {
    label, ...ids, project: p.id, coord: p.coord, criterion1: criterion1!, criterion2: criterion2!,
    task, title, run, cited, evidenceId: '',
  };
  const receipt = await submit(stack, w);
  assert.equal(receipt.revision, '1');
  w.evidenceId = receipt.id;
  return w;
}

/** One revision of the envelope a current runner sends: no criterion, the server binds it. */
function submit(stack: Stack, w: World, key = `${w.task}-1`) {
  return stack.evidence.submit(
    w.ownerId,
    w.task,
    { type: CreatorType.AGENT, id: w.workspaceId },
    {
      sourceSessionId: w.run,
      idempotencyKey: key,
      evidence: {
        claim: 'the work is done and its spec passes',
        checks: [{ kind: 'TOOL_CALL', ref: w.cited, command: 'npm test', succeeded: true }],
        gaps: [],
      },
    } as never,
  );
}

/** The owner's criteria edit, applied: held when it loosens anything, then approved by the owner. */
async function editCriteria(
  stack: Stack,
  w: Pick<World, 'ownerId' | 'project'>,
  items: Array<{ id?: string; text: string }>,
): Promise<void> {
  const response = await stack.projects.update(w.ownerId, w.project, {
    acceptanceCriteriaItems: items.map((item) => ({ ...item, verificationMethod: METHOD })),
  } as never) as { acceptanceCriteriaHold?: { intentId: string; baselineSeal: string } };
  const hold = response.acceptanceCriteriaHold;
  if (!hold) return;
  const [key] = await stack.db.$queryRaw<Array<{ commit_token: string }>>`
    SELECT "commit_token" FROM "project_ratified_action_intent" WHERE "id" = ${hold.intentId}::uuid`;
  const answered = await stack.projects.decideCriteriaChange(w.ownerId, w.project, hold.intentId, {
    commitToken: key!.commit_token, decision: 'APPROVE', baseSeal: hold.baselineSeal,
  } as never);
  assert.equal(answered.applied, true);
}

const reword = (stack: Stack, w: World) => editCriteria(stack, w, [
  { id: w.criterion1, text: WANTS_1_REWORDED }, { id: w.criterion2, text: WANTS_2 },
]);
const deleteDeclared = (stack: Stack, w: World) => editCriteria(stack, w, [{ id: w.criterion2, text: WANTS_2 }]);

/** The same trigger again: another applied edit of the same project that leaves the task's standard as it is. */
async function editAgain(stack: Stack, w: World): Promise<void> {
  const rows = await stack.db.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId: w.project }, orderBy: { ordinal: 'asc' }, select: { id: true, text: true },
  });
  await editCriteria(stack, w, [...rows.map((row) => ({ id: row.id, text: row.text })), { text: WANTS_3 }]);
  const after = await stack.db.projectAcceptanceCriterionDefinition.count({ where: { projectId: w.project } });
  assert.equal(after, rows.length + 1, 'the repeat edit was not applied');
}

/** Everything put on a conversation after its opening prompt, oldest first. */
function messagesOn(db: PrismaClient, sessionId: string | null) {
  if (sessionId === null) return Promise.resolve([]);
  return db.conversationTurn.findMany({
    where: { sessionId, clientTurnId: { not: SessionsService.initialTurnClientId(sessionId) } },
    select: { clientTurnId: true, content: true, sendIntent: true },
    orderBy: { seq: 'asc' },
  });
}

async function told(db: PrismaClient, w: World) {
  return { coord: await messagesOn(db, w.coord), run: await messagesOn(db, w.run) };
}

function newSince<T>(before: readonly T[], after: readonly T[]): T[] {
  assert.deepEqual(after.slice(0, before.length), before, 'what was said before was rewritten');
  return after.slice(before.length);
}

const read = (stack: Stack, w: Pick<World, 'ownerId'>, sessionId: string, taskId: string | null = null) =>
  readPendingEvidenceJudgments(stack.prisma, w.ownerId, { id: sessionId, taskId });

/** The task's runs whose conversations have not ended, by the rule every delivery here uses. */
async function liveRunsOf(db: PrismaClient, taskId: string): Promise<Set<string>> {
  const runs = await db.session.findMany({ where: { taskId }, select: { id: true, ...SESSION_ENDING_SELECT } });
  return new Set(runs.filter((run) => !sessionHasEnded(run)).map((run) => run.id));
}

/**
 * NO ROW SHOWN HAS A REQUIRED ACTION ITS READER CANNOT TAKE. Every row returned for a reader is one
 * that reader can move: a decidable one it may answer (`pending`), an undecidable one it is the live
 * run to file again (`RUN`), or an undecidable one the owner can restart (`OWNER`, `RESTART_TASK`).
 */
function assertEveryRowIsTheReaders(queue: PendingEvidenceJudgmentQueue, liveRuns: Set<string>, where: string) {
  for (const row of queue.pending) {
    assert.equal(row.decidability.decidable, true, `${where}: an undecidable row is asked to be decided`);
    assert.equal(row.independence.independent, true, `${where}: a row this reader may not answer is pending`);
    assert.equal(row.ownerAction, null);
  }
  for (const row of queue.waitingOnYou) {
    assert.equal(row.decidability.decidable, false, `${where}: a decidable row waits on its reader`);
    if (row.decidability.addressee === 'RUN') {
      assert.ok(liveRuns.has(queue.decidingSessionId), `${where}: a run's row is shown to a reader that is not a live run`);
      assert.equal(row.ownerAction, null);
    } else {
      assert.equal(row.decidability.addressee, 'OWNER', `${where}: a row addressed to ${row.decidability.addressee} is shown`);
      assert.equal(row.ownerAction, 'RESTART_TASK', `${where}: an owner's row offers no action`);
    }
  }
}

async function assertReadsHoldTheInvariant(stack: Stack, w: World): Promise<void> {
  const live = await liveRunsOf(stack.db, w.task);
  const readers: Array<[string, string | null]> = [[w.run, w.task], ...[...live].map((id) => [id, w.task] as [string, string])];
  if (w.coord) readers.push([w.coord, null]);
  for (const [id, taskId] of readers) {
    assertEveryRowIsTheReaders(await read(stack, w, id, taskId), live, `reader ${id}`);
  }
}

function rowFor(queue: PendingEvidenceJudgmentQueue, taskId: string) {
  return queue.waitingOnYou.find((row) => row.taskId === taskId) ?? null;
}

type Refusal = { status: number; body: Record<string, unknown> };
async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected a typed refusal, got ${error}`);
    return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
  }
  throw new assert.AssertionError({ message: 'the call was not refused' });
}

/** The live run is steered once with `standard`, the coordinator told once, and a repeat says nothing. */
async function assertLiveRunAndCoordinatorToldOnce(
  stack: Stack,
  w: World,
  before: Awaited<ReturnType<typeof told>>,
  standard: HeldStandard,
  standardWords: string,
  repeat: () => Promise<void>,
): Promise<void> {
  const digest = standardDigest(standard);
  const after = await told(stack.db, w);
  const toRun = newSince(before.run, after.run);
  assert.equal(toRun.length, 1, 'the live run was steered other than once');
  assert.equal(toRun[0]!.clientTurnId, undecidableEvidenceTurnId('run', w.evidenceId, digest));
  assert.ok((toRun[0]!.content ?? '').includes(standardWords), 'the steer does not name the new standard');
  assert.ok((toRun[0]!.content ?? '').includes('task_evidence_submit'));
  const toCoord = newSince(before.coord, after.coord);
  assert.equal(toCoord.length, 1, 'the Automatic coordinator was told other than once');
  assert.equal(toCoord[0]!.clientTurnId, undecidableEvidenceTurnId('coordinator', w.evidenceId, digest));
  const coordSays = toCoord[0]!.content ?? '';
  assert.ok(coordSays.includes(uuidToBase62(w.run)), 'the coordinator is not told the run was told');
  assert.ok(!coordSays.includes('task_evidence_decide'), 'the coordinator is asked to decide a revision nobody can');

  // The live run reads the row it has to file again; the coordinator is not asked to decide it.
  const runRow = rowFor(await read(stack, w, w.run, w.task), w.task);
  assert.ok(runRow, 'the live run does not find the revision it has to file again');
  assert.equal(runRow.decidability.addressee, 'RUN');
  assert.equal(runRow.ownerAction, null);
  if (w.coord) {
    const coordQueue = await read(stack, w, w.coord);
    assert.equal(coordQueue.pending.some((row) => row.taskId === w.task), false);
    assert.equal(rowFor(coordQueue, w.task), null, 'the coordinator conversation shows the run\'s row');
  }
  await assertReadsHoldTheInvariant(stack, w);

  // The trigger again, with the same standard: nothing more, anywhere.
  await repeat();
  assert.deepEqual(await told(stack.db, w), after, 'firing the trigger again with the same standard said something more');
}

/** With no live run, the Automatic coordinator is given it to act on, and nothing starts by itself. */
async function assertCoordinatorToActOn(
  stack: Stack,
  w: World,
  before: Awaited<ReturnType<typeof told>>,
  standard: HeldStandard,
): Promise<void> {
  const after = await told(stack.db, w);
  assert.deepEqual(after.run, before.run, 'a run that has ended was written to');
  const toCoord = newSince(before.coord, after.coord);
  assert.equal(toCoord.length, 1, 'the coordinator was told other than once');
  assert.equal(toCoord[0]!.clientTurnId, undecidableEvidenceTurnId('coordinator', w.evidenceId, standardDigest(standard)));
  const says = toCoord[0]!.content ?? '';
  assert.ok(says.includes('has no running session'));
  assert.ok(says.includes('It is yours to act on'));
  assert.ok(says.includes(`task_start, taskId ${uuidToBase62(w.task)}`));
  assert.ok(says.includes('or change the standard'));
  assert.ok(says.includes('Nothing restarts it by itself'));
  assert.deepEqual([...await liveRunsOf(stack.db, w.task)], [], 'the task was restarted by itself');
  // The action is the coordinator's: no row of it is shown to the owner anywhere.
  for (const [id, taskId] of [[w.run, w.task], [w.coord!, null]] as const) {
    assert.equal(rowFor(await read(stack, w, id, taskId), w.task), null, `reader ${id} is shown the coordinator's row`);
  }
  await assertReadsHoldTheInvariant(stack, w);
}

/** With no coordinator to tell, nobody is messaged; the owner's row offers Restart and it starts the task. */
async function assertOwnerRestarts(
  stack: Stack,
  w: World,
  before: Awaited<ReturnType<typeof told>>,
): Promise<void> {
  assert.deepEqual(await told(stack.db, w), before, 'somebody was messaged though nobody but the owner can act');
  const readers: Array<[string, string | null]> = [[w.run, w.task]];
  if (w.coord) readers.push([w.coord, null]);
  for (const [id, taskId] of readers) {
    const row = rowFor(await read(stack, w, id, taskId), w.task);
    assert.ok(row, `the owner is not shown the row in ${id}`);
    assert.equal(row.decidability.decidable, false);
    assert.equal(row.decidability.addressee, 'OWNER');
    assert.equal(row.ownerAction, 'RESTART_TASK');
    // Fields only: what a released client renders is all still there.
    assert.equal(row.evidenceRevision, '1');
    assert.equal(row.decidability.requiredAction, 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION');
    assert.ok(typeof row.decidability.refusal === 'string');
    assert.deepEqual(row.gaps, []);
  }
  await assertReadsHoldTheInvariant(stack, w);

  // A press for a revision that is not the latest starts nothing.
  const stale = await refusalOf(() => stack.evidence.restartFromEvidence(w.ownerId, w.task, '2'));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, EVIDENCE_RESTART_NOT_OFFERED_CODE);
  assert.deepEqual([...await liveRunsOf(stack.db, w.task)], []);

  // The press: the task is started.
  const pressed = await stack.evidence.restartFromEvidence(w.ownerId, w.task, '1');
  assert.equal(pressed.action, 'RESTART_TASK');
  const live = await liveRunsOf(stack.db, w.task);
  assert.equal(live.size, 1, 'pressing Restart did not start the task');
  assert.ok(!live.has(w.run));

  // Now a run is live, so the action is the run's: the owner is no longer offered it, and a press is refused.
  for (const [id, taskId] of readers) {
    const row = rowFor(await read(stack, w, id, taskId), w.task);
    assert.equal(row, null, `the owner is still shown a row in ${id} once a run is live`);
  }
  await assertReadsHoldTheInvariant(stack, w);
  const again = await refusalOf(() => stack.evidence.restartFromEvidence(w.ownerId, w.task, '1'));
  assert.equal(again.status, 409);
  assert.equal(again.body.code, EVIDENCE_RESTART_NOT_OFFERED_CODE);
  assert.equal(again.body.addressee, 'RUN');
  assert.equal((await liveRunsOf(stack.db, w.task)).size, 1, 'a refused press started something');
}

const declaredStandard = (w: World, text: string): HeldStandard =>
  ({ kind: 'PROJECT_CRITERION', key: criterionKeyOf(w.criterion1), text });
const deletedStandard = (w: World): HeldStandard =>
  ({ kind: 'DECLARED_CRITERION_DELETED', own: { key: uuidToBase62(w.task), text: OWN } });

// ── REWORDED ─────────────────────────────────────────────────────────────────────────────────────

test('reworded, live run: one steer naming the new wording, one coordinator message, and a repeat says nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reworded-live');
      const before = await told(stack.db, w);
      await reword(stack, w);
      await assertLiveRunAndCoordinatorToldOnce(
        stack, w, before, declaredStandard(w, WANTS_1_REWORDED), `“${WANTS_1_REWORDED}”`, () => editAgain(stack, w),
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('reworded, no live run: the Automatic coordinator gets it to act on', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'reworded-idle', { runEnded: true });
    const before = await told(stack.db, w);
    await reword(stack, w);
    await assertCoordinatorToActOn(stack, w, before, declaredStandard(w, WANTS_1_REWORDED));
    const after = await told(stack.db, w);
    await editAgain(stack, w);
    assert.deepEqual(await told(stack.db, w), after, 'the repeat said something more');
  } finally {
    await stack.db.$disconnect();
  }
});

test('reworded, Manual project: nobody is messaged, the owner row offers Restart and pressing it starts the task',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'reworded-manual', { coordinator: 'manual', runEnded: true });
      const before = await told(stack.db, w);
      await reword(stack, w);
      await assertOwnerRestarts(stack, w, before);
    } finally {
      await stack.db.$disconnect();
    }
  });

test('reworded, Manual project with a live run: the run is steered and nobody else is told', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'reworded-manual-live', { coordinator: 'manual' });
    const before = await told(stack.db, w);
    await reword(stack, w);
    const after = await told(stack.db, w);
    assert.equal(newSince(before.run, after.run).length, 1);
    assert.deepEqual(after.coord, before.coord, 'a Manual project\'s coordinator was told');
    assert.equal(rowFor(await read(stack, w, w.coord!), w.task), null);
    await assertReadsHoldTheInvariant(stack, w);
  } finally {
    await stack.db.$disconnect();
  }
});

// ── DELETED ──────────────────────────────────────────────────────────────────────────────────────

test('deleted, live run: one steer naming the standard left, one coordinator message, and a repeat says nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'deleted-live');
      const before = await told(stack.db, w);
      await deleteDeclared(stack, w);
      const task = await stack.db.task.findUniqueOrThrow({ where: { id: w.task } });
      assert.equal(task.criterionDefinitionId, null, 'the declared criterion was not deleted');
      await assertLiveRunAndCoordinatorToldOnce(
        stack, w, before, deletedStandard(w), `“${OWN}”`, () => editAgain(stack, w),
      );
      const [steer] = newSince(before.run, (await told(stack.db, w)).run);
      assert.ok((steer!.content ?? '').includes('no longer exists'));
      assert.ok((steer!.content ?? '').includes('criterionKey: null'));
    } finally {
      await stack.db.$disconnect();
    }
  });

test('deleted, no live run: the Automatic coordinator gets it to act on', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'deleted-idle', { runEnded: true });
    const before = await told(stack.db, w);
    await deleteDeclared(stack, w);
    await assertCoordinatorToActOn(stack, w, before, deletedStandard(w));
  } finally {
    await stack.db.$disconnect();
  }
});

test('deleted, a project with no coordinator at all: the owner row offers Restart and pressing it starts the task',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'deleted-none', { coordinator: 'none', runEnded: true });
      const before = await told(stack.db, w);
      await deleteDeclared(stack, w);
      await assertOwnerRestarts(stack, w, before);
    } finally {
      await stack.db.$disconnect();
    }
  });

// ── MOVED ────────────────────────────────────────────────────────────────────────────────────────

/** A project B for the world's task to move into, and the owner-confirmed move there. */
async function moveToB(
  stack: Stack,
  w: World,
  coordinator: 'automatic' | 'manual',
): Promise<{ projectB: string; coordB: string; criterionB: string }> {
  const b = await project(stack, w, `${w.label} project B`, coordinator, [WANTS_B]);
  let asked: Refusal;
  try {
    await stack.tasks.update(w.ownerId, w.task, {
      projectId: b.id, handoff: { reason: 'it serves B' }, criterionKey: criterionKeyOf(b.criteria[0]!),
    } as never, b.coord!);
    throw new assert.AssertionError({ message: 'the move was not asked for' });
  } catch (error) {
    assert.ok(error instanceof HttpException, String(error));
    asked = { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
  }
  assert.equal(asked.body.code, 'CROSS_PROJECT_APPROVAL_REQUIRED');
  const answer = await stack.handoffs.decide(
    w.ownerId, w.ownerId, String(asked.body.handoffId), 'APPROVE', new Date(), { kind: 'LOGIN' },
  );
  assert.equal(answer.row.state, 'APPLIED');
  return { projectB: b.id, coordB: b.coord!, criterionB: b.criteria[0]! };
}

/** The move's post-commit hand-over once more, as a retried delivery would run it. */
function handOverAgain(stack: Stack, w: World, moved: { projectB: string }) {
  return (stack.tasks as unknown as {
    handOverMovedEvidence(ownerId: string, move: Record<string, unknown>): Promise<void>;
  }).handOverMovedEvidence(w.ownerId, {
    taskId: w.task,
    fromProjectId: w.project,
    toProjectId: moved.projectB,
    withdrawnCriterionDefinitionId: w.criterion1,
  });
}

test('moved, live run: one steer naming the target criterion, one message to the target coordinator, and a repeat says nothing',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'moved-live');
      const runBefore = await messagesOn(stack.db, w.run);
      const sourceBefore = await messagesOn(stack.db, w.coord);
      const moved = await moveToB(stack, w, 'automatic');
      // Read as the target's world: its coordinator is the one told.
      const target: World = { ...w, coord: moved.coordB };
      const before = { run: runBefore, coord: [] as Awaited<ReturnType<typeof messagesOn>> };
      await assertLiveRunAndCoordinatorToldOnce(
        stack, target, before, { kind: 'PROJECT_CRITERION', key: criterionKeyOf(moved.criterionB), text: WANTS_B },
        `“${WANTS_B}”`, () => handOverAgain(stack, w, moved),
      );
      assert.deepEqual(await messagesOn(stack.db, w.coord), sourceBefore, 'the project the task left was told something');
    } finally {
      await stack.db.$disconnect();
    }
  });

test('moved, no live run: the Automatic target coordinator gets it to act on', { skip, timeout: 180_000 }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'moved-idle', { runEnded: true });
    const runBefore = await messagesOn(stack.db, w.run);
    const moved = await moveToB(stack, w, 'automatic');
    const target: World = { ...w, coord: moved.coordB };
    await assertCoordinatorToActOn(stack, target, { run: runBefore, coord: [] },
      { kind: 'PROJECT_CRITERION', key: criterionKeyOf(moved.criterionB), text: WANTS_B });
    const after = await told(stack.db, target);
    await handOverAgain(stack, w, moved);
    assert.deepEqual(await told(stack.db, target), after, 'the repeat said something more');
  } finally {
    await stack.db.$disconnect();
  }
});

test('moved into a Manual project with no live run: the owner row offers Restart and pressing it starts the task',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const w = await world(stack, 'moved-manual', { runEnded: true });
      const runBefore = await messagesOn(stack.db, w.run);
      const moved = await moveToB(stack, w, 'manual');
      const target: World = { ...w, coord: moved.coordB };
      await assertOwnerRestarts(stack, target, { run: runBefore, coord: [] });
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the undecidable-evidence PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
