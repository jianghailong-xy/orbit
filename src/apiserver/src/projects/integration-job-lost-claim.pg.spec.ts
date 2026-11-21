import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Prisma, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { IntegrationCheckResult, IntegrationJobCommand, IntegrationJobResultRequest } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { IntegrationJobRelay, receiveIntegrationJobProgress } from '../runner-api/integration-job-relay';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectOpenItemService } from './project-open-item.service';
import {
  INTEGRATION_JOB_CLAIM,
  INTEGRATION_PROGRESS_V2,
  PROMOTION_AUTOMATIC_LAND,
  enqueueForDoneTask,
} from './project-integration-job';
import { configureProjectIntegration, readInFlightJobs } from './project-integration-line';
import { ProjectPromotionService } from './project-promotion.service';

/**
 * A live runner process that lost the command of a claim it holds (docs/project-integration-line-
 * contract.md §2.3 J-T3a), on real PostgreSQL.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/integration-job-lost-claim.pg.spec.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * At 2026-10-18 16:03:15Z the HPC runner's process (lease owner 1a69cfb2-…, runner 0.1.232, which
 * declared no `integration-progress/v2`) claimed job 88cfd7e8, a project's LAND_PROMOTION into
 * main, and never reported a phase: its heartbeat_at stayed its claimed_at. The process lived on,
 * kept beating, and finished other jobs on refs/heads/main in the same checkout, which take the
 * same in-process lock — so nothing in it was running that job: the answer that carried the claim
 * never reached it, or the goroutine ended without a word. A claim was handed out once, in the
 * answer to the beat that made it, and the takeover is for another process, so main's serial slot
 * was held for 31 hours with four promotions queued behind it, until the runner was restarted on
 * 2026-10-19 at 23:35Z and its new process took the job over as claim 2. That restart untangled
 * production (task comment 34itQ2WHMwQCSWQpF5XKM); this spec is the fix that makes it unnecessary.
 *
 * THE CASES
 * ---------
 *  (1) The 10-19 case. A LAND_PROMOTION into main held by the beating process's own lease owner,
 *      heartbeat_at = claimed_at 31 hours ago, no phase ever reported, and another project's
 *      LAND_PROMOTION queued behind it on the same serial key. The process's next beat is handed the
 *      claim again — the very command the claim was, under the same claim generation — and nothing
 *      about the row moves, so V6 still reads its silence. It is handed again on every beat until the
 *      claim is heard from; the runner's report and result are taken under that claim; and the next
 *      beat claims the promotion queued behind it. No new process, and nobody pressed anything. A
 *      draining process is handed nothing, as before.
 *  (2) A v2 claim that reported and then went silent past the lease is handed again too, still asked
 *      for the synchronous PUSH report.
 *  (3) What is NOT handed again: a claim of the same process that reports on time, under either
 *      protocol (its generation and lease owner untouched, not taken over, not handed a second time),
 *      one still inside its lease, one waiting its turn on the runner's local lock (handed out once
 *      the job holding the lock is done), and a legacy claim that reported and may still be in a long
 *      step (a new process's takeover is still what ends that one).
 *  (4) Handing a claim out again takes the claim's own steps: a stop asked for while the claim was
 *      live goes with it and is answered CANCELLED, and a claim whose checkout is gone is ended as
 *      unworkable instead of handed out.
 *
 * Not destructive: every case owns freshly generated ids and reads only its own projects.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const sha = (nibble: string) => nibble.repeat(40);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const UPSTREAM_TIP = sha('9');

/** What runner 0.1.232 declared, the process of 2026-10-19: integration jobs, and no v2 reports. */
const LEGACY = [INTEGRATION_JOB_CLAIM, PROMOTION_AUTOMATIC_LAND];
/** What every runner since 0.1.234 declares. */
const V2 = [INTEGRATION_JOB_CLAIM, INTEGRATION_PROGRESS_V2, PROMOTION_AUTOMATIC_LAND];

const GREEN_CHECK: IntegrationCheckResult = {
  name: 'MERGE_CHECK',
  command: 'npm test',
  expectedExitCode: 0,
  exitCode: 0,
  timedOut: false,
  durationMs: 1_200,
  outputTail: 'ok\n',
};

type Answer = Omit<IntegrationJobResultRequest, 'claimGeneration' | 'leaseOwner'>;

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  jobs: IntegrationJobRelay;
  promotions: ProjectPromotionService;
  tasks: TasksService;
}

