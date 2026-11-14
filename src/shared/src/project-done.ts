import type { TaskStatus } from './enums';
import type { OpenItemKind } from './project-progress';

/**
 * Who recorded a project's DONE (`project.done_by`, migration 0345): the account owner in person on
 * `POST /projects/:id/done`, or Orbit's projection from committed facts (`project-done-derived.ts`).
 *
 * An OWNER record is a decision and outlives the facts that move under it: a later task write, merge
 * receipt or confirmation does not reopen the project. Only the criteria changing, or a task serving
 * one of them being reopened, does — and the coordinator is told which. A DERIVED record is the
 * projection itself, and goes back to OPEN whenever its inputs stop holding.
 */
export type ProjectDoneBy = 'OWNER' | 'DERIVED';

/**
 * One gap the owner accepted when recording a project done: a criterion Orbit could not prove, and
 * what was checked instead.
 *
 * For a coordinator request the server keeps the object as it was sent. Without a request it
 * appends every current check finding, including project-wide findings anchored as documented below.
 * `criterionKey` is the anchor every version of the card carries; the rest is the explanation the card
 * showed, which may grow without making an older server unable to read a gap accepted earlier.
 */
export interface AcceptedGap {
  /** A criterion key, or `project:<projectId>` when scope is PROJECT. The latter is a
   * reserved project anchor, never the key of a stated criterion. */
  criterionKey: string;
  scope?: 'CRITERION' | 'PROJECT';
  /** The original check finding, retained for project-wide context and criterion details. */
  finding?: ProjectDoneFinding;
  /** A few words naming the gap — the card's headline for it. */
  title?: string;
  /** Why Orbit cannot prove the criterion. */
  whyNotProven?: string;
  /** What the coordinator checked instead. */
  coordinatorChecked?: string;
  /** Where that evidence is. */
  evidenceRefs?: string[];
  [key: string]: unknown;
}

/**
 * One gap as `project_request_done` files it: every part of the explanation is required, because
 * the owner decides on it — which criterion, why Orbit cannot prove it, what the coordinator checked
 * instead, and where that evidence is. One criterion may carry several gaps.
 */
export interface DoneRequestGap extends AcceptedGap {
  whyNotProven: string;
  coordinatorChecked: string;
  evidenceRefs: string[];
}

/**
 * A coordinator's request that its owner record the project done: the `DONE_REQUEST` open item's
 * payload, and what the owner's "Is this project done?" card is drawn from.
 *
 * `criteriaDigest` is the seal of the criteria the request was made about — the one
 * `POST /projects/:id/done` compares — so a request whose criteria have moved since is answered 409.
 * `stateDigest` does the same for the work: the project's tasks, where each criterion's work has
 * landed and the landings in flight, as the check read them. A request whose state has moved since
 * is superseded, and pressing Record as done on it is 409; one filed without the check carries none.
 */
export interface DoneRequest {
  criteriaDigest: string;
  /** The coordinator's call, in a sentence or two. */
  judgment: string;
  /** What Orbit cannot prove: the gaps, each naming its criterion. */
  gaps: AcceptedGap[];
  stateDigest?: string;
  /** The check's `WARN` findings: every criterion not LANDED, with why. */
  warnings?: ProjectDoneFinding[];
}

/**
 * Why a criterion is not on main by work of its own (D4), as the apiserver's
 * `criterion-landing-reason.ts` reads it off the landing lane's rows:
 *
 * - `IN_FLIGHT` — a landing of its work, or a merge of the project branch into main, is queued or
 *   running.
 * - `ON_PROJECT_BRANCH` — its work is on the project branch, with commits of its own, and nothing
 *   is taking it to main.
 * - `NOTHING_TO_LAND` — its work ran a branch and the line found no commit of its own on it.
 * - `NO_RECEIPT` — no receipt puts its work on either branch: merged outside Orbit, or not merged.
 * - `NO_BRANCH` — its work ran without a branch and no job or receipt names it, so Orbit cannot see
 *   whether its changes reached main.
 * - `CODELESS` — its work has nothing to land: declared codeless, or done in another repository.
 */
export type CriterionLandingReason =
  | 'IN_FLIGHT'
  | 'ON_PROJECT_BRANCH'
  | 'NOTHING_TO_LAND'
  | 'NO_RECEIPT'
  | 'NO_BRANCH'
  | 'CODELESS';

/**
 * `project_request_done` sends this (`POST /runner/projects/:id/done-requests`): the coordinator's
 * call in a sentence or two, and every criterion Orbit cannot prove.
 */
export interface RequestProjectDoneBody {
  judgment: string;
  gaps: DoneRequestGap[];
}

