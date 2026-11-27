import {
  AUTO_CAPABLE_CLAUDE_MODELS,
  AgentProvider,
  autoAvailable,
  type RunnerModelCatalog,
} from '@orbit/shared';

import { codedRefusal } from '../common/refusal-recovery';
import { resolveProviderExec } from '../providers/custom-provider';

/**
 * A task runs only on a model that has Auto (owner rulings R1 and R2, project 350NMcNDulzkqRAFFUsXZ).
 *
 * Every task run starts in Auto, whether a person started it or a sweep did (TasksService
 * applyWorkspaceRun). The claim runs a Claude model that has no Auto in Default instead
 * (normalizeBuiltinPermissionMode), and an unattended run then stops at the first approval card. So
 * the model a task run gets must have Auto. This module is the one answer to whether it does: the
 * shared `autoAvailable`, asked of the assigned runner's catalogue, for the model the claim would
 * hand that runner (resolveProviderExec, the claim's own rule).
 *
 * Only Claude Code on its own sign-in makes Auto a question of the model. Every other engine has it
 * runtime-wide, and a configured key or an account pool has a model space the CLI decides, so the
 * functions here answer for that one case and the caller (TasksService) establishes it first.
 *
 * It has three readers:
 *  - the pin doors (create, batch create, update, batch pin) refuse a pin to a model without Auto
 *    when the pin is made;
 *  - every start refuses a task whose stored pin has no Auto, before any session exists;
 *  - a run that names no model is given one with Auto when the runner's default has none
 *    (autoModelForUnpinnedRun).
 */

export const TASK_MODEL_HAS_NO_AUTO = 'TASK_MODEL_HAS_NO_AUTO';

/** How many of the models that have Auto a refusal names in its sentence; `autoModels` lists all of them. */
const NAMED_ALTERNATIVES = 3;

/** The runner that would claim a task run: its name, its catalogue and the default it reports. Null when
 *  the task's assignee is bound to none, and the static list `autoAvailable` falls back to answers. */
export interface TaskRunAutoRunner {
  name: string;
  modelCatalog: unknown;
  runtimeDefaultModels: unknown;
}

/** Where a refusal is given: a pin door writes nothing, a start starts nothing. */
export type TaskRunAutoDoor = 'pin' | 'start';

function catalogOf(runner: TaskRunAutoRunner | null): RunnerModelCatalog | null {
  const catalog = runner?.modelCatalog;
  return catalog && typeof catalog === 'object' && !Array.isArray(catalog) ? (catalog as RunnerModelCatalog) : null;
}

/** The model the claim would hand `runner` for a Claude Code run on its own sign-in that names `model`. */
function claimedModel(model: string | null, runner: TaskRunAutoRunner | null): string {
  return resolveProviderExec({
    engine: AgentProvider.CLAUDE,
    declaredProvider: AgentProvider.CLAUDE,
    declaredProviderBuiltin: true,
    customRow: null,
    sessionModel: model,
    runtimeDefaultModels: runner?.runtimeDefaultModels,
    modelCatalog: runner?.modelCatalog,
  }).model;
}

function hasAuto(model: string, runner: TaskRunAutoRunner | null): boolean {
  return autoAvailable(AgentProvider.CLAUDE, model, false, catalogOf(runner));
}

/**
 * The Claude models that have Auto on this runner, in its catalogue's order (the runner's own
 * preference). A runner that reported no Claude catalogue gets the static list `autoAvailable` falls
 * back to.
 */
export function autoModelsOn(runner: TaskRunAutoRunner | null): string[] {
  const rows = catalogOf(runner)?.[AgentProvider.CLAUDE];
  const offered = Array.isArray(rows)
    ? rows.map((row) => (typeof row?.value === 'string' ? row.value.trim() : '')).filter((value) => value !== '')
    : [];
  if (offered.length === 0) return [...AUTO_CAPABLE_CLAUDE_MODELS];
  return [...new Set(offered)].filter((model) => hasAuto(model, runner));
}

/** "a", "a or b", "a, b or c". */
function either(models: readonly string[]): string {
  if (models.length <= 1) return models.join('');
  return `${models.slice(0, -1).join(', ')} or ${models[models.length - 1]}`;
}

/**
 * The refusal a Claude Code run on its own sign-in gets when it would not have Auto, or null when it
 * would. A pinned model is judged as the claim would run it. An unpinned run is refused only at a start,
 * and only when no Claude model on its runner has Auto: otherwise it is given one (autoModelForUnpinnedRun).
 */
export function claudeRunAutoRefusal(
  target: { model: string | null; runner: TaskRunAutoRunner | null },
  door: TaskRunAutoDoor,
  ids: Record<string, string | number | null | undefined> = {},
): Record<string, unknown> | null {
  const { model, runner } = target;
  if (model == null && door === 'pin') return null;
  const runsAs = claimedModel(model, runner);
  if (hasAuto(runsAs, runner)) return null;
  const autoModels = autoModelsOn(runner);
  if (model == null && autoModels.length > 0) return null;
  const on = runner ? ` on runner "${runner.name}"` : '';
  const there = runner ? ' there' : '';
  const startAgain = door === 'start' ? ', then start the task again' : '';
  let message: string;
  if (model == null) {
    message = `Task runs start in Auto, and no Claude model${on} has Auto, so this task was not started. ` +
      `Update Claude Code${there}, or pin the task to another engine${startAgain}.`;
  } else {
    const subject = runsAs === model ? model : `${model} (it runs as ${runsAs}${there})`;
    const refused = door === 'pin'
      ? `${subject} has no Auto${on}, so nothing was written.`
      : `this task is pinned to ${subject}, which has no Auto${on}, so it was not started.`;
    const instead = autoModels.length > 0
      ? `Pin a model that has Auto${there}, such as ${either(autoModels.slice(0, NAMED_ALTERNATIVES))}, ` +
        `or clear the model pin so the run gets one${startAgain}.`
      : `No Claude model${on} has Auto: update Claude Code${there}, or pin another engine${startAgain}.`;
    message = `Task runs start in Auto, and ${refused} ${instead}`;
  }
  return {
    ...codedRefusal(400, TASK_MODEL_HAS_NO_AUTO, message, ids),
    model,
    runsAs,
    engine: AgentProvider.CLAUDE,
    runner: runner?.name ?? null,
    autoModels,
  };
}

/**
 * For a Claude Code run on its own sign-in that names no model: the model to create it on instead of a
 * runner default that has no Auto, or null when the default has Auto. The first model with Auto in the
 * runner's catalogue, which lists them in the runner's preference order; null too when there is none,
 * which a start has already refused (claudeRunAutoRefusal).
 */
export function autoModelForUnpinnedRun(runner: TaskRunAutoRunner | null): string | null {
  if (hasAuto(claimedModel(null, runner), runner)) return null;
  return autoModelsOn(runner)[0] ?? null;
}
