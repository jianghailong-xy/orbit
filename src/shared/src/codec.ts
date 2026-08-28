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
  // The person whose HUMAN_SIGNOFF event supplied a task's completion judgment. It is returned
  // beside the event and names the user row exactly as ownerId/userId do.
  'signedById',
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
  // The project graph's ends, which name a MARK rather than a task: one task, or the run of them
  // a fold stands for. Same rule for the same reason — a mark id that is a task's id is encoded
  // in `marks[].id`, so an edge naming it in the other spelling matches no mark and the whole
  // picture loses its arrows. A synthetic mark id (`run:3`) is not a uuid, so it passes through
  // both here and in `id` untouched, and the two spellings still agree.
  'sourceMarkId',
  'targetMarkId',
  'verifiesTaskId',
  // Completion-evidence responses name their current judgment consumer under a wire-only name
  // that cannot be confused with the opaque runner requestId fence.
  'judgmentRequestId',
  // §13.5's supersession link: the later attempt that took a cancelled one's place. An address a
  // reader hands straight to task_get, exactly like `parentTaskId` beside it.
  'supersededByTaskId',
  // N11 judgment-request history points at the request for the newer evidence revision. It is an
  // address returned beside the old request and can be handed straight back to the request read.
  'supersededById',
  // N24's supersession audit names who caused the transition and which task Session they acted
  // from. These are provenance addresses, not the successor request named by `supersededById`.
  'supersededActorId',
  'supersededSourceSessionId',
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
  'definitionId',
  'criterionId',
  'evidenceTaskId',
  'evidenceSessionId',
  'evidenceRunId',
  'decidedById',
  // The user or authenticated runner principal recorded on a project criterion-set confirmation.
  // It is returned as audit provenance and is therefore an address just like `decidedById`.
  'confirmedById',
  'actingSessionId',
  // Unit L2's provenance columns on `task` (migration 0150): where a piece of work was NOTICED, as
  // distinct from `projectId`, which says whose goal it counts towards. Addresses a reader follows
  // — "show me the project that filed this", "open the session it came out of" — so they are
  // rendered the way every other address is. `sourceTaskId` is already above; it is the same name
  // the dependency graph uses for the same kind of thing, which is why L1 chose it.
  //
  // Being a public id says nothing about authority. They are evidence and no gate reads them
  // (contract §3 SC7); what puts them here is that a person handed one has somewhere to hand it.
  'discoveredFromProjectId',
  'sourceSessionId',
  // N10 completion evidence keeps both immutable source identities. The attempt is nullable for
  // legacy/manual Sessions, but when present it is as followable as the source Session beside it.
  'sourceAttemptId',
  'evidenceId',
  // N8's explicit legacy-import and bounded-backfill receipts. Each is an address returned by
  // the audit response (and pushTaskIds is the exact allowlist the operator supplied).
  'sourceCommentId',
  'sourceAuthorId',
  'importedById',
  'backfillBatchId',
  'pushTaskIds',
  // N12's device receipt names the reliable in-app item it projects. A delivery audit reader can
  // follow this address back to the independent request/version item; it is not a lease token.
  'inboxItemId',
  // N12's in-app item resolves the N11 text recipient into the concrete account UUID that owns the
  // inbox. It is an address returned to inbox/audit readers, not an opaque transport token.
  'recipientId',
  // Unit L4's recorded answer about one crossing (migration 0155): the two ends, the session that
  // asked, the person who answered and the one task the yes was spent on. Every one of them is an
  // address a reader follows — open that project, open that session, run that task — which is the
  // only question this set asks. It says nothing about authority: the gate reads `crossing_key` and
  // `state`, and neither is an id.
  'fromProjectId',
  'toProjectId',
  'requestedBySessionId',
  'decidedByUserId',
  'appliedTaskId',
  // The recorded answer itself, named in the refusal a declared crossing gets: the caller polls it
  // and a person opens it, so it is an address like every other id in an error body.
  'handoffId',
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
  // Owner Ratification's durable decision, reusable authority and two-phase action ledgers. These
  // all name rows a caller can inspect or hand back; whether the named authority is still valid is
  // decided by the database from its immutable scope, not by preserving UUID spelling.
  'templateId',
  'delegationId',
  'authorityId',
  'decisionRequestId',
  // Wire aliases returned by the append/CTA functions for those same durable rows.
  'ratificationId',
  'newDecisionRequestId',
  'intentId',
  // Outcome fact ingress is tenant-scoped, but each key is still an address in the canonical fact
  // and evaluation-cut APIs rather than an equality capability. Causal predecessor ids have the
  // same wire semantics as the fact id they reference.
  'tenantId',
  'grantId',
  'factId',
  'causalPredecessorFactId',
  'cutId',
  // The same row as `decisionId`, under the name `[K2]`'s task ledger uses for it: a convergence
  // decision names the project-level pass that produced it, and a caller may hand that back to
  // `/projects/:id/coordinator/status`. Two names because the two ledgers are joined by a reader,
  // not by a foreign key — a task's judgment must stay readable after the pass that made it is gone.
  'projectDecisionId',
  // `[K5]`: a finding names WHO reported it (which check, in which conversation) and WHAT it filed.
  // All three are addresses a caller hands back — to read the check, to open the session, to run
  // the defect — so all three are public ids like every other task and session reference here.
  'reporterTaskId',
  'reporterSessionId',
  'effectTaskId',
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
  // `[K6]` §7: the known-good point a merge landed, and the attempt that produced it. Addresses,
  // not fences — a checkpoint is audit material a person reads and quotes back ("merge cp X"), and
  // the merge gate's refusals name one, so it has to survive the round trip in the spelling
  // clients see. The same classification `findingId` carries for the same reason.
  'checkpointId',
  'attemptId',
  // EXECUTABLE v2's pre-spawn decision is an inspectable row and the runner hands this address
  // back at the idempotent start boundary.
  'admissionId',
  // The checkpoint a QUEUED merge was authorised for (`session`, migration 0152). It names the
  // same kind of thing `checkpointId` does and is read the same way — the server looks the row up
  // by id when the merge reports back. Deliberately NOT a fence: no runner echoes it, nothing
  // compares it byte-for-byte, and a reader handed one has somewhere to hand it.
  'mergeCheckpointId',
  // Wire-only, like the aggregates above: `[K6]`'s read states §7 CP6's baseline rather than
  // leaving a client to re-derive "the LATEST accepted one" by filtering. It is the same id under
  // a name that says which one it is, so it follows the same rule.
  'baselineCheckpointId',
  // Unit T4 (0173): the committed fact a coordinator judgment was made on
  // (`project_convergence_decision.wake_id` → `project_coordinator_wake`), and the blocker that
  // judgment raised (`.blocker_id` → `project_blocker`). Both are addresses: the ledger is audit
  // material somebody reads to ask "which fact stopped this project, and where is the row about
  // it", and the answer has to be an id they can hand back. Neither is a fence — nothing echoes
  // one back to be compared byte-for-byte, and neither is interpolated into a comparison whose
  // meaning a translation would change.
  //
  // `raisedBlockerId` rather than `blockerId`: this codec keys on the field NAME across every
  // payload, and `blockerId` is already the spelling `GET /tasks/:id/attribution` sends as a raw
  // uuid. Whether THAT should be base62 is its own question; classifying it here would answer it
  // by accident.
  'wakeId',
  'raisedBlockerId',
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
  // One-shot Owner Ratification capabilities. They authorize/commit an exact pending operation
  // and are compared byte-for-byte; exposing them as public row addresses would silently break
  // stale/duplicate CTA and action-commit fencing.
  'ctaToken',
  'commitToken',
]);
