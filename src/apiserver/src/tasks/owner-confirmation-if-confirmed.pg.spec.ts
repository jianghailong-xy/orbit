/**
 * The confirmation card's "If you confirm", and the report it shows, against real PostgreSQL.
 *
 * `GET /tasks/:taskId/owner-confirmation` (`TaskOwnerConfirmationService.read`) tells the owner what
 * confirming sets off, computed by the server from the rules that will act on it:
 *
 *   (1) the tasks it starts — NOW, WHEN_SLOT_FREES and MANUAL — are the completion edge's own
 *       answer: a dependent the card calls NOW is the one the owner's Confirm done then starts, and
 *       the others are left alone. Reading the card starts nothing. A dependent still waiting on
 *       another prerequisite, or scheduled for later, is not on the card. The project is at its
 *       limit while the card is read, held by the confirmed task's own run, and its DONE gives that
 *       slot back — so the card says NOW, as the edge then does;
 *   (2) a task nothing waits on starts nothing;
 *   (3) the report is what the run said in the turn it DECLARED the work finished, not the turn it
 *       stopped in, and a decision's receipt keeps it; a request from before declarations (0295)
 *       keeps the turn it was asked in;
 *   (4) the branch: lines and files as `changedFiles` counts them, and whether it is on main — a
 *       merge receipt decides even where the branch is not an ancestor (squash), the runner's
 *       verdict answers where no receipt does, and with neither the answer is UNKNOWN;
 *   (5) the landing: NONE outside a project, LINE_THEN_OWNER on a MAIN line or a project branch with
 *       Automatic off, AUTO_MAIN on a project branch with Automatic on — and the dependents wait for
 *       the landing until a receipt says the work is on the line;
 *   (6) an item that cannot be read is left out, and the card is still drawn.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/owner-confirmation-if-confirmed.pg.spec.ts
 *
 * Destructive: it seeds rows, so it runs only against a disposable server.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  CreatorType,
  Prisma,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunEventType, uuidToBase62 } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { configureProjectIntegration } from '../projects/project-integration-line';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { readOwnerConfirmation } from './owner-confirmation-read';
import { TaskOwnerConfirmationService } from './task-owner-confirmation.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
/** Emails are unique and this database can outlive one run. */
const RUN = randomUUID().slice(0, 8);

const DECLARED_REPORT = 'All six review findings are fixed and pushed to the branch — ready for your sign-off.';
const WAKE_OPENER = 'This wake only reports background jobs; their results are the ones I reported.';
const LEGACY_REPORT = 'Done before declarations existed: the turn that ended is the report.';

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  confirmations: TaskOwnerConfirmationService;
}

function connect(): Stack {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    realtime,
  );
  const tasks = new TasksService(prisma, sessions, realtime);
  return { db, tasks, confirmations: new TaskOwnerConfirmationService(prisma, sessions, tasks, realtime) };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

/** An owner with an online runner and a workspace on it, cloned from a repository. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const w = { ownerId: randomUUID(), runnerId: randomUUID(), workspaceId: randomUUID() };
  await db.user.create({
    data: { id: w.ownerId, email: `${label}-${RUN}-${w.ownerId}@confirm.invalid`, name: label, passwordHash: 'x' },
  });
  await runner(db, w.ownerId, w.runnerId, `${label}-runner`, 64);
  await db.workspace.create({
    data: {
      id: w.workspaceId, ownerId: w.ownerId, runnerId: w.runnerId, name: `${label}-agent`, enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}.git`, workDir: `/srv/${label}`,
    },
  });
  return w;
}

function runner(db: PrismaClient, ownerId: string, id: string, name: string, maxConcurrent: number) {
  return db.runner.create({
    data: {
      id, ownerId, name, tokenHash: `hash-${id}`, status: RunnerStatus.ONLINE, capabilities: [],
      capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(), maxConcurrent,
    },
  });
}

/** A task assigned to `workspaceId`, OPEN and not opted into auto-run unless `extra` says so. */
async function seedTask(
  db: PrismaClient,
  w: World,
  projectId: string | null,
  title: string,
  extra: Partial<Prisma.TaskUncheckedCreateInput> = {},
): Promise<string> {
  const id = randomUUID();
  await db.task.create({
    data: {
      id, ownerId: w.ownerId, projectId, assigneeId: w.workspaceId, title: `${title}-${RUN}`,
      creatorType: CreatorType.USER, creatorId: w.ownerId, provider: 'claude',
      completionCriterion: 'EVIDENCE_JUDGMENT', status: TaskStatus.OPEN,
      autoRunWhenReady: false, dispatchHold: false,
      ...extra,
    },
  });
  return id;
}

