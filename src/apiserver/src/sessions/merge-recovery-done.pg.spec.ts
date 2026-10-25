/**
 * DONE ENDS A MERGE RECOVERY THAT FOUND THE SESSION ALREADY ON ORIGIN, AND A LANDING FROM ELSEWHERE CLEARS
 * ONE — OVER A REAL POSTGRESQL.
 *
 * S3 of the merge-recovery repair loop (project 34hIv3wbdtsxpc5RzDlOk). A check that answers ALREADY_LANDED
 * found every one of the session's commits on origin/<target> as other commits with the same patch-id. The
 * owner's Done (`recoveryAction: 'confirm-landed'` on POST /sessions/:id/merge) records the session merged
 * there, clears the recovery, and leaves the MATCHED_BY_CONTENT receipt the dispatch gate answers a later
 * merge of that source with — all on the server, with nothing sent to a runner. Every other write that
 * records a session as landed — an integration landing (a task's LAND_TASK, and the promotion that merges it
 * into main), a merge receipt, an ordinary merge — clears the recovery the session was still holding. And a
 * match by content is no ancestry-proven ALREADY_MERGED: nothing that reads a landed receipt counts it.
 *
 * The cases are the task's named scenarios, through the doors a client, an agent and a runner use, over real
 * rows. The ancestry check an ALREADY_MERGED receipt has to pass is the runner's (CLI and MCP), and
 * scripts/test-merge-recovery-server.mjs runs its Go tests beside this file.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/merge-recovery-done.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to the rows it made.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, HttpException } from '@nestjs/common';
import { Prisma, PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } from '@prisma/client';
import {
  type IntegrationCheckResult,
  type IntegrationJobCommand,
  type IntegrationJobResultRequest,
  type MergeRecovery,
  RunEventType,
  RunStatus as SharedRunStatus,
  SESSION_MERGE_RECOVERY_V1,
  readMergeRecovery,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import {
  readLandingBranches,
  receiptIsLandingEvidence,
  taskLanding,
  taskLandingSql,
} from '../projects/project-criterion-landing';
import { INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND } from '../projects/project-integration-job';
import { configureProjectIntegration } from '../projects/project-integration-line';
import { ProjectOpenItemService } from '../projects/project-open-item.service';
import { ProjectPromotionService } from '../projects/project-promotion.service';
import type { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { prerequisiteLandedSql } from '../tasks/task-dependencies';
import { TasksService } from '../tasks/tasks.service';
import { MATCHED_BY_CONTENT, mergeReceiptRow, type MergeReceiptRow } from './merge-receipt';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

// The commits a check reads. Distinct, so an assertion that picked up the wrong one fails on the value.
const SOURCE = 'a'.repeat(40);
const LOCAL = 'b'.repeat(40);
const REMOTE = 'c'.repeat(40);
const MERGED = 'd'.repeat(40);

// The commits the simulated integration runner reports.
const TASK_BRANCH_TIP = '1'.repeat(40);
const LINE_BEFORE = '2'.repeat(40);
const LANDED_ON_LINE = '3'.repeat(40);
const LANDED_TREE = '4'.repeat(40);
const MAIN_CHECKED = '5'.repeat(40);
const CHECK_MERGE = '6'.repeat(40);
const CHECKED_TREE = '7'.repeat(40);
const MERGE_COMMIT = '8'.repeat(40);

const CAPABLE = [SESSION_MERGE_RECOVERY_V1, INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];
/** The runner process that claims merges in this file. */
const LEASE = randomUUID();

/** The runner's own clock format for `checkedAt`: RFC 3339 to the second, as merge_recovery.go writes it. */
const rfc3339 = (at: Date) => at.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * What a check answers when origin/<target> carries every commit of the session as rebase copies, exactly as
 * R1's runner sends it: no previewId, since the runner mints one only for a check that builds a candidate.
 */
function alreadyLanded(extra: Partial<MergeRecovery> = {}): MergeRecovery {
  return {
    code: 'ALREADY_LANDED', targetBranch: 'main', repoRoot: '/repo', sourceSha: SOURCE, localSha: LOCAL, remoteSha: REMOTE,
    patch: '', checkedAt: rfc3339(new Date()),
    localCommits: [{ sha: LOCAL, subject: 'Local main work', author: 'Alice', date: '2026-10-11T08:00:00Z' }],
    landedCommits: [
      { sha: 'e'.repeat(40), subject: 'Session list wiring tests', author: 'Alice', date: '2026-10-11T10:34:00Z', sourceSha: SOURCE },
      { sha: 'f'.repeat(40), subject: 'Agents model', author: 'Alice', date: '2026-10-11T09:36:00Z', sourceSha: '9'.repeat(40) },
    ],
    ...extra,
  };
}

