import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import {
  LANDING_SERVING_WORK_SELECT,
  taskHasNothingToLand,
  taskLanding,
  type CriterionLanding,
  type LandingBranches,
  type LandingServingTask,
} from './project-criterion-landing';

/**
 * WHY a criterion is not on the upstream by a receipt of its own — one word per criterion, so a card
 * can group the criteria by what they are waiting on and every count it prints comes out of one
 * reading (project closing, D4).
 *
 * `landing` says WHERE the work is and refuses to guess beyond the receipts; this says what that
 * means for the person reading it. The two came apart on 2026-10-01: a go-live task that made no
 * commits read ON_INTEGRATION_LINE — the line's own no-commit answer writes an `ALREADY_MERGED`
 * receipt onto the project branch — and the card told its owner the work was "on the integration
 * line" and to record a merge receipt, when there was nothing anywhere to merge. Each reason below
 * is read off the same rows the landing fold reads, and none of them moves `landing`.
 *
 *   * IN_FLIGHT         — the platform is moving its work right now: a `LAND_TASK` of its own is
 *                         queued or running, or a merge into the upstream (`CHECK_PROMOTION`,
 *                         `LAND_PROMOTION`) is, while its work is on the project branch.
 *   * ON_PROJECT_BRANCH — its work is on the project branch, with commits of its own, and nothing is
 *                         taking it to the upstream.
 *   * NOTHING_TO_LAND   — its work ran a branch and the line found no commit of its own on it. Not
 *                         LANDED when that answer cannot say the tip is on the upstream; LANDED when
 *                         it can (`taskHasNothingToLand`), and then this names which kind of landed.
 *   * NO_RECEIPT        — no receipt puts its work on either branch: merged outside Orbit, or not
 *                         merged at all. Absence of evidence, never evidence of absence.
 *   * CODELESS          — its work has no branch to land: declared codeless (LANDED, nothing to
 *                         land), or never declared and its newest work session took no worktree
 *                         branch — so no landing was ever queued and no receipt will ever come.
 *
 * Null exactly when the criterion is LANDED with work of its own on the upstream — "on main".
 */
export type CriterionLandingReason =
  | 'IN_FLIGHT'
  | 'ON_PROJECT_BRANCH'
  | 'NOTHING_TO_LAND'
  | 'NO_RECEIPT'
  | 'CODELESS';

/** The landing reasons, in the order a reader is told about them: what is moving first. */
export const CRITERION_LANDING_REASONS = [
  'IN_FLIGHT',
  'ON_PROJECT_BRANCH',
  'NOTHING_TO_LAND',
  'NO_RECEIPT',
  'CODELESS',
] as const satisfies readonly CriterionLandingReason[];

/** The integration jobs that move work towards the upstream, and the two states they move in. */
export const LANDING_JOB_KINDS = ['LAND_TASK', 'CHECK_PROMOTION', 'LAND_PROMOTION'] as const;
export const IN_FLIGHT_JOB_STATES = ['QUEUED', 'RUNNING'] as const;

/** One landing or merge into the upstream that is queued or running, as the queue holds it. */
export interface InFlightLandingJob {
  kind: string;
  /** The task a `LAND_TASK` lands. A promotion names none: it merges a whole branch. */
  taskId: string | null;
}

/** One serving task as this reading needs it: the landing lane's facts, its id, and its newest work
 *  session — §1.1 `isCodeTask`'s second half, which the landing fold deliberately does not read. */
export interface LandingReasonServingTask extends LandingServingTask {
  id: string;
  /** At most one: the newest session that started this task's work. */
  sessions: ReadonlyArray<{ isolationStatus: string | null; branch: string | null }>;
}

/** One criterion: its landing answer, and the work serving it. */
export interface CriterionLandingReasonFacts {
  landing: CriterionLanding;
  servingTasks: ReadonlyArray<LandingReasonServingTask>;
}

/** Precedence when a criterion's held work disagrees: what is moving, then real work waiting, then
 *  the gaps nobody can close by landing anything. */
const PRECEDENCE: readonly CriterionLandingReason[] = [
  'IN_FLIGHT',
  'ON_PROJECT_BRANCH',
  'NO_RECEIPT',
  'CODELESS',
  'NOTHING_TO_LAND',
];

/** The line answered that the branch it was handed carried no commit of the task's own, and no
 *  receipt says any target ever moved with this task's work. */
function madeNoCommits(task: LandingServingTask): boolean {
  return task.integrationJobs.some((job) => job.state === 'NOTHING_TO_LAND')
    && !task.mergeReceipts.some((receipt) => receipt.result === 'MERGED');
}