/** An OWNER_CONFIRMED task whose run is in progress. */
function confirmedTask(db: PrismaClient, w: World, projectId: string | null, title: string) {
  return seedTask(db, w, projectId, title, {
    completionCriterion: 'OWNER_CONFIRMED',
    status: TaskStatus.IN_PROGRESS,
  });
}

/**
 * The rows a run leaves when it declared its work finished in one turn and stopped working in a
 * later one — the claim and the question `runnerApi.turnComplete` records from it — with what the
 * run said in each. `legacy` is a question from before declarations: no claim, asked in one turn.
 */
async function waitingRun(
  db: PrismaClient,
  w: World,
  taskId: string,
  run: {
    declared?: string;
    stopped: string;
    legacy?: boolean;
    session?: Partial<Prisma.SessionUncheckedCreateInput>;
  },
): Promise<{ sessionId: string; requestId: string }> {
  const sessionId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title: `run of ${taskId}`, prompt: 'do the work', provider: 'claude',
      status: RunStatus.AWAITING_INPUT, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      startedAt: new Date(),
      ...run.session,
    },
  });
  let seq = 1;
  const said = (turnId: string, text: string) => db.runEvent.create({
    data: { sessionId, seq: seq++, type: RunEventType.ASSISTANT, payload: { text }, turnId },
  });
  const declaredTurnId = run.legacy ? null : randomUUID();
  const stoppedTurnId = randomUUID();
  if (declaredTurnId) await said(declaredTurnId, run.declared ?? run.stopped);
  await said(stoppedTurnId, run.stopped);
  const claim = declaredTurnId === null ? null : await db.taskOwnerConfirmationClaim.create({
    data: { taskId, ownerId: w.ownerId, sessionId, turnId: declaredTurnId },
    select: { id: true },
  });
  const request = await db.taskOwnerConfirmationRequest.create({
    data: { taskId, ownerId: w.ownerId, sessionId, turnId: stoppedTurnId, claimId: claim?.id ?? null },
    select: { id: true },
  });
  return { sessionId, requestId: request.id };
}

/** A worktree branch with work on it, as the runner reports it at its finalize. */
function onBranch(name: string, extra: Partial<Prisma.SessionUncheckedCreateInput> = {}) {
  return {
    ...extra,
    branch: `${name}-${RUN}`,
    isolationStatus: 'worktree',
    baseSha: 'b'.repeat(40),
    changedFiles: [
      { path: 'src/a.ts', additions: 120, deletions: 30, status: 'M' },
      { path: 'docs/diagram.png', additions: -1, deletions: -1, status: 'A' },
      { path: 'src/b.ts', additions: 5, deletions: 0, status: 'A' },
    ],
  } satisfies Partial<Prisma.SessionUncheckedCreateInput>;
}

/** A merge somebody recorded: this branch, into `targetBranch`. */
function mergedInto(
  db: PrismaClient,
  w: World,
  receipt: { sessionId: string; taskId: string; sourceBranch: string; targetBranch: string; projectId?: string },
) {
  return db.sessionMergeReceipt.create({
    data: {
      ownerId: w.ownerId, sessionId: receipt.sessionId, taskId: receipt.taskId,
      projectId: receipt.projectId ?? null, result: 'MERGED', sourceBranch: receipt.sourceBranch,
      sourceSha: 'a'.repeat(40), targetBranch: receipt.targetBranch, targetShaBefore: 'b'.repeat(40),
      targetShaAfter: 'c'.repeat(40), recordedBy: 'AGENT', idempotencyKey: `merged:${randomUUID()}`,
    },
  });
}

const runs = (db: PrismaClient, taskId: string) =>
  db.session.count({ where: { taskId, startsTaskWork: true } });

/** Whether a door was OFFERED the task: the run door writes a receipt even for a refusal. */
const offered = (db: PrismaClient, ownerId: string, taskId: string) =>
  db.taskRunRequest.count({ where: { ownerId, fingerprint: `task:${taskId}` } });

// ═══ (1) (2) the tasks confirming starts ═══════════════════════════════════════════════════════════

