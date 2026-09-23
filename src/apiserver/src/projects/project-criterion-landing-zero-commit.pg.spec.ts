/**
 * A criterion's landing on real PostgreSQL, for work that ran a branch, committed nothing to it, and
 * never said so.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Since 57639ba119 a task that DECLARES it needs no code (`codeless`) no longer holds its criterion
 * off LANDED. The declaration is written when a task is created and no door writes it afterwards, so
 * a task created without it can never gain it — and the project that fix was written for went on
 * reading ON_INTEGRATION_LINE on the same criterion, because the task holding it declared nothing.
 * It was the UI acceptance task. It ran a branch (`orbit/ui-1-6-a48a23`) and committed nothing to
 * it; the line, handed that branch the next day, long after its session had finished, answered
 * ALREADY_LANDED against a line that was at that moment the upstream itself
 * (`target_sha_before = upstream_sha`, no main sync). The receipt that answer writes names the
 * project's line, so by receipts the task was "on the line, not yet on main" for ever: no promotion
 * writes a main receipt for a landing that moved nothing.
 *
 * The fact this file stands on is that answer — the line's own observation that the branch had no
 * commit of its own — and every case is about what it takes for the observation to be the whole
 * truth about a task (`lineSawNothingToLand` in `project-criterion-landing.ts`).
 *
 * THE CASES
 * ---------
 *  (a) Two pieces on main, and a third whose finished branch the line found already on the
 *      upstream. LANDED.
 *  (b) The guard 57639ba119 was written for, and the one that matters most here: a third piece whose
 *      own commits the line LANDED on the project branch, and which then ran again in a session that
 *      took no worktree. Read off the newest session, it is "not code"; it has commits on the line
 *      and not on main, so ON_INTEGRATION_LINE.
 *  (c) The negative control: three pieces, none of whose work landed. Never LANDED.
 *  (d) The declaration, as before: a third piece that declares it needs no code. LANDED.
 *
 * And four controls that are the rows of (a) with ONE fact changed, so each is a control for one
 * condition of the fact rather than for the case as a whole:
 *
 *  - the line looked before the session had finished. This is the ordering that lost this rule's own
 *    first delivery on 2026-09-22: the landing is queued by the DONE, the runner commits when it
 *    finishes the session, and the commit appeared fifteen seconds after the line had answered;
 *  - the session ended on another branch (`git checkout -b` inside its checkout);
 *  - the session finished with work it could not commit;
 *  - the line had moved past the upstream, so what it found the tip inside was only the LINE.
 *
 * Every fact is produced the way the product produces it: work through `TasksService.create`, DONE
 * through 0193/0230's fence, a merge an agent made itself through `MergeReceiptService.record`, and
 * the line's answers through its queue — queued by `enqueueForDoneTask` (J-T1a), claimed off the
 * heartbeat by the runner that holds the branch (J-T2), and answered by the result that runner posts
 * (J-T5), which writes the job and its receipt in one transaction (J8). What a case chooses is the
 * ANSWER and the tips it was computed against: whether one commit contains another is a fact only a
 * repository has, and `src/runner-go/integrate.go` is where it is resolved. The work sessions are
 * rows carrying what a runner's finalize records (`finished_at`, `worktree_branch`,
 * `worktree_dirty`).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-criterion-landing-zero-commit.pg.spec.ts
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

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/** The upstream's tip, and a line tip that has moved past it. */
const UPSTREAM_TIP = sha('9');
const LINE_AHEAD_OF_UPSTREAM = sha('c');

/** What the line answers about a branch with nothing of its own on it, offered to a line AT main. */
const NOTHING_OF_ITS_OWN = {
  state: 'ALREADY_LANDED',
  phase: 'REBASE',
  sourceSha: sha('5'),
  targetShaBefore: UPSTREAM_TIP,
  upstreamSha: UPSTREAM_TIP,
} as const;

/** One criterion as the outward read states it, narrowed to what this spec reads. */
interface StatedCriterion {
  text: string;
  satisfied?: boolean;
  unmet?: Array<{ clause: string }>;
  landing?: string;
}

/** How a work session's finalize left it. Omitted fields are a clean finish on its own branch. */
interface Finish {
  worktreeBranch?: string;
  worktreeDirty?: boolean;
}

