import { Prisma, TaskStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { LANDING_SESSION_CANDIDATES, LANDING_WORK_SESSION_SELECT, landingWorkSession } from './landing-source-branch';
import { startOnFirstIntegration } from './project-integration-line';
// Type-only, so the two modules do not import each other at run time: this one needs the two closed
// sets a candidate is written with, and `project-promotion.ts` needs the shape a check reports.
import type { PromotionSourceKind, PromotionState } from './project-promotion';

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
  // The branch the line was handed carried nothing of the task's own, so there was nothing to land
  // (0300). Deliberately NOT `ALREADY_LANDED`: that answer is reached by asking whether the source
  // tip is an ancestor of the base, and an EMPTY branch passes that trivially — every branch's
  // fork point is in the target it forked from. Reading the two as one is what let a landing job
  // started for a retry session that died commit a receipt for work no branch held.
  'NOTHING_TO_LAND',
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
  'CHECK_TREE_UNPREPARED',
  'CHECK_MUTATED_TREE',
  'LANDED_TREE_MISMATCH',
  'PROMOTION_TREE_NONDETERMINISTIC',
  'RUNNER_DRAINING',
  'INTEGRATION_REPOSITORY_UNKNOWN',
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

/** A job the runner is not going to touch again. */
const TERMINAL_STATES: ReadonlySet<string> = new Set<IntegrationJobState>([
  'LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'READY', 'CONFLICT', 'CHECK_FAILED', 'ERROR',
  'CANCELLED', 'SUPERSEDED',
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

/**
 * The capability a runner declares when it honours an automatic landing's one extra rule (§3.3
 * M-T12): land only onto the upstream tip the check ran against, and when the upstream has moved,
 * merge nothing and report READY so the owner is asked. A runner that has not declared it would
 * check the moved tip again and merge it (M5), which is the right thing after an owner's press and
 * not a thing the Automatic setting authorizes — so the platform confirms nothing by itself for a
 * landing such a runner would do, and never hands one an automatic landing to do. Its runner twin
 * is `promotionAutomaticLandCapabilityV1` in `src/runner-go/integrate.go`.
 */
export const PROMOTION_AUTOMATIC_LAND = 'promotion-automatic-land/v1';

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

// ── when a task's landing may be judged, and which branch that judgment is about ───────────────

/**
 * One work session of a landing's task, as the two rules below read it.
 *
 * Every field here is the runner's finalize's, not this process's opinion: `finishedAt` is written
 * after the runner committed the checkout (SR13), `worktreeBranch` is where that checkout's HEAD
 * ended, and `branch` is the branch the session was STARTED on. The last two are the same branch
 * unless the agent made one of its own mid-session (`git checkout -b`), which is exactly the case
 * where a landing handed the started branch learns nothing about the work.
 */
export interface LandingWorkSessionFacts {
  sessionId: string;
  /** The branch the session was started on — what an enqueue freezes (§2.3 J-T1a). */
  branch: string | null;
  /** Where its checkout's HEAD ended, as the finalize reported it. */
  worktreeBranch: string | null;
  /** When the runner finished with the checkout. Null while the session can still commit. */
  finishedAt: Date | null;
  /** The runner the session's checkout is on, which is where a landing for it can be worked. */
  runnerId: string | null;
}

/** The branch a session ended on. `worktree_branch` when the runner said, else the started branch. */
function endedOnBranch(session: LandingWorkSessionFacts): string | null {
  return session.worktreeBranch ?? session.branch;
}

/**
 * The branch a task's work ENDED on: of the work sessions that have finished, the one that finished
 * LAST, spelled as the branch its checkout's HEAD ended on. Null when nothing has finished on a
 * branch, which is "cannot tell" rather than "nothing".
 *
 * WHY THE LAST TO FINISH, AND NOT THE NEWEST SESSION
 * ==================================================
 * `enqueueForDoneTask` freezes the NEWEST work session at the moment the DONE is written (J-T1a), and
 * that is the right branch for the landing exactly while the task's work has stopped moving. It is
 * written while a session can still be running, and then "newest" and "the one that holds the work"
 * come apart: on 2026-09-23 this task had a 151-turn session in flight and a one-turn retry beside it
 * that had already FAILED, and the DONE — written after both had started — froze the retry's branch,
 * whose tip was the project branch's tip. The line answered ALREADY_LANDED about a branch that
 * carried nothing, and the commit the running session made afterwards had no route to the line: it
 * took two hand cherry-picks (789a8fffc onto the project branch, then that onto the upstream) to get
 * it anywhere. The session that finishes LAST is the one whose commits the task's work does not
 * predate, so its branch is the one a landing for this task is about.
 *
 * `null` is not `NO_BRANCH`: a task whose sessions have not finished yet has work that may still
 * move, and `landingWorkHasSettled` is the question asked about that, separately.
 */
export function workBranchEndedOn(
  sessions: ReadonlyArray<LandingWorkSessionFacts>,
): { sessionId: string; branch: string } | null {
  let best: { sessionId: string; branch: string; finishedAt: Date } | null = null;
  for (const session of sessions) {
    if (session.finishedAt === null) continue;
    const branch = endedOnBranch(session);
    if (branch === null) continue;
    const better = best === null
      || session.finishedAt.getTime() > best.finishedAt.getTime()
      // Two sessions can finish in the same millisecond; the id is the tie-break, and v7 uuids make
      // it the later session as well.
      || (session.finishedAt.getTime() === best.finishedAt.getTime() && session.sessionId > best.sessionId);
    if (better) best = { sessionId: session.sessionId, branch, finishedAt: session.finishedAt };
  }
  return best === null ? null : { sessionId: best.sessionId, branch: best.branch };
}

/**
 * Whether the task's work has stopped moving: every work session of it has finished.
 *
 * A task with no work sessions at all has settled — there is nothing to wait for, and its landing
 * could not have been queued in the first place (J-T1a refuses work with no branch).
 *
 * `finished_at`, and not a terminal `status`, for the reason `project-criterion-landing.ts` gives
 * about its own reading: the finish is recorded after the runner committed the checkout (SR13), so
 * it is the only column that says the branch cannot grow. What that costs, said rather than left to
 * be discovered: a session that reaches a terminal status with no finish recorded — an end whose
 * finalize killed the runner, or a row from a build older than this column — holds its task's
 * landings until it is revived and finishes. Measured on 2026-09-23: two such rows on this
 * deployment, both from 2026-09-15, neither with a landing queued; and a landing held that way is
 * visible rather than silent (it stays `QUEUED`, and the criteria stop reading the task as "nothing
 * to land" because no job ever answered about it).
 */
export function landingWorkHasSettled(sessions: ReadonlyArray<LandingWorkSessionFacts>): boolean {
  return sessions.every((session) => session.finishedAt !== null);
}

/**
 * Whether an answer taken at `claimedAt` was taken before the task's work had settled — the timing
 * this rule exists to remove (§2.6 J-T1a).
 *
 * The runner commits a worktree when it FINISHES the session, and a landing is queued by the DONE
 * that ends it: the two are the same beat, so the line can be handed a branch that carries nothing
 * yet and answer the only thing it can answer about such a branch, `ALREADY_LANDED` — a terminal
 * answer which by design is never re-queued, while the commit arrives seconds later. This rule's own
 * first delivery was lost that way on 2026-09-22 (the line answered at 04:23:09Z, the commit
 * appeared at 04:23:24Z), and the 2026-09-23 incident above is the same window with the work on a
 * second branch.
 *
 * `claimedAt` null is an answer nobody can date, and an undated answer is not one to write down as
 * final: the next claim dates it, and a claim always sets it.
 */
export function landingJudgedTooEarly(
  claimedAt: Date | null,
  sessions: ReadonlyArray<LandingWorkSessionFacts>,
): boolean {
  if (claimedAt === null) return true;
  // Work that has not finished cannot have been looked at after it did — the same question the
  // claim guard's SQL asks, so it is asked here through the same predicate rather than restated.
  if (!landingWorkHasSettled(sessions)) return true;
  return sessions.some((session) => session.finishedAt!.getTime() > claimedAt.getTime());
}

/**
 * Whether this `ALREADY_LANDED` is an answer about a branch the task's work did not end on.
 *
 * The answer is true of the branch the line was handed and says nothing about any other one, so when
 * the work ended somewhere else the landing has delivered nothing and never will: the job is
 * terminal, a terminal job is not offered again (§2.2 J-T3), and the branch holding the commits is
 * not on anybody's queue. `queueLandingBehindTheWork` is what closes it.
 */
export function landingLeftWorkBehind(
  job: { sourceRef: string },
  sessions: ReadonlyArray<LandingWorkSessionFacts>,
): boolean {
  const ended = workBranchEndedOn(sessions);
  return ended !== null && `refs/heads/${ended.branch}` !== job.sourceRef;
}

/**
 * Whether a promotion's check looked at the branch the task's work ENDED on — the question
 * `jobSawTheFinishedBranch` asks for the criterion lane, asked here about a candidate (§3.4, J-T1e
 * one level up).
 *
 * A `TASK_BRANCH` candidate's source is resolved by the check itself and written onto the candidate
 * as the commit the owner is about to be asked about (M-S1, 0293), so "the tip the owner is asked
 * about is the tip of the branch the work ended on" is only true when the check looked at that
 * branch. `jobSawTheFinishedBranch` in `projects/project-criterion-landing.ts` is the same condition
 * written for the criterion lane's audit — read it there. Two things differ, and both are this
 * caller's:
 *
 *  - it asks about the TASK's work sessions rather than about the job's own one, for the reason
 *    `landingLeftWorkBehind` gives: an enqueue freezes the NEWEST session, and the session that
 *    holds the work may be another one;
 *  - it does not read `worktree_dirty`. That column says what a finish could not commit, and a
 *    session that has already ended is not something this guard can wait for: a candidate held on it
 *    would be fetched, merged and checked again once per heartbeat with no answer at the end of it.
 *    What that costs, said rather than left to be discovered: a commit made afterwards from that
 *    session's own Commit action lands after the card was drawn, which no freeze can have seen. The
 *    lane that DOES read it is asking a different question — not "may the owner be asked now" but
 *    "does this task have nothing of its own at all" — where withholding is free.
 *
 * `false` covers two things, and the caller acts on the first of them only: the check looked at
 * another branch — the work is elsewhere, and `refileCandidateBehindTheWork` files the candidate that
 * branch is owed — or nothing finished on a branch at all, which `workBranchEndedOn` refuses to guess
 * at and which no re-check of THIS candidate could ever learn about, so the candidate stands as the
 * DONE left it.
 */
export function checkSawTheFinishedBranch(
  check: { sourceRef: string },
  sessions: ReadonlyArray<LandingWorkSessionFacts>,
): boolean {
  const ended = workBranchEndedOn(sessions);
  return ended !== null && `refs/heads/${ended.branch}` === check.sourceRef;
}

/**
 * The landing a task is owed after the line answered `ALREADY_LANDED` about a branch its work did not
 * end on: the NEXT generation, bound to the branch the work ended on (§2.3 J-T1a, §2.6).
 *
 * A generation rather than a re-pointed row, because that is what a second look at the same task IS
 * here: the first row says what the line was handed and what it answered, and this one is a landing
 * for the branch the work actually ended on — the row a DONE would have queued had it been written
 * after the work settled rather than during it. The generation counter, the idempotency key and the
 * serial key all already work this way.
 *
 * Answers null when there is nothing to offer: no finished session names a branch, the project's
 * binding is gone, or a landing of this task is already in flight for that branch (J3's index).
 */
export async function queueLandingBehindTheWork(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    projectId: string;
    taskId: string;
    sessions: ReadonlyArray<LandingWorkSessionFacts>;
  },
): Promise<LandingQueued | null> {
  const ended = workBranchEndedOn(input.sessions);
  if (ended === null) return null;
  const codebase = await tx.projectCodebase.findFirst({
    where: { projectId: input.projectId, slot: 'primary' },
    select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
  });
  if (!codebase) return null;
  const session = input.sessions.find((row) => row.sessionId === ended.sessionId)!;
  return queueLandingForWork(tx, {
    ownerId: input.ownerId,
    projectId: input.projectId,
    taskId: input.taskId,
    codebase,
    session: { id: session.sessionId, branch: ended.branch, runnerId: session.runnerId },
    // The line's own two refs decide which of the two things a landing is (§2.3): a project that
    // integrates into its upstream has no branch of its own to land on, and gets a candidate.
    line: codebase.integrationRef === codebase.upstreamRef ? 'MAIN' : 'PROJECT_BRANCH',
  });
}

// ── enqueue (J-T1a) ───────────────────────────────────────────────────────────────────────────

/**
 * What `enqueueForDoneTask` did, so the caller knows whether it owes an exception item.
 *
 * The two ways it can have done something are told apart by `kind`, because they put different
 * things on the queue and name them differently: a `LAND_TASK` is a job to replay this task's branch
 * onto the project's own line, and a `PROMOTION` is a candidate the owner will be asked to confirm,
 * with a check job beside it. Both mean "this DONE is on its way somewhere"; neither is the same as
 * `enqueued: false`, which is the ordinary answer for most DONE writes.
 */
export type EnqueueOutcome =
  | {
      enqueued: true;
      kind: 'LAND_TASK';
      jobId: string;
      projectId: string;
      alsoQueuedTaskIds: string[];
    }
  | {
      enqueued: true;
      kind: 'PROMOTION';
      /** The candidate (§3.4 M-F2), and the `CHECK_PROMOTION` job checking it. */
      promotionId: string;
      jobId: string;
      projectId: string;
      alsoQueuedTaskIds: string[];
    }
  | {
      enqueued: false;
      /**
       * NOT_A_CODE_TASK — nothing to integrate, and the ordinary answer for most DONE writes.
       * ALREADY_QUEUED — J3's index already holds a landing for this task, or the candidate's own
       *   index (§3.2) already holds a live promotion of this task's branch.
       * INTEGRATION_REPOSITORY_UNKNOWN — the caller opens an INTEGRATION_ERROR item (§4.2).
       */
      reason: 'NOT_A_CODE_TASK' | 'ALREADY_QUEUED' | 'INTEGRATION_REPOSITORY_UNKNOWN';
      projectId: string | null;
    };

/** The columns a landing needs from the task's own work session. */
const WORK_SESSION_SELECT = LANDING_WORK_SESSION_SELECT;

/**
 * The task's finished branches, newest first, as the two landing producers read them.
 *
 * Read through one WHERE so that "which session is this task's work" has one answer: sessions that
 * started work of this task's, were not deleted, and can carry work at all — a worktree and a
 * branch. A session that took no worktree is not the work's branch, and letting it shadow an older
 * one that did is the same bug as letting a session that reported nothing shadow one that did
 * (`landing-source-branch.ts`).
 */
function workSessionsOfTaskSelect() {
  return {
    where: {
      startsTaskWork: true,
      deletedAt: null,
      isolationStatus: 'worktree',
      branch: { not: null },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: LANDING_SESSION_CANDIDATES,
    select: WORK_SESSION_SELECT,
  } satisfies Prisma.Task$sessionsArgs;
}

/**
 * Give this task's branch a route to its project's integration line, in the transaction that wrote
 * DONE (§2.3 J-T1a).
 *
 * Which route depends on the line, and that is the whole of the difference: a `PROJECT_BRANCH`
 * project queues a `LAND_TASK` and the platform replays the task onto its own branch (§2.3), while a
 * `MAIN` project — whose integration ref IS its upstream — queues a candidate for a promotion the
 * owner confirms (§3.4 M-F2). Neither is a message to anybody: both are rows, and the platform
 * carries them from there.
 *
 * Does nothing for work that has no branch: a codeless task, a task in no project, a task none of
 * whose work sessions took a worktree. Those are the majority of DONE writes, and the check is
 * three columns rather than an inference from the title.
 *
 * WHICH of the task's branches is handed over is `landing-source-branch.ts`, and it is not simply
 * the newest: a session that reported no work must not stand in for the one that carried the
 * delivery (2026-09-23, the retry that died on a 429).
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
      sessions: workSessionsOfTaskSelect(),
    },
  });
  const work = landingWorkSession(task?.sessions ?? []);
  if (!task?.projectId || task.codeless || !work?.branch) {
    return { enqueued: false, reason: 'NOT_A_CODE_TASK', projectId: task?.projectId ?? null };
  }
  const projectId = task.projectId;

  const first = await startOnFirstIntegration(tx, { ownerId, projectId, taskId });
  if (!first.started) {
    return { enqueued: false, reason: first.refusal, projectId };
  }

  const codebase = await tx.projectCodebase.findFirst({
    where: { projectId, slot: 'primary' },
    select: { id: true, canonicalRepoUrl: true, integrationRef: true, upstreamRef: true },
  });
  if (!codebase) return { enqueued: false, reason: 'INTEGRATION_REPOSITORY_UNKNOWN', projectId };

  const session = { id: work.id, branch: work.branch, runnerId: work.assignedRunnerId };
  // L3 step 4. Only on the beat the line started: afterwards every DONE queues itself.
  const onTheStartingBeat = first.startedAt.getTime() >= Date.now() - 1_000;

  const queued = await queueLandingForWork(tx, {
    ownerId, projectId, taskId, codebase, session, line: first.line,
  });
  if (queued === null) return { enqueued: false, reason: 'ALREADY_QUEUED', projectId };

  const alsoQueuedTaskIds = onTheStartingBeat
    ? await backfillFinishedCodeTasks(tx, {
      ownerId, projectId, codebase, exceptTaskId: taskId, line: first.line,
    })
    : [];
  return queued.kind === 'PROMOTION'
    ? {
      enqueued: true,
      kind: 'PROMOTION',
      promotionId: queued.promotionId,
      jobId: queued.jobId,
      projectId,
      alsoQueuedTaskIds,
    }
    : { enqueued: true, kind: 'LAND_TASK', jobId: queued.jobId, projectId, alsoQueuedTaskIds };
}

interface CodebaseForJob {
  id: string;
  canonicalRepoUrl: string;
  integrationRef: string;
  upstreamRef: string;
}

/** What one work session's branch was given a route to: a landing on the line, or a candidate. */
export type LandingQueued =
  | { kind: 'LAND_TASK'; jobId: string }
  | { kind: 'PROMOTION'; promotionId: string; jobId: string };

/**
 * Give ONE work session's branch its route to the project's integration line (§2.3 J-T1a).
 *
 * Which route depends on the line and that is the whole of the difference: a `PROJECT_BRANCH` line
 * gets a `LAND_TASK` and the platform replays the branch onto its own ref, while a `MAIN` project —
 * whose integration ref IS its upstream — gets a candidate for a promotion the owner confirms
 * (§3.4 M-F2). Null when this branch already has one in flight.
 *
 * The caller decides WHICH session, because the two callers answer that differently and both
 * answers are facts about the same task: `enqueueForDoneTask` freezes the newest session at the
 * moment the DONE is written, and `queueLandingBehindTheWork` binds the branch the work ended on
 * once it has. Extracted rather than duplicated so the line's two routes stay one decision.
 */
async function queueLandingForWork(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    projectId: string;
    taskId: string;
    codebase: CodebaseForJob;
    session: { id: string; branch: string; runnerId: string | null };
    /** Which line the project has: its integration ref is its upstream, or a branch of its own. */
    line: 'MAIN' | 'PROJECT_BRANCH';
  },
): Promise<LandingQueued | null> {
  if (input.line === 'MAIN') {
    const candidate = await queueTaskBranchCandidate(tx, {
      ownerId: input.ownerId,
      projectId: input.projectId,
      taskId: input.taskId,
      codebase: input.codebase,
      session: input.session,
    });
    return candidate === null
      ? null
      : { kind: 'PROMOTION', promotionId: candidate.promotionId, jobId: candidate.jobId };
  }
  const jobId = await queueLandTask(tx, {
    ownerId: input.ownerId,
    projectId: input.projectId,
    taskId: input.taskId,
    codebase: input.codebase,
    session: input.session,
  });
  return jobId === null ? null : { kind: 'LAND_TASK', jobId };
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
 * The project's other finished code tasks, given a route at the moment the line starts (L3 step 4).
 *
 * "Finished" is DONE and not yet on this line: not on its target, and not on its upstream. A task
 * whose work already sits there is not offered again — the runner would answer ALREADY_LANDED,
 * which is a correct answer and a wasted claim on a repository's serial slot, and the owner would
 * be shown a card for a merge that has nothing in it.
 *
 * The upstream half is what a project branch makes true by construction: J-S2 MAIN_SYNC merges the
 * upstream into the target whenever the upstream tip is not an ancestor of it, so work that is on
 * the upstream is on the branch already, and a landing for it has nothing to replay — it can only
 * come back as a CONFLICT against a branch that moved on without it. J-S3 cannot tell either,
 * because this platform's own merges are rebases: the source sha those receipts name is an ancestor
 * of nothing. Work that reaches the upstream later arrives on the branch at the next MAIN_SYNC.
 *
 * Which route is the same one the triggering task took, from the same line: a project branch
 * back-fills `LAND_TASK` rows, and a MAIN line back-fills candidates. Without the second half a
 * project whose first integration happened after its code tasks finished would offer the owner
 * exactly one of them and quietly leave the rest on their branches.
 */
async function backfillFinishedCodeTasks(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string; projectId: string; codebase: CodebaseForJob; exceptTaskId: string;
    line: 'MAIN' | 'PROJECT_BRANCH';
  },
): Promise<string[]> {
  const targetBranch = shortBranchName(input.codebase.integrationRef);
  // The branches whose content the line already holds. On a MAIN line this is one branch, because
  // the binding's target and its upstream are the same ref (L3 step 2).
  const landedBranches = [...new Set([targetBranch, shortBranchName(input.codebase.upstreamRef)])];
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
      sessions: workSessionsOfTaskSelect(),
      mergeReceipts: {
        where: { targetBranch: { in: landedBranches }, result: { in: ['MERGED', 'ALREADY_MERGED'] } },
        take: 1,
        select: { id: true },
      },
    },
  });
  const queued: string[] = [];
  for (const candidate of candidates) {
    const work = landingWorkSession(candidate.sessions);
    if (!work?.branch) continue;
    if (candidate.mergeReceipts.length > 0) continue;
    const session = { id: work.id, branch: work.branch, runnerId: work.assignedRunnerId };
    if (input.line === 'MAIN') {
      const made = await queueTaskBranchCandidate(tx, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        taskId: candidate.id,
        codebase: input.codebase,
        session,
      });
      if (made) queued.push(candidate.id);
      continue;
    }
    const jobId = await queueLandTask(tx, {
      ownerId: input.ownerId,
      projectId: input.projectId,
      taskId: candidate.id,
      codebase: input.codebase,
      session,
    });
    if (jobId) queued.push(candidate.id);
  }
  return queued;
}

