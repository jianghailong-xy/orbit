import { type ProjectPauseReason, uuidToBase62 } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * A project's tasks start by themselves only while the project is started and not paused.
 *
 * "Does this project move" is two facts on the project row: its owner started it (`started_at`,
 * migration 0331) and has not paused it (`paused_at`, 0334). Until then it was read off
 * `coordinator_enabled`, the Automatic switch — and only by the release of tasks that depend on
 * nothing, so switching Automatic off stopped that release and nothing else: a prerequisite
 * finishing, a schedule coming due and the retry policy went on starting the project's tasks.
 * Automatic now says who decides for the owner (its coordinator, or the owner), not whether the
 * project moves; this is the one answer to that, read by every door that starts a task on its own:
 *
 *   - the release of a task that depends on nothing (the completion edge and the sweep),
 *   - a prerequisite finishing (the completion edge `dispatchDependentsOf` and the sweep),
 *   - a schedule coming due (`runAt`),
 *   - the retry policy re-arming a task whose run ended,
 *   - and `execute()` itself for every automatic caller, where a scan that read the project before
 *     it was paused stands down instead of starting anything.
 *
 * An agent's `task_start` is refused while the project is paused (`projectPausedRefusal`), as it is
 * while it has not been started (`projectAwaitingStart`). The owner's own Run is not held — a
 * person pressing Run on a task is deciding to run it now — and a run that is already going is not
 * stopped. A task filed under no project is not asked about projects at all.
 *
 * Read off the project row at the moment of the start rather than projected onto the task, for the
 * reason `project-cancelled-dispatch.ts` gives: the row outlives every task filed under it, and there
 * is no second copy to keep in step when the project is resumed.
 */

/** The project row, aliased `project`, moves by itself: started, and not paused. */
export function projectMovesSql(project: string): string {
  return `${project}.started_at IS NOT NULL AND ${project}.paused_at IS NULL`;
}

/**
 * The same, correlated to an outer task: the task is under no project, or under one that moves.
 *
 * Spelled as a permission, like every clause beside it in the candidate predicates. A project row
 * that could not be read would not permit.
 */
export function projectMovesForTaskSql(alias = 't'): string {
  return `(${alias}.project_id IS NULL OR EXISTS (
    SELECT 1 FROM project moving_project
     WHERE moving_project.id = ${alias}.project_id
       AND ${projectMovesSql('moving_project')}
  ))`;
}

/** The two facts, as a row read carries them. */
export interface ProjectMotion {
  startedAt: Date | null;
  pausedAt: Date | null;
}

/** Whether a project with these facts moves by itself. A project that could not be read does not. */
export function projectMoves(project: Partial<ProjectMotion> | null | undefined): boolean {
  return project?.startedAt != null && project.pausedAt == null;
}

/**
 * Why an automatic door stands down for this task's project, or null when the project moves. The
 * run door asks it of every automatic caller before anything with an effect.
 */
export async function projectStandsStill(
  prisma: Pick<PrismaService, 'project'>,
  ownerId: string,
  projectId: string,
): Promise<'project-not-started' | 'project-paused' | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId },
    select: { startedAt: true, pausedAt: true },
  });
  if (projectMoves(project)) return null;
  return project?.startedAt == null ? 'project-not-started' : 'project-paused';
}

export interface PausedProject {
  projectId: string;
  title: string;
  pausedAt: Date;
  reason: ProjectPauseReason;
}

/** The project a task is filed under, when that project is paused. */
export async function pausedProjectOf(
  prisma: Pick<PrismaService, 'project'>,
  ownerId: string,
  projectId: string,
): Promise<PausedProject | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId, pausedAt: { not: null } },
    select: { title: true, pausedAt: true, pausedReason: true },
  });
  if (!project?.pausedAt) return null;
  return {
    projectId,
    title: project.title,
    pausedAt: project.pausedAt,
    reason: project.pausedReason === 'LEGACY_AUTOMATIC_OFF' ? 'LEGACY_AUTOMATIC_OFF' : 'OWNER',
  };
}

/** The 409 an agent's `task_start` gets for a task in a paused project. */
export function projectPausedRefusal(
  taskId: string,
  project: PausedProject,
): { code: 'PROJECT_PAUSED'; message: string } {
  const how = project.reason === 'LEGACY_AUTOMATIC_OFF'
    ? 'Its owner switched Automatic off on an app that pauses the project that way'
    : 'Its owner paused it (Pause project)';
  return {
    code: 'PROJECT_PAUSED',
    message:
      `task ${uuidToBase62(taskId)}: its project “${project.title}” `
      + `(${uuidToBase62(project.projectId)}) is paused. ${how} at ${project.pausedAt.toISOString()}, `
      + 'and while it is paused task_start starts none of its tasks and nothing starts on its own. '
      + 'Do not work around this: tell the owner what is waiting and leave resuming it to them '
      + '(Resume project, on the project page). Runs already going are not stopped.',
  };
}
