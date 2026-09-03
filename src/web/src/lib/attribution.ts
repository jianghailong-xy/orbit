/**
 * Unit L7: the attribution boundary, as the web app reads it.
 *
 * Types only, plus the two things a screen legitimately decides — how to LABEL a value the server
 * already computed, and how to sort a queue. Nothing here re-derives a fact: whether a PASS is
 * current, which code a crossing refuses with and what a reopen would cost are all decided by
 * `project-attribution-surface.ts` on the server, precisely so the web app, the CLI and anything
 * after them cannot answer them differently.
 *
 * §5 of the project's stated criteria is why the labels are here at all: a screen must not leave the
 * meaning of a state to colour or to prose. Every state below has a WORD, and the word comes from
 * a closed map keyed by a value the server sent — so a state nobody wrote a label for renders as
 * the raw code rather than as an empty chip that looks like "fine".
 */

export type AttributionProjectStatus = 'OPEN' | 'DONE' | 'CANCELLED';

export interface AttributionProjectRef {
  projectId: string;
  /** The Base62 twin `PublicIdInterceptor` adds. Optional: an older server sends only the uuid. */
  projectPublicId?: string;
  title: string;
  status: AttributionProjectStatus;
}

export interface AttributionDiscovery {
  project: AttributionProjectRef | null;
  triggerEvent: string | null;
  task: { taskId: string; taskPublicId?: string; title: string } | null;
  session: { sessionId: string; sessionPublicId?: string; title: string | null } | null;
  recorded: boolean;
  absentReason: string | null;
  authority: 'EVIDENCE_ONLY';
}

export type CrossingState = 'PENDING' | 'APPROVED' | 'DENIED' | 'APPLIED';

export interface AttributionCrossing {
  handoffId: string;
  handoffPublicId?: string;
  kind: string;
  state: CrossingState;
  from: AttributionProjectRef | null;
  to: AttributionProjectRef | null;
  subjectTaskId: string | null;
  crossingKey: string;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  code: string | null;
  requiredAction: string | null;
}

export interface AttributionBlocker {
  blockerId: string;
  kind: string;
  owner: string;
  requiredAction: string;
  nextCheckAt: string;
  code: string | null;
}

export interface TaskAttribution {
  taskId: string;
  owning: AttributionProjectRef | null;
  owningAbsentReason: string | null;
  discovery: AttributionDiscovery;
  crossing: AttributionCrossing | null;
  crossingAbsentReason: string | null;
  blocker: AttributionBlocker | null;
  blockerAbsentReason: string | null;
}

/** One row of `GET /projects/:id/handoffs` — a declared crossing, from either end. */
export interface ProjectCrossingRow {
  id: string;
  publicId?: string;
  fromProjectId: string;
  fromProjectPublicId?: string;
  toProjectId: string;
  toProjectPublicId?: string;
  fromProject?: { title: string; status: AttributionProjectStatus } | null;
  toProject?: { title: string; status: AttributionProjectStatus } | null;
  kind: string;
  subjectTaskId: string | null;
  subjectTaskPublicId?: string;
  crossingKey: string;
  state: CrossingState;
  title: string;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
}

/**
 * The id a person can read and paste. Base62 when the server sent it, the raw uuid otherwise.
 *
 * The fallback is not cosmetic: a mixed-version deployment serves the uuid alone, and a card that
 * rendered nothing in that case would drop the very field AC1 requires be visible before submit.
 */
export function publicIdOf(row: { projectId: string; projectPublicId?: string }): string {
  return row.projectPublicId ?? row.projectId;
}

/** What a crossing's state is CALLED. Closed map; anything unlisted renders as its own code. */
export const CROSSING_STATE_LABEL: Readonly<Record<CrossingState, string>> = {
  PENDING: 'Waiting for your answer',
  APPROVED: 'Approved, not yet applied',
  DENIED: 'Refused',
  APPLIED: 'Applied',
};

/**
 * What each state means for the reader, in one clause. Beside the label rather than instead of it:
 * the label says what the row IS and this says what follows from it.
 */
export const CROSSING_STATE_MEANING: Readonly<Record<CrossingState, string>> = {
  PENDING: 'the work is not filed anywhere until you answer',
  APPROVED: 'the writer may now file it; it has not been filed yet',
  DENIED: 'refusing is final for this crossing — file the work yourself if you change your mind',
  APPLIED: 'this answer has been spent; it authorises nothing further',
};

/** Why a fact is absent. A screen that printed nothing here would read as "there is none". */
export const ABSENT_REASON_LABEL: Readonly<Record<string, string>> = {
  FILED_UNDER_NO_PROJECT: 'This task is filed under no project.',
  NO_DISCOVERY_RECORDED: 'Nothing was recorded about where this work was noticed.',
  NO_CROSSING_DECLARED: 'No declared crossing touches this task.',
  NOTHING_BLOCKING_ATTRIBUTION: 'Nothing is blocking where this work counts.',
};

/** The label for a code, falling back to the code itself — never to silence. */
export function labelFor(map: Readonly<Record<string, string>>, code: string | null): string {
  if (!code) return '';
  return map[code] ?? code;
}

/**
 * The crossings that are still questions, oldest first, then everything else newest first.
 *
 * Two orders in one list because they are read for two reasons: a PENDING row is work waiting on
 * the reader, and the one that has waited longest is the one holding up the most; an answered row
 * is history, and history reads newest first.
 */
export function orderCrossings(rows: readonly ProjectCrossingRow[]): ProjectCrossingRow[] {
  const pending = rows.filter((row) => row.state === 'PENDING');
  const answered = rows.filter((row) => row.state !== 'PENDING');
  pending.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  answered.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return [...pending, ...answered];
}
