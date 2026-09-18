import { Prisma, TaskStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { startOnFirstIntegration } from './project-integration-line';

/**
 * Integration jobs: the platform's own git work (`docs/project-integration-line-contract.md` §2).
 *
 * This module is the part with no I/O of its own — the closed sets migration 0281 spells as CHECK
 * constraints, the two keys that make the queue serial and idempotent, and the small decisions a
 * reader has to be able to re-derive (which states are final, which end in a landing, which
 * exception kind a failure opens). Everything that touches the database is
 * `project-integration-job.service.ts`, and everything that touches a repository is
 * `src/runner-go/integrate.go`.
 *
 * The sets are written out rather than derived from Prisma enums because the columns are `text`: a
 * new state is a migration, not a deploy that starts writing a value the database has never seen.
 */

/** What a job is putting where (§2.1). Only LAND_TASK has a producer today; promotions are §3. */
export const INTEGRATION_JOB_KINDS = ['LAND_TASK', 'CHECK_PROMOTION', 'LAND_PROMOTION'] as const;
export type IntegrationJobKind = (typeof INTEGRATION_JOB_KINDS)[number];

/**
 * Where a job is. `READY` is a promotion check that passed and is waiting for the owner; the three
 * failures are distinguished because they open different exception items and read differently to a
 * person: a conflict is about the code, a check failure is about the tests, an error is about the
 * machinery.
 */
export const INTEGRATION_JOB_STATES = [
  'QUEUED',
  'RUNNING',
  'LANDED',
  'ALREADY_LANDED',
  'READY',
  'CONFLICT',
  'CHECK_FAILED',
  'ERROR',
  'CANCELLED',
  'SUPERSEDED',
] as const;
export type IntegrationJobState = (typeof INTEGRATION_JOB_STATES)[number];

/** The step a job is on, or the one it stopped at (§2.4). */
export const INTEGRATION_JOB_PHASES = [
  'FETCH',
  'MAIN_SYNC',
  'REBASE',
  'MERGE',
  'CHECK',
  'VERIFY',
  'PUSH',
] as const;
export type IntegrationJobPhase = (typeof INTEGRATION_JOB_PHASES)[number];

/** Why a job ended in ERROR (J12). Conflicts and failed checks are states, not error codes. */
export const INTEGRATION_ERROR_CODES = [
  'FETCH_FAILED',
  'SOURCE_BRANCH_MISSING',
  'BASE_REF_NOT_FOUND',
  'TARGET_MOVED',
  'PUSH_REJECTED',
  'CHECK_MUTATED_TREE',
  'LANDED_TREE_MISMATCH',
  'PROMOTION_TREE_NONDETERMINISTIC',
  'RUNNER_DRAINING',
  'INTEGRATION_REPOSITORY_UNKNOWN',
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

/** A job the runner is not going to touch again. */
const TERMINAL_STATES: ReadonlySet<string> = new Set<IntegrationJobState>([
  'LANDED', 'ALREADY_LANDED', 'READY', 'CONFLICT', 'CHECK_FAILED', 'ERROR', 'CANCELLED', 'SUPERSEDED',
]);

export function isTerminalJobState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

/** The two states a receipt is written for (§2.5 J8). */
export function jobLanded(state: string): state is 'LANDED' | 'ALREADY_LANDED' {
  return state === 'LANDED' || state === 'ALREADY_LANDED';
}

/**
 * Which exception item a finished job opens (§2.6, §4.2). Returns null for the states nobody has to
 * act on: a landing, a promotion waiting for its own approval item, and the two ways a job is taken
 * out of the queue by something that already has somebody's attention.
 */
export function openItemKindForJobState(
  state: string,
): 'INTEGRATION_CONFLICT' | 'INTEGRATION_CHECK_FAILED' | 'INTEGRATION_ERROR' | null {
  switch (state) {
    case 'CONFLICT': return 'INTEGRATION_CONFLICT';
    case 'CHECK_FAILED': return 'INTEGRATION_CHECK_FAILED';
    case 'ERROR': return 'INTEGRATION_ERROR';
    default: return null;
  }
}

/** The checks the runner ran, as it reports them back. `outputTail` is clipped by the runner. */
export interface IntegrationCheckResult {
  name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK';
  command: string;
  expectedExitCode: number;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

/** The check the runner is told to run (§2.3 `IntegrationJobCommand`). */
export interface IntegrationCheckSpec {
  name: 'TASK_ACCEPTANCE' | 'MERGE_CHECK';
  command: string;
  expectedExitCode: number;
  timeoutSeconds: number;
}

/**
 * The budget a check with no declared one gets: the same hour an EXECUTABLE acceptance command gets
 * when its task declares no `acceptanceTimeoutSeconds`.
 */
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 3_600;

/**
 * How long a claimed job may go without a heartbeat before another runner may take it (J-T3). Ten
 * minutes is long enough for a slow check to be mid-command and short enough that a runner that
 * died does not hold a repository's serial slot for an afternoon.
 */
export const INTEGRATION_CLAIM_STALE_MS = 10 * 60 * 1_000;

/** How many jobs one runner is handed per heartbeat (J-T2's dispatch). */
export const INTEGRATION_JOBS_PER_HEARTBEAT = 2;

/** The capability a runner declares before it is handed any of this (J-T2). */
export const INTEGRATION_JOB_CLAIM = 'integration-job/v1';

/** Longest check output an item and a job row carry, per §2.1 (`outputTail` ≤ 16 KB). */
export const MAX_CHECK_OUTPUT_TAIL = 16 * 1_024;

/**
 * J1's serial key: the repository and the ref being written, so that two PROJECTS landing into the
 * same branch of the same repository are serialised against each other and not merely two tasks of
 * one project. A promotion's own check runs against no ref and takes a key of its own rather than
 * occupying main's slot while it runs.
 */
export function integrationSerialKey(input: {
  kind: IntegrationJobKind;
  canonicalRepoUrl: string;
  targetRef: string;
  projectId: string;
}): string {
  return input.kind === 'CHECK_PROMOTION'
    ? `${input.canonicalRepoUrl}#check:${input.projectId}`
    : `${input.canonicalRepoUrl}#${input.targetRef}`;
}

/**
 * The key that makes enqueue idempotent on the FACT rather than on the request (§2.1). A task's
 * first landing is generation 1 forever; asking for another is asking for generation 2.
 */
export function integrationIdempotencyKey(input: {
  kind: IntegrationJobKind;
  subjectId: string;
  generation: number;
}): string {
  return `ij:v1:${input.kind}:${input.subjectId}:${input.generation}`;
}

/** `refs/heads/x` → `x`, which is how a receipt spells a branch (the runner reports short names). */
export function shortBranchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** The columns every reader of a job needs. Kept here so the service and the read model agree. */
export const INTEGRATION_JOB_COLUMNS = {
  id: true,
  projectId: true,
  ownerId: true,
  codebaseId: true,
  kind: true,
  generation: true,
  taskId: true,
  sessionId: true,
  serialKey: true,
  targetRef: true,
  upstreamRef: true,
  sourceRef: true,
  state: true,
  phase: true,
  runnerId: true,
  claimGeneration: true,
  claimLeaseOwner: true,
  claimedAt: true,
  heartbeatAt: true,
  cancelRequestedAt: true,
  sourceSha: true,
  targetShaBefore: true,
  upstreamSha: true,
  mainSyncSha: true,
  testedSha: true,
  testedTreeSha: true,
  landedSha: true,
  landedTreeSha: true,
  aheadOfUpstream: true,
  checks: true,
  conflicts: true,
  errorCode: true,
  errorDetail: true,
  receiptIds: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} as const;

export type IntegrationJobRow = Prisma.ProjectIntegrationJobGetPayload<{
  select: typeof INTEGRATION_JOB_COLUMNS;
}>;

/** What a person is told an integration is doing right now (§2.7, read by the project page). */
export interface IntegrationJobView {
  id: string;
  kind: IntegrationJobKind;
  generation: number;
  taskId: string | null;
  state: IntegrationJobState;
  phase: IntegrationJobPhase | null;
  targetRef: string;
  sourceRef: string;
  sourceSha: string | null;
  testedSha: string | null;
  testedTreeSha: string | null;
  landedSha: string | null;
  landedTreeSha: string | null;
  aheadOfUpstream: number | null;
  checks: IntegrationCheckResult[];
  conflicts: string[];
  errorCode: IntegrationErrorCode | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export function integrationJobView(row: IntegrationJobRow): IntegrationJobView {
  return {
    id: row.id,
    kind: row.kind as IntegrationJobKind,
    generation: row.generation,
    taskId: row.taskId,
    state: row.state as IntegrationJobState,
    phase: (row.phase ?? null) as IntegrationJobPhase | null,
    targetRef: row.targetRef,
    sourceRef: row.sourceRef,
    sourceSha: row.sourceSha,
    testedSha: row.testedSha,
    testedTreeSha: row.testedTreeSha,
    landedSha: row.landedSha,
    landedTreeSha: row.landedTreeSha,
    aheadOfUpstream: row.aheadOfUpstream,
    checks: Array.isArray(row.checks) ? (row.checks as unknown as IntegrationCheckResult[]) : [],
    conflicts: row.conflicts,
    errorCode: (row.errorCode ?? null) as IntegrationErrorCode | null,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/**
 * The title an exception item about this job carries (§4.2). Built from the job and the task's own
 * title, both of which are immutable by the time an item is opened, so a replay reads the same.
 */
export function integrationItemTitle(state: string, kind: string, taskTitle: string): string {
  // A promotion's failure is not about one task — it is about the branch the owner was going to be
  // asked to merge — so it is named after that rather than after whichever task landed last.
  const subject = kind === 'LAND_TASK' ? taskTitle : 'merging the project branch into main';
  switch (state) {
    case 'CONFLICT': return `Merge conflict: ${subject}`;
    case 'CHECK_FAILED': return `Checks failed on the combined tree: ${subject}`;
    default: return `Integration error: ${subject}`;
  }
}

/** `IC:`/`ICF:`/`IE:` + the job, per §4.2: one failed job is one item however often it is replayed. */
export function integrationDedupeKey(state: string, jobId: string): string {
  switch (state) {
    case 'CONFLICT': return `IC:${jobId}`;
    case 'CHECK_FAILED': return `ICF:${jobId}`;
    default: return `IE:${jobId}`;
  }
}

// ── enqueue (J-T1a) ───────────────────────────────────────────────────────────────────────────

/** What `enqueueForDoneTask` did, so the caller knows whether it owes an exception item. */
export type EnqueueOutcome =
  | { enqueued: true; jobId: string; projectId: string; alsoQueuedTaskIds: string[] }
  | {
      enqueued: false;
      /**
       * NOT_A_CODE_TASK — nothing to integrate, and the ordinary answer for most DONE writes.
       * ALREADY_QUEUED — J3's index already holds a landing for this task.
       * PROMOTION_REQUIRED — a MAIN-line project: the next step is an owner-confirmed promotion (§3),
       *   not a job this module queues.
       * INTEGRATION_REPOSITORY_UNKNOWN — the caller opens an INTEGRATION_ERROR item (§4.2).
       */
      reason: 'NOT_A_CODE_TASK' | 'ALREADY_QUEUED' | 'PROMOTION_REQUIRED' | 'INTEGRATION_REPOSITORY_UNKNOWN';
      projectId: string | null;
    };

/** The columns a landing needs from the task's own work session. */
const WORK_SESSION_SELECT = {
  id: true,
  branch: true,
  isolationStatus: true,
  assignedRunnerId: true,
} as const;

/**
 * Queue this task's branch onto its project's integration line, in the transaction that wrote DONE
 * (§2.3 J-T1a).
 *
 * Does nothing for work that has no branch: a codeless task, a task in no project, a task whose
 * latest work session never took a worktree. Those are the majority of DONE writes, and the check is
 * three columns rather than an inference from the title.
 *
 * Starting the line is part of THIS transaction (L3): a project that had not decided where its work
 * lands decides it here, once, and the same transaction back-queues the project's other finished
 * code tasks — without that, they would have landed nowhere and their dependents would wait on J9
 * for a landing that was never going to be queued.
 */
export async function enqueueForDoneTask(
  tx: Prisma.TransactionClient,
  ownerId: string,
  taskId: string,
): Promise<EnqueueOutcome> {
  const task = await tx.task.findFirst({
    where: { id: taskId, ownerId },
    select: {
      projectId: true,
      codeless: true,
      sessions: {
        where: { startsTaskWork: true, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: WORK_SESSION_SELECT,
      },
    },
  });
  const work = task?.sessions[0];
  if (!task?.projectId || task.codeless || work?.isolationStatus !== 'worktree' || !work.branch) {
    return { enqueued: false, reason: 'NOT_A_CODE_TASK', projectId: task?.projectId ?? null };
  }
  const projectId = task.projectId;

  const first = await startOnFirstIntegration(tx, { ownerId, projectId, taskId });
  if (!first.started) {
    return { enqueued: false, reason: first.refusal, projectId };
  }
  // A MAIN-line project does not land a task on a branch of its own: what comes next is a promotion
  // the owner confirms (§3.4 M-F2, owner decision 2), which is not this module's queue.
  if (first.line === 'MAIN') {
    return { enqueued: false, reason: 'PROMOTION_REQUIRED', projectId };
  }

  const codebase = await tx.projectCodebase.findFirst({
    where: { projectId, slot: 'primary' },
    select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
  });
  if (!codebase) return { enqueued: false, reason: 'INTEGRATION_REPOSITORY_UNKNOWN', projectId };

  const jobId = await queueLandTask(tx, {
    ownerId,
    projectId,
    taskId,
    codebase,
    session: { id: work.id, branch: work.branch, runnerId: work.assignedRunnerId },
  });
  if (!jobId) return { enqueued: false, reason: 'ALREADY_QUEUED', projectId };

  // L3 step 4. Only on the beat the line started: afterwards every DONE queues itself.
  const alsoQueuedTaskIds = first.startedAt.getTime() >= Date.now() - 1_000
    ? await backfillFinishedCodeTasks(tx, { ownerId, projectId, codebase, exceptTaskId: taskId })
    : [];
  return { enqueued: true, jobId, projectId, alsoQueuedTaskIds };
}

interface CodebaseForJob {
  id: string;
  canonicalRepoUrl: string;
  integrationRef: string;
  upstreamRef: string;
}

/**
 * Insert one LAND_TASK row, or answer null when this task already has a landing in flight.
 *
 * The generation is read under the task row lock the DONE transaction already holds, so two writers
 * cannot both decide they are generation 2. Earlier QUEUED rows of the same task are superseded
 * rather than left behind: a task branch that moved is one thing to land, not two.
 */
async function queueLandTask(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    projectId: string;
    taskId: string;
    codebase: CodebaseForJob;
    session: { id: string; branch: string; runnerId: string | null };
  },
): Promise<string | null> {
  const inflight = await tx.projectIntegrationJob.count({
    where: { taskId: input.taskId, kind: 'LAND_TASK', state: { in: ['QUEUED', 'RUNNING'] } },
  });
  if (inflight > 0) return null;

  const previous = await tx.projectIntegrationJob.aggregate({
    where: { taskId: input.taskId, kind: 'LAND_TASK' },
    _max: { generation: true },
  });
  const generation = (previous._max.generation ?? 0) + 1;
  const jobId = randomUUID();
  const created = await tx.projectIntegrationJob.createManyAndReturn({
    data: [{
      id: jobId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      codebaseId: input.codebase.id,
      kind: 'LAND_TASK' satisfies IntegrationJobKind,
      generation,
      taskId: input.taskId,
      sessionId: input.session.id,
      serialKey: integrationSerialKey({
        kind: 'LAND_TASK',
        canonicalRepoUrl: input.codebase.canonicalRepoUrl,
        targetRef: input.codebase.integrationRef,
        projectId: input.projectId,
      }),
      targetRef: input.codebase.integrationRef,
      upstreamRef: input.codebase.upstreamRef,
      sourceRef: `refs/heads/${input.session.branch}`,
      runnerId: input.session.runnerId,
      idempotencyKey: integrationIdempotencyKey({
        kind: 'LAND_TASK',
        subjectId: input.taskId,
        generation,
      }),
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  return created[0]?.id ?? null;
}

/**
 * The project's other finished code tasks, queued onto the line the moment it starts (L3 step 4).
 *
 * "Finished" is DONE and not yet landed anywhere on this line. A task whose work already sits on the
 * target is not re-queued — the runner would answer ALREADY_LANDED, which is a correct answer and a
 * wasted claim on a repository's serial slot.
 */
async function backfillFinishedCodeTasks(
  tx: Prisma.TransactionClient,
  input: { ownerId: string; projectId: string; codebase: CodebaseForJob; exceptTaskId: string },
): Promise<string[]> {
  const targetBranch = shortBranchName(input.codebase.integrationRef);
  const candidates = await tx.task.findMany({
    where: {
      ownerId: input.ownerId,
      projectId: input.projectId,
      codeless: false,
      status: TaskStatus.DONE,
      id: { not: input.exceptTaskId },
    },
    select: {
      id: true,
      sessions: {
        where: { startsTaskWork: true, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: WORK_SESSION_SELECT,
      },
      mergeReceipts: {
        where: { targetBranch, result: { in: ['MERGED', 'ALREADY_MERGED'] } },
        take: 1,
        select: { id: true },
      },
    },
  });
  const queued: string[] = [];
  for (const candidate of candidates) {
    const work = candidate.sessions[0];
    if (work?.isolationStatus !== 'worktree' || !work.branch) continue;
    if (candidate.mergeReceipts.length > 0) continue;
    const jobId = await queueLandTask(tx, {
      ownerId: input.ownerId,
      projectId: input.projectId,
      taskId: candidate.id,
      codebase: input.codebase,
      session: { id: work.id, branch: work.branch, runnerId: work.assignedRunnerId },
    });
    if (jobId) queued.push(candidate.id);
  }
  return queued;
}
