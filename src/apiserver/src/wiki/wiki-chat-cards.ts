import { Prisma } from '@prisma/client';
import {
  toUuid,
  uuidToBase62,
  WIKI_CHAT_NOTE_TAGS,
  wikiChatContextErrors,
  wikiChatDraftLabel,
  wikiChatDraftState,
  wikiChatDraftUndoable,
  wikiChatNoteAttribute,
  wikiChatResultLine,
  wikiChatRewrites,
  wikiChatWhere,
  type WikiChatCard,
  type WikiChatContext,
  type WikiChatDraftKind,
  type WikiChatDraftOp,
  type WikiChatDraftOpView,
  type WikiChatDraftRewriteView,
  type WikiChatDraftSectionView,
  type WikiChatDraftState,
  type WikiChatDraftView,
  type WikiChatSectionRef,
  type WikiSimilar,
} from '@orbit/shared';
import { OPEN_SESSION_STATUSES } from '../common/session-scheduling';
import type { PrismaService } from '../prisma/prisma.service';
import { readWikiDocsFollowRewrites, type WikiDocsFollowRewrite } from './wiki-docs-follow';
import { numbering, PLAN_SELECT, type PlanRow } from './wiki-docs';
import { anchorPathsOf, sectionFit, storedSessionCondition } from './wiki-docs-material';
import { ENTRY_SELECT, entryView } from './wiki.service';

/**
 * A wiki chat's cards as they are read (contracts/wiki.contract.json `chat.drafts`; docs/wiki-contract.md §28.5–§28.8):
 * what a card's state is, derived on read and never stored (`wikiChatDraftState`, design §3); what it offers; what its
 * rewrite is doing; the Rewrites worked out when it is drafted (design §8.2); and the note that tells the chat's agent,
 * with the owner's next message, what the owner pressed (`chat.notes.drafts`).
 *
 * Reads, and the one stamp the note writes (`told_at`), through whatever client it is handed — a press's transaction, a
 * delivery's, or the service's own — so a card reads the same wherever it is drawn: the panel, the full session page,
 * the phone, the round button's counts and the Wiki's waiting count.
 */

type Reader = Prisma.TransactionClient;

/** A card's columns, as every read below takes them. */
export const DRAFT_SELECT = {
  id: true,
  ownerId: true,
  spaceId: true,
  sessionId: true,
  kind: true,
  rationale: true,
  ops: true,
  sections: true,
  change: true,
  rewrites: true,
  tainted: true,
  replacesId: true,
  idempotencyKey: true,
  requestSha256: true,
  decision: true,
  decidedAt: true,
  changesetId: true,
  trustBefore: true,
  undoneAt: true,
  seenAt: true,
  toldAt: true,
  createdAt: true,
} satisfies Prisma.WikiChatDraftSelect;

export type DraftRow = Prisma.WikiChatDraftGetPayload<{ select: typeof DRAFT_SELECT }>;

/** One op as a card keeps it (`wiki_chat_draft.ops`). */
export interface StoredDraftOp {
  seq: number;
  op: WikiChatDraftOp['op'];
  entryId: string | null;
  baseRevision: number | null;
  payload: Record<string, unknown>;
  similar: WikiSimilar[];
  tainted: boolean;
}

export function storedOps(raw: unknown): StoredDraftOp[] {
  return Array.isArray(raw) ? (raw as StoredDraftOp[]) : [];
}

export function storedSections(raw: unknown): WikiChatSectionRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((one) => {
    const section = one as { doc?: unknown; key?: unknown };
    return typeof section.doc === 'string' && typeof section.key === 'string' ? [{ doc: section.doc, key: section.key }] : [];
  });
}

/** The label a card is drawn with after `Draft · ` (design §6, board 42 ②④). */
export function draftLabel(row: Pick<DraftRow, 'kind' | 'ops'>): string {
  return wikiChatDraftLabel(row.kind as WikiChatDraftKind, storedOps(row.ops).map((op) => ({
    op: op.op,
    kind: typeof (op.payload?.entry as { kind?: unknown } | undefined)?.kind === 'string' ? String((op.payload.entry as { kind: string }).kind) : undefined,
  })));
}

const sectionId = (doc: string, key: string): string => `${doc}\u0000${key}`;

// ── The facts a card's state is read from ──────────────────────────────────────────────────────

