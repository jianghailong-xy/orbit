import type { CriterionLandingReason, DoneRequest, ProjectDoneFinding, ProjectDoneBy, ProjectOpenItemsView, ProjectOpenItemRow } from '@orbit/shared';
import { api } from '../api';
import { DEFAULT_MAIN_BRANCH } from './projectStart';
import { formatSpan } from './watches';

/**
 * The owner-facing project-settlement copy.  Keep the words in this small module so the native
 * copy-parity checks can read one source instead of scraping JSX branches.
 */
// Keep each public copy token as a literal declaration.  Native copy-parity tests intentionally
// read the source (rather than importing the web bundle), so an alias such as
// `DONE_CARD_HEADING = PROJECT_DONE_COPY.heading` is not enough for them to prove parity.
export const DONE_DECLINE_HEADING = 'You said not yet';
export const DONE_DECLINE_HINT = 'The card comes back after the coordinator changes something.';

export const DONE_CARD_HEADING = 'Is this project done?';
export const DONE_CARD_COORDINATOR_CALL = 'Coordinator’s call';
export const DONE_CARD_DONE_WHEN = 'Done when';
export const DONE_CARD_WHAT_ORBIT_CANT_PROVE = 'What Orbit can’t prove';
export const DONE_CARD_COORDINATOR_CHECKED = 'Coordinator checked';
export const DONE_CARD_ORBIT_CHECKED = 'Orbit checked';
export const DONE_CARD_RECORD = 'Record as done';
export const DONE_CHECK_NO_CRITERIA = 'No acceptance criteria are stated';
export const DONE_CHECK_UNMET = 'Criterion {n} is not met';
export const DONE_CHECK_UNLANDED = 'Criterion {n} is not on {main}';
export const DONE_CHECK_TASKS = '{n} tasks are still running';
export const DONE_CHECK_TASK = '1 task is still running';
export const DONE_CHECK_OWNER_ITEMS = 'Open owner items: {n}';
export const DONE_CHECK_LANDINGS = 'Landings in flight: {n}';
export const DONE_CARD_FINDINGS_HEADING = 'Orbit can’t prove {n} things';
export const DONE_CARD_FINDINGS_ACCEPTED = 'These will be kept as the gaps you accepted.';
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
export const DONE_CARD_DERIVED_FROM = 'From the criteria you confirmed on';
export const DONE_CARD_DERIVED_REOPEN_HINT = 'Not right? Reopen it.';

// The non-code mark (decided board ③ A, board 01): set by the coordinator or the owner, never inferred.
export const NON_CODE_BADGE = 'Non-code';
export const NON_CODE_LEAD = 'Non-code project.';
export const NON_CODE_BODY = 'Orbit checks the criteria only, not where work landed.';
export const NON_CODE_PROJECT_LINE = 'Non-code project · Orbit checks the criteria only, not where work landed';
export const NON_CODE_MARKED_BY_COORDINATOR = 'Marked by the coordinator';
export const NON_CODE_MARKED_BY_YOU = 'Marked by you';
export const NON_CODE_CHANGE = 'Change';
/** The project page's Delivers row, which the done card's Change opens (`/projects/:id#delivers`). */
export const NON_CODE_ANCHOR = 'delivers';
export const RUN_DELIVERS = 'Delivers';
export const RUN_DELIVERS_CODE = 'Code';
export const RUN_DELIVERS_CODE_HINT = 'Tasks land on a branch, and the done card checks the work reached {main}.';
export const RUN_DELIVERS_NOT_CODE = 'Not code';
export const RUN_DELIVERS_NOT_CODE_HINT = 'Documents, accounts, approvals. Orbit checks the criteria only; nothing lands.';
export const RUN_LANDING = 'Landing';
export const RUN_LANDING_OFF_HINT = 'Off for a non-code project: Tasks land on, Delivery, Main branch and Merge check don’t apply. Switch Delivers to Code to bring them back.';
export const RUN_TO_NOT_CODE = 'The done card stops reading where work landed. Work already on {branch} stays there.';
export const RUN_TO_CODE = 'The done card will check where work landed again. Work that ran without a branch will show as “Ran without a branch”.';

