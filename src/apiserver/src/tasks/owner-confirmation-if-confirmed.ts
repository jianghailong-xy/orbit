import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  OwnerConfirmationBranch,
  OwnerConfirmationEndsSession,
  OwnerConfirmationIfConfirmed,
  OwnerConfirmationLanding,
  OwnerConfirmationOnMain,
  OwnerConfirmationStart,
  OwnerConfirmationStartsTask,
} from '@orbit/shared';
import {
  landingBranchesFor,
  taskLanding,
  type LandingBranches,
  type LandingReceiptFacts,
} from '../projects/project-criterion-landing';
import { defaultStartLine, readProjectCodebase } from '../projects/project-integration-line';
import { doneTaskLandingWork } from '../projects/project-integration-job';
import { automaticAuthorizationRefusal } from '../projects/project-promotion';
import { changedFileCount, mergeTargetOf } from '../sessions/session-move';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import type { DependentRelease } from './tasks.service';

/**
 * What confirming an OWNER_CONFIRMED task sets off, as the card draws it above its buttons
 * (`OwnerConfirmationIfConfirmed` in `@orbit/shared`).
 *
 * Each item is read from the rule that will act on it rather than restated here: the tasks it starts
 * are the completion edge's own answer (`TasksService.dependentRelease`), the landing is what
 * `enqueueForDoneTask` would queue on the line `defaultStartLine` names, and the Automatic merge into
 * main is M-T11's project half (`automaticAuthorizationRefusal`). A card that said anything else
 * would be the 2026-10-02 card again: confirmed, and a second later a dependent started on a branch
 * nobody had told the owner about.
 *
 * Best-effort, item by item: a read that fails leaves its item out and the card is drawn without it.
 */

/** The completion edge's predicate, as the card asks it (`TasksService.dependentRelease`). */
export interface DependentReleaseReader {
  dependentRelease(
    ownerId: string,
    doneTaskId: string,
    options: { assumeCompleted: boolean },
  ): Promise<DependentRelease>;
}

const log = new Logger('OwnerConfirmationIfConfirmed');

/** The four items for the run `sessionId` is waiting with. `releases` absent leaves out the first. */
export async function readIfConfirmed(
  db: Prisma.TransactionClient,
  input: { ownerId: string; taskId: string; sessionId: string },
  releases?: DependentReleaseReader,
): Promise<OwnerConfirmationIfConfirmed> {
  const read = async <T>(item: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (error) {
      log.warn(`task ${input.taskId}: could not read ${item} for its confirmation card: `
        + `${error instanceof Error ? error.message : error}`);
      return undefined;
    }
  };
  const ifConfirmed: OwnerConfirmationIfConfirmed = {};
  const startsTasks = releases
    ? await read('startsTasks', () => readStartsTasks(db, releases, input))
    : undefined;
  if (startsTasks !== undefined) ifConfirmed.startsTasks = startsTasks;
  const landing = await read('landing', () => readLanding(db, input));
  if (landing !== undefined) {
    ifConfirmed.landing = landing.landing;
    ifConfirmed.startsAfterLanding = landing.startsAfterLanding;
  }
  const branch = await read('branch', () => readBranch(db, input));
  if (branch !== undefined) ifConfirmed.branch = branch;
  const endsSession = await read('endsSession', () => readEndsSession(db, input));
  if (endsSession !== undefined) ifConfirmed.endsSession = endsSession;
  return ifConfirmed;
}

/** The dependents this task's DONE releases, by when they start: the dispatch's own order. */
async function readStartsTasks(
  db: Prisma.TransactionClient,
  releases: DependentReleaseReader,
  { ownerId, taskId }: { ownerId: string; taskId: string },
): Promise<OwnerConfirmationStartsTask[]> {
  const release = await releases.dependentRelease(ownerId, taskId, { assumeCompleted: true });
  const released: Array<[string, OwnerConfirmationStart]> = [
    ...release.start.map(({ id }): [string, OwnerConfirmationStart] => [id, 'NOW']),
    ...release.waitingForSlot.map((id): [string, OwnerConfirmationStart] => [id, 'WHEN_SLOT_FREES']),
    ...release.undecided.map((id): [string, OwnerConfirmationStart] => [id, 'MANUAL']),
  ];
  if (released.length === 0) return [];
  const rows = await db.task.findMany({
    where: { ownerId, id: { in: released.map(([id]) => id) } },
    select: { id: true, title: true },
  });
  const titles = new Map(rows.map((row) => [row.id, row.title]));
  return released.flatMap(([id, starts]) => {
    const title = titles.get(id);
    return title === undefined ? [] : [{ id, title, starts }];
  });
}

/**
 * How the DONE lands the work, and whether the dependents wait for that landing.
 *
 * They wait when the work lands at all: the DONE starts the project's line if nothing has, and from
 * then on §2.5 J9 holds a code task's dependents until a receipt puts its work on the line or on
 * main — `prerequisiteLanded`'s last clause, which a receipt already on record answers now.
 */
