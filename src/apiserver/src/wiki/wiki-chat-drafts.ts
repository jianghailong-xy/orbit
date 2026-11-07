import { ConflictException, HttpException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  toUuid,
  WIKI_CHAT_RULES,
  WIKI_LIMITS,
  wikiChatDraftUndoable,
  type WikiChatDraftKind,
  type WikiChatDraftOpOutcome,
  type WikiChatDraftState,
  type WikiChatDraftToolAnswer,
  type WikiChatDraftView,
  type WikiChatProposeAnswer,
  type WikiChatSectionRef,
  type WikiEntryChanges,
  type WikiFieldError,
  type WikiOpOutcome,
  type WikiRefusal,
  type WikiRefusalCode,
  type WikiSimilar,
  type WikiTrust,
} from '@orbit/shared';
import { sha256 } from '../common/crypto.util';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  chatDraftRewrites,
  chatWaitingOfSpaces,
  confirmedPlanOf,
  DRAFT_SELECT,
  draftFacts,
  draftRewrites,
  draftStateOf,
  draftViews,
  sectionViews,
  storedOps,
  storedSections,
  type DraftRow,
  type StoredDraftOp,
} from './wiki-chat-cards';
import { WikiDocs } from './wiki-docs';
import { followWikiDocsPress, wikiDocsFollowFactsOf } from './wiki-docs-follow';
import { WikiRefusalError, WikiService, type CheckedChatOps, type WikiPrincipal, type WikiProposeInput } from './wiki.service';

/**
 * A wiki chat's cards and the owner's presses (contracts/wiki.contract.json `chat.drafts`, `chat.presses`,
 * `agentSurface.chat`; docs/wiki-contract.md §11 and §28.5–§28.6; design docs/wiki-chat-design.md §7).
 *
 * THE AGENT DRAFTS, THE OWNER WRITES. In a chat (`session.wiki_chat_space_id` set), `wiki_propose` and the `corrects` of a
 * `wiki_note` make a card instead of a changeset — every op checked as ever (`WikiService.draftChatOps`) and nothing of
 * the wiki written — and `wiki_draft` makes a rewrite card. A card is a row of its own (`wiki_chat_draft`): it takes no
 * place in Review, its quotas or the queue, and no review mode touches it.
 *
 * THE PRESSES ARE THE OWNER'S DOOR'S ALONE. Every route here refuses a request with a session header
 * WIKI_OWNER_CHANNEL_ONLY before it reads anything, whatever the session, and takes only the owner's interactive
 * credential for a write (the controller's guard). Apply accepts a card's ops as Review's Accept does, confirmed — a
 * principle the owner's — with no verification, in one transaction with the card's Rewrites queued (`docs_follow`); Undo
 * takes it back through revert's own writes and restores the sections its rewrite wrote.
 *
 * LOCKS, in one order everywhere: the card's row FOR UPDATE first; then the entries a press writes (`WikiService`); then
 * the documents (`followWikiDocsPress`, `WikiDocs.restoreIn`); then the space's row and its follow job. A follow job's
 * write takes the cards that asked for a section FOR SHARE before its entries and documents (`WikiDocs.store`).
 */

/** What a press answers: the card as it stands after it, and whether this was the same press again. */
export interface WikiChatPressAnswer {
  replayed: boolean;
  draft: WikiChatDraftView;
  [extra: string]: unknown;
}

const PRESS_TRANSACTION = { timeout: 20_000, maxWait: 5_000 };

function refusal(code: WikiRefusalCode, message: string, errors?: WikiFieldError[]): WikiRefusalError {
  return new WikiRefusalError(errors ? { code, message, errors } : { code, message });
}

/** A request with a session header is never the owner's press (contract `chat.door`). */
function refuseActingSession(actingSessionId: string | null, what: string): void {
  if (!actingSessionId) return;
  throw refusal(
    'WIKI_OWNER_CHANNEL_ONLY',
    `${what} is the account owner's, through an owner channel with no acting session: an agent drafts a card, and only `
      + 'the owner reads it here and presses it.',
  );
}

/** An id a body names, as its UUID: a public id or a UUID, or WIKI_SCHEMA at its path. */
function idAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw refusal('WIKI_SCHEMA', `${path} names a card by its id`, [{ path, message: 'must be an id' }]);
  try {
    return toUuid(value.trim());
  } catch {
    throw refusal('WIKI_SCHEMA', `${path} names no card`, [{ path, message: 'is not an id' }]);
  }
}

/** The 409 a press on a card that is not open answers (contract `chat.presses.oneCardOnePress`): no code, its state named. */
function notOpen(state: WikiChatDraftState, press: string): ConflictException {
  const why: Record<WikiChatDraftState, string> = {
    draft: 'it is still a draft',
    replaced: 'a newer card of the chat replaced it',
    changed: 'what it changes changed since it was drafted',
    applied: 'it is applied already',
    discarded: 'it was discarded',
    not_applied: 'its chat ended with it unpressed',
    undone: 'it was undone',
  };
  return new ConflictException(`this card is ${state} (${why[state]}), so ${press} does nothing to it: nothing was written`);
}

const sectionKey = (doc: string, key: string): string => `${doc}\u0000${key}`;

