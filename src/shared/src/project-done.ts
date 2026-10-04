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
 * The server keeps the object as it was sent. `criterionKey` is the anchor every version of the card
 * carries (the criterion's `key`, as `project_get` returns it); the rest is the explanation the card
 * showed, which may grow without making an older server unable to read a gap accepted earlier.
 */
export interface AcceptedGap {
  criterionKey: string;
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
 * - `CODELESS` — its work has no branch to land.
 */
export type CriterionLandingReason =
  | 'IN_FLIGHT'
  | 'ON_PROJECT_BRANCH'
  | 'NOTHING_TO_LAND'
  | 'NO_RECEIPT'
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