test('(1) the card names the dependents NOW / WHEN_SLOT_FREES / MANUAL exactly as the completion edge '
  + 'then treats them, and reading it starts nothing; (2) a task nothing waits on starts nothing',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'starts');
    // A second runner with room for one run, and that run already on it: whatever is assigned here
    // has a dependency that is satisfied and no slot to start in.
    const busy = { ...w, runnerId: randomUUID(), workspaceId: randomUUID() };
    await runner(s.db, w.ownerId, busy.runnerId, 'starts-busy-runner', 1);
    await s.db.workspace.create({
      data: { id: busy.workspaceId, ownerId: w.ownerId, runnerId: busy.runnerId, name: 'starts-busy', enabled: true },
    });
    await s.db.session.create({
      data: {
        id: randomUUID(), ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: busy.workspaceId,
        assignedRunnerId: busy.runnerId, title: 'the run the busy runner is on', prompt: 'busy',
        provider: 'claude', status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
      },
    });
    // A started project that may run ONE task at a time — and the task being confirmed is it.
    const projectId = randomUUID();
    await s.db.project.create({
      data: { id: projectId, ownerId: w.ownerId, title: `starts-${RUN}`, startedAt: new Date(), maxConcurrentTasks: 1 },
    });
    const finishing = await confirmedTask(s.db, w, projectId, 'finishing');
    const { requestId } = await waitingRun(s.db, w, finishing, { declared: DECLARED_REPORT, stopped: WAKE_OPENER });
    const occupying = await s.db.task.count({
      where: {
        projectId, status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] },
        sessions: { some: { status: { in: [RunStatus.AWAITING_INPUT] } } },
      },
    });
    assert.equal(occupying, 1, 'CONTROL: the project is at its limit, held by the confirmed task\'s own run');

    const now = await seedTask(s.db, w, projectId, 'starts-now', { autoRunWhenReady: true });
    const slot = await seedTask(s.db, busy, projectId, 'starts-when-a-slot-frees', { autoRunWhenReady: true });
    const manual = await seedTask(s.db, w, projectId, 'starts-by-hand');
    const otherPrerequisite = await seedTask(s.db, w, null, 'still-open-prerequisite');
    const blocked = await seedTask(s.db, w, projectId, 'waits-on-another-too', { autoRunWhenReady: true });
    const later = await seedTask(s.db, w, projectId, 'scheduled-for-later', {
      autoRunWhenReady: true, runAt: new Date(Date.now() + 24 * 3_600_000),
    });
    for (const dependent of [now, slot, manual, blocked, later]) {
      await s.db.taskDependency.create({ data: { taskId: dependent, dependsOnTaskId: finishing } });
    }
    await s.db.taskDependency.create({ data: { taskId: blocked, dependsOnTaskId: otherPrerequisite } });

    const card = await s.confirmations.read(w.ownerId, finishing);
    assert.ok(card.waiting, 'CONTROL: a run is waiting on the owner');
    assert.ok(card.ifConfirmed, 'a waiting card says what confirming sets off');
    assert.deepEqual(card.ifConfirmed.startsTasks, [
      { id: now, title: `starts-now-${RUN}`, starts: 'NOW' },
      { id: slot, title: `starts-when-a-slot-frees-${RUN}`, starts: 'WHEN_SLOT_FREES' },
      { id: manual, title: `starts-by-hand-${RUN}`, starts: 'MANUAL' },
    ]);
    for (const dependent of [now, slot, manual, blocked, later]) {
      assert.equal(await runs(s.db, dependent), 0, 'reading the card started a dependent');
      assert.equal(await offered(s.db, w.ownerId, dependent), 0, 'reading the card offered a dependent to the run door');
    }

    // The owner confirms: the completion edge starts what the card called NOW, and nothing else.
    const receipt = await s.confirmations.decide(
      w.ownerId, finishing, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM', requestId },
    );
    assert.equal(receipt.completed, true, 'CONTROL: the confirmation settled the task');
    assert.equal(await runs(s.db, now), 1, 'the dependent the card called NOW was not started');
    for (const [dependent, why] of [
      [slot, 'a dependent with no slot'], [manual, 'a dependent that does not start by itself'],
      [blocked, 'a dependent still waiting on another prerequisite'], [later, 'a dependent scheduled for later'],
    ] as const) {
      assert.equal(await runs(s.db, dependent), 0, `the completion edge started ${why}`);
    }
    const settled = await s.confirmations.read(w.ownerId, finishing);
    assert.equal(settled.waiting, null);
    assert.equal(settled.ifConfirmed, null, 'nothing is waiting, so the card says nothing about confirming');

    // (2) A task nothing waits on: the list is there, and empty.
    const alone = await confirmedTask(s.db, w, null, 'nothing-waits-on-me');
    await waitingRun(s.db, w, alone, { declared: DECLARED_REPORT, stopped: DECLARED_REPORT });
    assert.deepEqual((await s.confirmations.read(w.ownerId, alone)).ifConfirmed?.startsTasks, []);
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (3) the report ════════════════════════════════════════════════════════════════════════════════

