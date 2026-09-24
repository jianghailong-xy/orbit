/**
 * A candidate frozen before the work it offers had stopped moving.
 *
 * WHAT THIS IS FOR
 * ----------------
 * A `TASK_BRANCH` candidate is one task's branch offered to the owner for the upstream — what a
 * MAIN-line project promotes, because it has no branch of its own to accumulate on (M-F2, A-Q7). The
 * commit the owner is shown is not resolved by the platform: it is where the branch points when the
 * CANDIDATE'S OWN CHECK fetches it, reported back and written onto the row as `source_sha` (M-S1,
 * 0293). So that check is the only thing that ever looks at the branch, and until this rule it asked
 * nothing about the task whose work the branch carries.
 *
 * The runner commits a worktree when it FINISHES the session (SR13), and a candidate is queued by the
 * DONE that ends it — often the same beat. Freeze the tip then and the owner is asked to merge a
 * commit the session moves past seconds later: the card is answered, the older commit lands, and the
 * one behind it stays on the task branch with nothing left that would ever ask again. That is the
 * landing race of `task-landing-races-final-commit.pg.spec.ts` one level up, and the same two
 * questions close it:
 *
 *  1. HAS THE TASK'S WORK STOPPED MOVING — the work sessions of the task the candidate's `session_id`
 *     belongs to must all have a `finished_at`. Too early and the check goes back to the queue, where
 *     the claim guard holds it until that work settles (`landingJudgedTooEarly`, and `claimOne`'s
 *     SQL); the re-check then resolves the branch as it stands by then, carrying the commit the first
 *     look could not have seen.
 *  2. IS THE COMMIT THE OWNER IS ABOUT TO BE SHOWN THE TIP OF THE BRANCH THE WORK ENDED ON — the
 *     branch the last-finished work session's checkout ended on (`checkSawTheFinishedBranch` over
 *     `workBranchEndedOn`). If it is not, no re-check of THAT branch ever would be: the candidate is
 *     about a branch the work is not on, so it is retired and the branch the work IS on gets the
 *     candidate it was owed (`refileCandidateBehindTheWork`) — the row a DONE written after the work
 *     settled would have made.
 *
 * Nothing here loosens a guard. `READY` still means the checks passed, the freeze still happens, and
 * the owner is still asked — the question is only ever whether this is the commit to ask about.
 *
 * THE CASES
 * ---------
 *  (1) the work is still running: the queue hands nothing out, a `READY` reported early is not
 *      written down as a freeze (no `source_sha`, no card, the check back in the queue), and once the
 *      session ends the re-check freezes the tip the branch carries by then and the owner's card
 *      names the task it is about;
 *  (2) the tip is of a branch the work did not end on — the 789a8fffc shape one level up: two
 *      sessions, the enqueue frozen to the one that carries nothing, the work in the other. The
 *      candidate that asks about the wrong branch is retired without freezing and the work's own
 *      branch gets one, whose check runs and freezes the commit the owner is really being asked for;
 *  (3) the negative control: work settled on the branch the candidate names is frozen exactly as
 *      before — one candidate, one check, one card, nothing further owed.
 *
 * Everything is produced the way the product produces it: the candidate through `enqueueForDoneTask`
 * (M-F2, in the transaction that wrote DONE), the claim off the heartbeat (J-T2), the answer through
 * the result the runner posts (J-T5). What a case chooses is the ANSWER and the tip it was computed
 * against — whether one commit contains another is a fact only a repository has, and
 * `src/runner-go/integrate.go` is where it is resolved. The work sessions carry what a runner's
 * finalize records (`finished_at`, `worktree_branch`, `worktree_dirty`), and THE TIMESTAMPS ARE
 * RELATIVE to the claim that reads them, because the ordering is the fact under test.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/promotion-candidate-freeze.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RunStatus, RunnerStatus, TaskStatus, type PrismaClient } from '@prisma/client';
import type { IntegrationJobResultRequest } from '@orbit/shared';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from './project-integration-job';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, the only kind an integration job's sha columns accept. */
const sha = (nibble: string) => nibble.repeat(40);

