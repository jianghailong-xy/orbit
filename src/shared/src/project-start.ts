import type { IntegrationLine } from './project-progress';

/**
 * Starting a project: the one write the account owner makes on the "Start this project?" card
 * (apiserver `POST /projects/:id/start`), and what it leaves behind.
 *
 * One set of types for every end of it. The start request a coordinator files, the card the web
 * and the native clients draw, the door's answer and the "Project started" card its coordinator is
 * shown all name the same five settings the same way, so a setting cannot mean one thing on the
 * card and another on the row it was written to.
 */

/**
 * How a project runs, as a start sets it.
 *
 * - `line` — where its finished tasks land: its own branch first (`PROJECT_BRANCH`), or straight on
 *   its upstream (`MAIN`). Written as the owner's choice, unless the line had already started
 *   integrating, which locks it.
 * - `projectBranchName` — the project branch as a full `refs/heads/…` ref, only with
 *   `PROJECT_BRANCH`. Absent on a request means `refs/heads/project/<project id>`, or the branch the
 *   project already names.
 * - `automatic` — `project.coordinator_enabled`: the coordinator runs the project for the owner.
 * - `maxConcurrentTasks` — how many of its tasks may be in flight at once.
 * - `mergeCheckCommand` — the check run on the combined tree before anything lands; null for none.
 */
export interface ProjectStartSettings {
  line: IntegrationLine;
  projectBranchName?: string;
  automatic: boolean;
  maxConcurrentTasks: number;
  mergeCheckCommand: string | null;
}

/** One of the settings above, as a difference names it. `line` covers the branch name too. */
export type ProjectStartSettingKey = 'line' | 'automatic' | 'maxConcurrentTasks' | 'mergeCheckCommand';

/** Every setting, in the order a card lists them. */
export const PROJECT_START_SETTING_KEYS: readonly ProjectStartSettingKey[] = [
  'line',
  'automatic',
  'maxConcurrentTasks',
  'mergeCheckCommand',
];

/**
 * The body of `POST /projects/:id/start`: the settings, and the version of the criteria the owner
 * read.
 *
 * `criteriaDigest` is the seal of the criteria as the card showed them (`project_get`'s digest over
 * each criterion's `definitionId:revision:contentHash`). A seal that is no longer current is a 409
 * and nothing is written: a start carried over an edit would confirm wording nobody read.
 * `requestId` names the coordinator's start request the card answered, when there was one.
 */
export interface StartProjectRequestBody extends ProjectStartSettings {
  criteriaDigest: string;
  requestId?: string | null;
}

/**
 * What a start left behind, beside the confirmation it wrote: the settings as they stand after it,
 * and which of them are not what the start was asked for.
 *
 * Stored on that confirmation (`project_standard_set_confirmation.started_with`), so every later
 * reader of the start — the "Project started" card, a receipt — reads the one record the start made
 * rather than today's settings, which somebody may have changed since.
 */
export interface ProjectStartRecord {
  settings: ProjectStartSettings;
  differsFromRequest: ProjectStartSettingKey[];
}

/** The door's answer to a start. A start that did not happen is a 4xx, never this body. */
export interface StartProjectResponse extends ProjectStartRecord {
  projectId: string;
  /** When the project was started: this start's own time, and from now on the project's. */
  startedAt: string;
  /** The seal the start confirmed, and how many criteria it named. */
  criteriaDigest: string;
  criteriaCount: number;
  /**
   * The line had already started integrating, so the start left it where it was. `settings.line`
   * is the line the project is on, which is not necessarily the one asked for — `differsFromRequest`
   * names `line` when it is not.
   */
  lineLocked: boolean;
}

/**
 * What `project_request_start` sends (`POST /runner/projects/:id/start-requests`): the settings the
 * coordinator suggests the project start with, and one sentence on why. The merge check may be left
 * out, which suggests none.
 */
export type ProjectStartRequestBody = Omit<ProjectStartSettings, 'mergeCheckCommand'> & {
  mergeCheckCommand?: string | null;
  why: string;
};

/**
 * The readiness check a start request goes through, in `task-plan-preflight`'s shape: `REFUSE`
 * means the plan is not ready and nothing is filed, `WARN` is a fact about what will happen once it
 * starts and is filed with the request. Every finding comes back at once.
 *
 * - `START_NO_CRITERIA` / `START_NO_TASKS` — nothing to judge done by, or nothing to run.
 * - `START_CRITERION_UNSERVED` — a criterion no task declares it serves (`criterionKey`).
 * - `START_TASK_HAS_NO_RUNNER` — tasks whose assignee is not a workspace bound to a runner.
 * - `START_REPOSITORY_UNKNOWN` — a project branch (or a merge check) asked for, and the project's
 *   coordination workspace names no repository.
 * - `START_TASKS_START_BY_HAND` (warn) — tasks set `autoRunWhenReady=false`.
 * - `START_NO_MERGE_CHECK` (warn) — Automatic on a project branch with no merge check: the branch
 *   would merge into main with nothing run on the combined tree.
 */