test('(3) the report is the declaring turn\'s last message, the receipt keeps it, and a request from '
  + 'before declarations keeps the turn it was asked in',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'report');
    const declared = await confirmedTask(s.db, w, null, 'declared-then-woken');
    const { requestId } = await waitingRun(s.db, w, declared, { declared: DECLARED_REPORT, stopped: WAKE_OPENER });
    const card = await s.confirmations.read(w.ownerId, declared);
    assert.equal(card.waiting?.report?.text, DECLARED_REPORT,
      'the card shows what the run said when it declared, not the wake it stopped in');

    await s.confirmations.decide(
      w.ownerId, declared, { door: 'USER', userId: w.ownerId }, { decision: 'CONFIRM', requestId },
    );
    const receipt = await s.confirmations.read(w.ownerId, declared);
    assert.deepEqual(receipt.decisions.map((each) => each.report?.text), [DECLARED_REPORT],
      'the receipt says what the owner was shown');

    const legacy = await confirmedTask(s.db, w, null, 'asked-before-0295');
    await waitingRun(s.db, w, legacy, { stopped: LEGACY_REPORT, legacy: true });
    assert.equal((await s.confirmations.read(w.ownerId, legacy)).waiting?.report?.text, LEGACY_REPORT);
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (4) the branch and whether it is on main ═════════════════════════════════════════════════════

test('(4) the branch counts lines as changedFiles does, and is on main by its receipt even where it '
  + 'is no ancestor; the runner\'s verdict answers only without one; with neither it is UNKNOWN',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'branch');
    const branchOf = async (taskId: string) => (await s.confirmations.read(w.ownerId, taskId)).ifConfirmed?.branch;

    // Squash-merged: the runner finds the branch tip in no ancestry of main, and a receipt says the
    // work is there.
    const squashed = await confirmedTask(s.db, w, null, 'squash-merged');
    const squashedBranch = onBranch('orbit/squash', { branchMerged: false });
    const squashedRun = await waitingRun(s.db, w, squashed, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: squashedBranch,
    });
    await mergedInto(s.db, w, {
      sessionId: squashedRun.sessionId, taskId: squashed, sourceBranch: squashedBranch.branch, targetBranch: 'main',
    });
    assert.deepEqual(await branchOf(squashed), {
      name: squashedBranch.branch, linesAdded: 125, linesRemoved: 30, files: 3, onMain: 'YES',
    }, 'a receipt puts the branch on main even though it is not an ancestor; a binary file adds no lines');

    // A receipt into some other branch is not main.
    const elsewhere = await confirmedTask(s.db, w, null, 'merged-elsewhere');
    const elsewhereBranch = onBranch('orbit/elsewhere');
    const elsewhereRun = await waitingRun(s.db, w, elsewhere, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: elsewhereBranch,
    });
    await mergedInto(s.db, w, {
      sessionId: elsewhereRun.sessionId, taskId: elsewhere, sourceBranch: elsewhereBranch.branch, targetBranch: 'release',
    });
    assert.equal((await branchOf(elsewhere))?.onMain, 'UNKNOWN');

    // The runner's verdict, with no receipt: an ancestor of main is on it, and a branch it judged
    // and did not find there is not.
    const ancestor = await confirmedTask(s.db, w, null, 'fast-forwarded');
    await waitingRun(s.db, w, ancestor, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: onBranch('orbit/ff', { branchMerged: true }),
    });
    assert.equal((await branchOf(ancestor))?.onMain, 'YES');
    const notYet = await confirmedTask(s.db, w, null, 'not-merged');
    await waitingRun(s.db, w, notYet, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: onBranch('orbit/open', { branchMerged: false }),
    });
    assert.equal((await branchOf(notYet))?.onMain, 'NO');
    // ...but only about the branch it judged: a run that merges into another branch says nothing of main.
    const otherTarget = await confirmedTask(s.db, w, null, 'judged-against-develop');
    await waitingRun(s.db, w, otherTarget, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT,
      session: onBranch('orbit/develop', { branchMerged: true, mergeTarget: 'develop' }),
    });
    assert.equal((await branchOf(otherTarget))?.onMain, 'UNKNOWN');

    // No record of any kind: no receipt, and no verdict from the runner.
    const unknown = await confirmedTask(s.db, w, null, 'nothing-recorded');
    await waitingRun(s.db, w, unknown, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: onBranch('orbit/unknown', { branchMerged: null }),
    });
    assert.equal((await branchOf(unknown))?.onMain, 'UNKNOWN');

    // A run that took no branch has none to describe.
    const shared = await confirmedTask(s.db, w, null, 'no-branch');
    await waitingRun(s.db, w, shared, { declared: DECLARED_REPORT, stopped: DECLARED_REPORT });
    assert.equal(await branchOf(shared), null);
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (5) how it lands, and the session it ends ═══════════════════════════════════════════════════

