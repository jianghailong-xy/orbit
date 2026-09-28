import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  KIND_SPECS,
  WIKI_DEFAULT_SPACE_SETTINGS,
  WIKI_KINDS,
  WIKI_LIMITS,
  WIKI_MACHINE_TRUST,
  WIKI_REJECT_REASONS,
  WIKI_REVIEW_RULES,
  WIKI_SOURCE_KINDS,
  WIKI_VERIFICATION_VERDICTS,
  validateWikiEntryChanges,
  validateWikiEntryDraft,
  validateWikiSources,
  toUuid,
  uuidToBase62,
  wikiReviewEffect,
  wikiSpaceSettings,
  wikiTieredBasis,
  wikiVerdictTrust,
  type WikiAnchorInput,
  type WikiAnchorState,
  type WikiChangesetOrigin,
  type WikiDecideAction,
  type WikiEntryChanges,
  type WikiEntryKind,
  type WikiEntryStatus,
  type WikiFieldError,
  type WikiKind,
  type WikiOp,
  type WikiOpOutcome,
  type WikiRejectReason,
  type WikiRefusal,
  type WikiRefusalCode,
  type WikiReviewEffect,
  type WikiReviewMode,
  type WikiSimilar,
  type WikiSourceKind,
  type WikiSpaceSettings,
  type WikiTieredBasis,
  type WikiTrust,
  type WikiVerdictInput,
  type WikiVerificationItem,
  type WikiVerificationOutcome,
  type WikiVerificationVerdict,
} from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { redactSecrets } from '../common/secret-redaction';
import { mergeReceiptText, ownerResolutionText } from './wiki-dossier';
import { setWikiMaintenance, type WikiMaintenanceInput } from './wiki-maintenance-settings';
import { isOrbitAuthoredTurn } from '../sessions/orbit-authored-turn';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { canonicalRepoUrl } from '../projects/project-integration-line';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';

/** `Prisma.TransactionClient`, named once: every write below takes one, never the unmanaged client. */
type Tx = Prisma.TransactionClient;

/**
 * Orbit Wiki's ONE write entry point (design §4.1), and the reads its two doors serve.
 *
 * EVERYTHING THAT WRITES A WIKI ROW COMES THROUGH HERE. `submitChangeset` is what an agent's
 * proposal, the owner's own edit, a maintenance run and an import all reach; `decide` is the owner's
 * answer to what waits in Review; and `revertChangeset` and `rejectEntry` are the owner's answer to
 * what a space's review mode applied without waiting (contract `reviewModes`). No other service
 * writes `wiki_entry`.
 *
 * WHAT APPLIES AT ONCE is the effect policy's answer first and the space's review mode's second
 * (`wikiReviewEffect`): Manual is phase 1 exactly; Tiered applies an add or an amend of what the
 * machine wrote, and Automatic takes the same ops but applies none of them until a verification
 * says so (`recordVerifications`, contract `reviewModes.verification`) — never past the floors: a
 * principle, a tainted op, a change to what the owner wrote or confirmed, the circuit breaker and
 * thirty ops a changeset hold in every mode.
 *
 * THE ENTRY'S STATE HAS EXACTLY TWO WRITERS. `applyOp` and `recomputeFlags` are the only functions
 * that write `wiki_entry.status`, `trust`, `challenged` and `unsupported` — the Wikova lesson
 * (design §3), and `common/db-write-inventory.ts` registers those two writers and no other. What
 * else a write touches is append-only (`wiki_entry_revision`, `wiki_source`), a changeset row, or a
 * column no reader derives a decision from.
 *
 * ACTORS COME FROM CREDENTIALS, NEVER FROM A BODY. The door decides who is asking: the JWT door is
 * the owner (`origin: 'owner'`), the runner door is a session that runner hosts (`origin: 'agent'`),
 * and a headless runner call is an agent with no session — which may still only PROPOSE. No parameter
 * anywhere below could name another owner.
 *
 * WHAT THIS FILE DOES NOT DO YET, and who owns it: the `<orbit_wiki_context>` delivery (T6),
 * anchors' re-verification, which needs git on a runner (phase 2), and the review queue's 14-day
 * expiry sweep, which the contract gives an `expires_at` and no worker yet. Of the writes the contract has announce a change
 * (`realtime.publishedWhen`), the two below do: a recorded changeset, and a decided one. A space
 * created, a setting changed and a workspace bound announce nothing yet.
 */

// ── The shape of a caller ───────────────────────────────────────────────────────────────────────

/** Who is writing, as their credential proved at the door. */
export interface WikiPrincipal {
  /** The changeset's origin (contract `changesetOrigins`): phase 1 writes `owner` and `agent`. */
  origin: WikiChangesetOrigin;
  ownerId: string;
  /** The authenticated account, on the owner door; null on the runner door. */
  userId: string | null;
  /** The calling session a runner hosts; null headless (and always null on the owner door). */
  sessionId: string | null;
  /** The tool call this proposal came from, when the door knows it. */
  toolCallId: string | null;
  /**
   * Who authors the revisions the write makes (contract `authorKinds`), when the origin alone does not
   * say: a one-off import the server runs itself is `system`. Left out, the owner's write is the
   * owner's and everything else an agent's.
   */
  authorKind?: WikiAuthor['authorKind'];
}

/**
 * The body of `POST /api/wiki/spaces/:id/changesets` and of the runner door's propose route.
 *
 * `ops` and `rationale` are `unknown` rather than typed: what they must hold is the contract's, and
 * WIKI_SCHEMA is the answer when they do not — a class-validator message cannot carry that code.
 */
export interface WikiProposeInput {
  ops?: unknown;
  rationale?: unknown;
  idempotencyKey?: string;
  dryRun?: boolean;
}

/** What the owner answers, one op at a time. */
export interface WikiDecisionInput {
  opId: string;
  action: WikiDecideAction;
  edited?: unknown;
  reason?: WikiRejectReason;
  note?: string;
}

/** Who authored the revision an apply writes (contract `authorKinds`). */
export interface WikiAuthor {
  authorKind: 'owner' | 'agent' | 'maintenance' | 'system';
  authorUserId: string | null;
  authorSessionId: string | null;
  authorToolCallId: string | null;
  changesetOpId: string | null;
}

/**
 * Each refusal code's HTTP status (contracts/wiki.contract.json `refusals`). The service raises the
 * code; the door answers this status, so a caller reading either one is told the same story.
 */
const WIKI_HTTP_STATUS: Readonly<Record<WikiRefusalCode, number>> = {
  WIKI_DISABLED: 404,
  WIKI_SPACE_UNBOUND: 409,
  WIKI_SCHEMA: 400,
  WIKI_KIND_OWNER_ONLY: 403,
  WIKI_SOURCE_UNRESOLVED: 422,
  WIKI_QUOTE_NOT_FOUND: 422,
  WIKI_REVISION_CONFLICT: 409,
  WIKI_QUOTA: 429,
  WIKI_REVIEW_QUEUE_FULL: 429,
  WIKI_PROBE_REFUSED: 422,
  WIKI_OWNER_CHANNEL_ONLY: 403,
  WIKI_NOT_MAINTENANCE_SESSION: 403,
  WIKI_SESSION_EXCLUDED: 403,
  WIKI_IDEMPOTENCY_KEY_REUSED: 409,
  WIKI_CURSOR_BEHIND: 409,
  WIKI_CURSOR_INVALID: 400,
  WIKI_ARTICLE_STALE: 409,
};

/** A refusal carrying a contract code, thrown out of the service and answered by the door. */
export class WikiRefusalError extends HttpException {
  constructor(readonly refusal: WikiRefusal) {
    super(refusal, WIKI_HTTP_STATUS[refusal.code]);
  }
}

function refuse(code: WikiRefusalCode, message: string, errors?: WikiFieldError[]): never {
  throw new WikiRefusalError(errors ? { code, message, errors } : { code, message });
}

/**
 * The status a submission's answer is served with (contract `refusalRules.status`).
 *
 * A request that recorded something is a 200. A request none of whose ops was recorded answers with
 * the status of its FIRST failure — a refusal's own code's status, or 409 for a compare-and-set that
 * no longer held — and carries every op's outcome in the body, so a batch whose first op was refused
 * and whose second was recorded is still a 200.
 */
export function answerFor(result: Record<string, unknown>): Record<string, unknown> {
  const status = submissionStatus(result);
  if (status !== 200) throw new HttpException(result, status);
  return result;
}

/**
 * The status a verification report is served with (contract `reviewModes.verification.report`), on
 * the same rule as a submission's: a report that recorded a verdict — or found one already recorded
 * the same way — is a 200, and one none of whose verdicts was recorded answers with the status of its
 * first refusal, every outcome in the body.
 */
export function answerForVerifications<T extends { outcomes: WikiVerificationOutcome[] }>(result: T): T {
  const refused = result.outcomes.filter((outcome) => outcome.status === 'refused');
  if (result.outcomes.length > 0 && refused.length === result.outcomes.length) {
    const first = refused[0] as Extract<WikiVerificationOutcome, { status: 'refused' }>;
    throw new HttpException(result, first.httpStatus);
  }
  return result;
}

/** The status behind {@link answerFor}, so a caller that wants the number rather than the answer has it. */
export function submissionStatus(result: { changesetId?: unknown; dryRun?: unknown; ops?: unknown }): number {
  // A dry run records nothing BY CONSTRUCTION, so "nothing was recorded" says nothing about it: it
  // answered as the request would, and what it would refuse is in the body.
  if (result.dryRun === true) return 200;
  if (result.changesetId !== null && result.changesetId !== undefined) return 200;
  const ops = Array.isArray(result.ops) ? (result.ops as WikiOpOutcome[]) : [];
  const first = ops.find((op) => op.status === 'refused' || op.status === 'conflict');
  if (!first) return 200;
  if (first.status === 'conflict') return 409;
  return WIKI_HTTP_STATUS[first.reasons[0]?.code ?? 'WIKI_SCHEMA'];
}

/**
 * An op whose compare-and-set no longer holds. Not a refusal: the answer the contract gives it is the
 * current revision and a diff (`opRules.compareAndSet`), which is what this carries to the caller.
 */
class WikiConflict extends Error {
  constructor(readonly outcome: WikiOpOutcome) {
    super('the base revision this op was written against is no longer current');
  }
}

/**
 * A source as the server resolved it: the record it names, the quote taken from it, and whether that
 * quote could be checked against the record's own text yet. A turn of the calling session may not be
 * stored at the moment it is cited, and a commit's text is not in this database at all, so a quote
 * can be real and still unverified — the review card says so (§4.3).
 */
interface ResolvedSource {
  kind: WikiSourceKind;
  ref: string;
  locator: Prisma.InputJsonValue;
  quote: string | null;
  quoteVerified: boolean;
  tainted: boolean;
  /** The record is the owner's own words: a turn they sent, or an AskUserQuestion they answered. */
  ownerWords: boolean;
  /** The session the record belongs to, where it belongs to one: what "independent sessions" count. */
  sessionId: string | null;
}

/** An entry's content, as it is about to be written. */
interface PreparedDraft {
  kind: WikiKind;
  title: string;
  summary: string;
  fields: unknown;
  topics: string[];
  aliases: string[];
  anchors: WikiAnchorInput[];
}

/** One op, after every check that refuses nothing: what to write, and under which effect. */
interface PreparedOp {
  seq: number;
  op: WikiOp;
  /** The entry the op is about; null for an add. */
  entryId: string | null;
  baseRevision: number | null;
  /** The op as submitted, redacted. This is what Review shows and what an accepted op applies. */
  payload: Record<string, unknown>;
  similar: WikiSimilar[];
  tainted: boolean;
  /** The effect policy's answer (§4.2), under the space's review mode: does this op take effect before the owner sees it? */
  applied: boolean;
  /**
   * Automatic took it: it waits for its verification (contract `reviewModes.verification.waits`) —
   * not applied, not a Review card, and counted by neither the queue nor the quotas. Its verdict
   * decides it later (`recordVerifications`).
   */
  verifying: boolean;
  /** Set when the REVIEW MODE took it (contract `reviewModes.effect`): the mode, and — for Tiered — the trust it leaves. */
  byMode: WikiReviewEffect['byMode'];
  /** Drawn into Review as a spot check (`reviewModes.spotChecks`): applied, and still waiting for the owner. */
  spotCheck: boolean;
  /**
   * Whether the op goes on waiting for the owner's answer after it has taken effect.
   *
   * True for everything the policy holds back, and for a challenge — whose flag takes effect at once
   * while the answer it asks for is the owner's (`challengeRule`: "the owner answers it in Review:
   * Re-confirm, Amend or Retire"). A challenge recorded `auto_applied` would leave Review with nothing
   * to press and the entry out of the push forever.
   */
  waitsForOwner: boolean;
  sources: ResolvedSource[];
  draft: PreparedDraft | null;
  changes: WikiEntryChanges | null;
}

/**
 * One thing to apply to an entry. `promote`, `confirm` and `reject` are not wiki ops: they are what
 * the owner's acceptance and refusal do to a proposal, or to what a review mode applied at once, and
 * they go through `applyOp` for the one reason that matters — the entry's status and trust have
 * exactly one writer.
 */
interface WikiApplyInstruction {
  op: WikiOp | 'promote' | 'confirm' | 'reject';
  entryId: string | null;
  draft: PreparedDraft | null;
  changes: WikiEntryChanges | null;
  payload: Record<string, unknown>;
  sources: readonly ResolvedSource[];
  tainted: boolean;
  /**
   * The owner has not accepted this yet: the lineage is born proposed and nothing live changes. An
   * add and a supersede are written either way (the entry IS the proposal), a challenge writes only
   * its flag, and every other op writes nothing until it is decided.
   */
  proposed?: boolean;
  /** What a promotion leaves behind: `owner` for the owner's own write, `confirmed` for everything
   *  else — an agent's proposal the owner accepted, edited or not (contract `trust.onApply`) — and
   *  `auto` or `unreviewed` for an add the space's review mode applied. */
  promotedTrust?: WikiTrust;
  /** An amend's trust afterwards, when it changes it: what a review mode leaves, `confirmed` once the
   *  owner has put their hand to an entry the machine wrote, `unreviewed` for a revision a revert or a
   *  rejected spot check restored. Left out, an amend keeps the trust it found. */
  trustAfter?: WikiTrust;
}

/**
 * What a changeset's ops are held to besides their own checks (contract `limitNotes.quota`,
 * `reviewModes.floors`): the space's mode and settings, the review queue, the ops that wait for the
 * owner, and the circuit breaker's reading. Read once when the changeset begins and advanced as each
 * op is recorded, so every op is judged against the ones before it in the same request.
 */
interface ChangesetBudget {
  mode: WikiReviewMode;
  autoAcceptReinforce: boolean;
  /** The space's pending ops that wait on the owner's decision: the review queue. A spot check does
   *  not count (`reviewModes.spotChecks.card`), and an op waiting for its verification is not pending. */
  pendingInSpace: number;
  /** Ops that wait for the owner: this request's so far, and the calling session's before it. */
  waitingInRequest: number;
  waitingInSession: number;
  /** The space's active entries when the changeset began, and the entries the mode changed in it. */
  activeAtStart: number;
  changedByMode: Set<string>;
  /** How many ops the space's review mode had applied before this one: what the spot-check draw counts. */
  appliedByModeBefore: number;
}

/** A revert's restorations, by entry: the sources of the revision each amend puts back. */
type Restorations = ReadonlyMap<string, readonly ResolvedSource[]>;

/** What a spot-check rejection did to the space's mode, for the one notification it earns. */
interface ReviewModeTrip {
  spaceId: string;
  title: string;
  rejected: number;
  window: number;
}

/** What an unsupported verdict did to an Automatic space's mode, for the one notification it earns. */
interface VerificationTrip {
  spaceId: string;
  title: string;
  unsupported: number;
  window: number;
}

/** One verdict as the service reads it, from the runner door's body or the import's own call. */
type VerdictInput = Pick<WikiVerdictInput, 'opId' | 'verdict' | 'reason' | 'model' | 'duplicateOf'>;

/** A verdict the service will not record, with the status the runner door answers it with. */
class VerdictRefusal extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
    readonly code?: WikiRefusalCode,
  ) {
    super(message);
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────

/**
 * A repository URL as a wiki space normalizes it (design §2.1): the remote without its scheme,
 * userinfo, trailing `.git` or trailing `/`, so `git@github.com:a/b.git` and `https://github.com/a/b`
 * are one codebase. The scheme is dropped from `canonicalRepoUrl`'s spelling rather than arrived at
 * by a second parser: repository identity has one normalizer in this tree, and the wiki's CHECK
 * (`repo_url_norm NOT LIKE '%://%'`) is the only thing that differs.
 */
export function normalizeRepoUrl(raw: string): string | null {
  const canonical = canonicalRepoUrl(raw);
  if (canonical === null) return null;
  const bare = canonical.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '');
  const trimmed = bare.replace(/\/+$/u, '').replace(/\.git$/u, '');
  return trimmed === '' ? null : trimmed;
}

/** A space slug from a normalized repository, a title, or a name the owner typed. */
export function slugFromText(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, WIKI_LIMITS.slugMaxChars)
    .replace(/-+$/u, '');
  return slug === '' ? 'wiki' : slug;
}

