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
  /** Why Orbit cannot prove the criterion. */
  whyNotProven?: string;
  /** What the coordinator checked instead. */
  coordinatorChecked?: string;
  /** Where that evidence is. */
  evidenceRefs?: string[];
  [key: string]: unknown;
}

/**
 * A coordinator's request that its owner record the project done: the `DONE_REQUEST` open item's
 * payload, and what the owner's "Is this project done?" card is drawn from.
 *
 * `criteriaDigest` is the seal of the criteria the request was made about — the one
 * `POST /projects/:id/done` compares — so a request whose criteria have moved since is answered 409.
 */
export interface DoneRequest {
  criteriaDigest: string;
  /** The coordinator's call, in a sentence or two. */
  judgment: string;
  /** Every criterion Orbit cannot prove, one gap each. */
  gaps: AcceptedGap[];
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