/**
 * The check a done request goes through, in `task-plan-preflight`'s shape: `REFUSE` means the project
 * is not ready to be recorded done and nothing is filed, `WARN` is filed with the request for the
 * owner to read. Every finding comes back at once.
 *
 * - `DONE_NO_CRITERIA` — the project states no criteria, so there is nothing to be done against.
 * - `DONE_CRITERION_UNSATISFIED` — a criterion its work has not met, one finding each.
 * - `DONE_TASKS_IN_FLIGHT` — tasks running, queued for a runner, or IN_PROGRESS.
 * - `DONE_OWNER_ITEMS_OPEN` — open items waiting on the owner.
 * - `DONE_INTEGRATION_IN_FLIGHT` — a landing or a merge into main (LAND_TASK, CHECK_PROMOTION,
 *   LAND_PROMOTION) queued or running.
 * - `DONE_CRITERION_UNLANDED` (warn) — a criterion not LANDED, one finding each, with its reason.
 */
export type ProjectDoneCheckCode =
  | 'DONE_NO_CRITERIA'
  | 'DONE_CRITERION_UNSATISFIED'
  | 'DONE_TASKS_IN_FLIGHT'
  | 'DONE_OWNER_ITEMS_OPEN'
  | 'DONE_INTEGRATION_IN_FLIGHT'
  | 'DONE_CRITERION_UNLANDED';

export interface ProjectDoneFinding {
  severity: 'REFUSE' | 'WARN';
  code: ProjectDoneCheckCode;
  message: string;
  /** One executable sentence, as a blocker's `requiredAction` is. */
  requiredAction: string;
  /** The criterion a finding is about, by the `key` `project_get` gives it; null for the others. */
  criterion: { key: string; ordinal: number; text: string } | null;
  /** Why the criterion is not LANDED — `DONE_CRITERION_UNLANDED` only; null for the others. */
  reason: CriterionLandingReason | null;
  /** The tasks a finding is about, oldest first; empty for the others. */
  tasks: Array<{ taskId: string; title: string }>;
  /** The owner's open items — `DONE_OWNER_ITEMS_OPEN` only. */
  items: Array<{ itemId: string; kind: OpenItemKind; title: string }>;
  /** The landings in flight — `DONE_INTEGRATION_IN_FLIGHT` only. */
  jobs: Array<{ integrationJobId: string; kind: string; state: string; taskId: string | null }>;
}

/** What filing a done request answers: the request, the open item that holds it, and the one it
 *  replaced. `alreadyOpen` is a re-send of the request already open, which writes nothing. */
export interface ProjectDoneRequestFiled extends DoneRequest {
  stateDigest: string;
  warnings: ProjectDoneFinding[];
  itemId: string;
  state: 'OPEN';
  alreadyOpen: boolean;
  superseded: { itemId: string } | null;
}

/**
 * What the account owner sends when the answer to a coordinator's done request is "Not yet…".
 *
 * The note is the owner's explanation of what is still missing.  The server trims it before it is
 * stored and before it is delivered to the coordinator; the wire type deliberately stays a plain
 * string so the same contract is usable by the web and native clients.
 */
export interface ProjectDoneRequestDeclineBody {
  note: string;
}

/** The result of ending a `DONE_REQUEST` with the owner's "Not yet…" answer. */
export interface ProjectDoneRequestDeclined {
  itemId: string;
  state: 'RESOLVED';
  resolution: 'DECLINED';
  /** The normalized note retained in `project_open_item.answer`. */
  note: string;
  /** Null when the project has no current coordinator conversation. */
  delivery: { sessionId: string; turnId: string } | null;
}

/** The 409 a done request that is not ready gets: every finding, refusals first. */
export interface ProjectDoneNotReadyBody {
  code: 'DONE_REQUEST_NOT_READY';
  message: string;
  written: 0;
  findings: ProjectDoneFinding[];
}

/**
 * `POST /projects/:id/done`. `requestId` is the `DONE_REQUEST` the press answers, or null when the
 * owner records it done without being asked; `criteriaDigest` is the seal the owner read, compared
 * under the project lock.
 */
export interface ProjectDoneRequestBody {
  requestId?: string | null;
  criteriaDigest: string;
  acceptedGaps: AcceptedGap[];
}

/** What `POST /projects/:id/done` answers: the record it wrote. */
export interface ProjectDoneRecord {
  projectId: string;
  status: 'DONE';
  doneBy: 'OWNER';
  doneAt: string;
  criteriaDigest: string;
  acceptedGaps: AcceptedGap[];
  requestId: string | null;
}

/** One criterion, as the check reads it. */
export interface DoneStateCriterion {
  stated: {
    ordinal: number;
    key: string;
    text: string;
    definitionId: string;
    definitionRevision: number;
    verificationMethod: string | null;
    completionCriterionOverrideReason: string | null;
    contentHash: string;
  };
  satisfied: boolean;
  /** The work holding it unmet, as the satisfaction lane names it; empty when nothing is filed. */
  heldUpBy: Array<{ taskId: string; title: string }>;
  landing: 'LANDED' | 'ON_INTEGRATION_LINE' | 'UNKNOWN';
  /** Why it is not LANDED (`criterion-landing-reason.ts`); null when it is. */
  reason: CriterionLandingReason | null;
  /** The serving work that has something to land and is not on the upstream. */
  heldOffLanded: Array<{ taskId: string; title: string }>;
}