// ── promotions queued off a DONE (§3.4 M-F2) ─────────────────────────────────────────────────────

/**
 * Offer this task's branch to the owner, in the transaction that wrote DONE (§3.4 M-F2).
 *
 * A MAIN-line project has no branch of its own, so the thing that would go onto the upstream is the
 * task branch itself — which is why the source kind is `TASK_BRANCH` and why the candidate names the
 * task and its session rather than a ref the project owns. The row is `CHECKING` and a
 * `CHECK_PROMOTION` job is queued beside it: nothing here decides whether the merge is any good, and
 * the owner is not asked until a check has said it is.
 *
 * `source_sha` is left NULL on purpose. Where the task's branch points is not a fact any table here
 * holds — the session records the branch and the fork point it came from, not where it has got to —
 * so it is resolved by the runner that fetches the ref, reported on the check's result, and written
 * onto this row then (0293). Everything the owner is shown comes after that.
 *
 * Answers null when the partial unique index already holds a live candidate for this ref: one branch
 * is one question, and the one already standing is the one being asked.
 *
 * The second caller is `refileCandidateBehindTheWork` (`project-promotion.service.ts`): a check that
 * found it was handed a branch the task's work did not end on retires that candidate and files this
 * one for the branch the work is on, which is the same row a DONE written after the work settled
 * would have made.
 */