test('(5) the landing is NONE outside a project, LINE_THEN_OWNER on a MAIN line or with Automatic off, '
  + 'AUTO_MAIN on a project branch with Automatic on; the session it ends and its running jobs',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'landing');
    /** A started project coordinated from the world's workspace, on the line given. */
    const lineProject = async (label: string, line: 'MAIN' | 'PROJECT_BRANCH', automatic: boolean) => {
      const projectId = randomUUID();
      await s.db.project.create({
        data: {
          id: projectId, ownerId: w.ownerId, title: `${label}-${RUN}`, startedAt: new Date(),
          coordinatorEnabled: automatic, coordinatorWorkspaceId: w.workspaceId,
        },
      });
      await s.db.$transaction((tx) => configureProjectIntegration(tx, {
        ownerId: w.ownerId, projectId, settings: { line },
      }));
      return projectId;
    };
    const landingOf = async (taskId: string) => {
      const ifConfirmed = (await s.confirmations.read(w.ownerId, taskId)).ifConfirmed;
      return { landing: ifConfirmed?.landing, startsAfterLanding: ifConfirmed?.startsAfterLanding };
    };
    const codeTask = async (projectId: string | null, label: string) => {
      const taskId = await confirmedTask(s.db, w, projectId, label);
      const run = await waitingRun(s.db, w, taskId, {
        declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: onBranch(`orbit/${label}`),
      });
      return { taskId, ...run };
    };

    // NONE: in no project — and in a project, a codeless task or one whose run took no branch.
    const outside = await codeTask(null, 'outside-any-project');
    assert.deepEqual(await landingOf(outside.taskId), { landing: 'NONE', startsAfterLanding: false });
    const mainLine = await lineProject('main-line', 'MAIN', true);
    const codeless = await seedTask(s.db, w, mainLine, 'codeless', {
      completionCriterion: 'OWNER_CONFIRMED', status: TaskStatus.IN_PROGRESS,
      codeless: true, codelessReason: 'a decision, no code',
    });
    await waitingRun(s.db, w, codeless, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: onBranch('orbit/codeless'),
    });
    assert.deepEqual(await landingOf(codeless), { landing: 'NONE', startsAfterLanding: false });
    const noBranch = await confirmedTask(s.db, w, mainLine, 'no-worktree');
    await waitingRun(s.db, w, noBranch, { declared: DECLARED_REPORT, stopped: DECLARED_REPORT });
    assert.deepEqual(await landingOf(noBranch), { landing: 'NONE', startsAfterLanding: false });

    // LINE_THEN_OWNER: a MAIN line asks the owner whatever Automatic says, and so does a project
    // branch with Automatic off.
    const onMainLine = await codeTask(mainLine, 'on-a-main-line');
    assert.deepEqual(await landingOf(onMainLine.taskId), { landing: 'LINE_THEN_OWNER', startsAfterLanding: true });
    const manualBranch = await lineProject('branch-automatic-off', 'PROJECT_BRANCH', false);
    const onManualBranch = await codeTask(manualBranch, 'on-a-project-branch-automatic-off');
    assert.deepEqual(await landingOf(onManualBranch.taskId), { landing: 'LINE_THEN_OWNER', startsAfterLanding: true });

    // AUTO_MAIN: the project's own branch, with Automatic on.
    const autoBranch = await lineProject('branch-automatic-on', 'PROJECT_BRANCH', true);
    const onAutoBranch = await codeTask(autoBranch, 'on-a-project-branch-automatic-on');
    assert.deepEqual(await landingOf(onAutoBranch.taskId), { landing: 'AUTO_MAIN', startsAfterLanding: true });
    // Once a receipt puts the work on the line, its dependents no longer wait for the landing.
    await mergedInto(s.db, w, {
      sessionId: onAutoBranch.sessionId, taskId: onAutoBranch.taskId, projectId: autoBranch,
      sourceBranch: `orbit/on-a-project-branch-automatic-on-${RUN}`, targetBranch: `project/${uuidToBase62(autoBranch)}`,
    });
    assert.deepEqual(await landingOf(onAutoBranch.taskId), { landing: 'AUTO_MAIN', startsAfterLanding: false });

    // The run a DONE ends: the waiting session, while it is open, with the jobs it still runs.
    const withJobs = await confirmedTask(s.db, w, null, 'jobs-still-running');
    const jobsRun = await waitingRun(s.db, w, withJobs, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT, session: { runningBgJobs: ['bgj_suite', 'bgj_build'] },
    });
    assert.deepEqual((await s.confirmations.read(w.ownerId, withJobs)).ifConfirmed?.endsSession,
      { sessionId: jobsRun.sessionId, runningBgJobs: 2 });
    const ended = await confirmedTask(s.db, w, null, 'run-already-over');
    await waitingRun(s.db, w, ended, {
      declared: DECLARED_REPORT, stopped: DECLARED_REPORT,
      session: { status: RunStatus.SUCCEEDED, completedAt: new Date() },
    });
    assert.equal((await s.confirmations.read(w.ownerId, ended)).ifConfirmed?.endsSession, null,
      'a run that is already over is not one the DONE ends');
  } finally {
    await s.db.$disconnect();
  }
});