/** One task of the project, as the check reads it. */
export interface DoneStateTask {
  id: string;
  title: string;
  status: `${TaskStatus}`;
  criterionDefinitionId: string | null;
  /** A run of it is going, or waiting for a runner — never the asking conversation's own. */
  run: 'RUNNING' | 'QUEUED' | null;
}

/** Everything the check and the digest read: the project as it stands. */
export interface DoneState {
  criteria: DoneStateCriterion[];
  /** Every task of the project, cancelled ones included, oldest first. */
  tasks: DoneStateTask[];
  /** The open items waiting on the owner, oldest first — this kind's own excepted. */
  ownerItems: Array<{ itemId: string; kind: OpenItemKind; title: string }>;
  /** The landings and merges into main queued or running, oldest first. */
  jobs: Array<{ integrationJobId: string; kind: string; state: string; taskId: string | null }>;
  criteriaDigest: string;
  stateDigest: string;
  /** The project carries the explicit non-code mark (migration 0535): it reads no landing, so no
   *  criterion carries a `reason` or `heldOffLanded`, and no `DONE_CRITERION_UNLANDED` is found. */
  nonCode: boolean;
}

/** GET /projects/:id/done-check: owner read, with no asking session excluded.
 * REFUSE findings inform the owner; they do not prevent an owner record. */
export interface ProjectDoneCheck extends DoneState {
  findings: ProjectDoneFinding[];
}

/**
 * `POST /projects/:id/criteria/:criterionKey/move` — the done card's "Move to a follow-up…": one
 * unmet acceptance criterion of this project, and the serving tasks of it that are not DONE or
 * CANCELLED, moved to another project in one transaction. Name exactly one destination:
 * `toProjectId`, an OPEN project of the same owner, or `newProject`, created by the move.
 *
 * The account owner's alone: a request made from a session is refused 403.
 */
export interface MoveCriterionRequestBody {
  toProjectId?: string;
  newProject?: { title: string; goal?: string | null };
}

/** Why a move was refused (409 unless noted), each with the tasks or items that stand in the way. */
export const MOVE_CRITERION_REFUSALS = [
  /** 400: neither or both of `toProjectId` and `newProject` were sent, or the title is blank. */
  'CRITERION_MOVE_TARGET_REQUIRED',
  /** 400: `toProjectId` is the project the criterion is already in. */
  'CRITERION_MOVE_SAME_PROJECT',
  /** The source project is DONE or CANCELLED: reopen it first. */
  'CRITERION_MOVE_SOURCE_NOT_OPEN',
  /** The destination project is DONE or CANCELLED. */
  'CRITERION_MOVE_TARGET_NOT_OPEN',
  /** The criterion is met; only an unmet criterion is moved to a follow-up. */
  'CRITERION_MOVE_CRITERION_MET',
  /** A task that would move has a live run (queued, running, waiting for input or interrupted). */
  'CRITERION_MOVE_TASK_RUNNING',
  /** A task that would move is being landed on the source project's line. */
  'CRITERION_MOVE_TASK_LANDING',
  /** A task that would move is being written by something else right now; try again. */
  'CRITERION_MOVE_BUSY',
  /** A task that would move depends on, or is depended on by, open work staying behind. */
  'CRITERION_MOVE_DEPENDENCY_CROSSES',
  /** A parent, subtask, check, supersession or fix link would cross the two projects. */
  'CRITERION_MOVE_LINK_CROSSES',
  /** An open item about a task that would move belongs to the source project (a landing on its line,
   *  a question its coordinator asked) and is answered there first. A TASK_FAILED item moves with
   *  its task instead. */
  'CRITERION_MOVE_TASK_ITEM_OPEN',
] as const;
export type MoveCriterionRefusal = (typeof MOVE_CRITERION_REFUSALS)[number];

/** What a move answers: where the criterion went and what went with it. */
export interface MoveCriterionResult {
  fromProjectId: string;
  toProjectId: string;
  /** True when the destination was created by this move. */
  createdProject: boolean;
  /** The criterion's key, which the move does not change. */
  criterionKey: string;
  /** Serving tasks that moved with it. */
  movedTaskIds: string[];
  /** DONE and CANCELLED serving tasks, which stay with the source project and no longer serve the
   *  criterion (their declaration reads as one whose criterion is gone). */
  keptTaskIds: string[];
  /** Open TASK_FAILED items about the moved tasks, which moved with them. */
  movedOpenItemIds: string[];
  /** The source project's criteria seal before and after the move. */
  fromCriteriaDigest: { before: string; after: string };
}
