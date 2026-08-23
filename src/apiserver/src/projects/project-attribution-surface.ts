/**
 * Unit L7: what a person is shown about where a piece of work counts, who noticed it, which
 * acceptance reads it, and what a crossing or a reopen would cost.
 *
 * L1 froze the rules, L3 enforced them, L4 gave a crossing a door and L5 gave a settled project
 * one. Every one of those refusals is correct and none of them is VISIBLE: the target project is
 * an id in an error body, the discovery source is four columns nothing reads back, and "this PASS
 * belongs to an epoch that is over" is a `superseded_at` nobody renders. A boundary the writer
 * only meets by being refused is a boundary the writer learns about after they have already
 * decided what to do.
 *
 * So this module is the DERIVATION, once, for every client. Pure: no clock, no database, no Nest.
 * The service layer reads rows and hands them here; the web app, the CLI and any client after them
 * render what comes back. That direction is the point — three clients each deriving "is this PASS
 * current" from `acceptanceEpoch` and `supersededAt` is three chances to disagree about whether a
 * project has been accepted, and the disagreement would show up as two screens saying different
 * things about the same row.
 *
 * TWO RULES THIS FILE IS CAREFUL ABOUT
 * ------------------------------------
 *   - §3 SC7: the discovery source is EVIDENCE. It is rendered beside the authoritative
 *     attribution and never instead of it, and `authority: 'EVIDENCE_ONLY'` is emitted next to it
 *     rather than left to a caption somebody may drop. "Where this was noticed" reading like
 *     "where this belongs" is the incident §0 exists for, one screen later.
 *   - An absent fact is null WITH a reason (§7's absent-reason convention). "This task is cited by
 *     no acceptance criterion" and "this build cannot tell you" are different answers, and a
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
  /** The project's current acceptance epoch, as a string — a BigInt has no JSON spelling. */
  acceptanceEpoch: string;
}

