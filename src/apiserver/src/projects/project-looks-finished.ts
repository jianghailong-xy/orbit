import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { SETTLED_TASK_STATUSES, type CoordinatorWakeEvent } from './coordinator-wake';
import { IN_FLIGHT_JOB_STATES, LANDING_JOB_KINDS } from './criterion-landing-reason';
import {
  readDerivedProjectDoneReading,
  type DerivedProjectDoneReading,
} from './project-done-derived';
import { DONE_REQUEST_KIND } from './project-done-request';
import { SESSION_ENDING_SELECT, openItemOwed, sessionHasEnded } from './project-open-item';

/**
 * A project that LOOKS finished and that Orbit still cannot record done — and who is told so, in
 * which order (project closing, D5).
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-10-01 a project had every criterion met and every task settled, and the projection still
 * withheld DONE: one go-live task had made no commits, so no receipt could ever put its criterion on
 * `main`. Nothing said so to anybody who could act. The settled-task fact opened a one-shot judgment
 * session instead, in the minutes between the work landing on the project branch and the project
 * branch reaching `main`, and that session filed a redundant "merge into main" task against the very
 * criterion that was met — which unmet it.
 *
 * So the settled-task fact now has a third terminal beside the judgment and the confirmation card,
 * chosen by what the project looks like when the fact is derived (`readProjectFinish`):
 *
 *   * a landing or merge into the upstream is queued or running (`LANDING_IN_FLIGHT`) — nothing is
 *     said to anybody. The platform is still moving the work, and the job's own result re-derives
 *     the same fact once it ends (`integrationJobResult` → `deliverProjectFactsAfterCommit`).
 *   * every criterion met, every task settled, no open item, nothing landing — and DONE still
 *     withheld (`LOOKS_FINISHED`) — the fact is DELIVERED to the project's standing coordinator
 *     conversation, with every criterion's landing reason, asking it to choose: request done
 *     (`project_request_done`), or go and do the work. No new wake event: it is
 *     `PROJECT_TASKS_SETTLED`, spent on the conversation rather than on a judgment.
 *   * anything else — the judgment, as before.
 *
 * And then the owner: a coordinator that neither asks nor makes the project move within the
 * project's `exceptionEscalationSeconds` leaves the decision with the account owner, whose Needs you
 * shows "Record as done…" (`projectsToRecordAsDone`). Read off committed rows at read time, like the
 * Automatic evidence card's hold (`pending-evidence-judgments.ts`): no clock writes anything.
 */

/** The fact a finished-looking project is delivered as: the settled-task fact, spent on the standing
 *  conversation rather than on a judgment. Read back by name here, never built. */
const LOOKS_FINISHED_DELIVERY = 'PROJECT_TASKS_SETTLED' satisfies CoordinatorWakeEvent;

/** What a project whose tasks have all settled is waiting on, as the closing guardrail reads it. */
export type ProjectFinish =
  /** A landing or a merge into the upstream is queued or running: the work is still moving. */
  | { state: 'LANDING_IN_FLIGHT' }
  /** Every criterion met, nothing running or queued, no open item, nothing landing — and the
   *  projection still withholds DONE. Carries the reading it was decided on. */
  | { state: 'LOOKS_FINISHED'; reading: DerivedProjectDoneReading }
  /** Anything else: work still open, an open item, a criterion not met, DONE, CANCELLED, gone. */
  | { state: 'NOT_FINISHED' };

/**
 * Whether a `LAND_TASK`, `CHECK_PROMOTION` or `LAND_PROMOTION` is queued or running in this project
 * — the first thing the guardrail asks, of the settled-task producer and of a settled project's
 * judgment alike: while it is, the work is still moving towards the upstream. One statement.
 */
export async function landingInFlight(
  prisma: Pick<PrismaService, 'projectIntegrationJob'>,
  projectId: string,
): Promise<boolean> {
  const job = await prisma.projectIntegrationJob.findFirst({
    where: {
      projectId,
      kind: { in: [...LANDING_JOB_KINDS] },
      state: { in: [...IN_FLIGHT_JOB_STATES] },
    },
    select: { id: true },
  });
  return job !== null;
}

/** The delegates the guardrail reads: the projection's, and the four rows it asks before it. */
type FinishClient = Parameters<typeof readDerivedProjectDoneReading>[0]
  & Pick<PrismaService, 'projectTaskStatusCount' | '$queryRaw'>;

/**
 * Whether this project looks finished while Orbit cannot record it done.
 *
 * `tasksSettled` is the caller saying it has just read every task row and found them all DONE or
 * CANCELLED — the settled-task producer, which must not pay again for the read that justified it.
 * Without it the project's own tally answers first and one row of `task` confirms it, which is the
 * order the producer asks them in and for its reason.
 */
