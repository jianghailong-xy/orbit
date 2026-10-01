import { useCallback } from 'react';
import { matchPath, useLocation, useNavigate, type Location } from 'react-router-dom';
import { routeId } from './idCodec';

/**
 * Where a project's task opens: over its project's page.
 *
 * The Tasks page lists only the tasks filed under no project (its browsing views send
 * `projectId=none`), and says in so many words that a project's tasks are on their project's page.
 * A task of a project opened anywhere else is opened over a list it is not in — the Tasks section
 * lit in the sidebar, "Tasks outside projects" behind it, and ✕ landing on that list instead of on
 * the project the reader came from. So the address of a project's task names its project, and the
 * project's page is what stands behind the panel.
 */
export const PROJECT_TASK_ROUTE = '/projects/:id/tasks/:taskId';

/** Either spelling of either id; an id neither spelling can read is sent as it came, so a malformed
 *  one reaches the page's own "not found" instead of throwing while a link is being drawn. */
export function projectTaskPath(projectId: string, taskId: string): string {
  const project = routeId(projectId) ?? projectId;
  const task = routeId(taskId) ?? taskId;
  return `/projects/${encodeURIComponent(project)}/tasks/${encodeURIComponent(task)}`;
}

/** The history state a task opened from its project's page carries: the entry under it is that page. */
export interface ProjectTaskHistoryState {
  projectTaskOverPage: true;
}

function openedOverPage(state: unknown): boolean {
  return (state as Partial<ProjectTaskHistoryState> | null)?.projectTaskOverPage === true;
}

/**
 * How a press inside a project's page opens one of its tasks: the destination, and whether it is a
 * new history entry.
 *
 * From the page itself it is one — on a phone the task fills the screen, and the system back
 * gesture is what closes a screen. From a task already open over the page it replaces that one, so
 * Back never walks back through every task looked at (the Tasks page's panel rule), and the state
 * rides along so ✕ still knows the page is the entry underneath.
 */
export function projectTaskLink(location: Location, projectId: string, taskId: string) {
  const to = projectTaskPath(projectId, taskId);
  return matchPath(PROJECT_TASK_ROUTE, location.pathname)
    ? { to, replace: true, state: location.state as unknown }
    : { to, replace: false, state: { projectTaskOverPage: true } satisfies ProjectTaskHistoryState };
}

/** Open one of `projectId`'s tasks over its page, by `projectTaskLink`'s rule. */
export function useOpenProjectTask(projectId: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (taskId: string) => {
      const link = projectTaskLink(location, projectId, taskId);
      navigate(link.to, { replace: link.replace, state: link.state });
    },
    [location, navigate, projectId],
  );
}

/**
 * Close the task open over `projectId`'s page. Opened from the page, the entry underneath IS the
 * page, so closing is going back to it — and a later Back does not reopen the task. Opened any other
 * way (a link pasted in, a chat reference) there is no such entry, so the page takes the task's
 * place.
 */
export function useCloseProjectTask(projectId: string) {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (openedOverPage(location.state)) navigate(-1);
    else navigate(`/projects/${encodeURIComponent(projectId)}`, { replace: true });
  }, [location.state, navigate, projectId]);
}
