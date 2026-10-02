/**
 * Work that has nothing to land stops holding its criterion off LANDED — on a declaration the task
 * doors can now make, or on the runner's own measurement — and nothing else lets it out (project-close
 * redo, D1).
 *
 * WHAT THIS IS FOR
 * ----------------
 * On 2026-10-01 project 34WzvgkHWbY1VwXmSPUZi met all ten of its criteria and could not be derived
 * done: criterion 10's rollout task committed nothing, so no receipt could ever put its work on main.
 * Two facts were missing, and this file pins both:
 *
 *  - `codeless` (SR5's escape hatch, 0231) was a column no door wrote. task_create, each
 *    task_create_batch item and task_update now take it — at creation for free, on an existing task
 *    only with a reason (`task.codeless_reason`, 0346) and never for a task with commits of its own.
 *  - The line's NOTHING_TO_LAND was let out of the roll-up only where the project branch WAS main
 *    (`target_sha_before = upstream_sha`), which a project branch stops being after its first landing.
 *    The runner now measures whether the empty tip is an ancestor of main and reports it
 *    (`source_on_upstream`, 0346); that measurement is the only fact the answer is let out on.
 *
 * THE CASES
 * ---------
 *  (1) a task created codeless — through task_create and through a batch item — does not hold LANDED;
 *  (2) a task that ran a branch and committed nothing, declared codeless afterwards: refused without
 *      a reason, then let out with one; the reason is stored, and taking the declaration back puts the
 *      task back in the roll-up and clears it;
 *  (3) a task with commits of its own — a merge that moved a target, or a session that reported work —
 *      cannot be declared codeless, and the refusal writes nothing;
 *  (4) NOTHING_TO_LAND with the tip measured ON main, on a line AHEAD of main: LANDED;
 *  (5) NOTHING_TO_LAND with the tip measured OFF main: still withheld;
 *  (6) NOTHING_TO_LAND with no measurement (an older runner), even on a line AT main: still withheld —
 *      the old inference is no longer read for this answer;
 *  (7) the two the measurement must not release: a task whose empty retry was handed to the line while
 *      its work sat on another branch, and a task whose session died and never finished;
 *  (8) `project_request_start`'s ready check warns about a criterion served only by work that looks
 *      codeless and does not say so, and stops once it says so;
 *  (9) end to end: the owner has confirmed, the one thing withholding DONE is a zero-commit task's
 *      landing, and declaring it codeless lets the projection record the project done — by Orbit.
 *
 * Every fact is produced the way the product produces it: tasks through `TasksService` (the service
 * both the user API and the runner API call), DONE through 0193/0230's fence, a merge an agent made
 * itself through `MergeReceiptService.record`, the line's answers through its queue — queued by
 * `enqueueForDoneTask`, claimed off the heartbeat and answered by the result the runner posts — and
 * the start request through the runner's own door. What a case chooses is the ANSWER: whether one
 * commit contains another is a repository's fact, measured in `src/runner-go/integrate.go`.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criterion-landing-codeless.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  type PrismaClient,
} from '@prisma/client';
import type {
  IntegrationJobResultRequest,
  ProjectStartFinding,
  ProjectStartRequestBody,
  ProjectStartRequestFiled,
} from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import type { CompletionInputRouter } from './completion-input-router.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { readDerivedProjectDone } from './project-done-derived';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';
import { ProjectOpenItemService } from './project-open-item.service';
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

/** The line's answer about a branch that never moved off the commit its session started at, given
 *  against a project branch AHEAD of main — the 2026-10-01 shape, which the old inference could
 *  never read. A case adds what the runner measured, or leaves it out. */
const NOTHING_TO_LAND_ON_A_LINE_AHEAD = {
  state: 'NOTHING_TO_LAND',
  phase: 'REBASE',
  sourceSha: sha('5'),
  targetShaBefore: LINE_AHEAD_OF_UPSTREAM,
  upstreamSha: UPSTREAM_TIP,
} as const;

