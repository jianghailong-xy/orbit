// Compact, URL-safe rendering of a 128-bit UUID as base62 (≤ 22 chars), used
// for short session/agent links. Bijective: `uuidToBase62` strips leading
// zeros, `base62ToUuid` re-pads to a full 32-hex UUID, so round-trips are exact
// regardless of how many high-order zero bits the id happens to have.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = 62n;
const MAX = 1n << 128n; // exclusive upper bound for a 128-bit value

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Encode a canonical UUID string to base62 (case-sensitive, ≤ 22 chars). */
export function uuidToBase62(uuid: string): string {
  if (!UUID_RE.test(uuid)) throw new Error(`invalid uuid: ${uuid}`);
  let n = BigInt('0x' + uuid.replace(/-/g, ''));
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % BASE)] + out;
    n /= BASE;
  }
  return out;
}

/** Decode a base62 string back to a canonical lowercase UUID. Throws on input
 *  that isn't valid base62 or that overflows 128 bits. */
export function base62ToUuid(s: string): string {
  if (!s) throw new Error('empty base62 id');
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid base62 char: ${ch}`);
    n = n * BASE + BigInt(v);
  }
  if (n >= MAX) throw new Error('base62 id out of 128-bit range');
  const hex = n.toString(16).padStart(32, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Accept either a canonical UUID or a base62 public id and return the UUID.
 *  Lets routes/links carry the short form while older raw-UUID links and
 *  internal callers keep working. Throws on input that is neither. */
export function toUuid(idOrPublicId: string): string {
  return UUID_RE.test(idOrPublicId) ? idOrPublicId.toLowerCase() : base62ToUuid(idOrPublicId);
}

// ── Which fields the codec is allowed to touch ────────────────────────────────────────────────
//
// ONE classification, read by both directions. The reason it has to be one list rather than a
// rule applied twice: a field encoded on the way out but not decoded on the way back in is not a
// type error anywhere — the base62 string reaches a `where` clause or a `::uuid` cast and either
// 500s or, worse, compares unequal forever. The lease fences below are exactly that shape, and a
// fence that never matches is how a merge wedges the whole runner.
//
// Every `@db.Uuid` column in the schema belongs to exactly one of these sets;
// `public-id-coverage.spec.ts` fails the build when a new column belongs to neither.

/** Fields naming a row a caller may legitimately be handed and hand back — an entity's own `id`
 *  and every foreign key to one. Accepted in either spelling on the way in (`PublicIdPipe` /
 *  `IsPublicId`); to be rendered base62 on the way out. */
export const PUBLIC_ID_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'ownerId',
  'userId',
  'sessionId',
  'parentSessionId',
  'rootSessionId',
  'creatorSessionId',
  'authorSessionId',
  'ownerSessionId',
  'coordinatorSessionId',
  'workspaceId',
  'foremanWorkspaceId',
  'coordinatorWorkspaceId',
  'runnerId',
  'assignedRunnerId',
  'targetRunnerId',
  'taskId',
  'dependsOnTaskId',
  // The dependency graph's computed fields. They name tasks exactly as `taskId` does, but they are
  // not columns, so `public-id-coverage.spec.ts` — which walks the schema — never asked about
  // them. Left unencoded they came back as raw uuids beside nodes whose `id` had been encoded, so
  // the focus matched no node and every edge pointed at nothing: the view fell back to "the
  // dependency graph could not be rendered" for every task that has a dependency.
  'focusTaskId',
  'sourceTaskId',
  'targetTaskId',
  'verifiesTaskId',
  // §13.5's supersession link: the later attempt that took a cancelled one's place. An address a
  // reader hands straight to task_get, exactly like `parentTaskId` beside it.
  'supersededByTaskId',
  // §13.8: the task a session is ABOUT rather than one it executes — an @-mention's reply thread.
  // Named in a session payload beside `taskId`, and handed to task_get by whoever reads it.
  'contextTaskId',
  // §13.8's mention-delivery ledger: the comment that made the mention, and the session the
  // message landed in. Both are addresses a client follows — "show me that comment", "open that
  // conversation" — so both are rendered the way every other address is.
  'commentId',
  'targetSessionId',
  // The session id a delivery INTENDS to use before it exists. Public for the same reason as the
  // one above: a stuck delivery's detail names it, and a reader who looks it up should find the
  // conversation once it has been created.
  'desiredSessionId',
  // §13.2's verification-failure record names four rows a caller reads and looks up: the check
  // that concluded, the task it concluded about, the defect subtask filed to fix it, and the
  // later check that cleared it. Every one of them is an address somebody hands to task_get.
  'verifierTaskId',
  'subjectTaskId',
  'defectTaskId',
  'resolvedByTaskId',
  'raisedByActionId',
  // §13.4's acceptance record: the run a project's DONE stands on, the run a criterion belongs to,
  // and the two rows a criterion cites as its evidence. Every one of them is an address somebody
  // hands straight back — `GET /projects/:id/acceptance/...`, `task_get`, a session link.
  'runId',
  'acceptedRunId',
  'evidenceTaskId',
  'evidenceSessionId',
  'parentTaskId',
  'batchId',
  'listId',
  'projectId',
  'eventId',
  'sourceId',
  'tagId',
  'turnId',
  'approvalId',
  'projectActionId',
  'decisionId',
  'resultSessionId',
  // ProjectAction subjects are currently tasks. Keep the generic wire name classified so an
  // action returned by the coordinator API can be handed back in either public-id spelling.
  'subjectId',
  'assigneeId',
  // The project's coordinator, and any agent on its team. An Agent is a `workspace` row today, so
  // these name the same kind of thing `workspaceId` does — but under the name the coordinator API
  // uses, and a name that is only ever encoded on the way out and never decoded on the way in is
  // how a base62 string reaches a `::uuid` cast.
  'agentId',
  'coordinatorAgentId',
  // The `workspace` row an Agent was mirrored out of (`agent.legacyWorkspaceId`, migration 0129).
  // An address, not a fence token: it is the one handle a caller holding an old agent id — an
  // `orbit agent` script, a recorded MCP payload, a bookmarked URL — hands back to ask "which
  // Agent is this now", so it has to survive the round trip in the spelling clients use.
  'legacyWorkspaceId',
  'creatorId',
  'authorId',
  'createdById',
  'approvedById',
  'decidedById',
  'actorId',
  'mentions',
  // Wire-only aggregates: no column of their own, but they carry the same ids in request and
  // response bodies, so they follow the same rule (see the `@IsPublicId({ each: true })` DTOs).
  'tagIds',
  'taskIds',
  'dependsOnTaskIds',
  'anchorTaskId',
  'attachmentIds',
]);

/** `@db.Uuid` columns that are NOT public ids. They are opaque lease/fence tokens: the runner
 *  echoes them back byte-for-byte (`runner-api.controller.ts` `parseLeaseGeneration`) and the
 *  server interpolates them into raw SQL as `::uuid`. Translating one breaks the fence silently,
 *  so neither direction may touch them — they are not addresses, they are equality tokens. */
export const NEVER_PUBLIC_ID_FIELDS: ReadonlySet<string> = new Set([
  // The coordination workspace a project's DERIVED coordinator identity was derived FROM
  // (`project_runtime`, migration 0114). It names a workspace row, but it is not an address: it is
  // the value `project_coordinator_reconcile` compares the seated agent against, byte-for-byte, to
  // tell an identity the database worked out from one somebody chose. It appears in no request and
  // no response, and decoding it on the way in is the one way to make that comparison lie.
  'coordinatorIdentityLandingId',
  'generation',
  'leaseGeneration',
  'leaseOwner',
  'inboxLeaseGeneration',
  'inboxLeaseOwner',
  // Project coordinator lease ownership is an internal compare-and-swap fence, not a row address.
  'leaseHolder',
  'mergeOperationId',
  'mergeOperationOwner',
  'commitOperationId',
  'commitOperationOwner',
  // The manual Project trigger's effect marker (`task_run_manual_trigger`, migration 0137). It
  // names no row a caller can ask for: it is `taskRunManualTriggerId(pressToken, projectId)`, a
  // value derived from the press so the marker and the outbox signal agree byte-for-byte about
  // which request already happened. Decoding it on the way in would make that comparison lie, and
  // it appears in no request and no response.
  'requestId',
]);