@Injectable()
export class WikiChatDrafts {
  private readonly logger = new Logger(WikiChatDrafts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wiki: WikiService,
    private readonly docs: WikiDocs,
    // `wiki.changed` after a card is made, replaced or pressed (contract `chat.realtime`). Global; defaulted for specs
    // that build this by hand.
    @Optional() private readonly realtime?: RealtimeService,
  ) {}

  /** The space a session is a chat of (contract `chat.binding.is`), or null for a session that is no chat. */
  async chatOf(ownerId: string, sessionId: string | null): Promise<{ spaceId: string } | null> {
    if (!sessionId) return null;
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, ownerId }, select: { wikiChatSpaceId: true } });
    return session?.wikiChatSpaceId ? { spaceId: session.wikiChatSpaceId } : null;
  }

  /** Each space's `chatWaiting` (contract `space.list.chatWaiting`): its applied cards whose rewrite waits on the owner. */
  async chatWaitingOf(ownerId: string, spaceIds: readonly string[]): Promise<Map<string, number>> {
    return chatWaitingOfSpaces(this.prisma, ownerId, spaceIds);
  }

  // ── The drafting tools (the runner door) ───────────────────────────────────────────────────────

  /**
   * `wiki_propose` in a chat (contract `agentSurface.chat.propose`): every op is checked as anywhere and the ones that
   * pass become one card. Answers `{ status: draft, draftId, ops, similar, rewrites }`; a request none of whose ops passed
   * makes no card and answers as a proposal would have; a dry run checks and makes nothing.
   */
  async proposeInChat(
    principal: WikiPrincipal & { sessionId: string },
    spaceId: string,
    input: WikiProposeInput & { replaces?: unknown },
  ): Promise<Record<string, unknown>> {
    const replaces = input.replaces === undefined || input.replaces === null ? null : idAt(input.replaces, 'replaces');
    const dryRun = input.dryRun === true;
    const made = await this.wiki.draftChatOps(principal, spaceId, { ...input, replaces }, {
      replay: async (tx, requestSha256) => (dryRun || !input.idempotencyKey ? null : this.replayCard(tx, principal, input.idempotencyKey, requestSha256)),
      write: async (tx, checked) => this.writeEntryCard(tx, principal, checked, {
        rationale: String(input.rationale ?? ''),
        idempotencyKey: input.idempotencyKey ?? null,
        replaces,
        dryRun,
      }),
    });
    if (made.status === 'draft' && made.replayed === false && typeof made.draftId === 'string') {
      this.realtime?.publishWikiChanged(principal.ownerId, spaceId);
    }
    return made;
  }

  /**
   * A `wiki_note`'s `corrects` in a chat (contract `agentSurface.chat.note`): the note is kept as anywhere, and the
   * challenge becomes a card. Answers `{ status: draft, draftId }`, or the refusal, as `challenged`.
   */
  async correctInChat(
    principal: WikiPrincipal & { sessionId: string },
    spaceId: string,
    input: { entryId: string; reason: string; noteId: string; replaces?: unknown },
  ): Promise<Record<string, unknown>> {
    try {
      const answer = await this.proposeInChat(principal, spaceId, {
        ops: [{ op: 'challenge', entryId: input.entryId, reason: input.reason }],
        rationale: 'A session said this entry is wrong (wiki_note, corrects).',
        idempotencyKey: `wiki-note:${input.noteId}:${input.entryId}`,
        replaces: input.replaces,
      });
      if (answer.status === 'draft' && typeof answer.draftId === 'string') {
        const [op] = (answer.ops ?? []) as WikiChatDraftOpOutcome[];
        return { status: 'draft', draftId: answer.draftId, entryId: op && op.status === 'draft' ? op.entryId : null, ...(answer.replayed ? { replayed: true } : {}) };
      }
      const [op] = (answer.ops ?? []) as Array<{ status: string; reasons?: WikiRefusal[]; currentRevision?: number }>;
      return { status: 'refused', reasons: op?.reasons ?? [{ code: 'WIKI_REVISION_CONFLICT', message: 'the entry moved' }] };
    } catch (error) {
      // An entry this session may not read is answered as one that does not exist (`refusalRules.notFound`).
      if (!(error instanceof HttpException)) throw error;
      const said = error.getResponse();
      const { code, message } = (typeof said === 'object' ? said : { message: said }) as { code?: string; message?: unknown };
      return { status: 'refused', reasons: [{ ...(code ? { code } : {}), message: String(message ?? error.message) }] };
    }
  }

  /**
   * `wiki_draft` (contract `agentSurface.chat.draft`): a rewrite of written sections of the confirmed plan from main,
   * 1 to rules.rewritesMax of them. The plan kind arrives with the plan card (C12): until then it is refused WIKI_SCHEMA at
   * kind. Answers `{ status: draft, draftId, kind, rewrites }`.
   */
  async draftInChat(principal: WikiPrincipal & { sessionId: string }, spaceId: string, body: unknown): Promise<WikiChatDraftToolAnswer> {
    const input = (body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (input.kind === 'plan') {
      throw refusal('WIKI_SCHEMA', 'plan drafts are not open yet: they arrive with the plan card. Draft a rewrite of sections from main, or say '
        + 'what the plan should change in the chat', [{ path: 'kind', message: 'plan is not open yet' }]);
    }
    if (input.kind !== 'rewrite') {
      throw refusal('WIKI_SCHEMA', 'kind is rewrite: the sections to write again from main (an entry is wiki_propose\'s)', [
        { path: 'kind', message: 'must be rewrite' },
      ]);
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '' || Array.from(reason).length > WIKI_LIMITS.fieldTextMaxChars) {
      throw refusal('WIKI_SCHEMA', `reason says why these sections lag behind main, in at most ${WIKI_LIMITS.fieldTextMaxChars} characters`, [
        { path: 'reason', message: reason === '' ? 'is required' : `must be at most ${WIKI_LIMITS.fieldTextMaxChars} characters` },
      ]);
    }
    const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (key === '' || Array.from(key).length > 200) {
      throw refusal('WIKI_SCHEMA', 'idempotencyKey is required, at most 200 characters: a retry under it is the same card', [
        { path: 'idempotencyKey', message: key === '' ? 'is required' : 'must be at most 200 characters' },
      ]);
    }
    const raw = input.sections;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > WIKI_CHAT_RULES.rewritesMax) {
      throw refusal('WIKI_SCHEMA', `sections names 1 to ${WIKI_CHAT_RULES.rewritesMax} sections, each { doc, section }`, [
        { path: 'sections', message: `must hold 1 to ${WIKI_CHAT_RULES.rewritesMax} sections` },
      ]);
    }
    const sections: WikiChatSectionRef[] = [];
    const errors: WikiFieldError[] = [];
    raw.forEach((one, i) => {
      const section = (one !== null && typeof one === 'object' ? one : {}) as { doc?: unknown; section?: unknown };
      if (typeof section.doc !== 'string' || section.doc.trim() === '') errors.push({ path: `sections[${i}].doc`, message: "is the document's slug" });
      if (typeof section.section !== 'string' || section.section.trim() === '') errors.push({ path: `sections[${i}].section`, message: "is the section's key" });
      if (typeof section.doc === 'string' && typeof section.section === 'string') {
        const ref = { doc: section.doc.trim(), key: section.section.trim() };
        if (sections.some((s) => s.doc === ref.doc && s.key === ref.key)) errors.push({ path: `sections[${i}]`, message: 'names a section twice' });
        else sections.push(ref);
      }
    });
    if (errors.length > 0) throw refusal('WIKI_SCHEMA', 'each section is { doc, section }: a document\'s slug and a section\'s key', errors);
    const replaces = input.replaces === undefined || input.replaces === null ? null : idAt(input.replaces, 'replaces');
    const requestSha256 = sha256(JSON.stringify({ kind: 'rewrite', spaceId, sections, reason, replaces }));
    const answer = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const replayed = await this.replayCard(tx, principal, key, requestSha256);
        if (replayed) {
          return { status: 'draft' as const, draftId: replayed.draftId as string, kind: 'rewrite' as const, replayed: true, rewrites: replayed.rewrites as WikiChatDraftToolAnswer['rewrites'] };
        }
        // Each a written section of the confirmed plan (contract `agentSurface.chat.draft.params.sections`).
        const plan = await confirmedPlanOf(tx, principal.ownerId, spaceId);
        const written = new Set((await tx.wikiDocSection.findMany({
          where: { ownerId: principal.ownerId, doc: { ownerId: principal.ownerId, spaceId } },
          select: { key: true, doc: { select: { slug: true } } },
        })).map((row) => sectionKey(row.doc.slug, row.key)));
        const missing = sections.flatMap((section, i) => {
          const inPlan = plan?.docs.some((doc) => doc.slug === section.doc && doc.sections.some((one) => one.key === section.key)) ?? false;
          return inPlan && written.has(sectionKey(section.doc, section.key))
            ? []
            : [{ path: `sections[${i}]`, message: inPlan ? 'is not written yet: there is nothing to write again' : 'is not a section of the confirmed plan' }];
        });
        if (missing.length > 0) {
          throw refusal('WIKI_SCHEMA', 'a rewrite names written sections of the confirmed plan, as the documents read names them', missing);
        }
        await this.lockReplaced(tx, principal, replaces);
        const created = await tx.wikiChatDraft.create({
          data: {
            ownerId: principal.ownerId,
            spaceId,
            sessionId: principal.sessionId,
            kind: 'rewrite',
            rationale: reason,
            sections: sections as unknown as Prisma.InputJsonValue,
            rewrites: sections as unknown as Prisma.InputJsonValue,
            tainted: await this.wiki.chatWasTainted(tx, principal.sessionId),
            replacesId: replaces,
            idempotencyKey: key,
            requestSha256,
          },
          select: { id: true },
        });
        return { status: 'draft' as const, draftId: created.id, kind: 'rewrite' as const, replayed: false, rewrites: sectionViews(plan, sections) };
      },
      loggedRetry(this.logger, 'wiki.draftChatRewrite'),
    );
    if (!answer.replayed) this.realtime?.publishWikiChanged(principal.ownerId, spaceId);
    return answer;
  }

  /** The card an earlier call made under the same key, answered again; or the refusal for a key reused. */
  private async replayCard(
    tx: Prisma.TransactionClient,
    principal: WikiPrincipal & { sessionId: string },
    idempotencyKey: string,
    requestSha256: string | null,
  ): Promise<Record<string, unknown> | null> {
    const existing = await tx.wikiChatDraft.findFirst({ where: { ownerId: principal.ownerId, idempotencyKey }, select: DRAFT_SELECT });
    if (!existing) return null;
    if (existing.requestSha256 !== requestSha256 || existing.sessionId !== principal.sessionId) {
      throw refusal('WIKI_IDEMPOTENCY_KEY_REUSED', 'this idempotency key was used for a different draft: the same request under the same key answers '
        + 'with the card it made, and another request needs another key');
    }
    const plan = await confirmedPlanOf(tx, principal.ownerId, existing.spaceId);
    return {
      status: 'draft',
      draftId: existing.id,
      replayed: true,
      ops: storedOps(existing.ops).map((op): WikiChatDraftOpOutcome => ({
        seq: op.seq, status: 'draft', entryId: op.entryId, ...(op.similar?.length ? { similar: op.similar } : {}),
      })),
      similar: similarOf(storedOps(existing.ops)),
      rewrites: sectionViews(plan, storedSections(existing.rewrites)),
    };
  }

  /**
   * The card a chat's checked ops make (contract `chat.drafts.made`): the ops that passed, with their neighbours and
   * Rewrites; none made when none passed, which answers as a proposal would; nothing made for a dry run.
   */
  private async writeEntryCard(
    tx: Prisma.TransactionClient,
    principal: WikiPrincipal & { sessionId: string },
    checked: CheckedChatOps,
    card: { rationale: string; idempotencyKey: string | null; replaces: string | null; dryRun: boolean },
  ): Promise<Record<string, unknown>> {
    const drafted: StoredDraftOp[] = checked.ops.flatMap((one) => (one.drafted
      ? [{
          seq: one.seq,
          op: one.drafted.op,
          entryId: one.drafted.entryId,
          baseRevision: one.drafted.baseRevision,
          payload: one.drafted.payload,
          similar: one.drafted.similar,
          tainted: one.drafted.tainted,
        }]
      : []));
    const outcomes = checked.ops.map((one): WikiChatDraftOpOutcome => (one.drafted
      ? { seq: one.seq, status: 'draft', entryId: one.drafted.entryId, ...(one.drafted.similar.length > 0 ? { similar: one.drafted.similar } : {}) }
      : one.outcome as Exclude<WikiChatDraftOpOutcome, { status: 'draft' }>));
    if (drafted.length === 0) {
      // Nothing passed: no card, and the answer a proposal would have had (contract `agentSurface.chat.propose`).
      return { changesetId: null, replayed: false, ...(card.dryRun ? { dryRun: true } : {}), ops: checked.ops.map((one) => one.outcome as WikiOpOutcome) };
    }
    const rewrites = await chatDraftRewrites(tx, { ownerId: principal.ownerId, spaceId: checked.space.id, chatId: principal.sessionId, ops: drafted });
    const plan = await confirmedPlanOf(tx, principal.ownerId, checked.space.id);
    const answer: WikiChatProposeAnswer = {
      status: 'draft',
      draftId: null,
      replayed: false,
      ops: outcomes,
      similar: similarOf(drafted),
      rewrites: sectionViews(plan, rewrites),
    };
    if (card.dryRun) return { ...answer, dryRun: true };
    await this.lockReplaced(tx, principal, card.replaces);
    const created = await tx.wikiChatDraft.create({
      data: {
        ownerId: principal.ownerId,
        spaceId: checked.space.id,
        sessionId: principal.sessionId,
        kind: 'entry',
        rationale: card.rationale,
        ops: drafted as unknown as Prisma.InputJsonValue,
        rewrites: rewrites as unknown as Prisma.InputJsonValue,
        tainted: checked.sessionTainted || drafted.some((op) => op.tainted),
        replacesId: card.replaces,
        idempotencyKey: card.idempotencyKey,
        requestSha256: card.idempotencyKey ? checked.requestSha256 : null,
      },
      select: { id: true },
    });
    return { ...answer, draftId: created.id };
  }

  /**
   * The card a new one replaces (contract `chat.drafts.replace`), held FOR UPDATE: an open card — a draft, or one whose
   * base moved — of the same chat. Anything else is no card to replace, refused WIKI_SCHEMA at replaces.
   */
  private async lockReplaced(tx: Prisma.TransactionClient, principal: WikiPrincipal & { sessionId: string }, replaces: string | null): Promise<void> {
    if (!replaces) return;
    const row = await this.lockCard(tx, principal.ownerId, replaces).catch((error: unknown) => {
      if (error instanceof NotFoundException) return null;
      throw error;
    });
    const state = row && row.sessionId === principal.sessionId ? draftStateOf(row, await draftFacts(tx, principal.ownerId, [row])) : null;
    if (!row || row.sessionId !== principal.sessionId || (state !== 'draft' && state !== 'changed')) {
      throw refusal('WIKI_SCHEMA', 'replaces names an open card of this chat: a draft nobody pressed, discarded or replaced', [
        { path: 'replaces', message: !row || row.sessionId !== principal.sessionId ? 'is not a card of this chat' : `is ${state}, not open` },
      ]);
    }
  }

  /** A card's row, held FOR UPDATE: the first lock every press takes. Another owner's card is the plain 404. */
  private async lockCard(tx: Prisma.TransactionClient, ownerId: string, draftId: string): Promise<DraftRow> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"::text AS "id" FROM "wiki_chat_draft" WHERE "id" = ${draftId}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`);
    if (locked.length === 0) throw new NotFoundException('no such card');
    return tx.wikiChatDraft.findFirstOrThrow({ where: { id: draftId, ownerId }, select: DRAFT_SELECT });
  }

  // ── The owner's reads ──────────────────────────────────────────────────────────────────────────

  /** `GET /api/wiki/chat-drafts/:id` (contract `chat.drafts.read`). Reads only. */
  async read(ownerId: string, draftId: string, actingSessionId: string | null): Promise<WikiChatDraftView> {
    refuseActingSession(actingSessionId, 'reading a wiki chat\'s card');
    return this.view(ownerId, draftId);
  }

  /** `GET /api/wiki/chats/:id/drafts`: every card of one chat, oldest first. Another owner's chat, or a session that is no chat, is the 404. */
  async listOfChat(ownerId: string, chatId: string, actingSessionId: string | null): Promise<{ sessionId: string; drafts: WikiChatDraftView[] }> {
    refuseActingSession(actingSessionId, 'reading a wiki chat\'s cards');
    const chat = await this.prisma.session.findFirst({ where: { id: chatId, ownerId }, select: { id: true, wikiChatSpaceId: true } });
    if (!chat?.wikiChatSpaceId) throw new NotFoundException('no such wiki chat');
    const rows = await this.prisma.wikiChatDraft.findMany({
      where: { ownerId, sessionId: chat.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: DRAFT_SELECT,
    });
    return { sessionId: chat.id, drafts: await draftViews(this.prisma, ownerId, rows) };
  }

  private async view(ownerId: string, draftId: string): Promise<WikiChatDraftView> {
    const row = await this.prisma.wikiChatDraft.findFirst({ where: { id: draftId, ownerId }, select: DRAFT_SELECT });
    if (!row) throw new NotFoundException('no such card');
    const [view] = await draftViews(this.prisma, ownerId, [row]);
    return view!;
  }

  // ── The presses ────────────────────────────────────────────────────────────────────────────────

  /** `POST /api/wiki/chat-drafts/:id/apply` (contract `chat.presses.apply`). */
  async apply(ownerId: string, userId: string, draftId: string, actingSessionId: string | null): Promise<WikiChatPressAnswer> {
    refuseActingSession(actingSessionId, 'applying a wiki chat\'s card');
    return this.press(ownerId, userId, draftId, 'applied', new Map());
  }

  /**
   * `POST /api/wiki/chat-drafts/:id/edit` (contract `chat.presses.edit`): `{ ops: [{ seq, changes }] }`, the owner's
   * changes laid over the named ops of an entry card as an amend's changes, then the rest of an Apply.
   */
  async edit(ownerId: string, userId: string, draftId: string, body: unknown, actingSessionId: string | null): Promise<WikiChatPressAnswer> {
    refuseActingSession(actingSessionId, 'editing a wiki chat\'s card');
    const raw = (body !== null && typeof body === 'object' ? (body as { ops?: unknown }).ops : undefined);
    if (!Array.isArray(raw) || raw.length === 0) {
      throw refusal('WIKI_SCHEMA', 'an edit names the ops it changes, { ops: [{ seq, changes }] }: Apply takes the card as it is', [
        { path: 'ops', message: 'must hold at least one { seq, changes }' },
      ]);
    }
    const edits = new Map<number, WikiEntryChanges>();
    raw.forEach((one, i) => {
      const item = (one !== null && typeof one === 'object' ? one : {}) as { seq?: unknown; changes?: unknown };
      if (typeof item.seq !== 'number' || !Number.isInteger(item.seq) || item.seq < 0) {
        throw refusal('WIKI_SCHEMA', 'each edit names the op it changes by its seq', [{ path: `ops[${i}].seq`, message: 'must be an op\'s seq' }]);
      }
      if (item.changes === null || typeof item.changes !== 'object' || Array.isArray(item.changes) || Object.keys(item.changes).length === 0) {
        throw refusal('WIKI_SCHEMA', 'each edit carries the owner\'s changes, shaped as an amend\'s', [{ path: `ops[${i}].changes`, message: 'is required' }]);
      }
      if (edits.has(item.seq)) throw refusal('WIKI_SCHEMA', 'an op is edited once', [{ path: `ops[${i}].seq`, message: 'names an op twice' }]);
      edits.set(item.seq, item.changes as WikiEntryChanges);
    });
    return this.press(ownerId, userId, draftId, 'edited', edits);
  }

  /**
   * Apply and Edit, one press each (contract `chat.presses`): in one transaction, the card held; an entry card's ops
   * recorded and accepted (`WikiService.applyChatOps`); its Rewrites queued as forced sections (`followWikiDocsPress`); and
   * the press written on the card. The same press again answers the first, marked replayed.
   */
  private async press(
    ownerId: string,
    userId: string,
    draftId: string,
    decision: 'applied' | 'edited',
    edits: ReadonlyMap<number, WikiEntryChanges>,
  ): Promise<WikiChatPressAnswer> {
    const pressed = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const row = await this.lockCard(tx, ownerId, draftId);
        if (row.decision === decision && row.undoneAt === null) return { replayed: true, row, record: null };
        const state = draftStateOf(row, await draftFacts(tx, ownerId, [row]));
        if (state === 'changed') {
          throw refusal('WIKI_REVISION_CONFLICT', 'what this card changes changed since it was drafted: nothing was applied. Ask the chat to draft it '
            + 'again from what is there now (Redo)');
        }
        if (state !== 'draft') throw notOpen(state, decision === 'applied' ? 'Apply' : 'Edit');
        if (decision === 'edited' && row.kind !== 'entry') {
          throw new ConflictException(`only an entry card is edited, and this is a ${row.kind} card: Apply it or Discard it`);
        }
        if (row.kind === 'plan') throw new ConflictException('plan cards are not open yet: they arrive with the plan card, and nothing was written');
        const ops = storedOps(row.ops);
        for (const seq of edits.keys()) {
          const op = ops.find((one) => one.seq === seq);
          if (!op || (op.op !== 'add' && op.op !== 'supersede' && op.op !== 'amend')) {
            throw refusal('WIKI_SCHEMA', 'an edit lays the owner\'s changes over an add, a supersede or an amend of the card', [
              { path: `ops[${[...edits.keys()].indexOf(seq)}].seq`, message: op ? `is a ${op.op}, which has nothing to edit` : 'is not an op of this card' },
            ]);
          }
        }
        let record: Awaited<ReturnType<WikiService['applyChatOps']>> | null = null;
        if (row.kind === 'entry') {
          record = await this.wiki.applyChatOps(tx, {
            ownerId,
            userId,
            spaceId: row.spaceId,
            chatId: row.sessionId,
            draftId: row.id,
            rationale: row.rationale,
            ops: ops.map((op) => op.payload),
            edits,
          });
        }
        await followWikiDocsPress(tx, {
          ownerId,
          spaceId: row.spaceId,
          draftId: row.id,
          chatId: row.sessionId,
          sections: storedSections(row.rewrites),
          entryIds: record?.entryIds ?? [],
        });
        await tx.wikiChatDraft.updateMany({
          where: { id: row.id, ownerId, decision: null },
          data: {
            decision,
            decidedAt: new Date(),
            changesetId: record?.changesetId ?? null,
            trustBefore: record ? (record.trustBefore as Prisma.InputJsonValue) : Prisma.DbNull,
          },
        });
        return { replayed: false, row, record };
      },
      loggedRetry(this.logger, 'wiki.pressChatDraft', { transaction: PRESS_TRANSACTION }),
    );
    if (!pressed.replayed) this.realtime?.publishWikiChanged(ownerId, pressed.row.spaceId);
    return {
      replayed: pressed.replayed,
      draft: await this.view(ownerId, draftId),
      ...(pressed.record ? { changesetId: pressed.record.changesetId, ops: pressed.record.ops } : {}),
    };
  }

  /** `POST /api/wiki/chat-drafts/:id/discard` (contract `chat.presses.discard`): the card marked, nothing else written. */
  async discard(ownerId: string, userId: string, draftId: string, actingSessionId: string | null): Promise<WikiChatPressAnswer> {
    refuseActingSession(actingSessionId, 'discarding a wiki chat\'s card');
    void userId;
    const pressed = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const row = await this.lockCard(tx, ownerId, draftId);
        if (row.decision === 'discarded') return { replayed: true, row };
        const state = draftStateOf(row, await draftFacts(tx, ownerId, [row]));
        if (state !== 'draft' && state !== 'changed') throw notOpen(state, 'Discard');
        await tx.wikiChatDraft.updateMany({ where: { id: row.id, ownerId, decision: null }, data: { decision: 'discarded', decidedAt: new Date() } });
        return { replayed: false, row };
      },
      loggedRetry(this.logger, 'wiki.discardChatDraft'),
    );
    if (!pressed.replayed) this.realtime?.publishWikiChanged(ownerId, pressed.row.spaceId);
    return { replayed: pressed.replayed, draft: await this.view(ownerId, draftId) };
  }

  /**
   * `POST /api/wiki/chat-drafts/:id/undo` (contract `chat.presses.undo`), in one transaction: the changeset an entry card's
   * Apply recorded reverted (`WikiService.revertChatApplyIn`); each section the card's rewrite wrote restored to the
   * version that rewrite kept — one written again since is left and named; the card's press taken off a follow job that
   * has not started (a job left with nothing is cancelled), while one that runs writes none of the card's sections it has
   * not written yet (`WikiDocs.store`); and the card marked undone.
   */
  async undo(ownerId: string, userId: string, draftId: string, actingSessionId: string | null): Promise<WikiChatPressAnswer> {
    refuseActingSession(actingSessionId, 'undoing a wiki chat\'s card');
    const undone = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const row = await this.lockCard(tx, ownerId, draftId);
        if (row.undoneAt !== null) return { replayed: true, row, revert: null, sections: [] as Array<Record<string, unknown>> };
        const state = draftStateOf(row, await draftFacts(tx, ownerId, [row]));
        if (state !== 'applied') throw notOpen(state, 'Undo');
        if (!wikiChatDraftUndoable(row.kind as WikiChatDraftKind, state, storedOps(row.ops))) {
          throw new ConflictException('this card cannot be undone: a supersede or a retire ends a lineage nothing brings back, and a reinforce or a '
            + 'challenge is answered as any other — the challenge in Review. Nothing was written');
        }
        const revert = row.kind === 'entry' && row.changesetId
          ? await this.wiki.revertChatApplyIn(tx, {
            ownerId,
            userId,
            changesetId: row.changesetId,
            trustBefore: (row.trustBefore ?? {}) as Record<string, WikiTrust>,
          })
          : null;
        const sections = await this.undoRewrite(tx, ownerId, row);
        await tx.wikiChatDraft.updateMany({ where: { id: row.id, ownerId, undoneAt: null }, data: { undoneAt: new Date() } });
        return { replayed: false, row, revert, sections };
      },
      loggedRetry(this.logger, 'wiki.undoChatDraft', { transaction: PRESS_TRANSACTION }),
    );
    if (!undone.replayed) this.realtime?.publishWikiChanged(ownerId, undone.row.spaceId);
    return {
      replayed: undone.replayed,
      draft: await this.view(ownerId, draftId),
      revert: undone.revert,
      sections: undone.sections,
    };
  }

  /**
   * The revert route given a chat Apply's changeset (contract `reviewModes.chat.revert`: one path): the card's Undo. Null
   * when no card's Apply recorded it — an ordinary changeset, reverted as ever.
   */
  async undoForChangeset(ownerId: string, userId: string, changesetId: string, actingSessionId: string | null): Promise<WikiChatPressAnswer | null> {
    const card = await this.prisma.wikiChatDraft.findFirst({ where: { ownerId, changesetId }, select: { id: true } });
    if (!card) return null;
    return this.undo(ownerId, userId, card.id, actingSessionId);
  }

  /**
   * What Undo does to a card's rewrite (contract `chat.presses.undo`): every section a follow job that carried the press
   * wrote goes back to the version the first of those writes kept — what stood before the press — unless anything else
   * wrote it since; the press is taken off each job that has not started, and a job left with no fact is cancelled.
   */
  private async undoRewrite(tx: Prisma.TransactionClient, ownerId: string, row: DraftRow): Promise<Array<Record<string, unknown>>> {
    const sections = storedSections(row.rewrites);
    if (sections.length === 0) return [];
    const jobs = await tx.$queryRaw<Array<{ id: string; state: string }>>(Prisma.sql`
      SELECT j."id"::text AS "id", j."state" FROM "wiki_job" j
       WHERE j."owner_id" = ${ownerId}::uuid AND j."space_id" = ${row.spaceId}::uuid AND j."kind" = 'docs_follow'
         AND j."input" -> 'facts' @> ${JSON.stringify([{ draftId: row.id }])}::jsonb
       ORDER BY j."created_at", j."id"`);
    const jobIds = jobs.map((job) => job.id);
    const kept = jobIds.length === 0
      ? []
      : await tx.wikiDocSectionVersion.findMany({
        where: { ownerId, spaceId: row.spaceId, reason: 'chat', jobId: { in: jobIds } },
        orderBy: { seq: 'asc' },
        select: { id: true, docSlug: true, sectionKey: true, seq: true },
      });
    const out: Array<Record<string, unknown>> = [];
    for (const section of sections) {
      const first = kept.find((version) => version.docSlug === section.doc && version.sectionKey === section.key);
      if (!first) {
        out.push({ doc: section.doc, key: section.key, outcome: 'unwritten' });
        continue;
      }
      const since = await tx.wikiDocSectionVersion.findFirst({
        where: {
          ownerId,
          spaceId: row.spaceId,
          docSlug: section.doc,
          sectionKey: section.key,
          seq: { gt: first.seq },
          OR: [{ jobId: null }, { jobId: { notIn: jobIds } }],
        },
        select: { id: true },
      });
      if (since) {
        out.push({ doc: section.doc, key: section.key, outcome: 'skipped', reason: 'written again since' });
        continue;
      }
      try {
        const restored = await this.docs.restoreIn(tx, ownerId, first.id, { slug: section.doc, key: section.key });
        out.push({ doc: section.doc, key: section.key, outcome: restored.outcome, versionId: first.id, keptVersionId: restored.keptVersionId });
      } catch (error) {
        // A section the confirmed plan no longer has is written nowhere, and a space with no confirmed plan writes no
        // document: there is nothing to restore it into, which the answer names.
        if (error instanceof ConflictException) {
          out.push({ doc: section.doc, key: section.key, outcome: 'skipped', reason: 'no longer in the plan' });
        } else if (error instanceof WikiRefusalError) {
          out.push({ doc: section.doc, key: section.key, outcome: 'skipped', reason: error.refusal.message });
        } else {
          throw error;
        }
      }
    }
    const queued = jobs.filter((job) => job.state === 'queued');
    if (queued.length > 0) {
      // The space's row first, as a fact joining its job takes it, then each job.
      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "wiki_space" WHERE "id" = ${row.spaceId}::uuid AND "owner_id" = ${ownerId}::uuid FOR NO KEY UPDATE`);
      for (const job of queued) {
        const [held] = await tx.$queryRaw<Array<{ input: unknown; state: string }>>(Prisma.sql`
          SELECT "input", "state" FROM "wiki_job" WHERE "id" = ${job.id}::uuid AND "owner_id" = ${ownerId}::uuid FOR UPDATE`);
        if (!held || held.state !== 'queued') continue;
        const facts = wikiDocsFollowFactsOf(held.input).filter((fact) => !(fact.kind === 'press' && fact.draftId === row.id));
        if (facts.length === 0) {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "wiki_job" SET "state" = 'cancelled', "ended_at" = now(), "updated_at" = now()
             WHERE "id" = ${job.id}::uuid AND "owner_id" = ${ownerId}::uuid AND "state" = 'queued'`);
        } else {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "wiki_job" SET "input" = ${JSON.stringify({ facts })}::jsonb, "updated_at" = now()
             WHERE "id" = ${job.id}::uuid AND "owner_id" = ${ownerId}::uuid AND "state" = 'queued'`);
        }
      }
    }
    return out;
  }

  /**
   * `POST /api/wiki/chat-drafts/:id/retry` (contract `chat.presses.retry`): Try again — an applied card whose rewrite
   * failed queues its sections again, forced, as its Apply did, and the result is unseen again. Any other card: a 409.
   */
  async retry(ownerId: string, userId: string, draftId: string, actingSessionId: string | null): Promise<WikiChatPressAnswer> {
    refuseActingSession(actingSessionId, 'retrying a wiki chat\'s rewrite');
    void userId;
    const retried = await withTransactionRetry(
      this.prisma,
      async (tx) => {
        const row = await this.lockCard(tx, ownerId, draftId);
        const state = draftStateOf(row, await draftFacts(tx, ownerId, [row]));
        if (state !== 'applied') throw notOpen(state, 'Try again');
        const rewrite = (await draftRewrites(tx, ownerId, [row])).get(row.id);
        if (rewrite?.result !== 'failed') {
          throw new ConflictException(`this card's rewrite is ${rewrite?.result ?? 'not there'}, not failed: Try again queues only a failed one, and nothing was written`);
        }
        const changeset = row.changesetId
          ? await tx.wikiChangesetOp.findMany({ where: { ownerId, changesetId: row.changesetId }, select: { op: true, entryId: true, resultEntryId: true } })
          : [];
        const entryIds = [...new Set(changeset.map((op) => (op.op === 'add' || op.op === 'supersede' ? op.resultEntryId : op.entryId)).filter((id): id is string => id !== null))];
        await followWikiDocsPress(tx, { ownerId, spaceId: row.spaceId, draftId: row.id, chatId: row.sessionId, sections: storedSections(row.rewrites), entryIds });
        await tx.wikiChatDraft.updateMany({ where: { id: row.id, ownerId }, data: { seenAt: null } });
        return { row };
      },
      loggedRetry(this.logger, 'wiki.retryChatDraft', { transaction: PRESS_TRANSACTION }),
    );
    this.realtime?.publishWikiChanged(ownerId, retried.row.spaceId);
    return { replayed: false, draft: await this.view(ownerId, draftId) };
  }

  /**
   * `POST /api/wiki/chat-drafts/:id/seen` (contract `chat.presses.seen`): the owner opened the card's settled rewrite. Set
   * once; a card with no settled rewrite answers without writing.
   */
  async seen(ownerId: string, userId: string, draftId: string, actingSessionId: string | null): Promise<WikiChatPressAnswer> {
    refuseActingSession(actingSessionId, 'marking a wiki chat\'s rewrite seen');
    void userId;
    const row = await this.prisma.wikiChatDraft.findFirst({ where: { id: draftId, ownerId }, select: DRAFT_SELECT });
    if (!row) throw new NotFoundException('no such card');
    const rewrite = (await draftRewrites(this.prisma, ownerId, [row])).get(row.id);
    let wrote = false;
    if (row.seenAt === null && rewrite?.settledAt) {
      const written = await this.prisma.wikiChatDraft.updateMany({ where: { id: row.id, ownerId, seenAt: null, decision: { in: ['applied', 'edited'] } }, data: { seenAt: new Date() } });
      wrote = written.count === 1;
    }
    if (wrote) this.realtime?.publishWikiChanged(ownerId, row.spaceId);
    return { replayed: !wrote && row.seenAt !== null, draft: await this.view(ownerId, draftId), seen: wrote || row.seenAt !== null };
  }
}

/** The neighbours a card's adds and supersedes resemble, each once, best first. */
function similarOf(ops: readonly StoredDraftOp[]): WikiSimilar[] {
  const out = new Map<string, WikiSimilar>();
  for (const op of ops) {
    for (const neighbour of op.similar ?? []) {
      const before = out.get(neighbour.id);
      if (!before || neighbour.score > before.score) out.set(neighbour.id, neighbour);
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}
