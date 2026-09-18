/**
 * How a project's work reaches its integration line, as every client reads it
 * (`docs/project-integration-line-contract.md` §7.0).
 *
 * One declaration rather than one per client. The web has always re-declared the project shapes it
 * renders in `ProjectsPage.tsx`, and that was affordable while the fields were a title and a count;
 * the states below are not — `TaskIntegrationState` is a closed set the server writes and the row
 * COLOURS by, so a client carrying its own copy of it renders a row the server never described.
 *
 * `Instant` is the one thing that legitimately differs across the wire: the apiserver holds these
 * as `Date`, everything downstream of JSON holds them as ISO strings. Parameterising it is what
 * lets both sides name the same interface instead of keeping two that drift.
 */

/** Where this project's finished tasks land: straight onto main, or onto a branch of its own. */
export type IntegrationLine = 'MAIN' | 'PROJECT_BRANCH';

/** Who decided the line — the account owner in the settings, or the default rule at the first
 *  integration (§1.2 L1 / L2). */
export type IntegrationRefSource = 'EXPLICIT' | 'DEFAULT_RULE';

/** Whether the merge check passed the last time the platform ran it on the line's tip (§1.6).
 *  `UNKNOWN` is the absence of a finished job, never a failure it forgot about. */
export type MergeCheckTipState = 'PASSING' | 'FAILING' | 'UNKNOWN';

/**
 * The line itself, as `GET /projects/:id/integration` answers and the project document's settings
 * half repeats (§1.6).
 *
 * Every absence names its reason rather than arriving as a bare null: "nobody chose a line and
 * nothing has integrated yet" and "there is no merge check" are different states, and a client that
 * had to guess between them would print one of them as the other.
 */
export interface ProjectIntegrationSettings<Instant = string> {
  line: IntegrationLine | null;
  lineAbsentReason: 'NOT_DECIDED' | null;
  /** The integration line's branch, spelled as a merge receipt spells it (no `refs/heads/`). */
  ref: string | null;
  upstreamRef: string | null;
  source: IntegrationRefSource | null;
  /** Integration started, so the line can no longer change (§1.2 L4). */
  locked: boolean;
  startedAt: Instant | null;
  mergeCheckCommand: string | null;
  mergeCheckCommandAbsentReason: 'NOT_CONFIGURED' | null;
  mergeCheckTimeoutSeconds: number | null;
  /** How long an exception item may wait on the coordinator before it becomes the owner's (§4.6). */
  escalationSeconds: number;
}

/**
 * The settings plus what the integration queue has done with them (§1.6): the five facts the
 * project page's line row is drawn from.
 *
 * The two counts are plain numbers because zero is the ordinary answer and says something true —
 * nothing in flight. The two instants are not: a project that has never synced with main is not one
 * that synced at the epoch.
 */
export interface ProjectIntegrationView<Instant = string> extends ProjectIntegrationSettings<Instant> {
  /** How far the line is ahead of upstream, from the newest finished `LAND_TASK`. */
  commitsAheadOfUpstream: number | null;
  commitsAheadOfUpstreamAbsentReason: 'NO_LANDING_YET' | null;
  /** When upstream was last absorbed into the line (§3.1). */
  lastUpstreamSyncAt: Instant | null;
  lastUpstreamSyncAbsentReason: 'NEVER_SYNCED' | null;
  /** Jobs this project has RUNNING and QUEUED right now. */
  integratingCount: number;
  queuedCount: number;
  mergeCheckOnTip: MergeCheckTipState;
}

/**
 * Where one task stands between "done" and "on main" (§2.7).
 *
 * `NOT_APPLICABLE` is the state of most rows in most projects and is not a gap: a codeless task, or
 * one in a project that has not started integrating, has nothing to land, and a row that said
 * "queued" about it would be describing work nobody is going to do.
 */
export type TaskIntegrationState =
  | 'NOT_APPLICABLE'
  | 'QUEUED'
  | 'RUNNING'
  | 'CONFLICT'
  | 'CHECK_FAILED'
  | 'ERROR'
  | 'AWAITING_OWNER'
  | 'ON_INTEGRATION_LINE'
  | 'ON_UPSTREAM';

/** Who is expected to act on this task's integration, while somebody has to (§4.2). */
export type TaskIntegrationHandler = 'COORDINATOR' | 'OWNER';

/** One task's integration, as the project page's task rows read it (§2.7, §7.3 V10). */
export interface TaskIntegrationView<Instant = string> {
  state: TaskIntegrationState;
  /** When the task entered this state. */
  since: Instant | null;
  handler: TaskIntegrationHandler | null;
  openItemId: string | null;
  jobId: string | null;
  /** How long the combined-tree checks have been running, for the row that says so. */
  checksRunningForMs: number | null;
}

/**
 * The three lanes a project's `done` count splits across once it has an integration line, plus the
 * two numbers that make the split readable (§7.2 V6).
 *
 * `done = integrating + onIntegrationLine + onUpstream + doneNotIntegrated` is the invariant the
 * card is drawn from: a project page that showed four lanes summing to something other than its own
 * done count would be inviting the reader to find the missing task.
 *
 * Optional as a set: a server that does not report them is a project page that draws the single
 * Done lane it always drew, rather than one showing three zeroes.
 */
export interface ProjectIntegrationBuckets {
  /** DONE code work the platform still has in hand: queued, checking, or stopped on an exception. */
  integrating: number;
  /** Landed on the project's own branch and not yet on main. Always 0 on a `MAIN` line. */
  onIntegrationLine: number;
  onUpstream: number;
  /** DONE work with nothing to land: codeless tasks, and every task of a project that has no line. */
  doneNotIntegrated: number;
  /** Blocked tasks held by nothing but a prerequisite that is finished and not yet landed (§2.5 J9). */
  waitingForLanding: number;
}