/** What `wikiChatDraftState` reads of a set of cards, beside their own columns: their chats, their successors, their bases. */
export interface DraftFacts {
  /** The chats that are open: one of OPEN_SESSION_STATUSES, and not in Trash. */
  openChats: ReadonlySet<string>;
  /** Each card a newer one replaced, with the newer one. */
  replacedBy: ReadonlyMap<string, string>;
  /** Each card whose base moved since it was drafted (contract `chat.drafts.states.changed`). */
  moved: ReadonlySet<string>;
}

/**
 * The facts of some cards (contract `chat.drafts.derivation`): whether each one's chat is open, whether a newer card of
 * the chat replaced it, and whether its base moved — an entry it changes left the revision it was drafted against or left
 * active, or a section it would rewrite was written since it was drafted. A base is only read for a card nobody pressed:
 * the press decides an applied or discarded card's state whatever moved after it.
 */
export async function draftFacts(db: Reader, ownerId: string, rows: readonly DraftRow[]): Promise<DraftFacts> {
  if (rows.length === 0) return { openChats: new Set(), replacedBy: new Map(), moved: new Set() };
  const chats = await db.session.findMany({
    where: { ownerId, id: { in: [...new Set(rows.map((row) => row.sessionId))] } },
    select: { id: true, status: true, deletedAt: true },
  });
  const openChats = new Set(chats.filter((chat) => chat.deletedAt === null && OPEN_SESSION_STATUSES.includes(chat.status)).map((chat) => chat.id));
  const successors = await db.wikiChatDraft.findMany({
    where: { ownerId, replacesId: { in: rows.map((row) => row.id) } },
    select: { id: true, replacesId: true },
  });
  const replacedBy = new Map(successors.map((successor) => [successor.replacesId!, successor.id]));

  const open = rows.filter((row) => row.decision === null && !replacedBy.has(row.id) && openChats.has(row.sessionId));
  const moved = new Set<string>();
  if (open.length > 0) {
    const entryIds = [...new Set(open.flatMap((row) => storedOps(row.ops).map((op) => op.entryId).filter((id): id is string => id !== null)))];
    const entries = entryIds.length === 0
      ? []
      : await db.wikiEntry.findMany({ where: { ownerId, id: { in: entryIds } }, select: { id: true, status: true, currentRevision: true } });
    const entryOf = new Map(entries.map((entry) => [entry.id, entry]));
    for (const row of open) {
      for (const op of storedOps(row.ops)) {
        if (op.entryId === null) continue;
        const entry = entryOf.get(op.entryId);
        if (!entry || entry.status !== 'active' || (op.baseRevision !== null && entry.currentRevision !== op.baseRevision)) moved.add(row.id);
      }
    }
    // A section it would rewrite, written since it was drafted: a section's own write (generated_at), or any write that
    // replaced what stood — a restore puts back an older generated_at, and keeps a version of what it replaced.
    const spaces = [...new Set(open.map((row) => row.spaceId))];
    for (const spaceId of spaces) {
      const ofSpace = open.filter((row) => row.spaceId === spaceId && !moved.has(row.id) && storedSections(row.rewrites).length > 0);
      if (ofSpace.length === 0) continue;
      const slugs = [...new Set(ofSpace.flatMap((row) => storedSections(row.rewrites).map((section) => section.doc)))];
      const written = await db.wikiDocSection.findMany({
        where: { ownerId, doc: { ownerId, spaceId, slug: { in: slugs } } },
        select: { key: true, generatedAt: true, doc: { select: { slug: true } } },
      });
      const versions = await db.wikiDocSectionVersion.groupBy({
        by: ['docSlug', 'sectionKey'],
        where: { ownerId, spaceId, docSlug: { in: slugs } },
        _max: { replacedAt: true },
      });
      const lastWrite = new Map<string, Date>();
      const later = (id: string, at: Date | null | undefined) => {
        if (!at) return;
        const before = lastWrite.get(id);
        if (!before || at > before) lastWrite.set(id, at);
      };
      for (const section of written) later(sectionId(section.doc.slug, section.key), section.generatedAt);
      for (const version of versions) later(sectionId(version.docSlug, version.sectionKey), version._max.replacedAt);
      for (const row of ofSpace) {
        if (storedSections(row.rewrites).some((section) => (lastWrite.get(sectionId(section.doc, section.key)) ?? new Date(0)) > row.createdAt)) {
          moved.add(row.id);
        }
      }
    }
  }
  return { openChats, replacedBy, moved };
}

