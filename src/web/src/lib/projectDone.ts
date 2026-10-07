import type { CriterionLandingReason, DoneRequest, ProjectDoneBy, ProjectOpenItemRow } from '@orbit/shared';
import { formatSpan } from './watches';

/**
 * The owner-facing project-settlement copy.  Keep the words in this small module so the native
 * copy-parity checks can read one source instead of scraping JSX branches.
 */
// Keep each public copy token as a literal declaration.  Native copy-parity tests intentionally
// read the source (rather than importing the web bundle), so an alias such as
// `DONE_CARD_HEADING = PROJECT_DONE_COPY.heading` is not enough for them to prove parity.
export const DONE_CARD_HEADING = 'Is this project done?';
export const DONE_CARD_COORDINATOR_CALL = 'Coordinator’s call';
export const DONE_CARD_DONE_WHEN = 'Done when';
export const DONE_CARD_WHAT_ORBIT_CANT_PROVE = 'What Orbit can’t prove';
export const DONE_CARD_COORDINATOR_CHECKED = 'Coordinator checked';
export const DONE_CARD_ORBIT_CHECKED = 'Orbit checked';
export const DONE_CARD_RECORD = 'Record as done';
export const DONE_CARD_RECORD_ANYWAY = 'Record as done anyway';
export const DONE_CARD_NOT_YET = 'Not yet…';
export const DONE_CARD_MISSING = 'What’s missing before it’s done?';
export const DONE_CARD_RECEIPT = 'You recorded this project done';
export const DONE_CARD_GAPS_ACCEPTED = 'gaps accepted';
export const DONE_CARD_SEE_ACCEPTED = 'See what you accepted';
export const DONE_CARD_REOPEN = 'Reopen project';
export const DONE_CARD_EXPLANATION = 'Recording it done is yours. Orbit keeps your record — a later check won’t reopen the project unless the criteria change or one of their tasks is reopened.';
export const DONE_CARD_NOT_YET_HINT = 'Sends your note and this card’s facts to the coordinator. The card closes; it asks again when it has more.';
export const DONE_CARD_ASKED_BY_COORDINATOR = 'asked by the coordinator';
export const DONE_CARD_SHOW_ALL = 'Show all';
export const DONE_CARD_SHOW_LESS = 'Show less';
export const DONE_CARD_SEND_TO_COORDINATOR = 'Send to coordinator';
export const DONE_CARD_BACK = 'Back';
export const DONE_CARD_THIS_PROJECT_IS_DONE = 'This project is done';
export const WHY_NOT_DONE_HEADING = 'Why is this project not done?';
export const WHY_NOT_DONE_WAITING_ON_WORK = 'Waiting on work';
export const WHY_NOT_DONE_NEEDS_YOUR_CALL = 'Needs your call';
export const WHY_NOT_DONE_ON_MAIN = 'on main';
export const WHY_NOT_DONE_REVIEW = 'Review “Is this project done?”';
export const WHY_NOT_DONE_COORDINATOR_IS_ON_IT = 'the coordinator is on it';
export const WHY_NOT_DONE_ON_PROJECT_BRANCH = 'On the project branch';
export const WHY_NOT_DONE_MERGED_OUTSIDE_ORBIT = 'Merged outside Orbit';
export const WHY_NOT_DONE_NOTHING_TO_LAND = 'nothing to land';
export const WHY_NOT_DONE_THIS_PROJECT_IS_DONE = 'This project is done';
export const WHY_NOT_DONE_ASK_COORDINATOR = 'Ask the coordinator to handle it';
export const WHY_NOT_DONE_WAITING_DETAIL = 'Goes to main after the merge check — the coordinator is handling it.';
export const WHY_NOT_DONE_NEEDS_CALL_DETAIL = 'Orbit saw no merge for it. The coordinator checked main has it and asked you to record the project done.';
export const WHY_NOT_DONE_NOT_MET_YET = 'Not met yet';
export const WHY_NOT_DONE_NOT_MET_DETAIL = 'Its work has not met this criterion yet.';
export const WHY_NOT_DONE_NOT_MET = 'not met';
export const PROJECT_DONE_RECORDED_BY_YOU = 'recorded by you';
export const PROJECT_DONE_RECORDED_BY_ORBIT = 'recorded by Orbit';
export const READY_TO_CLOSE = 'Ready to close';
export const PROJECT_DONE_COORDINATOR_ASKED = 'The coordinator asked';
export const PROJECT_DONE_GAPS_IT_COULDNT_PROVE = 'gaps it couldn’t prove';
export const PROJECT_DONE_NOT_ASKED_YET = 'not asked yet';
export const PROJECT_DONE_RECORD_AS_DONE_ROW = 'Record as done…';

