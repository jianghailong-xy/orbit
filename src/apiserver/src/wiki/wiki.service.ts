import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  KIND_SPECS,
  WIKI_DEFAULT_SPACE_SETTINGS,
  WIKI_KINDS,
  WIKI_LIMITS,
  WIKI_REJECT_REASONS,
  WIKI_SOURCE_KINDS,
  validateWikiEntryChanges,
  validateWikiEntryDraft,
  validateWikiSources,
  toUuid,
  wikiOpEffect,
  type WikiAnchorInput,
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
  type WikiSimilar,
  type WikiSourceKind,
  type WikiTrust,
} from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { redactSecrets } from '../common/secret-redaction';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { canonicalRepoUrl } from '../projects/project-integration-line';
import { PrismaService } from '../prisma/prisma.service';

/** `Prisma.TransactionClient`, named once: every write below takes one, never the unmanaged client. */
type Tx = Prisma.TransactionClient;

/**
 * Orbit Wiki's ONE write entry point (design §4.1), and the reads its two doors serve.
 *
 * EVERYTHING THAT WRITES A WIKI ROW COMES THROUGH HERE. `submitChangeset` is what an agent's
 * proposal, the owner's own edit, a maintenance run and an import all reach; `decide` is the owner's
 * answer to what waits in Review. No other service writes `wiki_entry`.
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
 * WHAT THIS FILE DOES NOT DO YET, and who owns it: `GET /api/wiki/search` and the `wiki_search`
 * retrieval legs (T4), the `<orbit_wiki_context>` delivery (T6), the `wiki.changed` announcement
 * (T7), anchors' re-verification, which needs git on a runner (phase 2), and the review queue's
 * 14-day expiry sweep, which the contract gives an `expires_at` and no worker yet.
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
  /** The effect policy's answer (§4.2): does this op take effect before the owner sees it? */
  applied: boolean;
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
 * One thing to apply to an entry. `promote` and `reject` are not wiki ops: they are what the owner's
 * acceptance and refusal do to a proposal, and they go through `applyOp` for the one reason that
 * matters — the entry's status has exactly one writer.
 */
interface WikiApplyInstruction {
  op: WikiOp | 'promote' | 'reject';
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
   *  else — an agent's proposal the owner accepted, edited or not (contract `trust.onApply`). */
  promotedTrust?: WikiTrust;
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
    })),
  };
}

// ── The service ─────────────────────────────────────────────────────────────────────────────────