/** The upstream, as the fetch that ran the check read it. */
const UPSTREAM = sha('b');

/** How the fixture dates a session: only the ORDER of these instants is under test. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

test('a candidate is not frozen before the work it offers has stopped moving', {
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

  // The heartbeat's half of the line's queue: what a runner claims and reports back on.
  const jobs = new IntegrationJobRelay(prisma as unknown as PrismaService);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `freeze-${ownerId}@promotion-candidate.invalid`, name: 'Freeze', passwordHash: 'x' },
  });
  await prisma.project.create({ data: { id: projectId, ownerId, title: 'The project that offered a branch before it settled' } });
  // A MAIN line: the project's integration ref IS its upstream, so a DONE queues no landing and
  // offers the task branch itself to the owner (M-F2, A-Q7). Started before any of this work
  // finished, so a DONE queues exactly its own candidate instead of back-filling the project's.
  await prisma.projectCodebase.create({
    data: {
      ownerId,
      projectId,
      canonicalRepoUrl: 'ssh://git@example.invalid/the-frozen-project',
      upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main',
      refAuthority: 'REMOTE',
      integrationRefSource: 'EXPLICIT',
      integrationStartedAt: new Date(Date.now() - 60_000),
    },
  });

  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'the runner that checks this project',
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
      repoUrl: 'ssh://git@example.invalid/the-frozen-project',
      workDir: '/srv/promotion-candidate-freeze',
    },
  });

  /** A code task that reached DONE. The DONE's own fence is not what this file is about. */
  async function doneTask(title: string) {
    const id = randomUUID();
    await prisma.task.create({
      data: {
        id,
        ownerId,
        projectId,
        title,
        status: TaskStatus.DONE,
        creatorType: 'AGENT',
        creatorId: ownerId,
        completionCriterion: 'EXECUTABLE',
      },
    });
    return id;
  }

  /**
   * A work session that ran `branch` in a worktree on the runner above, dated the way a case needs
   * it: `createdAt` is what an enqueue freezes by (the newest one), `finished` is what the runner's
   * finalize wrote after its last commit (SR13), and leaving it out is a session still able to
   * commit.
   */
  async function workSession(taskId: string, branch: string, when: {
    createdAt: Date;
    finished?: Date;
    worktreeBranch?: string;
    worktreeDirty?: boolean;
  }) {
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
        createdAt: when.createdAt,
        ...(when.finished
          ? {
            status: RunStatus.SUCCEEDED,
            finishedAt: when.finished,
            worktreeBranch: when.worktreeBranch ?? branch,
            worktreeDirty: when.worktreeDirty ?? false,
          }
          : { status: RunStatus.RUNNING }),
      },
    });
    return id;
  }

  /** The heartbeat, as the runner that holds the branches sends it (J-T2). */
  function heartbeat(leaseOwner: string) {
    return jobs.dispatch({
      runnerId,
      leaseOwner,
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
  }

  /** Queue this task's candidate, the way the DONE that ended it does (M-F2). */
  async function enqueue(taskId: string) {
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued && queued.kind === 'PROMOTION',
      `the DONE queued no candidate for ${taskId}: ${JSON.stringify(queued)}`);
    return { promotionId: queued.promotionId, jobId: queued.jobId };
  }

  /** The command the heartbeat hands over for exactly this job, or null when it was held back (J-T2). */
  async function handOut(jobId: string, leaseOwner: string) {
    const claimed = await heartbeat(leaseOwner);
    return claimed.find((command) => command.jobId === jobId) ?? null;
  }

  /**
   * The claim a build BEFORE these rules would have taken, written directly because the queue no
   * longer takes it for work that can still move (the claim guard is half the rule). It is the only
   * way left to reach the judgment under test, and the rows it reaches are the ones this deployment
   * already holds from before the rules shipped.
   */
  async function claimDirectly(jobId: string, leaseOwner: string) {
    await sql.query(
      `UPDATE "project_integration_job"
          SET "state" = 'RUNNING', "claim_lease_owner" = $2, "runner_id" = $3::uuid,
              "claim_generation" = "claim_generation" + 1, "claimed_at" = now(),
              "heartbeat_at" = now(), "started_at" = COALESCE("started_at", now())
        WHERE "id" = $1::uuid`,
      [jobId, leaseOwner, runnerId],
    );
    const row = await jobRow(jobId);
    assert.equal(row.state, 'RUNNING', 'the fixture has to be the claim it names');
    return { jobId, claimGeneration: String(row.claimGeneration), leaseOwner };
  }

  /** Report this job's result, the way the runner that ran it does (J-T5). */
  function answer(
    job: { jobId: string; claimGeneration: string; leaseOwner: string },
    body: Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>,
  ) {
    return jobs.applyResult(job.jobId, runnerId, {
      claimGeneration: job.claimGeneration,
      leaseOwner: job.leaseOwner,
      ...body,
    });
  }

  /** One job row, as every case reads it. */
  function jobRow(jobId: string) {
    return prisma.projectIntegrationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: {
        kind: true, state: true, generation: true, sourceRef: true, sourceSha: true,
        sessionId: true, promotionId: true, taskId: true, claimGeneration: true, claimedAt: true,
        finishedAt: true,
      },
    });
  }

  /** One candidate, as the owner's card is drawn from it. */
  function candidate(promotionId: string) {
    return prisma.projectPromotion.findUniqueOrThrow({
      where: { id: promotionId },
      select: {
        id: true, taskId: true, sessionId: true, sourceKind: true, sourceRef: true, sourceSha: true,
        upstreamRef: true, upstreamShaChecked: true, mergeTreeSha: true, commitsAhead: true,
        filesChanged: true, includedTaskIds: true, state: true, checkJobId: true, openItemId: true,
      },
    });
  }

  /**
   * The owner's card about one candidate, or null while the candidate is still being checked: this
   * is where a candidate is NAMED — a promotion job carries no task id, so a card about one names
   * the work it would merge (its title and payload) rather than a task row.
   */
  function cardOf(promotionId: string) {
    return prisma.projectOpenItem.findFirst({
      where: { promotionId },
      select: { id: true, kind: true, state: true, assignee: true, title: true, payload: true },
    });
  }

  /** Everything one task is owed, counted: its candidates, the checks queued for them, their cards. */
  async function owedFor(taskId: string) {
    const candidates = await prisma.projectPromotion.findMany({
      where: { taskId }, select: { id: true }, orderBy: { createdAt: 'asc' },
    });
    const ids = candidates.map((row) => row.id);
    const [jobCount, cardCount] = await Promise.all([
      prisma.projectIntegrationJob.count({ where: { promotionId: { in: ids } } }),
      prisma.projectOpenItem.count({ where: { promotionId: { in: ids } } }),
    ]);
    return { candidates: candidates.length, jobs: jobCount, cards: cardCount };
  }

  // ═══ (1) the work is still running ═══════════════════════════════════════════════════════════
  const stillRunning = await doneTask('the work whose session had not finished yet');
  const runningBranch = `orbit/still-running-${stillRunning.slice(0, 6)}`;
  const runningSession = await workSession(stillRunning, runningBranch, { createdAt: new Date() });
  const early = await enqueue(stillRunning);

  await t.test('(1) the queue hands out no check while the task has a work session running',
    async () => {
      const handed = await handOut(early.jobId, 'lease-early');
      assert.equal(handed, null,
        'the branch can still move: the runner commits when it finishes the session, so a check '
          + 'handed over now resolves a tip the session is about to move past, and that tip is the '
          + 'commit the owner would be asked to merge');
      const row = await jobRow(early.jobId);
      assert.equal(row.state, 'QUEUED', 'and it is still waiting in the queue, not judged');
      assert.equal(row.finishedAt, null);
      assert.equal(row.sourceSha, null, 'nothing has been resolved or written down about it');
      const queued = await candidate(early.promotionId);
      assert.equal(queued.state, 'CHECKING');
      assert.equal(queued.sourceSha, null,
        'a TASK_BRANCH candidate starts with no commit named (0293), and this one names none yet');
    });

  await t.test('(1) a READY taken while the work can still move does not freeze the tip', async () => {
    const claim = await claimDirectly(early.jobId, 'lease-early');
    const { answer: taken } = await answer(claim, {
      state: 'READY', phase: 'CHECK', sourceSha: sha('a'), upstreamSha: UPSTREAM,
      testedTreeSha: sha('c'), aheadOfUpstream: 1, filesChanged: 1, checks: [], conflicts: [],
    });
    assert.ok(taken.accepted, `the check's answer was refused outright: ${JSON.stringify(taken)}`);
    assert.equal(taken.state, 'QUEUED',
      'the check goes back to the queue it came from rather than freezing a tip that may be stale');
    const frozen = await candidate(early.promotionId);
    assert.equal(frozen.sourceSha, null,
      'nothing was frozen: the commit this check resolved is not necessarily the one the work ends '
        + 'on, and the owner is not asked about a tip the work can still move past');
    assert.equal(frozen.state, 'CHECKING', 'the candidate is still being checked, not offered');
    const row = await jobRow(early.jobId);
    assert.equal(row.state, 'QUEUED', 'and the check is waiting to be handed over again');
    assert.equal(row.claimedAt, null);
    assert.equal(row.finishedAt, null, 'a check that was not written down has no finish');
    assert.equal(row.sourceSha, null, 'and it kept none of what the refused answer reported');
    assert.deepEqual(await owedFor(stillRunning), { candidates: 1, jobs: 1, cards: 0 },
      'one candidate, one check, and no card: the question is not put to the owner yet');
  });

  await t.test('(1) once the session ends the check freezes the tip the branch then carries',
    async () => {
      // The session's finalize: the commit it leaves is on the branch, and only now is the branch
      // something the owner can be asked about (SR13).
      await prisma.session.update({
        where: { id: runningSession },
        data: {
          status: RunStatus.SUCCEEDED,
          finishedAt: new Date(),
          worktreeBranch: runningBranch,
          worktreeDirty: false,
        },
      });
      const handed = await handOut(early.jobId, 'lease-again');
      assert.ok(handed, 'the check the queue was held back from must be offered to the next heartbeat');
      assert.equal(handed.sourceRef, `refs/heads/${runningBranch}`,
        'and it is still the branch the DONE froze: what changed is that the branch has stopped '
          + 'moving, and the re-check resolves it as it stands NOW — with the commit it left');
      const { answer: taken } = await answer(handed, {
        state: 'READY', phase: 'CHECK', sourceSha: sha('d'), upstreamSha: UPSTREAM,
        testedTreeSha: sha('e'), aheadOfUpstream: 2, filesChanged: 3, checks: [], conflicts: [],
      });
      assert.ok(taken.accepted, `the check's answer was refused: ${JSON.stringify(taken)}`);
      const frozen = await candidate(early.promotionId);
      assert.equal(frozen.state, 'READY', 'the work had stopped moving, so this time it is the answer');
      assert.equal(frozen.sourceSha, sha('d'),
        'and it froze the tip the check resolved after that — the commit the owner is asked about');
      assert.equal(frozen.upstreamShaChecked, UPSTREAM);
      assert.equal(frozen.mergeTreeSha, sha('e'));
      assert.equal(frozen.commitsAhead, 2);
      assert.equal(frozen.filesChanged, 3);
      const card = await cardOf(early.promotionId);
      assert.ok(card, 'the owner is asked now, and the card is what names the work being merged');
      assert.equal(card.kind, 'PROMOTION_APPROVAL');
      assert.equal(card.assignee, 'OWNER');
      assert.equal(card.title, 'Merge 1 task into main?');
      assert.deepEqual((card.payload as { taskIds?: string[] }).taskIds, [stillRunning]);
      assert.equal(frozen.openItemId, card.id, 'and the candidate points at it');
      assert.deepEqual(await owedFor(stillRunning), { candidates: 1, jobs: 1, cards: 1 },
        'one candidate, one check, one card — the freeze owed nothing further');
    });

  // ═══ (2) the tip is of a branch the work did not end on ══════════════════════════════════════
  await t.test('(2) a check that looked at a branch the work did not end on retires the candidate '
    + 'and files the one the work is owed', async () => {
    // 789a8fffc, one level up. Two work sessions: the one that HOLDS the work started first and
    // finished LAST (the 151-turn session), and the retry beside it was created later — which is what
    // the DONE froze — and finished in one turn, carrying nothing.
    const raced = await doneTask('the work whose DONE froze a branch it had already left');
    const whereItWent = `orbit/where-it-went-${raced.slice(0, 6)}`;
    const startedHere = `orbit/started-here-${raced.slice(0, 6)}`;
    const held = await workSession(raced, whereItWent, {
      createdAt: minutesAgo(40), finished: minutesAgo(5),
    });
    const retry = await workSession(raced, startedHere, {
      createdAt: minutesAgo(30), finished: minutesAgo(29),
    });
    const wrong = await enqueue(raced);
    const frozen = await candidate(wrong.promotionId);
    assert.equal(frozen.sourceRef, `refs/heads/${startedHere}`,
      'the DONE freezes the NEWEST work session, which here is the retry that carries nothing');
    assert.equal(frozen.sessionId, retry);
    assert.equal(frozen.sourceSha, null, 'and the tip of that branch is resolved by the check, not here');

    // The work HAS stopped moving, and the check is handed over — which branch it is about is a
    // separate question, and the answer to it is the one that retires the candidate.
    const handed = await handOut(wrong.jobId, 'lease-wrong');
    assert.ok(handed, 'every work session has finished, so the claim guard holds nothing back');
    assert.equal(handed.sourceRef, `refs/heads/${startedHere}`);
    const { answer: taken } = await answer(handed, {
      state: 'READY', phase: 'CHECK', sourceSha: sha('1'), upstreamSha: UPSTREAM,
      testedTreeSha: sha('2'), aheadOfUpstream: 1, filesChanged: 1, checks: [], conflicts: [],
    });
    assert.ok(taken.accepted, `the check's answer was refused: ${JSON.stringify(taken)}`);

    const retired = await candidate(wrong.promotionId);
    assert.equal(retired.state, 'SUPERSEDED',
      'the candidate asked about a branch the task work did not end on, so the owner must not be '
        + 'asked to merge it — and it is retired rather than left standing in front of them');
    assert.equal(retired.sourceSha, null,
      'nothing was frozen: the tip of that branch is not the work, and no re-check of it ever would '
        + 'be — the row keeps what the check answered, about the branch it was handed');
    assert.equal(await cardOf(wrong.promotionId), null, 'and no card was opened about it');
    const written = await jobRow(wrong.jobId);
    assert.equal(written.state, 'READY',
      'the check itself is a fact and is written down where it belongs — on the job row, about the '
        + 'branch it was handed');
    assert.equal(written.sourceSha, sha('1'));
    assert.equal(written.promotionId, wrong.promotionId);

    // The branch the work IS on gets the candidate it was owed: the row a DONE written after the work
    // settled would have queued.
    const filed = await prisma.projectPromotion.findMany({
      where: { taskId: raced }, orderBy: { createdAt: 'asc' },
      select: { id: true, sourceRef: true, sessionId: true, taskId: true, state: true, sourceSha: true, checkJobId: true },
    });
    assert.equal(filed.length, 2, 'the work is owed exactly one more candidate, not a pile of them');
    const owed = filed.find((row) => row.id !== wrong.promotionId)!;
    assert.deepEqual(
      {
        sourceRef: owed.sourceRef, sessionId: owed.sessionId, taskId: owed.taskId,
        state: owed.state, sourceSha: owed.sourceSha,
      },
      {
        sourceRef: `refs/heads/${whereItWent}`, sessionId: held, taskId: raced,
        state: 'CHECKING', sourceSha: null,
      },
      'bound to the branch the work ended on and to the session that ended it — the candidate a DONE '
        + 'written after the work settled would have made (M-F2)',
    );
    const owedJob = await jobRow(owed.checkJobId!);
    assert.deepEqual(
      {
        kind: owedJob.kind, state: owedJob.state, sourceRef: owedJob.sourceRef,
        sessionId: owedJob.sessionId, promotionId: owedJob.promotionId, taskId: owedJob.taskId,
      },
      {
        kind: 'CHECK_PROMOTION', state: 'QUEUED', sourceRef: `refs/heads/${whereItWent}`,
        sessionId: held, promotionId: owed.id, taskId: null,
      },
      'with its own check queued: a promotion job names no task on purpose (0293), and this one is '
        + 'about the branch the work is on',
    );

    // …and that check freezes the commit the owner is really being asked about.
    const second = await handOut(owed.checkJobId!, 'lease-owed');
    assert.ok(second, 'the candidate the work was owed is handed to the line');
    assert.equal(second.sourceRef, `refs/heads/${whereItWent}`);
    const { answer: landed } = await answer(second, {
      state: 'READY', phase: 'CHECK', sourceSha: sha('3'), upstreamSha: UPSTREAM,
      testedTreeSha: sha('4'), aheadOfUpstream: 1, filesChanged: 2, checks: [], conflicts: [],
    });
    assert.ok(landed.accepted, `the owed check's answer was refused: ${JSON.stringify(landed)}`);
    const offered = await candidate(owed.id);
    assert.equal(offered.state, 'READY');
    assert.equal(offered.sourceSha, sha('3'),
      'the commit the work ended on is the one the owner is shown — the tip that had no route to a '
        + 'card at all while the candidate named the other branch');
    const card = await cardOf(owed.id);
    assert.equal(card?.title, 'Merge 1 task into main?');
    assert.deepEqual((card?.payload as { taskIds?: string[] }).taskIds, [raced]);

    // The candidate that IS about the branch the work ended on cannot be "left behind" by itself, so
    // the rule has nothing left to offer: one generation, one candidate for the work.
    assert.deepEqual(await owedFor(raced), { candidates: 2, jobs: 2, cards: 1 },
      'the queue stops there: no third candidate, no second card — the one the owner is asked about '
        + 'names the branch the work is on');
  });

  // ═══ (3) the negative control ════════════════════════════════════════════════════════════════
  await t.test('(3) work settled on the branch the candidate names is frozen as before', async () => {
    const quiet = await doneTask('the work that really is on the branch the DONE froze');
    const branch = `orbit/nothing-to-reconsider-${quiet.slice(0, 6)}`;
    const session = await workSession(quiet, branch, {
      createdAt: minutesAgo(30), finished: minutesAgo(29),
    });
    const settled = await enqueue(quiet);
    const queued = await candidate(settled.promotionId);
    assert.equal(queued.sessionId, session);
    assert.equal(queued.sourceRef, `refs/heads/${branch}`);

    const handed = await handOut(settled.jobId, 'lease-quiet');
    assert.ok(handed, 'the work settled on this very branch, so the check is handed over');
    const { answer: taken } = await answer(handed, {
      state: 'READY', phase: 'CHECK', sourceSha: sha('7'), upstreamSha: sha('8'),
      testedTreeSha: sha('9'), aheadOfUpstream: 1, filesChanged: 1, checks: [], conflicts: [],
    });
    assert.ok(taken.accepted, `the check's answer was refused: ${JSON.stringify(taken)}`);
    const frozen = await candidate(settled.promotionId);
    assert.equal(frozen.state, 'READY',
      'the session had finished and the branch was the one that work ended on: this is the freeze, '
        + 'and the guards have nothing to say about it');
    assert.equal(frozen.sourceSha, sha('7'));
    assert.equal(frozen.mergeTreeSha, sha('9'));
    const card = await cardOf(settled.promotionId);
    assert.equal(card?.title, 'Merge 1 task into main?');
    assert.deepEqual(await owedFor(quiet), { candidates: 1, jobs: 1, cards: 1 },
      'nothing further is owed: no second candidate was filed, no check was queued twice, and one '
        + 'card asks the owner');
  });
});
