/**
 * docs/share-links-design.md §6, the red line, as the negative assertions every door that projects a session for
 * someone other than its owner is held to: the public link (`/shared/:token/…`, share-links/public-task.pg.spec.ts and
 * public-project.pg.spec.ts) and the guest door (`/guest-sessions/…`, session-guests/session-guests-projection.pg.spec.ts).
 * One list and one check, so the doors cannot drift apart: a field added here is refused by all of them.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/**
 * Contract §6 as field names: owner and account, runner and machine, repository, compute, the dispatch / convergence
 * / verification internals, comment delivery records. None of them is a field of any answer these doors give.
 */
export const RED_LINE_FIELDS: readonly string[] = [
  'owner', 'ownerId', 'ownerPublicId', 'userId', 'email', 'creatorId', 'creatorType', 'creatorSession',
  'creatorSessionId', 'assignee', 'assigneeId', 'authorId', 'authorType', 'authorName',
  'runner', 'runnerId', 'assignedRunnerId', 'targetRunnerId', 'workspaceId', 'workDir', 'repoUrl', 'env',
  'branch', 'baseSha', 'knownGoodSha', 'pinnedRevision', 'mergeCheckCommand', 'integration',
  'provider', 'providerBuiltin', 'model', 'costUsd', 'sumInputTokens', 'sumOutputTokens', 'contextTokens',
  'poolMemberProviderId',
  'dispatchAuthority', 'dispatchAttempt', 'dispatchHold', 'dispatchRefusal', 'autoRunWhenReady',
  'autoRunSkipped', 'priority', 'runAt', 'requiredCapabilities', 'idempotencyKey', 'progressState',
  'convergenceCounters', 'lastProgressAt', 'attemptGeneration', 'scopeRevision', 'completionFenceRevision',
  'completionCriterionOverrideReason', 'criterionDefinitionId', 'criterionRevision', 'verdict',
  'verifiesTaskId', 'verifier', 'verificationState', 'instructions', 'listId',
  'deliveries', 'mentions', 'mentionDeliveryVersion', 'lastError', 'requiredAction',
  'dependsOn', 'dependedOnBy', 'sessions', 'successorChain', 'supersedes',
];

/** Every key anywhere in an answer. */
export function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, into));
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Json)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

/**
 * What one answer carries across the red line: every `values` entry found anywhere in its text, and every `fields`
 * name found as a key of its envelope. A transcript's events are the conversation itself — command output and file
 * contents are what the Conversations layer warns about — so their payloads are searched for values but are not
 * fields of the page: the envelope's `events` and a single event's `payload` are left out of the key walk.
 */
export function redLineCrossings(
  answer: { text: string; json: Json },
  values: readonly string[],
  fields: readonly string[] = RED_LINE_FIELDS,
): { values: string[]; fields: string[] } {
  const json = answer.json ?? {};
  let envelope: Json = Array.isArray(json.events) ? { ...json, events: [] } : json;
  if ('payload' in envelope && 'seq' in envelope) envelope = { ...envelope, payload: null };
  const keys = keysOf(envelope);
  return {
    values: values.filter((value) => answer.text.includes(value)),
    fields: fields.filter((name) => keys.has(name)),
  };
}