/** What a reason looks like when a coordinator gives one. */
const REASON = 'it deploys and walks the release through; it commits nothing';

/** One criterion as the outward read states it, narrowed to what this spec reads. */
interface StatedCriterion {
  text: string;
  landing?: string;
}

/** How a work session's finalize left it. Omitted fields are a clean finish on its own branch. */
interface Finish {
  worktreeBranch?: string;
  changedFiles?: unknown[];
}

interface Refusal {
  status: number;
  body: {
    code?: string;
    reasonField?: string;
    evidence?: Array<{ kind: string; branch: string }>;
    findings?: ProjectStartFinding[];
  };
}

test('work with nothing to land stops holding its criterion — on a declaration or a measurement, '
  + 'and on nothing else', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
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

  // The production wiring over one client. Only the publishes and the queue nudge are inert.
  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions);
  /**
   * The router both post-commit edges sit behind, answering with nothing: what a write WAKES is
   * another unit's question. It is here for the guard the deliveries share, which is also what
   * re-projects `project.status` after a task write or a receipt — case (9) depends on that edge
   * exactly as production does.
   */
  const completionInputs = {
    routeSettledUnmerged: async () => [],
    routeSettledProjects: async () => [],
    routeReadyCriteria: async () => [],
    routeUnlandedCriteria: async () => [],
    routeReadyDependents: async () => [],
    routeTaskExceptions: async () => [],
  } as unknown as CompletionInputRouter;
  const tasks = new TasksService(
    prisma as never,
    {} as never,
    { publishTaskChanged() {}, publishForUser() {}, publishTaskResync() {} } as never,
    undefined,
    completionInputs,
  );
  const receipts = new MergeReceiptService(db, completionInputs);
  // The heartbeat's half of the line's queue: what a runner claims and reports back on.
  const jobs = new IntegrationJobRelay(db);
  // The runner's door `project_request_start` reaches. It spends no orchestration credential.
  const door = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => assert.fail('a start request spends no orchestration credential') } as never,
    openItems,
  );

  const ownerId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `codeless-${ownerId}@criterion-landing.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  // The runner that holds the branches, and the workspace its checkout is bound to: a landing is
  // only handed to the runner whose workspace the session ran in, and a task is only startable when
  // its assignee is a workspace on a runner.
  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'the runner that lands this work',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  const runner = { id: runnerId, ownerId } as never;
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: 'the workspace the line is worked in',
      enabled: true,
      repoUrl: 'ssh://git@example.invalid/the-project',
      workDir: '/srv/criterion-landing-codeless',
    },
  });

  // ── the fixture's own vocabulary ───────────────────────────────────────────────────────────────

  /** A project on a line of its own that has already started integrating — the ordinary state
   *  after a first landing, in which a DONE queues exactly its own landing. */
  async function projectOnALine(title: string): Promise<string> {
    const id = randomUUID();
    await prisma.project.create({ data: { id, ownerId, title } });
    await prisma.projectCodebase.create({
      data: {
        ownerId,
        projectId: id,
        canonicalRepoUrl: 'ssh://git@example.invalid/the-project',
        upstreamRef: 'refs/heads/main',
        integrationRef: `refs/heads/project/${id}`,
        refAuthority: 'REMOTE',
        integrationRefSource: 'EXPLICIT',
        integrationStartedAt: new Date(Date.now() - 60_000),
      },
    });
    return id;
  }

  async function stateCriteria(projectId: string, texts: string[]) {
    return criteriaFromDefinitions((await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: texts.map((text) => ({ text, verificationMethod: METHOD })),
    } as never)).acceptanceCriteriaItems);
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

  /** One finished task serving a criterion, filed through task_create's service. */
  async function settledTask(projectId: string, title: string, criterionKey: string | null,
    declaration: { codeless?: boolean } = {}) {
    const task = await tasks.create(ownerId, {
      title,
      projectId,
      ...(criterionKey ? { criterionKey } : {}),
      ...declaration,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await settleExecutable(task.id);
    return task.id;
  }

  /**
   * A work session that ran `branch` in a worktree on the runner above, as its finalize left it a
   * minute ago — or `'DIED'`: it failed and its finalize never ran, so it never finished.
   */
  async function workSession(taskId: string, branch: string, finish: Finish | 'DIED' = {}) {
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
        ...(finish === 'DIED'
          ? { status: RunStatus.FAILED }
          : {
            status: RunStatus.SUCCEEDED,
            finishedAt: new Date(Date.now() - 60_000),
            worktreeBranch: finish.worktreeBranch ?? branch,
            worktreeDirty: false,
            changedFiles: (finish.changedFiles ?? []) as never,
          }),
      },
    });
    return id;
  }

  /** The line's queue for one task: queued by its DONE, and what the next heartbeat is handed. */
  async function queuedFor(taskId: string) {
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued, `the DONE queued no landing for ${taskId}: ${JSON.stringify(queued)}`);
    return queued.jobId;
  }

  async function heartbeat(label: string) {
    return jobs.dispatch({
      runnerId,
      leaseOwner: `lease-${label}`,
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
  }

  /** The line is handed a queued landing and answers — claimed and answered as the runner does. */
  async function answered(jobId: string, answer: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>) {
    const job = (await heartbeat(jobId)).find((command) => command.jobId === jobId);
    assert.ok(job, `the heartbeat was handed no landing for job ${jobId}`);
    const { answer: taken } = await jobs.applyResult(job.jobId, runnerId, {
      claimGeneration: job.claimGeneration,
      leaseOwner: job.leaseOwner,
      ...answer,
    });
    assert.ok(taken.accepted, `the line's answer was refused: ${JSON.stringify(taken)}`);
  }

  /** One receipt, through the door an agent records a merge it made itself with. */
  function mergeRecorded(
    sessionId: string,
    body: { result: string; sourceSha: string; targetBranch: string; targetShaBefore?: string; targetShaAfter?: string },
  ) {
    return receipts.record(ownerId, sessionId, body as never, 'AGENT');
  }

  /** The two pieces of a criterion's work that reached main: the part of each case not in question. */
  async function twoPiecesOnMain(projectId: string, criterionKey: string, label: string) {
    for (const [nibble, n] of [['b', 1], ['d', 2]] as const) {
      const branch = `orbit/${label}-reached-main-${n}`;
      const taskId = await settledTask(projectId, `the part that reached main (${branch})`, criterionKey);
      const sessionId = await workSession(taskId, branch, { changedFiles: [{ path: `${branch}.ts` }] });
      await mergeRecorded(sessionId, {
        result: 'MERGED', sourceSha: sha(nibble), targetBranch: 'main',
        targetShaBefore: sha('0'), targetShaAfter: sha(nibble),
      });
    }
  }

  /** The read under test: the project detail, and one criterion's landing as it states it. */
  async function landingOf(projectId: string, text: string): Promise<string> {
    const read = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: StatedCriterion[];
    };
    const item = read.acceptanceCriteriaItems.find((row) => row.text === text);
    assert.ok(item, `the project must still state “${text}”`);
    assert.ok(item.landing !== undefined, `the outward read carries no landing for “${text}”`);
    return item.landing;
  }

  /** The declaration as the row holds it, read with SQL. */
  async function declarationOf(taskId: string) {
    const { rows } = await sql.query<{ codeless: boolean; codeless_reason: string | null }>(
      `SELECT "codeless", "codeless_reason" FROM "task" WHERE "id" = $1::uuid`, [taskId],
    );
    assert.equal(rows.length, 1);
    return { codeless: rows[0]!.codeless, reason: rows[0]!.codeless_reason };
  }

  /** The line's answers about one task, read with SQL. */
  async function jobsOf(taskId: string) {
    const { rows } = await sql.query<{
      state: string; source_on_upstream: boolean | null; at_upstream: boolean; receipts: number;
    }>(
      `SELECT "state", "source_on_upstream", "target_sha_before" = "upstream_sha" AS "at_upstream",
              cardinality("receipt_ids") AS "receipts"
         FROM "project_integration_job" WHERE "task_id" = $1::uuid ORDER BY "created_at", "id"`,
      [taskId],
    );
    return rows;
  }

  async function refused(action: () => Promise<unknown>): Promise<Refusal> {
    try {
      await action();
    } catch (error) {
      assert.ok(error instanceof HttpException, `expected an HttpException, got ${String(error)}`);
      return { status: error.getStatus(), body: error.getResponse() as Refusal['body'] };
    }
    return assert.fail('the call was expected to be refused and was not');
  }

  // ════ the landing project: every criterion two pieces on main and one piece in question ════════

  const projectId = await projectOnALine('The project whose last task commits nothing');
  const CREATED_CODELESS = '(1) one piece was created codeless, at task_create and in a batch';
  const DECLARED_LATER = '(2) one piece ran a branch, committed nothing, and is declared codeless later';
  const MEASURED_ON_MAIN = '(4) one piece was answered NOTHING_TO_LAND, its tip measured on main';
  const MEASURED_OFF_MAIN = '(5) one piece was answered NOTHING_TO_LAND, its tip measured off main';
  const NOT_MEASURED = '(6) one piece was answered NOTHING_TO_LAND by a runner that measured nothing';
  const WORK_ELSEWHERE = '(7a) one piece’s empty retry went to the line while its work sat elsewhere';
  const SESSION_DIED = '(7b) one piece’s session died and never finished';
  const [
    createdCodelessAt, declaredLaterAt, measuredOnMainAt, measuredOffMainAt, notMeasuredAt,
    workElsewhereAt, sessionDiedAt,
  ] = await stateCriteria(projectId, [
    CREATED_CODELESS, DECLARED_LATER, MEASURED_ON_MAIN, MEASURED_OFF_MAIN, NOT_MEASURED,
    WORK_ELSEWHERE, SESSION_DIED,
  ]);

  // ═══ (1) created codeless ═════════════════════════════════════════════════════════════════════
  await t.test('(1) a task created codeless — single or batch — does not hold its criterion off LANDED',
    async () => {
      await twoPiecesOnMain(projectId, createdCodelessAt.key, 'created');
      const single = await settledTask(projectId, 'roll it out', createdCodelessAt.key, { codeless: true });
      const [batched] = await tasks.createMany(ownerId, {
        tasks: [{
          title: 'walk the release through', projectId, criterionKey: createdCodelessAt.key, codeless: true,
          completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
        }],
      } as never) as Array<{ id: string }>;
      await settleExecutable(batched.id);

      for (const taskId of [single, batched.id]) {
        assert.deepEqual(await declarationOf(taskId), { codeless: true, reason: null },
          'declared where the task was created, which needs no reason');
      }
      assert.equal(await landingOf(projectId, CREATED_CODELESS), 'LANDED',
        'the two pieces with commits are on main, and the two that declare they produce no code take '
          + 'no part in the conjunction: neither will ever have a commit to land');
    });

  // ═══ (2) declared codeless later ══════════════════════════════════════════════════════════════
  await twoPiecesOnMain(projectId, declaredLaterAt.key, 'declared');
  const rollout = await settledTask(projectId, 'roll it out (filed without the declaration)', declaredLaterAt.key);
  // It ran a branch, as every task in a code project does, and its finalize reported nothing on it.
  await workSession(rollout, 'orbit/rollout-ran-a-branch');

  await t.test('(2a) declaring an existing task codeless is refused without a reason, and writes nothing',
    async () => {
      assert.equal(await landingOf(projectId, DECLARED_LATER), 'UNKNOWN',
        'before the declaration nothing says where this task’s work is: the criterion cannot land');
      for (const codelessReason of [undefined, '', '   ']) {
        const refusal = await refused(() => tasks.update(ownerId, rollout, {
          codeless: true, ...(codelessReason === undefined ? {} : { codelessReason }),
        } as never));
        assert.equal(refusal.status, 400);
        assert.equal(refusal.body.code, 'TASK_CODELESS_REASON_REQUIRED');
        assert.equal(refusal.body.reasonField, 'codelessReason');
      }
      assert.deepEqual(await declarationOf(rollout), { codeless: false, reason: null },
        'a refused declaration leaves the row exactly as it was');
    });

  await t.test('(2b) with a reason it is declared, stored, and the criterion is LANDED', async () => {
    await tasks.update(ownerId, rollout, { codeless: true, codelessReason: `  ${REASON}  ` } as never);
    assert.deepEqual(await declarationOf(rollout), { codeless: true, reason: REASON },
      'the reason is stored beside the declaration, trimmed');
    assert.equal(await landingOf(projectId, DECLARED_LATER), 'LANDED',
      'the rollout is out of the conjunction, and the two pieces that had commits are on main');

    // Re-sending what the task already has changes nothing, and is not asked why.
    await tasks.update(ownerId, rollout, { codeless: true } as never);
    assert.deepEqual(await declarationOf(rollout), { codeless: true, reason: REASON });
  });

  await t.test('(2c) taking the declaration back puts the task back in the roll-up, and clears the '
    + 'reason', async () => {
    await tasks.update(ownerId, rollout, { codeless: false } as never);
    assert.deepEqual(await declarationOf(rollout), { codeless: false, reason: null },
      'a reason left behind would be explaining a declaration the task no longer makes');
    assert.equal(await landingOf(projectId, DECLARED_LATER), 'UNKNOWN');
    // ...and it is the edit door's to make again, at the same price.
    await tasks.update(ownerId, rollout, { codeless: true, codelessReason: REASON } as never);
    assert.equal(await landingOf(projectId, DECLARED_LATER), 'LANDED');
  });

  // ═══ (3) a task with commits of its own cannot be declared codeless ══════════════════════════
  await t.test('(3) a task with commits of its own is refused the declaration, and nothing is written',
    async () => {
      // One whose branch an agent merged into main itself: a target MOVED with its work.
      const merged = await settledTask(projectId, 'the work an agent merged itself', null);
      const mergedSession = await workSession(merged, 'orbit/merged-by-hand');
      await mergeRecorded(mergedSession, {
        result: 'MERGED', sourceSha: sha('e'), targetBranch: 'main',
        targetShaBefore: sha('0'), targetShaAfter: sha('e'),
      });
      // One whose session reported changes on its branch when it finished, landed nowhere yet.
      const worked = await settledTask(projectId, 'the work whose session reported changes', null);
      await workSession(worked, 'orbit/reported-work', { changedFiles: [{ path: 'src/the-change.ts' }] });

      for (const [taskId, kind, branch] of [
        [merged, 'MERGE_MOVED_A_TARGET', 'orbit/merged-by-hand'],
        [worked, 'SESSION_REPORTED_WORK', 'orbit/reported-work'],
      ] as const) {
        const refusal = await refused(() => tasks.update(ownerId, taskId,
          { codeless: true, codelessReason: REASON } as never));
        assert.equal(refusal.status, 409);
        assert.equal(refusal.body.code, 'TASK_CODELESS_HAS_COMMITS');
        assert.deepEqual(refusal.body.evidence, [{ kind, branch }],
          'the refusal names what says the task has commits of its own');
        assert.deepEqual(await declarationOf(taskId), { codeless: false, reason: null },
          'and writes nothing: the task stays in its criterion’s landing conjunction');
      }
    });

  // ═══ (4) NOTHING_TO_LAND, measured on main ═══════════════════════════════════════════════════
  await t.test('(4) NOTHING_TO_LAND whose tip the runner measured on main does not hold LANDED, on a '
    + 'line ahead of main', async () => {
    await twoPiecesOnMain(projectId, measuredOnMainAt.key, 'on-main');
    const zeroCommit = await settledTask(projectId, 'the rollout task that committed nothing', measuredOnMainAt.key);
    await workSession(zeroCommit, 'orbit/empty-on-main');
    await answered(await queuedFor(zeroCommit), { ...NOTHING_TO_LAND_ON_A_LINE_AHEAD, sourceOnUpstream: true });

    assert.deepEqual(await jobsOf(zeroCommit), [
      { state: 'NOTHING_TO_LAND', source_on_upstream: true, at_upstream: false, receipts: 1 },
    ], 'the measurement is on the row, beside an answer given against a line ahead of main — where '
      + 'the old inference (the line being the upstream) could never have said anything');
    assert.equal(await landingOf(projectId, MEASURED_ON_MAIN), 'LANDED',
      'the empty branch’s tip is on main, measured: there is nothing of this task’s that main lacks');
  });

  // ═══ (5) NOTHING_TO_LAND, measured off main ══════════════════════════════════════════════════
  await t.test('(5) NOTHING_TO_LAND whose tip the runner measured off main still holds LANDED', async () => {
    await twoPiecesOnMain(projectId, measuredOffMainAt.key, 'off-main');
    const forkedFromTheLine = await settledTask(projectId, 'the empty branch forked from the line',
      measuredOffMainAt.key);
    await workSession(forkedFromTheLine, 'orbit/empty-off-main');
    await answered(await queuedFor(forkedFromTheLine),
      { ...NOTHING_TO_LAND_ON_A_LINE_AHEAD, sourceOnUpstream: false });

    assert.deepEqual(await jobsOf(forkedFromTheLine), [
      { state: 'NOTHING_TO_LAND', source_on_upstream: false, at_upstream: false, receipts: 1 },
    ]);
    assert.equal(await landingOf(projectId, MEASURED_OFF_MAIN), 'ON_INTEGRATION_LINE',
      'nothing on the branch is not nothing that main lacks: its tip is a commit of the project line '
        + 'that main does not have yet, so the criterion waits for the line, as it always did');
  });

  // ═══ (6) NOTHING_TO_LAND, not measured ═══════════════════════════════════════════════════════
  await t.test('(6) NOTHING_TO_LAND with no measurement holds LANDED — even from a line AT main', async () => {
    await twoPiecesOnMain(projectId, notMeasuredAt.key, 'not-measured');
    const olderRunner = await settledTask(projectId, 'the empty branch an older runner answered about',
      notMeasuredAt.key);
    await workSession(olderRunner, 'orbit/empty-not-measured');
    // The answer exactly as a runner from before 0346 gives it, against a line that WAS main: the
    // shape the old exemption let out on inference alone.
    await answered(await queuedFor(olderRunner), {
      ...NOTHING_TO_LAND_ON_A_LINE_AHEAD, targetShaBefore: UPSTREAM_TIP,
    });

    assert.deepEqual(await jobsOf(olderRunner), [
      { state: 'NOTHING_TO_LAND', source_on_upstream: null, at_upstream: true, receipts: 1 },
    ]);
    assert.equal(await landingOf(projectId, NOT_MEASURED), 'ON_INTEGRATION_LINE',
      'the state is not the fact, and since 0346 the line being at main is not read in its place '
        + 'either: a NOTHING_TO_LAND is let out on the runner’s measurement and nothing else');
  });

  // ═══ (7) what the measurement must not release ═══════════════════════════════════════════════
  await t.test('(7a) an empty retry handed to the line while the work sat on another branch is not let '
    + 'out, measured on main or not', async () => {
    await twoPiecesOnMain(projectId, workElsewhereAt.key, 'elsewhere');
    const retried = await settledTask(projectId, 'the work whose retry died empty', workElsewhereAt.key);
    // The DONE queues the landing while the only finished session is the empty retry...
    await workSession(retried, 'orbit/retry-died-empty');
    const jobId = await queuedFor(retried);
    // ...and the session that did the work finishes after it, on its own branch, before the line looks.
    await workSession(retried, 'orbit/where-the-work-is', { changedFiles: [{ path: 'src/the-work.ts' }] });
    await answered(jobId, { ...NOTHING_TO_LAND_ON_A_LINE_AHEAD, sourceOnUpstream: true });

    assert.deepEqual(await jobsOf(retried), [
      { state: 'NOTHING_TO_LAND', source_on_upstream: true, at_upstream: false, receipts: 0 },
    ], 'the empty tip IS on main — and the answer wrote no receipt, because the task has work of its '
      + 'own on another branch');
    const told = await prisma.taskComment.findMany({ where: { taskId: retried }, select: { body: true } });
    assert.ok(told.some((comment) => comment.body.includes('orbit/where-the-work-is')),
      'the task is told which branch holds its work');
    assert.equal(await landingOf(projectId, WORK_ELSEWHERE), 'UNKNOWN',
      'the measurement is about the branch the line was handed; the task’s commits are on another one, '
        + 'and letting the criterion land on the empty branch’s answer would be the false green');
  });

  await t.test('(7b) a task whose session died and never finished is not let out', async () => {
    await twoPiecesOnMain(projectId, sessionDiedAt.key, 'died');
    const died = await settledTask(projectId, 'the work whose session died', sessionDiedAt.key);
    await workSession(died, 'orbit/session-died', 'DIED');
    const jobId = await queuedFor(died);

    assert.equal((await heartbeat('died')).find((command) => command.jobId === jobId), undefined,
      'a branch whose session never finished is not handed to the line: it may still grow');
    assert.deepEqual((await jobsOf(died)).map((job) => job.state), ['QUEUED']);
    assert.equal(await landingOf(projectId, SESSION_DIED), 'UNKNOWN',
      'no answer, no measurement, no declaration: nothing lets this task out, and no session or task '
        + 'status stands in for one');
  });

  // ═══ (8) the ready check ═════════════════════════════════════════════════════════════════════
  await t.test('(8) the start request warns about a criterion served only by work that looks codeless '
    + 'and does not say so', async () => {
    // A project nobody has started, coordinated from a parked conversation.
    const coordinatorSessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: coordinatorSessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runnerId,
        title: 'the coordinator',
        prompt: 'coordinate',
        provider: 'claude',
        status: RunStatus.AWAITING_INPUT,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: randomUUID(),
      },
    });
    await prisma.conversationTurn.create({
      data: {
        sessionId: coordinatorSessionId,
        seq: 1,
        clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
        kind: 'message',
        content: 'coordinate',
        status: 'ANSWERED',
      },
    });
    const planned = randomUUID();
    await prisma.project.create({
      data: {
        id: planned,
        ownerId,
        title: 'The project about to be started',
        coordinatorWorkspaceId: workspaceId,
        coordinatorSessionId,
      },
    });
    await prisma.projectRuntime.upsert({ where: { projectId: planned }, create: { projectId: planned }, update: {} });
    const ROLLOUT = 'it is live, and the owner has walked it through';
    const MIXED = 'the screen exists, and its screenshots match the mock-ups';
    const DECLARED = 'the research is written up';
    const [rolloutAt, mixedAt, declaredAt] = await stateCriteria(planned, [ROLLOUT, MIXED, DECLARED]);

    async function planTask(title: string, criterionKey: string, declaration: Record<string, unknown>) {
      return (await tasks.create(ownerId, {
        title, projectId: planned, criterionKey, assigneeId: workspaceId, ...declaration,
      } as never)).id;
    }
    // Criterion 1: only a rollout, confirmed by the owner, that does not declare codeless — the
    // shape of 2026-10-01's criterion 10.
    const rolloutTask = await planTask('roll it out', rolloutAt.key, { completionCriterion: 'OWNER_CONFIRMED' });
    // Criterion 2: a judged screenshot review BESIDE the code it reviews — not "only" codeless work.
    await planTask('review the screenshots', mixedAt.key, { completionCriterion: 'EVIDENCE_JUDGMENT' });
    await planTask('build the screen', mixedAt.key,
      { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
    // Criterion 3: judged work with no command that already says it produces no code.
    await planTask('write the research up', declaredAt.key,
      { completionCriterion: 'EVIDENCE_JUDGMENT', codeless: true });

    const ask = (why: string) => door.requestStart(runner, coordinatorSessionId, planned, {
      line: 'MAIN', automatic: false, maxConcurrentTasks: 2, mergeCheckCommand: null, why,
    } satisfies ProjectStartRequestBody as never) as Promise<ProjectStartRequestFiled>;

    const first = await ask('the plan is written and every criterion is served');
    assert.equal(first.state, 'OPEN', 'a warning does not refuse the request');
    const codelessWarnings = first.warnings.filter((finding) =>
      finding.code === 'START_CRITERION_CODELESS_UNDECLARED');
    assert.equal(codelessWarnings.length, 1,
      `exactly one criterion rests only on undeclared codeless-looking work: ${JSON.stringify(first.warnings)}`);
    const [warning] = codelessWarnings;
    assert.equal(warning.severity, 'WARN');
    assert.deepEqual(warning.criterion, { key: rolloutAt.key, ordinal: 1, text: ROLLOUT });
    assert.deepEqual(warning.tasks, [{ taskId: rolloutTask, title: 'roll it out' }]);
    assert.match(warning.message, /codeless/);
    assert.match(warning.requiredAction, /codelessReason/);

    // The coordinator declares it, and asks again: the warning is gone.
    await tasks.update(ownerId, rolloutTask, { codeless: true, codelessReason: REASON } as never);
    const again = await ask('the rollout now says it produces no code');
    assert.equal(again.state, 'OPEN');
    assert.deepEqual(
      again.warnings.filter((finding) => finding.code === 'START_CRITERION_CODELESS_UNDECLARED'), [],
      'every criterion now has either code to land or a declaration that it has none',
    );
  });

  // ═══ (9) end to end: the project is recorded done by Orbit ═══════════════════════════════════
  await t.test('(9) once the zero-commit task is declared codeless, the confirmed project is derived '
    + 'done — recorded by Orbit', async () => {
    const shipped = await projectOnALine('The project whose rollout committed nothing');
    const [only] = await stateCriteria(shipped, ['it is built, and it is live']);
    const built = await settledTask(shipped, 'build it', only.key);
    await mergeRecorded(await workSession(built, 'orbit/build-it', { changedFiles: [{ path: 'src/it.ts' }] }), {
      result: 'MERGED', sourceSha: sha('f'), targetBranch: 'main', targetShaBefore: sha('0'), targetShaAfter: sha('f'),
    });
    const live = await settledTask(shipped, 'put it live', only.key);
    await workSession(live, 'orbit/put-it-live');

    const standing = await acceptance.standardSetConfirmation(ownerId, shipped);
    await acceptance.confirmStandardSet(ownerId, shipped, { criteriaDigest: standing.currentVersion.digest });
    const before = await readDerivedProjectDone(db, ownerId, shipped);
    assert.deepEqual(before.withheld, ['CRITERION_UNLANDED'],
      'every criterion is met and confirmed: the zero-commit task’s landing is the only thing left');

    await tasks.update(ownerId, live, { codeless: true, codelessReason: REASON } as never);

    const { rows } = await sql.query<{ status: string; done_by: string | null }>(
      `SELECT "status"::text, "done_by" FROM "project" WHERE "id" = $1::uuid`, [shipped],
    );
    assert.deepEqual(rows, [{ status: 'DONE', done_by: 'DERIVED' }],
      'the declaration is a task write, and the projection it re-runs records the project done by '
        + 'itself — nobody had to record it by hand');
  });
});