// The follow-up details (boards 01 B, 02 G/I, 03 Confirm sheet and stale row).
/** The non-code mark's reason, quoted under "Marked by … · <when>". */
export const NON_CODE_REASON = '“{reason}”';
/** Board 02 G: the source project's line for a criterion it moved out; the project name is a link. */
export const MOVED_OUT_CRITERION = 'Criterion {n} moved to';
export const MOVED_OUT_UNNUMBERED = 'A criterion moved to';
/** Board 02 I: the destination's criterion row; the project name is a link. */
export const MOVED_FROM = 'Moved from';
export const MOVED_BY_YOU = 'by you';
/** Board 03 Confirm sheet: one optional screenshot. */
export const CONFIRM_SHEET_SCREENSHOT = 'Screenshot';
export const CONFIRM_SHEET_ATTACH = 'Attach a screenshot';
export const CONFIRM_SHEET_DROP = 'Drop an image or paste it here';
export const CONFIRM_SHEET_UPLOADING = 'Uploading…';
export const CONFIRM_SHEET_REMOVE = 'Remove';
export const CONFIRM_SHEET_NOT_AN_IMAGE = 'Attach an image: a PNG, JPEG, GIF or WebP file.';
export const CONFIRM_SHEET_NOT_UPLOADED = 'The screenshot was not uploaded';
/** The confirmer row's attachment. */
export const CRITERION_SCREENSHOT = 'Screenshot';
export const CRITERION_ONE_SCREENSHOT = '1 screenshot';
export const CRITERION_SCREENSHOTS = '{n} screenshots';
/** Board 03 J: a stale confirmation row's "What changed" — the confirmed wording beside today's. */
export const CRITERION_WHAT_CHANGED = 'What changed';
export const CRITERION_HIDE_CHANGES = 'Hide changes';
export const CRITERION_WORDING_CONFIRMED = 'Confirmed · revision {r}';
export const CRITERION_WORDING_NOW = 'Now · revision {r}';
export const CRITERION_WORDING_NOT_KEPT = 'The wording confirmed then was not kept.';

// The done card's findings, grouped by criterion with the unmet ones first (decided board ③ B–D).
export const DONE_CARD_STANDS_IN_WAY_ONE = '1 thing stands in the way';
export const DONE_CARD_STANDS_IN_WAY = '{n} things stand in the way';
export const DONE_CARD_FINDINGS_HEADING_ONE = 'Orbit can’t prove 1 thing';
export const DONE_CHECK_UNMET_OPEN_TASK = 'Criterion {n} is not met — 1 task is still open';
export const DONE_CHECK_UNMET_OPEN_TASKS = 'Criterion {n} is not met — {m} tasks are still open';
export const DONE_CHECK_UNMET_NO_TASK = 'Criterion {n} is not met — no task serves it';
export const DONE_CHECK_UNMET_UNCONFIRMED = 'Criterion {n} is not met — it waits for confirmation';
export const DONE_CHECK_NO_BRANCH = 'Criterion {n}: {tasks} ran without a branch, so Orbit can’t see whether their changes reached {main}. Check {main} yourself before recording it done.';
export const DONE_CHECK_ON_PROJECT_BRANCH = 'Criterion {n} is on the project branch, not on {main} yet';
export const DONE_CHECK_IN_FLIGHT = 'Criterion {n} is being landed on {main}';
export const DONE_CHECK_NOTHING_TO_LAND = 'Criterion {n} has nothing to land';
export const DONE_CHECK_CODELESS = 'Criterion {n} has no code to land';
export const DONE_CARD_OPEN = 'Open';
export const DONE_CARD_MOVE_TO_FOLLOW_UP = 'Move to a follow-up…';
export const DONE_CARD_MOVE_HINT = 'takes criterion {n} and its open tasks out of this project';
export const DONE_CARD_ANYWAY_KEEPS = 'If you record it done anyway, Orbit keeps {criteria} as the gap you accepted.';
export const DONE_CARD_TALLY_OF = '{met} of {n} met';
export const DONE_CARD_WAIT_CONFIRMATION = '{n} wait for confirmation';
export const LANDING_RAN_WITHOUT_BRANCH = 'Ran without a branch';
export const LANDING_NO_CODE_TO_LAND = 'No code to land';

