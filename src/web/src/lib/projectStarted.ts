import {
  PROJECT_START_SETTING_KEYS,
  type ProjectStartSettings,
  type ProjectStartedCard,
} from '@orbit/shared';

/**
 * The message telling a coordinator its project was started, as the control plane recorded it
 * beside the turn's echo (`projectStarted`, apiserver project-started.ts) — the reading
 * `ProjectStartedCard` is drawn from.
 *
 * Read the way `parseOpenItemDelivery` reads an exception item's card: the shape is checked and a
 * payload that is not a card parses as NOTHING rather than as half a card, which leaves the turn
 * drawn as the bubble it was before this existed. Nothing is derived from the prose.
 */
export function parseProjectStarted(payload: unknown): ProjectStartedCard | null {
  const raw = (payload as { projectStarted?: unknown } | null)?.projectStarted;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  // How it was started, and which project: those are what make it one.
  if (
    (card.by !== 'CONFIRMATION' && card.by !== 'SWITCH')
    || typeof card.projectId !== 'string' || card.projectId === ''
    || typeof card.projectTitle !== 'string'
  ) {
    return null;
  }
  const held = Array.isArray(card.held) ? card.held.flatMap(taskOf) : [];
  // What the start left the project running with, when it recorded it. A settings object this
  // build cannot read is left off whole — the card is still the card — rather than drawn half.
  const settings = settingsOf(card.settings);
  return {
    by: card.by,
    projectId: card.projectId,
    projectTitle: card.projectTitle,
    criteriaCount: count(card.criteriaCount),
    held,
    // Never fewer than it lists: a count that says so is not one a reader can act on.
    heldCount: Math.max(count(card.heldCount) ?? 0, held.length),
    ...(settings
      ? {
          settings,
          differsFromRequest: Array.isArray(card.differsFromRequest)
            ? PROJECT_START_SETTING_KEYS.filter((key) =>
                (card.differsFromRequest as unknown[]).includes(key),
              )
            : [],
        }
      : {}),
  };
}

function settingsOf(value: unknown): ProjectStartSettings | null {
  if (!value || typeof value !== 'object') return null;
  const settings = value as Record<string, unknown>;
  if (
    (settings.line !== 'PROJECT_BRANCH' && settings.line !== 'MAIN')
    || typeof settings.automatic !== 'boolean'
    || count(settings.maxConcurrentTasks) === null
    || (settings.mergeCheckCommand !== null && typeof settings.mergeCheckCommand !== 'string')
  ) {
    return null;
  }
  return {
    line: settings.line,
    ...(typeof settings.projectBranchName === 'string'
      ? { projectBranchName: settings.projectBranchName }
      : {}),
    automatic: settings.automatic,
    maxConcurrentTasks: settings.maxConcurrentTasks as number,
    mergeCheckCommand: (settings.mergeCheckCommand as string | null) ?? null,
  };
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function taskOf(value: unknown): ProjectStartedCard['held'] {
  if (!value || typeof value !== 'object') return [];
  const task = value as Record<string, unknown>;
  if (typeof task.id !== 'string' || task.id === '' || typeof task.title !== 'string') return [];
  return [{ id: task.id, title: task.title }];
}