// The object is the ergonomic web API; the named constants above are the parity API.
export const PROJECT_DONE_COPY = {
  heading: DONE_CARD_HEADING,
  coordinatorCall: DONE_CARD_COORDINATOR_CALL,
  doneWhen: DONE_CARD_DONE_WHEN,
  whatOrbitCantProve: DONE_CARD_WHAT_ORBIT_CANT_PROVE,
  coordinatorChecked: DONE_CARD_COORDINATOR_CHECKED,
  orbitChecked: DONE_CARD_ORBIT_CHECKED,
  recordAsDone: DONE_CARD_RECORD,
  recordAsDoneAnyway: DONE_CARD_RECORD_ANYWAY,
  notYet: DONE_CARD_NOT_YET,
  missingBeforeDone: DONE_CARD_MISSING,
  receiptPrefix: DONE_CARD_RECEIPT,
  gapsAccepted: DONE_CARD_GAPS_ACCEPTED,
  seeWhatAccepted: DONE_CARD_SEE_ACCEPTED,
  reopenProject: DONE_CARD_REOPEN,
  readyToClose: READY_TO_CLOSE,
  recordedByYou: PROJECT_DONE_RECORDED_BY_YOU,
  recordedByOrbit: PROJECT_DONE_RECORDED_BY_ORBIT,
  waitingOnWork: WHY_NOT_DONE_WAITING_ON_WORK,
  needsYourCall: WHY_NOT_DONE_NEEDS_YOUR_CALL,
  coordinatorIsOnIt: WHY_NOT_DONE_COORDINATOR_IS_ON_IT,
  reviewDoneRequest: WHY_NOT_DONE_REVIEW,
  onProjectBranch: WHY_NOT_DONE_ON_PROJECT_BRANCH,
  mergedOutsideOrbit: WHY_NOT_DONE_MERGED_OUTSIDE_ORBIT,
  nothingToLand: WHY_NOT_DONE_NOTHING_TO_LAND,
  thisProjectIsDone: DONE_CARD_THIS_PROJECT_IS_DONE,
  openItemsDoneRequest: PROJECT_DONE_COORDINATOR_ASKED,
  gapsItCouldntProve: PROJECT_DONE_GAPS_IT_COULDNT_PROVE,
  notAskedYet: PROJECT_DONE_NOT_ASKED_YET,
  recordAsDoneRow: PROJECT_DONE_RECORD_AS_DONE_ROW,
  openItems: 'Open items',
  askedByCoordinator: DONE_CARD_ASKED_BY_COORDINATOR,
  noRequestMeta: 'record as done anyway',
  recordingExplanation: DONE_CARD_EXPLANATION,
  notYetHint: DONE_CARD_NOT_YET_HINT,
  sendToCoordinator: DONE_CARD_SEND_TO_COORDINATOR,
  back: DONE_CARD_BACK,
  askCoordinator: WHY_NOT_DONE_ASK_COORDINATOR,
  waitingDetail: WHY_NOT_DONE_WAITING_DETAIL,
  needsCallDetail: WHY_NOT_DONE_NEEDS_CALL_DETAIL,
  notMetYet: WHY_NOT_DONE_NOT_MET_YET,
  notMetDetail: WHY_NOT_DONE_NOT_MET_DETAIL,
  notMet: WHY_NOT_DONE_NOT_MET,
  onMain: WHY_NOT_DONE_ON_MAIN,
  whyHeading: WHY_NOT_DONE_HEADING,
  landedOnMain: 'landed on main',
} as const;

export type ProjectDoneCriterion = {
  definitionId: string;
  satisfied: boolean;
  landing: 'LANDED' | 'ON_INTEGRATION_LINE' | 'UNKNOWN';
  landingReason: CriterionLandingReason | null;
  independence?: string;
  withheld?: readonly string[];
  conflicts?: readonly unknown[];
  remedy?: unknown;
};

