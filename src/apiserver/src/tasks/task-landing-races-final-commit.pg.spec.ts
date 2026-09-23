/**
 * A landing judged before the work it is about had stopped moving.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The runner commits a worktree when it FINISHES the session (SR13), and a landing is queued by the
 * DONE — the same beat, or before it. So the line can be handed a branch that carries nothing yet,
 * and the only answer it can give about such a branch is `ALREADY_LANDED`: correct about the branch,
 * terminal by design (a terminal job is never offered again, §2.2 J-T3), and owed no receipt that
 * moves anything. The commit arrives seconds later and stays on the session's branch for ever.
 *
 * It has happened on this deployment, and the two incidents this file is built around are the two
 * halves of it (three rows carry the ordering — two on 2026-09-21 and the one below, measured
 * 2026-09-23 — and the two older ones turned out harmless only because their branches stayed empty):
 *
 *  - 2026-09-22: the line answered ALREADY_LANDED at 04:23:09Z about a branch whose session had not
 *    finished, and the commit appeared at 04:23:24Z. `project-criterion-landing.ts` audits that
 *    ordering (`jobSawTheFinishedBranch`) so the criteria stop counting the answer as "nothing to
 *    land" — but auditing it does not deliver anything, and the commits stayed on the branch.
 *  - 2026-09-23, `789a8fffc`: a task whose work was in the middle of a 151-turn session had a
 *    one-turn retry that had already FAILED beside it, and the DONE froze the RETRY's branch (whose
 *    tip was the project branch's tip). The line answered ALREADY_LANDED at 15:39:18.325Z — 2m42s
 *    before that session finished at 15:42:00.488Z — and the commit it made (789a8fffc, on branch
 *    `orbit/autorun-false-91f94d`) had no route to the line: it took a hand cherry-pick onto the
 *    project branch (`d6b55d2d8`) and another onto the upstream (`c125e11c6`).
 *
 * THE RULES (`projects/project-integration-job.ts`, read `landingWorkHasSettled`, `workBranchEndedOn`,
 * `landingJudgedTooEarly`, `landingLeftWorkBehind`)
 * -------------------------------------------------------------------------------------------------
 *  1. a landing is not CLAIMED while any work session of its task has no `finished_at` — the branch
 *     can still move, so there is nothing to ask the line about yet (`claimOne`);
 *  2. an `ALREADY_LANDED` is not written as final if it was taken before the task's work settled: the
 *     row goes back to the queue instead, which the first rule then holds until the work stops;
 *  3. a final `ALREADY_LANDED` about a branch the work did NOT end on leaves the work with no route,
 *     so the task is owed the next generation of its landing, bound to the branch the work ended on.
 *
 * THE CASES
 * ---------
 *  (1) the work is still running: the queue hands nothing out, a premature `ALREADY_LANDED` is not
 *      written down, and once the session ends the landing is handed over again — with the commit
 *      that session made now on the branch, which is the answer that lands it.
 *  (2) the 789a8fffc fixture, row for row: three sessions, the enqueue frozen to the one that
 *      carried nothing, the work session finished after the judgment, and the landing that follows
 *      bound to `orbit/autorun-false-91f94d` — the branch that commit is on.
 *  (3) the negative control: work that really has nothing of its own, settled on the branch that was
 *      offered, is written down as ALREADY_LANDED and nothing else is queued — no item, no wake.
 *  (4) the guard: one generation is owed at most one landing. A resent result (a response lost on
 *      its way back) queues nothing; the generation this rule queues is bound to the branch the work
 *      ended on and can never be "left behind" by itself, so the queue stops there; and neither path
 *      opens an exception item or raises a wake.
 *
 * Everything is produced the way the product produces it: the landing through `enqueueForDoneTask`
 * (J-T1a), the claim off the heartbeat (J-T2), the answer through the result the runner posts (J-T5),
 * which writes the job and its receipt in one transaction (J8). What a case chooses is the ANSWER and
 * the tips it was computed against — whether one commit contains another is a fact only a repository
 * has, and `src/runner-go/integrate.go` is where it is resolved. The work sessions carry what a
 * runner's finalize records (`finished_at`, `worktree_branch`, `worktree_dirty`), and the
 * TIMESTAMPS ARE RELATIVE to the claim that read them, because the ordering is the fact under test
 * and the incident's own clock (quoted above) is not the fixture's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-landing-races-final-commit.pg.spec.ts
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
} from '../projects/coordinator-pg-test-safety';
import { INTEGRATION_JOB_CLAIM, enqueueForDoneTask } from '../projects/project-integration-job';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** A full 40-hex object name, which is the only kind a receipt accepts. */
const sha = (nibble: string) => nibble.repeat(40);