// A criterion met by confirmation (board 03): its mode, who confirmed it, and its Confirm sheet.
export const CRITERION_MET_BY = 'Met by';
export const CRITERION_MET_BY_TASKS = 'its tasks';
export const CRITERION_MET_BY_CONFIRMATION = 'confirmation';
export const CRITERION_MODE_TASKS = 'Its tasks';
export const CRITERION_MODE_TASKS_HINT = 'Met when the work filed under it is done.';
export const CRITERION_MODE_CONFIRMATION = 'Confirmation';
export const CRITERION_MODE_CONFIRMATION_HINT = 'Met when you, the coordinator or an Agent check confirms it. For facts outside the code: filings, approvals, accounts.';
export const CRITERION_MODE_NOT_CHANGED = 'How this criterion is met was not changed';
export const CRITERION_CONFIRMED_BY_YOU = 'Met · confirmed by you';
export const CRITERION_CONFIRMED_BY_COORDINATOR = 'Met · confirmed by the coordinator';
export const CRITERION_CHECK_PASSED = 'Met · Agent check passed';
export const CRITERION_CHECK_FAILED = 'Not met · Agent check failed';
export const CRITERION_CHECK_RUNNING = 'Checking… · Agent check running';
export const CRITERION_STALE = 'Not met · confirmed for an earlier wording';
export const CRITERION_STALE_DETAIL = '{who} confirmed revision {r} on {date}. The wording has changed since.';
export const CRITERION_WAITS_CONFIRMATION = 'Waits for confirmation';
export const CRITERION_CHECK_STARTED = 'started {ago}';
export const CRITERION_PASS_NOTE = 'PASS — {note}';
export const CRITERION_FAIL_NOTE = 'FAIL — {note}';
export const CRITERION_WHO_YOU = 'You';
export const CRITERION_WHO_COORDINATOR = 'The coordinator';
export const CRITERION_WHO_CHECK = 'An Agent check';
export const DONE_CHECK_ITS_WORK = 'its work';
export const CRITERION_WITHDRAW = 'Withdraw';
export const CRITERION_VIEW_RUN = 'View run';
export const CRITERION_OPEN_CONVERSATION = 'Open conversation';
export const CRITERION_CONFIRM = 'Confirm…';
export const CRITERION_CONFIRM_AGAIN = 'Confirm again…';
export const CRITERION_RUN_CHECK = 'Run an Agent check';
export const CRITERION_RUN_CHECK_AGAIN = 'Run the check again';
export const CRITERION_ACTION_FAILED = 'That did not go through';
export const CONFIRM_SHEET_TITLE = 'Confirm criterion {n}';
export const CONFIRM_SHEET_HOW_CHECKED = 'How it’s checked:';
export const CONFIRM_SHEET_WHAT_CHECKED = 'What did you check?';
export const CONFIRM_SHEET_OPTIONAL = 'optional';
export const CONFIRM_SHEET_PLACEHOLDER = 'e.g. the filing number you saw, and where';
export const CONFIRM_SHEET_FOOTNOTE = 'Your name and the time are kept with it. If the wording of this criterion changes, it goes back to not met until someone confirms it again.';
export const CONFIRM_SHEET_CONFIRM = 'Confirm';
export const CONFIRM_SHEET_CANCEL = 'Cancel';
export const CONFIRM_SHEET_NOT_RECORDED = 'The confirmation was not recorded';
export const DONE_ROW_BY_YOU = 'by you';
export const DONE_ROW_BY_COORDINATOR = 'by the coordinator';
export const DONE_ROW_CHECK_PASS = 'Agent check PASS';
export const DONE_ROW_CHECK_FAILED = 'Agent check failed';
export const DONE_ROW_WAITS = 'waits for confirmation';
export const DONE_ROW_STALE = 'confirmed for an earlier wording';
export const DONE_ROW_CHECKING = 'checking…';
export const DONE_ROW_CONFIRMED_BY_YOU = 'Confirmed by you';
export const DONE_ROW_CONFIRMED_BY_COORDINATOR = 'Confirmed by the coordinator';
export const DONE_ROW_CONFIRMED_BY_CHECK = 'Confirmed by an Agent check';
export const ACCEPTANCE_STANDING_MIXED = '{n} criteria stated. {a} met by their tasks; {b} by a confirmation — from you, the coordinator, or an Agent check.';
export const ACCEPTANCE_NOTE_MIXED = 'A criterion met by its tasks is read off the work filed under it. A criterion met by confirmation says who confirmed it, when, and what they checked; it goes back to not met when its wording changes or the confirmation is withdrawn.';