export type ProjectDoneCounts = {
  criteria: number;
  met: number;
  landed: number;
  onMain: number;
  byReason: Record<CriterionLandingReason, number>;
};

export type ProjectDerivedDone = {
  status: 'OPEN' | 'DONE';
  done: boolean;
  withheld: readonly string[];
  criteria: readonly ProjectDoneCriterion[];
  confirmation: 'UNCONFIRMED' | 'CONFIRMED' | 'STALE';
  counts: ProjectDoneCounts;
};

export type ProjectDoneCriterionItem = {
  id: string;
  ordinal: number;
  text: string;
  key?: string;
};

export type ProjectDoneDocument = {
  id?: string;
  title: string;
  status?: 'OPEN' | 'DONE' | 'CANCELLED' | string;
  acceptanceCriteriaItems?: readonly ProjectDoneCriterionItem[];
  derivedDone?: ProjectDerivedDone;
  doneBy?: ProjectDoneBy | null;
  doneAt?: string | null;
  acceptedGaps?: readonly Record<string, unknown>[] | null;
};

export type DoneRequestRow = {
  itemId: string;
  waitingSince?: string;
  doneRequest?: DoneRequest | null;
  detailLine?: string;
};

const REASON_ORDER: readonly CriterionLandingReason[] = [
  'IN_FLIGHT',
  'ON_PROJECT_BRANCH',
  'NO_RECEIPT',
  'NOTHING_TO_LAND',
  'CODELESS',
];

const REASON_LABELS: Record<CriterionLandingReason, string> = {
  IN_FLIGHT: 'in flight',
  ON_PROJECT_BRANCH: 'on the project branch',
  NOTHING_TO_LAND: PROJECT_DONE_COPY.nothingToLand,
  NO_RECEIPT: 'merged outside Orbit',
  CODELESS: 'no code to land',
};

function reasonParts(counts: Pick<ProjectDoneCounts, 'byReason'>): string[] {
  return REASON_ORDER.flatMap((reason) => {
    const count = counts.byReason?.[reason] ?? 0;
    return count > 0 ? [`${count} ${REASON_LABELS[reason]}`] : [];
  });
}

function nothingToLandCount(counts: ProjectDoneCounts): number {
  // CODELESS has the same user-facing outcome as a zero-commit task: there is no branch or
  // receipt to land. Keep the server's two reasons distinct in the read model, but present the
  // three compact card counts from the wording in the effect.
  return (counts.byReason?.NOTHING_TO_LAND ?? 0) + (counts.byReason?.CODELESS ?? 0);
}

/** Counts are deliberately read from `derivedDone.counts`; this function never inspects tasks. */
export function projectDoneTally(counts: ProjectDoneCounts | undefined): string {
  if (!counts) return '';
  return [
    `${counts.criteria} criteria`,
    `${counts.met} met`,
    `${counts.onMain} ${PROJECT_DONE_COPY.landedOnMain}`,
    ...reasonParts(counts),
  ].join(' · ');
}

/** The compact tally in the request card: the heading already states the number of criteria. */
export function projectDoneCardTally(counts: ProjectDoneCounts | undefined): string {
  if (!counts) return '';
  return [
    `${counts.met} met`,
    `${counts.onMain} ${PROJECT_DONE_COPY.landedOnMain}`,
    `${nothingToLandCount(counts)} ${PROJECT_DONE_COPY.nothingToLand}`,
  ].join(' · ');
}

/** The receipt's first phrase says how many criteria were met, rather than repeating the heading. */
export function projectDoneReceiptTally(
  counts: ProjectDoneCounts | undefined,
  acceptedGaps: number,
): string {
  if (!counts) return `${acceptedGaps} ${PROJECT_DONE_COPY.gapsAccepted}`;
  return [
    `${counts.criteria} criteria met`,
    `${counts.onMain} ${PROJECT_DONE_COPY.landedOnMain}`,
    `${nothingToLandCount(counts)} ${PROJECT_DONE_COPY.nothingToLand}`,
    `${acceptedGaps} ${PROJECT_DONE_COPY.gapsAccepted}`,
  ].join(' · ');
}

/**
 * The Why-not-done tally: the criteria, then where each one stands, in parts that add up to them.
 * A met criterion is counted where its work is — the mock's shorter "on main", or the reason it is
 * not (`REASON_LABELS`). An unmet one is counted as not met and never by its landing lane, which for
 * work still to do describes nothing that happened (no receipt, no code to land). Read off the
 * criteria's own answers in the unified read (`satisfied`, `landingReason`); never off tasks.
 */