export async function queueTaskBranchCandidate(
  tx: Prisma.TransactionClient,
  input: {
    ownerId: string;
    projectId: string;
    taskId: string;
    codebase: CodebaseForJob;
    session: { id: string; branch: string; runnerId: string | null };
  },
): Promise<{ promotionId: string; jobId: string } | null> {
  const promotionId = randomUUID();
  const sourceRef = `refs/heads/${input.session.branch}`;
  const [created] = await tx.projectPromotion.createManyAndReturn({
    data: [{
      id: promotionId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      codebaseId: input.codebase.id,
      sourceKind: 'TASK_BRANCH' satisfies PromotionSourceKind,
      taskId: input.taskId,
      sessionId: input.session.id,
      sourceRef,
      sourceSha: null,
      upstreamRef: input.codebase.upstreamRef,
      // The one task this merge would carry. On a MAIN line a candidate is one task's branch, so
      // there is no set to derive the way M-F1 derives one off the receipts.
      includedTaskIds: [input.taskId],
      state: 'CHECKING' satisfies PromotionState,
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  if (!created) return null;

  const jobId = await queuePromotionJob(tx, {
    kind: 'CHECK_PROMOTION',
    promotion: {
      id: promotionId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      codebaseId: input.codebase.id,
      sourceRef,
      sourceSha: null,
      upstreamRef: input.codebase.upstreamRef,
      sessionId: input.session.id,
    },
    canonicalRepoUrl: input.codebase.canonicalRepoUrl,
  });
  await tx.projectPromotion.update({ where: { id: promotionId }, data: { checkJobId: jobId } });
  return { promotionId, jobId };
}

/** What a promotion job needs to exist, whichever of the two it is. */
export interface PromotionJobSubject {
  id: string;
  projectId: string;
  ownerId: string;
  codebaseId: string;
  sourceRef: string;
  /** Null only for a `TASK_BRANCH` candidate whose check has not run yet (0293). */
  sourceSha: string | null;
  upstreamRef: string;
  sessionId: string | null;
}

/**
 * Queue one `CHECK_PROMOTION` or `LAND_PROMOTION` (§3.4).
 *
 * The job carries a session even though a promotion is not one task's: the session is how the queue
 * finds a checkout on a runner to work in (`claimOne` joins it), and a promotion's git work happens
 * in a throwaway worktree beside that checkout like every other job's. For a candidate a DONE made,
 * that session is the finishing task's own work session, which is also where the runner reads the
 * task's acceptance command from (M-S3).
 *
 * A job whose `source_sha` is null leaves the runner to resolve the source ref itself and report the
 * commit it resolved — the only way a `TASK_BRANCH` candidate's source is knowable (0293).
 *
 * `confirmedAutomatically` marks a LAND_PROMOTION the project's Automatic setting queued rather than
 * the owner's press (M-T11) — on the job itself, because the job is the record of what was sent out
 * to be pushed, and because it is what tells the runner the landing is bound to the checked tip.
 */
export async function queuePromotionJob(
  tx: Prisma.TransactionClient,
  input: {
    kind: Extract<IntegrationJobKind, 'CHECK_PROMOTION' | 'LAND_PROMOTION'>;
    promotion: PromotionJobSubject;
    canonicalRepoUrl: string;
    confirmedAutomatically?: boolean;
  },
): Promise<string> {
  const previous = await tx.projectIntegrationJob.aggregate({
    where: { promotionId: input.promotion.id, kind: input.kind },
    _max: { generation: true },
  });
  const generation = (previous._max.generation ?? 0) + 1;
  const jobId = randomUUID();
  const [created] = await tx.projectIntegrationJob.createManyAndReturn({
    data: [{
      id: jobId,
      projectId: input.promotion.projectId,
      ownerId: input.promotion.ownerId,
      codebaseId: input.promotion.codebaseId,
      kind: input.kind,
      generation,
      // No task id, deliberately. A promotion is not one task's landing, and a job row that named
      // one would make "the job of task X" ambiguous for every reader that addresses a job by its
      // task — the acceptance script included. The session is still named, because that is how the
      // queue finds a checkout on a runner to work in and where the task's acceptance command comes
      // from.
      taskId: null,
      sessionId: input.promotion.sessionId,
      promotionId: input.promotion.id,
      serialKey: integrationSerialKey({
        kind: input.kind,
        canonicalRepoUrl: input.canonicalRepoUrl,
        targetRef: input.promotion.upstreamRef,
        projectId: input.promotion.projectId,
      }),
      // A promotion is merged INTO the upstream, so that is the ref it writes and the one it
      // serialises on; the project branch — or the task branch — is its source.
      targetRef: input.promotion.upstreamRef,
      upstreamRef: input.promotion.upstreamRef,
      sourceRef: input.promotion.sourceRef,
      sourceSha: input.promotion.sourceSha,
      confirmedAutomatically: input.confirmedAutomatically === true,
      idempotencyKey: integrationIdempotencyKey({
        kind: input.kind,
        subjectId: input.promotion.id,
        generation,
      }),
    }],
    skipDuplicates: true,
    select: { id: true },
  });
  return created?.id ?? jobId;
}