/** Whitespace-normalized text: what a quote is compared against. */
export function normalizeForQuote(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Is the quote in the record, once both are read the way a person reads them? */
function quoteHolds(sourceText: string, quote: string): boolean {
  return normalizeForQuote(sourceText).includes(normalizeForQuote(quote));
}

/**
 * Does this read as a tool probe rather than as knowledge (`WIKI_PROBE_REFUSED`, Wikova 4db6610f)?
 *
 * Deliberately narrow. An entry whose title CONTAINS the word is knowledge — "Testing strategy" is a
 * convention a project may well have — while a title that IS the word, or that carries the
 * write-check marker anywhere, is a tool test. The refusal tells the agent the tool works and not to
 * retry, because the other reading — "my call failed, let me try again" — is what makes a probe cost
 * a round trip.
 */
export function looksLikeProbe(title: string, texts: readonly string[]): boolean {
  const trimmed = title.trim();
  if (/TEST_WRITE_CHECK/iu.test(trimmed)) return true;
  if (texts.some((text) => /TEST_WRITE_CHECK/iu.test(text))) return true;
  return /^(?:test|testing|probe|ping)[\s:_-]*\d*$/iu.test(trimmed);
}

/**
 * Is this conversation turn the owner's own words (contract `reviewModes.tiered.auto.ownerWords`)?
 *
 * A message or a steer the user door filed with an explicit routing intent, under a key no part of
 * the control plane mints. The runner door — a coordinator's send, an agent's steer, whatever key it
 * was handed — files no intent at all, and every turn Orbit queues on its own account is keyed in a
 * namespace of its own (`isOrbitAuthoredTurn`), so neither can read as the owner. What this leaves
 * out on purpose: a turn from a client that sends no intent (the Apple apps, today) is not
 * recognized, and its entry reads Unreviewed until the owner confirms it — a false negative costs a
 * label, a false positive would push an agent's claim as the owner's.
 */
export function isOwnerTurn(turn: { kind: string; sendIntent: string | null; clientTurnId: string }): boolean {
  if (turn.kind !== 'message' && turn.kind !== 'steer') return false;
  return turn.sendIntent !== null && !isOrbitAuthoredTurn(turn.clientTurnId);
}

/** An AskUserQuestion a person answered: the approval route writes `decided_by_id`, and nothing else does. */
function isOwnerAnswer(approval: { toolName: string; status: string; answers: unknown; decidedById: string | null }): boolean {
  return approval.toolName === 'AskUserQuestion' && approval.status === 'ALLOWED' && approval.answers !== null
    && approval.decidedById !== null;
}

/**
 * Is the op a review mode applies at 0-based `position` among the space's the one its block of
 * `every` draws (contract `reviewModes.spotChecks.trigger`)? Tiered's block is `spotCheckEvery`, and
 * Automatic's — when its owner turned spot checks on — `automaticSpotCheckEvery`.
 *
 * Exactly one per block, at a place read off a digest of the space and the block's number: the same
 * space and position always answer the same, so a retried transaction or a replay draws the same op,
 * and nothing about the draw depends on when it ran.
 */
export function isSpotCheckDraw(spaceId: string, position: number, every: number = WIKI_REVIEW_RULES.spotCheckEvery): boolean {
  const block = Math.floor(position / every);
  const drawn = parseInt(sha256(`wiki-spot-check:${spaceId}:${block}`).slice(0, 8), 16) % every;
  return position % every === drawn;
}

/** JSON with object keys sorted, so the same content digests the same however a client spelled it. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The digest a revision is keyed by: the entry's content, canonically serialized. */
function contentSha256(content: PreparedDraft): string {
  return sha256(
    canonicalJson({
      title: content.title,
      summary: content.summary,
      fields: content.fields,
      topics: content.topics,
      aliases: content.aliases,
      anchors: content.anchors,
    }),
  );
}

/** A string's characters, counted the way the schema's CHECK counts them. */
const lengthOf = (value: string): number => [...value].length;

/** A record's text, whatever shape its column holds it in. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/** The text a run event carries, for the two types that carry prose. */
function eventText(type: string, payload: unknown): string | null {
  if (type !== 'user' && type !== 'assistant') return null;
  const text = (payload as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : null;
}

/** The kind a draft names, when it names one this phase writes. */
function draftKind(value: unknown): WikiKind | null {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && (WIKI_KINDS as readonly string[]).includes(kind) ? (kind as WikiKind) : null;
}

/** Every string a draft carries, for the probe check to read. */
function draftTexts(draft: { title?: unknown; summary?: unknown; fields?: unknown }): string[] {
  return [draft.title, draft.summary, JSON.stringify(draft.fields ?? {})].filter(
    (text): text is string => typeof text === 'string',
  );
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────

const ENTRY_SELECT = {
  id: true,
  spaceId: true,
  kind: true,
  status: true,
  trust: true,
  currentRevision: true,
  title: true,
  summary: true,
  fields: true,
  topics: true,
  aliases: true,
  anchors: true,
  anchorState: true,
  anchorCheckedRef: true,
  anchorCheckedAt: true,
  tainted: true,
  challenged: true,
  unsupported: true,
  pinned: true,
  supersedesId: true,
  supersededById: true,
  validFrom: true,
  validTo: true,
  recordedAt: true,
  retiredAt: true,
} satisfies Prisma.WikiEntrySelect;

type EntryRow = Prisma.WikiEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

const CHANGESET_SELECT = {
  id: true,
  spaceId: true,
  origin: true,
  sessionId: true,
  toolCallId: true,
  rationale: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  expiresAt: true,
  ops: {
    select: {
      id: true,
      changesetId: true,
      seq: true,
      op: true,
      entryId: true,
      baseRevision: true,
      payload: true,
      similar: true,
      tainted: true,
      decision: true,
      decisionReason: true,
      decisionNote: true,
      resultEntryId: true,
      resultRevision: true,
      decidedAt: true,
      appliedByMode: true,
      spotCheck: true,
      verificationVerdict: true,
      verificationReason: true,
      verificationModel: true,
      verifiedAt: true,
      verificationDuplicateOf: true,
    },
    orderBy: { seq: 'asc' },
  },
} satisfies Prisma.WikiChangesetSelect;

type ChangesetRow = Prisma.WikiChangesetGetPayload<{ select: typeof CHANGESET_SELECT }>;

/** An entry as the wire describes it (`WikiEntry` in `src/shared/src/wiki.ts`). */
export function entryView(row: EntryRow): Record<string, unknown> {
  return {
    id: row.id,
    spaceId: row.spaceId,
    kind: row.kind,
    status: row.status,
    trust: row.trust,
    currentRevision: row.currentRevision,
    title: row.title,
    summary: row.summary,
    fields: row.fields,
    topics: row.topics,
    aliases: row.aliases,
    anchors: row.anchors,
    anchorState: row.anchorState,
    anchorCheckedRef: row.anchorCheckedRef,
    anchorCheckedAt: row.anchorCheckedAt?.toISOString() ?? null,
    tainted: row.tainted,
    challenged: row.challenged,
    unsupported: row.unsupported,
    pinned: row.pinned,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    recordedAt: row.recordedAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

/** A changeset as the wire describes it (`WikiChangeset`). */
export function changesetView(row: ChangesetRow): Record<string, unknown> {
  return {
    id: row.id,
    spaceId: row.spaceId,
    origin: row.origin,
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    rationale: row.rationale,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    ops: row.ops.map((op) => ({
      id: op.id,
      changesetId: op.changesetId,
      seq: op.seq,
      op: op.op,
      entryId: op.entryId,
      baseRevision: op.baseRevision,
      payload: op.payload,
      similar: op.similar,
      tainted: op.tainted,
      decision: op.decision,
      decisionReason: op.decisionReason,
      decisionNote: op.decisionNote,
      resultEntryId: op.resultEntryId,
      resultRevision: op.resultRevision,
      decidedAt: op.decidedAt?.toISOString() ?? null,
      appliedByMode: op.appliedByMode,
      spotCheck: op.spotCheck,
      verification: verificationView(op),
    })),
  };
}

/** An op's verification trail as the wire reads it (`WikiOpVerification`), or null before a verdict. */
function verificationView(op: {
  verificationVerdict: string | null;
  verificationReason: string | null;
  verificationModel: string | null;
  verifiedAt: Date | null;
  verificationDuplicateOf: string | null;
}): Record<string, unknown> | null {
  if (op.verificationVerdict === null || op.verifiedAt === null) return null;
  return {
    verdict: op.verificationVerdict,
    reason: op.verificationReason,
    model: op.verificationModel,
    at: op.verifiedAt.toISOString(),
    duplicateOf: op.verificationDuplicateOf,
  };
}

/** The window the home page's usage block counts over — the design's "this week" (§12.1). */
const WIKI_USAGE_WINDOW_DAYS = 7;

/**
 * A topic's name when the space has never declared one: the slug read as words.
 *
 * The slug is the only name an entry carries (`topics` is a list of slugs), so a topic's page has to
 * be able to title itself from it — `tasks-dispatch` reads back as "Tasks dispatch". Only the first
 * word is capitalised: a slug cannot say which of its words the owner would have capitalised, and
 * title-casing every one of them invents an emphasis nobody wrote.
 */
export function topicTitleFromSlug(slug: string): string {
  const words = slug.split('-').filter((word) => word.length > 0);
  if (words.length === 0) return slug;
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

@Injectable()
export class WikiService {
  private readonly logger = new Logger(WikiService.name);

  constructor(
    private readonly prisma: PrismaService,
    // The one thing that leaves this service other than a return value: `wiki.changed`, published
    // after a write's transaction commits and only when one recorded something (`publishWikiChanged`
    // carries the argument). An accelerant and nothing more — contract `realtime.correctness` — so
    // it is defaulted, and the specs that construct this service by hand do not each have to stub a
    // hub they never read. `RealtimeModule` is global, so Nest injects the real one by type.
    private readonly realtime: RealtimeService = undefined as unknown as RealtimeService,
    // The one notification the review modes send: a space the spot checks sent back to Manual
    // (contract `reviewModes.spotChecks.trip`). Best-effort and after the commit, like the nudge
    // above, and defaulted for the same reason.
    private readonly push: PushService = undefined as unknown as PushService,
  ) {}

  // ── Spaces (§2.1) ─────────────────────────────────────────────────────────────────────────────

  /**
   * The space a runner call writes into: the calling session's workspace, bound on first use, or a
   * space a headless call named (it has no session, and so no workspace to derive one from).
   *
   * Binding a workspace is what the owner agreed to share (contract `readBoundary`), so this is also
   * the read boundary: a session whose workspace is bound to no space is refused WIKI_SPACE_UNBOUND
   * with one sentence saying how the owner binds it.
   */
  async resolveSpaceForCall(ownerId: string, sessionId: string | null, namedSpaceId?: string | null): Promise<string> {
    if (sessionId) {
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, ownerId },
        select: { id: true, workspaceId: true },
      });
      if (!session) throw new NotFoundException('no such session');
      if (session.workspaceId) {
        const bound = await this.prisma.wikiSpaceWorkspace.findFirst({
          where: { workspaceId: session.workspaceId, ownerId },
          select: { spaceId: true },
        });
        if (bound) return bound.spaceId;
        const workspace = await this.prisma.workspace.findFirst({
          where: { id: session.workspaceId, ownerId },
          select: { id: true, name: true, repoUrl: true },
        });
        if (workspace?.repoUrl) {
          return this.bindOnFirstUse(ownerId, workspace.id, workspace.repoUrl, workspace.name);
        }
      }
    }
    if (namedSpaceId) {
      const space = await this.prisma.wikiSpace.findFirst({
        where: { id: namedSpaceId, ownerId },
        select: { id: true },
      });
      if (!space) throw new NotFoundException('no such wiki space');
      return space.id;
    }
    return refuse(
      'WIKI_SPACE_UNBOUND',
      'This workspace is bound to no wiki space: the owner binds it in Wiki settings '
        + '(POST /api/wiki/spaces/:id/workspaces), or sets the workspace\'s repository URL so that it binds on first use.',
    );
  }

  /** A workspace with a repository joins its owner's space for that repository, creating it if new. */
  private async bindOnFirstUse(
    ownerId: string,
    workspaceId: string,
    repoUrl: string,
    workspaceName: string,
  ): Promise<string> {
    const normalized = normalizeRepoUrl(repoUrl);
    if (normalized === null) {
      return refuse(
        'WIKI_SPACE_UNBOUND',
        'This workspace\'s repository URL says nothing a wiki space can be keyed by: the owner sets it in '
          + 'the workspace form, or binds the workspace in Wiki settings.',
      );
    }
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const existing = await tx.wikiSpace.findFirst({
          where: { ownerId, repoUrlNorm: normalized },
          select: { id: true },
        });
        const spaceId = existing?.id ?? (await this.createSpaceRow(tx, ownerId, workspaceName, normalized)) ;
        // The binding is keyed by the workspace alone (`workspace_id` is unique), so a second session
        // of the same workspace finds the row it already has rather than making a second one.
        await tx.wikiSpaceWorkspace.upsert({
          where: { workspaceId },
          create: { spaceId, ownerId, workspaceId },
          update: {},
          select: { id: true },
        });
        return spaceId;
      },
      loggedRetry(this.logger, 'wiki.bindOnFirstUse'),
    );
  }

  /** One space row, under a slug and a repository that are unique within its owner. */
  private async createSpaceRow(
    tx: Tx,
    ownerId: string,
    title: string,
    repoUrlNorm: string | null,
    slug?: string,
  ): Promise<string> {
    const taken = await tx.wikiSpace.findMany({ where: { ownerId }, select: { slug: true } });
    const slugs = new Set(taken.map((row) => row.slug));
    const base = slugFromText(slug ?? repoUrlNorm ?? title);
    let candidate = base;
    for (let n = 2; slugs.has(candidate); n += 1) candidate = `${base.slice(0, 60)}-${n}`;
    const created = await tx.wikiSpace.create({
      data: {
        ownerId,
        slug: candidate,
        title: title.trim().slice(0, WIKI_LIMITS.titleMaxChars) || candidate,
        repoUrlNorm,
        // Written out, review mode included: a space made from here on is Tiered (criterion 7's
        // default). A space made BEFORE review modes has no `reviewMode` key and reads as Manual
        // (`wikiSpaceSettings`) — deliberately not backfilled to Tiered, because until Wiki settings
        // can show the mode and switch it (criterion 8) a space that started applying its agents'
        // proposals would be a change of behaviour its owner could neither see nor undo.
        settings: { ...WIKI_DEFAULT_SPACE_SETTINGS },
      },
      select: { id: true },
    });
    return created.id;
  }

  /** The owner's spaces, each with the pending-op count the sidebar shows (design §12.1). */
  async listSpaces(ownerId: string): Promise<Array<Record<string, unknown>>> {
    const spaces = await this.prisma.wikiSpace.findMany({
      where: { ownerId },
      orderBy: { slug: 'asc' },
      select: {
        id: true,
        slug: true,
        title: true,
        repoUrlNorm: true,
        rootCommitSha: true,
        settings: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const pending = await this.prisma.wikiChangesetOp.findMany({
      where: { ownerId, decision: 'pending' },
      select: { changeset: { select: { spaceId: true } } },
    });
    const counts = new Map<string, number>();
    for (const op of pending) {
      counts.set(op.changeset.spaceId, (counts.get(op.changeset.spaceId) ?? 0) + 1);
    }
    return spaces.map((space) => ({
      ...space,
      settings: wikiSpaceSettings(space.settings),
      createdAt: space.createdAt.toISOString(),
      updatedAt: space.updatedAt.toISOString(),
      pendingOps: counts.get(space.id) ?? 0,
    }));
  }

  /** The owner creating a space outright: a codebase, or a wiki with no repository behind it. */
  async createSpace(ownerId: string, input: { title: string; repoUrl?: string; slug?: string }) {
    const normalized = input.repoUrl ? normalizeRepoUrl(input.repoUrl) : null;
    if (input.repoUrl && normalized === null) {
      return refuse('WIKI_SCHEMA', 'repoUrl says nothing a repository identity can be read from');
    }
    const spaceId = await withTransactionRetry(
      this.prisma,
      (tx) => this.createSpaceRow(tx, ownerId, input.title, normalized, input.slug),
      loggedRetry(this.logger, 'wiki.createSpace'),
    );
    return this.requireSpace(ownerId, spaceId);
  }

  /** One of the owner's spaces, or a plain 404 (§10.1: another owner's is a 404 as well). */
  async requireSpace(ownerId: string, spaceId: string) {
    const space = await this.prisma.wikiSpace.findFirst({
      where: { id: spaceId, ownerId },
      select: {
        id: true,
        slug: true,
        title: true,
        repoUrlNorm: true,
        rootCommitSha: true,
        settings: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!space) throw new NotFoundException('no such wiki space');
    return {
      ...space,
      settings: wikiSpaceSettings(space.settings),
      createdAt: space.createdAt.toISOString(),
      updatedAt: space.updatedAt.toISOString(),
    };
  }

  /**
   * The owner's settings: whether the space pushes, whether a reinforce applies at once, its review
   * mode, and its Wiki maintenance run (the owner channel's alone, like the mode).
   *
   * THE REVIEW MODE IS THE OWNER CHANNEL'S, like a decide (contract `space.settings.reviewMode`): a
   * request that would change it and carries a session header is refused WIKI_OWNER_CHANNEL_ONLY
   * before anything is read, whatever the session's role — which mode applies an agent's writes is
   * never something an agent sets. Setting the mode the space already has changes nothing, so the
   * spot checks' window (which counts from the last change) is not restarted by it. Whether an
   * Automatic space sends the owner spot checks at all (`automaticSpotChecks`) is the owner's in the
   * same way: it decides how much of what the machine applied a person ever looks at.
   */
  async updateSpace(
    ownerId: string,
    spaceId: string,
    input: {
      push?: boolean;
      autoAcceptReinforce?: boolean;
      reviewMode?: WikiReviewMode;
      automaticSpotChecks?: boolean;
      maintenance?: WikiMaintenanceInput;
      title?: string;
    },
    actingSessionId: string | null = null,
  ) {
    if (input.maintenance !== undefined && actingSessionId) {
      return refuse(
        'WIKI_OWNER_CHANNEL_ONLY',
        "a space's Wiki maintenance is the account owner's to set, through an owner channel with no acting session: "
          + 'report what should change, and let a person change it.',
      );
    }
    if (input.reviewMode !== undefined && actingSessionId) {
      return refuse(
        'WIKI_OWNER_CHANNEL_ONLY',
        "a space's review mode is the account owner's to set, through an owner channel with no acting session: "
          + 'report which mode the space should run in, and let a person switch it.',
      );
    }
    if (input.automaticSpotChecks !== undefined && actingSessionId) {
      return refuse(
        'WIKI_OWNER_CHANNEL_ONLY',
        "whether an Automatic space sends its owner spot checks is the account owner's to set, through an owner "
          + 'channel with no acting session: report what should change, and let a person change it.',
      );
    }
    const current = await this.requireSpace(ownerId, spaceId);
    // Maintenance is written by its own unit, under the space row's lock and with the hidden list it
    // may need (`setWikiMaintenance`); every other key below is merged over the row as it stands, so
    // neither write can put back what the other just changed.
    if (input.maintenance !== undefined) await setWikiMaintenance(this.prisma, ownerId, spaceId, input.maintenance);
    const { maintenance: _maintenance, ...settings }: Record<string, unknown> = { ...current.settings };
    if (input.push !== undefined) settings.push = input.push;
    if (input.autoAcceptReinforce !== undefined) settings.autoAcceptReinforce = input.autoAcceptReinforce;
    if (input.automaticSpotChecks !== undefined) settings.automaticSpotChecks = input.automaticSpotChecks;
    if (input.reviewMode !== undefined && input.reviewMode !== current.settings.reviewMode) {
      settings.reviewMode = input.reviewMode;
      settings.reviewModeChangedAt = new Date().toISOString();
      settings.reviewModeChangedBy = 'owner' satisfies WikiSpaceSettings['reviewModeChangedBy'];
    }
    await this.prisma.$executeRaw`
      UPDATE "wiki_space"
         SET "settings" = "settings" || ${JSON.stringify(settings)}::jsonb, "updated_at" = now()
             ${input.title ? Prisma.sql`, "title" = ${input.title}` : Prisma.empty}
       WHERE "id" = ${spaceId}::uuid AND "owner_id" = ${ownerId}::uuid`;
    return this.requireSpace(ownerId, spaceId);
  }

  /** Bind a workspace the owner named: the manual half of §2.1's binding. */
  async bindWorkspace(ownerId: string, spaceId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException('no such workspace');
    await this.requireSpace(ownerId, spaceId);
    await this.prisma.wikiSpaceWorkspace.upsert({
      where: { workspaceId },
      create: { spaceId, ownerId, workspaceId },
      update: { spaceId },
      select: { id: true },
    });
    return { spaceId, workspaceId };
  }

  // ── The single write entry point (§4.1) ───────────────────────────────────────────────────────

  /**
   * Record one submission: an agent's proposal, the owner's own edit, a maintenance run's batch.
   *
   * Every op is judged on its own, in the order §4.1 states, and the ones that pass are written in
   * ONE transaction. A refused op writes nothing and does not stop the others; the answer carries
   * every op's outcome, and a request that recorded something is a 200.
   */
  async submitChangeset(
    principal: WikiPrincipal,
    spaceId: string,
    input: WikiProposeInput,
  ): Promise<Record<string, unknown>> {
    const space = await this.requireSpace(principal.ownerId, spaceId);
    const ops = input.ops;
    if (!Array.isArray(ops) || ops.length === 0) {
      return refuse('WIKI_SCHEMA', 'ops must hold at least one op', [{ path: 'ops', message: 'is required' }]);
    }
    if (typeof input.rationale !== 'string' || input.rationale.trim() === '') {
      return refuse('WIKI_SCHEMA', 'rationale is required: what this records, and why', [
        { path: 'rationale', message: 'is required' },
      ]);
    }
    if (input.idempotencyKey && lengthOf(input.idempotencyKey) > 200) {
      return refuse('WIKI_SCHEMA', 'idempotencyKey is at most 200 characters', [
        { path: 'idempotencyKey', message: 'must be at most 200 characters' },
      ]);
    }
    // The digest a replay is told apart by: the same request under the same key is the same request
    // however its JSON was spelled, and a different one is a key reused (WIKI_IDEMPOTENCY_KEY_REUSED).
    const requestSha256 = input.idempotencyKey
      ? sha256(canonicalJson({ spaceId, ops, rationale: input.rationale }))
      : null;
    const literals = await this.envLiterals(this.prisma, principal.ownerId);
    const answer = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        if (input.idempotencyKey) {
          const replay = await this.replayIdempotent(tx, principal.ownerId, input.idempotencyKey, requestSha256!);
          if (replay) return replay;
        }
        return this.recordChangeset(tx, principal, space, ops, input, requestSha256, literals);
      },
      loggedRetry(this.logger, 'wiki.submitChangeset'),
    );
    // AFTER the commit, never inside the closure above: a retried transaction would announce the same
    // write once per attempt, and this announcement is what a client's re-read hangs off — it may
    // only be made once the rows it points at are readable (contract `realtime.publishedWhen`).
    //
    // Silent for everything that is not a recorded write (`realtime.notPublishedWhen`): an idempotent
    // replay changed nothing for it to announce, a dry run writes nothing by construction, and a
    // request whose every op was refused left no changeset behind.
    if (answer.replayed !== true && typeof answer.changesetId === 'string') {
      this.realtime?.publishWikiChanged(principal.ownerId, space.id);
    }
    return answer;
  }

  /** The recorded answer to an earlier request under the same key; or the refusal for a key reused. */
  private async replayIdempotent(
    tx: Tx,
    ownerId: string,
    idempotencyKey: string,
    requestSha256: string,
  ): Promise<Record<string, unknown> | null> {
    const existing = await tx.wikiChangeset.findFirst({
      where: { ownerId, idempotencyKey },
      select: { id: true, requestSha256: true },
    });
    if (!existing) return null;
    if (existing.requestSha256 !== requestSha256) {
      return refuse(
        'WIKI_IDEMPOTENCY_KEY_REUSED',
        'this idempotency key was used for a different request: the same request under the same key replays '
          + 'its recorded answer, and another request needs another key',
      );
    }
    const row = await tx.wikiChangeset.findFirstOrThrow({
      where: { id: existing.id, ownerId },
      select: CHANGESET_SELECT,
    });
    return { changesetId: row.id, replayed: true, ops: recordedOutcomes(row) };
  }

  /**
   * One submission, inside one transaction: every op processed in the contract's order, the ones that
   * passed written, and the answer assembled from what each one became.
   *
   * A dry run takes the whole path and writes nothing — no changeset, no op, no entry — which is what
   * lets a maintenance run check a batch before it proposes it.
   */
  private async recordChangeset(
    tx: Tx,
    principal: WikiPrincipal,
    space: { id: string; settings: unknown },
    ops: unknown[],
    input: WikiProposeInput,
    requestSha256: string | null,
    literals: readonly string[],
    restorations: Restorations | null = null,
  ): Promise<Record<string, unknown>> {
    const dryRun = input.dryRun === true;
    const settings = wikiSpaceSettings(space.settings);
    const mode = settings.reviewMode;
    const budget: ChangesetBudget = {
      mode,
      autoAcceptReinforce: settings.autoAcceptReinforce !== false,
      // The queue is what waits on the owner's DECISION: a spot check does not take one of its places
      // (`reviewModes.spotChecks.card`), and an op waiting for its verification is not pending at all.
      pendingInSpace: await tx.wikiChangesetOp.count({
        where: { ownerId: principal.ownerId, decision: 'pending', spotCheck: false, changeset: { spaceId: space.id } },
      }),
      waitingInRequest: 0,
      // What waited for the owner is what the effect policy held back: every op a session recorded
      // that was not applied at once — by the policy (`auto_applied`) or by the mode — and that no
      // verification took: an op that waits for, or was decided by, its verdict never waited on them.
      waitingInSession: principal.sessionId
        ? await tx.wikiChangesetOp.count({
            where: {
              ownerId: principal.ownerId,
              changeset: { sessionId: principal.sessionId },
              appliedByMode: null,
              verificationVerdict: null,
              decision: { notIn: ['auto_applied', 'verifying'] },
            },
          })
        : 0,
      // Only a mode other than Manual takes anything the breaker counts, so a Manual space pays for
      // neither this read nor the draw's below.
      activeAtStart: mode === 'manual'
        ? 0
        : await tx.wikiEntry.count({ where: { ownerId: principal.ownerId, spaceId: space.id, status: 'active' } }),
      changedByMode: new Set<string>(),
      // Only Tiered draws a spot check as it records; Automatic's verdicts draw theirs (`applyVerdict`).
      appliedByModeBefore: mode !== 'tiered'
        ? 0
        : await tx.wikiChangesetOp.count({
            where: { ownerId: principal.ownerId, appliedByMode: { not: null }, changeset: { spaceId: space.id } },
          }),
    };
    // The changeset is created before its ops: an op's row is what a revision came from, and both must
    // exist before the first entry is written.
    const changesetId = dryRun
      ? ''
      : (
          await tx.wikiChangeset.create({
            data: {
              ownerId: principal.ownerId,
              spaceId: space.id,
              origin: principal.origin,
              sessionId: principal.sessionId,
              toolCallId: principal.toolCallId,
              rationale: input.rationale as string,
              idempotencyKey: input.idempotencyKey ?? null,
              requestSha256,
              // A pending changeset's expiry is not optional (the schema's CHECK), and a changeset every
              // op of which applies at once is settled the moment it is written.
              status: 'pending',
              expiresAt: new Date(Date.now() + WIKI_LIMITS.pendingExpiryDays * 86_400_000),
            },
            select: { id: true },
          })
        ).id;
    const outcomes: WikiOpOutcome[] = [];
    let recorded = 0;
    let pending = 0;
    for (let seq = 0; seq < ops.length; seq += 1) {
      let outcome: WikiOpOutcome;
      try {
        if (seq >= WIKI_LIMITS.opsPerChangeset) {
          return refuse(
            'WIKI_QUOTA',
            `a changeset holds at most ${WIKI_LIMITS.opsPerChangeset} ops: submit the rest in another one`,
          );
        }
        const prepared = await this.prepareOp(tx, principal, space.id, seq, ops[seq], budget, literals);
        if (prepared.byMode?.mode === 'tiered') {
          // Tiered's spot check (`reviewModes.spotChecks`): one in every block of the ops it applies at
          // once, drawn by position. Automatic applies nothing here — its verdicts draw theirs, when the
          // owner asked for any — and a full review queue skips nothing: a spot check takes no place in it.
          prepared.spotCheck = isSpotCheckDraw(space.id, budget.appliedByModeBefore);
          budget.appliedByModeBefore += 1;
        }
        outcome = await this.recordOp(tx, principal, space.id, changesetId, seq, prepared, dryRun, restorations);
        // What keeps the changeset open is the OP's decision, not its outcome: a challenge takes effect
        // at once and still waits for the owner's answer, and so does a spot check; an op waiting for
        // its verification keeps it open too, without being anybody's queue.
        const waits = prepared.waitsForOwner || prepared.spotCheck;
        if (outcome.status === 'pending' || (outcome.status === 'applied' && waits)) {
          pending += 1;
          if (prepared.waitsForOwner) budget.pendingInSpace += 1;
        }
        // The quotas count what the POLICY held back; a spot check is the server's own draw.
        if (prepared.waitsForOwner) budget.waitingInRequest += 1;
        if (prepared.byMode) {
          // The distinct entries the mode changes: an amend's own entry — whether it applied now or
          // waits for its verdict — and an add's new lineage.
          const changed = prepared.op === 'amend'
            ? prepared.entryId
            : outcome.status === 'applied' || outcome.status === 'pending' ? outcome.entryId : null;
          budget.changedByMode.add(changed ?? `seq:${seq}`);
        }
        if (outcome.status !== 'refused') recorded += 1;
      } catch (error) {
        if (error instanceof WikiConflict) outcome = error.outcome;
        else if (error instanceof WikiRefusalError) outcome = { seq, status: 'refused', reasons: [error.refusal] };
        else throw error;
      }
      outcomes.push(outcome);
    }
    if (dryRun) return { changesetId: null, replayed: false, dryRun: true, ops: outcomes };
    if (recorded === 0) {
      // A request none of whose ops was recorded leaves no changeset behind: an empty queue entry is not
      // a fact. The answer still carries every refusal.
      await tx.wikiChangeset.deleteMany({ where: { id: changesetId, ownerId: principal.ownerId } });
      return { changesetId: null, replayed: false, ops: outcomes };
    }
    if (pending === 0) {
      await tx.wikiChangeset.updateMany({
        where: { id: changesetId, ownerId: principal.ownerId },
        data: { status: 'settled', decidedAt: new Date(), expiresAt: null },
      });
    }
    return { changesetId, replayed: false, ops: outcomes };
  }

  /**
   * Every check that runs before an op is recorded, in the order §4.1 gives them. Redaction, the
   * neighbours and the taint mark the op; everything else refuses it, and a compare-and-set that no
   * longer holds answers with the current revision instead (contract `opRules.compareAndSet`).
   */
  private async prepareOp(
    tx: Tx,
    principal: WikiPrincipal,
    spaceId: string,
    seq: number,
    raw: unknown,
    budget: ChangesetBudget,
    literals: readonly string[],
  ): Promise<PreparedOp> {
    const op = (raw ?? {}) as Record<string, unknown>;
    const opName = op.op as WikiOp;
    // An id out of an op is a public id like any other: a caller pastes back the short form its client
    // showed it. shapeErrors has already established that it decodes, so this cannot throw here.
    const namedId = typeof op.entryId === 'string' ? toUuid(op.entryId) : null;
    const target = namedId ? await this.ownEntry(tx, principal.ownerId, spaceId, namedId) : null;
    const targetKind = target ? (target.kind as WikiEntryKind) : null;

    // 1. The shape: the op, the draft, the anchors, the sources, and the revision the op names.
    const shape = shapeErrors(raw, seq);
    const errors = shape.length > 0 ? shape : amendErrors(targetKind, opName, op);
    if (errors.length > 0) {
      return refuse('WIKI_SCHEMA', 'the op does not have the shape this contract gives it', errors);
    }
    const writtenKind = opName === 'add' || opName === 'supersede' ? draftKind(op.entry) : targetKind;

    // 2. Only the owner writes a kind that only the owner writes (kinds.<kind>.ownerOnlyOps).
    if (principal.origin !== 'owner') {
      for (const candidate of new Set([writtenKind, targetKind])) {
        if (!candidate) continue;
        const spec = KIND_SPECS[candidate as WikiKind];
        if (spec?.ownerOnlyOps.includes(opName)) {
          return refuse(
            'WIKI_KIND_OWNER_ONLY',
            `a ${candidate} is the owner's to write: propose what you observed and let them state it`,
          );
        }
      }
    }

    // 3. Every source resolves among the owner's own rows, and every quote is in the text it cites.
    const found = await this.resolveSources(tx, principal, rawOpSources(op), { required: requiresSource(opName, principal) });

    // 4. Redaction: nothing stored carries a credential, and a field it changed is marked. The quotes
    //    are redacted with the payload, because what is stored is the redacted text and a quote that
    //    changed under it no longer matches the record verbatim.
    const redacted = redactOp(op, literals);
    if (redacted.changed) {
      // The same checks, over what will actually be stored: `[redacted]` is longer than what it replaces,
      // so a field that only just fitted can be refused here rather than failing the schema's CHECK later.
      const after = [...shapeErrors(redacted.value, seq), ...amendErrors(targetKind, opName, redacted.value)];
      if (after.length > 0) {
        return refuse('WIKI_SCHEMA', 'redaction pushed a field past its limit: shorten it and propose again', after);
      }
    }
    const sources = found.resolved.map((source) => {
      if (source.quote === null) return source;
      const { text, redacted: changed } = redactSecrets(source.quote, { literals });
      return changed ? { ...source, quote: text, quoteVerified: false } : source;
    });

    // 5. Compare-and-set: an amend, a supersede and a retire name the revision they were written against.
    const baseRevision = opName === 'amend' || opName === 'supersede' || opName === 'retire' ? (op.baseRevision as number) : null;
    if (target && baseRevision !== null && baseRevision !== target.currentRevision) {
      throw new WikiConflict(revisionConflict(seq, target, baseRevision, redacted.value));
    }

    // 6. A tool probe is not knowledge.
    const draft = opName === 'add' || opName === 'supersede' ? ((redacted.value.entry ?? {}) as Record<string, unknown>) : null;
    const probeTexts = draft ? draftTexts(draft) : typeof redacted.value.reason === 'string' ? [redacted.value.reason] : [];
    if (looksLikeProbe(draft ? String(draft.title ?? '') : String(redacted.value.reason ?? ''), probeTexts)) {
      return refuse(
        'WIKI_PROBE_REFUSED',
        'this reads as a tool probe rather than as knowledge to keep: the tool works and the call was received — '
          + 'do not retry it, and record something a reader could not get from the code.',
      );
    }

    // 7. The effect, under the space's review mode (contract `reviewModes.effect`), and then what it
    //    costs: the ops that wait for the owner, the review queue, and the circuit breaker. The taint is
    //    read before any of them because a tainted op WAITS: a space at its cap must not take in what the
    //    policy was going to apply, only for the mark to turn it into a queue entry.
    const tainted = await this.isTainted(tx, principal, sources);
    const reviewing = budget.mode !== 'manual' && principal.origin !== 'owner';
    const decided = wikiReviewEffect({
      mode: budget.mode,
      origin: principal.origin,
      op: opName,
      tainted,
      autoAcceptReinforce: budget.autoAcceptReinforce,
      target: reviewing && opName === 'amend' && target ? await this.reviewTarget(tx, principal.ownerId, target) : null,
      basis: reviewing && budget.mode === 'tiered' && writtenKind && (opName === 'add' || opName === 'amend')
        ? tieredBasisOf(writtenKind, opName === 'amend' ? target : null, redacted.value.changes, sources)
        : null,
    });
    const applied = decided.effect === 'applied';
    // What Automatic takes waits for its verification, not for the owner: no queue, no quota, no card.
    const verifying = decided.effect === 'verifying';
    const waitsForOwner = decided.effect === 'pending' || opName === 'challenge';
    // The two quotas protect the review queue, so they count only what waits for it (limitNotes.quota):
    // an op that applies at once, or waits for its verification, is bounded by the changeset's size and
    // the breaker instead.
    if (
      waitsForOwner
      && (budget.waitingInRequest >= WIKI_LIMITS.opsPerTurn
        || (principal.sessionId !== null && budget.waitingInSession + budget.waitingInRequest >= WIKI_LIMITS.opsPerSession))
    ) {
      return refuse(
        'WIKI_QUOTA',
        `a session records at most ${WIKI_LIMITS.opsPerTurn} ops that wait for review in one turn and `
          + `${WIKI_LIMITS.opsPerSession} in its life: record the rest in another turn`,
      );
    }
    if (decided.effect === 'pending' && budget.pendingInSpace >= WIKI_LIMITS.pendingOpsPerSpace) {
      return refuse(
        'WIKI_REVIEW_QUEUE_FULL',
        `this space already holds ${WIKI_LIMITS.pendingOpsPerSpace} ops waiting for review: the owner decides `
          + 'some of them before more can queue behind them',
      );
    }
    if (decided.byMode && breakerTrips(budget, opName === 'amend' ? (target?.id ?? null) : null)) {
      return refuse(
        'WIKI_QUOTA',
        `circuit breaker: this changeset has already changed ${budget.changedByMode.size} of the space's `
          + `${budget.activeAtStart} active entries, and one changeset may change at most `
          + `${WIKI_REVIEW_RULES.breakerMaxChangedPercent}% of them — submit the rest in another changeset`,
      );
    }

    // 8. Near neighbours, for the agent and for the review card. Never a refusal (§4.1 step 8).
    const similar = draft
      ? await this.nearNeighbours(tx, principal.ownerId, spaceId, draft, target?.id ?? null)
      : [];

    return {
      seq,
      op: opName,
      entryId: target?.id ?? null,
      baseRevision,
      payload: redacted.value,
      similar,
      tainted,
      applied,
      verifying,
      byMode: decided.byMode,
      spotCheck: false,
      waitsForOwner,
      sources,
      draft: draft ? preparedDraft(draft) : null,
      changes: (redacted.value.changes ?? null) as WikiEntryChanges | null,
    };
  }

  /** Record one prepared op: its row, its effect, and the answer its caller reads. */
  private async recordOp(
    tx: Tx,
    principal: WikiPrincipal,
    spaceId: string,
    changesetId: string,
    seq: number,
    prepared: PreparedOp,
    dryRun: boolean,
    restorations: Restorations | null = null,
  ): Promise<WikiOpOutcome> {
    const similar = prepared.similar.length > 0 ? prepared.similar : undefined;
    // An add and a supersede write their lineage even when the owner has not accepted it yet: the entry
    // IS the proposal (`states.entry.born`), and Review, the neighbours and a later acceptance all read
    // it — and so does a verdict, for an add that waits for its verification. A challenge writes its
    // flag at once. Everything else waits, and applies when it is decided.
    const writesNow = prepared.op === 'add' || prepared.op === 'supersede' || prepared.op === 'challenge' || prepared.applied;
    const opRowId = dryRun
      ? null
      : (
          await tx.wikiChangesetOp.create({
            data: {
              changesetId,
              ownerId: principal.ownerId,
              seq,
              op: prepared.op,
              entryId: prepared.entryId,
              baseRevision: prepared.baseRevision,
              payload: prepared.payload as Prisma.InputJsonValue,
              similar: prepared.similar as unknown as Prisma.InputJsonValue,
              tainted: prepared.tainted,
              decision: prepared.verifying ? 'verifying' : 'pending',
              // What Automatic took is not applied yet: its verdict names the mode when it applies it.
              appliedByMode: prepared.applied ? (prepared.byMode?.mode ?? null) : null,
              spotCheck: prepared.spotCheck,
            },
            select: { id: true },
          })
        ).id;
    const author: WikiAuthor = {
      // An agent's proposal is authored by the session that made it; the owner's own write by the owner;
      // and a write the server makes on its own account says so (`principal.authorKind`).
      authorKind: principal.authorKind ?? (principal.origin === 'owner' ? 'owner' : 'agent'),
      authorUserId: principal.origin === 'owner' ? principal.userId : null,
      authorSessionId: principal.sessionId,
      authorToolCallId: principal.toolCallId,
      changesetOpId: opRowId,
    };
    // A revert's amend puts a revision back (`reviewModes.revert`): with the sources that revision
    // rested on, and the entry out of the push until somebody looks at it again.
    const restored = prepared.op === 'amend' && prepared.entryId ? restorations?.get(prepared.entryId) : undefined;
    // A dry run takes the whole path and writes NOTHING — no op row, and no entry either, which is the
    // half that is easy to get wrong: an add that creates its lineage is a write like any other.
    const written = writesNow && !dryRun
      ? await this.applyOp(tx, principal.ownerId, spaceId, {
          op: prepared.op,
          entryId: prepared.entryId,
          draft: prepared.draft,
          changes: prepared.changes,
          payload: prepared.payload,
          sources: restored ?? prepared.sources,
          tainted: prepared.tainted,
          proposed: !prepared.applied,
          promotedTrust: principal.origin === 'owner' ? 'owner' : (prepared.byMode?.trust ?? 'confirmed'),
          trustAfter: restored ? 'unreviewed' : (prepared.byMode?.trust ?? undefined),
        }, author)
      : null;
    if (opRowId) {
      await tx.wikiChangesetOp.updateMany({
        where: { id: opRowId, ownerId: principal.ownerId },
        data: {
          ...(prepared.verifying
            ? { decision: 'verifying' }
            : prepared.waitsForOwner || prepared.spotCheck
              ? { decision: 'pending' }
              : { decision: 'auto_applied', decidedAt: new Date() }),
          ...(written ? { resultEntryId: written.entryId, resultRevision: written.revision } : {}),
        },
      });
    }
    const outcomeEntryId = written?.entryId ?? prepared.entryId;
    if (prepared.applied) {
      return { seq, status: 'applied', opId: opRowId, entryId: outcomeEntryId, revision: written?.revision ?? null, similar };
    }
    return prepared.verifying
      ? { seq, status: 'pending', opId: opRowId, entryId: outcomeEntryId, similar, waitsFor: 'verification' }
      : { seq, status: 'pending', opId: opRowId, entryId: outcomeEntryId, similar };
  }

  // ── decide: the owner channel (contract `effectPolicy.decide`) ────────────────────────────────

  /**
   * The owner's answer to what waits in Review: accept, edit or reject, one op at a time.
   *
   * THE OWNER CHANNEL ONLY. A request carrying a session header is refused whatever that session's
   * role — deciding is not something a session does (contract `agentSurface.decide`; the precedent is
   * `coordinator-authority.ts`'s `refuseSessionAuthoredConfirmation`). The runner door has no decide
   * route at all, so this is the second lock on the same door.
   */
  async decide(
    ownerId: string,
    userId: string,
    changesetId: string,
    decisions: readonly WikiDecisionInput[],
    actingSessionId: string | null,
  ): Promise<Record<string, unknown>> {
    if (actingSessionId) {
      return refuse(
        'WIKI_OWNER_CHANNEL_ONLY',
        'deciding what the wiki keeps is the account owner\'s, through an owner channel with no acting '
          + 'session: report what should be accepted, and let a person accept it.',
      );
    }
    const decided = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const changeset = await tx.wikiChangeset.findFirst({
          where: { id: changesetId, ownerId },
          select: CHANGESET_SELECT,
        });
        if (!changeset) throw new NotFoundException('no such changeset');
        let rejectedSpotCheck = false;
        for (const decision of decisions) {
          if (await this.applyDecision(tx, ownerId, userId, changeset, decision)) rejectedSpotCheck = true;
        }
        await this.settleChangeset(tx, ownerId, changesetId);
        // In the same transaction as the rejection that could take the rate over: a space is sent back
        // to Manual by the fact that did it, or not at all (`reviewModes.spotChecks.trip`).
        const trip = rejectedSpotCheck ? await this.tripIfRejecting(tx, ownerId, changeset.spaceId) : null;
        const row = await tx.wikiChangeset.findFirstOrThrow({
          where: { id: changesetId, ownerId },
          select: CHANGESET_SELECT,
        });
        return { view: changesetView(row), trip };
      },
      loggedRetry(this.logger, 'wiki.decide'),
    );
    // After the commit, and outside it, for `submitChangeset`'s reason. A decision moves the space's
    // review queue and its entries, so the nudge names the SPACE — the same event either write path
    // sends, and the id and nothing else about it (contract `realtime.redaction`). A decide the
    // service refused threw before reaching here and announces nothing.
    this.realtime?.publishWikiChanged(ownerId, String(decided.view.spaceId));
    if (decided.trip) this.announceTrip(ownerId, decided.trip);
    return decided.view;
  }

  /**
   * Undo, as the owner, every op of one changeset the space's review mode applied at once and the
   * owner has not answered (contract `reviewModes.revert`): a run, taken back in one press.
   *
   * THE OWNER CHANNEL ONLY, like a decide. And through the one write path: the undoing is the
   * owner's own changeset — a retire for each add, an amend for each entry an amend changed —
   * recorded by `recordChangeset` and applied by `applyOp` like any other, so the history shows what
   * was taken back and by whom. It is keyed `revert:<changeset id>`, so a second press answers with
   * the first rather than writing again.
   *
   * WHAT IT DOES NOT TOUCH, and names in `skipped`: an entry that is no longer active, and an entry
   * changed again after the run changed it — putting back a revision somebody has since built on
   * would throw their change away with the run's.
   */
  async revertChangeset(
    ownerId: string,
    userId: string,
    changesetId: string,
    actingSessionId: string | null,
  ): Promise<Record<string, unknown>> {
    if (actingSessionId) {
      return refuse(
        'WIKI_OWNER_CHANNEL_ONLY',
        'taking back what the wiki applied is the account owner\'s, through an owner channel with no acting '
          + 'session: report what should be reverted, and let a person revert it.',
      );
    }
    const literals = await this.envLiterals(this.prisma, ownerId);
    const answer = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const changeset = await tx.wikiChangeset.findFirst({ where: { id: changesetId, ownerId }, select: CHANGESET_SELECT });
        if (!changeset) throw new NotFoundException('no such changeset');
        const idempotencyKey = `revert:${changeset.id}`;
        const earlier = await tx.wikiChangeset.findFirst({ where: { ownerId, idempotencyKey }, select: CHANGESET_SELECT });
        if (earlier) {
          return { revertedChangesetId: changeset.id, changesetId: earlier.id, replayed: true, ops: recordedOutcomes(earlier), skipped: [] };
        }
        const space = await tx.wikiSpace.findFirstOrThrow({
          where: { id: changeset.spaceId, ownerId },
          select: { id: true, settings: true },
        });
        const undone = changeset.ops.filter(
          (op) => op.appliedByMode !== null && (op.decision === 'auto_applied' || (op.decision === 'pending' && op.spotCheck)),
        );
        const ops: Record<string, unknown>[] = [];
        const skipped: Array<{ entryId: string; reason: string }> = [];
        const reason = `Reverted with the run that applied it (changeset ${uuidToBase62(changeset.id)}).`;
        for (const op of undone.filter((row) => row.op === 'add' && row.resultEntryId)) {
          const entry = await this.ownEntryById(tx, ownerId, op.resultEntryId!);
          if (entry?.status !== 'active') {
            skipped.push({ entryId: op.resultEntryId!, reason: 'no longer active' });
            continue;
          }
          ops.push({ op: 'retire', entryId: entry.id, baseRevision: entry.currentRevision, reason });
        }
        // An entry the run amended more than once goes back to where the run found it, in one amend.
        const amended = new Map<string, { from: number; to: number }>();
        for (const op of undone.filter((row) => row.op === 'amend' && row.entryId)) {
          const seen = amended.get(op.entryId!);
          amended.set(op.entryId!, {
            from: Math.min(seen?.from ?? op.baseRevision!, op.baseRevision!),
            to: Math.max(seen?.to ?? 0, op.resultRevision ?? 0),
          });
        }
        const restorations = new Map<string, ResolvedSource[]>();
        for (const [entryId, span] of amended) {
          const entry = await this.ownEntryById(tx, ownerId, entryId);
          if (entry?.status !== 'active' || entry.currentRevision !== span.to) {
            skipped.push({ entryId, reason: entry?.status !== 'active' ? 'no longer active' : 'changed again since' });
            continue;
          }
          const before = await tx.wikiEntryRevision.findFirstOrThrow({
            where: { entryId, ownerId, revision: span.from },
            select: { id: true, title: true, summary: true, fields: true, topics: true, aliases: true, anchors: true },
          });
          restorations.set(entryId, await this.sourcesOfRevision(tx, ownerId, before.id));
          ops.push({
            op: 'amend',
            entryId,
            baseRevision: entry.currentRevision,
            changes: {
              title: before.title,
              summary: before.summary,
              fields: before.fields,
              topics: before.topics,
              aliases: before.aliases,
              anchors: before.anchors,
            },
          });
        }
        // The run's own open spot checks go with it: there is nothing left for the owner to check.
        await tx.wikiChangesetOp.updateMany({
          where: { changesetId: changeset.id, ownerId, decision: 'pending', spotCheck: true },
          data: { decision: 'withdrawn', decidedAt: new Date() },
        });
        // And so does what of it still waits for a verdict, so that no verdict can apply it later
        // (`reviewModes.revert`): the op withdrawn, and an add's proposed lineage rejected with it
        // (`states.entry`: proposed -> rejected when its op is withdrawn).
        const owner: WikiAuthor = { authorKind: 'owner', authorUserId: userId, authorSessionId: null, authorToolCallId: null, changesetOpId: null };
        for (const op of changeset.ops.filter((row) => row.decision === 'verifying')) {
          if (op.op === 'add' && op.resultEntryId) {
            await this.applyOp(tx, ownerId, changeset.spaceId, {
              op: 'reject', entryId: op.resultEntryId, draft: null, changes: null, payload: {}, sources: [], tainted: op.tainted,
            }, { ...owner, changesetOpId: op.id });
          }
          await this.writeOpDecision(tx, ownerId, op.id, { decision: 'withdrawn', decisionNote: null });
        }
        await this.settleChangeset(tx, ownerId, changeset.id);
        if (ops.length === 0) {
          return { revertedChangesetId: changeset.id, changesetId: null, replayed: false, ops: [], skipped };
        }
        const principal: WikiPrincipal = { origin: 'owner', ownerId, userId, sessionId: null, toolCallId: null };
        const rationale = `Revert of changeset ${uuidToBase62(changeset.id)}: what its review mode applied at once, taken back.`;
        const recorded = await this.recordChangeset(
          tx,
          principal,
          space,
          ops,
          { ops, rationale, idempotencyKey },
          sha256(canonicalJson({ spaceId: space.id, ops, rationale })),
          literals,
          restorations,
        );
        return { revertedChangesetId: changeset.id, ...recorded, skipped };
      },
      loggedRetry(this.logger, 'wiki.revertChangeset'),
    );
    if (answer.replayed !== true) {
      const spaceId = await this.prisma.wikiChangeset.findFirst({ where: { id: changesetId, ownerId }, select: { spaceId: true } });
      if (spaceId) this.realtime?.publishWikiChanged(ownerId, spaceId.spaceId);
    }
    return answer;
  }

  /**
   * The owner's Reject of an entry a review mode applied and nobody has confirmed — trust `auto` or
   * `unreviewed` — from the entry itself rather than from a card (contract `reviewModes.entryReject`).
   *
   * The entry becomes rejected, a counter-example with its reason exactly like a rejected proposal,
   * and the rejection is recorded on the op that made it: the add the mode applied. When that add is
   * an open spot check, this IS its answer, and it counts toward the spot checks' reject rate like one
   * given on the card. Anything else answers 409: a proposal is rejected in Review, and what the owner
   * wrote or confirmed is retired, never rejected.
   */
  async rejectEntry(
    ownerId: string,
    userId: string,
    entryId: string,
    input: { reason?: WikiRejectReason; note?: string },
    actingSessionId: string | null,
  ): Promise<Record<string, unknown>> {
    if (actingSessionId) {
      return refuse(
        'WIKI_OWNER_CHANNEL_ONLY',
        'rejecting what the wiki holds is the account owner\'s, through an owner channel with no acting session: '
          + 'report what should be rejected, and let a person reject it.',
      );
    }
    const reason = input.reason;
    if (!reason || !WIKI_REJECT_REASONS.includes(reason)) {
      return refuse('WIKI_SCHEMA', `reject names a reason: ${WIKI_REJECT_REASONS.join(', ')}`);
    }
    const done = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const entry = await this.ownEntryById(tx, ownerId, entryId);
        if (!entry) throw new NotFoundException('no such wiki entry');
        const made = entry.status === 'active' && WIKI_MACHINE_TRUST.includes(entry.trust as WikiTrust)
          ? await tx.wikiChangesetOp.findFirst({
              where: { ownerId, resultEntryId: entry.id, op: 'add', appliedByMode: { not: null } },
              select: { id: true, changesetId: true, spotCheck: true, decision: true },
            })
          : null;
        if (!made) {
          throw new ConflictException(
            'only an entry the review mode applied, and nobody has confirmed, is rejected from the entry: '
              + 'a proposal is rejected in Review, and what the owner wrote or confirmed is retired',
          );
        }
        await this.applyOp(tx, ownerId, entry.spaceId, {
          op: 'reject',
          entryId: entry.id,
          draft: null,
          changes: null,
          payload: {},
          sources: [],
          tainted: entry.tainted,
        }, { authorKind: 'owner', authorUserId: userId, authorSessionId: null, authorToolCallId: null, changesetOpId: made.id });
        await this.writeOpDecision(tx, ownerId, made.id, {
          decision: 'rejected',
          decisionReason: reason,
          decisionNote: input.note ?? null,
        });
        await this.settleChangeset(tx, ownerId, made.changesetId);
        const trip = made.spotCheck ? await this.tripIfRejecting(tx, ownerId, entry.spaceId) : null;
        const after = await this.ownEntryById(tx, ownerId, entry.id);
        return { view: entryView(after!), trip };
      },
      loggedRetry(this.logger, 'wiki.rejectEntry'),
    );
    this.realtime?.publishWikiChanged(ownerId, String(done.view.spaceId));
    if (done.trip) this.announceTrip(ownerId, done.trip);
    return done.view;
  }

  /**
   * Send the space back to Manual when the spot checks say its review mode is not to be trusted
   * (contract `reviewModes.spotChecks.window` and `trip`), and say whether THIS call did it.
   *
   * The rate is read over the latest answered spot checks recorded since the mode last changed, so a
   * mode the owner has just turned back on starts from a clean window. The switch is a compare-and-set
   * on the mode inside the caller's transaction, and merged into the settings in SQL rather than
   * written from a snapshot: of two rejections racing, the second finds the space already Manual and
   * reports nothing, which is what makes the owner's notification a once-only one; and an owner's
   * concurrent change to another setting survives it.
   */
  private async tripIfRejecting(tx: Tx, ownerId: string, spaceId: string): Promise<ReviewModeTrip | null> {
    const space = await tx.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { title: true, settings: true } });
    if (!space) return null;
    const settings = wikiSpaceSettings(space.settings);
    if (settings.reviewMode === 'manual') return null;
    const since = settings.reviewModeChangedAt ? new Date(settings.reviewModeChangedAt) : new Date(0);
    const window = WIKI_REVIEW_RULES.spotCheckWindow;
    const answered = await tx.wikiChangesetOp.findMany({
      where: {
        ownerId,
        spotCheck: true,
        decision: { in: ['accepted', 'edited', 'rejected'] },
        changeset: { spaceId, createdAt: { gte: since } },
      },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: window,
      select: { decision: true },
    });
    const rejected = answered.filter((row) => row.decision === 'rejected').length;
    if (rejected * 100 <= window * WIKI_REVIEW_RULES.spotCheckMaxRejectPercent) return null;
    const change = JSON.stringify({
      reviewMode: 'manual',
      reviewModeChangedAt: new Date().toISOString(),
      reviewModeChangedBy: 'spot_checks',
    } satisfies Partial<WikiSpaceSettings>);
    const switched = await tx.$executeRaw`
      UPDATE "wiki_space"
         SET "settings" = "settings" || ${change}::jsonb, "updated_at" = now()
       WHERE "id" = ${spaceId}::uuid
         AND "owner_id" = ${ownerId}::uuid
         AND "settings"->>'reviewMode' IN ('tiered', 'automatic')`;
    return switched === 1 ? { spaceId, title: space.title, rejected, window } : null;
  }

  /** The owner's one notification for a space the spot checks sent back to Manual. After the commit. */
  private announceTrip(ownerId: string, trip: ReviewModeTrip): void {
    void this.push?.notifyWikiReviewModeTripped({ ownerId, ...trip });
  }

  // ── Verification: what decides an Automatic space's ops (contract `reviewModes.verification`) ──

  /**
   * The ops that wait for their verification in one space, for the verifier that will judge them:
   * the runner door's read, and the import's own (contract `reviewModes.verification.list`).
   *
   * ONLY THE PROPOSER'S. A session sees the ops its own changesets hold, and the one-off import (no
   * session, origin import) the ops of the import changesets that name none — never anybody else's,
   * which is what makes "only the session that proposed may report" hold before a verdict is written.
   *
   * WHAT A VERIFIER NEEDS, AND NO MORE: the entry as it would read once applied, each source with the
   * text of its record read NOW and redacted as everything this service stores is (§10.2) — so a
   * record deleted since is a source with no text, and a secret in a tool's output never reaches the
   * model — and the neighbours recorded with the op, each as it reads now, because a duplicate may
   * only name one that is still live. The space's mode rides along: a verdict is refused outside
   * Automatic, and a verifier that reads it can stop before it asks a model anything.
   */
  async listVerifications(
    principal: WikiPrincipal,
    spaceId: string,
    options: { after?: string | null; limit?: number } = {},
  ): Promise<{ spaceId: string; mode: WikiReviewMode; items: WikiVerificationItem[]; next: string | null }> {
    const space = await this.requireSpace(principal.ownerId, spaceId);
    const asked = Number.isFinite(options.limit) ? Math.trunc(options.limit as number) : 20;
    const limit = Math.min(Math.max(asked, 1), WIKI_REVIEW_RULES.verificationListMax);
    let after: string | null = null;
    if (options.after) {
      try {
        after = toUuid(options.after);
      } catch {
        return refuse('WIKI_SCHEMA', 'after names no op: hand back the opId this list gave you', [
          { path: 'after', message: 'names no op' },
        ]);
      }
    }
    const rows = await this.prisma.wikiChangesetOp.findMany({
      where: {
        ownerId: principal.ownerId,
        decision: 'verifying',
        ...(after ? { id: { gt: after } } : {}),
        changeset: { spaceId: space.id, ...proposerScope(principal) },
      },
      // uuid(7): the id order is the order the ops were recorded in, and the partial index 0312 made.
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: {
        id: true,
        changesetId: true,
        op: true,
        entryId: true,
        payload: true,
        similar: true,
        changeset: { select: { sessionId: true } },
      },
    });
    const page = rows.slice(0, limit);
    const literals = await this.envLiterals(this.prisma, principal.ownerId);
    const items: WikiVerificationItem[] = [];
    for (const row of page) items.push(await this.verificationItem(principal.ownerId, row, literals));
    return {
      spaceId: space.id,
      mode: space.settings.reviewMode,
      items,
      next: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** One op of the verification list, read the way {@link listVerifications} says. */
  private async verificationItem(
    ownerId: string,
    row: {
      id: string;
      changesetId: string;
      op: string;
      entryId: string | null;
      payload: Prisma.JsonValue;
      similar: Prisma.JsonValue;
      changeset: { sessionId: string | null };
    },
    literals: readonly string[],
  ): Promise<WikiVerificationItem> {
    const reader = this.prisma as unknown as Tx;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    let entry: WikiVerificationItem['entry'];
    if (row.op === 'amend' && row.entryId) {
      const target = await this.ownEntryById(reader, ownerId, row.entryId);
      const merged = target ? mergeChanges(target, payload) : mergeChanges(emptyContent(), payload);
      entry = {
        kind: (target?.kind ?? 'concept') as WikiEntryKind,
        title: merged.title,
        summary: merged.summary,
        fields: (merged.fields ?? {}) as Record<string, unknown>,
        topics: merged.topics,
        aliases: merged.aliases,
      };
    } else {
      const draft = (payload.entry ?? {}) as Record<string, unknown>;
      entry = {
        kind: (draftKind(draft) ?? 'concept') as WikiEntryKind,
        title: String(draft.title ?? ''),
        summary: String(draft.summary ?? ''),
        fields: (draft.fields ?? {}) as Record<string, unknown>,
        topics: (draft.topics ?? []) as string[],
        aliases: (draft.aliases ?? []) as string[],
      };
    }
    // Resolved against the session that proposed the op, as a decide resolves them: `{session:'self'}`
    // names THAT session's turn, whoever is reading.
    const as: WikiPrincipal = { origin: 'agent', ownerId, userId: null, sessionId: row.changeset.sessionId, toolCallId: null };
    const sources: WikiVerificationItem['sources'] = [];
    for (const raw of rawOpSources(payload)) {
      const cited = raw as { kind: WikiSourceKind; ref?: string; session?: 'self'; seq?: number; quote?: string };
      const found = await this.sourceText(reader, as, cited);
      const full = found?.text ?? null;
      const redacted = full === null ? null : redactSecrets(full, { literals }).text;
      const max = WIKI_REVIEW_RULES.verificationSourceMaxChars;
      const chars = redacted === null ? [] : [...redacted];
      sources.push({
        kind: cited.kind,
        ref: found?.ref ?? cited.ref ?? '',
        quote: typeof cited.quote === 'string' ? cited.quote : null,
        text: redacted === null ? null : chars.slice(0, max).join(''),
        truncated: chars.length > max,
      });
    }
    // The neighbours as recorded, each as it reads now: a duplicate may only name one still live.
    const recorded = (Array.isArray(row.similar) ? row.similar : []) as unknown as WikiSimilar[];
    const now = recorded.length === 0
      ? []
      : await this.prisma.wikiEntry.findMany({
          where: { ownerId, id: { in: recorded.map((near) => near.id) } },
          select: { id: true, kind: true, title: true, status: true, trust: true },
        });
    const byId = new Map(now.map((near) => [near.id, near]));
    const similar = recorded
      .filter((near) => byId.has(near.id))
      .map((near) => {
        const current = byId.get(near.id)!;
        return {
          ...near,
          kind: current.kind as WikiEntryKind,
          title: current.title,
          status: current.status as WikiEntryStatus,
          trust: current.trust as WikiTrust,
        };
      });
    return {
      opId: row.id,
      changesetId: row.changesetId,
      op: row.op as 'add' | 'amend',
      entryId: row.op === 'amend' ? row.entryId : null,
      entry,
      sources,
      similar,
    };
  }

  /**
   * Record verdicts, and apply each as its verdict says (contract `reviewModes.verification.verdicts`):
   * the runner door's report, and the import's own.
   *
   * EACH VERDICT ON ITS OWN, IN A TRANSACTION OF ITS OWN: what one verifier call decided is not undone
   * because the next one in the same request was refused, and a verifier that reports as it goes
   * loses nothing when it stops half way. The answer carries every verdict's outcome; the door
   * answers the status of the first refusal when none was recorded.
   *
   * WHO MAY: the proposer (`proposerScope`), and nobody else's op is even found — a 404, as another
   * owner's is. WHEN: while the space is Automatic, and only then (`verification.notAutomatic`).
   */
  async recordVerifications(
    principal: WikiPrincipal,
    spaceId: string,
    verdicts: unknown,
  ): Promise<{ spaceId: string; mode: WikiReviewMode; outcomes: WikiVerificationOutcome[] }> {
    const space = await this.requireSpace(principal.ownerId, spaceId);
    if (!Array.isArray(verdicts) || verdicts.length === 0) {
      return refuse('WIKI_SCHEMA', 'verdicts must hold at least one verdict', [{ path: 'verdicts', message: 'is required' }]);
    }
    if (verdicts.length > WIKI_LIMITS.opsPerChangeset) {
      return refuse('WIKI_SCHEMA', `a report holds at most ${WIKI_LIMITS.opsPerChangeset} verdicts: send the rest in another`, [
        { path: 'verdicts', message: `must hold at most ${WIKI_LIMITS.opsPerChangeset}` },
      ]);
    }
    const literals = await this.envLiterals(this.prisma, principal.ownerId);
    const outcomes: WikiVerificationOutcome[] = [];
    let wrote = false;
    for (const [index, raw] of verdicts.entries()) {
      const named = typeof (raw as { opId?: unknown } | null)?.opId === 'string' ? String((raw as { opId: string }).opId) : '';
      try {
        const verdict = verdictInput(raw, index);
        const done = await withTransactionRetry(
          this.prisma,
          (tx) => this.applyVerdict(tx, principal, space.id, verdict, literals),
          loggedRetry(this.logger, 'wiki.recordVerifications'),
        );
        outcomes.push(done.outcome);
        if (done.wrote) wrote = true;
        // After the commit, and outside it: the fallback is announced once, by the call that won it.
        if (done.trip) void this.push?.notifyWikiVerificationTripped({ ownerId: principal.ownerId, ...done.trip });
      } catch (error) {
        if (error instanceof VerdictRefusal) {
          outcomes.push({ opId: named, status: 'refused', httpStatus: error.httpStatus, ...(error.code ? { code: error.code } : {}), message: error.message });
        } else if (error instanceof WikiRefusalError) {
          outcomes.push({ opId: named, status: 'refused', httpStatus: WIKI_HTTP_STATUS[error.refusal.code], code: error.refusal.code, message: error.refusal.message });
        } else {
          throw error;
        }
      }
    }
    if (wrote) this.realtime?.publishWikiChanged(principal.ownerId, space.id);
    const after = await this.requireSpace(principal.ownerId, space.id);
    return { spaceId: space.id, mode: after.settings.reviewMode, outcomes };
  }

  /**
   * One verdict, inside its own transaction: the op found among the proposer's, its verdict applied
   * through `applyOp` (storage.singleWriter), and its trail and decision written in ONE update whose
   * predicate is the compare-and-set — the op still `verifying` — so two verdicts for the same op
   * cannot both land, and a second one sent for an op already verified the same way is answered with
   * what was recorded and writes nothing.
   */
  private async applyVerdict(
    tx: Tx,
    principal: WikiPrincipal,
    spaceId: string,
    verdict: VerdictInput,
    literals: readonly string[],
  ): Promise<{ outcome: WikiVerificationOutcome; trip: VerificationTrip | null; wrote: boolean }> {
    const ownerId = principal.ownerId;
    const opId = toUuid(verdict.opId);
    const op = await tx.wikiChangesetOp.findFirst({
      where: { id: opId, ownerId, changeset: { spaceId, ...proposerScope(principal) } },
      select: {
        id: true,
        changesetId: true,
        op: true,
        entryId: true,
        baseRevision: true,
        payload: true,
        similar: true,
        tainted: true,
        decision: true,
        resultEntryId: true,
        resultRevision: true,
        verificationVerdict: true,
        verificationDuplicateOf: true,
        changeset: { select: { sessionId: true, toolCallId: true } },
      },
    });
    if (!op) {
      throw new VerdictRefusal(404, 'no such op waits for a verdict from this caller in this space: a verdict is '
        + "reported for the ops the caller itself proposed, by the opId the verification list gave");
    }
    const duplicateOf = verdict.verdict === 'duplicate' && verdict.duplicateOf ? toUuid(verdict.duplicateOf) : null;
    if (op.decision !== 'verifying') {
      if (op.verificationVerdict === verdict.verdict && (op.verificationDuplicateOf ?? null) === duplicateOf) {
        return {
          outcome: {
            opId: op.id,
            status: verdictStatus(op.verificationVerdict as WikiVerificationVerdict, op.decision),
            verdict: verdict.verdict,
            entryId: duplicateOf ?? op.resultEntryId ?? op.entryId,
            replayed: true,
          },
          trip: null,
          wrote: false,
        };
      }
      throw new VerdictRefusal(409, op.verificationVerdict
        ? `this op was already verified ${op.verificationVerdict}: a verdict is given once`
        : `this op no longer waits for a verdict: it is ${op.decision}`);
    }
    const space = await tx.wikiSpace.findFirstOrThrow({ where: { id: spaceId, ownerId }, select: { settings: true } });
    const settings = wikiSpaceSettings(space.settings);
    if (settings.reviewMode !== 'automatic') {
      throw new VerdictRefusal(409, `this space is ${settings.reviewMode} now, not automatic, so no verdict is recorded: `
        + 'its ops keep waiting for their verification until the owner makes it automatic again, or reverts their run');
    }
    if (duplicateOf !== null) {
      const recorded = (Array.isArray(op.similar) ? op.similar : []) as unknown as WikiSimilar[];
      const named = new Set([...recorded.map((near) => near.id), ...(op.op === 'amend' && op.entryId ? [op.entryId] : [])]);
      if (!named.has(duplicateOf)) {
        throw new VerdictRefusal(400, "duplicateOf names no entry among this op's similar[] (or, for an amend, its own "
          + 'entry): a duplicate names the neighbour the verification list gave', 'WIKI_SCHEMA');
      }
      const target = await tx.wikiEntry.findFirst({ where: { id: duplicateOf, ownerId, spaceId }, select: { status: true } });
      if (target?.status !== 'active') {
        throw new VerdictRefusal(409, 'the entry duplicateOf names is not active any more: its sources cannot be added to it');
      }
    }
    const reason = cutTo(redactSecrets(verdict.reason.trim(), { literals }).text, WIKI_REVIEW_RULES.verificationReasonMaxChars);
    const model = verdict.model.trim();
    const payload = (op.payload ?? {}) as Record<string, unknown>;
    // The revision a verdict applies is the proposer's, not the verifier's: the words are what was
    // proposed, as when the owner accepts a proposal as written.
    const author: WikiAuthor = {
      authorKind: principal.authorKind ?? (principal.origin === 'owner' ? 'owner' : 'agent'),
      authorUserId: null,
      authorSessionId: op.changeset.sessionId,
      authorToolCallId: op.changeset.toolCallId,
      changesetOpId: op.id,
    };
    const trust = wikiVerdictTrust(verdict.verdict);
    let status: 'applied' | 'rejected' | 'reinforced' | 'conflict';
    let decision: 'auto_applied' | 'pending' | 'rejected' | 'conflict';
    let decisionReason: WikiRejectReason | null = null;
    let resultRevision = op.resultRevision;
    let spotCheck = false;
    let reinforced: boolean | undefined;
    if (trust !== null) {
      let applied = false;
      if (op.op === 'add' && op.resultEntryId) {
        await this.applyOp(tx, ownerId, spaceId, {
          op: 'promote', entryId: op.resultEntryId, draft: null, changes: null, payload, sources: [], tainted: op.tainted, promotedTrust: trust,
        }, author);
        applied = true;
      } else if (op.op === 'amend' && op.entryId) {
        // The floors again, at the moment it applies: the entry may have moved, or passed into the
        // owner's hands, while its op waited — and then the machine does not change it.
        const target = await this.ownEntryById(tx, ownerId, op.entryId);
        const floor = target ? await this.reviewTarget(tx, ownerId, target) : null;
        if (target && floor && target.currentRevision === op.baseRevision && floor.machineWritten && !floor.ownerVouched) {
          const sources = await this.sourcesOfOp(tx, ownerId, op.changeset.sessionId, payload);
          try {
            const written = await this.applyOp(tx, ownerId, spaceId, {
              op: 'amend', entryId: op.entryId, draft: null, changes: null, payload, sources, tainted: op.tainted, trustAfter: trust,
            }, author);
            resultRevision = written.revision;
            applied = true;
          } catch (error) {
            if (!(error instanceof WikiConflict)) throw error;
          }
        }
      }
      if (applied) {
        // Automatic's spot check, when its owner asked for any: one in every block of the ops its
        // verdicts apply, by position, exactly as Tiered draws one in every block of ten.
        spotCheck = settings.automaticSpotChecks && isSpotCheckDraw(
          spaceId,
          await tx.wikiChangesetOp.count({ where: { ownerId, appliedByMode: { not: null }, changeset: { spaceId } } }),
          WIKI_REVIEW_RULES.automaticSpotCheckEvery,
        );
        status = 'applied';
        decision = spotCheck ? 'pending' : 'auto_applied';
      } else {
        status = 'conflict';
        decision = 'conflict';
      }
    } else {
      // Unsupported or a duplicate: the op is rejected as a new claim, and an add's lineage with it —
      // a counter-example the next similar[] shows with its reason.
      if (op.op === 'add' && op.resultEntryId) {
        await this.applyOp(tx, ownerId, spaceId, {
          op: 'reject', entryId: op.resultEntryId, draft: null, changes: null, payload, sources: [], tainted: op.tainted,
        }, author);
      }
      decision = 'rejected';
      if (verdict.verdict === 'unsupported') {
        status = 'rejected';
        decisionReason = 'not_true';
      } else {
        status = 'reinforced';
        decisionReason = 'duplicate';
        // What it cited is kept, on the entry it duplicates — unless the owner reviews every reinforce.
        reinforced = settings.autoAcceptReinforce !== false;
        if (reinforced) {
          const lineage = op.op === 'add' && op.resultEntryId
            ? await tx.wikiEntryRevision.findFirst({ where: { entryId: op.resultEntryId, ownerId, revision: 1 }, select: { id: true } })
            : null;
          const sources = lineage
            ? await this.sourcesOfRevision(tx, ownerId, lineage.id)
            : await this.sourcesOfOp(tx, ownerId, op.changeset.sessionId, payload);
          await this.applyOp(tx, ownerId, spaceId, {
            op: 'reinforce', entryId: duplicateOf, draft: null, changes: null, payload, sources, tainted: op.tainted,
          }, author);
        }
      }
    }
    const now = new Date();
    const recorded = await tx.wikiChangesetOp.updateMany({
      where: { id: op.id, ownerId, decision: 'verifying' },
      data: {
        decision,
        decisionReason,
        decidedAt: decision === 'pending' ? null : now,
        appliedByMode: status === 'applied' ? 'automatic' : null,
        spotCheck,
        resultRevision,
        verificationVerdict: verdict.verdict,
        verificationReason: reason,
        verificationModel: model,
        verifiedAt: now,
        verificationDuplicateOf: duplicateOf,
      },
    });
    if (recorded.count !== 1) {
      throw new VerdictRefusal(409, 'another verdict for this op landed at the same moment: read the list again');
    }
    await this.settleChangeset(tx, ownerId, op.changesetId);
    const trip = verdict.verdict === 'unsupported' ? await this.tripIfUnsupported(tx, ownerId, spaceId) : null;
    return {
      outcome: {
        opId: op.id,
        status,
        verdict: verdict.verdict,
        entryId: status === 'reinforced' ? duplicateOf : (op.resultEntryId ?? op.entryId),
        ...(status === 'applied' ? { trust: trust!, spotCheck } : {}),
        ...(reinforced !== undefined ? { reinforced } : {}),
      },
      trip,
      wrote: true,
    };
  }

  /**
   * Send an Automatic space back to Tiered when its verification says what it takes in is not to be
   * trusted (contract `reviewModes.verification.fallback`), and say whether THIS call did it.
   *
   * The rate is read over the latest verdicts recorded since the mode last changed, so a space the
   * owner has just made Automatic again starts from a clean window. The switch is a compare-and-set
   * on the mode inside the caller's transaction, merged into the settings in SQL: of two verdicts
   * racing over the line, the second finds the space already Tiered and reports nothing, which is
   * what makes the owner's notification a once-only one.
   */
  private async tripIfUnsupported(tx: Tx, ownerId: string, spaceId: string): Promise<VerificationTrip | null> {
    const space = await tx.wikiSpace.findFirst({ where: { id: spaceId, ownerId }, select: { title: true, settings: true } });
    if (!space) return null;
    const settings = wikiSpaceSettings(space.settings);
    if (settings.reviewMode !== 'automatic') return null;
    const since = settings.reviewModeChangedAt ? new Date(settings.reviewModeChangedAt) : new Date(0);
    const window = WIKI_REVIEW_RULES.verificationWindow;
    const latest = await tx.wikiChangesetOp.findMany({
      where: { ownerId, verificationVerdict: { not: null }, verifiedAt: { gte: since }, changeset: { spaceId } },
      orderBy: [{ verifiedAt: 'desc' }, { id: 'desc' }],
      take: window,
      select: { verificationVerdict: true },
    });
    const unsupported = latest.filter((row) => row.verificationVerdict === 'unsupported').length;
    if (unsupported * 100 <= window * WIKI_REVIEW_RULES.verificationMaxUnsupportedPercent) return null;
    const change = JSON.stringify({
      reviewMode: 'tiered',
      reviewModeChangedAt: new Date().toISOString(),
      reviewModeChangedBy: 'verification',
    } satisfies Partial<WikiSpaceSettings>);
    const switched = await tx.$executeRaw`
      UPDATE "wiki_space"
         SET "settings" = "settings" || ${change}::jsonb, "updated_at" = now()
       WHERE "id" = ${spaceId}::uuid
         AND "owner_id" = ${ownerId}::uuid
         AND "settings"->>'reviewMode' = 'automatic'`;
    return switched === 1 ? { spaceId, title: space.title, unsupported, window } : null;
  }

  /** One op's answer: what the owner decided, and what it applied. True for a rejected spot check. */
  private async applyDecision(
    tx: Tx,
    ownerId: string,
    userId: string,
    changeset: ChangesetRow,
    decision: WikiDecisionInput,
  ): Promise<boolean> {
    const op = changeset.ops.find((row) => row.id === decision.opId);
    if (!op) throw new NotFoundException('no such op in this changeset');
    if (op.decision !== 'pending') {
      // Not a WIKI_ code: the contract's closed set has none for it, and this is an answer about the
      // row's state rather than about the request's shape. A second press must not decide twice.
      throw new ConflictException('this op has already been decided');
    }
    // Taken here, not left to the row: one call may name the same op twice, and the snapshot it decides
    // from was read before the first decision wrote.
    op.decision = 'deciding';
    if (op.spotCheck) return this.answerSpotCheck(tx, ownerId, userId, changeset, op, decision);
    const opName = op.op as WikiOp;
    // The lineage the decision is ABOUT. An add has no target of its own, and a supersede's `entry_id`
    // names the entry it replaces — in both cases the row the op created is `result_entry_id`, and it
    // is what a promotion makes live and what a rejection ends.
    const entryId = opName === 'add' || opName === 'supersede' ? (op.resultEntryId ?? op.entryId) : op.entryId;
    const ownerAuthor: WikiAuthor = {
      authorKind: 'owner',
      authorUserId: userId,
      authorSessionId: null,
      authorToolCallId: null,
      changesetOpId: op.id,
    };
    if (decision.action === 'reject') {
      const reason = decision.reason;
      if (!reason || !WIKI_REJECT_REASONS.includes(reason)) {
        return refuse('WIKI_SCHEMA', `reject names a reason: ${WIKI_REJECT_REASONS.join(', ')}`);
      }
      if (entryId) {
        // The row stays, as a counter-example the next similar[] shows with its reason (states.entry).
        await this.applyOp(tx, ownerId, changeset.spaceId, {
          op: 'reject',
          entryId,
          draft: null,
          changes: null,
          payload: op.payload as Record<string, unknown>,
          sources: [],
          tainted: op.tainted,
        }, ownerAuthor);
      }
      await this.writeOpDecision(tx, ownerId, op.id, {
        decision: 'rejected',
        decisionReason: reason,
        decisionNote: decision.note ?? null,
      });
      return false;
    }
    const editing = decision.action === 'edit';
    // An edit arrives shaped as an amend's changes, whatever op it answers (`effectPolicy.decide.edit`):
    // each key given replaces that key of the proposal, and each key left out carries it over.
    const proposed = (op.payload ?? {}) as Record<string, unknown>;
    const edited = (editing ? decision.edited : null) as WikiEntryChanges | null;
    if (editing) {
      const target = op.entryId ? await this.ownEntryById(tx, ownerId, op.entryId) : null;
      const kind = opName === 'add' || opName === 'supersede'
        ? draftKind(proposed.entry)
        : (target?.kind as WikiKind | undefined);
      if (!kind) return refuse('WIKI_SCHEMA', 'the edited op names no kind');
      if (opName === 'add' || opName === 'supersede') {
        const merged = mergeDraft((proposed.entry ?? {}) as Record<string, unknown>, edited ?? {});
        const errors = validateWikiEntryDraft(merged, 'entry');
        if (errors.length > 0) {
          return refuse('WIKI_SCHEMA', "the owner's edit does not have the shape this contract gives it", errors);
        }
        // The edit is written as a revision of its own before the lineage goes live, so what the owner
        // changed is a revision the owner authored (`trust.edited`) and revision 1 stays as proposed.
        await this.applyOp(tx, ownerId, changeset.spaceId, {
          op: 'amend',
          entryId,
          draft: null,
          changes: null,
          payload: merged,
          sources: await this.sourcesOfOp(tx, ownerId, changeset.sessionId, proposed),
          tainted: op.tainted,
        }, ownerAuthor);
        const promoted = await this.applyOp(tx, ownerId, changeset.spaceId, {
          op: 'promote',
          entryId,
          draft: null,
          changes: null,
          payload: proposed,
          sources: [],
          tainted: op.tainted,
          promotedTrust: 'confirmed',
        }, ownerAuthor);
        await this.writeOpDecision(tx, ownerId, op.id, {
          decision: 'edited',
          decisionNote: decision.note ?? null,
          resultEntryId: promoted.entryId,
          resultRevision: promoted.revision,
        });
        if (entryId) await this.recomputeFlags(tx, ownerId, entryId);
        return false;
      }
      const errors = validateWikiEntryChanges(edited, kind, 'changes');
      if (errors.length > 0) {
        return refuse('WIKI_SCHEMA', "the owner's edit does not have the shape this contract gives it", errors);
      }
    }
    // Compare-and-set at the moment it applies: the entry may have moved while the op waited.
    let machineTarget = false;
    if ((opName === 'amend' || opName === 'supersede' || opName === 'retire') && op.entryId) {
      const target = await this.ownEntryById(tx, ownerId, op.entryId);
      if (!target) throw new NotFoundException('no such wiki entry');
      if (op.baseRevision !== target.currentRevision) {
        await this.writeOpDecision(tx, ownerId, op.id, { decision: 'conflict', decisionNote: null });
        return false;
      }
      machineTarget = target.status === 'active' && WIKI_MACHINE_TRUST.includes(target.trust as WikiTrust);
    }
    // An edit of an amend is the owner's changes laid over the proposal's, as an add's is over its
    // draft above: a key the owner left alone is the proposal's, not the entry's. And the proposal's
    // sources are still what the revision rests on — the owner rewrote the words, not the evidence.
    const payload = editing
      ? { ...((proposed.changes ?? {}) as Record<string, unknown>), ...(edited as Record<string, unknown>) }
      : proposed;
    const sources = await this.sourcesOfOp(tx, ownerId, changeset.sessionId, proposed);
    const draft = opName === 'add' || opName === 'supersede' ? preparedDraft((payload.entry ?? {}) as Record<string, unknown>) : null;
    const promote = opName === 'add' || opName === 'supersede';
    const written = await this.applyOp(tx, ownerId, changeset.spaceId, {
      // Accepting an add or a supersede is what makes its lineage live; everything else applies its own op.
      op: promote ? 'promote' : opName,
      entryId,
      draft,
      changes: (payload.changes ?? null) as WikiEntryChanges | null,
      payload,
      sources,
      tainted: op.tainted,
      promotedTrust: 'confirmed',
      // An amend the owner accepted into an entry the machine wrote is theirs to vouch for now
      // (`trust.onApply.acceptedAddSupersedeOrAmend`); into any other entry, it keeps the trust it found.
      ...(opName === 'amend' && machineTarget ? { trustAfter: 'confirmed' as const } : {}),
    }, editing ? ownerAuthor : { ...ownerAuthor, authorKind: 'agent', authorUserId: null, authorSessionId: changeset.sessionId, authorToolCallId: changeset.toolCallId });
    await this.writeOpDecision(tx, ownerId, op.id, {
      decision: editing ? 'edited' : 'accepted',
      decisionNote: decision.note ?? null,
      resultEntryId: written.entryId,
      resultRevision: written.revision,
    });
    // After the decision is on the row, not before: a challenge is answered by the decision itself, so
    // the flags have to be recomputed against the world the decision just made.
    if (entryId) await this.recomputeFlags(tx, ownerId, entryId);
    return false;
  }

  /**
   * The owner's answer to a spot check (contract `reviewModes.spotChecks.answers`). The op's effect
   * already stands, so accepting confirms it, editing lays the owner's changes over it, and rejecting
   * undoes it — an add's entry rejected, an amend's entry put back to the revision it replaced. An
   * entry that changed after the op applied is not answered for it: `conflict`, as a proposal whose
   * base moved is. True when it recorded a rejection, which is what the reject rate counts.
   */
  private async answerSpotCheck(
    tx: Tx,
    ownerId: string,
    userId: string,
    changeset: ChangesetRow,
    op: ChangesetRow['ops'][number],
    decision: WikiDecisionInput,
  ): Promise<boolean> {
    if (decision.action === 'reject' && (!decision.reason || !WIKI_REJECT_REASONS.includes(decision.reason))) {
      return refuse('WIKI_SCHEMA', `reject names a reason: ${WIKI_REJECT_REASONS.join(', ')}`);
    }
    const entryId = op.resultEntryId ?? op.entryId;
    const entry = entryId ? await this.ownEntryById(tx, ownerId, entryId) : null;
    if (!entry || entry.status !== 'active' || entry.currentRevision !== op.resultRevision) {
      await this.writeOpDecision(tx, ownerId, op.id, { decision: 'conflict', decisionNote: null });
      return false;
    }
    const owner: WikiAuthor = {
      authorKind: 'owner',
      authorUserId: userId,
      authorSessionId: null,
      authorToolCallId: null,
      changesetOpId: op.id,
    };
    const proposed = (op.payload ?? {}) as Record<string, unknown>;
    const bare = { draft: null, changes: null, sources: [], tainted: op.tainted } as const;
    if (decision.action === 'accept') {
      await this.applyOp(tx, ownerId, changeset.spaceId, { ...bare, op: 'confirm', entryId: entry.id, payload: proposed }, owner);
      await this.writeOpDecision(tx, ownerId, op.id, { decision: 'accepted', decisionNote: decision.note ?? null });
      return false;
    }
    if (decision.action === 'edit') {
      // The owner's changes laid over what the op wrote: an add's whole draft, an amend's changes.
      const edited = (decision.edited ?? {}) as WikiEntryChanges;
      const payload = op.op === 'add'
        ? mergeDraft((proposed.entry ?? {}) as Record<string, unknown>, edited)
        : { ...((proposed.changes ?? {}) as Record<string, unknown>), ...(edited as Record<string, unknown>) };
      const errors = op.op === 'add'
        ? validateWikiEntryDraft(payload, 'entry')
        : validateWikiEntryChanges(payload, entry.kind as WikiKind, 'changes');
      if (errors.length > 0) {
        return refuse('WIKI_SCHEMA', "the owner's edit does not have the shape this contract gives it", errors);
      }
      const written = await this.applyOp(tx, ownerId, changeset.spaceId, {
        op: 'amend',
        entryId: entry.id,
        draft: null,
        changes: null,
        payload,
        sources: await this.sourcesOfOp(tx, ownerId, changeset.sessionId, proposed),
        tainted: op.tainted,
        trustAfter: 'confirmed',
      }, owner);
      await this.writeOpDecision(tx, ownerId, op.id, {
        decision: 'edited',
        decisionNote: decision.note ?? null,
        resultEntryId: written.entryId,
        resultRevision: written.revision,
      });
      return false;
    }
    if (op.op === 'add') {
      await this.applyOp(tx, ownerId, changeset.spaceId, { ...bare, op: 'reject', entryId: entry.id, payload: proposed }, owner);
    } else {
      await this.restoreRevision(tx, ownerId, changeset.spaceId, entry.id, op.baseRevision!, owner);
    }
    await this.writeOpDecision(tx, ownerId, op.id, {
      decision: 'rejected',
      decisionReason: decision.reason,
      decisionNote: decision.note ?? null,
    });
    return true;
  }

  /**
   * Put an earlier revision's content back as the entry's next revision, with the sources that
   * revision rested on, and leave the entry unreviewed (`trust.onApply.undoneByRevertOrSpotCheck`):
   * what the owner has just said about the change it undoes is reason enough to take the entry out
   * of the push until somebody looks at it again.
   */
  private async restoreRevision(
    tx: Tx,
    ownerId: string,
    spaceId: string,
    entryId: string,
    revision: number,
    author: WikiAuthor,
  ): Promise<{ entryId: string; revision: number | null }> {
    const before = await tx.wikiEntryRevision.findFirstOrThrow({
      where: { entryId, ownerId, revision },
      select: { id: true, title: true, summary: true, fields: true, topics: true, aliases: true, anchors: true },
    });
    const { id, ...content } = before;
    return this.applyOp(tx, ownerId, spaceId, {
      op: 'amend',
      entryId,
      draft: null,
      changes: null,
      payload: { changes: content },
      sources: await this.sourcesOfRevision(tx, ownerId, id),
      tainted: false,
      trustAfter: 'unreviewed',
    }, author);
  }

  /** The op's row, in the state its decision left it (contract `states.op`). */
  private async writeOpDecision(
    tx: Tx,
    ownerId: string,
    opId: string,
    data: {
      decision: string;
      decisionReason?: string | null;
      decisionNote: string | null;
      resultEntryId?: string | null;
      resultRevision?: number | null;
    },
  ): Promise<void> {
    await tx.wikiChangesetOp.updateMany({
      where: { id: opId, ownerId },
      data: {
        decision: data.decision,
        decisionReason: data.decisionReason ?? null,
        decisionNote: data.decisionNote,
        decidedAt: new Date(),
        ...(data.resultEntryId !== undefined ? { resultEntryId: data.resultEntryId } : {}),
        ...(data.resultRevision !== undefined ? { resultRevision: data.resultRevision } : {}),
      },
    });
  }

  /** A changeset is settled once none of its ops is still waiting — for the owner, or for its verdict. */
  private async settleChangeset(tx: Tx, ownerId: string, changesetId: string): Promise<void> {
    const waiting = await tx.wikiChangesetOp.count({ where: { changesetId, ownerId, decision: { in: ['pending', 'verifying'] } } });
    if (waiting > 0) return;
    await tx.wikiChangeset.updateMany({
      where: { id: changesetId, ownerId },
      data: { status: 'settled', decidedAt: new Date(), expiresAt: null },
    });
  }

  // ── applyOp: the ONE writer of an entry's state (design §3) ───────────────────────────────────

  /**
   * Apply one instruction to `wiki_entry`, and write the revision or the sources it brings.
   *
   * `wiki_entry.status`, `trust`, `challenged` and `unsupported` are written HERE and in
   * `recomputeFlags`, and nowhere else in the tree; `common/db-write-inventory.ts` registers those two
   * writers and no other. Every branch that changes what the entry says ends in `recomputeFlags`,
   * because a revision that answers a challenge, or a source that stops being live, changes the flags
   * as much as it changes the content.
   */
  private async applyOp(
    tx: Tx,
    ownerId: string,
    spaceId: string,
    instruction: WikiApplyInstruction,
    author: WikiAuthor,
  ): Promise<{ entryId: string; revision: number | null }> {
    const now = new Date();
    /**
     * An entry that left active takes its unanswered ops with it: they can no longer apply. That
     * includes the spot check of the add that made it, which names the entry as its result rather
     * than as its target, and an amend of it still waiting for its verdict.
     */
    const withdrawPendingOps = (entryId: string) =>
      tx.wikiChangesetOp.updateMany({
        where: {
          ownerId,
          OR: [
            { decision: { in: ['pending', 'verifying'] }, entryId },
            { decision: 'pending', resultEntryId: entryId, spotCheck: true },
          ],
        },
        data: { decision: 'withdrawn', decidedAt: new Date() },
      });
    const supersedeTarget = async (targetId: string, successorId: string) => {
      await tx.wikiEntry.updateMany({
        where: { id: targetId, ownerId },
        data: { status: 'superseded', supersededById: successorId, retiredAt: now, validTo: now },
      });
      await withdrawPendingOps(targetId);
      await this.recomputeFlags(tx, ownerId, targetId);
    };
    switch (instruction.op) {
      case 'add':
      case 'supersede': {
        const draft = instruction.draft!;
        const entry = await tx.wikiEntry.create({
          data: {
            ownerId,
            spaceId,
            kind: draft.kind,
            // A lineage is born proposed and becomes active when it applies: the owner's own write is
            // live at once, and an agent's waits for Review.
            status: 'proposed',
            trust: 'proposed',
            currentRevision: 1,
            title: draft.title,
            summary: draft.summary,
            fields: draft.fields as Prisma.InputJsonValue,
            topics: draft.topics,
            aliases: draft.aliases,
            anchors: draft.anchors as unknown as Prisma.InputJsonValue,
            tainted: instruction.tainted,
            supersedesId: instruction.op === 'supersede' ? instruction.entryId : null,
            validFrom: now,
            recordedAt: now,
          },
          select: { id: true },
        });
        await this.insertRevision(tx, ownerId, entry.id, 1, draft, instruction.sources, author);
        if (!instruction.proposed) {
          // The owner's own work is live at once; nothing waits behind this call.
          await this.applyOp(tx, ownerId, spaceId, { ...instruction, op: 'promote', entryId: entry.id }, author);
        }
        return { entryId: entry.id, revision: 1 };
      }
      case 'promote': {
        // The owner accepted a proposal (or wrote it themselves): what the lineage proposes is now live,
        // and the lineage it supersedes can be retired behind it.
        const entry = await tx.wikiEntry.findFirstOrThrow({
          where: { id: instruction.entryId!, ownerId },
          select: { id: true, supersedesId: true },
        });
        await tx.wikiEntry.updateMany({
          where: { id: entry.id, ownerId },
          data: {
            status: 'active',
            trust: instruction.promotedTrust ?? (author.authorKind === 'owner' ? 'owner' : 'confirmed'),
          },
        });
        if (entry.supersedesId) await supersedeTarget(entry.supersedesId, entry.id);
        await this.recomputeFlags(tx, ownerId, entry.id);
        return { entryId: entry.id, revision: null };
      }
      case 'amend': {
        const target = await tx.wikiEntry.findFirstOrThrow({
          where: { id: instruction.entryId!, ownerId },
          select: { id: true, kind: true, currentRevision: true, title: true, summary: true, fields: true, topics: true, aliases: true, anchors: true },
        });
        const merged = mergeChanges(target, instruction.payload);
        const revision = target.currentRevision + 1;
        const applied = await tx.wikiEntry.updateMany({
          where: { id: target.id, ownerId, currentRevision: target.currentRevision },
          data: {
            currentRevision: revision,
            title: merged.title,
            summary: merged.summary,
            fields: merged.fields as Prisma.InputJsonValue,
            topics: merged.topics,
            aliases: merged.aliases,
            anchors: merged.anchors as unknown as Prisma.InputJsonValue,
            ...(instruction.tainted ? { tainted: true } : {}),
            ...(instruction.trustAfter ? { trust: instruction.trustAfter } : {}),
          },
        });
        if (applied.count !== 1) {
          // The entry moved between the compare-and-set and this write. Nothing was written (the
          // predicate matched no row), and the caller is told which revision it is at now.
          const current = await this.ownEntryById(tx, ownerId, target.id);
          if (!current) throw new NotFoundException('no such wiki entry');
          throw new WikiConflict(revisionConflict(0, current, target.currentRevision, instruction.payload));
        }
        await this.insertRevision(tx, ownerId, target.id, revision, { ...merged, kind: target.kind as WikiKind }, instruction.sources, author);
        await this.recomputeFlags(tx, ownerId, target.id);
        return { entryId: target.id, revision };
      }
      case 'reinforce': {
        const target = await tx.wikiEntry.findFirstOrThrow({
          where: { id: instruction.entryId!, ownerId },
          select: { id: true, currentRevision: true },
        });
        const revision = await tx.wikiEntryRevision.findFirstOrThrow({
          where: { entryId: target.id, ownerId, revision: target.currentRevision },
          select: { id: true },
        });
        await this.insertSources(tx, ownerId, revision.id, instruction.sources);
        if (instruction.tainted) {
          await tx.wikiEntry.updateMany({ where: { id: target.id, ownerId }, data: { tainted: true } });
        }
        await this.recomputeFlags(tx, ownerId, target.id);
        return { entryId: target.id, revision: target.currentRevision };
      }
      case 'retire': {
        await tx.wikiEntry.updateMany({
          where: { id: instruction.entryId!, ownerId },
          data: { status: 'retired', retiredAt: now, validTo: now },
        });
        await withdrawPendingOps(instruction.entryId!);
        await this.recomputeFlags(tx, ownerId, instruction.entryId!);
        return { entryId: instruction.entryId!, revision: null };
      }
      case 'challenge': {
        await tx.wikiEntry.updateMany({ where: { id: instruction.entryId!, ownerId }, data: { challenged: true } });
        await this.recomputeFlags(tx, ownerId, instruction.entryId!);
        return { entryId: instruction.entryId!, revision: null };
      }
      case 'confirm': {
        // The owner looked at what a review mode applied and kept it (a spot check accepted): it is now
        // as trusted as a proposal they accepted. Only a live entry the machine wrote moves.
        await tx.wikiEntry.updateMany({
          where: { id: instruction.entryId!, ownerId, status: 'active', trust: { in: [...WIKI_MACHINE_TRUST] } },
          data: { trust: 'confirmed' },
        });
        await this.recomputeFlags(tx, ownerId, instruction.entryId!);
        return { entryId: instruction.entryId!, revision: null };
      }
      case 'reject': {
        // A proposal, or a live entry a review mode applied that nobody has confirmed (contract
        // `states.entry`: active -> rejected). Anything the owner wrote or confirmed is retired instead,
        // never rejected, so the predicate is what keeps this from reaching it.
        await tx.wikiEntry.updateMany({
          where: {
            id: instruction.entryId!,
            ownerId,
            OR: [{ status: 'proposed' }, { status: 'active', trust: { in: [...WIKI_MACHINE_TRUST] } }],
          },
          data: { status: 'rejected', trust: 'proposed', retiredAt: now, validTo: now },
        });
        await withdrawPendingOps(instruction.entryId!);
        await this.recomputeFlags(tx, ownerId, instruction.entryId!);
        return { entryId: instruction.entryId!, revision: null };
      }
    }
  }

  /**
   * The entry's derived flags, recomputed from what is now true of it.
   *
   * `challenged`: an unanswered challenge is open, and answers on the decision itself — a challenge
   * that applies at once is recorded pending (the effect is immediate, the ANSWER is the owner's), so
   * the flag stands until they decide it.
   *
   * `unsupported`: a confirmed entry that every live source has left (design §9, Delete means forget).
   * What the owner wrote is never marked — an owner's entry is not supported by quotes it did not take.
   */
  private async recomputeFlags(tx: Tx, ownerId: string, entryId: string): Promise<void> {
    const entry = await tx.wikiEntry.findFirst({
      where: { id: entryId, ownerId },
      select: { id: true, trust: true, status: true, currentRevision: true },
    });
    if (!entry) return;
    const revision = await tx.wikiEntryRevision.findFirst({
      where: { entryId, ownerId, revision: entry.currentRevision },
      select: { id: true },
    });
    const liveSources = revision
      ? await tx.wikiSource.count({ where: { revisionId: revision.id, ownerId, state: 'live' } })
      : 0;
    const openChallenge = await tx.wikiChangesetOp.count({
      where: { entryId, ownerId, op: 'challenge', decision: 'pending' },
    });
    const unsupported = entry.trust !== 'owner' && entry.trust !== 'proposed' && liveSources === 0;
    const challenged = entry.status === 'active' && openChallenge > 0;
    await tx.wikiEntry.updateMany({
      where: { id: entryId, ownerId },
      data: { unsupported, challenged },
    });
  }

  /**
   * One revision row. `wiki_entry_revision` is append-only: a change never rewrites a revision, it adds
   * one (`storage.appendOnly`).
   */
  private async insertRevision(
    tx: Tx,
    ownerId: string,
    entryId: string,
    revision: number,
    content: PreparedDraft,
    sources: readonly ResolvedSource[],
    author: WikiAuthor,
  ): Promise<string> {
    const row = await tx.wikiEntryRevision.create({
      data: {
        entryId,
        ownerId,
        revision,
        title: content.title,
        summary: content.summary,
        fields: content.fields as Prisma.InputJsonValue,
        topics: content.topics,
        aliases: content.aliases,
        anchors: content.anchors as unknown as Prisma.InputJsonValue,
        contentSha256: contentSha256(content),
        authorKind: author.authorKind,
        authorUserId: author.authorUserId,
        authorSessionId: author.authorSessionId,
        authorToolCallId: author.authorToolCallId,
        changesetOpId: author.changesetOpId,
      },
      select: { id: true },
    });
    await this.insertSources(tx, ownerId, row.id, sources);
    return row.id;
  }

  /** The quotes a revision rests on. A source is a first-hand record; a wiki entry never is. */
  private async insertSources(
    tx: Tx,
    ownerId: string,
    revisionId: string,
    sources: readonly ResolvedSource[],
  ): Promise<void> {
    if (sources.length === 0) return;
    await tx.wikiSource.createMany({
      data: sources.map((source) => ({
        revisionId,
        ownerId,
        kind: source.kind,
        ref: source.ref,
        locator: source.locator,
        quote: source.quote,
        quoteSha256: source.quote === null ? null : sha256(source.quote),
        quoteVerified: source.quoteVerified,
        state: 'live',
        tainted: source.tainted,
      })),
    });
  }

  // ── Sources (§4.3) ────────────────────────────────────────────────────────────────────────────

  /**
   * Resolve every source among the owner's own rows, and check every quote against the text of the
   * record it names.
   *
   * A quote is compared whitespace-normalized, so a line break the model wrapped is not a mismatch. A
   * record whose text this database does not hold — a turn of the calling session that has not been
   * stored yet, a commit the apiserver never sees — keeps its quote unverified, and the review card
   * says so (§4.3).
   */
  private async resolveSources(
    tx: Tx,
    principal: WikiPrincipal,
    sources: unknown[],
    options: { required: boolean },
  ): Promise<{ resolved: ResolvedSource[] }> {
    if (sources.length === 0) {
      if (options.required) {
        return refuse(
          'WIKI_SOURCE_UNRESOLVED',
          'a claim you cannot cite is not ready: name the turns, tool calls or records this came from',
        );
      }
      return { resolved: [] };
    }
    const resolved: ResolvedSource[] = [];
    for (const [index, raw] of sources.entries()) {
      const source = raw as {
        kind: WikiSourceKind;
        ref?: string;
        session?: 'self';
        seq?: number;
        locator?: Record<string, unknown>;
        quote?: string;
      };
      const found = await this.sourceText(tx, principal, source);
      if (found === null) {
        return refuse(
          'WIKI_SOURCE_UNRESOLVED',
          `sources[${index}] does not resolve among this account's own records: ${String(source.kind)} `
            + `${source.ref ?? '(the calling session)'} is not one of them`,
        );
      }
      const quote = source.quote ?? null;
      let verified = false;
      if (quote !== null) {
        if (found.text === null) {
          // Real, but its text is not this database's to read: the calling session's current turn may not
          // be stored yet, and a commit's contents never are. The quote is kept and marked unverified.
          verified = false;
        } else if (!quoteHolds(found.text, quote)) {
          return refuse(
            'WIKI_QUOTE_NOT_FOUND',
            `sources[${index}].quote is not in the record it cites: quote the record's own words, or leave the quote out`,
          );
        } else {
          verified = true;
        }
      }
      resolved.push({
        kind: source.kind,
        ref: found.ref,
        locator: (source.locator ?? found.locator ?? {}) as Prisma.InputJsonValue,
        quote,
        quoteVerified: verified,
        tainted: found.tainted,
        ownerWords: found.ownerWords,
        sessionId: found.sessionId,
      });
    }
    return { resolved };
  }

  /**
   * The record one source names, and its text where this database holds one.
   *
   * The set is the first-hand records a phase-1 door can reach: a conversation turn (the calling
   * session's own, or one named by id), a run event, a tool call, a task, a task comment, an approval,
   * and a commit resolved through the merge receipt that named it — and the two a maintenance run's
   * dossier cites besides (contract `maintenance.dossier.sources`): a merge receipt itself, and an
   * owner decision, a blocker the owner resolved with a note. Everything else the contract lists
   * belongs to a phase that does not write yet — a `note` has no row, and a `url` is an assumption's,
   * which phase 1 refuses.
   */
  private async sourceText(
    tx: Tx,
    principal: WikiPrincipal,
    source: { kind: WikiSourceKind; ref?: string; session?: 'self'; seq?: number },
  ): Promise<{
    ref: string;
    text: string | null;
    locator?: Record<string, unknown>;
    tainted: boolean;
    ownerWords: boolean;
    sessionId: string | null;
  } | null> {
    if (!(WIKI_SOURCE_KINDS as readonly string[]).includes(source.kind)) return null;
    const ownerScoped = { session: { ownerId: principal.ownerId } };
    const ref = source.ref === undefined ? undefined : refAsUuid(source.ref);
    /** What tells the owner's own turn from anybody else's (`isOwnerTurn`). */
    const turnAuthor = { kind: true, sendIntent: true, clientTurnId: true } as const;
    switch (source.kind) {
      case 'turn': {
        if (source.session === 'self') {
          if (!principal.sessionId) return null;
          const turn = await tx.conversationTurn.findFirst({
            where: { sessionId: principal.sessionId, ...(source.seq === undefined ? {} : { seq: source.seq }) },
            orderBy: { seq: 'desc' },
            select: { id: true, content: true, seq: true, ...turnAuthor },
          });
          return {
            ref: principal.sessionId,
            text: turn?.content ?? null,
            locator: { seq: source.seq ?? turn?.seq ?? null, ...(turn ? { turnId: turn.id } : {}) },
            tainted: false,
            ownerWords: turn ? isOwnerTurn(turn) : false,
            sessionId: principal.sessionId,
          };
        }
        if (!ref) return null;
        const turn = await tx.conversationTurn.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, content: true, sessionId: true, ...turnAuthor },
        });
        if (!turn) return null;
        return {
          ref: turn.id,
          text: turn.content ?? '',
          tainted: await this.sessionWasTainted(tx, turn.sessionId),
          ownerWords: isOwnerTurn(turn),
          sessionId: turn.sessionId,
        };
      }
      case 'event': {
        if (!ref) return null;
        const event = await tx.runEvent.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, type: true, payload: true, sessionId: true },
        });
        if (!event) return null;
        return {
          ref: event.id,
          text: eventText(event.type, event.payload),
          tainted: await this.sessionWasTainted(tx, event.sessionId),
          ownerWords: false,
          sessionId: event.sessionId,
        };
      }
      case 'tool_call': {
        if (!ref) return null;
        const call = await tx.toolCall.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, output: true, sessionId: true },
        });
        if (!call) return null;
        return {
          ref: call.id,
          text: call.output === null ? null : asText(call.output),
          tainted: false,
          ownerWords: false,
          sessionId: call.sessionId,
        };
      }
      case 'task': {
        if (!ref) return null;
        const task = await tx.task.findFirst({
          where: { id: ref, ownerId: principal.ownerId },
          select: { id: true, title: true, description: true },
        });
        if (!task) return null;
        return { ref: task.id, text: `${task.title}\n${task.description ?? ''}`, tainted: false, ownerWords: false, sessionId: null };
      }
      case 'task_comment': {
        if (!ref) return null;
        const comment = await tx.taskComment.findFirst({
          where: { id: ref, task: { ownerId: principal.ownerId } },
          select: { id: true, body: true },
        });
        if (!comment) return null;
        return { ref: comment.id, text: comment.body, tainted: false, ownerWords: false, sessionId: null };
      }
      case 'approval': {
        if (!ref) return null;
        const approval = await tx.approval.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, answers: true, message: true, sessionId: true, toolName: true, status: true, decidedById: true },
        });
        if (!approval) return null;
        const text = [approval.answers === null ? '' : asText(approval.answers), approval.message ?? ''].join('\n');
        return {
          ref: approval.id,
          text,
          tainted: await this.sessionWasTainted(tx, approval.sessionId),
          ownerWords: isOwnerAnswer(approval),
          sessionId: approval.sessionId,
        };
      }
      case 'merge_receipt': {
        // A merge receipt, as a dossier line shows it (`mergeReceiptText`): what was merged where, by sha.
        if (!ref) return null;
        const receipt = await tx.sessionMergeReceipt.findFirst({
          where: { id: ref, ownerId: principal.ownerId },
          select: { id: true, result: true, sourceBranch: true, sourceSha: true, targetBranch: true, targetShaAfter: true, sessionId: true },
        });
        if (!receipt) return null;
        return { ref: receipt.id, text: mergeReceiptText(receipt), tainted: false, ownerWords: false, sessionId: receipt.sessionId };
      }
      case 'owner_decision': {
        // A decision the owner recorded: a blocker the owner resolved with a note, what it asked and what
        // they answered, as a dossier line carries them. Not the owner's words for Tiered, whose
        // `ownerWords` is a message, a steer or an answer and nothing else.
        if (!ref) return null;
        const blocker = await tx.projectBlocker.findFirst({
          where: { id: ref, project: { ownerId: principal.ownerId }, resolvedBy: 'USER', resolutionNote: { not: null } },
          select: { id: true, requiredAction: true, resolutionNote: true },
        });
        if (!blocker || !blocker.resolutionNote) return null;
        return {
          ref: blocker.id,
          text: ownerResolutionText({ requiredAction: blocker.requiredAction, resolutionNote: blocker.resolutionNote }),
          tainted: false,
          ownerWords: false,
          sessionId: null,
        };
      }
      case 'commit': {
        if (!ref) return null;
        // The repository is not this database's to read, so a commit resolves through the record that
        // named it: a merge receipt of this owner's that carried that sha.
        const receipt = await tx.sessionMergeReceipt.findFirst({
          where: {
            ownerId: principal.ownerId,
            OR: [{ sourceSha: ref }, { targetShaAfter: ref }],
          },
          select: { id: true },
        });
        if (!receipt) return null;
        return { ref, text: null, tainted: false, ownerWords: false, sessionId: null };
      }
      default:
        return null;
    }
  }

  /** Was this session reading the web? A tool call that fetched or searched is the mark (§4.1 step 9). */
  private async sessionWasTainted(tx: Tx, sessionId: string): Promise<boolean> {
    const call = await tx.toolCall.findFirst({
      where: { sessionId, name: { in: ['WebFetch', 'WebSearch', 'webSearch'] } },
      select: { id: true },
    });
    return call !== null;
  }

  /**
   * Is this op tainted? The calling session read the web before it, or a record it cites came from a
   * session that had (contract `effectPolicy.taintedRule`).
   */
  private async isTainted(tx: Tx, principal: WikiPrincipal, sources: readonly ResolvedSource[]): Promise<boolean> {
    if (principal.sessionId && (await this.sessionWasTainted(tx, principal.sessionId))) return true;
    return sources.some((source) => source.tainted);
  }

  /**
   * The owner's own `workspace.env` values, replaced literally wherever they appear (§10.2).
   *
   * Read as a flat list of strings: an environment value is the one secret no shape can recognize, and
   * a quote may repeat one without ever looking like a credential.
   */
  private async envLiterals(reader: Pick<PrismaService, 'workspace'>, ownerId: string): Promise<string[]> {
    const workspaces = await reader.workspace.findMany({ where: { ownerId }, select: { env: true } });
    const literals: string[] = [];
    for (const workspace of workspaces) {
      const env = workspace.env;
      if (env === null || typeof env !== 'object' || Array.isArray(env)) continue;
      for (const value of Object.values(env as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim() !== '') literals.push(value);
      }
    }
    return literals;
  }

  // ── Similarity and lookups ────────────────────────────────────────────────────────────────────

  /**
   * The nearest neighbours of a proposed entry, for the agent and for the review card.
   *
   * pg_trgm over the same expression the trigram index is built on, so the query reaches the index. It
   * NEVER refuses (§4.1 step 8): a similarity score cannot tell "the same claim" from "the same words",
   * and a neighbour that was rejected is listed with the reason it was rejected, as a counter-example.
   */
  private async nearNeighbours(
    tx: Tx,
    ownerId: string,
    spaceId: string,
    draft: Record<string, unknown>,
    exclude: string | null,
  ): Promise<WikiSimilar[]> {
    const title = typeof draft.title === 'string' ? draft.title : '';
    const summary = typeof draft.summary === 'string' ? draft.summary : '';
    const text = `${title} ${summary}`.trim();
    if (text === '') return [];
    // The five first, and a rejection's reason only for them: the reason is a lookup per row, and it
    // belongs to what is returned, not to every entry the trigram index lets through to its recheck.
    //
    // The draft's text reaches the planner as an InitPlan's output, `(SELECT $n::text)`, rather than
    // as a constant. Given a constant, the planner prices `%` by running it against every value in
    // the index expression's statistics — a hundred and more trigram extractions, 10–30 ms of
    // planning per op on production — to arrive at the plan it chooses anyway once migration 0313
    // has priced the test: the trigram index.
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        kind: string;
        title: string;
        status: string;
        trust: string;
        score: number;
        rejectedReason: string | null;
      }>
    >(Prisma.sql`
      SELECT n."id" AS "id",
             n."kind" AS "kind",
             n."title" AS "title",
             n."status" AS "status",
             n."trust" AS "trust",
             n."score" AS "score",
             (SELECT o."decision_reason"
                FROM "wiki_changeset_op" o
               WHERE o."result_entry_id" = n."id" AND o."decision" = 'rejected'
               ORDER BY o."decided_at" DESC NULLS LAST
               LIMIT 1) AS "rejectedReason"
        FROM (
          SELECT e."id", e."kind", e."title", e."status", e."trust", e."recorded_at" AS "recordedAt",
                 similarity(wiki_entry_search_text(e."title", e."summary", e."aliases", e."fields"), (SELECT ${text}::text))::float8 AS "score"
            FROM "wiki_entry" e
           WHERE e."owner_id" = ${ownerId}::uuid
             AND e."space_id" = ${spaceId}::uuid
             AND (${exclude}::uuid IS NULL OR e."id" <> ${exclude}::uuid)
             AND wiki_entry_search_text(e."title", e."summary", e."aliases", e."fields") % (SELECT ${text}::text)
           ORDER BY "score" DESC, e."recorded_at" DESC
           LIMIT 5
        ) n
       ORDER BY n."score" DESC, n."recordedAt" DESC
    `);
    // A neighbour a verification rejected says why in the verifier's own words as well (contract
    // `reviewModes.verification.verdicts.unsupported`): read beside the query above rather than inside
    // it, over the few rows it returned, so what it costs does not grow with the space.
    const because = new Map<string, string>();
    const rejected = rows.filter((row) => row.rejectedReason !== null).map((row) => row.id);
    if (rejected.length > 0) {
      // Only a verdict that rejected it: an op its verification found supported, which the owner then
      // rejected, carries the verifier's reason for the opposite answer.
      const verdicts = await tx.wikiChangesetOp.findMany({
        where: {
          ownerId,
          resultEntryId: { in: rejected },
          decision: 'rejected',
          verificationVerdict: { in: ['unsupported', 'duplicate'] },
        },
        orderBy: { decidedAt: 'desc' },
        select: { resultEntryId: true, verificationReason: true },
      });
      for (const verdict of verdicts) {
        if (verdict.resultEntryId && verdict.verificationReason && !because.has(verdict.resultEntryId)) {
          because.set(verdict.resultEntryId, verdict.verificationReason);
        }
      }
    }
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as WikiEntryKind,
      title: row.title,
      status: row.status as WikiEntryStatus,
      trust: row.trust as WikiTrust,
      score: Number(row.score),
      ...(row.rejectedReason ? { rejectedReason: row.rejectedReason as WikiRejectReason } : {}),
      ...(because.has(row.id) ? { rejectedBecause: because.get(row.id) } : {}),
    }));
  }

  /** A revision's live sources, as the revision that puts its content back cites them again. */
  private async sourcesOfRevision(tx: Tx, ownerId: string, revisionId: string): Promise<ResolvedSource[]> {
    const rows = await tx.wikiSource.findMany({
      where: { revisionId, ownerId, state: 'live' },
      orderBy: { createdAt: 'asc' },
      select: { kind: true, ref: true, locator: true, quote: true, quoteVerified: true, tainted: true },
    });
    return rows.map((row) => ({
      kind: row.kind as WikiSourceKind,
      ref: row.ref,
      locator: row.locator as Prisma.InputJsonValue,
      quote: row.quote,
      quoteVerified: row.quoteVerified,
      tainted: row.tainted,
      ownerWords: false,
      sessionId: null,
    }));
  }

  /** The sources of an op being applied at decide time, resolved against the session that proposed it. */
  private async sourcesOfOp(
    tx: Tx,
    ownerId: string,
    sessionId: string | null,
    payload: Record<string, unknown>,
  ): Promise<ResolvedSource[]> {
    const raw = rawOpSources(payload);
    if (raw.length === 0) return [];
    const principal: WikiPrincipal = { origin: 'agent', ownerId, userId: null, sessionId, toolCallId: null };
    const { resolved } = await this.resolveSources(tx, principal, raw, { required: false });
    return resolved;
  }

  /**
   * What the review mode's floor needs to know of an amend's entry (contract
   * `reviewModes.floors.ownerVouchedWaits`): whether the owner wrote or confirmed it — its trust, or
   * any revision of it the owner authored — and whether it is live with the machine's trust, which is
   * all a mode ever amends.
   */
  private async reviewTarget(
    tx: Tx,
    ownerId: string,
    target: EntryRow,
  ): Promise<{ ownerVouched: boolean; machineWritten: boolean }> {
    const machineWritten = target.status === 'active' && WIKI_MACHINE_TRUST.includes(target.trust as WikiTrust);
    if (target.trust === 'owner' || target.trust === 'confirmed') return { ownerVouched: true, machineWritten };
    const ownerRevisions = await tx.wikiEntryRevision.count({ where: { entryId: target.id, ownerId, authorKind: 'owner' } });
    return { ownerVouched: ownerRevisions > 0, machineWritten };
  }

  /** One of the owner's entries in this space, or a plain 404 (§10.1). */
  private async ownEntry(tx: Tx, ownerId: string, spaceId: string, entryId: string): Promise<EntryRow> {
    const entry = await tx.wikiEntry.findFirst({ where: { id: entryId, ownerId, spaceId }, select: ENTRY_SELECT });
    if (!entry) throw new NotFoundException('no such wiki entry');
    return entry;
  }

  private async ownEntryById(tx: Tx, ownerId: string, entryId: string): Promise<EntryRow | null> {
    return tx.wikiEntry.findFirst({ where: { id: entryId, ownerId }, select: ENTRY_SELECT });
  }

  // ── Reads the two doors serve ─────────────────────────────────────────────────────────────────

  /**
   * One entry, with the sources of its current revision, its history, and who was shown it.
   *
   * `spaceId` is the runner door's read boundary: a session reads a space's entries only when its
   * workspace is bound to that space (contract `readBoundary`), and an entry of another codebase is
   * the same 404 as one that does not exist.
   */
  async getEntry(
    ownerId: string,
    entryId: string,
    include: { sources: boolean; history: boolean; exposure: boolean },
    spaceId?: string,
  ): Promise<Record<string, unknown>> {
    const entry = await this.prisma.wikiEntry.findFirst({
      where: { id: entryId, ownerId, ...(spaceId ? { spaceId } : {}) },
      select: ENTRY_SELECT,
    });
    if (!entry) throw new NotFoundException('no such wiki entry');
    const view: Record<string, unknown> = entryView(entry);
    if (include.sources) {
      const revision = await this.prisma.wikiEntryRevision.findFirst({
        where: { entryId, ownerId, revision: entry.currentRevision },
        select: { id: true },
      });
      const sources = revision
        ? await this.prisma.wikiSource.findMany({
            where: { revisionId: revision.id, ownerId },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              kind: true,
              ref: true,
              locator: true,
              quote: true,
              quoteVerified: true,
              state: true,
              tainted: true,
              createdAt: true,
            },
          })
        : [];
      view.sources = sources.map((source) => ({ ...source, createdAt: source.createdAt.toISOString() }));
    }
    if (include.history) {
      const revisions = await this.prisma.wikiEntryRevision.findMany({
        where: { entryId, ownerId },
        orderBy: { revision: 'desc' },
        select: {
          id: true,
          entryId: true,
          revision: true,
          title: true,
          summary: true,
          fields: true,
          topics: true,
          aliases: true,
          anchors: true,
          contentSha256: true,
          authorKind: true,
          authorUserId: true,
          authorSessionId: true,
          authorToolCallId: true,
          changesetOpId: true,
          createdAt: true,
        },
      });
      view.history = revisions.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    }
    if (include.exposure) {
      const exposure = await this.prisma.wikiExposure.findMany({
        where: { entryId, ownerId },
        orderBy: { at: 'desc' },
        take: 100,
        select: { sessionId: true, entryId: true, revision: true, channel: true, at: true },
      });
      view.exposure = exposure.map((row) => ({ ...row, at: row.at.toISOString() }));
    }
    return view;
  }

  /** A space's entries, newest first, filtered by what the page shows. */
  async listEntries(
    ownerId: string,
    spaceId: string,
    filter: { kind?: string; status?: string; limit?: number },
  ): Promise<Array<Record<string, unknown>>> {
    await this.requireSpace(ownerId, spaceId);
    const rows = await this.prisma.wikiEntry.findMany({
      where: {
        ownerId,
        spaceId,
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
      select: ENTRY_SELECT,
    });
    return rows.map(entryView);
  }

  /**
   * What waits for the owner: the pending ops of one space, or of every space. A changeset is pending
   * while any op of it waits for its verification too, and one that waits for nothing else is no
   * card of the owner's (contract `states.changeset.note`), so only a changeset holding an op that
   * waits for the owner is listed.
   */
  async listReview(ownerId: string, spaceId?: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.wikiChangeset.findMany({
      where: { ownerId, status: 'pending', ops: { some: { decision: 'pending' } }, ...(spaceId ? { spaceId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: CHANGESET_SELECT,
    });
    return rows.map(changesetView);
  }

  // ── The three reads the pages ask for (contract `agentSurface.doors.user.routes`) ─────────────

  /**
   * One topic's page: the entries that carry the slug, and the topic's own name when the space has one.
   *
   * THE TOPIC'S NAME IS DERIVED FROM THE SLUG, because nothing in phase 1 writes `wiki_topic`: an
   * entry names its topics by slug alone (`topicsMax` of them), so the slugs in use are the topics
   * that exist, and a row in `wiki_topic` — when phase 2's maintenance run writes one — is what a
   * space has SAID about one of them. `title` therefore prefers the row and falls back to the slug
   * read as words, and `declared` says which of the two the caller got, so a page can show the name
   * it has without pretending the owner chose it.
   *
   * A topic nothing carries is a 404 rather than an empty page: `/wiki/orbit/t/typo` is a link
   * somebody followed, and an empty topic page reads as "this topic has no entries" instead.
   */
  async getTopicView(ownerId: string, spaceId: string, slug: string): Promise<Record<string, unknown>> {
    await this.requireSpace(ownerId, spaceId);
    const entries = await this.prisma.wikiEntry.findMany({
      where: { ownerId, spaceId, topics: { has: slug } },
      orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
      take: 200,
      select: ENTRY_SELECT,
    });
    const declared = await this.prisma.wikiTopic.findFirst({
      where: { ownerId, spaceId, slug },
      select: { title: true, description: true, pathPrefixes: true },
    });
    if (entries.length === 0 && !declared) throw new NotFoundException('no such wiki topic');
    return {
      slug,
      title: declared?.title ?? topicTitleFromSlug(slug),
      description: declared?.description ?? null,
      declared: declared !== null,
      entryCount: entries.length,
      entries: entries.map(entryView),
    };
  }

  /**
   * What changed in this space lately, newest first — the home page's timeline.
   *
   * ONE ROW PER RECORDED OP, which is the only ledger of a change this store keeps: `applyOp` writes
   * a revision for an add or an amend and nothing at all for a retire, a supersede, a reinforce or a
   * challenge, so a feed built from `wiki_entry_revision` would silently omit every retirement in the
   * space. The op row is written for every recorded change whatever its kind, and `decided_at` is
   * when it took effect.
   *
   * NOT `submitChangeset`'s `created_at`: an op that waited in Review for a day changed the wiki when
   * the owner answered it, not when a session proposed it.
   *
   * What is left out is what changed nothing: a pending op (Review shows it, and it may never apply),
   * a rejected one, an expired one, and one withdrawn behind an entry that left active.
   *
   * AN OP A REVIEW MODE APPLIED changed the wiki when it was recorded, so it is dated by its
   * changeset — or, when a verdict applied it, by the verdict — and it is listed while it waits as a
   * spot check too: its effect already stands, and a timeline that dropped every tenth such change
   * until the owner answered its card would be wrong about what the wiki holds. An op still waiting
   * for its verdict changed nothing yet, and is left out like any other pending one.
   */
  async getTimeline(ownerId: string, spaceId: string, limit = 20): Promise<Record<string, unknown>> {
    await this.requireSpace(ownerId, spaceId);
    const rows = await this.prisma.$queryRaw<
      Array<{
        opId: string;
        op: string;
        decision: string;
        origin: string;
        appliedByMode: string | null;
        spotCheck: boolean;
        at: Date;
        entryId: string | null;
        title: string | null;
        kind: string | null;
        status: string | null;
        trust: string | null;
        supersededById: string | null;
        supersededByTitle: string | null;
        reason: string | null;
      }>
    >(Prisma.sql`
      SELECT o."id" AS "opId",
             o."op" AS "op",
             o."decision" AS "decision",
             c."origin" AS "origin",
             o."applied_by_mode" AS "appliedByMode",
             o."spot_check" AS "spotCheck",
             CASE WHEN o."applied_by_mode" IS NULL THEN o."decided_at" ELSE COALESCE(o."verified_at", c."created_at") END AS "at",
             e."id" AS "entryId",
             e."title" AS "title",
             e."kind" AS "kind",
             e."status" AS "status",
             e."trust" AS "trust",
             e."superseded_by_id" AS "supersededById",
             successor."title" AS "supersededByTitle",
             o."payload"->>'reason' AS "reason"
        FROM "wiki_changeset_op" o
        JOIN "wiki_changeset" c ON c."id" = o."changeset_id" AND c."owner_id" = o."owner_id"
        LEFT JOIN "wiki_entry" e
          ON e."id" = COALESCE(o."result_entry_id", o."entry_id") AND e."owner_id" = o."owner_id"
        LEFT JOIN "wiki_entry" successor
          ON successor."id" = e."superseded_by_id" AND successor."owner_id" = e."owner_id"
       WHERE o."owner_id" = ${ownerId}::uuid
         AND c."space_id" = ${spaceId}::uuid
         AND (
           (o."decision" IN ('accepted', 'edited', 'auto_applied') AND o."decided_at" IS NOT NULL)
           OR (o."spot_check" AND o."decision" = 'pending')
         )
       ORDER BY "at" DESC, o."id" DESC
       LIMIT ${Math.min(Math.max(limit, 1), 100)}::int
    `);
    return {
      items: rows.map((row) => ({
        opId: row.opId,
        op: row.op,
        decision: row.decision,
        origin: row.origin,
        appliedByMode: row.appliedByMode,
        spotCheck: row.spotCheck,
        at: row.at.toISOString(),
        entryId: row.entryId,
        title: row.title,
        kind: row.kind,
        status: row.status,
        trust: row.trust,
        supersededById: row.supersededById,
        supersededByTitle: row.supersededByTitle,
        reason: row.reason,
      })),
    };
  }

  /**
   * One space, with what the home page reads about its use when it asks for it.
   *
   * A QUERY PARAMETER ON THE ROUTE THAT ALREADY EXISTS rather than a route of its own: `usage` is
   * four aggregates over `wiki_exposure`, which the space document itself never pays for, and
   * `include` is the idiom `GET /wiki/entries/:id` already spells its optional reads with.
   *
   * THE WINDOW IS WHAT MAKES THE NUMBER SAY "this week" — the design's read is a rolling one, and the
   * exposure table is append-only, so an unwindowed count would be a lifetime total wearing a weekly
   * label.
   */
  async getSpaceView(ownerId: string, spaceId: string, include: { usage: boolean }): Promise<Record<string, unknown>> {
    const space = await this.requireSpace(ownerId, spaceId);
    if (!include.usage) return space;
    return { ...space, usage: await this.spaceUsage(ownerId, spaceId, WIKI_USAGE_WINDOW_DAYS) };
  }

  /** What the space's entries were read for in the last `days`. See {@link getSpaceView}. */
  private async spaceUsage(ownerId: string, spaceId: string, days: number): Promise<Record<string, unknown>> {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.prisma.wikiExposure.findMany({
      where: { ownerId, at: { gte: since }, entry: { spaceId } },
      select: { entryId: true, sessionId: true, channel: true },
    });
    const sessions = new Set<string>();
    const byEntry = new Map<string, { total: number; pushed: number; searched: number; fetched: number }>();
    let searches = 0;
    let gets = 0;
    for (const row of rows) {
      if (row.channel === 'search') searches += 1;
      if (row.channel === 'get') gets += 1;
      if (row.channel === 'push' && row.sessionId) sessions.add(row.sessionId);
      const entry = byEntry.get(row.entryId) ?? { total: 0, pushed: 0, searched: 0, fetched: 0 };
      entry.total += 1;
      if (row.channel === 'push') entry.pushed += 1;
      if (row.channel === 'search') entry.searched += 1;
      if (row.channel === 'get') entry.fetched += 1;
      byEntry.set(row.entryId, entry);
    }
    const ranked = [...byEntry].sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1)).slice(0, 50);
    const titles = await this.prisma.wikiEntry.findMany({
      where: { ownerId, id: { in: ranked.map(([id]) => id) } },
      select: { id: true, title: true },
    });
    const titleById = new Map(titles.map((entry) => [entry.id, entry.title]));
    return {
      days,
      sessionsPushed: sessions.size,
      searches,
      gets,
      entries: ranked.map(([entryId, counts]) => ({
        entryId,
        title: titleById.get(entryId) ?? null,
        ...counts,
      })),
    };
  }
}

// ── Shape checks (contract `refusals.WIKI_SCHEMA`) ──────────────────────────────────────────────

const OP_KEYS: Readonly<Record<WikiOp, readonly string[]>> = {
  add: ['op', 'entry', 'sources'],
  reinforce: ['op', 'entryId', 'sources'],
  amend: ['op', 'entryId', 'baseRevision', 'changes', 'sources'],
  supersede: ['op', 'entryId', 'baseRevision', 'entry', 'sources'],
  retire: ['op', 'entryId', 'baseRevision', 'reason', 'sources'],
  challenge: ['op', 'entryId', 'reason', 'sources'],
};

/** Every field that failed, named by path, exactly as the contract's WIKI_SCHEMA reports them. */
export function shapeErrors(raw: unknown, seq: number): WikiFieldError[] {
  const at = (path: string): string => `ops[${seq}].${path}`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ path: at(''), message: 'must be an object' }];
  }
  const op = raw as Record<string, unknown>;
  const name = op.op;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(OP_KEYS, name)) {
    return [{ path: at('op'), message: `must be one of ${Object.keys(OP_KEYS).join(', ')}` }];
  }
  const kind = name as WikiOp;
  const errors: WikiFieldError[] = [];
  for (const key of Object.keys(op)) {
    if (!OP_KEYS[kind].includes(key)) errors.push({ path: at(key), message: 'is not a field here' });
  }
  const requiredId = (): void => {
    if (typeof op.entryId !== 'string' || op.entryId.trim() === '') {
      errors.push({ path: at('entryId'), message: 'is required' });
    } else if (!isDecodableId(op.entryId)) {
      // Either spelling of a public id is taken, so anything else is a value no entry row could have.
      errors.push({ path: at('entryId'), message: 'names no entry: hand back the id this door gave you' });
    }
  };
  const requiredReason = (): void => {
    if (typeof op.reason !== 'string' || op.reason.trim() === '') {
      errors.push({ path: at('reason'), message: 'is required' });
    } else if (lengthOf(op.reason) > WIKI_LIMITS.fieldTextMaxChars) {
      errors.push({ path: at('reason'), message: `must be at most ${WIKI_LIMITS.fieldTextMaxChars} characters` });
    }
  };
  const requiredBase = (): void => {
    if (typeof op.baseRevision !== 'number' || !Number.isInteger(op.baseRevision) || op.baseRevision < 1) {
      errors.push({ path: at('baseRevision'), message: 'is required: the revision this was written against' });
    }
  };
  switch (kind) {
    case 'add':
      errors.push(...validateWikiEntryDraft(op.entry, at('entry')));
      break;
    case 'supersede':
      requiredId();
      requiredBase();
      errors.push(...validateWikiEntryDraft(op.entry, at('entry')));
      break;
    case 'amend': {
      requiredId();
      requiredBase();
      if (op.changes === null || op.changes === undefined) {
        errors.push({ path: at('changes'), message: 'is required' });
      } else if (typeof op.changes !== 'object' || Array.isArray(op.changes)) {
        errors.push({ path: at('changes'), message: 'must be an object' });
      } else {
        for (const key of Object.keys(op.changes as object)) {
          if (!['title', 'summary', 'fields', 'topics', 'aliases', 'anchors'].includes(key)) {
            errors.push({ path: at(`changes.${key}`), message: 'is not a field here' });
          }
        }
      }
      break;
    }
    case 'retire':
      requiredId();
      requiredBase();
      requiredReason();
      break;
    case 'challenge':
      requiredId();
      requiredReason();
      break;
    case 'reinforce':
      requiredId();
      if (!Array.isArray(op.sources) || op.sources.length === 0) {
        errors.push({ path: at('sources'), message: 'is required: a reinforce adds sources and nothing else' });
      }
      break;
  }
  if (op.sources !== undefined && op.sources !== null) {
    errors.push(...validateWikiSources(op.sources, at('sources')));
  }
  return errors;
}