// Move to a follow-up… (board 02 ⑥): one dialog, two steps.
export const MOVE_TITLE = 'Move to a follow-up';
export const MOVE_MOVES = 'Moves';
export const MOVE_AND_ONE_OPEN_TASK = 'and its 1 open task';
export const MOVE_AND_OPEN_TASKS = 'and its {n} open tasks';
export const MOVE_STAYS = 'Stays here: its done and cancelled tasks, as this project’s history.';
export const MOVE_KEEPS = 'This project keeps {n} criteria.';
export const MOVE_KEEPS_ALL_MET = 'This project keeps {n} criteria, all met.';
export const MOVE_TO = 'To';
export const MOVE_NEW_PROJECT = 'New project';
export const MOVE_EXISTING_PROJECT = 'Existing project';
export const MOVE_FOLLOW_UP_TITLE = '{title} · follow-up';
export const MOVE_FOLLOW_UP_GOAL = 'Follow-up of “{title}”: criterion {n}.';
export const MOVE_NEW_HINT = 'It starts not started, in the same workspace, with this criterion and its tasks. You start it when you’re ready.';
export const MOVE_SEARCH = 'Search open projects';
export const MOVE_OPEN_ONLY = 'Open projects only.';
export const MOVE_PROJECT_TASKS = '{n} tasks';
export const MOVE_NO_OPEN_PROJECTS = 'No other open project.';
export const MOVE_NEXT = 'Next';
export const MOVE_CANCEL = 'Cancel';
export const MOVE_BACK = 'Back';
export const MOVE_CONFIRM_TITLE = 'Move criterion {n} to “{project}”?';
export const MOVE_CONFIRM_THIS_ALL_MET = 'This project keeps {n} criteria, all met. You can record it as done right after.';
export const MOVE_CONFIRM_NEW = '{project} is created, not started, and gets criterion {n} {tasks}.';
export const MOVE_CONFIRM_EXISTING = '{project} gets criterion {n} {tasks}, after its own criteria.';
export const MOVE_CONFIRM_RECORD = 'Both projects record the move: who moved it and when. Nothing is deleted.';
export const MOVE_CONFIRM_ACTION = 'Move criterion {n}';
export const MOVE_NOT_MOVED = 'The criterion was not moved';