async function connect(): Promise<Stack> {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    prisma,
    jobs: new IntegrationJobRelay(prisma, new ProjectOpenItemService(prisma, sessions)),
    promotions: new ProjectPromotionService(prisma),
    tasks: new TasksService(prisma as never, {} as never, {
      publishTaskChanged() {},
      publishForUser() {},
    } as never),
  };
}

/** One runner and the workspace of its checkout, under one owner: what every project below runs from. */
interface Machine {
  label: string;
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function machine(stack: Stack, label: string): Promise<Machine> {
  const db = stack.db;
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@lost-claim.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true,
      repoUrl: `https://git.invalid/${label}-${randomUUID().slice(0, 8)}.git`, workDir: `/srv/${label}`,
    },
  });
  return { label, ownerId, runnerId, workspaceId };
}

/**
 * The machine's runner row as one live process's heartbeats leave it: beating now, under that
 * process's lease, declaring what it declares — the runner of 2026-10-19, whose
 * `heartbeat_lease_owner` was the stuck claim's `claim_lease_owner` the whole time.
 */
async function beating(stack: Stack, m: Machine, leaseOwner: string, capabilities: string[]): Promise<void> {
  await stack.db.runner.update({
    where: { id: m.runnerId },
    data: {
      heartbeatLeaseOwner: leaseOwner, heartbeatDraining: false, capabilities,
      capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
}

/**
 * A project coordinated from the machine's workspace. Every project of one machine is therefore in
 * one repository, and their landings into main take one serial key (J1) — as the projects of
 * 2026-10-19, which all ran from the HPC runner's one checkout, did.
 */
async function project(stack: Stack, m: Machine, label: string, line: 'MAIN' | 'PROJECT_BRANCH'): Promise<string> {
  const projectId = randomUUID();
  await stack.db.project.create({
    data: { id: projectId, ownerId: m.ownerId, title: `${label} project`, coordinatorWorkspaceId: m.workspaceId },
  });
  await stack.db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await stack.db.$transaction((tx) => configureProjectIntegration(tx, {
    ownerId: m.ownerId, projectId, settings: { line },
  }));
  return projectId;
}

/**
 * A DONE task whose branch is handed to the line, as its DONE would (J-T1a / M-F2). Its work
 * session finished two days ago, before any claim this file moves back in time: a result judged
 * against a claim made while the work could still move would be J-T1e's "too early" instead.
 */
async function doneTask(stack: Stack, m: Machine, projectId: string, label: string): Promise<string> {
  const title = `${label} ${randomUUID().slice(0, 8)}`;
  const created = await stack.tasks.create(m.ownerId, {
    title,
    projectId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
  } as never);
  const settled = await stack.db.$executeRawUnsafe(
    `UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid AND "status" IN ('OPEN', 'IN_PROGRESS')`,
    created.id,
  );
  assert.equal(settled, 1, 'the task could not be marked DONE');
  const branch = `orbit/${label}-${randomUUID().slice(0, 8)}`;
  await stack.db.session.create({
    data: {
      ownerId: m.ownerId, creatorId: m.ownerId, taskId: created.id, workspaceId: m.workspaceId,
      assignedRunnerId: m.runnerId, title, prompt: title, branch, isolationStatus: 'worktree',
      baseSha: sha('b'), status: RunStatus.SUCCEEDED, startsTaskWork: true,
      createdAt: new Date(Date.now() - 49 * HOUR), finishedAt: new Date(Date.now() - 48 * HOUR),
      worktreeBranch: branch, worktreeDirty: false,
      changedFiles: [{ path: 'src/the-work.ts' }] as never,
    },
  });
  const queued = await stack.db.$transaction((tx) => enqueueForDoneTask(tx, m.ownerId, created.id));
  assert.ok(queued.enqueued, `the DONE queued nothing: ${JSON.stringify(queued)}`);
  return created.id;
}

/** One heartbeat of one runner process asking for work: what it is handed. */
function beat(
  stack: Stack,
  m: Machine,
  leaseOwner: string,
  capabilities: string[],
  draining = false,
): Promise<IntegrationJobCommand[]> {
  return stack.jobs.dispatch({ runnerId: m.runnerId, leaseOwner, draining, capabilities });
}

/** The one job a beat hands out, which has to be the one named. */
async function onlyHanded(stack: Stack, m: Machine, leaseOwner: string, capabilities: string[], jobId: string, what: string) {
  const handed = await beat(stack, m, leaseOwner, capabilities);
  assert.deepEqual(handed.map((job) => job.jobId), [jobId], what);
  return handed[0]!;
}

/** A result, over the door the runner posts it on, under the claim the command named. */
async function report(stack: Stack, m: Machine, job: IntegrationJobCommand, answer: Answer) {
  const { answer: taken } = await stack.jobs.applyResult(job.jobId, m.runnerId, {
    claimGeneration: job.claimGeneration,
    leaseOwner: job.leaseOwner,
    ...answer,
  });
  assert.equal(taken.accepted, true, `the result was refused: ${JSON.stringify(taken)}`);
}

/** A progress report under the claim the command named — the runner saying it is on the job. */
function progress(stack: Stack, m: Machine, job: IntegrationJobCommand, phase: 'FETCH' | 'CHECK') {
  return receiveIntegrationJobProgress(stack.prisma, m.runnerId, job.jobId, {
    claimGeneration: job.claimGeneration, leaseOwner: job.leaseOwner, phase,
  });
}

function jobRow(stack: Stack, jobId: string) {
  return stack.db.projectIntegrationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: {
      state: true, kind: true, phase: true, progressProtocol: true, claimGeneration: true,
      claimLeaseOwner: true, claimedAt: true, heartbeatAt: true, stepStartedAt: true, startedAt: true,
      cancelRequestedAt: true, errorCode: true,
    },
  });
}

/**
 * The claim's clock moved back: claimed `claimedMsAgo` ago and last heard from `heardMsAgo` ago. One
 * statement, so a claim never heard from (`heardMsAgo` = `claimedMsAgo`) has heartbeat_at equal to
 * claimed_at to the microsecond, as the claim statement leaves it.
 */
async function age(stack: Stack, jobId: string, claimedMsAgo: number, heardMsAgo = claimedMsAgo): Promise<void> {
  await stack.db.$executeRaw(Prisma.sql`
    UPDATE "project_integration_job"
       SET "claimed_at" = now() - (${claimedMsAgo}::int * interval '1 millisecond'),
           "started_at" = now() - (${claimedMsAgo}::int * interval '1 millisecond'),
           "heartbeat_at" = now() - (${heardMsAgo}::int * interval '1 millisecond'),
           "step_started_at" = now() - (${heardMsAgo}::int * interval '1 millisecond')
     WHERE "id" = ${jobId}::uuid`);
}

/** How §7.2 V6 reads one in-flight job right now: the page's `inFlightJobs` entry. */
async function inFlight(stack: Stack, projectId: string, jobId: string) {
  const [job] = await readInFlightJobs(stack.prisma, projectId, jobId);
  assert.ok(job, 'the job is in flight');
  return job;
}

/** A check that found the candidate merging cleanly onto main. */
const CLEAN = (sourceSha: string, testedSha: string, treeSha: string): Answer => ({
  state: 'READY', phase: 'CHECK', sourceSha, targetShaBefore: UPSTREAM_TIP, upstreamSha: UPSTREAM_TIP,
  testedSha, testedTreeSha: treeSha, aheadOfUpstream: 1, filesChanged: 1, checks: [GREEN_CHECK],
});

/** The candidate a MAIN-line project's DONE offered, and its CHECK_PROMOTION. */
async function candidateOf(stack: Stack, projectId: string) {
  const candidate = await stack.db.projectPromotion.findFirstOrThrow({
    where: { projectId, sourceKind: 'TASK_BRANCH' },
    orderBy: { createdAt: 'desc' },
  });
  const check = await stack.db.projectIntegrationJob.findFirstOrThrow({
    where: { promotionId: candidate.id, kind: 'CHECK_PROMOTION' },
    select: { id: true },
  });
  return { candidateId: candidate.id, checkId: check.id };
}

/** The LAND_PROMOTION the owner's confirmation of a candidate queued. */
async function landingOf(stack: Stack, candidateId: string): Promise<string> {
  const job = await stack.db.projectIntegrationJob.findFirstOrThrow({
    where: { promotionId: candidateId, kind: 'LAND_PROMOTION' },
    select: { id: true, state: true },
  });
  assert.equal(job.state, 'QUEUED', 'the confirmation queued the landing');
  return job.id;
}

test('a live process that lost the command of a claim it holds is handed it again', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = await connect();
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('(1) the 10-19 case: a LAND_PROMOTION its own process never started is handed to it again, and the promotion behind it lands next', async () => {
    const m = await machine(stack, 'lost-land-promotion');
    const stuck = await project(stack, m, 'stuck', 'MAIN');
    const behind = await project(stack, m, 'behind', 'MAIN');
    // The one process of 2026-10-19, which beats on through all of this: a legacy runner.
    const lease = randomUUID();
    await beating(stack, m, lease, LEGACY);

    // Two projects' candidates, checked clean and confirmed by the owner: two landings into main.
    await doneTask(stack, m, stuck, 'stuck');
    await doneTask(stack, m, behind, 'behind');
    const first = await candidateOf(stack, stuck);
    const second = await candidateOf(stack, behind);
    const checks = await beat(stack, m, lease, LEGACY);
    assert.deepEqual(checks.map((job) => job.jobId).sort(), [first.checkId, second.checkId].sort(),
      'one beat claims both candidates\' checks, which take serial keys of their own');
    await report(stack, m, checks.find((job) => job.jobId === first.checkId)!, CLEAN(sha('a'), sha('4'), sha('5')));
    await report(stack, m, checks.find((job) => job.jobId === second.checkId)!, CLEAN(sha('c'), sha('7'), sha('8')));
    await stack.promotions.confirm({ userId: m.ownerId }, stuck, first.candidateId, sha('a'));
    await stack.promotions.confirm({ userId: m.ownerId }, behind, second.candidateId, sha('c'));
    const stuckLanding = await landingOf(stack, first.candidateId);
    const behindLanding = await landingOf(stack, second.candidateId);

    // The process claims the first landing. The answer that carries the command is lost on its way:
    // the runner never starts the job, and the second landing waits on main's serial slot (J1).
    const lost = await onlyHanded(stack, m, lease, LEGACY, stuckLanding,
      'the beat claims the older landing, and only that one: the other shares its serial key');
    assert.equal(lost.kind, 'LAND_PROMOTION');
    assert.equal(lost.reportBeforePush, undefined, 'a legacy claim, as 0.1.232\'s was');
    await age(stack, stuckLanding, 31 * HOUR);

    const held = await jobRow(stack, stuckLanding);
    assert.equal(held.state, 'RUNNING');
    assert.equal(held.claimLeaseOwner, lease, 'held by the very process that is still beating');
    const runner = await stack.db.runner.findUniqueOrThrow({
      where: { id: m.runnerId }, select: { heartbeatLeaseOwner: true },
    });
    assert.equal(runner.heartbeatLeaseOwner, held.claimLeaseOwner, 'the runner\'s live lease is the claim\'s');
    assert.equal(held.claimGeneration, 1n);
    assert.equal(held.phase, 'FETCH', 'no phase reported since the claim');
    assert.equal(held.progressProtocol, null);
    assert.equal(held.heartbeatAt?.getTime(), held.claimedAt?.getTime(), 'heartbeat_at = claimed_at');
    assert.ok(Date.now() - held.claimedAt!.getTime() > 30 * HOUR, 'claimed 31 hours ago');
    assert.equal((await inFlight(stack, stuck, stuckLanding)).timedOut, true, 'V6 reads the claim LEASE_EXPIRED');
    const waiting = await inFlight(stack, behind, behindLanding);
    assert.equal(waiting.state, 'QUEUED');
    assert.equal(waiting.blockingReason?.code, 'WAITING_SERIAL_SLOT');
    assert.equal(waiting.blockingReason?.jobId, stuckLanding, 'behind the landing nobody is running');

    // A draining process is handed nothing, its own claims included: it is about to stop, and the
    // process after it takes the job over (J-T3).
    assert.deepEqual(await beat(stack, m, lease, LEGACY, true), []);

    // The same live process's next beat. Before J-T3a it was handed nothing, for 31 hours.
    const again = await onlyHanded(stack, m, lease, LEGACY, stuckLanding,
      'the process is handed the claim it holds and never started — and not the landing behind it');
    assert.deepEqual(again, lost, 'the very command the claim was: same claim generation, same lease owner');
    assert.deepEqual(await jobRow(stack, stuckLanding), held, 'and nothing about the row moved: no new claim, no renewal');
    assert.equal((await inFlight(stack, stuck, stuckLanding)).timedOut, true,
      'the silence is still the silence: V6, X-E5 and the abandon door read the claim as before');
    assert.equal((await jobRow(stack, behindLanding)).state, 'QUEUED');

    // At least once: every beat hands it again until the claim is heard from. The runner starts a
    // job it is not running and skips one it is (`integratingNow`), so a repeat costs nothing.
    assert.deepEqual(await onlyHanded(stack, m, lease, LEGACY, stuckLanding, 'the next beat hands it again'), lost);

    // The runner starts it: its report and its result are taken under the claim it was made under.
    assert.deepEqual(await progress(stack, m, again, 'FETCH'), { accepted: true, cancelRequested: false });
    assert.deepEqual(await beat(stack, m, lease, LEGACY), [],
      'heard from, the claim is not handed again, and main\'s slot is still the job\'s');
    await report(stack, m, again, {
      state: 'LANDED', phase: 'VERIFY', sourceSha: sha('a'), targetShaBefore: UPSTREAM_TIP,
      upstreamSha: UPSTREAM_TIP, testedSha: sha('4'), testedTreeSha: sha('5'),
      landedSha: sha('6'), landedTreeSha: sha('5'), aheadOfUpstream: 1, filesChanged: 1,
      checks: [GREEN_CHECK],
    });
    const landed = await jobRow(stack, stuckLanding);
    assert.equal(landed.state, 'LANDED');
    assert.equal(landed.claimGeneration, 1n, 'under claim 1: nothing was taken over');
    const merged = await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: first.candidateId } });
    assert.equal(merged.state, 'MERGED');

    // And the queue moves: the next beat of the same process claims the landing that waited.
    const next = await onlyHanded(stack, m, lease, LEGACY, behindLanding,
      'the promotion queued behind it is dispatched');
    assert.equal(next.kind, 'LAND_PROMOTION');
    assert.equal(next.claimGeneration, '1');
    const claimed = await jobRow(stack, behindLanding);
    assert.equal(claimed.state, 'RUNNING');
    assert.equal(claimed.claimLeaseOwner, lease);
  });

  await t.test('(2) a v2 claim that went silent past the lease is handed again, still asked for the PUSH report', async () => {
    const m = await machine(stack, 'silent-v2');
    const line = await project(stack, m, 'silent-v2', 'PROJECT_BRANCH');
    await doneTask(stack, m, line, 'silent-v2');
    const lease = randomUUID();
    const [claimed] = await beat(stack, m, lease, V2);
    assert.ok(claimed, 'the landing was claimed');
    assert.equal(claimed.kind, 'LAND_TASK');
    assert.equal(claimed.reportBeforePush, true);
    assert.deepEqual(await progress(stack, m, claimed, 'CHECK'), { accepted: true, cancelRequested: false });
    // It reported, then nothing for eleven minutes: the lease of a v2 claim, which reports every 30 s.
    await age(stack, claimed.jobId, 15 * MINUTE, 11 * MINUTE);
    const silent = await jobRow(stack, claimed.jobId);
    assert.ok(silent.heartbeatAt!.getTime() > silent.claimedAt!.getTime(), 'it was heard from once');
    assert.equal((await inFlight(stack, line, claimed.jobId)).liveness, 'LEASE_EXPIRED');

    const again = await onlyHanded(stack, m, lease, V2, claimed.jobId, 'the silent v2 claim is handed again');
    assert.deepEqual(again, claimed, 'the same command, reportBeforePush included');
    assert.deepEqual(await jobRow(stack, claimed.jobId), silent, 'and the row did not move');
    assert.deepEqual(await progress(stack, m, again, 'CHECK'), { accepted: true, cancelRequested: false });
    assert.equal((await inFlight(stack, line, claimed.jobId)).liveness, 'LIVE');
    assert.deepEqual(await beat(stack, m, lease, V2), [], 'heard from again, it is not handed out any more');
  });

  await t.test('(3) a claim that may really be running is not handed to its process a second time', async () => {
    /** A PROJECT_BRANCH project on a machine of its own, whose one landing the process `lease` has claimed. */
    const heldLanding = async (label: string, capabilities: string[]) => {
      const m = await machine(stack, label);
      const line = await project(stack, m, label, 'PROJECT_BRANCH');
      await doneTask(stack, m, line, label);
      const lease = randomUUID();
      const [claimed] = await beat(stack, m, lease, capabilities);
      assert.ok(claimed, `${label}: the landing was claimed`);
      return { m, line, lease, claimed };
    };

    // (a) The counter-example to (1): the same process, a claim it reports on, on time — claimed 40
    //     minutes ago, its last report 20 seconds ago — under either protocol.
    for (const [protocol, capabilities] of [['v2', V2], ['legacy', LEGACY]] as const) {
      const onTime = await heldLanding(`on-time-${protocol}`, [...capabilities]);
      assert.deepEqual(await progress(stack, onTime.m, onTime.claimed, 'CHECK'), { accepted: true, cancelRequested: false });
      await age(stack, onTime.claimed.jobId, 40 * MINUTE, 20_000);
      const reporting = await jobRow(stack, onTime.claimed.jobId);
      for (const n of [1, 2]) {
        assert.deepEqual(await beat(stack, onTime.m, onTime.lease, [...capabilities]), [],
          `${protocol}, beat ${n}: a claim reporting on time is not handed to its process a second time`);
      }
      assert.deepEqual(await beat(stack, onTime.m, randomUUID(), [...capabilities]), [],
        `${protocol}: nor taken over by another process — its lease is live`);
      assert.deepEqual(await jobRow(stack, onTime.claimed.jobId), reporting,
        `${protocol}: its claim generation, its lease owner and its lease are as they were`);
      assert.deepEqual(await progress(stack, onTime.m, onTime.claimed, 'CHECK'), { accepted: true, cancelRequested: false },
        `${protocol}: and the job it is running still reports under its own claim`);
    }

    // (b) Never heard from, but still inside the lease: the runner may simply not have reported yet.
    const fresh = await heldLanding('inside-lease', LEGACY);
    await age(stack, fresh.claimed.jobId, 2 * MINUTE);
    assert.deepEqual(await beat(stack, fresh.m, fresh.lease, LEGACY), [], 'a claim inside its lease is not handed again');

    // (c) A legacy claim that reported FETCH twelve minutes ago. V6 calls that lease-expired, but a
    //     legacy runner may be in a long fetch — it reports only when a step starts — and it reads no
    //     answer, so a second run racing the end of that step could push. It is not handed again;
    //     what still ends it is a new process's takeover, as before.
    const longStep = await heldLanding('long-legacy-step', LEGACY);
    assert.deepEqual(await progress(stack, longStep.m, longStep.claimed, 'FETCH'), { accepted: true, cancelRequested: false });
    await age(stack, longStep.claimed.jobId, 15 * MINUTE, 12 * MINUTE);
    assert.equal((await inFlight(stack, longStep.line, longStep.claimed.jobId)).timedOut, true);
    assert.deepEqual(await beat(stack, longStep.m, longStep.lease, LEGACY), [],
      'a legacy claim that was heard from is not handed again');
    assert.equal((await jobRow(stack, longStep.claimed.jobId)).claimGeneration, 1n);
    const restarted = randomUUID();
    const [takenOver] = await beat(stack, longStep.m, restarted, LEGACY);
    assert.equal(takenOver?.jobId, longStep.claimed.jobId, 'the next process takes it over (J-T3)');
    assert.equal(takenOver?.claimGeneration, '2');
    assert.equal((await jobRow(stack, longStep.claimed.jobId)).claimLeaseOwner, restarted);

    // (d) Never heard from and past the lease, but queued behind an older job of the same runner,
    //     repository and ref: that is V6's local-lock rule, so the claim is waiting, not silent. Once
    //     the older job is done the claim is handed again.
    const m = await machine(stack, 'local-lock');
    const ahead = await project(stack, m, 'ahead', 'MAIN');
    const queuedBehind = await project(stack, m, 'queued-behind', 'MAIN');
    const lease = randomUUID();
    await doneTask(stack, m, ahead, 'ahead');
    await doneTask(stack, m, queuedBehind, 'queued-behind');
    const aheadCandidate = await candidateOf(stack, ahead);
    const behindCandidate = await candidateOf(stack, queuedBehind);
    const checks = await beat(stack, m, lease, LEGACY);
    const aheadCheck = checks.find((job) => job.jobId === aheadCandidate.checkId)!;
    const behindCheck = checks.find((job) => job.jobId === behindCandidate.checkId)!;
    assert.ok(aheadCheck && behindCheck, 'both checks were claimed');
    await report(stack, m, behindCheck, CLEAN(sha('c'), sha('7'), sha('8')));
    await stack.promotions.confirm({ userId: m.ownerId }, queuedBehind, behindCandidate.candidateId, sha('c'));
    const landing = await landingOf(stack, behindCandidate.candidateId);
    const lost = await onlyHanded(stack, m, lease, LEGACY, landing, 'the landing is claimed while the other check runs');
    // The check on main, claimed first, holds the runner's lock on refs/heads/main and keeps reporting.
    await age(stack, aheadCheck.jobId, 20 * MINUTE, 10_000);
    await age(stack, landing, 12 * MINUTE);
    assert.equal((await inFlight(stack, queuedBehind, landing)).timedOut, false, 'V6: queueing on the local lock');
    assert.deepEqual(await beat(stack, m, lease, LEGACY), [], 'a claim waiting its turn is not handed again');
    await report(stack, m, aheadCheck, CLEAN(sha('a'), sha('4'), sha('5')));
    assert.equal((await inFlight(stack, queuedBehind, landing)).timedOut, true);
    assert.deepEqual(await onlyHanded(stack, m, lease, LEGACY, landing,
      'with the lock free and still no word, it is handed again'), lost);
  });

  await t.test('(4) handing a claim out again takes the claim\'s own steps', async () => {
    // (a) The owner pressed Cancel while the landing was live: J-T8 writes the stop request and
    //     leaves the job to answer it. Handed again, the command carries it, and the runner's
    //     CANCELLED settles the promotion (J-T12, M-T10).
    const m = await machine(stack, 'cancel-on-hand-out');
    const main = await project(stack, m, 'cancel-on-hand-out', 'MAIN');
    const lease = randomUUID();
    await doneTask(stack, m, main, 'cancel-on-hand-out');
    const offered = await candidateOf(stack, main);
    const [check] = await beat(stack, m, lease, V2);
    assert.equal(check?.jobId, offered.checkId);
    await report(stack, m, check!, CLEAN(sha('a'), sha('4'), sha('5')));
    await stack.promotions.confirm({ userId: m.ownerId }, main, offered.candidateId, sha('a'));
    const landing = await landingOf(stack, offered.candidateId);
    const claimed = await onlyHanded(stack, m, lease, V2, landing, 'the landing is claimed');
    assert.deepEqual(await progress(stack, m, claimed, 'CHECK'), { accepted: true, cancelRequested: false });
    const cancelling = await stack.promotions.cancel({ userId: m.ownerId }, main, offered.candidateId);
    assert.equal(cancelling.cancelRequested, true, 'a live landing is asked, not ended');
    await age(stack, landing, 20 * MINUTE, 11 * MINUTE);
    const asked = await onlyHanded(stack, m, lease, V2, landing, 'the silent claim is handed again');
    assert.equal(asked.cancelRequested, true, 'carrying the stop asked for while it was live');
    assert.equal(asked.claimGeneration, claimed.claimGeneration);
    await report(stack, m, asked, { state: 'CANCELLED', phase: 'CHECK' });
    assert.equal((await stack.db.projectPromotion.findUniqueOrThrow({ where: { id: offered.candidateId } })).state,
      'CANCELLED');

    // (b) The checkout went away after the claim: there is nothing to hand out any more, and the
    //     claim is ended as the claim would have been (INTEGRATION_REPOSITORY_UNKNOWN) — once, by
    //     the beat that found it, rather than handed to a runner that cannot act on it.
    const gone = await machine(stack, 'checkout-gone');
    const line = await project(stack, gone, 'checkout-gone', 'PROJECT_BRANCH');
    await doneTask(stack, gone, line, 'checkout-gone');
    const holder = randomUUID();
    const [held] = await beat(stack, gone, holder, LEGACY);
    assert.ok(held, 'the landing was claimed');
    await age(stack, held.jobId, 11 * MINUTE);
    await stack.db.workspace.update({ where: { id: gone.workspaceId }, data: { workDir: null } });
    assert.deepEqual(await beat(stack, gone, holder, LEGACY), [], 'nothing to work in: nothing handed out');
    const ended = await jobRow(stack, held.jobId);
    assert.equal(ended.state, 'ERROR');
    assert.equal(ended.errorCode, 'INTEGRATION_REPOSITORY_UNKNOWN');
    assert.deepEqual(await beat(stack, gone, holder, LEGACY), [], 'and it is ended once');
  });
});