/** What an earlier Merge into main and its check left on a session: a diverged target, never repaired. */
function diverged(target = 'main'): MergeRecovery {
  const previewId = randomUUID().replace(/-/g, '');
  return {
    code: 'TARGET_DIVERGED', targetBranch: target, repoRoot: '/repo', previewId, sourceSha: SOURCE, localSha: LOCAL,
    remoteSha: REMOTE, checkedAt: rfc3339(new Date()), patch: '',
    localCommits: [{ sha: LOCAL, subject: 'Local main work', author: 'Alice', date: '2026-10-03T08:00:00Z' }],
    remoteCommits: [{ sha: REMOTE, subject: 'Origin moved on', author: 'Bob', date: '2026-10-03T09:00:00Z' }],
  };
}

type Result = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 1_200,
  outputTail: 'ok\n',
};

/** The task's branch landed on the project branch. */
const LANDED_ON_PROJECT_BRANCH: Result = {
  state: 'LANDED', phase: 'VERIFY', sourceSha: TASK_BRANCH_TIP, targetShaBefore: LINE_BEFORE, testedSha: LANDED_ON_LINE,
  testedTreeSha: LANDED_TREE, landedSha: LANDED_ON_LINE, landedTreeSha: LANDED_TREE, aheadOfUpstream: 1,
};

/** The project branch merges cleanly onto main, every check green. */
const CLEAN_CHECK: Result = {
  state: 'READY', phase: 'CHECK', sourceSha: LANDED_ON_LINE, targetShaBefore: MAIN_CHECKED, upstreamSha: MAIN_CHECKED,
  testedSha: CHECK_MERGE, testedTreeSha: CHECKED_TREE, aheadOfUpstream: 1, filesChanged: 3, checks: [GREEN_CHECK],
  conflicts: [],
};

/** The merge the owner confirmed, on main. */
const MERGED_ON_MAIN: Result = {
  state: 'LANDED', phase: 'VERIFY', sourceSha: LANDED_ON_LINE, targetShaBefore: MAIN_CHECKED, upstreamSha: MAIN_CHECKED,
  testedSha: MERGE_COMMIT, testedTreeSha: CHECKED_TREE, landedSha: MERGE_COMMIT, landedTreeSha: CHECKED_TREE,
};

interface Stack {
  db: PrismaClient;
  sessions: SessionsService;
  controller: SessionsController;
  receipts: MergeReceiptService;
  tasks: TasksService;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  api: RunnerApiController;
  /** The heartbeat's merge drain: the one place a queued merge reaches a runner. */
  drain: RealtimeService;
}

/** One API replica over one client: the session doors, the receipt doors, the runner's routes and the relay. */
function connect(url: string): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  // No device and no runner process is reached from here: every announcement resolves and says nothing.
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const push = new Proxy({}, { get: () => async () => undefined }) as never;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const receipts = new MergeReceiptService(prisma);
  const controller = new SessionsController(sessions, prisma, realtime, {} as never, receipts, {} as never);
  const openItems = new ProjectOpenItemService(prisma, sessions);
  const tasks = new TasksService(prisma, sessions, realtime, undefined, undefined, undefined, openItems);
  const jobs = new IntegrationJobRelay(prisma, openItems);
  const promotions = new ProjectPromotionService(prisma);
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    push,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    tasks,
    undefined,
    undefined,
    openItems,
    jobs,
    undefined,
    promotions,
  );
  return { db, sessions, controller, receipts, tasks, jobs, promotions, api, drain: new RealtimeService(prisma, push) };
}

interface World { label: string; ownerId: string; runnerId: string; workspaceId: string }