export async function readProjectFinish(
  prisma: FinishClient,
  projectId: string,
  options: { tasksSettled?: boolean } = {},
): Promise<ProjectFinish> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true, status: true },
  });
  // DONE has been recorded, by Orbit or by the owner, and CANCELLED was somebody's decision: there
  // is nothing left to ask anybody about either.
  if (!project || project.status !== 'OPEN') return { state: 'NOT_FINISHED' };

  if (!options.tasksSettled) {
    const counted = await prisma.projectTaskStatusCount.findMany({
      where: { projectId, count: { gt: 0 } },
      select: { status: true },
    });
    if (counted.length === 0) return { state: 'NOT_FINISHED' };
    if (counted.some((row) => !(SETTLED_TASK_STATUSES as readonly string[]).includes(row.status))) {
      return { state: 'NOT_FINISHED' };
    }
    const unsettled = await prisma.task.findFirst({
      where: { projectId, status: { notIn: [...SETTLED_TASK_STATUSES] } },
      select: { id: true },
    });
    if (unsettled) return { state: 'NOT_FINISHED' };
  }

  // An open item is somebody already handling something — the coordinator's exception, or a
  // question, a merge or a request waiting on the owner. A project with one does not look finished.
  // One that is owed (`openItemOwed`): an item about a candidate or a task that has moved on is
  // nobody handling anything, whether or not anything has closed it yet.
  const [open] = await prisma.$queryRaw<Array<{ owed: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "project_open_item" item
       WHERE item."project_id" = ${projectId}::uuid
         AND item."state" = 'OPEN'
         AND ${openItemOwed('item')}) AS "owed"`);
  if (open?.owed) return { state: 'NOT_FINISHED' };

  const reading = await readDerivedProjectDoneReading(prisma, project.ownerId, projectId);
  if (reading.inFlight.length > 0) return { state: 'LANDING_IN_FLIGHT' };
  const { derived } = reading;
  if (derived.done) return { state: 'NOT_FINISHED' };
  // "Every criterion met" of a project that states none is the vacuous truth the projection itself
  // refuses (`NO_CRITERIA_STATED`).
  if (derived.criteria.length === 0) return { state: 'NOT_FINISHED' };
  if (!derived.criteria.every((criterion) => criterion.satisfied)) return { state: 'NOT_FINISHED' };
  return { state: 'LOOKS_FINISHED', reading };
}

/** The delegates `projectsToRecordAsDone` reads. */
type EscalationClient = FinishClient & Pick<PrismaService, 'projectCoordinatorWake' | 'projectOpenItem'>;

/**
 * This owner's projects, among `projectIds`, whose "Record as done…" is the owner's now — with the
 * instant it became theirs.
 *
 * A project is the owner's when ALL of these hold at `readAt`:
 *
 *   * its coordinator was told it looks finished — a `PROJECT_TASKS_SETTLED` wake DELIVERED to its
 *     standing conversation, which is the only way that fact is ever delivered;
 *   * there is no valid request to record it done — no OPEN `DONE_REQUEST`. A request the owner
 *     answered "Not yet…", or that went stale, restarts the clock rather than ending it: the
 *     coordinator was just handed the question back;
 *   * the project's `exceptionEscalationSeconds` have run out since the later of those two — or
 *     the conversation it was delivered to has ended, since a conversation that is over will not
 *     choose anything (`pending-evidence-judgments.ts` holds evidence on the same terms);
 *   * and it STILL looks finished (`readProjectFinish`): new work, an open item or a landing in
 *     flight takes it back off the owner's list by itself.
 *
 * The cheap facts are asked first and for every project at once — the task tally, then the
 * deliveries — so an owner none of whose projects has settled pays two statements for this.
 */
export async function projectsToRecordAsDone(
  prisma: EscalationClient,
  ownerId: string,
  projectIds: readonly string[],
  readAt: Date,
): Promise<Map<string, Date>> {
  const due = new Map<string, Date>();
  if (projectIds.length === 0) return due;

  const counted = await prisma.projectTaskStatusCount.findMany({
    where: { projectId: { in: [...projectIds] }, count: { gt: 0 } },
    select: { projectId: true, status: true },
  });
  const settled = new Map<string, boolean>();
  for (const row of counted) {
    const settledHere = (SETTLED_TASK_STATUSES as readonly string[]).includes(row.status);
    settled.set(row.projectId, (settled.get(row.projectId) ?? true) && settledHere);
  }
  const candidates = [...settled].filter(([, isSettled]) => isSettled).map(([id]) => id);
  if (candidates.length === 0) return due;

  const deliveries = await prisma.projectCoordinatorWake.findMany({
    where: {
      projectId: { in: candidates },
      event: LOOKS_FINISHED_DELIVERY,
      status: 'DELIVERED',
      project: { ownerId, status: 'OPEN' },
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    select: {
      projectId: true,
      updatedAt: true,
      session: { select: SESSION_ENDING_SELECT },
      project: { select: { exceptionEscalationSeconds: true } },
    },
  });
  const delivered = new Map<string, (typeof deliveries)[number]>();
  for (const row of deliveries) {
    if (!delivered.has(row.projectId)) delivered.set(row.projectId, row);
  }
  if (delivered.size === 0) return due;

  const requests = await prisma.projectOpenItem.findMany({
    where: { projectId: { in: [...delivered.keys()] }, kind: DONE_REQUEST_KIND },
    select: { projectId: true, state: true, updatedAt: true },
  });

  for (const [projectId, delivery] of delivered) {
    const asked = requests.filter((request) => request.projectId === projectId);
    if (asked.some((request) => request.state === 'OPEN')) continue;
    const since = Math.max(
      delivery.updatedAt.getTime(),
      ...asked.map((request) => request.updatedAt.getTime()),
    );
    const ended = !delivery.session || sessionHasEnded(delivery.session);
    const escalatesAt = ended
      ? since
      : since + delivery.project.exceptionEscalationSeconds * 1_000;
    if (readAt.getTime() < escalatesAt) continue;
    const finish = await readProjectFinish(prisma, projectId);
    if (finish.state !== 'LOOKS_FINISHED') continue;
    due.set(projectId, new Date(escalatesAt));
  }
  return due;
}