/** Why one task that holds its criterion off LANDED is holding it. */
function heldTaskReason(
  task: LandingReasonServingTask,
  branches: LandingBranches,
  inFlight: ReadonlyArray<InFlightLandingJob>,
): CriterionLandingReason {
  if (inFlight.some((job) => job.kind === 'LAND_TASK' && job.taskId === task.id)) return 'IN_FLIGHT';
  const where = taskLanding(task.mergeReceipts, branches);
  // A merge of the project branch into the upstream carries everything on the line, a receipt the
  // line wrote for a branch with no commits included.
  if (where === 'ON_INTEGRATION_LINE' && inFlight.some((job) => job.kind !== 'LAND_TASK')) {
    return 'IN_FLIGHT';
  }
  if (madeNoCommits(task)) return 'NOTHING_TO_LAND';
  if (where === 'ON_INTEGRATION_LINE') return 'ON_PROJECT_BRANCH';
  const newest = task.sessions[0];
  const ranNoBranch = !newest || newest.isolationStatus !== 'worktree' || !newest.branch;
  if (ranNoBranch && task.integrationJobs.length === 0 && task.mergeReceipts.length === 0) {
    return 'CODELESS';
  }
  return 'NO_RECEIPT';
}

/**
 * One criterion's reason, or null when it is on the upstream by work of its own.
 *
 * A criterion that is LANDED has a reason only when nothing of its work had to land: CODELESS when
 * every serving task declares it, NOTHING_TO_LAND otherwise. One that is not LANDED is held by the
 * serving tasks that have something to land and are not on the upstream — the same tasks the
 * landing fold is held by — and takes the first of their reasons in `PRECEDENCE`. A criterion
 * nothing is filed under has no receipt to stand on: NO_RECEIPT.
 */
export function criterionLandingReason(
  criterion: CriterionLandingReasonFacts,
  branches: LandingBranches,
  inFlight: ReadonlyArray<InFlightLandingJob>,
): CriterionLandingReason | null {
  const delivery = criterion.servingTasks.filter((task) => !taskHasNothingToLand(task));
  if (criterion.landing === 'LANDED') {
    if (delivery.length > 0) return null;
    return criterion.servingTasks.every((task) => task.codeless) ? 'CODELESS' : 'NOTHING_TO_LAND';
  }
  const held = delivery.filter((task) => taskLanding(task.mergeReceipts, branches) !== 'ON_UPSTREAM');
  if (held.length === 0) return 'NO_RECEIPT';
  const reasons = new Set(held.map((task) => heldTaskReason(task, branches, inFlight)));
  return PRECEDENCE.find((reason) => reasons.has(reason)) ?? 'NO_RECEIPT';
}

/** The newest session that started a task's work, the one §1.1 `isCodeTask` reads. */
const NEWEST_WORK_SESSION = {
  where: { startsTaskWork: true, deletedAt: null },
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: 1,
  select: { isolationStatus: true, branch: true },
} satisfies Prisma.Task$sessionsArgs;

/** What the reading needs about one serving task, as a Prisma `select`: the landing lane's own
 *  select, spread so that whatever it reads this reads too, plus the task's id and newest work
 *  session. */
export const LANDING_REASON_SERVING_WORK_SELECT = {
  id: true,
  ...LANDING_SERVING_WORK_SELECT,
  sessions: NEWEST_WORK_SESSION,
} as const;

/** Every criterion this project states, each with the serving work this reading needs. One call:
 *  the landing lane's read, with the newest work session one relation below each task. */
export async function readCriterionLandingReasonFacts(
  prisma: Pick<PrismaService, 'projectAcceptanceCriterionDefinition'>,
  ownerId: string,
  projectId: string,
): Promise<Array<{ id: string; servingTasks: LandingReasonServingTask[] }>> {
  return prisma.projectAcceptanceCriterionDefinition.findMany({
    where: { projectId, project: { ownerId } },
    select: {
      id: true,
      servingTasks: { where: { ownerId }, select: LANDING_REASON_SERVING_WORK_SELECT },
    },
  });
}

/** The project's landings and merges into the upstream that are queued or running. One statement. */
export async function readInFlightLandingJobs(
  prisma: Pick<PrismaService, 'projectIntegrationJob'>,
  projectId: string,
): Promise<InFlightLandingJob[]> {
  return prisma.projectIntegrationJob.findMany({
    where: {
      projectId,
      kind: { in: [...LANDING_JOB_KINDS] },
      state: { in: [...IN_FLIGHT_JOB_STATES] },
    },
    select: { kind: true, taskId: true },
  });
}
