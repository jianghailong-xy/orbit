import { useCallback, useEffect } from 'react';
import { matchPath, useLocation, useNavigate, type Location } from 'react-router-dom';
import { routeId } from './idCodec';

/**
 * A task link opens where it was pressed (owner 2026-11-12).
 *
 * A link to a task — a chat reference, a card in a conversation, a watch line, a notification — is
 * `/tasks/<id>`, and that address sends a project's task to its project's page (TaskRoute). Pressed
 * inside a conversation, that took the reader out of the conversation, and ✕ left them on the
 * project page. Now a press on such a link anywhere but a task's own homes opens the task over the
 * page it was pressed on, as `?task=<id>` on that page's address: ✕ and Back return to the page as
 * it was, and the panel's project line is the way to the project.
 *
 * The homes keep their own rule: the Tasks page's routes open a task over their list, and a
 * project's page opens its tasks over itself. A pasted `/tasks/<id>` has no page under it, so it
 * still goes to TaskRoute.
 */
export const TASK_PARAM = 'task';

const HOMES = ['/tasks', '/tasks/:id', '/lists/:key', '/projects/:id', '/projects/:id/tasks/:taskId'];

/** Whether `pathname` is a page that already opens tasks over itself by its own route. */
export function isTaskHome(pathname: string): boolean {
  return HOMES.some((pattern) => matchPath(pattern, pathname) != null);
}

/** The task a same-origin `/tasks/<id>` link names, or null for any other link. A link carrying a
 *  query (`?list=` names a list to open it over) or a fragment means more than "this task". */
export function linkedTaskId(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.search || url.hash) return null;
  const match = /^\/tasks\/([^/]+)\/?$/.exec(url.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The history state a task opened over a page carries: the entry under it is that page. */
interface TaskOverPageState {
  taskOverPage: true;
}

function openedOverPage(state: unknown): boolean {
  return (state as Partial<TaskOverPageState> | null)?.taskOverPage === true;
}

/** `location` with `taskId` open over it. */
function withTask(location: Location, taskId: string | null) {
  const search = new URLSearchParams(location.search);
  if (taskId) search.set(TASK_PARAM, routeId(taskId) ?? taskId);
  else search.delete(TASK_PARAM);
  const query = search.toString();
  return { pathname: location.pathname, search: query ? `?${query}` : '', hash: location.hash };
}

/** The task open over this page, if any. */
export function useTaskOverPage(): string | null {
  const location = useLocation();
  const raw = new URLSearchParams(location.search).get(TASK_PARAM);
  return raw ? (routeId(raw) ?? raw) : null;
}

/**
 * Open a task over this page. From the page itself it is a new history entry, so Back closes it;
 * from a task already open it replaces that one, so Back never walks through every task looked at.
 */
export function useOpenTaskOverPage() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (taskId: string) => {
      const already = new URLSearchParams(location.search).has(TASK_PARAM);
      navigate(withTask(location, taskId), {
        replace: already,
        state: already ? location.state : ({ taskOverPage: true } satisfies TaskOverPageState),
      });
    },
    [location, navigate],
  );
}

/** Close the task open over this page: back to the entry under it, or — opened by an address — the
 *  page's own address in its place. */
export function useCloseTaskOverPage() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (openedOverPage(location.state)) navigate(-1);
    else navigate(withTask(location, null), { replace: true });
  }, [location, navigate]);
}

/**
 * Turn every plain press on a `/tasks/<id>` link outside the task homes into "open it over this
 * page". One listener on the document, in the capture phase, so every way a link is drawn — a
 * router `<Link>`, an `AppLink`, a Markdown reference, a plain `<a>` — gets the same rule without
 * each one being taught it. A modified press (⌘, Ctrl, Shift, middle button) is left to the browser:
 * a new tab is still the task's own address.
 */
export function useTaskLinksOpenInPlace() {
  const location = useLocation();
  const open = useOpenTaskOverPage();
  useEffect(() => {
    if (isTaskHome(location.pathname)) return;
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const taskId = linkedTaskId(anchor.getAttribute('href')!, window.location.origin);
      if (!taskId) return;
      event.preventDefault();
      event.stopPropagation();
      open(taskId);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [location.pathname, open]);
}
