/**
 * A landing that pushed nothing because the target already had the work: how the line's answer is
 * read, on real PostgreSQL (0410).
 *
 * WHAT THIS IS FOR
 * ----------------
 * On 2026-10-09, project 34PBlWiEZytRLTcPufJht's line was rebuilt from main's tip after main had
 * taken the project's work in by another route, and every task's branch was handed to the line
 * again. Each branch carried commits, and the rebase dropped every one as "patch contents already
 * upstream". The push was a no-op, and every job reported LANDED with a receipt for a landing that
 * moved nothing. The runner now answers NOTHING_TO_LAND, pushes nothing, and reports two
 * measurements. `sourceFullyApplied`: the branch carried commits, and the base had every one.
 * `sourceOnUpstream`: the tip is not on main; copies of its commits are.
 *
 * NOTHING_TO_LAND was already the empty branch's answer, and read that way it would strand this
 * work. The branch's own session reported the work, so no receipt would be written (J8), its
 * dependents would wait for ever (J9), and its criterion would read UNKNOWN. This file pins how the
 * measured answer is read instead, for the two shapes a line can have:
 *
 *  (A) the line AT main (no main sync, line tip = upstream tip), which is the incident: the work is
 *      on main. The answer writes a receipt naming the line, the task does not hold its criterion off
 *      LANDED (`jobSawWorkOnUpstream`), its dependents are released, and it is told where its work is;
 *  (B) the line AHEAD of main: the work is on the line. The receipt names the line, the criterion reads
 *      ON_INTEGRATION_LINE like any landing there, and dependents are released;
 *  (C) and what follows a landing follows it: an integration item still open about the task closes.
 *
 * And what it must not release. Each control is (A)'s rows with one fact changed:
 *  - the runner measured an EMPTY branch (`sourceFullyApplied: false`) whose session reported work.
 *    This is the 0300/0346 reading, and it is unchanged: no receipt, UNKNOWN, dependents wait;
 *  - another session of the task reported work on another branch: no receipt, and the task is told
 *    which branch;
 *  - the work ended on another branch (`git checkout -b`): no receipt, and that branch is queued;
 *  - the answer was taken before the work's last finish: it is not written down, and the job goes
 *    back to the queue.
 *
 * Every fact is produced the way the product produces it. Work goes through `TasksService.create`, DONE
 * through 0193/0230's fence, and a merge an agent made itself through `MergeReceiptService.record`. The
 * line's answers go through its queue: queued by `enqueueForDoneTask` (J-T1a), claimed off the
 * heartbeat (J-T2), and answered by the result the runner posts (J-T5). What a case chooses is the
 * ANSWER and the tips it was computed against, because what a rebase drops is resolved in
 * `src/runner-go/integrate.go` (pinned there by
 * TestIntegrationNothingToLandWhenEveryCommitIsAlreadyOnTheTarget). Each case has its own runner,
 * workspace and project, because two of them leave a landing queued and a heartbeat hands out the
 * oldest.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criterion-landing-fully-applied.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import type { IntegrationJobResultRequest } from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { prerequisiteLandedSql } from '../tasks/task-dependencies';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** The verification method every criterion here declares; never the thing under test. */
const METHOD = 'Read it and say whether it holds';

/** A full 40-hex object name, which is the only kind a receipt and a job column accept. */
const sha = (nibble: string) => nibble.repeat(40);

/** The upstream's tip, and a project-branch tip that has moved past it. */
const UPSTREAM_TIP = sha('9');
const LINE_AHEAD_OF_UPSTREAM = sha('c');

/** What the runner answers about a branch whose every commit the base already had, when the line
 *  was AT main: the incident's shape. A case changes one fact of it, or none. */
const FULLY_APPLIED_AT_MAIN = {
  state: 'NOTHING_TO_LAND',
  phase: 'REBASE',
  sourceSha: sha('5'),
  targetShaBefore: UPSTREAM_TIP,
  upstreamSha: UPSTREAM_TIP,
  sourceOnUpstream: false,
  sourceFullyApplied: true,
} as const;

/** The one criterion each case's project states. */
const CRITERION = 'the work for this one is where the project needs it';

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

/** How a work session's finalize left it. Omitted fields: a clean finish on its own branch, with work reported. */
interface Finish {
  worktreeBranch?: string;
  finishedAt?: Date;
}