export type ProjectStartCheckCode =
  | 'START_NO_CRITERIA'
  | 'START_NO_TASKS'
  | 'START_CRITERION_UNSERVED'
  | 'START_TASK_HAS_NO_RUNNER'
  | 'START_REPOSITORY_UNKNOWN'
  | 'START_TASKS_START_BY_HAND'
  | 'START_NO_MERGE_CHECK';

export interface ProjectStartFinding {
  severity: 'REFUSE' | 'WARN';
  code: ProjectStartCheckCode;
  message: string;
  /** One executable sentence, as a blocker's `requiredAction` is. */
  requiredAction: string;
  /** The criterion a finding is about, by the `key` `project_get` gives it; null for the others. */
  criterion: { key: string; ordinal: number; text: string } | null;
  /** The tasks a finding is about, oldest first; empty for the others. */
  tasks: Array<{ taskId: string; title: string }>;
}

/**
 * A coordinator's request to start its project, as it is filed: the `START_REQUEST` open item's
 * payload, and what the owner's "Start this project?" card is drawn from.
 *
 * The two digests say which plan the request was made about. `criteriaDigest` is the seal of the
 * criteria (the one `POST /projects/:id/start` confirms); `planDigest` is a hash of the project's
 * tasks — each one's id and the criterion it serves — and of their dependency edges. A request whose
 * plan has moved since is superseded and no longer drawn: the coordinator asks again.
 */
export interface ProjectStartRequest {
  settings: ProjectStartSettings;
  why: string;
  criteriaDigest: string;
  planDigest: string;
  /** The repository the check found the project integrating into, or null for a project with none. */
  repository: string | null;
  /** The check's `WARN` findings: what the owner should know before pressing Start. */
  warnings: ProjectStartFinding[];
}

/** What filing a start request answers: the request, the open item that holds it, and the one it
 *  replaced. `alreadyOpen` is a re-send of the request already open, which writes nothing. */
export interface ProjectStartRequestFiled extends ProjectStartRequest {
  itemId: string;
  state: 'OPEN';
  alreadyOpen: boolean;
  superseded: { itemId: string } | null;
}

/** The 409 a start request that is not ready gets: every finding, refusals first. */
export interface ProjectStartNotReadyBody {
  code: 'START_REQUEST_NOT_READY';
  message: string;
  written: 0;
  findings: ProjectStartFinding[];
}

/**
 * Why a project is paused (`project.paused_reason`).
 *
 * - `OWNER` — the owner pressed Pause project (`POST /projects/:id/pause`).
 * - `LEGACY_AUTOMATIC_OFF` — a client that only knows the one Automatic switch turned it off
 *   (`PATCH /projects/:id {coordinatorEnabled: false}`). On those clients the switch was the
 *   project's on switch, so its off still means "stop"; switching it back on lifts this pause, and
 *   never an `OWNER` one.
 */
export type ProjectPauseReason = 'OWNER' | 'LEGACY_AUTOMATIC_OFF';

export const PROJECT_PAUSE_REASONS: readonly ProjectPauseReason[] = ['OWNER', 'LEGACY_AUTOMATIC_OFF'];

/**
 * Whether a project moves by itself, as `POST /projects/:id/pause` and `/resume` answer it.
 *
 * It moves while it is started and not paused. While `pausedAt` is set nothing starts its tasks by
 * itself — no release of a task that depends on nothing, no prerequisite finishing, no schedule, no
 * retry — an agent's `task_start` is refused, and nothing is merged into main by Automatic. The
 * owner's own Run still starts a task, and a run already going is not stopped. Automatic
 * (`coordinatorEnabled`) is a different question: who decides for the owner, not whether it moves.
 */
export interface ProjectPauseState {
  projectId: string;
  startedAt: string | null;
  pausedAt: string | null;
  pausedReason: ProjectPauseReason | null;
}

/** A merge check as it is stored: trimmed, and blank is none. */
function storedMergeCheck(command: string | null | undefined): string | null {
  return command?.trim() || null;
}

/**
 * Which of `settings` are not what `asked` asked for, in card order.
 *
 * A branch name the request did not give is not a difference: absent asks for whichever project
 * branch the project has. A merge check is compared as stored, so whitespace is not one either.
 */
export function differingStartSettings(
  asked: ProjectStartSettings,
  settings: ProjectStartSettings,
): ProjectStartSettingKey[] {
  const differs = new Set<ProjectStartSettingKey>();
  if (
    asked.line !== settings.line
    || (asked.line === 'PROJECT_BRANCH'
      && asked.projectBranchName !== undefined
      && asked.projectBranchName !== settings.projectBranchName)
  ) {
    differs.add('line');
  }
  if (asked.automatic !== settings.automatic) differs.add('automatic');
  if (asked.maxConcurrentTasks !== settings.maxConcurrentTasks) differs.add('maxConcurrentTasks');
  if (storedMergeCheck(asked.mergeCheckCommand) !== storedMergeCheck(settings.mergeCheckCommand)) {
    differs.add('mergeCheckCommand');
  }
  return PROJECT_START_SETTING_KEYS.filter((key) => differs.has(key));
}