/** The authenticated owner status door records the Reopen press (0469), not just OPEN. */
export function updateProjectStatus(projectId: string, status: 'DONE' | 'CANCELLED' | 'OPEN'): Promise<{ id: string }> {
  return api<{ id: string }>(`/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: { status } });
}

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
  findingsHeading: DONE_CARD_FINDINGS_HEADING,
  findingsAccepted: DONE_CARD_FINDINGS_ACCEPTED,
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
  derivedFrom: DONE_CARD_DERIVED_FROM,
  derivedReopenHint: DONE_CARD_DERIVED_REOPEN_HINT,
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

/**
 * The words above that say main, said of the project's main branch by name — the branch its work
 * ends up on (`integration.upstreamRef`). For a project on main each says its constant's words; the
 * constants stay, as the native parity tests read them.
 */
export function whyNotDoneOn(main: string = DEFAULT_MAIN_BRANCH): string {
  return `on ${main}`;
}
export function whyNotDoneWaitingDetail(main: string = DEFAULT_MAIN_BRANCH): string {
  return `Goes to ${main} after the merge check — the coordinator is handling it.`;
}
export function whyNotDoneNeedsCallDetail(main: string = DEFAULT_MAIN_BRANCH): string {
  return `Orbit saw no merge for it. The coordinator checked ${main} has it and asked you to record the project done.`;
}
export function landedOn(main: string = DEFAULT_MAIN_BRANCH): string {
  return `landed on ${main}`;
}

function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Why one criterion is not on main, in the words of the reason the check found
 *  (`ProjectDoneFinding.reason`): only work Orbit saw no merge of reads "not on main". */
function unlandedLine(finding: ProjectDoneFinding, ordinal: string, main: string): string {
  const fill = (words: string) => words.replace('{n}', ordinal).replaceAll('{main}', main);
  switch (finding.reason) {
    case 'NO_BRANCH':
      return fill(DONE_CHECK_NO_BRANCH).replace(
        '{tasks}',
        finding.tasks.length > 0 ? countOf(finding.tasks.length, 'task', 'tasks') : DONE_CHECK_ITS_WORK,
      );
    case 'ON_PROJECT_BRANCH': return fill(DONE_CHECK_ON_PROJECT_BRANCH);
    case 'IN_FLIGHT': return fill(DONE_CHECK_IN_FLIGHT);
    case 'NOTHING_TO_LAND': return fill(DONE_CHECK_NOTHING_TO_LAND);
    case 'CODELESS': return fill(DONE_CHECK_CODELESS);
    default: return fill(DONE_CHECK_UNLANDED);
  }
}

/** An unmet criterion's line names what holds it: its open tasks, no task at all, or — for a
 *  criterion met by confirmation — the confirmation it waits for. */
function unmetLine(finding: ProjectDoneFinding, ordinal: string, confirmation: boolean): string {
  if (confirmation) return DONE_CHECK_UNMET_UNCONFIRMED.replace('{n}', ordinal);
  if (finding.tasks.length === 0) return DONE_CHECK_UNMET_NO_TASK.replace('{n}', ordinal);
  return finding.tasks.length === 1
    ? DONE_CHECK_UNMET_OPEN_TASK.replace('{n}', ordinal)
    : DONE_CHECK_UNMET_OPEN_TASKS.replace('{n}', ordinal).replace('{m}', String(finding.tasks.length));
}

export function doneFindingLine(
  finding: ProjectDoneFinding,
  main: string = DEFAULT_MAIN_BRANCH,
  /** The criterion is met by confirmation, so no task holds it. */
  options: { confirmation?: boolean } = {},
): string {
  const ordinal = finding.criterion?.ordinal;
  switch (finding.code) {
    case 'DONE_NO_CRITERIA': return DONE_CHECK_NO_CRITERIA;
    case 'DONE_CRITERION_UNSATISFIED': return unmetLine(finding, String(ordinal), options.confirmation === true);
    case 'DONE_CRITERION_UNLANDED': return unlandedLine(finding, String(ordinal), main);
    case 'DONE_TASKS_IN_FLIGHT': return finding.tasks.length === 1 ? DONE_CHECK_TASK : DONE_CHECK_TASKS.replace('{n}', String(finding.tasks.length));
    case 'DONE_OWNER_ITEMS_OPEN': return DONE_CHECK_OWNER_ITEMS.replace('{n}', String(finding.items.length));
    case 'DONE_INTEGRATION_IN_FLIGHT': return DONE_CHECK_LANDINGS.replace('{n}', String(finding.jobs.length));
    default: return finding.message;
  }
}

/** One confirmation of a criterion met by confirmation (server `CriterionConfirmationView`). */
export type CriterionConfirmationView = {
  id: string;
  revision: number;
  confirmerKind: 'OWNER' | 'COORDINATOR' | 'AGENT_CHECK';
  outcome: 'PENDING' | 'CONFIRMED' | 'FAILED';
  /** The coordinator conversation that confirmed, or the Agent check's run. */
  sessionId: string | null;
  checkTaskId: string | null;
  note: string | null;
  attachmentIds: string[];
  at: string;
  /** The criterion's wording and verification method at `revision`, kept with the confirmation
   *  (0555); null on an older row. What a stale row's What changed shows. */
  criterionText?: string | null;
  criterionVerificationMethod?: string | null;
};

/** Where one CONFIRMATION criterion stands (server `CriterionConfirmationStanding`). */
export type CriterionConfirmationStanding = {
  state: 'CONFIRMED' | 'CHECK_FAILED' | 'STALE' | 'UNCONFIRMED';
  current: CriterionConfirmationView | null;
  stale: boolean;
  checkRunning: CriterionConfirmationView | null;
};

export type CriterionSatisfiedBy = 'TASKS' | 'CONFIRMATION';

export type ProjectDoneCriterion = {
  definitionId: string;
  satisfiedBy?: CriterionSatisfiedBy;
  confirmation?: CriterionConfirmationStanding | null;
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
  /** The explicit non-code mark: the project reads no landing at all. */
  nonCode?: boolean;
};

export type ProjectDoneCriterionItem = {
  id: string;
  ordinal: number;
  text: string;
  key?: string;
  revision?: number;
  verificationMethod?: string | null;
  satisfiedBy?: CriterionSatisfiedBy;
  /** Where the criterion came from, when it was moved here from another project (board 02 I). */
  movedFrom?: CriterionMovedFrom | null;
};

/** Board 02 I: the project a criterion was moved from, and when. Only the owner moves one. */
export type CriterionMovedFrom = {
  fromProjectId: string;
  fromProjectTitle: string;
  movedAt: string;
};

/** Board 02 G: one criterion this project moved out to a follow-up. */
export type CriterionMovedOut = {
  criterionKey: string;
  definitionId: string;
  /** Its number on this project's cards when it moved; null on an older record. */
  ordinal: number | null;
  text: string;
  toProjectId: string;
  toProjectTitle: string;
  movedAt: string;
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
  /** The project's main branch, which the cards' "on main" names. */
  integration?: { upstreamRef?: string | null } | null;
  /** The explicit non-code mark (migration 0535) and who set it, when. */
  nonCode?: boolean;
  nonCodeSetBy?: 'OWNER' | 'COORDINATOR' | null;
  nonCodeSetAt?: string | null;
  /** The short reason given with the mark (0555); null when none was. */
  nonCodeReason?: string | null;
  /** The criteria this project moved out to a follow-up (board 02 G). */
  criteriaMovedOut?: readonly CriterionMovedOut[];
};

/** The mark's reason, quoted — or null when the project is unmarked or no reason was given. */
export function nonCodeReasonLine(project: Pick<ProjectDoneDocument, 'nonCode' | 'nonCodeReason'>): string | null {
  const reason = project.nonCodeReason?.trim();
  return project.nonCode && reason ? NON_CODE_REASON.replace('{reason}', reason) : null;
}

/** "Criterion 4 moved to" — the words before the destination's linked name. */
export function movedOutLead(moved: Pick<CriterionMovedOut, 'ordinal'>): string {
  return moved.ordinal ? MOVED_OUT_CRITERION.replace('{n}', String(moved.ordinal)) : MOVED_OUT_UNNUMBERED;
}

/** "by you · Nov 11, 19:40" — the words after the linked name, on both sides of a move. */
export function movedByLine(movedAt: string, format: (value: string | null | undefined) => string | null = formatDoneDateTime): string {
  const when = format(movedAt);
  return when ? `${MOVED_BY_YOU} · ${when}` : MOVED_BY_YOU;
}

/** "1 screenshot", "2 screenshots" — or null for none. */
export function screenshotCount(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? CRITERION_ONE_SCREENSHOT : CRITERION_SCREENSHOTS.replace('{n}', String(count));
}

/** The mark's provenance — "Marked by the coordinator · Nov 11" — or null for an unmarked project. */
export function nonCodeProvenance(
  project: Pick<ProjectDoneDocument, 'nonCode' | 'nonCodeSetBy' | 'nonCodeSetAt'>,
  format: (value: string | null | undefined) => string | null = formatDoneDate,
): string | null {
  if (!project.nonCode) return null;
  const who = project.nonCodeSetBy === 'COORDINATOR' ? NON_CODE_MARKED_BY_COORDINATOR : NON_CODE_MARKED_BY_YOU;
  const when = format(project.nonCodeSetAt);
  return when ? `${who} · ${when}` : who;
}

/** Whether the document is a marked project: the mark on the project, or on its derived read. */
export function isNonCode(project: Pick<ProjectDoneDocument, 'nonCode' | 'derivedDone'>): boolean {
  return project.nonCode === true || project.derivedDone?.nonCode === true;
}

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
  'NO_BRANCH',
  'NOTHING_TO_LAND',
  'CODELESS',
];

const REASON_LABELS: Record<CriterionLandingReason, string> = {
  IN_FLIGHT: 'in flight',
  ON_PROJECT_BRANCH: 'on the project branch',
  NOTHING_TO_LAND: PROJECT_DONE_COPY.nothingToLand,
  NO_RECEIPT: 'merged outside Orbit',
  NO_BRANCH: LANDING_RAN_WITHOUT_BRANCH.toLowerCase(),
  CODELESS: LANDING_NO_CODE_TO_LAND.toLowerCase(),
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
  // three compact card counts from the wording in the effect. NO_BRANCH is not counted: work that
  // ran without a branch may have changed code, and Orbit cannot see whether it reached main.
  return (counts.byReason?.NOTHING_TO_LAND ?? 0) + (counts.byReason?.CODELESS ?? 0);
}

/** Counts are deliberately read from `derivedDone.counts`; this function never inspects tasks. The
 *  tallies say where work landed on `main`, the project's main branch by name. */
export function projectDoneTally(counts: ProjectDoneCounts | undefined, main: string = DEFAULT_MAIN_BRANCH): string {
  if (!counts) return '';
  return [
    `${counts.criteria} criteria`,
    `${counts.met} met`,
    `${counts.onMain} ${landedOn(main)}`,
    ...reasonParts(counts),
  ].join(' · ');
}

/** The compact tally in the request card: the heading already states the number of criteria. */
export function projectDoneCardTally(
  counts: ProjectDoneCounts | undefined,
  main: string = DEFAULT_MAIN_BRANCH,
  options: { nonCode?: boolean; waitingConfirmation?: number } = {},
): string {
  if (!counts) return '';
  const waiting = options.waitingConfirmation ?? 0;
  const waitPart = waiting > 0 ? [DONE_CARD_WAIT_CONFIRMATION.replace('{n}', String(waiting))] : [];
  // A non-code project reads no landing: the criteria and how many are met, and nothing else.
  if (options.nonCode) {
    return [
      DONE_CARD_TALLY_OF.replace('{met}', String(counts.met)).replace('{n}', String(counts.criteria)),
      ...waitPart,
    ].join(' · ');
  }
  const noBranch = counts.byReason?.NO_BRANCH ?? 0;
  const nothing = nothingToLandCount(counts);
  return [
    `${counts.met} met`,
    `${counts.onMain} ${landedOn(main)}`,
    ...(noBranch > 0 ? [`${noBranch} ${REASON_LABELS.NO_BRANCH}`] : []),
    ...(nothing > 0 ? [`${nothing} ${PROJECT_DONE_COPY.nothingToLand}`] : []),
    ...waitPart,
  ].join(' · ');
}

/** The receipt's first phrase says how many criteria were met, rather than repeating the heading. */
export function projectDoneReceiptTally(
  counts: ProjectDoneCounts | undefined,
  acceptedGaps: number,
  main: string = DEFAULT_MAIN_BRANCH,
  nonCode = false,
): string {
  if (!counts) return `${acceptedGaps} ${PROJECT_DONE_COPY.gapsAccepted}`;
  if (nonCode) {
    return [`${counts.criteria} criteria met`, `${acceptedGaps} ${PROJECT_DONE_COPY.gapsAccepted}`].join(' · ');
  }
  return [
    `${counts.criteria} criteria met`,
    `${counts.onMain} ${landedOn(main)}`,
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
  derivedDone: Pick<ProjectDerivedDone, 'criteria' | 'nonCode'> | undefined,
  main: string = DEFAULT_MAIN_BRANCH,
): string {
  if (!derivedDone) return '';
  const met = derivedDone.criteria.filter((criterion) => criterion.satisfied);
  const notMet = derivedDone.criteria.length - met.length;
  if (derivedDone.nonCode) {
    return [
      `${derivedDone.criteria.length} criteria`,
      `${met.length} met`,
      ...(notMet > 0 ? [`${notMet} ${PROJECT_DONE_COPY.notMet}`] : []),
    ].join(' · ');
  }
  const byReason = Object.fromEntries(REASON_ORDER.map((reason) => [
    reason,
    met.filter((criterion) => criterion.landingReason === reason).length,
  ])) as Record<CriterionLandingReason, number>;
  return [
    `${derivedDone.criteria.length} criteria`,
    `${met.filter((criterion) => criterion.landingReason == null).length} ${whyNotDoneOn(main)}`,
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

/** A stable reason label, used by the Why-not-done card and its compact project-page row. Work with
 *  no reason not to be there landed on `main`, the project's main branch by name. */
export function landingReasonLabel(reason: CriterionLandingReason | null, main: string = DEFAULT_MAIN_BRANCH): string {
  switch (reason) {
    case 'IN_FLIGHT': return 'In flight';
    case 'ON_PROJECT_BRANCH': return PROJECT_DONE_COPY.onProjectBranch;
    case 'NO_RECEIPT': return PROJECT_DONE_COPY.mergedOutsideOrbit;
    case 'NOTHING_TO_LAND': return PROJECT_DONE_COPY.nothingToLand;
    case 'NO_BRANCH': return LANDING_RAN_WITHOUT_BRANCH;
    case 'CODELESS': return LANDING_NO_CODE_TO_LAND;
    default: return `Landed on ${main}`;
  }
}

export function isWaitingOnWork(reason: CriterionLandingReason | null): boolean {
  return reason === 'IN_FLIGHT' || reason === 'ON_PROJECT_BRANCH';
}

export function isNeedsYourCall(reason: CriterionLandingReason | null): boolean {
  return reason === 'NO_RECEIPT';
}

export const DONE_REQUEST_STALE_HEADING = 'The coordinator’s request went stale';
export const DONE_REQUEST_STALE_DETAIL = 'The coordinator has been told and will ask again when the work settles.';

export function staleDoneRequest(view: Pick<ProjectOpenItemsView, 'doneRequest' | 'latestDoneRequestSuperseded' | 'latestDoneRequestDecline'> | null | undefined): string | null {
  const stale = view?.latestDoneRequestSuperseded;
  if (view?.doneRequest || !stale) return null;
  const declined = view?.latestDoneRequestDecline;
  if (declined && Date.parse(declined.declinedAt) >= Date.parse(stale.supersededAt)) return null;
  return `${stale.reason.replace(/[.\s]+$/, '')}. ${DONE_REQUEST_STALE_DETAIL}`;
}

/**
 * One criterion's state on the done card's rows: met or not, then — for a criterion met by
 * confirmation — who confirmed it, or — for a criterion met by its tasks in a project that reads
 * landing — where its work is. An unmet criterion is "not met" and nothing more: its landing lane
 * describes work still to do. A non-code project's rows carry no landing at all.
 */
export function doneCriterionRowState(
  criterion: ProjectDoneCriterion,
  options: { nonCode?: boolean; main?: string } = {},
): { text: string; warn: boolean } {
  const met = criterion.satisfied ? 'met' : 'not met';
  if (criterion.satisfiedBy === 'CONFIRMATION') {
    const standing = criterion.confirmation;
    if (criterion.satisfied) {
      const kind = standing?.current?.confirmerKind;
      const by = kind === 'COORDINATOR' ? DONE_ROW_BY_COORDINATOR : kind === 'AGENT_CHECK' ? DONE_ROW_CHECK_PASS : DONE_ROW_BY_YOU;
      return { text: `${met} · ${by}`, warn: false };
    }
    const why = standing?.checkRunning
      ? DONE_ROW_CHECKING
      : standing?.state === 'CHECK_FAILED'
        ? DONE_ROW_CHECK_FAILED
        : standing?.state === 'STALE' ? DONE_ROW_STALE : DONE_ROW_WAITS;
    return { text: `${met} · ${why}`, warn: standing?.state === 'STALE' };
  }
  if (!criterion.satisfied || options.nonCode) return { text: met, warn: false };
  return {
    text: `${met} · ${landingReasonLabel(criterion.landingReason, options.main)}`,
    warn: criterion.landingReason === 'NO_BRANCH',
  };
}

/** The line under a confirmed criterion's row: who confirmed it, when, and what they said. */
export function confirmationLine(view: CriterionConfirmationView | null | undefined): string | null {
  if (!view) return null;
  const who = view.confirmerKind === 'COORDINATOR'
    ? DONE_ROW_CONFIRMED_BY_COORDINATOR
    : view.confirmerKind === 'AGENT_CHECK' ? DONE_ROW_CONFIRMED_BY_CHECK : DONE_ROW_CONFIRMED_BY_YOU;
  return [who, formatDoneDate(view.at), view.note ? `“${view.note}”` : null, screenshotCount(view.attachmentIds?.length ?? 0)]
    .filter(Boolean).join(' · ');
}

/** "criterion 4", "criteria 3 and 4", "criteria 2, 3 and 4". */
export function criteriaPhrase(ordinals: readonly number[]): string {
  if (ordinals.length === 1) return `criterion ${ordinals[0]}`;
  const head = ordinals.slice(0, -1).join(', ');
  return `criteria ${head} and ${ordinals[ordinals.length - 1]}`;
}

export type MoveCriterionResult = {
  fromProjectId: string;
  toProjectId: string;
  createdProject: boolean;
  criterionKey: string;
  movedTaskIds: string[];
  keptTaskIds: string[];
};

/** `POST /projects/:id/criteria/:criterionKey/move` — the owner's alone. */
export function moveCriterion(
  projectId: string,
  criterionKey: string,
  body: { toProjectId: string } | { newProject: { title: string; goal?: string | null } },
): Promise<MoveCriterionResult> {
  return api<MoveCriterionResult>(
    `/projects/${encodeURIComponent(projectId)}/criteria/${encodeURIComponent(criterionKey)}/move`,
    { method: 'POST', body },
  );
}

/** The owner's three doors on a criterion met by confirmation. */
export function confirmCriterion(
  projectId: string,
  criterionId: string,
  body: { note?: string; revision?: number; attachmentIds?: string[] },
): Promise<unknown> {
  return api(`/projects/${encodeURIComponent(projectId)}/criteria/${encodeURIComponent(criterionId)}/confirmations`, { method: 'POST', body });
}
export function withdrawCriterionConfirmation(projectId: string, criterionId: string): Promise<unknown> {
  return api(`/projects/${encodeURIComponent(projectId)}/criteria/${encodeURIComponent(criterionId)}/confirmations/withdraw`, { method: 'POST' });
}
export function startCriterionCheck(projectId: string, criterionId: string): Promise<unknown> {
  return api(`/projects/${encodeURIComponent(projectId)}/criteria/${encodeURIComponent(criterionId)}/checks`, { method: 'POST', body: {} });
}