@Injectable()
export class WikiService {
  private readonly logger = new Logger(WikiService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      settings: { ...WIKI_DEFAULT_SPACE_SETTINGS, ...(space.settings as object) },
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
      settings: { ...WIKI_DEFAULT_SPACE_SETTINGS, ...(space.settings as object) },
      createdAt: space.createdAt.toISOString(),
      updatedAt: space.updatedAt.toISOString(),
    };
  }

  /** The two settings phase 1 reads: whether the space pushes, and whether a reinforce applies at once. */
  async updateSpace(
    ownerId: string,
    spaceId: string,
    input: { push?: boolean; autoAcceptReinforce?: boolean; title?: string },
  ) {
    const current = await this.requireSpace(ownerId, spaceId);
    const settings = { ...(current.settings as Record<string, unknown>) };
    if (input.push !== undefined) settings.push = input.push;
    if (input.autoAcceptReinforce !== undefined) settings.autoAcceptReinforce = input.autoAcceptReinforce;
    await this.prisma.wikiSpace.updateMany({
      where: { id: spaceId, ownerId },
      data: { settings: settings as Prisma.InputJsonValue, ...(input.title ? { title: input.title } : {}) },
    });
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
    return withTransactionRetry(
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
  ): Promise<Record<string, unknown>> {
    const dryRun = input.dryRun === true;
    const settings = { ...WIKI_DEFAULT_SPACE_SETTINGS, ...(space.settings as object) };
    const autoAcceptReinforce = settings.autoAcceptReinforce !== false;
    const sessionOps = principal.sessionId
      ? await tx.wikiChangesetOp.count({
          where: { ownerId: principal.ownerId, changeset: { sessionId: principal.sessionId } },
        })
      : 0;
    let pendingInSpace = await tx.wikiChangesetOp.count({
      where: { ownerId: principal.ownerId, decision: 'pending', changeset: { spaceId: space.id } },
    });
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
        if (seq >= WIKI_LIMITS.opsPerTurn || (principal.sessionId !== null && sessionOps + seq + 1 > WIKI_LIMITS.opsPerSession)) {
          return refuse(
            'WIKI_QUOTA',
            `a session records at most ${WIKI_LIMITS.opsPerTurn} ops in one turn and ${WIKI_LIMITS.opsPerSession} `
              + 'in its life: record the rest in another turn',
          );
        }
        const prepared = await this.prepareOp(tx, principal, space.id, seq, ops[seq], pendingInSpace, autoAcceptReinforce, literals);
        outcome = await this.recordOp(tx, principal, space.id, changesetId, seq, prepared, dryRun);
        // What keeps the changeset open is the OP's decision, not its outcome: a challenge takes effect
        // at once and still waits for the owner's answer.
        if (outcome.status === 'pending' || (outcome.status === 'applied' && prepared.waitsForOwner)) {
          pending += 1;
          pendingInSpace += 1;
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
    pendingInSpace: number,
    autoAcceptReinforce: boolean,
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

    // 7. Quota: what this op costs, and what the review queue already holds.
    const tainted = await this.isTainted(tx, principal, sources);
    const applied =
      wikiOpEffect({ origin: principal.origin, op: opName, tainted, autoAcceptReinforce }) === 'applied';
    // The taint is read before the queue is checked because a tainted op WAITS: a space at its cap must
    // not take in what the policy was going to apply, only for the mark to turn it into a queue entry.
    if (!applied && pendingInSpace >= WIKI_LIMITS.pendingOpsPerSpace) {
      return refuse(
        'WIKI_REVIEW_QUEUE_FULL',
        `this space already holds ${WIKI_LIMITS.pendingOpsPerSpace} ops waiting for review: the owner decides `
          + 'some of them before more can queue behind them',
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
      waitsForOwner: !applied || opName === 'challenge',
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
  ): Promise<WikiOpOutcome> {
    const similar = prepared.similar.length > 0 ? prepared.similar : undefined;
    // An add and a supersede write their lineage even when the owner has not accepted it yet: the entry
    // IS the proposal (`states.entry.born`), and Review, the neighbours and a later acceptance all read
    // it. A challenge writes its flag at once. Everything else waits, and applies when it is decided.
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
              decision: 'pending',
            },
            select: { id: true },
          })
        ).id;
    const author: WikiAuthor = {
      // An agent's proposal is authored by the session that made it; the owner's own write by the owner.
      authorKind: principal.origin === 'owner' ? 'owner' : 'agent',
      authorUserId: principal.origin === 'owner' ? principal.userId : null,
      authorSessionId: principal.sessionId,
      authorToolCallId: principal.toolCallId,
      changesetOpId: opRowId,
    };
    // A dry run takes the whole path and writes NOTHING — no op row, and no entry either, which is the
    // half that is easy to get wrong: an add that creates its lineage is a write like any other.
    const written = writesNow && !dryRun
      ? await this.applyOp(tx, principal.ownerId, spaceId, {
          op: prepared.op,
          entryId: prepared.entryId,
          draft: prepared.draft,
          changes: prepared.changes,
          payload: prepared.payload,
          sources: prepared.sources,
          tainted: prepared.tainted,
          proposed: !prepared.applied,
          promotedTrust: principal.origin === 'owner' ? 'owner' : 'confirmed',
        }, author)
      : null;
    if (opRowId) {
      await tx.wikiChangesetOp.updateMany({
        where: { id: opRowId, ownerId: principal.ownerId },
        data: {
          ...(prepared.waitsForOwner ? { decision: 'pending' } : { decision: 'auto_applied', decidedAt: new Date() }),
          ...(written ? { resultEntryId: written.entryId, resultRevision: written.revision } : {}),
        },
      });
    }
    const outcomeEntryId = written?.entryId ?? prepared.entryId;
    return prepared.applied
      ? { seq, status: 'applied', opId: opRowId, entryId: outcomeEntryId, revision: written?.revision ?? null, similar }
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
    return withTransactionRetry(
      this.prisma,
      async (tx) => {
        const changeset = await tx.wikiChangeset.findFirst({
          where: { id: changesetId, ownerId },
          select: CHANGESET_SELECT,
        });
        if (!changeset) throw new NotFoundException('no such changeset');
        for (const decision of decisions) {
          await this.applyDecision(tx, ownerId, userId, changeset, decision);
        }
        await this.settleChangeset(tx, ownerId, changesetId);
        const row = await tx.wikiChangeset.findFirstOrThrow({
          where: { id: changesetId, ownerId },
          select: CHANGESET_SELECT,
        });
        return changesetView(row);
      },
      loggedRetry(this.logger, 'wiki.decide'),
    );
  }

  /** One op's answer: what the owner decided, and what it applied. */
  private async applyDecision(
    tx: Tx,
    ownerId: string,
    userId: string,
    changeset: ChangesetRow,
    decision: WikiDecisionInput,
  ): Promise<void> {
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
      return;
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
        return;
      }
      const errors = validateWikiEntryChanges(edited, kind, 'changes');
      if (errors.length > 0) {
        return refuse('WIKI_SCHEMA', "the owner's edit does not have the shape this contract gives it", errors);
      }
    }
    // Compare-and-set at the moment it applies: the entry may have moved while the op waited.
    if ((opName === 'amend' || opName === 'supersede' || opName === 'retire') && op.entryId) {
      const target = await this.ownEntryById(tx, ownerId, op.entryId);
      if (!target) throw new NotFoundException('no such wiki entry');
      if (op.baseRevision !== target.currentRevision) {
        await this.writeOpDecision(tx, ownerId, op.id, { decision: 'conflict', decisionNote: null });
        return;
      }
    }
    const payload = editing ? (edited as Record<string, unknown>) : proposed;
    const sources = await this.sourcesOfOp(tx, ownerId, changeset.sessionId, payload);
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

  /** A changeset is settled once none of its ops is still waiting. */
  private async settleChangeset(tx: Tx, ownerId: string, changesetId: string): Promise<void> {
    const waiting = await tx.wikiChangesetOp.count({ where: { changesetId, ownerId, decision: 'pending' } });
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
    /** An entry that left active takes its unanswered ops with it: they can no longer apply. */
    const withdrawPendingOps = (entryId: string) =>
      tx.wikiChangesetOp.updateMany({
        where: { entryId, ownerId, decision: 'pending' },
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
      case 'reject': {
        await tx.wikiEntry.updateMany({
          where: { id: instruction.entryId!, ownerId, status: 'proposed' },
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
      });
    }
    return { resolved };
  }

  /**
   * The record one source names, and its text where this database holds one.
   *
   * The set is the first-hand records a phase-1 door can reach: a conversation turn (the calling
   * session's own, or one named by id), a run event, a tool call, a task, a task comment, an approval,
   * and a commit resolved through the merge receipt that named it. Everything else the contract lists
   * belongs to a phase that does not write yet — a `note` has no row, and a `url` is an assumption's,
   * which phase 1 refuses.
   */
  private async sourceText(
    tx: Tx,
    principal: WikiPrincipal,
    source: { kind: WikiSourceKind; ref?: string; session?: 'self'; seq?: number },
  ): Promise<{ ref: string; text: string | null; locator?: Record<string, unknown>; tainted: boolean } | null> {
    if (!(WIKI_SOURCE_KINDS as readonly string[]).includes(source.kind)) return null;
    const ownerScoped = { session: { ownerId: principal.ownerId } };
    const ref = source.ref === undefined ? undefined : refAsUuid(source.ref);
    switch (source.kind) {
      case 'turn': {
        if (source.session === 'self') {
          if (!principal.sessionId) return null;
          const turn = await tx.conversationTurn.findFirst({
            where: { sessionId: principal.sessionId, ...(source.seq === undefined ? {} : { seq: source.seq }) },
            orderBy: { seq: 'desc' },
            select: { id: true, content: true, seq: true },
          });
          return {
            ref: principal.sessionId,
            text: turn?.content ?? null,
            locator: { seq: source.seq ?? turn?.seq ?? null, ...(turn ? { turnId: turn.id } : {}) },
            tainted: false,
          };
        }
        if (!ref) return null;
        const turn = await tx.conversationTurn.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, content: true, sessionId: true },
        });
        if (!turn) return null;
        return { ref: turn.id, text: turn.content ?? '', tainted: await this.sessionWasTainted(tx, turn.sessionId) };
      }
      case 'event': {
        if (!ref) return null;
        const event = await tx.runEvent.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, type: true, payload: true, sessionId: true },
        });
        if (!event) return null;
        return { ref: event.id, text: eventText(event.type, event.payload), tainted: await this.sessionWasTainted(tx, event.sessionId) };
      }
      case 'tool_call': {
        if (!ref) return null;
        const call = await tx.toolCall.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, output: true },
        });
        if (!call) return null;
        return { ref: call.id, text: call.output === null ? null : asText(call.output), tainted: false };
      }
      case 'task': {
        if (!ref) return null;
        const task = await tx.task.findFirst({
          where: { id: ref, ownerId: principal.ownerId },
          select: { id: true, title: true, description: true },
        });
        if (!task) return null;
        return { ref: task.id, text: `${task.title}\n${task.description ?? ''}`, tainted: false };
      }
      case 'task_comment': {
        if (!ref) return null;
        const comment = await tx.taskComment.findFirst({
          where: { id: ref, task: { ownerId: principal.ownerId } },
          select: { id: true, body: true },
        });
        if (!comment) return null;
        return { ref: comment.id, text: comment.body, tainted: false };
      }
      case 'approval': {
        if (!ref) return null;
        const approval = await tx.approval.findFirst({
          where: { id: ref, ...ownerScoped },
          select: { id: true, answers: true, message: true, sessionId: true },
        });
        if (!approval) return null;
        const text = [approval.answers === null ? '' : asText(approval.answers), approval.message ?? ''].join('\n');
        return { ref: approval.id, text, tainted: await this.sessionWasTainted(tx, approval.sessionId) };
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
        return { ref, text: null, tainted: false };
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
      SELECT e."id" AS "id",
             e."kind" AS "kind",
             e."title" AS "title",
             e."status" AS "status",
             e."trust" AS "trust",
             similarity(wiki_entry_search_text(e."title", e."summary", e."aliases", e."fields"), ${text})::float8 AS "score",
             (SELECT o."decision_reason"
                FROM "wiki_changeset_op" o
               WHERE o."result_entry_id" = e."id" AND o."decision" = 'rejected'
               ORDER BY o."decided_at" DESC NULLS LAST
               LIMIT 1) AS "rejectedReason"
        FROM "wiki_entry" e
       WHERE e."owner_id" = ${ownerId}::uuid
         AND e."space_id" = ${spaceId}::uuid
         AND (${exclude}::uuid IS NULL OR e."id" <> ${exclude}::uuid)
         AND wiki_entry_search_text(e."title", e."summary", e."aliases", e."fields") % ${text}
       ORDER BY "score" DESC, e."recorded_at" DESC
       LIMIT 5
    `);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as WikiEntryKind,
      title: row.title,
      status: row.status as WikiEntryStatus,
      trust: row.trust as WikiTrust,
      score: Number(row.score),
      ...(row.rejectedReason ? { rejectedReason: row.rejectedReason as WikiRejectReason } : {}),
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

  /** What waits for the owner: the pending ops of one space, or of every space. */
  async listReview(ownerId: string, spaceId?: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.prisma.wikiChangeset.findMany({
      where: { ownerId, status: 'pending', ...(spaceId ? { spaceId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: CHANGESET_SELECT,
    });
    return rows.map(changesetView);
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

/** The op's sources as submitted. */
function rawOpSources(op: Record<string, unknown>): unknown[] {
  return Array.isArray(op.sources) ? op.sources : [];
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
    if (op.decision === 'pending' || op.decision === 'rejected' || op.decision === 'expired' || op.decision === 'withdrawn' || op.decision === 'conflict') {
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
