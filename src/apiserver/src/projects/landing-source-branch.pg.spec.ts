/**
 * Which branch a landing is handed, and what the line's answer means when that branch carries
 * nothing of the task's own.
 *
 * THE INCIDENT THIS PINS (2026-09-23, project `34Tq39ByZ0rV4c6pJkfw7`, task `34TqaiSUMbQfgTGgyTuNK`)
 * -------------------------------------------------------------------------------------------------
 * A task ran three sessions: the first died on a 429 with zero turns, the second did the work over
 * 57 turns and committed it, the third was a retry that died on a 429 after one turn and committed
 * nothing. The landing queued by the task's DONE was handed the THIRD session's branch — the rule
 * was "the newest work session" — whose tip was the upstream commit it had forked at. The line
 * answered `ALREADY_LANDED` (an empty branch is an ancestor of everything), wrote a receipt for a
 * landing that moved nothing, and the promotion card counted the task as work the merge did not
 * contain; the branch holding the delivery was never offered to the line at all. The coordinator
 * found it, cherry-picked by hand and recorded the receipt afterwards.
 *
 * THE TWO HALVES, AND WHY THEY ARE TWO CASES
 * -----------------------------------------
 *  (1) WHICH BRANCH. Three sessions like the incident's — newest a retry with nothing, oldest
 *      nothing, the middle one the delivery — and the landing is handed the delivery's branch. The
 *      control that keeps this from being "a rule about the newest session of any kind": a task
 *      whose only session reported nothing still gets its landing queued, for that branch, because
 *      the line's answer about it is what §1.4's landing lane reads.
 *  (2) WHAT THE ANSWER MEANS. The line reports that the branch it was handed carries nothing of the
 *      task's own. When the task's work is on another branch that is NOT a landing: no receipt,
 *      because a receipt says this task's work is on that target and it is not, and the task is
 *      TOLD — in a comment naming the branch that holds the work. When the task has no work of its
 *      own anywhere it IS a receipt, which is the fact §2.5 J9 releases its dependents on.
 *
 *      The case is run twice, because one fact reaches the control plane two ways: `ALREADY_LANDED`
 *      from a runner that predates 0300 — which is what the incident's runner sent — and 0300's own
 *      `NOTHING_TO_LAND`. The row is written as `NOTHING_TO_LAND` either way: the control plane knows
 *      both halves from its own rows, a source tip equal to the session's base being a branch that
 *      never moved off the commit it started at.
 *
 *      The positive control is here too: a branch that HAS commits, already contained in the
 *      target, is still `ALREADY_LANDED` with its receipt. Nothing about this may reach it.
 *
 * Every fact is produced the way the product produces it: work through `TasksService.create`, DONE
 * through 0193/0230's fence, the line's queue through `enqueueForDoneTask` (J-T1a), the claim off the
 * heartbeat (J-T2) and the answer that runner posts (J-T5), which writes the job row, the receipt and
 * the signal in one transaction. What a case chooses is which branch carries the work, whether a
 * session reported any, and the ANSWER — whether one commit contains another is a fact only a
 * repository has, and `src/runner-go/integrate.go` is where it is resolved.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/landing-source-branch.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import type { IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_JOB_STATES,
  enqueueForDoneTask,
} from './project-integration-job';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, the only kind a receipt and a job column accept. */
const sha = (nibble: string) => nibble.repeat(40);

/** What the runner's finalize leaves on a session: the work it reported, and the commit it forked at. */
interface Finish {
  changedFiles?: unknown[];
  baseSha?: string;
  status?: RunStatus;
}

/** The diff summary a session that delivered something reports. */
const WORK_REPORTED = [
  { path: 'src/web/src/components/ApprovalPanel.tsx', status: 'M', additions: 36, deletions: 5 },
];

/**
 * One deployment's worth of rows for these cases, built the way the product builds them: an owner, a
 * runner with a workspace its sessions run in, and — per project — a line of its own.
 */
