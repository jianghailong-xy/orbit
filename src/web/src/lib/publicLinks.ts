import { createContext } from 'react';
import { routeId } from './idCodec';

/** The objects a public page can have an address for. */
export type PublicLinkKind = 'task' | 'project' | 'session';

/**
 * Where a public page sends a link to one of this deployment's objects: that object's public
 * address when it is inside what the link shares, or null when it is not — and then the link is
 * drawn as its words alone. `id` is the object's public id.
 */
export type PublicLinkResolver = (target: { kind: PublicLinkKind; id: string }) => string | null;

/**
 * The resolver of the public page a transcript is drawn on (SharedSessionPage). Null everywhere in
 * the app, whose links go to its own routes. A public page is read signed out, where every one of
 * those routes (`/tasks/…`, `/projects/…`, `/sessions/…`, `/following`, …) ends at the sign-in
 * page — so under a resolver the two link primitives, AppLink and SameOriginLink, ask it instead
 * of linking there (see publicDestination).
 */
export const PublicLinkResolverCtx = createContext<PublicLinkResolver | null>(null);

/**
 * The resolver of a task link's pages (the task page and the conversations under it): the task
 * itself goes to the link's root page, and each of its runs the link opens goes to its conversation
 * page. Nothing else a task names is shared — not its project, not the tasks it depends on, not
 * another task's runs — so everything else is words. Ids in either spelling; `runSessionIds` holds
 * only the runs the link opens, so with Conversations off it is empty.
 */
export function taskLinkResolver(
  token: string,
  scope: { taskId: string; runSessionIds: readonly string[] },
): PublicLinkResolver {
  const taskId = routeId(scope.taskId);
  const runs = new Set(scope.runSessionIds.map((id) => routeId(id)));
  const root = `/s/${encodeURIComponent(token)}`;
  return ({ kind, id }) => {
    const target = routeId(id);
    if (kind === 'task' && target === taskId) return root;
    if (kind === 'session' && target && runs.has(target)) return `${root}/c/${target}`;
    return null;
  };
}

/**
 * The resolver of a project link's pages (the project page, its task pages and its conversations):
 * the project goes to the link's root page, each of its tasks the link opens (Task pages) to its
 * task page, and each conversation it opens (Conversations: its tasks' runs and its coordinator) to
 * its conversation page. Everything else — another project, a task or conversation outside it, a
 * layer that is off — is words. The two lists are the link's `scope`, which every page of it
 * carries; ids in either spelling.
 */
export function projectLinkResolver(
  token: string,
  scope: { projectId: string; taskIds: readonly string[]; sessionIds: readonly string[] },
): PublicLinkResolver {
  const projectId = routeId(scope.projectId);
  const tasks = new Set(scope.taskIds.map((id) => routeId(id)));
  const sessions = new Set(scope.sessionIds.map((id) => routeId(id)));
  const root = `/s/${encodeURIComponent(token)}`;
  return ({ kind, id }) => {
    const target = routeId(id);
    if (!target) return null;
    if (kind === 'project' && target === projectId) return root;
    if (kind === 'task' && tasks.has(target)) return `${root}/t/${target}`;
    if (kind === 'session' && sessions.has(target)) return `${root}/c/${target}`;
    return null;
  };
}

const OBJECT_ROUTE = /^\/(tasks|projects|sessions)\/([^/?#]+)\/?(?:[?#].*)?$/;
const OBJECT_KIND: Record<string, PublicLinkKind> = { tasks: 'task', projects: 'project', sessions: 'session' };

/**
 * Where an in-app destination goes on a public page. A public page's own address (`/s/…`) stays
 * as it is; a task's, project's or session's page goes wherever `resolve` sends it; every other
 * route of the app goes nowhere. Null means: draw the words, not a link.
 */
export function publicDestination(to: string, resolve: PublicLinkResolver): string | null {
  if (to.startsWith('/s/')) return to;
  const m = OBJECT_ROUTE.exec(to);
  if (!m) return null;
  let id: string | null;
  try {
    id = routeId(decodeURIComponent(m[2]));
  } catch {
    id = null; // a malformed escape: not an address this page can name
  }
  return id ? resolve({ kind: OBJECT_KIND[m[1]], id }) : null;
}