async function readLanding(
  db: Prisma.TransactionClient,
  { ownerId, taskId }: { ownerId: string; taskId: string },
): Promise<{ landing: OwnerConfirmationLanding; startsAfterLanding: boolean }> {
  const handed = await doneTaskLandingWork(db, ownerId, taskId);
  if (!handed.work) return { landing: 'NONE', startsAfterLanding: false };
  const { line } = await defaultStartLine(db, ownerId, handed.projectId);
  const project = await db.project.findFirst({
    where: { id: handed.projectId, ownerId },
    select: { coordinatorEnabled: true, pausedAt: true },
  });
  const automatic = automaticAuthorizationRefusal({
    // The candidate a DONE leads to: the project's branch on its own line, the task's branch on main.
    sourceKind: line === 'PROJECT_BRANCH' ? 'PROJECT_BRANCH' : 'TASK_BRANCH',
    line,
    coordinatorEnabled: project?.coordinatorEnabled === true,
    projectPaused: project?.pausedAt != null,
  }) === null;
  const codebase = await readProjectCodebase(db, handed.projectId);
  const receipts = await db.sessionMergeReceipt.findMany({
    where: { ownerId, taskId },
    select: { result: true, targetBranch: true },
  });
  return {
    landing: automatic ? 'AUTO_MAIN' : 'LINE_THEN_OWNER',
    startsAfterLanding: taskLanding(receipts, landingBranchesFor(codebase)) === 'NOT_KNOWN',
  };
}

/** The waiting run's branch, or null when it worked on none. */
async function readBranch(
  db: Prisma.TransactionClient,
  { ownerId, taskId, sessionId }: { ownerId: string; taskId: string; sessionId: string },
): Promise<OwnerConfirmationBranch | null> {
  const session = await db.session.findFirst({
    where: { id: sessionId, ownerId },
    select: {
      branch: true,
      changedFiles: true,
      branchMerged: true,
      mergeTarget: true,
      mergeTargets: true,
      workspace: { select: { defaultMergeTarget: true } },
      task: { select: { projectId: true } },
    },
  });
  if (!session?.branch) return null;
  const projectId = session.task?.projectId ?? null;
  const codebase = projectId ? await readProjectCodebase(db, projectId) : null;
  // This run's merges, and any other door's record of a merge of this same branch for this task.
  const receipts = await db.sessionMergeReceipt.findMany({
    where: { ownerId, OR: [{ sessionId }, { taskId, sourceBranch: session.branch }] },
    select: { result: true, targetBranch: true },
  });
  // The status bar's sums over the same list: a binary file reports -1 and adds no lines.
  const files: unknown[] = Array.isArray(session.changedFiles) ? session.changedFiles : [];
  const lines = (key: 'additions' | 'deletions') => files.reduce<number>((sum, file) => {
    const count = (file as Record<string, unknown> | null)?.[key];
    return sum + (typeof count === 'number' ? Math.max(0, count) : 0);
  }, 0);
  return {
    name: session.branch,
    linesAdded: lines('additions'),
    linesRemoved: lines('deletions'),
    files: changedFileCount(session.changedFiles),
    onMain: branchOnMain({
      receipts,
      branches: landingBranchesFor(codebase),
      branchMerged: session.branchMerged,
      judgedAgainst: mergeTargetOf(session, session.workspace?.defaultMergeTarget),
    }),
  };
}

/**
 * Whether a branch is on main, by the receipts first.
 *
 * A receipt that it landed on the upstream decides, whatever the ancestry says: a squash or rebase
 * merge puts the work there under commits the branch's own are not ancestors of, so a check by
 * ancestry alone would call that work "not on main" for ever. The runner's `branchMerged` answers only
 * where no receipt does, and only when the branch it was judged against is that upstream — it judges
 * the session's merge target. UNKNOWN when neither says.
 */
export function branchOnMain(facts: {
  receipts: readonly LandingReceiptFacts[];
  branches: LandingBranches;
  branchMerged: boolean | null;
  /** The branch the runner judged `branchMerged` against (`mergeTargetOf`). */
  judgedAgainst: string;
}): OwnerConfirmationOnMain {
  if (taskLanding(facts.receipts, facts.branches) === 'ON_UPSTREAM') return 'YES';
  if (facts.branchMerged === null || !facts.branches.upstream.includes(facts.judgedAgainst)) {
    return 'UNKNOWN';
  }
  return facts.branchMerged ? 'YES' : 'NO';
}

/**
 * The run the DONE ends: the waiting session while it is still open as the task's own work — the
 * reaper ends exactly those once the task is DONE (`end_reason` task_done), and with it the jobs it
 * still has running.
 */
async function readEndsSession(
  db: Prisma.TransactionClient,
  { ownerId, taskId, sessionId }: { ownerId: string; taskId: string; sessionId: string },
): Promise<OwnerConfirmationEndsSession | null> {
  const session = await db.session.findFirst({
    where: {
      id: sessionId,
      ownerId,
      taskId,
      startsTaskWork: true,
      deletedAt: null,
      cancelRequestedAt: null,
      status: { in: TASK_OCCUPYING },
    },
    select: { id: true, runningBgJobs: true },
  });
  return session ? { sessionId: session.id, runningBgJobs: session.runningBgJobs.length } : null;
}
