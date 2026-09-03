/**
 * Unit L7: what a person is shown about where a piece of work counts, who noticed it, and what a
 * crossing would cost.
 *
 * L1 froze the rules, L3 enforced them and L4 gave a crossing a door. Every one of those refusals
 * is correct and none of them is VISIBLE: the target project is an id in an error body and the
 * discovery source is four columns nothing reads back. A boundary the writer only meets by being
 * refused is a boundary the writer learns about after they have already decided what to do.
 *
 * So this module is the DERIVATION, once, for every client. Pure: no clock, no database, no Nest.
 * The service layer reads rows and hands them here; the web app, the CLI and any client after them
 * render what comes back. That direction is the point — several clients each deriving the same
 * answer from raw columns is several chances to disagree, and the disagreement would show up as
 * two screens saying different things about the same row.
 *
 * Migration 0229 removed the project acceptance judgment, so the acceptance lane of this surface —
 * which criterion cites this task, what a run concluded about it, and whether that conclusion is
 * still current — went with the rows it derived from. What a criterion SAYS is still readable, on
 * the project it belongs to.
 *
 * TWO RULES THIS FILE IS CAREFUL ABOUT
 * ------------------------------------
 *   - §3 SC7: the discovery source is EVIDENCE. It is rendered beside the authoritative
 *     attribution and never instead of it, and `authority: 'EVIDENCE_ONLY'` is emitted next to it
 *     rather than left to a caption somebody may drop. "Where this was noticed" reading like
 *     "where this belongs" is the incident §0 exists for, one screen later.
 *   - An absent fact is null WITH a reason (§7's absent-reason convention). "This task has no
 *     crossing declared about it" and "this build cannot tell you" are different answers, and a
 *     missing field says neither.
 */

import type { ScopeProjectStatus, ScopeRefusalCode, ScopeRequiredAction } from './project-scope-contract';

/** A project, as every attribution surface names one: the title a person reads and the id they
 *  paste. Base62 twins are added on the way out by `PublicIdInterceptor` (`projectId` is on the
 *  allowlist), so nothing here spells an id twice. */
export interface AttributionProjectRef {
  projectId: string;
  title: string;
  status: ScopeProjectStatus;
}

/** Why a fact below is null. A closed set, so a client can branch on it instead of on prose. */
export const ATTRIBUTION_ABSENT_REASONS = [
  /** The task is filed under no project at all — legal, and not the same as unreadable. */
  'FILED_UNDER_NO_PROJECT',
  /** Nothing was recorded about where this work was noticed. */
  'NO_DISCOVERY_RECORDED',
  /** No declared crossing touches this task. */
  'NO_CROSSING_DECLARED',
  /** Nothing is blocking this work's attribution. */
  'NOTHING_BLOCKING_ATTRIBUTION',
] as const;
export type AttributionAbsentReason = (typeof ATTRIBUTION_ABSENT_REASONS)[number];

/**
 * Where this work was noticed. Four columns L2 persists, resolved to things a person can read.
 *
 * `authority` is a constant and that is deliberate: it is SC7 travelling with the data instead of
 * living in a comment on the far side of the API.
 */
export interface AttributionDiscovery {
  project: AttributionProjectRef | null;
  triggerEvent: string | null;
  task: { taskId: string; title: string } | null;
  session: { sessionId: string; title: string | null } | null;
  /** True when at least one of the four above was recorded. */
  recorded: boolean;
  absentReason: AttributionAbsentReason | null;
  /** SC7, in the payload: evidence never decides who may write where. */
  authority: 'EVIDENCE_ONLY';
}

/** The declared crossing that touches this task, in the state the user's answer left it. */
export interface AttributionCrossing {
  handoffId: string;
  kind: string;
  state: 'PENDING' | 'APPROVED' | 'DENIED' | 'APPLIED';
  from: AttributionProjectRef | null;
  to: AttributionProjectRef | null;
  subjectTaskId: string | null;
  /** The value a decision has to echo back — the fence that makes answering it deliberate. */
  crossingKey: string;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  /** What a writer meeting this crossing is refused with while it stands, and what to do. */
  code: ScopeRefusalCode | null;
  requiredAction: ScopeRequiredAction | null;
}

/** The blocker that is holding this work's attribution up, if one is. */
export interface AttributionBlocker {
  blockerId: string;
  kind: string;
  owner: string;
  requiredAction: string;
  nextCheckAt: string;
  /** The refusal code that raised it, when the detail recorded one. */
  code: string | null;
}

/**
 * One task's attribution boundary, whole.
 *
 * Ordered the way the question is asked: where does this count (authority), where was it noticed
 * (evidence), what is being asked about it (crossing), what is stopping it (blocker).
 */
export interface TaskAttribution {
  taskId: string;
  owning: AttributionProjectRef | null;
  owningAbsentReason: AttributionAbsentReason | null;
  discovery: AttributionDiscovery;
  crossing: AttributionCrossing | null;
  crossingAbsentReason: AttributionAbsentReason | null;
  blocker: AttributionBlocker | null;
  blockerAbsentReason: AttributionAbsentReason | null;
}

/** The rows `taskAttribution` reads. One shape per source, so the query and the derivation can be
 *  wrong independently of one another and the spec can catch either. */
export interface TaskAttributionFacts {
  taskId: string;
  owning: AttributionProjectRef | null;
  discovery: {
    project: AttributionProjectRef | null;
    triggerEvent: string | null;
    task: { taskId: string; title: string } | null;
    session: { sessionId: string; title: string | null } | null;
  };
  crossing: AttributionCrossing | null;
  blocker: AttributionBlocker | null;
}

export function taskAttribution(facts: TaskAttributionFacts): TaskAttribution {
  const discoveryRecorded = Boolean(
    facts.discovery.project
    || facts.discovery.triggerEvent
    || facts.discovery.task
    || facts.discovery.session,
  );
  return {
    taskId: facts.taskId,
    owning: facts.owning,
    owningAbsentReason: facts.owning ? null : 'FILED_UNDER_NO_PROJECT',
    discovery: {
      ...facts.discovery,
      recorded: discoveryRecorded,
      absentReason: discoveryRecorded ? null : 'NO_DISCOVERY_RECORDED',
      authority: 'EVIDENCE_ONLY',
    },
    crossing: facts.crossing,
    crossingAbsentReason: facts.crossing ? null : 'NO_CROSSING_DECLARED',
    blocker: facts.blocker,
    blockerAbsentReason: facts.blocker ? null : 'NOTHING_BLOCKING_ATTRIBUTION',
  };
}
