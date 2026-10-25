/**
 * What the owner's confirmation card shows above its buttons: what Orbit will do once an
 * OWNER_CONFIRMED task is confirmed — `ifConfirmed` on `GET /tasks/:taskId/owner-confirmation`.
 *
 * Every fact here is the server's, computed when the card is read, and only while a run is waiting
 * on the owner. Best-effort: an item the server could not read this time is ABSENT — never a guess —
 * and the rest of the card is unaffected. One declaration for the web and OrbitKit, so the clients
 * cannot draw consequences the server never described.
 */

/**
 * When a task that waits on this one starts once it is DONE:
 *
 *  - NOW — by itself, and a slot is free for it: its runner's and its list's budget, its list's
 *    priorities and its project's limit all have room.
 *  - WHEN_SLOT_FREES — by itself, but one of those is full; it starts once a slot frees.
 *  - MANUAL — not by itself (`autoRunWhenReady` is off): it becomes ready and waits for somebody.
 */
export type OwnerConfirmationStart = 'NOW' | 'WHEN_SLOT_FREES' | 'MANUAL';

/** One task that waits on this one and that confirming releases. */
export interface OwnerConfirmationStartsTask {
  id: string;
  title: string;
  starts: OwnerConfirmationStart;
}

/**
 * Whether the run's branch is on main — the project's upstream, or main/master outside a project.
 * A merge receipt decides (a squash or rebase merge puts the work there under new commits); the
 * runner's own verdict answers only where no receipt does. UNKNOWN when neither says.
 */
export type OwnerConfirmationOnMain = 'YES' | 'NO' | 'UNKNOWN';

/** The branch the waiting run worked on. */
export interface OwnerConfirmationBranch {
  name: string;
  /** Counted as the run's `changedFiles` counts them: a binary file adds no lines. */
  linesAdded: number;
  linesRemoved: number;
  files: number;
  onMain: OwnerConfirmationOnMain;
}

/**
 * How the task's work reaches main once it is DONE:
 *
 *  - NONE — confirming lands nothing: the task is in no project, is codeless, or its work took no
 *    branch.
 *  - LINE_THEN_OWNER — it goes onto the project's integration line, and merging that into main
 *    asks the owner.
 *  - AUTO_MAIN — it goes onto the project's own branch, and with Automatic on the platform merges
 *    it into main by itself once the check is clean.
 */
export type OwnerConfirmationLanding = 'NONE' | 'LINE_THEN_OWNER' | 'AUTO_MAIN';

/** The task's run, which its DONE ends (`end_reason` task_done). */
export interface OwnerConfirmationEndsSession {
  sessionId: string;
  /** Its `bg_run` jobs still running, which ending it stops. */
  runningBgJobs: number;
}

export interface OwnerConfirmationIfConfirmed {
  /** The tasks waiting on this one that its DONE releases; empty when it releases none. */
  startsTasks?: OwnerConfirmationStartsTask[];
  /**
   * True when those tasks are released by this task's work LANDING on its project's line rather
   * than by the confirmation itself: a project holds a task's dependents until its work is there.
   */
  startsAfterLanding?: boolean;
  /** Null when the run worked on no branch. */
  branch?: OwnerConfirmationBranch | null;
  landing?: OwnerConfirmationLanding;
  /** Null when no run of the task is open for the DONE to end. */
  endsSession?: OwnerConfirmationEndsSession | null;
  /**
   * The project's main branch by name — `project_codebase.upstream_ref` without `refs/heads/` — that
   * the branch and landing rows say "main" of. Null when the task is in no project or its project
   * has no repository bound, and the rows say main.
   */
  mainBranch?: string | null;
}
