// Project sectioning for the workspace console's Open list, the structural half of the attention
// inbox: a conversation is filed under the project it serves rather than under the day it last
// ran, so the column's length tracks how many projects are in flight instead of how many sessions
// exist. Same pure shape as sessionGrouping's two groupers — an already console-sorted list in,
// buckets out, never a reorder within a bucket — and it delegates to `sessionTimeSections` for the
// trailing Unfiled region, which keeps the recency sections it always had.

import {
  sessionTimeSections,
  type GroupableSession,
  type SessionTimeSection,
} from './sessionGrouping';
import {
  sessionLifecycleStateOf,
  sessionRunStateOf,
  type SessionStateSource,
} from './sessionState';

/** What the grouper reads off a session row, on top of what the time grouper already reads. */
export interface ProjectGroupableSession extends GroupableSession {
  // Served on every list row (SessionsService.list): the project of the session's task, or the
  // project this session coordinates. Null for a conversation the user simply started.
  projectId?: string | null;
  projectTitle?: string | null;
}

/** One project's session tallies, as `GET /sessions/project-counts` serves them. */
export interface ProjectCounts {
  needsYou: number;
  running: number;
  done: number;
  total: number;
}

// Keys for the two groups that are not a project, so collapse state can name all three kinds in
// one set. Neither can collide with a project id, which is base62 and never contains an underscore.
export const PINNED_GROUP_KEY = '__pinned__';
export const UNFILED_GROUP_KEY = '__unfiled__';

/** A run of rows inside a group, with the recency heading Unfiled keeps (null: heading-less). */
export interface ProjectSubsection<T> {
  title: string | null;
  sessions: T[];
}

export interface ProjectSection<T> {
  /** Stable across renders and reloads — this is what a persisted collapse state stores. */
  key: string;
  /** The project this group is, or null for Pinned and Unfiled. */
  projectId: string | null;
  title: string;
  /** The header badge's tallies. Null for Pinned/Unfiled (not projects), and while the
   *  per-project counts are still in flight. Kept even while collapsed — the whole point of
   *  rolling a project up is that its header still says someone is waiting on you. */
  counts: ProjectCounts | null;
  collapsed: boolean;
  /** Rows the group holds, collapsed or not. */
  count: number;
  /** The rows to render, empty while collapsed — so a caller flattening these to walk what is
   *  actually on screen (cursor movement, "open the next one") never lands inside a rolled-up
   *  group. */
  sections: ProjectSubsection<T>[];
}

/** Index `GET /sessions/project-counts` by project, for the lookup the grouper wants. */
export function projectCountsById(
  rows: readonly (ProjectCounts & { projectId: string })[] | null | undefined,
): Map<string, ProjectCounts> {
  return new Map(
    (rows ?? []).map((r) => [
      r.projectId,
      { needsYou: r.needsYou, running: r.running, done: r.done, total: r.total },
    ]),
  );
}

/**
 * Bucket a console-sorted list into one section per project, then a trailing "Unfiled" section for
 * the sessions that belong to none — internally still sectioned by recency, since without a project
 * to file it under, when it last ran is all the structure a conversation has.
 *
 * Projects appear in the order the list first mentions them, which over a recency-sorted list means
 * most-recently-active project first: no separate ordering rule to keep in step with the server's.
 *
 * When `pinnedFirst` (the Open view, where pinning applies) pinned sessions lift into a leading
 * "Pinned" group ahead of every project, exactly as they lift above the recency sections today —
 * a pin means "keep this at the top of the list", and a pinned row that sank into a rolled-up
 * project group would be further from the top than before it was pinned.
 *
 * `counts` and `collapsed` are the two facts the grouper cannot derive from the rows: the tallies
 * are a server rollup over sessions this page has not loaded, and collapse is the user's. `now` is
 * injectable for deterministic tests, as in sessionGrouping.
 */