/** The checks that need the entry's kind: what an amend may change, and whether it may change it at all. */
function amendErrors(kind: WikiEntryKind | null, op: WikiOp, raw: Record<string, unknown>): WikiFieldError[] {
  if (op !== 'amend') return [];
  if (kind === null) return [];
  if (!(kind in KIND_SPECS)) return [{ path: 'ops.entryId', message: 'this entry is not one a phase-1 door writes' }];
  const spec = KIND_SPECS[kind as WikiKind];
  if (!spec.amendable) return [{ path: 'ops.amend', message: `a ${kind} is only ever superseded, never rewritten` }];
  return validateWikiEntryChanges(raw.changes, kind as WikiKind, 'ops.changes');
}

/** Does this op have to cite a source? A non-owner claim that cannot be cited is not ready (§4.3). */
function requiresSource(op: WikiOp, principal: WikiPrincipal): boolean {
  if (principal.origin === 'owner') return false;
  return op === 'add' || op === 'amend' || op === 'supersede' || op === 'reinforce';
}

/**
 * Tiered's reading of what an add or an amend leaves (contract `reviewModes.tiered`), for
 * `wikiTieredBasis`.
 *
 * The owner's words count only with a verified quote. An add's anchors have never been checked; an
 * amend keeps its entry's last check only when it leaves the anchors alone. And a recipe's verify
 * command is re-run by a maintenance run that reports nothing back yet, so no recipe is
 * machine-verified until one does: that reading is `false`, stated here rather than left out, so the
 * report has one place to land.
 */