/** Why a fact below is null. A closed set, so a client can branch on it instead of on prose. */
export const ATTRIBUTION_ABSENT_REASONS = [
  /** The task is filed under no project at all — legal, and not the same as unreadable. */
  'FILED_UNDER_NO_PROJECT',
  /** Nothing was recorded about where this work was noticed. */
  'NO_DISCOVERY_RECORDED',
  /** No acceptance criterion cites this task as its evidence. */
  'NOT_CITED_BY_ACCEPTANCE',
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

/** One acceptance criterion that names this task as its evidence, and whether it still counts. */
export interface AttributionAcceptanceLink {
  runId: string;
  /** The attempt number, as a string for the same reason `acceptanceEpoch` is. */
  attempt: string;
  ordinal: number;
  criterionKey: string;
  text: string;
  verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
  /** The epoch the run that cited this task was opened in. */
  epoch: string;
  /** Whether this conclusion is about the world the project is in NOW. */
  current: boolean;
  /** Why it is not, when it is not — the readable half of L5's "old PASS stays readable". */
  staleReason: 'EPOCH_ADVANCED' | 'RUN_SUPERSEDED' | null;
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
 * (evidence), what reads it (acceptance), what is being asked about it (crossing), what is stopping
 * it (blocker).
 */
export interface TaskAttribution {
  taskId: string;
  owning: AttributionProjectRef | null;
  owningAbsentReason: AttributionAbsentReason | null;
  discovery: AttributionDiscovery;
  acceptance: AttributionAcceptanceLink[];
  acceptanceAbsentReason: AttributionAbsentReason | null;
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
  /** Every criterion citing this task, with the run it belongs to. Order is preserved. */
  acceptance: ReadonlyArray<{
    runId: string;
    attempt: string;
    ordinal: number;
    criterionKey: string;
    text: string;
    verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | null;
    epoch: string;
    runSuperseded: boolean;
  }>;
  crossing: AttributionCrossing | null;
  blocker: AttributionBlocker | null;
}

/**
 * Whether a conclusion recorded in `epoch` is about the project's current world.
 *
 * Two independent ways an old PASS stops counting, and both have to be named rather than folded
 * into one boolean: the project was reopened (the epoch moved past the one the run was opened in),
 * or a newer attempt superseded this one inside the SAME epoch. A screen that showed only "stale"
 * would leave a reader unable to tell "somebody reopened this project" from "somebody ran
 * acceptance again", which are different things to do next.
 *
 * The epoch is compared as a string because that is how it crosses the wire, and both sides are
 * produced by the same database column — so equality is exact, and no client has to decide how to
 * parse a 64-bit integer to answer "is this current".
 */
export function acceptanceStaleReason(
  link: { epoch: string; runSuperseded: boolean },
  currentEpoch: string,
): 'EPOCH_ADVANCED' | 'RUN_SUPERSEDED' | null {
  if (link.epoch !== currentEpoch) return 'EPOCH_ADVANCED';
  return link.runSuperseded ? 'RUN_SUPERSEDED' : null;
}

export function taskAttribution(facts: TaskAttributionFacts): TaskAttribution {
  const currentEpoch = facts.owning?.acceptanceEpoch ?? null;
  const discoveryRecorded = Boolean(
    facts.discovery.project
    || facts.discovery.triggerEvent
    || facts.discovery.task
    || facts.discovery.session,
  );
  const acceptance = facts.acceptance.map((link) => {
    // A criterion citing a task filed under no project cannot be judged against an epoch there is
    // none of. It is reported as not current rather than as current — the same fail-closed reading
    // §4 R-d gives an unreadable project status, for the same reason: an unanswerable question
    // must not answer "fine".
    const staleReason = currentEpoch === null
      ? 'EPOCH_ADVANCED'
      : acceptanceStaleReason(link, currentEpoch);
    return {
      runId: link.runId,
      attempt: link.attempt,
      ordinal: link.ordinal,
      criterionKey: link.criterionKey,
      text: link.text,
      verdict: link.verdict,
      epoch: link.epoch,
      current: staleReason === null,
      staleReason,
    };
  });
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
    acceptance,
    acceptanceAbsentReason: acceptance.length ? null : 'NOT_CITED_BY_ACCEPTANCE',
    crossing: facts.crossing,
    crossingAbsentReason: facts.crossing ? null : 'NO_CROSSING_DECLARED',
    blocker: facts.blocker,
    blockerAbsentReason: facts.blocker ? null : 'NOTHING_BLOCKING_ATTRIBUTION',
  };
}

// -------------------------------------------------------------------------------------------
// Reopening a settled project — what it costs, stated before it is spent.
// -------------------------------------------------------------------------------------------

/** Why a reopen would be refused, or `null` when it would be allowed. */
export const REOPEN_REFUSAL_CODES = [
  /** The project is already OPEN: there is nothing to reopen and no epoch to advance. */
  'PROJECT_NOT_SETTLED',
  /** The caller did not say which epoch they were looking at. */
  'REOPEN_ACKNOWLEDGEMENT_REQUIRED',
  /** They said one, and the project has moved past it since they read it. */
  'REOPEN_ACKNOWLEDGEMENT_STALE',
] as const;
export type ReopenRefusalCode = (typeof REOPEN_REFUSAL_CODES)[number];

/**
 * What reopening this project would do, and what saying yes to it takes.
 *
 * `toEpoch` is `fromEpoch + 1` and it is computed here rather than read back afterwards, because
 * the number a person is asked to confirm has to exist BEFORE they confirm it. The database is
 * what actually advances the epoch (migration 0150's `project_acceptance_advance_epoch`), and this
 * is the same arithmetic said out loud — the spec pins the two together.
 */
export interface ReopenImpact {
  status: ScopeProjectStatus;
  settled: boolean;
  fromEpoch: string;
  toEpoch: string;
  /** Acceptance attempts that are live today and would be retired by the reopen. */
  retiringRuns: number;
  /** Whether the project's DONE rests on the pre-acceptance compatibility stamp. */
  wasLegacy: boolean;
  /** The value a reopen request has to echo back. Null when there is nothing to reopen. */
  acknowledgement: string | null;
  /** Why a reopen would be refused right now, or null when it would go through. */
  refusalCode: ReopenRefusalCode | null;
  requiredAction: string;
}

export interface ReopenFacts {
  status: ScopeProjectStatus;
  acceptanceEpoch: string;
  liveAcceptanceRuns: number;
  legacyAccepted: boolean;
}

/**
 * Reopening is not undoing. It starts a NEW acceptance epoch, and every PASS the project has
 * stays readable while ceasing to be current — which is why the sentence below says what it costs
 * rather than asking "are you sure".
 */
export function reopenImpact(facts: ReopenFacts): ReopenImpact {
  const settled = facts.status !== 'OPEN';
  const toEpoch = settled ? nextEpoch(facts.acceptanceEpoch) : facts.acceptanceEpoch;
  return {
    status: facts.status,
    settled,
    fromEpoch: facts.acceptanceEpoch,
    toEpoch,
    retiringRuns: settled ? facts.liveAcceptanceRuns : 0,
    wasLegacy: facts.legacyAccepted,
    acknowledgement: settled ? facts.acceptanceEpoch : null,
    refusalCode: settled ? null : 'PROJECT_NOT_SETTLED',
    requiredAction: settled
      ? `Confirm the reopen by acknowledging acceptance epoch ${facts.acceptanceEpoch}; `
        + `it starts epoch ${toEpoch} and retires ${facts.liveAcceptanceRuns} acceptance `
        + `attempt${facts.liveAcceptanceRuns === 1 ? '' : 's'}.`
      : 'This project is already OPEN; nothing has to be reopened.',
  };
}

/**
 * The next epoch, as a decimal string.
 *
 * `BigInt` rather than `Number`: the column is a 64-bit integer and a project that has been
 * reopened more times than a double can count is not a case worth being wrong about silently. A
 * value that is not an integer is passed through unchanged with a `?` — an epoch this code cannot
 * read must not be reported as a number it made up.
 */
function nextEpoch(epoch: string): string {
  try {
    return String(BigInt(epoch) + 1n);
  } catch {
    return `${epoch}?`;
  }
}

/**
 * Whether a reopen request may proceed, given what the caller says they were looking at.
 *
 * The acknowledgement is a compare-and-set on the epoch, not a checkbox. A checkbox says "I
 * pressed a second button"; this says "I am reopening the project I READ, at the epoch it was at
 * when I read it" — so a second tab that reopened it first turns this into a refusal instead of a
 * second reopen the user never intended.
 */
export function admitReopen(
  impact: ReopenImpact,
  acknowledged: string | null | undefined,
): { allowed: boolean; code: ReopenRefusalCode | null; message: string } {
  if (!impact.settled) {
    return {
      allowed: false,
      code: 'PROJECT_NOT_SETTLED',
      message: `this project is ${impact.status}; only a settled project is reopened`,
    };
  }
  if (acknowledged === null || acknowledged === undefined || acknowledged === '') {
    return {
      allowed: false,
      code: 'REOPEN_ACKNOWLEDGEMENT_REQUIRED',
      message:
        'reopening starts a new acceptance epoch and retires every acceptance attempt this '
        + `project has — acknowledge epoch ${impact.fromEpoch} to confirm it`,
    };
  }
  if (acknowledged !== impact.fromEpoch) {
    return {
      allowed: false,
      code: 'REOPEN_ACKNOWLEDGEMENT_STALE',
      message:
        `this project is at acceptance epoch ${impact.fromEpoch} and you acknowledged `
        + `${acknowledged} — re-read it and confirm what it says now`,
    };
  }
  return { allowed: true, code: null, message: '' };
}