// ═══ (6) best-effort ═══════════════════════════════════════════════════════════════════════════════

test('(6) an item that cannot be read is left out, and the rest of the card is drawn',
{ skip, timeout: 300_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const s = connect();
  try {
    const w = await world(s.db, 'best-effort');
    const taskId = await confirmedTask(s.db, w, null, 'partly-unreadable');
    const branch = onBranch('orbit/partly', { branchMerged: true });
    const run = await waitingRun(s.db, w, taskId, {
      declared: DECLARED_REPORT, stopped: WAKE_OPENER, session: branch,
    });
    const tx = s.db as unknown as Prisma.TransactionClient;

    // CONTROL: everything readable, everything there.
    const whole = await readOwnerConfirmation(tx, w.ownerId, taskId, s.tasks);
    assert.deepEqual(Object.keys(whole?.ifConfirmed ?? {}).sort(),
      ['branch', 'endsSession', 'landing', 'mainBranch', 'startsAfterLanding', 'startsTasks']);

    // The completion edge cannot be asked: no tasks are named — and nothing else is lost.
    const noRelease = await readOwnerConfirmation(tx, w.ownerId, taskId, {
      dependentRelease: () => Promise.reject(new Error('the completion edge could not be read')),
    });
    assert.equal(noRelease?.waiting?.report?.text, DECLARED_REPORT, 'the card is still drawn, with its report');
    assert.equal('startsTasks' in (noRelease?.ifConfirmed ?? {}), false, 'an unreadable item is left out');
    assert.deepEqual(noRelease?.ifConfirmed, {
      landing: 'NONE',
      startsAfterLanding: false,
      branch: { name: branch.branch, linesAdded: 125, linesRemoved: 30, files: 3, onMain: 'YES' },
      endsSession: { sessionId: run.sessionId, runningBgJobs: 0 },
      // A task in no project names no project's main branch.
      mainBranch: null,
    });

    // The merge receipts cannot be read: the branch is left out rather than guessed at.
    const receiptsDown = new Proxy(s.db, {
      get: (target, name) => name === 'sessionMergeReceipt'
        ? { findMany: () => Promise.reject(new Error('session_merge_receipt is unreadable')) }
        : (target as unknown as Record<string | symbol, unknown>)[name],
    }) as unknown as Prisma.TransactionClient;
    const noBranch = await readOwnerConfirmation(receiptsDown, w.ownerId, taskId, s.tasks);
    assert.equal(noBranch?.waiting?.report?.text, DECLARED_REPORT);
    assert.equal('branch' in (noBranch?.ifConfirmed ?? {}), false, 'the branch is left out, not guessed');
    assert.deepEqual(noBranch?.ifConfirmed, {
      startsTasks: [],
      landing: 'NONE',
      startsAfterLanding: false,
      endsSession: { sessionId: run.sessionId, runningBgJobs: 0 },
      mainBranch: null,
    });
  } finally {
    await s.db.$disconnect();
  }
});
