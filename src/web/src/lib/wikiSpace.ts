/**
 * The spaces as a reader knows them (design §12.3.3–§12.3.4): what each is called, which one `/wiki`
 * opens when its URL names none, and how much waits on the owner across all of them.
 *
 * RULES OVER THE SPACES LIST (`GET /wiki/spaces`), not over a page, because OrbitKit draws the same
 * three and the two clients are held to one set of cases: `src/shared/src/wiki-space.fixture.json`,
 * which `wikiSpace.test.ts` reads here and OrbitKit's tests read there.
 */
import {
  wikiCountInSpace,
  wikiProposalsToReview,
  wikiSpaceWaiting,
  type WikiSpaceRow,
} from './wiki';

// ── The name ────────────────────────────────────────────────────────────────────────────────────

type Named = Pick<WikiSpaceRow, 'id' | 'title' | 'repoUrlNorm'>;

/**
 * What each space is called, by id: the last segment of its repository (`github.com/jianghailong-xy/orbit`
 * is `orbit`), its title when it has no repository, and — when two spaces would be called the same —
 * the segments before it until the two differ (`jianghailong-xy/orbit`).
 */
export function wikiSpaceNames(spaces: readonly Named[]): Map<string, string> {
  const segments = new Map(spaces.map((space) => [space.id, (space.repoUrlNorm ?? '').split('/').filter(Boolean)]));
  const depth = new Map(spaces.map((space) => [space.id, 1]));
  const nameOf = (space: Named): string => {
    const parts = segments.get(space.id) ?? [];
    return parts.length === 0 ? space.title : parts.slice(-(depth.get(space.id) ?? 1)).join('/');
  };
  for (;;) {
    const named = new Map<string, Named[]>();
    for (const space of spaces) named.set(nameOf(space), [...(named.get(nameOf(space)) ?? []), space]);
    const longer = [...named.values()]
      .filter((same) => same.length > 1)
      .flat()
      .filter((space) => (depth.get(space.id) ?? 1) < (segments.get(space.id)?.length ?? 0));
    if (longer.length === 0) break;
    for (const space of longer) depth.set(space.id, (depth.get(space.id) ?? 1) + 1);
  }
  return new Map(spaces.map((space) => [space.id, nameOf(space)]));
}

// ── Which space `/wiki` opens ───────────────────────────────────────────────────────────────────

/**
 * The space `/wiki` opens: the one bound to the workspace the reader is in (`workspaceIds`), else the
 * one they last looked at, else the one with the most documents written — the first of the server's
 * list when that is a tie. `/wiki/:space` names its own and never asks.
 */
export function wikiDefaultSpace<T extends Pick<WikiSpaceRow, 'slug' | 'workspaceIds' | 'docs'>>(
  spaces: readonly T[],
  context: { workspaceId: string | null; lastSlug: string | null },
): T | null {
  const { workspaceId, lastSlug } = context;
  const bound = workspaceId ? spaces.find((space) => (space.workspaceIds ?? []).includes(workspaceId)) : undefined;
  if (bound) return bound;
  const last = lastSlug ? spaces.find((space) => space.slug === lastSlug) : undefined;
  if (last) return last;
  return spaces.reduce<T | null>(
    (most, space) => (most === null || (space.docs?.written ?? 0) > (most.docs?.written ?? 0) ? space : most),
    null,
  );
}

/** Where the reader's last look and the workspace they came from are kept. */
export const WIKI_LAST_SPACE_KEY = 'orbit:wiki:space';
export const WIKI_FROM_WORKSPACE_KEY = 'orbit:wiki:workspace';

/** The slug of the space the reader last looked at, kept in the browser. */
export function readWikiLastSpace(): string | null {
  try {
    return localStorage.getItem(WIKI_LAST_SPACE_KEY);
  } catch {
    return null;
  }
}

export function writeWikiLastSpace(slug: string): void {
  try {
    localStorage.setItem(WIKI_LAST_SPACE_KEY, slug);
  } catch {
    // Storage turned off: `/wiki` falls through to the space with the most documents.
  }
}

/**
 * The workspace the reader was in before they opened the Wiki: the sidebar's active workspace, or a
 * project's coordinator workspace on a project's page — and nothing after a page that is neither (the
 * Projects or Tasks list), which leaves the choice to the last look. Kept for this tab alone, because
 * it says where THIS tab came from.
 */
export function readWikiFromWorkspace(): string | null {
  try {
    return sessionStorage.getItem(WIKI_FROM_WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export function writeWikiFromWorkspace(workspaceId: string | null): void {
  try {
    if (workspaceId) sessionStorage.setItem(WIKI_FROM_WORKSPACE_KEY, workspaceId);
    else sessionStorage.removeItem(WIKI_FROM_WORKSPACE_KEY);
  } catch {
    // Storage turned off: `/wiki` falls through to the last look.
  }
}

// ── What waits on the owner ─────────────────────────────────────────────────────────────────────

type Counted = Pick<WikiSpaceRow, 'pendingOps' | 'planWaiting'>;

/** What waits on the owner in one space: its proposals in Review and the things its plan waits on them for. */
export function wikiWaitingIn(space: Counted): number {
  return (space.pendingOps ?? 0) + (space.planWaiting ?? 0);
}

/**
 * What waits on the owner across every space (§12.3.3): the sidebar's Wiki count and the head's
 * Activity badge, both from here — and what Activity's amber banners add up to.
 */
export function wikiWaiting(spaces: readonly Counted[]): number {
  return spaces.reduce((sum, space) => sum + wikiWaitingIn(space), 0);
}

/** The proposals alone, across every space: Activity's first banner, and Review's head on its own route. */
export function wikiProposalsWaiting(spaces: readonly Counted[]): number {
  return spaces.reduce((sum, space) => sum + (space.pendingOps ?? 0), 0);
}

/**
 * Activity's first banner (mock 31 ⑤): every space's proposals, with each other space's share on the
 * same line — `3 proposals to review · 2 in wikova` — and nothing after the count when they are all the
 * current space's. Null with none waiting anywhere.
 */
export function wikiProposalsBanner(
  spaces: ReadonlyArray<Named & Counted>,
  currentId: string,
  names: ReadonlyMap<string, string> = wikiSpaceNames(spaces),
): string | null {
  const total = wikiProposalsWaiting(spaces);
  if (total === 0) return null;
  const elsewhere = spaces
    .filter((space) => space.id !== currentId && (space.pendingOps ?? 0) > 0)
    .map((space) => wikiCountInSpace(space.pendingOps, names.get(space.id) ?? space.title));
  return [wikiProposalsToReview(total), ...elsewhere].join(' ');
}

/** A space as the picker lists it (mock 31 ④): its name, and what waits in it when anything does. */
export function wikiSpaceOption(name: string, space: Counted): string {
  const waiting = wikiWaitingIn(space);
  return waiting > 0 ? `${name} ${wikiSpaceWaiting(waiting)}` : name;
}
