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
  'parentTaskId',
  'batchId',
  'listId',
  'projectId',
  'tagId',
  'turnId',
  'approvalId',
  'assigneeId',
  // The project's coordinator, and any agent on its team. An Agent is a `workspace` row today, so
  // these name the same kind of thing `workspaceId` does — but under the name the coordinator API
  // uses, and a name that is only ever encoded on the way out and never decoded on the way in is
  // how a base62 string reaches a `::uuid` cast.
  'agentId',
  'coordinatorAgentId',
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
  'generation',
  'leaseGeneration',
  'leaseOwner',
  'inboxLeaseGeneration',
  'inboxLeaseOwner',
  'mergeOperationId',
  'mergeOperationOwner',
  'commitOperationId',
  'commitOperationOwner',
]);