/** The incident's commit, as the line would report the branch tip it read. */
const STRANDED_COMMIT = '789a8fffc0bf0223efe8d8286ed5fcae2cb6c414';
/** The project branch's tip when that landing answered: what the retry's branch pointed at. */
const PROJECT_TIP = '3fc8f28003d6e3fa50201c2be43c20020e889d55';

/** The line's answer about a branch that has nothing of its own on it (§2.4 J-S3). */
const NOTHING_OF_ITS_OWN = {
  state: 'ALREADY_LANDED',
  phase: 'REBASE',
  targetShaBefore: PROJECT_TIP,
  upstreamSha: PROJECT_TIP,
} as const;

/** How a work session's finalize left it. Omitted fields are a clean finish on its own branch. */
interface Finish {
  worktreeBranch?: string;
  worktreeDirty?: boolean;
}

test('a landing is not judged before the work it is about has stopped moving', {
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
    data: { id: ownerId, email: `races-${ownerId}@criterion-landing.invalid`, name: 'Races', passwordHash: 'x' },
  });
  await prisma.project.create({ data: { id: projectId, ownerId, title: 'The project that raced a commit' } });
  // A line of its own, started before any of this work finished: a DONE queues exactly its own
  // landing instead of back-queueing the project's (L3 step 4).
  const PROJECT_LINE = `project/${projectId}`;
  await prisma.projectCodebase.create({
    data: {
      ownerId,
      projectId,
      canonicalRepoUrl: 'ssh://git@example.invalid/the-raced-project',
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/${PROJECT_LINE}`,
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
      repoUrl: 'ssh://git@example.invalid/the-raced-project',
      workDir: '/srv/task-landing-races-final-commit',
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
   * A work session that ran `branch` in a worktree on the runner above — as its finalize left it
   * (`finish`), or still going (`'NOT_FINISHED'`), which is the state the runner is in while it can
   * still commit what the session leaves.
   */
  async function workSession(taskId: string, branch: string, finish: Finish | 'NOT_FINISHED', at?: Date) {
    const id = randomUUID();
    // A session that has finished ran and was left alone a while ago: its finish is in the PAST,
    // because the rule under test compares it with the claim that reads the branch.
    const createdAt = at ?? new Date(Date.now() - (finish === 'NOT_FINISHED' ? 0 : 120_000));
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
        createdAt,
        ...(finish === 'NOT_FINISHED'
          ? { status: RunStatus.RUNNING }
          : {
            status: RunStatus.SUCCEEDED,
            finishedAt: new Date(createdAt.getTime() + 60_000),
            worktreeBranch: finish.worktreeBranch ?? branch,
            worktreeDirty: finish.worktreeDirty ?? false,
          }),
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

  /** Queue this task's landing, the way the DONE that ended it does (J-T1a). */
  async function enqueue(taskId: string) {
    const queued = await prisma.$transaction((tx) => enqueueForDoneTask(tx, ownerId, taskId));
    assert.ok(queued.enqueued, `the DONE queued no landing for ${taskId}: ${JSON.stringify(queued)}`);
    return queued.enqueued ? queued.jobId : '';
  }

  /** The command the heartbeat hands over for exactly this job, or null when it was held back (J-T2). */
  async function handOut(jobId: string, leaseOwner: string) {
    const claimed = await heartbeat(leaseOwner);
    return claimed.find((command) => command.jobId === jobId) ?? null;
  }

  /**
   * The claim a build BEFORE this rule would have taken, written directly because the queue no
   * longer takes it (the claim guard is half the rule). It is the only way left to reach the
   * judgment under test, and the rows it reaches are the ones this deployment already holds from
   * before the rule shipped — three of them, in which the line answered while the session that
   * produces the branch had not finished.
   */
  async function claimDirectly(jobId: string, leaseOwner: string) {
    await sql.query(
      `UPDATE "project_integration_job"
          SET "state" = 'RUNNING', "claim_lease_owner" = $2,
              "claim_generation" = "claim_generation" + 1, "claimed_at" = now(),
              "heartbeat_at" = now(), "started_at" = COALESCE("started_at", now())
        WHERE "id" = $1::uuid`,
      [jobId, leaseOwner],
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
        state: true, phase: true, generation: true, sourceRef: true, sessionId: true,
        claimGeneration: true, claimedAt: true, finishedAt: true, receiptIds: true, taskId: true,
      },
    });
  }

  /**
   * Everything this task is owed, counted: the landings queued for it, the exception items opened
   * about it and the wakes raised for its project. The three numbers a case is about when it says
   * "nothing further", counted rather than asserted one at a time.
   */
  async function owedFor(taskId: string) {
    const [jobs, openItems, wakes] = await Promise.all([
      prisma.projectIntegrationJob.count({ where: { taskId } }),
      prisma.projectOpenItem.count({ where: { taskId } }),
      prisma.projectCoordinatorWake.count({ where: { projectId } }),
    ]);
    return { jobs, openItems, wakes };
  }

  // ═══ (1) the work is still running ═══════════════════════════════════════════════════════════
  const stillRunning = await doneTask('the work whose session had not finished yet');
  const runningBranch = `orbit/still-running-${stillRunning.slice(0, 6)}`;
  const runningSession = await workSession(stillRunning, runningBranch, 'NOT_FINISHED');
  const earlyJobId = await enqueue(stillRunning);

  await t.test('(1) the queue hands out no landing while the task has a work session running', async () => {
    const claimed = await handOut(earlyJobId, 'lease-early');
    assert.equal(claimed, null,
      'the branch can still move: the runner commits when it finishes the session, so a landing '
        + 'handed over now can only be answered "nothing of its own" about a branch that is about '
        + 'to grow');
    const row = await jobRow(earlyJobId);
    assert.equal(row.state, 'QUEUED', 'and it is still waiting in the queue, not judged');
    assert.equal(row.finishedAt, null);
    assert.deepEqual(row.receiptIds, [], 'nothing has been written down about this landing');
  });

  await t.test('(1) a premature ALREADY_LANDED is not written down as final', async () => {
    const claim = await claimDirectly(earlyJobId, 'lease-early');
    const { answer: taken } = await answer(claim, { ...NOTHING_OF_ITS_OWN, sourceSha: sha('5') });
    assert.ok(taken.accepted, `the line's answer was refused outright: ${JSON.stringify(taken)}`);
    const row = await jobRow(earlyJobId);
    assert.notEqual(row.state, 'ALREADY_LANDED',
      'the session that produces this branch is still running: the answer is about a branch that '
        + 'may still grow, and ALREADY_LANDED is terminal — nothing offers such a job again');
    assert.equal(row.state, 'QUEUED', 'it goes back to the queue it came from, to be judged again');
    assert.equal(row.finishedAt, null, 'a job that was not judged has no finish');
    assert.deepEqual(row.receiptIds, [],
      'and no receipt: a receipt is the record of a landing, and nothing landed');
    assert.equal(row.claimedAt, null);
  });

  await t.test('(1) once the session ends, the landing is handed over again and lands the commit',
    async () => {
      // The session's finalize: the commit it leaves is on the branch, and only now is the branch
      // something the line can be asked about (SR13).
      await prisma.session.update({
        where: { id: runningSession },
        data: {
          status: RunStatus.SUCCEEDED,
          finishedAt: new Date(),
          worktreeBranch: runningBranch,
          worktreeDirty: false,
        },
      });
      const job = await handOut(earlyJobId, 'lease-again');
      assert.ok(job, 'the job the line was held back from must be offered to the next heartbeat');
      assert.equal(job.sourceRef, `refs/heads/${runningBranch}`,
        'the line is handed the branch the work ended on, and it is fetched as it stands NOW — '
          + 'after the runner committed what the session left');
      const { answer: taken } = await answer(job, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: sha('a'),
        targetShaBefore: PROJECT_TIP,
        upstreamSha: PROJECT_TIP,
        landedSha: sha('b'),
        testedSha: sha('b'),
        testedTreeSha: sha('c'),
        landedTreeSha: sha('c'),
      });
      assert.ok(taken.accepted, `the landing was refused: ${JSON.stringify(taken)}`);
      const row = await jobRow(earlyJobId);
      assert.equal(row.state, 'LANDED', 'the second look is taken after the work settled, so it lands');
      assert.equal(row.receiptIds.length, 1,
        'and the landing leaves a receipt: the answer came after the commit existed, so there was '
          + 'something to land');
    });

  // ═══ (2) 789a8fffc, row for row ══════════════════════════════════════════════════════════════
  // The incident of 2026-09-23: a 151-turn session in flight (`…91f94d`, the commit's branch), a
  // one-turn retry that had already FAILED beside it (`…830a9b`, whose tip was the project branch's
  // tip), an earlier attempt that got nowhere (`…280742`), and a DONE written after all three had
  // started — which is why the freeze below lands on the retry.
  await t.test('(2) 789a8fffc: the landing is held, then re-queued onto the branch the work ended on',
    async () => {
      const raced = await doneTask('the work that was committed while a landing was in flight');
      const earlier = new Date(Date.now() - 60 * 60_000);
      const retry = new Date(Date.now() - 20 * 60_000);
      await workSession(raced, 'orbit/autorun-false-280742', {}, earlier);
      const workSessionId = await workSession(
        raced, 'orbit/autorun-false-91f94d', 'NOT_FINISHED', new Date(Date.now() - 40 * 60_000),
      );
      const retrySessionId = await workSession(raced, 'orbit/autorun-false-830a9b', {}, retry);
      // Its branch is the project's tip: a retry that failed in one turn committed nothing of its own.
      const jobId = await enqueue(raced);
      const frozen = await jobRow(jobId);
      assert.equal(frozen.sessionId, retrySessionId,
        'the enqueue freezes the NEWEST work session, which here is the retry that carries nothing');
      assert.equal(frozen.sourceRef, 'refs/heads/orbit/autorun-false-830a9b');

      // The line is NOT asked about that branch yet: the task has a work session with no
      // `finished_at`, so the branch can still move. A build before this rule handed it over — and
      // that claim is what the incident wrote down.
      assert.equal(await handOut(jobId, 'lease-raced'), null,
        'the session that holds this task work had not finished, so this landing waits');
      const claim = await claimDirectly(jobId, 'lease-raced');
      await answer(claim, { ...NOTHING_OF_ITS_OWN, sourceSha: PROJECT_TIP });
      const held = await jobRow(jobId);
      assert.notEqual(held.state, 'ALREADY_LANDED',
        'the task has a work session with no finished_at: judging it now writes a terminal answer '
          + 'about a branch a session is still able to move, which is how 789a8fffc was stranded');
      assert.equal(held.state, 'QUEUED');

      // That session finishes — the runner's last commit is on `orbit/autorun-false-91f94d`, at
      // 15:32:33Z in the incident, and its finish is recorded after it.
      await prisma.session.update({
        where: { id: workSessionId },
        data: {
          status: RunStatus.SUCCEEDED,
          finishedAt: new Date(),
          worktreeBranch: 'orbit/autorun-false-91f94d',
          worktreeDirty: false,
        },
      });

      const second = await handOut(jobId, 'lease-raced-again');
      assert.ok(second, 'and only now is the landing handed over: the work has stopped moving');
      const { answer: taken } = await answer(second, {
        ...NOTHING_OF_ITS_OWN, sourceSha: PROJECT_TIP,
      });
      assert.ok(taken.accepted, `the answer was refused: ${JSON.stringify(taken)}`);
      const judged = await jobRow(jobId);
      assert.equal(judged.state, 'ALREADY_LANDED',
        'this time it is the whole truth about the branch it was handed: the work settled');

      // …and that branch was not where the work ended, so the task is owed one more landing.
      const owed = await prisma.projectIntegrationJob.findMany({
        where: { taskId: raced },
        orderBy: { generation: 'asc' },
        select: { id: true, generation: true, state: true, sourceRef: true, sessionId: true },
      });
      assert.equal(owed.length, 2,
        'the ALREADY_LANDED is about a branch the task work did not end on, so the work has no route '
          + 'and the queue owes it one: the next generation');
      assert.deepEqual(owed[1], {
        id: owed[1].id,
        generation: 2,
        state: 'QUEUED',
        sourceRef: 'refs/heads/orbit/autorun-false-91f94d',
        sessionId: workSessionId,
      }, 'bound to the branch 789a8fffc is on, by the session that ended its work — the landing a '
        + 'DONE written after the work settled would have queued');

      const handed = await handOut(owed[1].id, 'lease-owed');
      assert.ok(handed, 'and the line is handed it, which is the route the commit never had');
      const { answer: landed } = await answer(handed, {
        state: 'LANDED',
        phase: 'VERIFY',
        sourceSha: STRANDED_COMMIT,
        targetShaBefore: PROJECT_TIP,
        upstreamSha: PROJECT_TIP,
        landedSha: STRANDED_COMMIT,
        testedSha: STRANDED_COMMIT,
        testedTreeSha: sha('e'),
        landedTreeSha: sha('e'),
      });
      assert.ok(landed.accepted, `the owed landing was refused: ${JSON.stringify(landed)}`);
      const receipt = await prisma.sessionMergeReceipt.findFirstOrThrow({
        where: { taskId: raced, result: 'MERGED' },
        orderBy: { createdAt: 'desc' },
        select: { sourceSha: true, targetBranch: true, sessionId: true },
      });
      assert.deepEqual(receipt, {
        sourceSha: STRANDED_COMMIT, targetBranch: PROJECT_LINE, sessionId: workSessionId,
      }, 'the commit reaches the line through the queue — which is what took a hand cherry-pick');
      assert.notEqual(retrySessionId, workSessionId);
    });

  // ═══ (3) the negative control ════════════════════════════════════════════════════════════════
  await t.test('(3) work settled on the branch that was offered owes nothing further', async () => {
    const quiet = await doneTask('the work that really had nothing of its own');
    const branch = `orbit/nothing-of-its-own-${quiet.slice(0, 6)}`;
    await workSession(quiet, branch, {});
    const jobId = await enqueue(quiet);
    const job = await handOut(jobId, 'lease-quiet');
    assert.ok(job, 'the work settled, so the landing is handed over');
    const { answer: taken } = await answer(job, { ...NOTHING_OF_ITS_OWN, sourceSha: sha('7') });
    assert.ok(taken.accepted, `the answer was refused: ${JSON.stringify(taken)}`);
    const row = await jobRow(jobId);
    assert.equal(row.state, 'ALREADY_LANDED',
      'the session had finished, the branch was the one the work ended on, and the line found '
        + 'nothing of its own on it: that is the answer, and it is final');
    assert.deepEqual(await owedFor(quiet), { jobs: 1, openItems: 0, wakes: 0 },
      'nothing further is owed: the work is settled on the branch the line was handed, so no later '
        + 'generation is queued, no exception item is opened and no wake is raised');
  });

  // ═══ (4) the guard: one generation is owed at most one landing ═══════════════════════════════
  await t.test('(4) a resent answer, and the generation it queued, do not queue a third', async () => {
    const once = await doneTask('the work whose commits the line was never handed');
    const wrongBranch = `orbit/started-here-${once.slice(0, 6)}`;
    const workBranch = `orbit/where-it-went-${once.slice(0, 6)}`;
    await workSession(once, wrongBranch, { worktreeBranch: workBranch });
    const jobId = await enqueue(once);
    const claim = await claimDirectly(jobId, 'lease-once');
    const { answer: first } = await answer(claim, { ...NOTHING_OF_ITS_OWN, sourceSha: sha('4') });
    assert.ok(first.accepted, `the answer was refused: ${JSON.stringify(first)}`);
    const queued = await prisma.projectIntegrationJob.findMany({
      where: { taskId: once }, orderBy: { generation: 'asc' },
      select: { id: true, generation: true, sourceRef: true, state: true },
    });
    assert.deepEqual(queued.map((j) => [j.generation, j.sourceRef, j.state]),
      [[1, `refs/heads/${wrongBranch}`, 'ALREADY_LANDED'],
        [2, `refs/heads/${workBranch}`, 'QUEUED']],
      'one generation, one landing: the answer is about a branch the work did not end on, so the '
        + 'next generation is queued — and it is the only one');

    // The runner's response was lost, so it sends the same result again: the job is terminal, and
    // the identity of a result is `(id, claim_lease_owner, claim_generation)` — the second copy is
    // answered `accepted: false` and nothing follows from it.
    const { answer: resent } = await answer(claim, { ...NOTHING_OF_ITS_OWN, sourceSha: sha('4') });
    assert.equal(resent.accepted, false, 'a resent result is not applied twice');
    assert.deepEqual(await owedFor(once), { jobs: 2, openItems: 0, wakes: 0 },
      'and it queues nothing: the landing this task was owed was queued once');

    // The line is handed the generation the fix queued, and answers the same thing about the branch
    // the work really ended on: that answer is about the branch it was handed, which is now the
    // right one, so the rule has nothing left to offer. This is what terminates the whole thing —
    // a generation bound to the branch the work ended on can never be "left behind" by itself.
    const second = await handOut(queued[1].id, 'lease-once-again');
    assert.ok(second, 'the owed generation is handed over once the work has settled');
    const { answer: nothingThere } = await answer(second, { ...NOTHING_OF_ITS_OWN, sourceSha: sha('4') });
    assert.ok(nothingThere.accepted, `the answer was refused: ${JSON.stringify(nothingThere)}`);
    assert.equal((await jobRow(queued[1].id)).state, 'ALREADY_LANDED');
    assert.deepEqual(await owedFor(once), { jobs: 2, openItems: 0, wakes: 0 },
      'and the queue stops there: the second look was about the branch the work ended on, so there '
        + 'is no third generation, no item and no wake — one generation, at most one landing');
  });
});
