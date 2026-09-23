import type { ProjectStartedCard } from '@orbit/shared';

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
  return {
    by: card.by,
    projectId: card.projectId,
    projectTitle: card.projectTitle,
    criteriaCount: count(card.criteriaCount),
    held,
    // Never fewer than it lists: a count that says so is not one a reader can act on.
    heldCount: Math.max(count(card.heldCount) ?? 0, held.length),
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
