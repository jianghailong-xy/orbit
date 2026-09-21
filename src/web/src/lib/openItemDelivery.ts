import type { OpenItemAction, OpenItemDeliveryCard, OpenItemKind } from '@orbit/shared';

/**
 * An exception item's delivery to the coordinator, as the control plane recorded it beside the
 * turn's echo — the reading `OpenItemDeliveryCard` is drawn from.
 *
 * The delivery itself is a paragraph of prose written for the AGENT (it names the tools to call and
 * the ids to call them with) and, until the payload existed, that paragraph was the only thing
 * recorded for it. A renderer had nothing to draw but the words, so the whole delivery turned up in
 * the transcript as a message somebody typed. This reads the fields the item was opened with — its
 * kind, its title, the files a merge conflicted on, the doors that exist — plus the one thing the
 * platform worked out on its own before handing it over: whether the work is already on the target
 * branch, which the coordinator otherwise re-checks by hand every single time.
 *
 * Read the way every other control-plane block is read (deliveredMessage, backgroundWake): the
 * shape is checked and a payload that is not a card parses as NOTHING rather than as half a card,
 * which leaves the turn drawn exactly as it was before this existed. Nothing here is derived from
 * the prose — a card is only ever drawn from the payload, so a delivery with no payload keeps its
 * old reading and can never be half-invented.
 */
export function parseOpenItemDelivery(payload: unknown): OpenItemDeliveryCard | null {
  const raw = (payload as { openItemDelivery?: unknown } | null)?.openItemDelivery;
  if (!raw || typeof raw !== 'object') return null;
  const card = raw as Record<string, unknown>;
  // A card names the item it is about, what kind it is and what it is called: those three are what
  // makes it one, and a payload missing any of them is not drawn at all (see the file comment).
  if (
    typeof card.itemId !== 'string' || card.itemId === ''
    || typeof card.kind !== 'string'
    || typeof card.title !== 'string' || card.title === ''
  ) {
    return null;
  }
  return {
    itemId: card.itemId,
    kind: card.kind as OpenItemKind,
    title: card.title,
    task: taskOf(card.task),
    files: strings(card.files),
    targetRef: stringOrNull(card.targetRef),
    check: checkOf(card.check),
    errorCode: stringOrNull(card.errorCode),
    failure: failureOf(card.failure),
    actions: strings(card.actions) as OpenItemAction[],
    landing: landingOf(card.landing),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function taskOf(value: unknown): OpenItemDeliveryCard['task'] {
  if (!value || typeof value !== 'object') return null;
  const task = value as Record<string, unknown>;
  if (typeof task.id !== 'string' || task.id === '' || typeof task.title !== 'string') return null;
  return { id: task.id, title: task.title, sessionId: stringOrNull(task.sessionId) };
}

function checkOf(value: unknown): OpenItemDeliveryCard['check'] {
  if (!value || typeof value !== 'object') return null;
  const check = value as Record<string, unknown>;
  if (typeof check.name !== 'string' || check.name === '') return null;
  return {
    name: check.name,
    exitCode: count(check.exitCode),
    expectedExitCode: count(check.expectedExitCode),
  };
}

function failureOf(value: unknown): OpenItemDeliveryCard['failure'] {
  if (!value || typeof value !== 'object') return null;
  const failure = value as Record<string, unknown>;
  const attempt = count(failure.attempt);
  const limit = count(failure.limit);
  if (attempt === null || limit === null) return null;
  return {
    how: stringOrNull(failure.how),
    exitCode: count(failure.exitCode),
    expectedExitCode: count(failure.expectedExitCode),
    attempt,
    limit,
  };
}

function landingOf(value: unknown): OpenItemDeliveryCard['landing'] {
  if (!value || typeof value !== 'object') return null;
  const landing = value as Record<string, unknown>;
  const receipts = count(landing.receipts);
  const state = landing.state;
  if (
    receipts === null
    || (state !== 'ON_UPSTREAM' && state !== 'ON_INTEGRATION_LINE' && state !== 'NOT_KNOWN')
  ) {
    return null;
  }
  return {
    receipts,
    state,
    upstream: typeof landing.upstream === 'string' ? landing.upstream : 'main',
    integration: typeof landing.integration === 'string' ? landing.integration : 'main',
  };
}