function tieredBasisOf(
  kind: WikiEntryKind,
  target: { anchorState: string } | null,
  changes: unknown,
  sources: readonly ResolvedSource[],
): WikiTieredBasis | null {
  const reanchored = changes !== null && typeof changes === 'object' && (changes as Record<string, unknown>).anchors !== undefined;
  return wikiTieredBasis({
    kind,
    ownerWords: sources.some((source) => source.ownerWords && source.quoteVerified),
    anchorState: target && !reanchored ? (target.anchorState as WikiAnchorState) : 'unchecked',
    sessions: new Set(sources.map((source) => source.sessionId).filter((id): id is string => id !== null)).size,
    recipeVerified: false,
  });
}

/**
 * Would applying this op pass the circuit breaker (contract `reviewModes.floors.circuitBreaker`)?
 *
 * What is counted is the distinct entries the mode changes in the changeset — every add is a new
 * one, an amend of an entry already changed here is not — against the active entries the space held
 * when the changeset began. Below `breakerMinActiveEntries` there is no breaker at all.
 */
function breakerTrips(budget: ChangesetBudget, amendedEntryId: string | null): boolean {
  if (amendedEntryId !== null && budget.changedByMode.has(amendedEntryId)) return false;
  if (budget.activeAtStart < WIKI_REVIEW_RULES.breakerMinActiveEntries) return false;
  return (budget.changedByMode.size + 1) * 100 > budget.activeAtStart * WIKI_REVIEW_RULES.breakerMaxChangedPercent;
}