async function harness(t: { after(fn: () => Promise<void> | void): void }) {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  const jobs = new IntegrationJobRelay(prisma as unknown as PrismaService);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `landing-source-${ownerId}@landing-source-branch.invalid`,
      name: 'Landing source branch',
      passwordHash: 'x',
    },
  });

  // The runner holding the branches, and the workspace its checkout is bound to: a landing is only
  // handed to the runner whose workspace the session ran in (`claimOne`).
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'the runner that lands this project',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: 'the workspace the line is worked in',
      enabled: true,
      repoUrl: 'ssh://git@example.invalid/landing-source-branch',
      workDir: '/srv/landing-source-branch',
    },
  });

  /**
   * One project with a line of its own, started before any of this work finished: the ordinary
   * state after a first landing, in which a DONE queues exactly its own landing and back-fills
   * nobody (L3 step 4).
   *
   * A project per case, because J1 serialises on the repository AND the target ref: two cases
   * sharing a target would have the second one's landing held behind the first one's claim, which
   * is the queue working rather than anything these cases are about.
   */
  async function newProject(): Promise<string> {
    const id = randomUUID();
    await prisma.project.create({
      data: { id, ownerId, title: 'The project whose landing picked an empty branch' },
    });
    await prisma.projectCodebase.create({
      data: {
        ownerId,
        projectId: id,
        canonicalRepoUrl: 'ssh://git@example.invalid/landing-source-branch',
        upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/project/${id}`,
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    return id;
  }

  /** Settle an EXECUTABLE task the way `runnerApi.turnComplete` does, through 0193/0230's fence. */
  async function settleExecutable(taskId: string) {
    const written = await sql.query(
      `UPDATE "task" SET "status" = 'DONE'
        WHERE "id" = $1::uuid
          AND "status" IN ('OPEN', 'IN_PROGRESS')
          AND "completion_criterion" = 'EXECUTABLE'
          AND "acceptance_command" = 'true'
          AND "acceptance_expected_exit_code" = 0`,
      [taskId],
    );
    assert.equal(written.rowCount, 1, 'the EXECUTABLE task must reach DONE through the DONE fence');
  }

  /** One finished task, and its branch-to-be: a session is added per case, in the order it ended. */
  async function settledTask(projectId: string, title: string) {
    const task = await tasks.create(ownerId, {
      title,
      projectId,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await settleExecutable(task.id);
    return task.id;
  }

  /**
   * One work session, as the runner's finalize left it: `minutesAgo` orders them (a task's sessions
   * are read newest first), `finish` is what the finalize reported — the diff summary the selection
   * reads, and the commit the branch forked at.
   */
  async function workSession(taskId: string, branch: string, minutesAgo: number, finish: Finish) {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: `ran ${branch}`,
        prompt: 'do the work',
        branch,
        isolationStatus: 'worktree',
        status: finish.status ?? RunStatus.SUCCEEDED,
        baseSha: finish.baseSha ?? sha('1'),
        changedFiles: (finish.changedFiles ?? []) as never,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
        finishedAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
    return id;
  }

  /**
   * The line is handed this task's branch — queued by the DONE (J-T1a) and claimed off the
   * heartbeat (J-T2) — and the claim is returned, so a case can decide what is true when the runner
   * answers it.
   */
  async function handOver(taskId: string) {
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued, `the DONE queued no landing for ${taskId}: ${JSON.stringify(queued)}`);
    const claimed = await jobs.dispatch({
      runnerId,
      leaseOwner: `lease-${taskId}`,
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
    const command = claimed.find((candidate) => candidate.jobId === queued.jobId);
    assert.ok(command, `the heartbeat was handed no landing for ${taskId}, which its DONE queued`);
    return command;
  }

  /** The answer that runner posts (J-T5), and the job row as it was written from it. */
  async function answer(
    command: IntegrationJobCommand,
    body: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
  ) {
    const applied = await jobs.applyResult(command.jobId, runnerId, {
      claimGeneration: command.claimGeneration,
      leaseOwner: command.leaseOwner,
      ...body,
    });
    assert.ok(applied.answer.accepted, `the line's answer was refused: ${JSON.stringify(applied.answer)}`);
    return prisma.projectIntegrationJob.findUniqueOrThrow({
      where: { id: command.jobId },
      select: { state: true, sourceRef: true, receiptIds: true, landedSha: true },
    });
  }

  /** What the task's own record holds after the line answered. */
  async function aftermath(taskId: string) {
    return {
      receipts: await prisma.sessionMergeReceipt.findMany({
        where: { taskId },
        select: { result: true, targetBranch: true, sourceBranch: true },
      }),
      comments: await prisma.taskComment.findMany({
        where: { taskId },
        select: { body: true },
      }),
    };
  }

  /** The line's answer about a branch nothing of the task's own was ever committed to. */
  const nothingCommitted = {
    phase: 'REBASE' as const,
    targetShaBefore: sha('9'),
    upstreamSha: sha('9'),
  };

  return {
    prisma, tasks, jobs, ownerId, runnerId, workspaceId,
    newProject, settledTask, workSession, handOver, answer, aftermath, nothingCommitted,
  };
}

test('a landing is handed the branch that carries the work', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const h = await harness(t);

  // ── (1) the incident's three sessions, in the order they ended: the oldest and the newest
  // reported nothing, and the delivery is the one in the middle.
  const retried = await h.settledTask(
    await h.newProject(), '(1) the delivery is on the middle branch, not the retry',
  );
  await h.workSession(retried, 'orbit/retried-first-attempt', 3, { changedFiles: [], status: RunStatus.FAILED });
  await h.workSession(retried, 'orbit/retried-delivery', 2, { changedFiles: WORK_REPORTED });
  await h.workSession(retried, 'orbit/retried-second-attempt', 1, { changedFiles: [], status: RunStatus.FAILED });
  const handed = await h.handOver(retried);
  assert.equal(
    handed.sourceRef, 'refs/heads/orbit/retried-delivery',
    'the landing was handed a branch that reported no work instead of the one the delivery is on',
  );

  // ── (2) the fallback is still the fallback: a task whose only session reported nothing has its
  // landing queued all the same, for that branch. The line's answer about it is what J9 and the
  // landing lane read, so a DONE that queued nothing would strand what waits on this task.
  const nothingAnywhere = await h.settledTask(
    await h.newProject(), '(2) no session of this task reported work',
  );
  await h.workSession(nothingAnywhere, 'orbit/nothing-anywhere', 1, { changedFiles: [], status: RunStatus.FAILED });
  const onlyBranch = await h.handOver(nothingAnywhere);
  assert.equal(onlyBranch.sourceRef, 'refs/heads/orbit/nothing-anywhere', 'the only branch this task has');
  await h.answer(onlyBranch, {
    state: 'NOTHING_TO_LAND', sourceSha: sha('1'), ...h.nothingCommitted,
  });
  const quiet = await h.aftermath(nothingAnywhere);
  assert.equal(quiet.receipts.length, 1, 'a task with nothing of its own to land still releases what waits on it');
  assert.equal(quiet.receipts[0].result, 'ALREADY_MERGED', 'nothing moved, so the receipt says so');
  assert.ok(quiet.comments.length > 0, 'the line\'s answer left no visible signal on the task');
});

test('a branch with nothing of the task\'s own on it is not written down as a landing', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const h = await harness(t);

  /**
   * The shape both spellings of the fact are run through: the line was handed a retry's empty
   * branch, and the delivery is on another branch whose session reported only after the landing was
   * queued — the race J-T1a queues landings in (the DONE queues it, the runner commits when it
   * finishes the session).
   */
  async function handedAnEmptyBranch(label: string) {
    const taskId = await h.settledTask(await h.newProject(), label);
    await h.workSession(taskId, `${label}/delivery`, 2, { changedFiles: [], baseSha: sha('2') });
    await h.workSession(taskId, `${label}/retry`, 1, { changedFiles: [], baseSha: sha('3'), status: RunStatus.FAILED });
    const command = await h.handOver(taskId);
    assert.equal(command.sourceRef, `refs/heads/${label}/retry`, 'the newest session, which reported nothing');
    await h.prisma.session.updateMany({
      where: { taskId, branch: `${label}/delivery` },
      data: { changedFiles: WORK_REPORTED as never },
    });
    return { taskId, command };
  }

  // ── (3) the spelling a runner older than 0300 sends, which is the one the incident's runner sent:
  // `ALREADY_LANDED` about a branch whose tip was the commit it forked at.
  const stale = await handedAnEmptyBranch('orbit/old-spelling');
  const old = await h.answer(stale.command, {
    state: 'ALREADY_LANDED', sourceSha: sha('3'), ...h.nothingCommitted,
  });
  assert.equal(old.state, 'NOTHING_TO_LAND',
    'an empty branch reported the old way was still written down as a landing');
  assert.equal(old.receiptIds.length, 0, 'a receipt was written for a landing that moved nothing');

  // ── (4) the answer 0300 added for the same fact, about a branch that never moved off the commit
  // its session started at, while the task's work is on another branch.
  const fresh = await handedAnEmptyBranch('orbit/elsewhere');
  const empty = await h.answer(fresh.command, {
    state: 'NOTHING_TO_LAND', sourceSha: sha('3'), ...h.nothingCommitted,
  });
  assert.notEqual(empty.state, 'ALREADY_LANDED', 'a branch with nothing of its own was called a landing');
  assert.equal(empty.state, 'NOTHING_TO_LAND');

  // The signal, and what it says: the task's work is named, because that is the delivery the line
  // was never shown, and the withheld receipt is the other half of the same statement.
  for (const [taskId, branch] of [
    [fresh.taskId, 'orbit/elsewhere/delivery'],
    [stale.taskId, 'orbit/old-spelling/delivery'],
  ] as const) {
    const told = await h.aftermath(taskId);
    assert.equal(told.receipts.length, 0, `${branch}: a receipt claims work on a target it is not on`);
    assert.ok(told.comments.length > 0, `${branch}: the line's answer left no visible signal on the task`);
    assert.match(told.comments.map((comment) => comment.body).join('\n'), new RegExp(branch),
      `${branch}: the signal does not name the branch that holds the work`);
  }

  // ── (5) the positive control: a branch with commits, already contained in the target. It is a
  // landing answer, and it writes its receipt.
  const alreadyThere = await h.settledTask(
    await h.newProject(), 'a branch that has commits the target already contains',
  );
  await h.workSession(alreadyThere, 'orbit/already-there', 1, { changedFiles: WORK_REPORTED, baseSha: sha('6') });
  const there = await h.handOver(alreadyThere);
  const landed = await h.answer(there, {
    state: 'ALREADY_LANDED', sourceSha: sha('7'), ...h.nothingCommitted,
  });
  assert.equal(landed.state, 'ALREADY_LANDED', 'work already on the target is still a landing answer');
  assert.equal(landed.receiptIds.length, 1, 'the receipt for a real landing was withheld');

  // ── the closed set, and the migration that holds it ─────────────────────────────────────────────
  // The state these cases are about is in the CHECK the newest migration wrote, and in the list the
  // API server validates a result against. The two are one set: a state the database refuses is a
  // result the runner reports and this process cannot record.
  const migration = readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/0300_integration_job_nothing_to_land/migration.sql'),
    'utf8',
  );
  const check = /"state" IN \(([\s\S]*?)\)\)/.exec(migration);
  assert.ok(check, 'migration 0300 no longer constrains the state column');
  assert.deepEqual(
    [...check![1].matchAll(/'([A-Z_]+)'/g)].map((hit) => hit[1]).sort(),
    [...INTEGRATION_JOB_STATES].sort(),
    'a job state was added in one place only — the CHECK and the closed set have to move together',
  );
});