export function sessionProjectSections<T extends ProjectGroupableSession>(
  sessions: readonly T[],
  opts: {
    counts?: ReadonlyMap<string, ProjectCounts> | null;
    collapsed?: ReadonlySet<string> | null;
    pinnedFirst?: boolean;
    now?: Date;
  } = {},
): ProjectSection<T>[] {
  const { counts = null, collapsed = null, pinnedFirst = true, now } = opts;
  const pinned: T[] = [];
  const unfiled: T[] = [];
  // Insertion-ordered, which is what makes "first mentioned" the group order.
  const projects = new Map<string, { title: string | null; sessions: T[] }>();

  for (const s of sessions) {
    if (pinnedFirst && s.pinnedAt) {
      pinned.push(s);
      continue;
    }
    if (!s.projectId) {
      unfiled.push(s);
      continue;
    }
    let g = projects.get(s.projectId);
    if (!g) {
      g = { title: s.projectTitle ?? null, sessions: [] };
      projects.set(s.projectId, g);
    }
    // A row that names the project wins over one that only carries the id, so a group is never
    // left titleless because its first row happened to be the incomplete one.
    g.title ??= s.projectTitle ?? null;
    g.sessions.push(s);
  }

  const isCollapsed = (key: string): boolean => collapsed?.has(key) ?? false;
  const out: ProjectSection<T>[] = [];

  if (pinned.length) {
    out.push(group(PINNED_GROUP_KEY, null, 'Pinned', null, isCollapsed(PINNED_GROUP_KEY), [
      { title: null, sessions: pinned },
    ]));
  }
  for (const [projectId, g] of projects) {
    out.push(
      group(
        projectId,
        projectId,
        g.title ?? 'Untitled project',
        counts?.get(projectId) ?? null,
        isCollapsed(projectId),
        [{ title: null, sessions: g.sessions }],
      ),
    );
  }
  if (unfiled.length) {
    // Pins were already lifted (or deliberately not lifted, under a tag filter); either way this
    // grouper has settled them, so the recency pass must not lift a second time.
    const timed: SessionTimeSection<T>[] = sessionTimeSections(unfiled, {
      pinnedFirst: false,
      now,
    });
    out.push(
      group(
        UNFILED_GROUP_KEY,
        null,
        'Unfiled',
        null,
        isCollapsed(UNFILED_GROUP_KEY),
        timed.map((t) => ({ title: t.title, sessions: t.sessions })),
      ),
    );
  }
  return out;
}

function group<T>(
  key: string,
  projectId: string | null,
  title: string,
  counts: ProjectCounts | null,
  collapsed: boolean,
  sections: ProjectSubsection<T>[],
): ProjectSection<T> {
  return {
    key,
    projectId,
    title,
    counts,
    collapsed,
    count: sections.reduce((n, s) => n + s.sessions.length, 0),
    sections: collapsed ? [] : sections,
  };
}

export interface ProjectBadgePart {
  kind: 'needsYou' | 'running' | 'done';
  text: string;
}

/**
 * The group header's rollup, "2 needs you · 1 running · 5/9 done". The two live tallies are dropped
 * at zero — an idle project should not spend header width saying nothing is happening — while the
 * done ratio always shows, being the group's progress rather than an event. The three buckets are
 * disjoint server-side, so they read as parts of one whole.
 */
export function projectBadgeParts(counts: ProjectCounts): ProjectBadgePart[] {
  const parts: ProjectBadgePart[] = [];
  if (counts.needsYou > 0) parts.push({ kind: 'needsYou', text: `${counts.needsYou} needs you` });
  if (counts.running > 0) parts.push({ kind: 'running', text: `${counts.running} running` });
  parts.push({ kind: 'done', text: `${counts.done}/${counts.total} done` });
  return parts;
}

/**
 * How many rows one project group renders before the rest folds behind a single line. Five is
 * what a group can spend and still leave the next project on screen — the column's job is to say
 * which projects want a person, and a project that answers that with twenty finished workers has
 * answered it nineteen times too often.
 */
export const PROJECT_ACTIVE_FACE_LIMIT = 5;

/**
 * What the active face reads off a row, on top of what the grouper already reads: the same three
 * facts the server counts a project's rollup from, all served on every list row.
 */