export function projectWhyNotDoneTally(
  derivedDone: Pick<ProjectDerivedDone, 'criteria'> | undefined,
): string {
  if (!derivedDone) return '';
  const met = derivedDone.criteria.filter((criterion) => criterion.satisfied);
  const notMet = derivedDone.criteria.length - met.length;
  const byReason = Object.fromEntries(REASON_ORDER.map((reason) => [
    reason,
    met.filter((criterion) => criterion.landingReason === reason).length,
  ])) as Record<CriterionLandingReason, number>;
  return [
    `${derivedDone.criteria.length} criteria`,
    `${met.filter((criterion) => criterion.landingReason == null).length} ${PROJECT_DONE_COPY.onMain}`,
    ...reasonParts({ byReason }),
    ...(notMet > 0 ? [`${notMet} ${PROJECT_DONE_COPY.notMet}`] : []),
  ].join(' · ');
}

export function criterionForGap(
  project: ProjectDoneDocument,
  criterionKey: string,
): ProjectDoneCriterionItem | undefined {
  return project.acceptanceCriteriaItems?.find(
    (item) => item.id === criterionKey || item.key === criterionKey,
  );
}

export function criterionOrdinal(
  project: ProjectDoneDocument,
  criterionKey: string,
): number | null {
  return criterionForGap(project, criterionKey)?.ordinal ?? null;
}

export function formatDoneDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDoneDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function doneProvenance(project: Pick<ProjectDoneDocument, 'doneBy' | 'acceptedGaps'>): string {
  if (project.doneBy === 'OWNER') {
    const n = project.acceptedGaps?.length ?? 0;
    return `${PROJECT_DONE_COPY.recordedByYou} · ${n} ${PROJECT_DONE_COPY.gapsAccepted}`;
  }
  return PROJECT_DONE_COPY.recordedByOrbit;
}

/**
 * The open items the card's Orbit checked row counts: every row the open-items read holds — the
 * START_REQUEST kept beside the groups included — except the DONE_REQUEST the card is itself
 * reviewing. Without a DONE_REQUEST (the owner opened it) nothing is left out.
 */
export function orbitCheckedOpenItemCount(view: {
  needsYou?: readonly Pick<ProjectOpenItemRow, 'itemId'>[];
  withCoordinator?: readonly Pick<ProjectOpenItemRow, 'itemId'>[];
  startRequest?: Pick<ProjectOpenItemRow, 'itemId'> | null;
  doneRequest?: Pick<ProjectOpenItemRow, 'itemId'> | null;
} | null | undefined): number {
  const reviewing = view?.doneRequest?.itemId ?? null;
  return [...(view?.needsYou ?? []), ...(view?.withCoordinator ?? []), ...(view?.startRequest ? [view.startRequest] : [])]
    .filter((row) => reviewing === null || row.itemId !== reviewing).length;
}

/** How long the coordinator's request has waited, from its own `waitingSince`. */
export function doneRequestWaiting(waitingSince: string | null | undefined, now: number): string | null {
  const at = waitingSince ? Date.parse(waitingSince) : Number.NaN;
  return Number.isNaN(at) ? null : `waiting ${formatSpan(now - at)}`;
}

/** A stable reason label, used by the Why-not-done card and its compact project-page row. */
export function landingReasonLabel(reason: CriterionLandingReason | null): string {
  switch (reason) {
    case 'IN_FLIGHT': return 'In flight';
    case 'ON_PROJECT_BRANCH': return PROJECT_DONE_COPY.onProjectBranch;
    case 'NO_RECEIPT': return PROJECT_DONE_COPY.mergedOutsideOrbit;
    case 'NOTHING_TO_LAND': return PROJECT_DONE_COPY.nothingToLand;
    case 'CODELESS': return 'No code to land';
    default: return 'Landed on main';
  }
}

export function isWaitingOnWork(reason: CriterionLandingReason | null): boolean {
  return reason === 'IN_FLIGHT' || reason === 'ON_PROJECT_BRANCH';
}

export function isNeedsYourCall(reason: CriterionLandingReason | null): boolean {
  return reason === 'NO_RECEIPT';
}
