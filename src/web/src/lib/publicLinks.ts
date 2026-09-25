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