test('a criterion is LANDED over work whose finished branch the line found nothing of its own on', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
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

  const projects = new ProjectsService(prisma as unknown as PrismaService,
    new ProjectAcceptanceService(prisma as unknown as PrismaService));
  const tasks = new TasksService(prisma as never, {} as never, {
    publishTaskChanged() {},
    publishForUser() {},
  } as never);
  const receipts = new MergeReceiptService(prisma as unknown as PrismaService);
  // The heartbeat's half of the line's queue: what a runner claims and reports back on.
  const jobs = new IntegrationJobRelay(prisma as unknown as PrismaService);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `zero-commit-${ownerId}@criterion-landing.invalid`,
      name: 'Project detail',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose acceptance task committed nothing' },
  });
  // The project's own binding: upstream `main`, and a line of its own that started before any of
  // this work finished — the ordinary state after a first landing, and the one in which a DONE
  // queues exactly its own landing instead of back-queueing the project's (L3 step 4).
  const PROJECT_LINE = `project/${projectId}`;
  await prisma.projectCodebase.create({
    data: {
      ownerId,
      projectId,
      canonicalRepoUrl: 'ssh://git@example.invalid/the-project',
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${PROJECT_LINE}`,
      refAuthority: 'REMOTE',
      integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date(Date.now() - 60_000),
    },
  });

  // The runner that holds the branches, and the workspace its checkout is bound to: a landing is
  // only handed to the runner whose workspace the session ran in (`claimOne`).
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
      repoUrl: 'ssh://git@example.invalid/the-project',
      workDir: '/srv/criterion-landing-zero-commit',
    },
  });

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

  /** One finished task serving a criterion. Declares nothing: `codeless` is false unless a case sets it. */
  async function settledTask(title: string, criterionKey: string) {
    const task = await tasks.create(ownerId, {
      title,
      projectId,
      criterionKey,
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    } as never);
    await settleExecutable(task.id);
    return task.id;
  }

  /**
   * A work session that ran `branch` in a worktree on the runner above — as its finalize left it a
   * minute ago (`finish`), or still going (`'NOT_FINISHED'`).
   */
  async function workSession(taskId: string, branch: string, finish: Finish | 'NOT_FINISHED' = {}) {
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
        ...(finish === 'NOT_FINISHED'
          ? { status: RunStatus.RUNNING }
          : {
            status: RunStatus.SUCCEEDED,
            finishedAt: new Date(Date.now() - 60_000),
            worktreeBranch: finish.worktreeBranch ?? branch,
            worktreeDirty: finish.worktreeDirty ?? false,
          }),
      },
    });
    return id;
  }

  /**
   * The line is handed this task's newest branch and answers — queued, claimed and answered the way
   * the platform does it (see the header). Returns when the line first looked.
   */
  async function offeredToTheLine(
    taskId: string,
    answer: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
  ) {
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued, `the DONE queued no landing for ${taskId}: ${JSON.stringify(queued)}`);
    const claimed = await jobs.dispatch({
      runnerId,
      leaseOwner: `lease-${taskId}`,
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
    const job = claimed.find((command) => command.jobId === queued.jobId);
    assert.ok(job, `the heartbeat was handed no landing for ${taskId}, which its DONE queued`);
    const { answer: taken } = await jobs.applyResult(job.jobId, runnerId, {
      claimGeneration: job.claimGeneration,
      leaseOwner: job.leaseOwner,
      ...answer,
    });
    assert.ok(taken.accepted, `the line's answer was refused: ${JSON.stringify(taken)}`);
    const row = await prisma.projectIntegrationJob.findUniqueOrThrow({
      where: { id: job.jobId },
      select: { startedAt: true },
    });
    assert.ok(row.startedAt, 'a job the line answered was claimed, so it has a start');
    return { lookedAt: row.startedAt };
  }

  /** One receipt, through the door an agent records a merge it made itself with. */
  function mergeRecorded(
    sessionId: string,
    body: { result: string; sourceSha: string; targetBranch: string; targetShaBefore?: string; targetShaAfter?: string },
  ) {
    return receipts.record(ownerId, sessionId, body as never, 'AGENT');
  }

  /** The two pieces of a criterion's work that reached main: the part of each case not in question. */
  async function twoPiecesOnMain(criterionKey: string, label: string) {
    for (const [nibble, n] of [['b', 1], ['d', 2]] as const) {
      const branch = `orbit/${label}-reached-main-${n}`;
      const sessionId = await workSession(await settledTask(`the part that reached main (${branch})`, criterionKey), branch);
      await mergeRecorded(sessionId, {
        result: 'MERGED', sourceSha: sha(nibble), targetBranch: 'main',
        targetShaBefore: sha('0'), targetShaAfter: sha(nibble),
      });
    }
  }

  /** The read under test: the project detail, and its criteria as it states them. */
  async function detail(): Promise<StatedCriterion[]> {
    const read = await projects.get(ownerId, projectId) as unknown as {
      acceptanceCriteriaItems: StatedCriterion[];
    };
    return read.acceptanceCriteriaItems;
  }

  /** One criterion's three answers, all required to be there — a missing one is not a passing one. */
  function answerOf(items: StatedCriterion[], text: string) {
    const item = items.find((row) => row.text === text);
    assert.ok(item, `the project must still state “${text}”`);
    const { satisfied, unmet, landing } = item;
    if (satisfied === undefined || unmet === undefined || landing === undefined) {
      assert.fail(`the outward read carries no complete answer for “${text}”: `
        + `satisfied=${satisfied}, unmet=${unmet && 'present'}, landing=${landing}`);
    }
    return { satisfied, clauses: unmet.map((reason) => reason.clause), landing };
  }

  const NOTHING_ON_THE_BRANCH = '(a) the work settled, and one piece ran a branch the line found nothing of its own on';
  const LANDED_AND_RAN_AGAIN = '(b) the work settled, and one piece landed commits on the line, then ran again without a worktree';
  const NONE_OF_IT_LANDED = '(c) none of the work for this one has landed anywhere';
  const DECLARED_CODELESS = '(d) the work settled, and one piece declares it needs no code';
  const LOOKED_TOO_SOON = 'the work settled, and the line looked at one piece before its session had finished';
  const ENDED_ELSEWHERE = 'the work settled, and one piece’s session ended on a branch the line was never handed';
  const LEFT_UNCOMMITTED = 'the work settled, and one piece’s session finished with work it could not commit';
  const LINE_HAD_MOVED_ON = 'the work settled, and one piece was offered to a line that had moved past main';

  const [
    nothingOnTheBranchAt, landedAndRanAgainAt, noneOfItLandedAt, declaredCodelessAt,
    lookedTooSoonAt, endedElsewhereAt, leftUncommittedAt, lineHadMovedOnAt,
  ] = criteriaFromDefinitions((await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: [
      NOTHING_ON_THE_BRANCH, LANDED_AND_RAN_AGAIN, NONE_OF_IT_LANDED, DECLARED_CODELESS,
      LOOKED_TOO_SOON, ENDED_ELSEWHERE, LEFT_UNCOMMITTED, LINE_HAD_MOVED_ON,
    ].map((text) => ({ text, verificationMethod: METHOD })),
  } as never)).acceptanceCriteriaItems);

  // ── (a) the UI acceptance task as it really is ─────────────────────────────────────────────────
  // It ran a branch, committed nothing, its session finished, and then the line was handed the branch
  // and found its tip already on the upstream — the line and the upstream at the same commit, no
  // main sync. Nothing about it declares anything.
  await twoPiecesOnMain(nothingOnTheBranchAt.key, 'a');
  const acceptanceTask = await settledTask('UI acceptance: implementation screenshots against the mock-ups',
    nothingOnTheBranchAt.key);
  await workSession(acceptanceTask, 'orbit/ui-acceptance');
  await offeredToTheLine(acceptanceTask, NOTHING_OF_ITS_OWN);

  // ── (b) the guard: commits the line landed on the project branch, then another attempt ─────────
  // The line LANDED this task's branch — its commits are on the project branch, and the receipt that
  // landing writes is `MERGED`, a target that moved. Then the task ran again, in a session that took
  // no worktree and ran no branch, and that session is now its newest.
  await twoPiecesOnMain(landedAndRanAgainAt.key, 'b');
  const landedTask = await settledTask('the work whose commits the line landed, run again after',
    landedAndRanAgainAt.key);
  await workSession(landedTask, 'orbit/landed-then-ran-again');
  await offeredToTheLine(landedTask, {
    state: 'LANDED',
    phase: 'VERIFY',
    sourceSha: sha('8'),
    targetShaBefore: LINE_AHEAD_OF_UPSTREAM,
    upstreamSha: UPSTREAM_TIP,
    testedSha: sha('a'),
    testedTreeSha: sha('e'),
    landedSha: sha('a'),
    landedTreeSha: sha('e'),
  });
  await prisma.session.create({
    data: {
      id: randomUUID(),
      ownerId,
      creatorId: ownerId,
      taskId: landedTask,
      workspaceId,
      title: 'ran again without a worktree',
      prompt: 'do the work once more',
      status: RunStatus.SUCCEEDED,
      // Stated, so which session is newest is this fixture's fact and not two inserts' timing.
      createdAt: new Date(Date.now() + 1_000),
    },
  });

  // ── (c) three pieces, none of which landed ─────────────────────────────────────────────────────
  for (const n of [1, 2, 3]) {
    await workSession(await settledTask(`the work that never landed (${n})`, noneOfItLandedAt.key),
      `orbit/never-landed-${n}`);
  }

  // ── (d) the declaration ────────────────────────────────────────────────────────────────────────
  // Written on the row, which is how the product writes it: no DTO carries `codeless`.
  await twoPiecesOnMain(declaredCodelessAt.key, 'd');
  const declaredTask = await settledTask('the acceptance task that declares it needs no code',
    declaredCodelessAt.key);
  await prisma.task.update({ where: { id: declaredTask }, data: { codeless: true } });

  // ── (a) with one fact changed: the line looked before the session had finished ─────────────────
  // Queued by the DONE while the runner was still finishing the session; the finish, recorded
  // fifteen seconds after the line looked, is where the runner commits whatever the session left.
  await twoPiecesOnMain(lookedTooSoonAt.key, 'too-soon');
  const tooSoonTask = await settledTask('the work the line looked at too soon', lookedTooSoonAt.key);
  const tooSoonSession = await workSession(tooSoonTask, 'orbit/looked-at-too-soon', 'NOT_FINISHED');
  const tooSoonAnswer = await offeredToTheLine(tooSoonTask, NOTHING_OF_ITS_OWN);
  await prisma.session.update({
    where: { id: tooSoonSession },
    data: {
      status: RunStatus.SUCCEEDED,
      finishedAt: new Date(tooSoonAnswer.lookedAt.getTime() + 15_000),
      worktreeBranch: 'orbit/looked-at-too-soon',
      worktreeDirty: false,
    },
  });

  // ── (a) with one fact changed: HEAD ended on a branch the line was never handed ────────────────
  await twoPiecesOnMain(endedElsewhereAt.key, 'elsewhere');
  const elsewhereTask = await settledTask('the work committed on a branch of its own making',
    endedElsewhereAt.key);
  await workSession(elsewhereTask, 'orbit/started-here', { worktreeBranch: 'feat/where-the-work-went' });
  await offeredToTheLine(elsewhereTask, NOTHING_OF_ITS_OWN);

  // ── (a) with one fact changed: the finish left work uncommitted ────────────────────────────────
  await twoPiecesOnMain(leftUncommittedAt.key, 'uncommitted');
  const uncommittedTask = await settledTask('the work left uncommitted in its checkout',
    leftUncommittedAt.key);
  await workSession(uncommittedTask, 'orbit/left-work-behind', { worktreeDirty: true });
  await offeredToTheLine(uncommittedTask, NOTHING_OF_ITS_OWN);

  // ── (a) with one fact changed: the line had moved past the upstream ────────────────────────────
  await twoPiecesOnMain(lineHadMovedOnAt.key, 'moved-on');
  const movedOnTask = await settledTask('the work offered to a line ahead of main', lineHadMovedOnAt.key);
  await workSession(movedOnTask, 'orbit/offered-to-a-line-ahead');
  await offeredToTheLine(movedOnTask, { ...NOTHING_OF_ITS_OWN, targetShaBefore: LINE_AHEAD_OF_UPSTREAM });

  /** What the table holds about one task — so each case is shown to be the shape it claims. */
  async function recordOf(taskId: string) {
    const [taskRow, newest] = await Promise.all([
      prisma.task.findUniqueOrThrow({
        where: { id: taskId },
        select: {
          codeless: true,
          mergeReceipts: { select: { result: true, targetBranch: true } },
          integrationJobs: { select: { state: true, targetShaBefore: true, upstreamSha: true, mainSyncSha: true } },
        },
      }),
      prisma.session.findFirst({
        where: { taskId, startsTaskWork: true, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { branch: true, isolationStatus: true },
      }),
    ]);
    return { ...taskRow, newestWorkSession: newest };
  }

  const stated = await detail();

  // ═══ (a) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(a) a piece whose finished branch the line found already on main does not withhold '
    + 'LANDED', async () => {
    assert.deepEqual(await recordOf(acceptanceTask), {
      codeless: false,
      mergeReceipts: [{ result: 'ALREADY_MERGED', targetBranch: PROJECT_LINE }],
      integrationJobs: [{
        state: 'ALREADY_LANDED', targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP, mainSyncSha: null,
      }],
      newestWorkSession: { branch: 'orbit/ui-acceptance', isolationStatus: 'worktree' },
    }, 'the production shape: declares nothing, ran a branch, and its only receipt — the one the '
      + 'line’s answer wrote — names the project’s line, which is what held the criterion off LANDED');
    assert.deepEqual(answerOf(stated, NOTHING_ON_THE_BRANCH),
      { satisfied: true, clauses: [], landing: 'LANDED' },
      'the line looked at the branch after its session had finished and found the tip already on '
        + 'main: this task never had a commit of its own, so nothing of this criterion is waiting to '
        + 'land. Before this unit the criterion read ON_INTEGRATION_LINE for ever, with nothing able '
        + 'to move it, and so did the project');
  });

  // ═══ (b) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(b) a piece with its own commits on the line still reads ON_INTEGRATION_LINE, '
    + 'whatever its newest session looks like', async () => {
    const record = await recordOf(landedTask);
    assert.equal(record.codeless, false);
    assert.deepEqual(record.mergeReceipts, [{ result: 'MERGED', targetBranch: PROJECT_LINE }],
      'its commits are on the project branch: the landing moved it');
    assert.deepEqual(record.newestWorkSession, { branch: null, isolationStatus: null },
      'and its newest work session ran no branch, which is §1.1’s second half answering "not code"');
    assert.deepEqual(answerOf(stated, LANDED_AND_RAN_AGAIN),
      { satisfied: true, clauses: [], landing: 'ON_INTEGRATION_LINE' },
      'this is the false green 57639ba119 refused, and it is refused here too: the commits the first '
        + 'attempt landed are on the line and not on main, and the line’s record of this task is a '
        + 'landing, not "nothing of its own". Reading the newest session instead would say LANDED '
        + 'over work only the project branch has');
  });

  // ═══ (c) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(c) a criterion none of whose work landed is not LANDED', async () => {
    const noneLanded = answerOf(stated, NONE_OF_IT_LANDED);
    assert.deepEqual(noneLanded, { satisfied: true, clauses: [], landing: 'UNKNOWN' },
      'three branches, no receipt and no answer from the line: nothing here says any of it landed, '
        + 'and the absence of the line’s answer is not the answer "nothing to land"');
    assert.notEqual(noneLanded.landing, 'LANDED');
  });

  // ═══ (d) ══════════════════════════════════════════════════════════════════════════════════════
  await t.test('(d) a piece that declares it needs no code does not withhold LANDED, as before',
    async () => {
      const record = await recordOf(declaredTask);
      assert.deepEqual(record, {
        codeless: true, mergeReceipts: [], integrationJobs: [], newestWorkSession: null,
      }, 'no branch, no receipt and no answer from the line: only the declaration lets it out');
      assert.deepEqual(answerOf(stated, DECLARED_CODELESS),
        { satisfied: true, clauses: [], landing: 'LANDED' },
        'the declaration is what 57639ba119 honoured, and widening the exemption beside it takes '
          + 'nothing away from it');
    });

  // ═══ the four controls: (a) with one fact changed ═════════════════════════════════════════════
  await t.test('an answer taken before the session finished does not count', async () => {
    const finished = await prisma.session.findUniqueOrThrow({
      where: { id: tooSoonSession },
      select: { finishedAt: true },
    });
    assert.ok(finished.finishedAt && finished.finishedAt > tooSoonAnswer.lookedAt,
      'the fixture has to be the ordering it names: the line looked, then the session finished');
    assert.deepEqual(answerOf(stated, LOOKED_TOO_SOON),
      { satisfied: true, clauses: [], landing: 'ON_INTEGRATION_LINE' },
      'the line looked before the runner had committed what the session left, so the answer is about '
        + 'a branch that may have grown since — the way this rule’s own first delivery was lost');
  });

  await t.test('an answer about a branch the session did not end on does not count', async () => {
    assert.deepEqual(answerOf(stated, ENDED_ELSEWHERE),
      { satisfied: true, clauses: [], landing: 'ON_INTEGRATION_LINE' },
      'the line was handed the branch the session started on, and HEAD ended on another one: an '
        + 'empty branch says nothing about the commits on the branch it was never handed');
  });

  await t.test('an answer about a session that left work uncommitted does not count', async () => {
    assert.deepEqual(answerOf(stated, LEFT_UNCOMMITTED),
      { satisfied: true, clauses: [], landing: 'ON_INTEGRATION_LINE' },
      'what the finish could not commit can still reach the branch after the line looked');
  });

  await t.test('an answer from a line that had moved past main does not count', async () => {
    assert.deepEqual(answerOf(stated, LINE_HAD_MOVED_ON),
      { satisfied: true, clauses: [], landing: 'ON_INTEGRATION_LINE' },
      'the line held commits main did not, so a tip found inside the line may be there because this '
        + 'task’s work was merged into it earlier — one answer for two situations, and the read may '
        + 'not choose the one that says LANDED');
  });
});