export interface ProjectFaceSession extends ProjectGroupableSession, SessionStateSource {
  /** What this session IS to its project, as `SessionsService.list` derives it. */
  role?: string | null;
  /** Live approvals; > 0 is what "waiting on you" means, here and in the rollup. */
  pendingApprovals?: number | null;
  /** A turn the runtime started for itself, which streams while parked at AWAITING_INPUT. */
  engineTurnActive?: boolean | null;
}

export interface ProjectActiveFace<T> {
  /** The rows to render, Main first, then everything waiting on you, then what is running. */
  visible: T[];
  /** Rows the face left out — 0 when the group is already entirely on screen. */
  hiddenCount: number;
  /** Finished rows across the whole group, the visible ones included: the fold line's "M done". */
  doneCount: number;
}

// The buckets, spelled for the client exactly as `SessionsService.projectSessionCounts` spells
// them in SQL, so a group's face and its header rollup cannot disagree about what a row is doing:
// a session is open until it is filed (completed_at/archived_at), generating while the engine is
// producing for it — including a self-driven turn parked at AWAITING_INPUT — and needs you when a
// live approval is holding it. Done is the two ways a conversation is finished: filed, or
// succeeded and not filed yet. A failed run is neither done nor active; it folds with the rest.
const isOpen = (s: ProjectFaceSession): boolean => sessionLifecycleStateOf(s) === 'OPEN';
const isGenerating = (s: ProjectFaceSession): boolean => {
  const state = sessionRunStateOf(s);
  return state === 'RUNNING' || (state === 'AWAITING_INPUT' && s.engineTurnActive === true);
};
const needsYou = (s: ProjectFaceSession): boolean =>
  isOpen(s) && isGenerating(s) && (s.pendingApprovals ?? 0) > 0;
const isDone = (s: ProjectFaceSession): boolean =>
  !isOpen(s) || sessionRunStateOf(s) === 'SUCCEEDED';

/**
 * The part of a project group worth rendering by default, and what folding the rest away costs.
 *
 * A project group is not a list of its sessions — it is the answer to "does this project want
 * something from me right now", and only three kinds of row carry that answer: the coordinator
 * (the way into the project, whatever it is doing), every conversation blocked on an approval,
 * and what is running. Finished workers are the group's history; they are what `doneCount` is for.
 *
 * The limit binds the running rows only. Main and everything waiting on you are in the face
 * whatever it says — a folded approval is an approval nobody answers, which is the failure this
 * whole list exists to end — so a project with six live prompts shows six rows and no running
 * ones. Emitted in tier order (Main → waiting → running) rather than in the order handed in, so
 * the face reads the same before and after the in-group sort lands; each tier keeps the console's
 * order internally, and no row is moved between tiers.
 */
export function projectActiveFace<T extends ProjectFaceSession>(
  rows: readonly T[],
  opts: { limit?: number } = {},
): ProjectActiveFace<T> {
  const limit = opts.limit ?? PROJECT_ACTIVE_FACE_LIMIT;
  const main: T[] = [];
  const waiting: T[] = [];
  const running: T[] = [];
  let doneCount = 0;

  for (const s of rows) {
    if (isDone(s)) doneCount++;
    // One bucket per row, in the order the identities outrank each other: coordinating the
    // project is what the row IS, and a coordinator waiting on you is still the group's Main.
    if (s.role === 'coordinator') main.push(s);
    else if (needsYou(s)) waiting.push(s);
    else if (isOpen(s) && isGenerating(s)) running.push(s);
  }

  const visible = [...main, ...waiting];
  for (const s of running) {
    if (visible.length >= limit) break;
    visible.push(s);
  }
  return { visible, hiddenCount: rows.length - visible.length, doneCount };
}

/**
 * The fold line under a capped group: "View all 12 · 7 done" — how many rows the group actually
 * holds, and how much of that is finished work, which is what the user is being told they are not
 * missing. The count is of loaded rows, not of the project (the header's rollup already speaks for
 * the whole project). "0 done" is dropped: a group hiding nothing finished is hiding live rows,
 * and saying "0 done" spends a word to describe an empty set.
 */
export const projectFoldLabel = (face: ProjectActiveFace<unknown>): string => {
  const total = face.visible.length + face.hiddenCount;
  return face.doneCount > 0 ? `View all ${total} · ${face.doneCount} done` : `View all ${total}`;
};
