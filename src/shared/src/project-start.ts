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