/** One owner and one runner that can check and repair target branches, with one workspace on it. */
async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@merge-recovery-done.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: CAPABLE, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}.git`, workDir: `/srv/${label}`,
    },
  });
  return { label, ownerId, runnerId, workspaceId };
}

/** A finished run on a worktree branch, its merge state as `row` says. */
async function finishedSession(
  db: PrismaClient,
  w: World,
  label: string,
  row: Partial<Prisma.SessionUncheckedCreateInput> = {},
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id, ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, assignedRunnerId: w.runnerId,
      title: label, prompt: 'ship the feature', provider: 'claude', providerBuiltin: true,
      dispatchOrigin: SessionDispatchOrigin.USER, status: RunStatus.SUCCEEDED, startedAt: new Date(Date.now() - 7_200_000),
      finishedAt: new Date(Date.now() - 3_600_000), numTurns: 1, branch: `orbit/${label}-${id.slice(0, 8)}`,
      isolationStatus: 'worktree', ...row,
    },
  });
  return id;
}

/** A session's merge state as a recovery check left it: `recovery` stored, the check's action, an error status. */
async function strand(db: PrismaClient, id: string, recovery: MergeRecovery, row: Prisma.SessionUncheckedUpdateInput = {}) {
  await db.session.update({
    where: { id },
    data: {
      mergeStatus: 'error', mergeError: 'local main has diverged from origin/main', mergeTarget: recovery.targetBranch,
      mergeRecovery: recovery as unknown as Prisma.InputJsonValue, mergeRecoveryAction: 'preview', ...row,
    },
  });
}

/**
 * The owner's Check again — or, with no action, the owner's Merge — as the runner performs it: queued, handed
 * out at the heartbeat and answered with `answer`, an error carrying the recovery, as alreadyLandedOutcome does.
 */
async function check(s: Stack, w: World, id: string, answer: MergeRecovery, recoveryAction?: 'preview') {
  await s.sessions.mergeToMain(w.ownerId, id, answer.targetBranch, undefined, recoveryAction ? { recoveryAction } : {});
  const commands = await s.drain.drainMergeRequests(w.runnerId, LEASE, true);
  assert.equal(commands.length, 1, 'the heartbeat hands out the one check');
  const [command] = commands;
  assert.equal(command!.sessionId, id);
  assert.equal(command!.recoveryAction, recoveryAction);
  await s.api.mergeResult({ id: w.runnerId }, id, {
    status: 'error', operationId: command!.operationId, leaseOwner: LEASE, sourceSha: answer.sourceSha,
    targetBranch: answer.targetBranch, targetShaBefore: answer.localSha, recovery: answer,
    message: `every commit of this session is already on origin/${answer.targetBranch} — nothing is left to merge`,
  });
  return command!;
}

/** Every column of the session row, so a refusal can be shown to have written nothing. */
const sessionRow = (db: PrismaClient, id: string) => db.session.findUniqueOrThrow({ where: { id } });

/** The session's receipts, oldest first. */
const receiptsOf = (db: PrismaClient, id: string) =>
  db.sessionMergeReceipt.findMany({ where: { sessionId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

/** The 409 a refused Done answers with, and its sentence. */
async function refused(call: () => Promise<unknown>, message: RegExp) {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof HttpException, `refused with ${String(error)}`);
    assert.equal(error.getStatus(), 409);
    assert.match(error.message, message);
    return true;
  });
}

interface ProjectWorld extends World { projectId: string }

/** A project integrating on a project branch, in a repository its workspace has, the owner's Automatic off. */
async function projectWorld(s: Stack, label: string): Promise<ProjectWorld> {
  const w = await world(s.db, label);
  const projectId = randomUUID();
  await s.db.project.create({
    data: {
      id: projectId, ownerId: w.ownerId, title: `${label} project`, goal: 'a landing ends the recovery it makes stale',
      coordinatorEnabled: false, coordinatorWorkspaceId: w.workspaceId,
    },
  });
  await s.db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await s.db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId: w.ownerId, projectId, settings: { line: 'PROJECT_BRANCH' },
  }));
  return { ...w, projectId };
}

/**
 * A code task of the project settled DONE by its own acceptance command, through the runner's doors; its DONE
 * queues its landing on the project branch. Its work session has finished, so nothing holds the landing.
 */
async function doneCodeTask(s: Stack, w: ProjectWorld, label: string): Promise<{ taskId: string; sessionId: string }> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const declared = await s.tasks.create(w.ownerId, {
    title, assigneeId: w.workspaceId, projectId: w.projectId, acceptanceCommand: 'exit 0', acceptanceExpectedExitCode: 0,
  });
  const sessionId = randomUUID();
  const turnId = randomUUID();
  await s.db.session.create({
    data: {
      id: sessionId, ownerId: w.ownerId, creatorId: w.ownerId, taskId: declared.id, workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId, title, prompt: title, provider: 'claude', status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, startedAt: new Date(),
      finishedAt: new Date(Date.now() - 60_000), branch: `orbit/${label}-${sessionId.slice(0, 8)}`,
      worktreeBranch: `orbit/${label}-${sessionId.slice(0, 8)}`, worktreeDirty: false, isolationStatus: 'worktree',
      baseSha: '0'.repeat(40),
    },
  });
  await s.db.conversationTurn.create({
    data: {
      id: turnId, sessionId, seq: 1, clientTurnId: `message:${turnId}`, kind: 'message', content: 'execute the task',
      status: 'IN_FLIGHT', deliveredAt: new Date(),
    },
  });
  await s.api.events({ id: w.runnerId }, sessionId, {
    events: [{ seq: 1, type: RunEventType.ASSISTANT, ts: new Date().toISOString(), turnId, payload: { text: 'the work is on the branch' } }],
  });
  await s.api.turnComplete({ id: w.runnerId }, sessionId, { turnId, status: SharedRunStatus.SUCCEEDED });
  const acceptance = await (s.api as unknown as {
    dequeueTurn: (sessionId: string, runnerId: string, leaseGeneration: string | null) =>
      Promise<{ turnId: string; taskAcceptance?: boolean } | null>;
  }).dequeueTurn(sessionId, w.runnerId, null);
  assert.equal(acceptance?.taskAcceptance, true, 'the acceptance command was queued for the task');
  await s.api.turnComplete({ id: w.runnerId }, sessionId, {
    turnId: acceptance!.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'shell', shellExitCode: 0, shellOutput: '',
  });
  const task = await s.db.task.findUniqueOrThrow({ where: { id: declared.id }, select: { status: true } });
  assert.equal(task.status, TaskStatus.DONE, 'the acceptance command agreed');
  return { taskId: declared.id, sessionId };
}

/** The one integration job a heartbeat hands out, which has to be of the kind named. */
async function onlyClaim(s: Stack, w: World, kind: string): Promise<IntegrationJobCommand> {
  const claimed = await s.jobs.dispatch({ runnerId: w.runnerId, leaseOwner: `lease-${w.label}`, draining: false, capabilities: CAPABLE });
  assert.equal(claimed.length, 1, `expected one ${kind} to be handed out`);
  assert.equal(claimed[0]!.kind, kind);
  return claimed[0]!;
}

/** The result a runner posts for an integration job it holds, over the route it posts it on. */
async function report(s: Stack, w: World, job: IntegrationJobCommand, result: Result): Promise<void> {
  const answer = await s.api.integrationJobResult({ id: w.runnerId }, job.jobId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, ...result,
  });
  assert.equal(answer.accepted, true, `the result route refused ${result.state}`);
}

test('S3 Done ends an ALREADY_LANDED merge recovery, and a landing from elsewhere clears one, on PostgreSQL', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const s = connect(url);
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const owner = (w: World) => ({ userId: w.ownerId, email: 'owner@merge-recovery-done.invalid' });

  await t.test('S3 Done records the session merged and clears the recovery', async () => {
    const w = await world(s.db, 'done');
    // Both checks that answer it: the owner's Check again, and an ordinary Merge that found the work already there.
    for (const recoveryAction of ['preview', undefined] as const) {
      const label = recoveryAction ?? 'merge';
      const id = await finishedSession(s.db, w, `done-${label}`);
      const sent = alreadyLanded();
      const command = await check(s, w, id, sent, recoveryAction);
      const { previewId, ...rest } = readMergeRecovery((await sessionRow(s.db, id)).mergeRecovery)!;
      assert.match(previewId ?? '', /^[0-9a-f]{32}$/, `${label}: the stored result was given a previewId of its own`);
      assert.deepEqual(rest, sent, `${label}: and is otherwise what the runner sent`);
      const before = await receiptsOf(s.db, id);

      const startedAt = Date.now();
      const answer = await s.controller.mergeToMain(owner(w), id,
        { recoveryAction: 'confirm-landed', previewId }) as unknown as Record<string, unknown>;
      const endedAt = Date.now();

      const done = await sessionRow(s.db, id);
      assert.equal(done.mergeStatus, 'merged', label);
      assert.equal(done.branchMerged, true, label);
      assert.equal(done.mergedSourceSha, SOURCE, `${label}: merged at the source the check found on origin`);
      assert.ok(done.mergedAt && done.mergedAt.getTime() >= startedAt && done.mergedAt.getTime() <= endedAt,
        `${label}: merged now`);
      assert.equal(done.mergeRecovery, null, `${label}: the recovery is cleared`);
      assert.equal(done.mergeRecoveryAction, null, `${label}: and its action`);
      assert.equal(done.mergeTarget, 'main');
      assert.equal(done.mergeError, null);

      const after = await receiptsOf(s.db, id);
      assert.deepEqual(after.slice(0, before.length), before, `${label}: what was recorded before is untouched`);
      assert.equal(after.length, before.length + 1, `${label}: one record written`);
      const receipt = after.at(-1)!;
      assert.equal(receipt.result, MATCHED_BY_CONTENT);
      assert.equal(receipt.recordedBy, 'USER');
      assert.equal(receipt.sourceSha, SOURCE);
      assert.equal(receipt.sourceBranch, done.branch);
      assert.equal(receipt.targetBranch, 'main');
      assert.equal(receipt.targetShaBefore, REMOTE, `${label}: the origin tip the check read carries the work`);
      assert.equal(receipt.targetShaAfter, REMOTE, `${label}: and nothing moved it`);
      assert.deepEqual(receipt.conflicts, []);
      assert.deepEqual(receipt.detail, {
        source: 'confirm-landed', previewId, checkedAt: sent.checkedAt,
        landedCommits: sent.landedCommits!.map(({ sha, sourceSha }) => ({ sha, sourceSha })),
      });

      // Answered as a later Merge of the same source is.
      assert.equal(answer.ok, true);
      assert.equal(answer.alreadyMerged, true);
      assert.equal(answer.sourceSha, SOURCE);
      assert.equal(answer.targetSha, REMOTE);
      assert.equal((answer.receipt as Record<string, unknown>).id, receipt.id);
      // Nothing went to a runner: no operation was minted, and the heartbeat hands nothing out.
      assert.equal(done.mergeOperationId, command.operationId, `${label}: no operation was queued`);
      assert.deepEqual(await s.drain.drainMergeRequests(w.runnerId, LEASE, true), []);
    }
  });

  await t.test('S3 Done with a stale previewId or on a result other than ALREADY_LANDED is refused 409 and writes nothing', async () => {
    const w = await world(s.db, 'refused');
    const current = randomUUID().replace(/-/g, '');
    const ready: MergeRecovery = {
      code: 'READY', targetBranch: 'main', repoRoot: '/repo', previewId: current, sourceSha: SOURCE, localSha: LOCAL,
      remoteSha: REMOTE, candidateSha: MERGED, candidateTreeSha: 'e'.repeat(40), patch: 'the candidate diff',
      check: { status: 'unconfigured' }, checkedAt: rfc3339(new Date()),
    };
    const cases: Array<{
      label: string; recovery: MergeRecovery | null; previewId?: string; targetBranch?: string;
      row?: Prisma.SessionUncheckedUpdateInput; message: RegExp;
    }> = [
      { label: 'a previewId another check gave', recovery: alreadyLanded({ previewId: current }), previewId: 'an-older-check',
        message: /no longer current/ },
      { label: 'no previewId', recovery: alreadyLanded({ previewId: current }), message: /no longer current/ },
      { label: 'another target', recovery: alreadyLanded({ previewId: current }), previewId: current, targetBranch: 'develop',
        message: /no longer current/ },
      { label: 'no recovery at all', recovery: null, previewId: current, message: /no longer current/ },
      { label: 'a conflict', recovery: { ...diverged(), code: 'CONFLICT', previewId: current, conflicts: ['src/app.ts'] },
        previewId: current, message: /nothing to confirm/ },
      { label: 'a diverged target', recovery: { ...diverged(), previewId: current }, previewId: current, message: /nothing to confirm/ },
      { label: 'a ready candidate', recovery: ready, previewId: current, message: /nothing to confirm/ },
      { label: 'a repair in progress', recovery: { ...diverged(), code: 'REPAIR_IN_PROGRESS', previewId: current }, previewId: current,
        message: /nothing to confirm/ },
      { label: 'an ALREADY_LANDED naming no source', recovery: alreadyLanded({ previewId: current, sourceSha: undefined }),
        previewId: current, message: /nothing to confirm/ },
      { label: 'a check in flight', recovery: alreadyLanded({ previewId: current }), previewId: current,
        row: { mergeStatus: 'pending', mergeOperationId: randomUUID(), mergeRequestedAt: new Date() }, message: /in flight/ },
    ];
    for (const c of cases) {
      const id = await finishedSession(s.db, w, `refused-${c.label.replace(/\W+/g, '-')}`);
      if (c.recovery) await strand(s.db, id, c.recovery, c.row);
      const before = await sessionRow(s.db, id);
      await refused(() => s.controller.mergeToMain(owner(w), id, {
        recoveryAction: 'confirm-landed', previewId: c.previewId, ...(c.targetBranch ? { targetBranch: c.targetBranch } : {}),
      }), c.message);
      assert.deepEqual(await sessionRow(s.db, id), before, `${c.label}: the session row is untouched`);
      assert.deepEqual(await receiptsOf(s.db, id), [], `${c.label}: nothing is recorded`);
    }
  });

  await t.test('S3 after Done a merge of the same source is answered as already landed and is not dispatched', async () => {
    const w = await world(s.db, 'again');
    const id = await finishedSession(s.db, w, 'again');
    await check(s, w, id, alreadyLanded(), 'preview');
    const { previewId } = readMergeRecovery((await sessionRow(s.db, id)).mergeRecovery)!;
    await s.controller.mergeToMain(owner(w), id, { recoveryAction: 'confirm-landed', previewId });
    const done = await sessionRow(s.db, id);
    const [record] = (await receiptsOf(s.db, id)).filter((r) => r.result === MATCHED_BY_CONTENT);
    assert.ok(record, 'Done left its record');

    // The owner's Merge, as the Merge button sends it: answered from that record, nothing queued.
    const merge = await s.controller.mergeToMain(owner(w), id, { targetBranch: 'main' }) as unknown as Record<string, unknown>;
    assert.equal(merge.ok, true);
    assert.equal(merge.alreadyMerged, true);
    assert.equal(merge.sourceSha, SOURCE);
    assert.equal(merge.targetSha, REMOTE);
    const shown = merge.receipt as Record<string, unknown>;
    assert.equal(shown.id, record.id);
    assert.equal(shown.result, MATCHED_BY_CONTENT);
    // A caller that waits, naming no target (the session's own): settled at once, by the same record.
    const waited = await s.sessions.mergeToMain(w.ownerId, id, undefined, 5) as unknown as Record<string, unknown>;
    assert.equal(waited.outcome, 'SETTLED');
    assert.equal(waited.mergeStatus, 'merged');
    assert.equal((waited.receipt as Record<string, unknown>).id, record.id);
    // Neither reached a runner: the row is as Done left it, and the heartbeat hands nothing out.
    assert.deepEqual(await sessionRow(s.db, id), done);
    assert.deepEqual(await s.drain.drainMergeRequests(w.runnerId, LEASE, true), []);

    // The record answers for that source in that target only: a merge into another branch goes to the runner.
    await s.controller.mergeToMain(owner(w), id, { targetBranch: 'develop' });
    const [elsewhere, ...more] = await s.drain.drainMergeRequests(w.runnerId, LEASE, true);
    assert.equal(more.length, 0);
    assert.equal(elsewhere?.sessionId, id);
    assert.equal(elsewhere?.targetBranch, 'develop');
  });

  await t.test('S3 an integration landing clears the recovery its session was holding', async () => {
    const w = await projectWorld(s, 'integration');
    const task = await doneCodeTask(s, w, 'integration');
    // The owner had pressed Merge into main on the work session, and the check left a diverged target.
    await strand(s.db, task.sessionId, diverged());
    await report(s, w, await onlyClaim(s, w, 'LAND_TASK'), LANDED_ON_PROJECT_BRANCH);
    const landed = await sessionRow(s.db, task.sessionId);
    assert.equal(landed.mergeRecovery, null, 'the task\'s landing cleared the recovery');
    assert.equal(landed.mergeRecoveryAction, null, 'and its action');
    assert.equal((await receiptsOf(s.db, task.sessionId)).filter((r) => r.result === 'MERGED').length, 1,
      'in the transaction that wrote its receipt');

    // The promotion that carries it into main, after another Merge into main left another recovery.
    await report(s, w, await onlyClaim(s, w, 'CHECK_PROMOTION'), CLEAN_CHECK);
    const promotion = await s.db.projectPromotion.findFirstOrThrow({
      where: { projectId: w.projectId }, select: { id: true, state: true },
    });
    assert.equal(promotion.state, 'READY', 'the candidate waits for the owner');
    await strand(s.db, task.sessionId, diverged());
    await s.promotions.confirm({ userId: w.ownerId }, w.projectId, promotion.id, LANDED_ON_LINE);
    await report(s, w, await onlyClaim(s, w, 'LAND_PROMOTION'), MERGED_ON_MAIN);
    assert.equal((await s.db.projectPromotion.findUniqueOrThrow({ where: { id: promotion.id } })).state, 'MERGED');
    const onMain = await sessionRow(s.db, task.sessionId);
    assert.equal(onMain.mergeRecovery, null, 'the merge into main cleared it again');
    assert.equal(onMain.mergeRecoveryAction, null);

    // A check in flight keeps its own: the landing is recorded, and the recovery is left to that check's answer.
    const v = await projectWorld(s, 'integration-in-flight');
    const busy = await doneCodeTask(s, v, 'integration-in-flight');
    const land = await onlyClaim(s, v, 'LAND_TASK');
    const stranded = diverged();
    await strand(s.db, busy.sessionId, stranded, { mergeStatus: 'pending', mergeOperationId: randomUUID(), mergeRequestedAt: new Date() });
    await report(s, v, land, LANDED_ON_PROJECT_BRANCH);
    const kept = await sessionRow(s.db, busy.sessionId);
    assert.deepEqual(kept.mergeRecovery, stranded, 'a check in flight keeps the recovery');
    assert.equal(kept.mergeRecoveryAction, 'preview');
    assert.equal(kept.mergeStatus, 'pending');
    assert.equal((await receiptsOf(s.db, busy.sessionId)).filter((r) => r.result === 'MERGED').length, 1,
      'and the landing is recorded all the same');
  });

  await t.test('S3 a merge-receipt landing clears the recovery its session was holding', async () => {
    const w = await world(s.db, 'receipt');
    // MERGED through the owner's door and ALREADY_MERGED through an agent's: each ends the recovery in the write that records it.
    for (const [label, input, door] of [
      ['merged', { result: 'MERGED', sourceSha: SOURCE, targetBranch: 'main', targetShaBefore: REMOTE, targetShaAfter: MERGED }, 'user'],
      ['already-merged', { result: 'ALREADY_MERGED', sourceSha: SOURCE, targetBranch: 'main', targetShaAfter: REMOTE }, 'agent'],
    ] as const) {
      const id = await finishedSession(s.db, w, `receipt-${label}`);
      await strand(s.db, id, diverged());
      const recorded = door === 'user'
        ? await s.controller.recordMergeReceipt(owner(w), id, input as never)
        : await s.receipts.record(w.ownerId, id, input, 'AGENT');
      assert.equal(recorded.created, true, label);
      assert.equal(recorded.receipt.result, input.result, label);
      const after = await sessionRow(s.db, id);
      assert.equal(after.mergeRecovery, null, `${label}: the recovery is cleared`);
      assert.equal(after.mergeRecoveryAction, null, `${label}: and its action`);
      assert.equal(after.mergeStatus, 'merged', label);
      assert.equal(after.branchMerged, true, label);
      assert.equal(after.mergedSourceSha, SOURCE, label);
    }
    // Not a landing: a conflict is recorded, and the recovery stays.
    {
      const id = await finishedSession(s.db, w, 'receipt-conflict');
      const stranded = diverged();
      await strand(s.db, id, stranded);
      await s.receipts.record(w.ownerId, id, { result: 'CONFLICT', sourceSha: SOURCE, targetBranch: 'main', conflicts: ['src/app.ts'] }, 'AGENT');
      const after = await sessionRow(s.db, id);
      assert.deepEqual(after.mergeRecovery, stranded, 'a conflict keeps the recovery');
      assert.equal(after.mergeRecoveryAction, 'preview');
      assert.equal(after.mergeStatus, 'conflict');
    }
    // A landing recorded while a check is in flight: the receipt is written, and the check's answer settles the recovery.
    {
      const id = await finishedSession(s.db, w, 'receipt-in-flight');
      const stranded = diverged();
      await strand(s.db, id, stranded, { mergeStatus: 'pending', mergeOperationId: randomUUID(), mergeRequestedAt: new Date() });
      const recorded = await s.receipts.record(w.ownerId, id,
        { result: 'MERGED', sourceSha: SOURCE, targetBranch: 'main', targetShaAfter: MERGED }, 'AGENT');
      assert.equal(recorded.created, true);
      const after = await sessionRow(s.db, id);
      assert.deepEqual(after.mergeRecovery, stranded, 'a check in flight keeps the recovery');
      assert.equal(after.mergeRecoveryAction, 'preview');
      assert.equal(after.mergeStatus, 'pending');
    }
  });

  await t.test('S3 an ordinary merge that lands leaves no recovery and no recovery action behind', async () => {
    const w = await world(s.db, 'ordinary');
    // The owner's Merge on a session still holding a recovery: queued without it, and landed with nothing left.
    {
      const id = await finishedSession(s.db, w, 'ordinary-merge');
      await strand(s.db, id, diverged());
      await s.sessions.mergeToMain(w.ownerId, id, 'main');
      const [merge] = await s.drain.drainMergeRequests(w.runnerId, LEASE, true);
      assert.equal(merge?.sessionId, id);
      await s.api.mergeResult({ id: w.runnerId }, id, {
        status: 'merged', operationId: merge!.operationId, leaseOwner: LEASE, sourceSha: SOURCE, targetBranch: 'main',
        targetShaBefore: REMOTE, mergedSha: MERGED,
      });
      const after = await sessionRow(s.db, id);
      assert.equal(after.mergeStatus, 'merged');
      assert.equal(after.mergeRecovery, null);
      assert.equal(after.mergeRecoveryAction, null);
    }
    // A reviewed candidate applied, then synced: LOCAL_SYNC_PENDING is the landing still being finished and keeps
    // both for sync-local; DONE ends the recovery and its action.
    {
      const id = await finishedSession(s.db, w, 'ordinary-apply');
      const reviewed: MergeRecovery = {
        code: 'READY', targetBranch: 'main', repoRoot: '/repo', previewId: 'reviewed', sourceSha: SOURCE, localSha: LOCAL,
        remoteSha: REMOTE, candidateSha: MERGED, candidateTreeSha: 'e'.repeat(40), patch: 'the candidate diff',
        check: { status: 'unconfigured' },
      };
      await strand(s.db, id, reviewed);
      await s.sessions.mergeToMain(w.ownerId, id, 'main', undefined, { recoveryAction: 'apply', previewId: 'reviewed' });
      const [apply] = await s.drain.drainMergeRequests(w.runnerId, LEASE, true);
      await s.api.mergeResult({ id: w.runnerId }, id, {
        status: 'merged', operationId: apply!.operationId, leaseOwner: LEASE, sourceSha: SOURCE, targetBranch: 'main',
        mergedSha: MERGED, targetShaBefore: REMOTE, rebaseBaseSha: REMOTE, recovery: { ...reviewed, code: 'LOCAL_SYNC_PENDING' },
        message: 'local edits block checkout',
      });
      const pending = await sessionRow(s.db, id);
      assert.equal(pending.branchMerged, true);
      assert.equal(readMergeRecovery(pending.mergeRecovery)?.code, 'LOCAL_SYNC_PENDING', 'kept for sync-local');
      assert.equal(pending.mergeRecoveryAction, 'apply');

      await s.sessions.mergeToMain(w.ownerId, id, 'main', undefined, { recoveryAction: 'sync-local', previewId: 'reviewed' });
      const [sync] = await s.drain.drainMergeRequests(w.runnerId, LEASE, true);
      await s.api.mergeResult({ id: w.runnerId }, id, {
        status: 'merged', operationId: sync!.operationId, leaseOwner: LEASE, sourceSha: SOURCE, targetBranch: 'main',
        mergedSha: MERGED, recovery: { ...reviewed, code: 'DONE' },
      });
      const synced = await sessionRow(s.db, id);
      assert.equal(synced.mergeStatus, 'merged');
      assert.equal(synced.mergeRecovery, null);
      assert.equal(synced.mergeRecoveryAction, null, 'the finished recovery leaves no action behind');
    }
  });

  await t.test('S3 a match by content is no ALREADY_MERGED and no reader of landed receipts counts it', async () => {
    const w = await projectWorld(s, 'readers');
    const task = await doneCodeTask(s, w, 'readers');
    const branches = await readLandingBranches(s.db as unknown as PrismaService, w.projectId);
    const main = branches.upstream[0]!;
    const line = await s.db.projectCodebase.findFirstOrThrow({
      where: { projectId: w.projectId, slot: 'primary' }, select: { integrationStartedAt: true },
    });
    assert.ok(line.integrationStartedAt, 'the project\'s line has started, so its landings are what its readers wait for');
    // The owner's Merge into main found every commit already there by content; the owner pressed Done.
    await strand(s.db, task.sessionId, alreadyLanded({ targetBranch: main, previewId: 'checked' }));
    await s.controller.mergeToMain(owner(w), task.sessionId, { recoveryAction: 'confirm-landed', previewId: 'checked' });
    const [receipt, ...others] = await receiptsOf(s.db, task.sessionId);
    assert.equal(others.length, 0);
    assert.equal(receipt!.result, MATCHED_BY_CONTENT);
    assert.equal(receipt!.taskId, task.taskId);
    assert.equal(receipt!.projectId, w.projectId);
    assert.equal(receipt!.targetBranch, main);

    // As every reader is shown the row: a result of its own, and not landed.
    const shown = mergeReceiptRow(receipt as unknown as MergeReceiptRow);
    assert.equal(shown.result, MATCHED_BY_CONTENT);
    assert.equal(shown.landed, false);

    // The readers that take a landed receipt as the work being there: a criterion's and the project's landing
    // (taskLanding, and its SQL), the landing evidence a coordinator is woken on, and a dependent's wait (J9).
    const read = async () => {
      const [row] = await s.db.$queryRawUnsafe<Array<{ landing: string; landed: boolean }>>(
        `SELECT ${taskLandingSql('t')} AS "landing", ${prerequisiteLandedSql('t')} AS "landed" FROM "task" t WHERE t."id" = $1::uuid`,
        task.taskId,
      );
      const facts = await s.db.sessionMergeReceipt.findMany({ where: { taskId: task.taskId }, select: { result: true, targetBranch: true } });
      return {
        sql: row,
        fold: taskLanding(facts, branches),
        evidence: facts.some((fact) => receiptIsLandingEvidence(fact, branches)),
      };
    };
    assert.deepEqual(await read(), { sql: { landing: 'NOT_KNOWN', landed: false }, fold: 'NOT_KNOWN', evidence: false },
      'a match by content lands nothing for any of them');

    // No receipt door records the result itself: not the owner's, not an agent's.
    const claim = { result: MATCHED_BY_CONTENT, sourceSha: SOURCE, targetBranch: main, targetShaAfter: REMOTE } as never;
    await assert.rejects(() => s.receipts.record(w.ownerId, task.sessionId, claim, 'AGENT'), BadRequestException);
    await assert.rejects(() => s.controller.recordMergeReceipt(owner(w), task.sessionId, claim), BadRequestException);
    assert.equal((await receiptsOf(s.db, task.sessionId)).length, 1, 'nothing was recorded');

    // The control: the same readers do count an ALREADY_MERGED of the work on main, which the runner's doors
    // record only for a commit main contains (merge_receipt_check.go).
    await s.receipts.record(w.ownerId, task.sessionId,
      { result: 'ALREADY_MERGED', sourceSha: MERGE_COMMIT, targetBranch: main, targetShaAfter: MERGE_COMMIT }, 'AGENT');
    assert.deepEqual(await read(), { sql: { landing: 'ON_UPSTREAM', landed: true }, fold: 'ON_UPSTREAM', evidence: true });
  });
});