/** The op's sources as submitted. */
function rawOpSources(op: Record<string, unknown>): unknown[] {
  return Array.isArray(op.sources) ? op.sources : [];
}

/**
 * The changesets a verification caller proposed (contract `reviewModes.verification.who`): a
 * session's own, or — for the one-off import, which has no session — the ones of its origin that
 * name none. Nothing else is found, so another caller's op is the same 404 as one that does not exist.
 */
function proposerScope(principal: WikiPrincipal): Prisma.WikiChangesetWhereInput {
  return principal.sessionId !== null
    ? { sessionId: principal.sessionId }
    : { sessionId: null, origin: principal.origin };
}

/**
 * One verdict, checked for the shape the contract gives it (`reviewModes.verification.report`) before
 * anything is read: a verdict the service cannot read is refused WIKI_SCHEMA, naming the field.
 */
function verdictInput(raw: unknown, index: number): VerdictInput {
  const at = (field: string): string => `verdicts[${index}].${field}`;
  const schema = (field: string, message: string): never => {
    throw new VerdictRefusal(400, `${at(field)} ${message}`, 'WIKI_SCHEMA');
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return schema('', 'must be an object');
  const value = raw as Record<string, unknown>;
  if (typeof value.opId !== 'string' || !isDecodableId(value.opId)) return schema('opId', 'names no op: hand back the opId the list gave');
  const verdict = value.verdict;
  if (typeof verdict !== 'string' || !(WIKI_VERIFICATION_VERDICTS as readonly string[]).includes(verdict)) {
    return schema('verdict', `must be one of ${WIKI_VERIFICATION_VERDICTS.join(', ')}`);
  }
  if (typeof value.reason !== 'string' || value.reason.trim() === '') return schema('reason', 'is required: the verifier\'s reason, in one sentence');
  if (lengthOf(value.reason.trim()) > WIKI_REVIEW_RULES.verificationReasonMaxChars) {
    return schema('reason', `must be at most ${WIKI_REVIEW_RULES.verificationReasonMaxChars} characters`);
  }
  if (typeof value.model !== 'string' || value.model.trim() === '') return schema('model', 'is required: the model that gave the verdict');
  if (lengthOf(value.model.trim()) > WIKI_REVIEW_RULES.verificationModelMaxChars) {
    return schema('model', `must be at most ${WIKI_REVIEW_RULES.verificationModelMaxChars} characters`);
  }
  const duplicateOf = value.duplicateOf;
  if (verdict === 'duplicate') {
    if (typeof duplicateOf !== 'string' || !isDecodableId(duplicateOf)) {
      return schema('duplicateOf', 'is required for a duplicate: the id of the entry it duplicates');
    }
  } else if (duplicateOf !== undefined && duplicateOf !== null) {
    return schema('duplicateOf', 'names what a duplicate duplicates, and this verdict is not one');
  }
  return {
    opId: value.opId,
    verdict: verdict as WikiVerificationVerdict,
    reason: value.reason,
    model: value.model,
    ...(verdict === 'duplicate' ? { duplicateOf: duplicateOf as string } : {}),
  };
}

/** What a verdict recorded earlier did, for its replay. */
function verdictStatus(verdict: WikiVerificationVerdict, decision: string): 'applied' | 'rejected' | 'reinforced' | 'conflict' {
  if (verdict === 'unsupported') return 'rejected';
  if (verdict === 'duplicate') return 'reinforced';
  return decision === 'conflict' ? 'conflict' : 'applied';
}

/** A text cut to at most `max` characters, counted the way the schema's CHECK counts them. */
function cutTo(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** An entry's content with nothing in it, for an amend whose entry could not be read. */
function emptyContent(): { title: string; summary: string; fields: unknown; topics: string[]; aliases: string[]; anchors: unknown } {
  return { title: '', summary: '', fields: {}, topics: [], aliases: [], anchors: [] };
}

/** Whether a value is an id this tree can decode — either spelling, and nothing else. */
function isDecodableId(value: string): boolean {
  try {
    toUuid(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A cited record's id, as a caller may have spelled it.
 *
 * The short form decodes; anything else is left exactly as it came, because a `commit` source names a
 * sha and not a row. A value left as it was simply resolves to nothing, which is the answer a source
 * that names no record of this account's gets.
 */
function refAsUuid(ref: string): string {
  try {
    return toUuid(ref);
  } catch {
    return ref;
  }
}

// ── Redaction (§10.2) ───────────────────────────────────────────────────────────────────────────

/**
 * A submission with every credential taken out of it: the shapes the shared redactor knows, and the
 * owner's own `workspace.env` values replaced wherever they appear verbatim. The fields it changed are
 * named, because the review card shows that the text is not quite what the agent wrote.
 */
export function redactOp(
  op: Record<string, unknown>,
  literals: readonly string[],
): { value: Record<string, unknown>; changed: boolean; fields: string[] } {
  const fields: string[] = [];
  const walk = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      const { text, redacted } = redactSecrets(value, { literals });
      if (redacted) fields.push(path);
      return text;
    }
    if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${path}[${index}]`));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(entry, path === '' ? key : `${path}.${key}`);
      }
      return out;
    }
    return value;
  };
  const value = walk(op, '') as Record<string, unknown>;
  return { value, changed: fields.length > 0, fields };
}

// ── The last few pieces ─────────────────────────────────────────────────────────────────────────

/** A draft as it is about to be written. */
function preparedDraft(entry: Record<string, unknown>): PreparedDraft {
  return {
    kind: draftKind(entry) as WikiKind,
    title: entry.title as string,
    summary: entry.summary as string,
    fields: entry.fields,
    topics: (entry.topics ?? []) as string[],
    aliases: (entry.aliases ?? []) as string[],
    anchors: (entry.anchors ?? []) as WikiAnchorInput[],
  };
}

/** A draft with a set of changes applied over it: each key given replaces that key, the rest carry over. */
function mergeDraft(entry: Record<string, unknown>, changes: WikiEntryChanges): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...entry };
  for (const key of ['title', 'summary', 'fields', 'topics', 'aliases', 'anchors'] as const) {
    if (changes?.[key] !== undefined) merged[key] = changes[key];
  }
  return merged;
}

/** The content an amend leaves in place: each key the changes give replaces that key whole. */
function mergeChanges(
  target: { title: string; summary: string; fields: unknown; topics: string[]; aliases: string[]; anchors: unknown },
  payload: Record<string, unknown>,
): Omit<PreparedDraft, 'kind'> {
  // Two shapes reach here and they are one thing: an amend, whose changes are under `changes`, and the
  // owner's edit in Review, which IS the changes (`effectPolicy.decide.edit`).
  const changes = ((payload.changes ?? payload) ?? {}) as WikiEntryChanges;
  return {
    title: (changes.title ?? target.title) as string,
    summary: (changes.summary ?? target.summary) as string,
    fields: changes.fields ?? target.fields,
    topics: (changes.topics ?? target.topics) as string[],
    aliases: (changes.aliases ?? target.aliases) as string[],
    anchors: (changes.anchors ?? target.anchors) as WikiAnchorInput[],
  };
}

/** The answer an out-of-date compare-and-set gets: the current revision, and a diff of the two. */
function revisionConflict(seq: number, current: EntryRow, baseRevision: number, payload: Record<string, unknown>): WikiOpOutcome {
  const now: WikiEntryChanges = {
    title: current.title,
    summary: current.summary,
    fields: current.fields as unknown as WikiEntryChanges['fields'],
    topics: current.topics,
    aliases: current.aliases,
    anchors: current.anchors as WikiAnchorInput[],
  };
  return {
    seq,
    status: 'conflict',
    entryId: current.id,
    baseRevision,
    currentRevision: current.currentRevision,
    current: now,
    diff: contentDiff(payload, now),
  };
}

/** What would change, one line per key. Enough for a caller to see it is not what it wrote against. */
function contentDiff(payload: Record<string, unknown>, current: WikiEntryChanges): string {
  // The keys the op wanted to change, read the way `mergeChanges` reads them: under `changes` for an
  // amend, and at the top level for the owner's edit in Review.
  const proposed = ((payload.changes ?? payload) ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of ['title', 'summary', 'fields', 'topics', 'aliases', 'anchors'] as const) {
    if (proposed[key] === undefined) continue;
    const from = JSON.stringify(proposed[key]);
    const to = JSON.stringify(current[key]);
    if (from !== to) lines.push(`- ${key}: ${from}\n+ ${key}: ${to}`);
  }
  return lines.join('\n');
}

/**
 * The outcome of an op recorded earlier, read back for an idempotent replay.
 *
 * An op the owner has since decided goes on saying what it did when it was recorded: an op that
 * applied then is `applied`, and one that waited was `pending` — the recorded answer of THAT request.
 * `decision` carries what the op has since become, for a client that wants to know; a client that
 * ignores it sees the answer it already had.
 */
function recordedOutcomes(changeset: ChangesetRow): WikiOpOutcome[] {
  return changeset.ops.map((op) => {
    const similar = op.similar as unknown as WikiSimilar[];
    const decided = op.decision === 'pending' ? undefined : op.decision;
    // An op an Automatic space sent to its verification was pending when it was recorded, waiting for
    // that and not for the owner — whatever its verdict has made of it since.
    if (op.decision === 'verifying' || op.verificationVerdict !== null) {
      return {
        seq: op.seq,
        status: 'pending',
        opId: op.id,
        entryId: op.resultEntryId ?? op.entryId,
        similar,
        waitsFor: 'verification',
        ...(op.decision === 'verifying' ? {} : { decision: op.decision }),
      } as WikiOpOutcome;
    }
    // An op a review mode applied was applied when it was recorded, a spot check's included, whatever
    // the owner has made of it since.
    const waited = op.appliedByMode === null
      && (op.decision === 'pending' || op.decision === 'rejected' || op.decision === 'expired' || op.decision === 'withdrawn' || op.decision === 'conflict');
    if (waited) {
      return { seq: op.seq, status: 'pending', opId: op.id, entryId: op.resultEntryId ?? op.entryId, similar, ...(decided ? { decision: decided } : {}) } as WikiOpOutcome;
    }
    return {
      seq: op.seq,
      status: 'applied',
      opId: op.id,
      entryId: op.resultEntryId ?? op.entryId,
      revision: op.resultRevision,
      similar,
      ...(decided ? { decision: decided } : {}),
    } as WikiOpOutcome;
  });
}