/** A card's state (contract `chat.drafts.derivation`), from its own columns and its facts. */
export function draftStateOf(row: DraftRow, facts: DraftFacts): WikiChatDraftState {
  return wikiChatDraftState({
    decision: (row.decision as 'applied' | 'edited' | 'discarded' | null) ?? null,
    undone: row.undoneAt !== null,
    replaced: facts.replacedBy.has(row.id),
    chatOpen: facts.openChats.has(row.sessionId),
    baseMoved: facts.moved.has(row.id),
  });
}

// ── Where a section is, and what its rewrite is doing ───────────────────────────────────────────

/** The confirmed plan of a space, as the documents read numbers it; null with none. */
export async function confirmedPlanOf(db: Reader, ownerId: string, spaceId: string): Promise<PlanRow | null> {
  return db.wikiPlan.findFirst({ where: { ownerId, spaceId, status: 'confirmed' }, select: PLAN_SELECT });
}

/** "3.1 §3" and the section's title, as the confirmed plan numbers it; `slug §key` for a section it no longer has. */
export function sectionViews(plan: PlanRow | null, sections: readonly WikiChatSectionRef[]): WikiChatDraftSectionView[] {
  const numbers = plan ? numbering(plan) : new Map<string, { number: string }>();
  return sections.map((section) => {
    const doc = plan?.docs.find((one) => one.slug === section.doc);
    const index = doc ? doc.sections.findIndex((one) => one.key === section.key) : -1;
    if (!doc || index < 0) return { doc: section.doc, key: section.key, where: `${section.doc} §${section.key}`, title: null };
    return { doc: section.doc, key: section.key, where: wikiChatWhere(numbers.get(doc.slug)!.number, index + 1), title: doc.sections[index]!.title };
  });
}

/** An applied card's rewrite, as its follow job says it, with each section's place and whether the owner opened it. */
export function rewriteView(rewrite: WikiDocsFollowRewrite, plan: PlanRow | null, seen: boolean): WikiChatDraftRewriteView {
  const where = new Map(sectionViews(plan, rewrite.sections).map((view) => [sectionId(view.doc, view.key), view.where]));
  return {
    jobId: rewrite.jobId,
    result: rewrite.result,
    reason: rewrite.reason,
    sha: rewrite.sha,
    sections: rewrite.sections.map((section) => ({
      doc: section.doc,
      key: section.key,
      where: where.get(sectionId(section.doc, section.key)) ?? `${section.doc} §${section.key}`,
      result: section.result,
      changed: section.changed,
      versionId: section.versionId,
    })),
    seen,
    settledAt: rewrite.settledAt,
  };
}

/** The rewrites of the pressed cards among some, by card (contract `chat.drafts.results`); a card no job carried has none. */
export async function draftRewrites(
  db: Reader,
  ownerId: string,
  rows: readonly DraftRow[],
): Promise<Map<string, WikiDocsFollowRewrite>> {
  const out = new Map<string, WikiDocsFollowRewrite>();
  const pressed = rows.filter((row) => (row.decision === 'applied' || row.decision === 'edited') && storedSections(row.rewrites).length > 0);
  for (const spaceId of new Set(pressed.map((row) => row.spaceId))) {
    const ids = pressed.filter((row) => row.spaceId === spaceId).map((row) => row.id);
    // The follow's read takes the service's client and reads through model delegates and $queryRaw alone, which a
    // transaction's client has too: a press reads its card back inside its own transaction.
    const read = await readWikiDocsFollowRewrites(db as unknown as PrismaService, { ownerId, spaceId, draftIds: ids });
    for (const [id, rewrite] of read) out.set(id, rewrite);
  }
  return out;
}

/** A card as what it offers and what it counts are read from (`wikiChatCardActions`, `wikiChatFabCounts`, `wikiChatWaiting`). */
export function cardOf(row: DraftRow, state: WikiChatDraftState, rewrite: WikiDocsFollowRewrite | undefined, plan: PlanRow | null): WikiChatCard {
  const view = rewrite ? rewriteView(rewrite, plan, row.seenAt !== null) : null;
  return {
    kind: row.kind as WikiChatDraftKind,
    state,
    undoable: wikiChatDraftUndoable(row.kind as WikiChatDraftKind, state, storedOps(row.ops)),
    rewrite: view
      ? { result: view.result, reason: view.reason, sha: view.sha, seen: view.seen, sections: view.sections.map((s) => ({ where: s.where, result: s.result, ...(s.changed !== null ? { changed: s.changed } : {}) })) }
      : null,
  };
}

