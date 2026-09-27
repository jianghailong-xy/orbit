import { ProjectStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * A cancelled project's tasks do not start.
 *
 * Cancelling a project is its owner saying the goal is no longer being pursued, and the goal is
 * what its tasks are FOR — so no door starts one of them: not the ready sweep, not the independent
 * release, not a schedule coming due, not the retry policy, not Run Now, bulk Run or `task_start`.
 * A run already going is not stopped, and nothing is deleted; reopening the project lifts it.
 *
 * Read off the project row at the moment of the start rather than projected onto the task like a
 * paused list's `dispatch_hold`. That column exists because a list can be deleted and a stop that
 * lived only on its row went with it; a project cannot be deleted while a task is filed under it
 * (`task.project_id` is ON DELETE RESTRICT), so the row this reads outlives every task it holds,
 * and there is no second copy of the status to keep in step when the project is reopened.
 *
 * Spelled as a permission, like every clause beside it: the task is under no project, or under one
 * whose status is not CANCELLED. A project row that could not be read would not permit.
 */
export function projectNotCancelledSql(alias = 't'): string {
  return `(${alias}.project_id IS NULL OR EXISTS (
    SELECT 1 FROM project dispatch_project
     WHERE dispatch_project.id = ${alias}.project_id
       AND dispatch_project.status <> 'CANCELLED'::project_status
  ))`;
}

export interface CancelledProject {
  projectId: string;
  title: string;
}

/** The project a task is filed under, when that project has been cancelled. */
export async function cancelledProjectOf(
  prisma: Pick<PrismaService, 'project'>,
  ownerId: string,
  projectId: string,
): Promise<CancelledProject | null> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, ownerId, status: ProjectStatus.CANCELLED },
    select: { title: true },
  });
  return project ? { projectId, title: project.title } : null;
}

/** The 409 a person's Run, or an agent's `task_start`, gets for a task in a cancelled project. */
export function projectCancelledRefusal(
  taskId: string,
  project: CancelledProject,
): { code: 'PROJECT_CANCELLED'; message: string } {
  return {
    code: 'PROJECT_CANCELLED',
    message:
      `task ${uuidToBase62(taskId)}: its project “${project.title}” `
      + `(${uuidToBase62(project.projectId)}) was cancelled, so its tasks do not start. `
      + 'Reopen the project to run it.',
  };
}