test('a landing whose commits the target already had is read as the work being there — and on '
  + 'nothing but that measurement', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  const db = prisma as unknown as PrismaService;
  const projects = new ProjectsService(db, new ProjectAcceptanceService(db));
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  const receipts = new MergeReceiptService(db);
  // The heartbeat's half of the line's queue: what a runner claims and reports back on.
  const jobs = new IntegrationJobRelay(db);

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `fully-applied-${ownerId}@criterion-landing.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });

  // ── the fixture's own vocabulary ───────────────────────────────────────────────────────────────

  /**
   * One case's world. It has a runner that holds the branches, the workspace its checkout is bound
   * to (a landing is handed only to that runner), and a project on a line of its own that has
   * started integrating, stating one criterion.
   */
  async function world(label: string) {
    const runnerId = randomUUID();
    await prisma.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}: the runner that lands this work`,
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
        name: `${label}: the workspace the line is worked in`,
        enabled: true,
        repoUrl: 'ssh://git@example.invalid/the-project',
        workDir: `/srv/fully-applied-${label}`,
      },
    });
    const projectId = randomUUID();
    await prisma.project.create({ data: { id: projectId, ownerId, title: `${label}: the project` } });
    const line = `project/${projectId}`;
    await prisma.projectCodebase.create({
      data: {
        ownerId,
        projectId,
        canonicalRepoUrl: 'ssh://git@example.invalid/the-project',
        upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/${line}`,
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    const [criterion] = criteriaFromDefinitions((await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: [{ text: CRITERION, verificationMethod: METHOD }],
    } as never)).acceptanceCriteriaItems);
    return { runnerId, workspaceId, projectId, line, criterionKey: criterion.key };
  }
  type World = Awaited<ReturnType<typeof world>>;

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

  /** One finished task serving the world's criterion, filed through task_create's service. */
  async function settledTask(w: World, title: string) {
    const task = await tasks.create(ownerId, {
      title,
      projectId: w.projectId,
      criterionKey: w.criterionKey,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await settleExecutable(task.id);
    return task.id;
  }

  /**
   * A work session that ran `branch` in a worktree on the world's runner and reported the work it
   * did there (`changed_files`), as its finalize left it a minute ago unless `finish` says otherwise.
   */
  async function workSession(w: World, taskId: string, branch: string, finish: Finish = {}) {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        taskId,
        workspaceId: w.workspaceId,
        assignedRunnerId: w.runnerId,
        title: `ran ${branch}`,
        prompt: 'do the work',
        branch,
        isolationStatus: 'worktree',
        status: RunStatus.SUCCEEDED,
        finishedAt: finish.finishedAt ?? new Date(Date.now() - 60_000),
        worktreeBranch: finish.worktreeBranch ?? branch,
        worktreeDirty: false,
        changedFiles: [{ path: `src/${branch.replace(/\W+/g, '-')}.ts` }] as never,
      },
    });
    return id;
  }

  /** The two pieces of the criterion's work that reached main: the part of each case not in question. */
  async function twoPiecesOnMain(w: World, label: string) {
    for (const [nibble, n] of [['b', 1], ['d', 2]] as const) {
      const branch = `orbit/${label}-reached-main-${n}`;
      const taskId = await settledTask(w, `the part that reached main (${branch})`);
      const sessionId = await workSession(w, taskId, branch);
      await receipts.record(ownerId, sessionId, {
        result: 'MERGED', sourceSha: sha(nibble), targetBranch: 'main',
        targetShaBefore: sha('0'), targetShaAfter: sha(nibble),
      } as never, 'AGENT');
    }
  }

  /** The line's queue for one task: queued by its DONE. */
  async function queuedFor(taskId: string) {
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued, `the DONE queued no landing for ${taskId}: ${JSON.stringify(queued)}`);
    return queued.jobId;
  }

  /** The world's runner asks for work, and is handed this job. */
  async function claimed(w: World, jobId: string) {
    const handed = await jobs.dispatch({
      runnerId: w.runnerId,
      leaseOwner: `lease-${jobId}`,
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
    const job = handed.find((command) => command.jobId === jobId);
    assert.ok(job, `the heartbeat was handed no landing for job ${jobId}`);
    return job;
  }

  /** The job is claimed and answered, as the runner does it. */
  async function answered(w: World, jobId: string, answer: Answer) {
    const job = await claimed(w, jobId);
    const result = await jobs.applyResult(job.jobId, w.runnerId, {
      claimGeneration: job.claimGeneration,
      leaseOwner: job.leaseOwner,
      ...answer,
    });
    assert.ok(result.answer.accepted, `the line's answer was refused: ${JSON.stringify(result.answer)}`);
    return result;
  }

  /** The read under test: the project detail, and its criterion's landing as it states it. */
  async function landingOf(w: World): Promise<string> {
    const read = await projects.get(ownerId, w.projectId) as unknown as {
      acceptanceCriteriaItems: Array<{ text: string; landing?: string }>;
    };
    const item = read.acceptanceCriteriaItems.find((row) => row.text === CRITERION);
    assert.ok(item?.landing !== undefined, 'the outward read carries no landing for the criterion');
    return item.landing;
  }

  /** The line's answers about one task, read with SQL. */
  async function jobsOf(taskId: string) {
    const { rows } = await sql.query<{
      state: string; source_ref: string; source_fully_applied: boolean | null;
      source_on_upstream: boolean | null; at_upstream: boolean; receipts: number;
    }>(
      `SELECT "state", "source_ref", "source_fully_applied", "source_on_upstream",
              "target_sha_before" = "upstream_sha" AS "at_upstream",
              cardinality("receipt_ids") AS "receipts"
         FROM "project_integration_job" WHERE "task_id" = $1::uuid ORDER BY "created_at", "id"`,
      [taskId],
    );
    return rows;
  }

  /** The task's receipts: where its work is recorded as being. */
  function receiptsOf(taskId: string) {
    return prisma.sessionMergeReceipt.findMany({
      where: { taskId },
      select: { result: true, targetBranch: true },
    });
  }

  /** §2.5 J9 for this task as a prerequisite: is there nothing left for its dependents to wait on? */
  async function releasesItsDependents(taskId: string): Promise<boolean> {
    const { rows } = await sql.query<{ landed: boolean }>(
      `SELECT ${prerequisiteLandedSql('t')} AS "landed" FROM "task" t WHERE t."id" = $1::uuid`,
      [taskId],
    );
    assert.equal(rows.length, 1);
    return rows[0]!.landed;
  }

  /** What the task was told about its landings. */
  async function toldTo(taskId: string): Promise<string> {
    const comments = await prisma.taskComment.findMany({ where: { taskId }, select: { body: true } });
    return comments.map((comment) => comment.body).join('\n\n');
  }

  /** The empty branch's words (`nothingToLandComment`): false about a branch that carried work. */
  const EMPTY_BRANCH_WORDS = "has no commits since that session's starting point";

  // ═══ (A) the line at main ═════════════════════════════════════════════════════════════════════
  await t.test('(A) on a line AT main, the task is read as having nothing main lacks: LANDED, its '
    + 'dependents released', async () => {
    const w = await world('at-main');
    await twoPiecesOnMain(w, 'a');
    const taskId = await settledTask(w, 'the work main took in by another route');
    await workSession(w, taskId, 'orbit/already-on-main');
    const { answer, after } = await answered(w, await queuedFor(taskId), FULLY_APPLIED_AT_MAIN);

    assert.equal(answer.state, 'NOTHING_TO_LAND', 'the answer is what the runner said, not a landing');
    assert.deepEqual(await jobsOf(taskId), [{
      state: 'NOTHING_TO_LAND', source_ref: 'refs/heads/orbit/already-on-main',
      source_fully_applied: true, source_on_upstream: false, at_upstream: true, receipts: 1,
    }], 'both measurements are on the row, beside an answer given against a line that WAS main');
    assert.deepEqual(await receiptsOf(taskId), [{ result: 'ALREADY_MERGED', targetBranch: w.line }],
      'the receipt says the work is on the line and that nothing moved: no MERGED, no target after');
    assert.equal(after?.landedTaskId, taskId,
      'the answer is what the dependents were waiting for (J10), so the controller dispatches them');
    assert.equal(await releasesItsDependents(taskId), true, 'J9: nothing is left to wait for');
    assert.equal(await landingOf(w), 'LANDED',
      'every commit the branch carried was already on main, measured: the task carried nothing main '
        + 'lacks, and the two pieces with commits of their own are on main');
    const told = await toldTo(taskId);
    assert.ok(told.includes('already has every one of these changes') && told.includes(`This task's work is already on \`${w.line}\`.`),
      `the task is told its work is already on the line: ${told}`);
    assert.ok(!told.includes(EMPTY_BRANCH_WORDS), 'and not that its branch was empty');
  });

  // ═══ (B) a line ahead of main ═════════════════════════════════════════════════════════════════
  await t.test('(B) on a line AHEAD of main, the work is on the line: ON_INTEGRATION_LINE, its '
    + 'dependents released', async () => {
    const w = await world('ahead');
    await twoPiecesOnMain(w, 'b');
    const taskId = await settledTask(w, 'the work the line already carries');
    await workSession(w, taskId, 'orbit/already-on-the-line');
    const { after } = await answered(w, await queuedFor(taskId),
      { ...FULLY_APPLIED_AT_MAIN, targetShaBefore: LINE_AHEAD_OF_UPSTREAM });

    assert.deepEqual(await jobsOf(taskId), [{
      state: 'NOTHING_TO_LAND', source_ref: 'refs/heads/orbit/already-on-the-line',
      source_fully_applied: true, source_on_upstream: false, at_upstream: false, receipts: 1,
    }]);
    assert.deepEqual(await receiptsOf(taskId), [{ result: 'ALREADY_MERGED', targetBranch: w.line }],
      'the receipt says the work reached the line, which is where the line found it');
    assert.equal(after?.landedTaskId, taskId);
    assert.equal(await releasesItsDependents(taskId), true,
      'J9 asks whether the work is on the line or on main, and it is on the line');
    assert.equal(await landingOf(w), 'ON_INTEGRATION_LINE',
      'the line holds commits main does not, so finding the work in the line is not finding it on main: '
        + 'the task waits for the line to reach main, like any landing on it');
  });

  // ═══ (C) what follows a landing ═══════════════════════════════════════════════════════════════
  await t.test('(C) an integration item still open about the task closes when the work is found on '
    + 'the target', async () => {
    const w = await world('item');
    const taskId = await settledTask(w, 'the work whose first landing errored');
    await workSession(w, taskId, 'orbit/errored-first');
    await answered(w, await queuedFor(taskId), {
      state: 'ERROR', phase: 'FETCH', errorCode: 'FETCH_FAILED', errorDetail: { detail: 'the remote hung up' },
    });
    const opened = await prisma.projectOpenItem.findMany({
      where: { taskId, kind: 'INTEGRATION_ERROR' },
      select: { id: true, state: true },
    });
    assert.deepEqual(opened.map((item) => item.state), ['OPEN'], 'the first landing left an item open');

    // The task is settled again, and the next generation is answered about the same work.
    await answered(w, await queuedFor(taskId), FULLY_APPLIED_AT_MAIN);
    const item = await prisma.projectOpenItem.findUniqueOrThrow({
      where: { id: opened[0]!.id },
      select: { state: true },
    });
    assert.equal(item.state, 'RESOLVED',
      'the item was waiting for the work to reach the line, and the line found it there: a card left '
        + 'open would be one nobody can close by landing anything, and would hold off Automatic '
        + 'promotion (M-T11) for the whole project');
    assert.equal(await releasesItsDependents(taskId), true);
  });

  // ═══ the controls: (A) with one fact changed ══════════════════════════════════════════════════
  await t.test('an EMPTY branch whose session reported work is read exactly as before: no receipt, '
    + 'UNKNOWN, dependents wait', async () => {
    const w = await world('empty');
    await twoPiecesOnMain(w, 'empty');
    const taskId = await settledTask(w, 'the work whose branch the line found empty');
    await workSession(w, taskId, 'orbit/measured-empty');
    const { after } = await answered(w, await queuedFor(taskId),
      { ...FULLY_APPLIED_AT_MAIN, sourceFullyApplied: false });

    assert.deepEqual((await jobsOf(taskId)).map((job) => [job.source_fully_applied, job.receipts]), [[false, 0]],
      'the runner measured a branch with no commit of its own while its session had reported work: '
        + 'that work is somewhere the line did not look (0300/0346), and the receipt is withheld as it '
        + 'always was');
    assert.deepEqual(await receiptsOf(taskId), []);
    assert.equal(after?.landedTaskId, null);
    assert.equal(await releasesItsDependents(taskId), false);
    assert.equal(await landingOf(w), 'UNKNOWN',
      'the measurement is the one thing that lets the answer speak for the work; without it nothing '
        + 'says where the task\'s commits are');
    assert.ok((await toldTo(taskId)).includes(EMPTY_BRANCH_WORDS), 'and it is told so, in the empty branch\'s words');
  });

  await t.test('another branch holding work of the task\'s keeps the receipt back, and the task is '
    + 'told which', async () => {
    const w = await world('elsewhere');
    await twoPiecesOnMain(w, 'elsewhere');
    const taskId = await settledTask(w, 'the work with a second branch');
    await workSession(w, taskId, 'orbit/an-older-attempt', { finishedAt: new Date(Date.now() - 120_000) });
    await workSession(w, taskId, 'orbit/the-newest-attempt');
    const { after } = await answered(w, await queuedFor(taskId), FULLY_APPLIED_AT_MAIN);

    assert.deepEqual((await jobsOf(taskId)).map((job) => [job.source_ref, job.receipts]),
      [['refs/heads/orbit/the-newest-attempt', 0]],
      'the line measured the newest attempt\'s commits on main, and says nothing about the older '
        + 'attempt\'s branch, which also reported work');
    assert.equal(after?.landedTaskId, null);
    assert.equal(await releasesItsDependents(taskId), false);
    assert.equal(await landingOf(w), 'UNKNOWN');
    const told = await toldTo(taskId);
    assert.ok(told.includes('orbit/an-older-attempt') && !told.includes(EMPTY_BRANCH_WORDS),
      `the task is told which branch holds the rest of its work: ${told}`);
  });

  await t.test('work that ended on another branch keeps the receipt back, and that branch is queued',
    async () => {
      const w = await world('ended-elsewhere');
      await twoPiecesOnMain(w, 'ended');
      const taskId = await settledTask(w, 'the work committed on a branch of its own making');
      await workSession(w, taskId, 'orbit/started-here', { worktreeBranch: 'feat/where-the-work-went' });
      const { after } = await answered(w, await queuedFor(taskId), FULLY_APPLIED_AT_MAIN);

      assert.deepEqual((await jobsOf(taskId)).map((job) => [job.state, job.source_ref, job.receipts]), [
        ['NOTHING_TO_LAND', 'refs/heads/orbit/started-here', 0],
        ['QUEUED', 'refs/heads/feat/where-the-work-went', 0],
      ], 'the answer is about the branch the session started on; HEAD ended on another one, which is '
        + 'owed a landing of its own (§2.6), exactly as an ALREADY_LANDED about it would be');
      assert.equal(after?.landedTaskId, null);
      assert.equal(await releasesItsDependents(taskId), false);
      assert.equal(await landingOf(w), 'UNKNOWN');
      assert.ok((await toldTo(taskId)).includes('feat/where-the-work-went'),
        'the task is told where its work ended');
    });

  await t.test('an answer taken before the work\'s last finish is not written down', async () => {
    const w = await world('too-soon');
    const taskId = await settledTask(w, 'the work that went on after the line looked');
    const sessionId = await workSession(w, taskId, 'orbit/went-on');
    const jobId = await queuedFor(taskId);
    const job = await claimed(w, jobId);
    const claim = await prisma.projectIntegrationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { claimedAt: true },
    });
    // Revived after the claim and finished again: the branch may have grown since the line looked.
    await prisma.session.update({
      where: { id: sessionId },
      data: { finishedAt: new Date(claim.claimedAt!.getTime() + 15_000) },
    });
    const { answer, after } = await jobs.applyResult(job.jobId, w.runnerId, {
      claimGeneration: job.claimGeneration,
      leaseOwner: job.leaseOwner,
      ...FULLY_APPLIED_AT_MAIN,
    });

    assert.deepEqual([answer.accepted, answer.state, after], [true, 'QUEUED', null],
      'the same question asked too early, as an ALREADY_LANDED would be: back to the queue, and nothing follows');
    assert.deepEqual((await jobsOf(taskId)).map((row) => [row.state, row.source_fully_applied, row.receipts]),
      [['QUEUED', null, 0]]);
    assert.deepEqual(await receiptsOf(taskId), []);
    assert.equal(await toldTo(taskId), '', 'and nothing was said about it');
  });
});