// ── The card read ──────────────────────────────────────────────────────────────────────────────

/**
 * Cards as the user door serves them (contract `chat.drafts.read`): the state from the derivation, the ops as checked
 * with each one's entry as it stands now — and, once pressed, its decision in the changeset the press recorded — the
 * Rewrites with each section's numbers and title, the neighbours the card's adds resemble, and an applied card's rewrite.
 * Reads only.
 */
export async function draftViews(db: Reader, ownerId: string, rows: readonly DraftRow[]): Promise<WikiChatDraftView[]> {
  if (rows.length === 0) return [];
  const facts = await draftFacts(db, ownerId, rows);
  const rewrites = await draftRewrites(db, ownerId, rows);
  const plans = new Map<string, PlanRow | null>();
  for (const spaceId of new Set(rows.map((row) => row.spaceId))) plans.set(spaceId, await confirmedPlanOf(db, ownerId, spaceId));
  const changesetIds = rows.map((row) => row.changesetId).filter((id): id is string => id !== null);
  const decided = changesetIds.length === 0
    ? []
    : await db.wikiChangesetOp.findMany({
      where: { ownerId, changesetId: { in: changesetIds } },
      select: { changesetId: true, seq: true, decision: true, resultEntryId: true },
    });
  const decisionOf = new Map(decided.map((op) => [`${op.changesetId}#${op.seq}`, op]));
  const entryIds = new Set<string>();
  for (const row of rows) {
    for (const op of storedOps(row.ops)) {
      if (op.entryId) entryIds.add(op.entryId);
      const result = row.changesetId ? decisionOf.get(`${row.changesetId}#${op.seq}`)?.resultEntryId : null;
      if (result) entryIds.add(result);
    }
  }
  const entries = entryIds.size === 0
    ? []
    : await db.wikiEntry.findMany({ where: { ownerId, id: { in: [...entryIds] } }, select: ENTRY_SELECT });
  const entryOf = new Map(entries.map((entry) => [entry.id, entry]));
  return rows.map((row) => {
    const state = draftStateOf(row, facts);
    const plan = plans.get(row.spaceId) ?? null;
    const ops: WikiChatDraftOpView[] = storedOps(row.ops).map((op) => {
      const recorded = row.changesetId ? decisionOf.get(`${row.changesetId}#${op.seq}`) : undefined;
      // An applied add or supersede is about the lineage it wrote; every other op about its target.
      const about = (op.op === 'add' || op.op === 'supersede') && recorded?.resultEntryId ? recorded.resultEntryId : op.entryId;
      const entry = about ? entryOf.get(about) : undefined;
      return {
        seq: op.seq,
        op: op.op,
        entryId: about,
        baseRevision: op.baseRevision,
        payload: op.payload,
        similar: op.similar ?? [],
        tainted: op.tainted === true,
        entry: entry ? entryView(entry) : null,
        decision: recorded?.decision ?? null,
      };
    });
    const similar = new Map<string, WikiSimilar>();
    for (const op of storedOps(row.ops)) {
      for (const neighbour of op.similar ?? []) {
        const before = similar.get(neighbour.id);
        if (!before || neighbour.score > before.score) similar.set(neighbour.id, neighbour);
      }
    }
    const rewrite = rewrites.get(row.id);
    return {
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind as WikiChatDraftKind,
      state,
      label: draftLabel(row),
      rationale: row.rationale,
      ops,
      sections: sectionViews(plan, storedSections(row.sections)),
      rewrites: sectionViews(plan, storedSections(row.rewrites)),
      similar: [...similar.values()].sort((a, b) => b.score - a.score),
      tainted: row.tainted,
      // Spelled as every id of an answer is, by hand: `replaces` names other things elsewhere, so it is no codec field.
      replaces: row.replacesId ? uuidToBase62(row.replacesId) : null,
      replacedBy: facts.replacedBy.has(row.id) ? uuidToBase62(facts.replacedBy.get(row.id)!) : null,
      decision: (row.decision as WikiChatDraftView['decision']) ?? null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      undoneAt: row.undoneAt?.toISOString() ?? null,
      undoable: wikiChatDraftUndoable(row.kind as WikiChatDraftKind, state, storedOps(row.ops)),
      changesetId: row.changesetId,
      rewrite: rewrite ? rewriteView(rewrite, plan, row.seenAt !== null) : null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * Every card of some chats, as the round button and the chats list count them (`wikiChatFabCounts`), by chat. A chat in
 * Trash is not counted at all (contract `chat.fab.counts`), which the caller decides by the chats it names.
 */
export async function cardsOfChats(db: Reader, ownerId: string, chatIds: readonly string[]): Promise<Map<string, WikiChatCard[]>> {
  const out = new Map<string, WikiChatCard[]>();
  if (chatIds.length === 0) return out;
  const rows = await db.wikiChatDraft.findMany({
    where: { ownerId, sessionId: { in: [...chatIds] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: DRAFT_SELECT,
  });
  const facts = await draftFacts(db, ownerId, rows);
  const rewrites = await draftRewrites(db, ownerId, rows);
  const plans = new Map<string, PlanRow | null>();
  for (const row of rows) {
    if (!plans.has(row.spaceId)) plans.set(row.spaceId, rewrites.size > 0 ? await confirmedPlanOf(db, ownerId, row.spaceId) : null);
    const cards = out.get(row.sessionId) ?? [];
    cards.push(cardOf(row, draftStateOf(row, facts), rewrites.get(row.id), plans.get(row.spaceId) ?? null));
    out.set(row.sessionId, cards);
  }
  return out;
}

/**
 * Each space's `chatWaiting` (contract `space.list.chatWaiting`, `wikiChatWaiting`): its applied cards whose rewrite
 * waits on the owner — held up, or read the same or failed and not yet seen — one each, over its chats not in Trash.
 * Only an applied card not undone, not seen and with Rewrites can wait, so only those are read.
 */
export async function chatWaitingOfSpaces(db: Reader, ownerId: string, spaceIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(spaceIds.map((id) => [id, 0]));
  if (spaceIds.length === 0) return out;
  const rows = await db.wikiChatDraft.findMany({
    where: { ownerId, spaceId: { in: [...spaceIds] }, decision: { in: ['applied', 'edited'] }, undoneAt: null, seenAt: null },
    select: DRAFT_SELECT,
  });
  const candidates = rows.filter((row) => storedSections(row.rewrites).length > 0);
  if (candidates.length === 0) return out;
  const trashed = new Set((await db.session.findMany({
    where: { ownerId, id: { in: [...new Set(candidates.map((row) => row.sessionId))] }, deletedAt: { not: null } },
    select: { id: true },
  })).map((session) => session.id));
  const counted = candidates.filter((row) => !trashed.has(row.sessionId));
  const rewrites = await draftRewrites(db, ownerId, counted);
  for (const row of counted) {
    const card = cardOf(row, 'applied', rewrites.get(row.id), null);
    const waits = card.rewrite !== null
      && (card.rewrite.result === 'waiting' || ((card.rewrite.result === 'same' || card.rewrite.result === 'failed') && !card.rewrite.seen));
    if (waits) out.set(row.spaceId, (out.get(row.spaceId) ?? 0) + 1);
  }
  return out;
}

// ── The Rewrites, when a card is drafted ───────────────────────────────────────────────────────

/** What a card's Rewrites are worked out from, besides the space: its chat, and the ops it drafts (contract `chat.drafts.rewrites`). */
export interface RewritesInput {
  ownerId: string;
  spaceId: string;
  chatId: string;
  ops: readonly Pick<StoredDraftOp, 'op' | 'entryId' | 'payload'>[];
}

/**
 * A card's Rewrites (contract `chat.drafts.rewrites`, design §8.2), worked out when it is drafted: the sections the chat's
 * owner turns attached — page and selection — newest first; then the sections holding a sentence whose footnote came
 * through an entry the card changes (`via_entry_id`), in the plan's order; then, for a new entry, the sections it fits
 * (`docs.affected.fit`), best first, ties in the plan's order. Each once, only written sections of the confirmed plan, at
 * most rules.rewritesMax (`wikiChatRewrites`). None without a confirmed plan.
 */
export async function chatDraftRewrites(db: Reader, input: RewritesInput): Promise<WikiChatSectionRef[]> {
  const { ownerId, spaceId } = input;
  const plan = await db.wikiPlan.findFirst({
    where: { ownerId, spaceId, status: 'confirmed' },
    select: { docs: { orderBy: { position: 'asc' }, select: { slug: true, sections: { orderBy: { position: 'asc' }, select: { key: true, sources: true } } } } },
  });
  if (!plan) return [];
  const written = await db.wikiDocSection.findMany({
    where: { ownerId, doc: { ownerId, spaceId } },
    select: { key: true, doc: { select: { slug: true } } },
  });
  const isWritten = new Set(written.map((section) => sectionId(section.doc.slug, section.key)));
  const order = plan.docs.flatMap((doc) => doc.sections.map((section) => ({ doc: doc.slug, key: section.key, sources: section.sources })))
    .filter((section) => isWritten.has(sectionId(section.doc, section.key)));
  if (order.length === 0) return [];

  // Attached: every turn of the chat that carried a page or a selection, newest first.
  const turns = await db.conversationTurn.findMany({
    where: { sessionId: input.chatId, wikiContext: { not: Prisma.DbNull } },
    orderBy: { seq: 'desc' },
    select: { wikiContext: true },
    take: 200,
  });
  const attached: WikiChatSectionRef[] = [];
  const sentenceIds: string[] = [];
  for (const turn of turns) {
    if (wikiChatContextErrors(turn.wikiContext).length > 0) continue;
    const context = turn.wikiContext as unknown as WikiChatContext;
    if (context.selection) attached.push({ doc: context.selection.docSlug, key: context.selection.sectionKey });
    if (context.page?.kind === 'doc') attached.push({ doc: context.page.docSlug, key: context.page.sectionKey });
    for (const id of context.selection?.sentenceIds ?? []) sentenceIds.push(id);
  }
  // A selection that ran on into later sections attached those too.
  const ranInto = await sentenceSections(db, ownerId, spaceId, sentenceIds);
  const attachedAll = [...attached, ...ranInto];

  // Cited: the sections holding a sentence a footnote of which came through an entry the card changes.
  const changed = [...new Set(input.ops.map((op) => op.entryId).filter((id): id is string => id !== null))];
  const cited = changed.length === 0
    ? []
    : await db.$queryRaw<Array<{ doc: string; key: string }>>(Prisma.sql`
        SELECT DISTINCT d."slug" AS "doc", s."key" AS "key"
          FROM "wiki_doc_footnote" f
          JOIN "wiki_doc_sentence" se ON se."id" = f."sentence_id" AND se."owner_id" = f."owner_id"
          JOIN "wiki_doc_section" s ON s."id" = se."section_id" AND s."owner_id" = se."owner_id"
          JOIN "wiki_doc" d ON d."id" = s."doc_id" AND d."owner_id" = s."owner_id"
         WHERE f."owner_id" = ${ownerId}::uuid AND d."space_id" = ${spaceId}::uuid AND f."via_entry_id" = ANY(${changed}::uuid[])`);

  // Fit: each new entry against each section's session condition, as a maintenance run places an entry.
  const fit: Array<WikiChatSectionRef & { score: number }> = [];
  for (const op of input.ops) {
    if (op.op !== 'add' && op.op !== 'supersede') continue;
    const draft = (op.payload.entry ?? {}) as Record<string, unknown>;
    const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []);
    const blob = [String(draft.title ?? ''), String(draft.summary ?? ''), JSON.stringify(draft.fields ?? {}), ...texts(draft.aliases)].join(' ');
    for (const section of order) {
      const sessions = section.sources && typeof section.sources === 'object' ? (section.sources as { sessions?: unknown }).sessions : null;
      const condition = storedSessionCondition(sessions);
      if (!condition) continue;
      const scored = sectionFit(condition, {
        id: '',
        kind: String(draft.kind ?? ''),
        blob,
        topics: texts(draft.topics),
        anchorPaths: anchorPathsOf(draft.anchors),
        projects: new Set<string>(),
      });
      if (scored.fits) fit.push({ doc: section.doc, key: section.key, score: scored.score });
    }
  }
  return wikiChatRewrites({ plan: order.map(({ doc, key }) => ({ doc, key })), attached: attachedAll, cited, fit });
}

/** The sections some document sentences are in, by their public ids or UUIDs; one that names none is no section. */
async function sentenceSections(db: Reader, ownerId: string, spaceId: string, ids: readonly string[]): Promise<WikiChatSectionRef[]> {
  const uuids = [...new Set(ids.map(uuidOrNull).filter((id): id is string => id !== null))];
  if (uuids.length === 0) return [];
  const rows = await db.wikiDocSentence.findMany({
    where: { ownerId, id: { in: uuids }, section: { doc: { spaceId } } },
    select: { section: { select: { key: true, doc: { select: { slug: true } } } } },
  });
  return rows.map((row) => ({ doc: row.section.doc.slug, key: row.section.key }));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function uuidOrNull(id: string): string | null {
  if (UUID.test(id)) return id.toLowerCase();
  try {
    // A public id, as the page sends one.
    return toUuid(id);
  } catch {
    return null;
  }
}

// ── The note the agent is told the presses with ───────────────────────────────────────────────

/**
 * `<orbit_wiki_drafts>` (contract `chat.notes.drafts`): with the owner's next message after one or more presses, one
 * line for each card of the chat pressed since the agent was last told — its id, its label, what became of it (applied,
 * edited, discarded or undone), for an applied one the entries it wrote with their trust, and how its rewrite stands
 * then. Stamps `told_at` on each in the delivery's transaction, so a delivery rolled back tells the next one. Null when
 * nothing was pressed since.
 */
export async function draftsNote(db: Reader, input: { ownerId: string; sessionId: string }): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT d."id"::text AS "id" FROM "wiki_chat_draft" d
     WHERE d."owner_id" = ${input.ownerId}::uuid AND d."session_id" = ${input.sessionId}::uuid AND d."decision" IS NOT NULL
       AND (d."told_at" IS NULL OR d."told_at" < GREATEST(d."decided_at", COALESCE(d."undone_at", d."decided_at")))
     ORDER BY GREATEST(d."decided_at", COALESCE(d."undone_at", d."decided_at")), d."id"`);
  if (rows.length === 0) return null;
  const drafts = await db.wikiChatDraft.findMany({ where: { ownerId: input.ownerId, id: { in: rows.map((row) => row.id) } }, select: DRAFT_SELECT });
  const byId = new Map(drafts.map((row) => [row.id, row]));
  const ordered = rows.map((row) => byId.get(row.id)).filter((row): row is DraftRow => row !== undefined);
  const views = await draftViews(db, input.ownerId, ordered);
  const counts = { applied: 0, edited: 0, discarded: 0, undone: 0 };
  const lines: string[] = [];
  for (const view of views) {
    const what = view.undoneAt !== null ? 'undone' : (view.decision as 'applied' | 'edited' | 'discarded');
    counts[what] += 1;
    const id = uuidToBase62(view.id);
    if (what === 'discarded') {
      lines.push(`- ${id} ${view.label}: discarded. Nothing of it was written.`);
      continue;
    }
    if (what === 'undone') {
      lines.push(`- ${id} ${view.label}: undone. What its Apply wrote was taken back, and the sections it rewrote were restored where nothing wrote them since.`);
      continue;
    }
    const written = view.ops
      .filter((op) => op.entryId !== null)
      .map((op) => {
        const trust = typeof op.entry?.trust === 'string' ? op.entry.trust : 'unknown';
        const how = op.decision === 'pending' && op.op === 'challenge' ? 'challenged, waiting for the owner in Review' : trust;
        return `entry ${uuidToBase62(op.entryId!)} (${op.op}, ${how})`;
      });
    const wrote = written.length > 0 ? ` It wrote ${written.join(', ')}.` : view.kind === 'rewrite' ? ' It wrote no entry.' : '';
    const rewrite = view.rewrite
      ? ` Rewrite: ${wikiChatResultLine({ result: view.rewrite.result, reason: view.rewrite.reason, sha: view.rewrite.sha, seen: view.rewrite.seen, sections: view.rewrite.sections.map((s) => ({ where: s.where, result: s.result, ...(s.changed !== null ? { changed: s.changed } : {}) })) })}.`
      : view.rewrites.length > 0 ? ' Its rewrite has not been queued.' : '';
    lines.push(`- ${id} ${view.label}: ${what} by the owner.${wrote}${rewrite}`);
  }
  await db.wikiChatDraft.updateMany({ where: { ownerId: input.ownerId, id: { in: ordered.map((row) => row.id) } }, data: { toldAt: new Date() } });
  const head = `<${WIKI_CHAT_NOTE_TAGS.drafts} ${(['applied', 'edited', 'discarded', 'undone'] as const).map((key) => wikiChatNoteAttribute(key, counts[key])).join(' ')}>`;
  return [head, 'The owner pressed these cards since your last turn:', ...lines, `</${WIKI_CHAT_NOTE_TAGS.drafts}>`].join('\n');
}
