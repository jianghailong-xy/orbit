import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  toUuid,
  uuidToBase62,
  WIKI_CHAT_NOTE_TAGS,
  WIKI_CHAT_PROMPT,
  WIKI_VOUCHED_TRUST,
  wikiChatContextErrors,
  wikiChatNoteAttribute,
  type WikiChatContext,
} from '@orbit/shared';
import { addTwins } from '../common/public-id-body';
import { draftsNote } from './wiki-chat-cards';
import { numbering, PLAN_SELECT } from './wiki-docs';
import { ENTRY_SELECT, entryView } from './wiki.service';

/**
 * What delivery appends to a wiki chat's message (contracts/wiki.contract.json `chat.notes`, docs/wiki-contract.md
 * §28.4): the chat's standing rules on its first message, and the page and the selection the message carried, read
 * NOW from the ids the message door kept (`conversation_turn.wiki_context`). Appended after the owner's words, like
 * every block of the control plane's (runner-api/control-plane-note.ts), so the turn's content stays those words
 * alone and the runner's echo records the rest as the note a client draws as "Orbit attached:".
 *
 * Read through the delivery's own transaction, from the rows the documents read serves, so a sentence is the one
 * the page shows when the turn is handed out: a section written again since the message was sent shows its new
 * sentences, and a selected sentence it no longer holds is left out and said so, never guessed. No text the client
 * sent is ever read — only ids.
 *
 * Ids are written as public ids: this is text an agent reads and hands back to the wiki's tools, which take them.
 *
 * And after the owner pressed a card, the next message tells the agent what became of it (`<orbit_wiki_drafts>`,
 * `wiki-chat-cards.ts#draftsNote`), so the agent never learns it from a turn of its own.
 */

/** One chat turn being handed to its runner. */
export interface WikiChatDelivery {
  ownerId: string;
  spaceId: string;
  sessionId: string;
  turn: { seq: number; kind: string; wikiContext: unknown };
}

/** The space a read is of: what the notes and `wiki_read` (wiki-chat-read.ts) read the plan and the sentences by. */
export type WikiChatSpaceRef = Pick<WikiChatDelivery, 'ownerId' | 'spaceId'>;

/** The header of `<orbit_wiki_contents>`: what the note is, and what it is not. */
export const WIKI_CONTENTS_HEADER = "This is a view of the wiki's structure, not a source: it names the pages and says which sections are written. "
  + 'Read a page for its sentences, and never cite this list.';

/** The most characters the contents note's body holds; a larger plan is listed by section key and written-or-not only. */
export const WIKI_CHAT_CONTENTS_MAX_CHARS = 30_000;

/** The digest a chat's delivery records of the `<orbit_wiki_chat>` text it handed out (session.wiki_chat_prompt_digest). */
export const WIKI_CHAT_PROMPT_DIGEST = createHash('sha256').update(WIKI_CHAT_PROMPT).digest('hex');

/**
 * The delivered text with the chat's blocks after the owner's words, or `content` as it was when the turn needs
 * none. `<orbit_wiki_chat>` rides on the chat's first message (contract `chat.notes.chat.when`) — the one no message
 * or steer of the session precedes — and on the first message after its text changed; `<orbit_wiki_contents>` on the
 * first message and on the first after the confirmed plan's version changed (`chat.notes.contents.when`). Both markers
 * are written in this transaction, so a claim rolled back sends both again. The page and the selection ride on any
 * message or steer that carried them.
 */
export async function appendWikiChatNotes(
  tx: Prisma.TransactionClient,
  delivery: WikiChatDelivery,
  content: string | undefined,
): Promise<string | undefined> {
  const blocks: string[] = [];
  if (delivery.turn.kind === 'message') {
    const told = await tx.session.findUnique({
      where: { id: delivery.sessionId },
      select: { wikiChatPromptDigest: true, wikiChatContentsVersion: true },
    });
    const opens = await opensTheChat(tx, delivery.sessionId, delivery.turn.seq);
    const marks: { wikiChatPromptDigest?: string; wikiChatContentsVersion?: number } = {};
    if (opens || told?.wikiChatPromptDigest !== WIKI_CHAT_PROMPT_DIGEST) {
      blocks.push(WIKI_CHAT_PROMPT);
      marks.wikiChatPromptDigest = WIKI_CHAT_PROMPT_DIGEST;
    }
    const plan = await confirmedPlanLight(tx, delivery);
    if (plan && (opens || told?.wikiChatContentsVersion !== plan.version)) {
      blocks.push(await contentsNote(tx, delivery, plan));
      marks.wikiChatContentsVersion = plan.version;
    }
    if (Object.keys(marks).length > 0) await tx.session.updateMany({ where: { id: delivery.sessionId }, data: marks });
  }
  const context = storedContext(delivery.turn.wikiContext);
  if (context?.page?.kind === 'doc') blocks.push(await docPageNote(tx, delivery, context.page));
  if (context?.page?.kind === 'entry') blocks.push(await entryPageNote(tx, delivery, context.page.entryId));
  if (context?.page?.kind === 'plan') blocks.push(await planPageNote(tx, delivery, context.page));
  if (context?.selection) blocks.push(await selectionNote(tx, delivery, context.selection));
  // What the owner pressed since the agent was last told (contract `chat.notes.drafts`): with this message, never as a
  // turn of its own. Stamped in this delivery's transaction, so a claim rolled back tells the next delivery instead.
  if (delivery.turn.kind === 'message' || delivery.turn.kind === 'steer') {
    const drafts = await draftsNote(tx, { ownerId: delivery.ownerId, sessionId: delivery.sessionId });
    if (drafts) blocks.push(drafts);
  }
  if (blocks.length === 0) return content;
  return [content ?? '', ...blocks].join('\n\n');
}

/** Whether this is the chat's first message: no message or steer of the session comes before it. */
async function opensTheChat(tx: Prisma.TransactionClient, sessionId: string, seq: number): Promise<boolean> {
  const earlier = await tx.conversationTurn.findFirst({
    where: { sessionId, seq: { lt: seq }, kind: { in: ['message', 'steer'] } },
    select: { id: true },
  });
  return earlier === null;
}

/** The stored context, held to the shape its door held it to; anything else is read as none. */
function storedContext(value: unknown): WikiChatContext | null {
  if (value === null || value === undefined || wikiChatContextErrors(value).length > 0) return null;
  return value as WikiChatContext;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A public id or a UUID as the UUID it names, or null for anything that names no row. */
function uuidOf(id: string): string | null {
  try {
    return toUuid(id);
  } catch {
    return null;
  }
}

/** An id as the text names it: a UUID's public id, anything else as it is. */
function publicIdOf(id: string): string {
  return UUID_SHAPE.test(id) ? uuidToBase62(id.toLowerCase()) : id;
}

/** A block: the opening tag with its attributes, its lines, its closing tag. */
function block(tag: string, attributes: ReadonlyArray<readonly [string, string | number]>, body: readonly string[]): string {
  const head = attributes.length === 0
    ? `<${tag}>`
    : `<${tag} ${attributes.map(([name, value]) => wikiChatNoteAttribute(name, value)).join(' ')}>`;
  return [head, ...body, `</${tag}>`].join('\n');
}

/**
 * The confirmed plan, with what the plan page attaches of a document besides what the documents read numbers: every
 * field a plan card's change sends back (contract `agentSurface.chat.draft.params.change`).
 */
const PLAN_NOTE_SELECT = {
  ...PLAN_SELECT,
  docs: {
    ...PLAN_SELECT.docs,
    select: {
      ...PLAN_SELECT.docs.select,
      protected: true,
      extra: true,
      sections: {
        ...PLAN_SELECT.docs.select.sections,
        select: { ...PLAN_SELECT.docs.select.sections.select, covers: true, length: true, sources: true, extra: true },
      },
    },
  },
} satisfies Prisma.WikiPlanSelect;

/**
 * What a plan page's note tells the agent of a plan card (contract `chat.notes.page.body`, design §6's third row): the
 * server's own words, so an agent reads how one card changes several documents (C17) without a runner release.
 */
export const PLAN_CARD_HOW = 'To change how this document is planned, draft a plan card: wiki_draft with kind plan, a reason, and as change.docs '
  + 'the documents as they should read — this doc with every field as it is here and the ones you change changed, and any other '
  + 'document the change touches, whole. To split this document, send it without the sections that move, and a new document '
  + '(a slug of its own, its category, question, audience, scope and sections) holding them: one card, one press, both '
  + 'documents at once. A category the plan does not have goes in change.categories. A writing requirement goes into the '
  + 'covers of the sections it is for: the writer reads covers, and a section\'s fingerprint holds them, so the next rewrite '
  + 'keeps the requirement. Nothing changes until the owner applies the card, which confirms and rebuilds the plan.';

/** An object with nothing in it is left out of a definition, as the plan's own reads leave out an empty extra. */
const extraOf = (extra: unknown): Record<string, unknown> =>
  extra !== null && typeof extra === 'object' && !Array.isArray(extra) && Object.keys(extra).length > 0 ? { extra } : {};

export async function confirmedPlan(tx: Prisma.TransactionClient, delivery: WikiChatSpaceRef) {
  return tx.wikiPlan.findFirst({
    where: { ownerId: delivery.ownerId, spaceId: delivery.spaceId, status: 'confirmed' },
    select: PLAN_NOTE_SELECT,
  });
}

/** The confirmed plan as the contents note needs it: documents and section titles, nothing that is written in them. */
export async function confirmedPlanLight(tx: Prisma.TransactionClient, delivery: WikiChatSpaceRef) {
  return tx.wikiPlan.findFirst({
    where: { ownerId: delivery.ownerId, spaceId: delivery.spaceId, status: 'confirmed' },
    select: PLAN_SELECT,
  });
}

/**
 * `<orbit_wiki_contents>`: the wiki's structure as the confirmed plan holds it, with which sections are written — every
 * document's number, slug, title and category, and each section's key, title, whether it is written and the repoSha it was
 * written from. No covers and no sentences: it is a view of where things are, not a source (contract `chat.notes.contents`).
 * One light read of the section rows (key and repoSha), never `writtenSections`, which loads every sentence.
 */
async function contentsNote(
  tx: Prisma.TransactionClient,
  delivery: WikiChatDelivery,
  plan: NonNullable<Awaited<ReturnType<typeof confirmedPlanLight>>>,
): Promise<string> {
  const lines = await contentsLines(tx, delivery, plan);
  // Past the cap a section is named by its key and whether it is written, which is all a page is found by.
  let body = [WIKI_CONTENTS_HEADER, ...lines(false)];
  if (body.join('\n').length > WIKI_CHAT_CONTENTS_MAX_CHARS) body = [WIKI_CONTENTS_HEADER, ...lines(true)];
  return block(WIKI_CHAT_NOTE_TAGS.contents, [['planVersion', plan.version]], body);
}

/**
 * The contents' lines, without a header: per document its number, slug, title and category, and per section its number, key,
 * title (left out when `compact`), whether it is written and the repoSha it was written from. Shared by the contents note and
 * `wiki_read` with no arguments (wiki-chat-read.ts), which always lists in full and cuts with `more` instead.
 */
export async function contentsLines(
  tx: Prisma.TransactionClient,
  delivery: WikiChatSpaceRef,
  plan: NonNullable<Awaited<ReturnType<typeof confirmedPlanLight>>>,
): Promise<(compact: boolean) => string[]> {
  const rows = await tx.wikiDoc.findMany({
    where: { ownerId: delivery.ownerId, spaceId: delivery.spaceId },
    select: { slug: true, sections: { select: { key: true, repoSha: true } } },
  });
  const written = new Map(rows.map((doc) => [doc.slug, new Map(doc.sections.map((section) => [section.key, section.repoSha]))]));
  const places = numbering(plan);
  return (compact: boolean): string[] => {
    const out: string[] = [];
    for (const doc of plan.docs) {
      const place = places.get(doc.slug)!;
      out.push(`${place.number} ${doc.slug} · ${doc.title} · ${place.category.title}`);
      doc.sections.forEach((section, index) => {
        const sha = written.get(doc.slug)?.get(section.key);
        const state = sha === undefined ? 'not written' : compact ? 'written' : `written, repoSha ${sha.slice(0, 12)}`;
        out.push(`  §${index + 1} ${section.key} · ${compact ? '' : `${section.title} · `}${state}`);
      });
    }
    return out;
  };
}

/** A written section as the notes and `wiki_read` read it: its key, the repoSha it was written from, its sentences in order with their footnotes. */
export const WRITTEN_SECTION_SELECT = {
  key: true,
  repoSha: true,
  sentences: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      text: true,
      withdrawnAt: true,
      footnotes: {
        orderBy: { position: 'asc' },
        select: { kind: true, ref: true, sha: true, lineStart: true, lineEnd: true, locator: true, viaEntryId: true },
      },
    },
  },
} satisfies Prisma.WikiDocSectionSelect;

/** A document's written sections, by key, with their sentences in order and each sentence's footnotes. */
export async function writtenSections(tx: Prisma.TransactionClient, delivery: WikiChatSpaceRef, slug: string) {
  const doc = await tx.wikiDoc.findFirst({
    where: { ownerId: delivery.ownerId, spaceId: delivery.spaceId, slug },
    select: { sections: { select: WRITTEN_SECTION_SELECT } },
  });
  return new Map((doc?.sections ?? []).map((section) => [section.key, section]));
}

export type WrittenSection = Prisma.WikiDocSectionGetPayload<{ select: typeof WRITTEN_SECTION_SELECT }>;
export type WrittenSentence = WrittenSection['sentences'][number];
type Footnote = Pick<WrittenSentence['footnotes'][number], 'kind' | 'ref' | 'sha' | 'lineStart' | 'lineEnd' | 'locator' | 'viaEntryId'>;

/**
 * A footnote as the selection note spells it (contract `chat.notes.selection.body`): a repository original as
 * path@sha#Lstart-end, a record as `<kind> <record id> in session <session id>`, and the entry it came through as
 * `via entry <id>`.
 */
export function footnoteLine(footnote: Footnote): string {
  const via = footnote.viaEntryId ? `, via entry ${uuidToBase62(footnote.viaEntryId)}` : '';
  if (footnote.sha !== null) return `${footnote.ref}@${footnote.sha}#L${footnote.lineStart}-${footnote.lineEnd}${via}`;
  const session = (footnote.locator as { sessionId?: unknown } | null)?.sessionId;
  const where = typeof session === 'string' && session !== '' ? ` in session ${publicIdOf(session)}` : '';
  return `${footnote.kind} ${publicIdOf(footnote.ref)}${where}${via}`;
}

/** A sentence and, under it, its footnotes. A withdrawn one is shown as the page shows it: there, and withdrawn. */
export function sentenceLines(sentence: Pick<WrittenSentence, 'text' | 'withdrawnAt'> & { footnotes: readonly Footnote[] }): string[] {
  return [
    sentence.withdrawnAt ? `${sentence.text} (withdrawn)` : sentence.text,
    ...sentence.footnotes.map((footnote) => `  - ${footnoteLine(footnote)}`),
  ];
}

/** `<orbit_wiki_page of="doc">`: the section's title, and its sentences as the documents read serves them now. */
async function docPageNote(
  tx: Prisma.TransactionClient,
  delivery: WikiChatDelivery,
  page: { docSlug: string; sectionKey: string },
): Promise<string> {
  const plan = await confirmedPlan(tx, delivery);
  const planDoc = plan?.docs.find((doc) => doc.slug === page.docSlug);
  const index = planDoc ? planDoc.sections.findIndex((section) => section.key === page.sectionKey) : -1;
  if (!plan || !planDoc || index < 0) {
    return block(WIKI_CHAT_NOTE_TAGS.page, [['of', 'doc'], ['slug', page.docSlug], ['key', page.sectionKey]], [
      `The page the owner had open, section ${page.sectionKey} of ${page.docSlug}, is not in this space's confirmed plan `
        + 'any more, so nothing of it is attached.',
    ]);
  }
  const number = numbering(plan).get(planDoc.slug)!.number;
  const planSection = planDoc.sections[index]!;
  const written = (await writtenSections(tx, delivery, planDoc.slug)).get(planSection.key);
  const heading = `${number} ${planDoc.title} · §${index + 1} ${planSection.title}`;
  return block(
    WIKI_CHAT_NOTE_TAGS.page,
    [
      ['of', 'doc'], ['doc', number], ['slug', planDoc.slug], ['section', index + 1], ['key', planSection.key],
      ...(written ? [['repoSha', written.repoSha] as const] : []),
    ],
    written
      ? [heading, ...written.sentences.flatMap(sentenceLines)]
      : [heading, 'This section is in the plan and not written yet, so it has no sentences.'],
  );
}

/** `<orbit_wiki_page of="entry">`: the entry as `wiki_get` answers a session of this space. */
async function entryPageNote(tx: Prisma.TransactionClient, delivery: WikiChatDelivery, entryId: string): Promise<string> {
  const id = uuidOf(entryId);
  const entry = id === null
    ? null
    : await tx.wikiEntry.findFirst({
        where: {
          id,
          ownerId: delivery.ownerId,
          spaceId: delivery.spaceId,
          // What a session of this space may read of it, as wiki_get serves it (WikiService.getEntry).
          OR: [{ tainted: false }, { trust: { in: [...WIKI_VOUCHED_TRUST] } }, { status: { not: 'active' } }],
        },
        select: ENTRY_SELECT,
      });
  if (!entry) {
    return block(WIKI_CHAT_NOTE_TAGS.page, [['of', 'entry'], ['entry', entryId], ['title', entryId]], [
      `No entry of this space's wiki is ${entryId}, so nothing of it is attached.`,
    ]);
  }
  return block(
    WIKI_CHAT_NOTE_TAGS.page,
    [['of', 'entry'], ['entry', uuidToBase62(entry.id)], ['title', entry.title]],
    [JSON.stringify(addTwins(entryView(entry), true), null, 2)],
  );
}

export type PlanNoteDoc = NonNullable<Awaited<ReturnType<typeof confirmedPlan>>>['docs'][number];

/** A document's whole definition in the confirmed plan, as a plan card's change takes it (`change.docs[]`), covers and all. */
export function planDocDefinition(planDoc: PlanNoteDoc) {
  return {
    category: planDoc.category,
    slug: planDoc.slug,
    title: planDoc.title,
    question: planDoc.question,
    audience: planDoc.audience,
    scopeIn: planDoc.scopeIn,
    scopeOut: planDoc.scopeOut,
    length: { min: planDoc.lengthMin, max: planDoc.lengthMax },
    ...(planDoc.protected ? { protected: true } : {}),
    ...extraOf(planDoc.extra),
    sections: planDoc.sections.map((section) => ({
      key: section.key, title: section.title, kind: section.kind, covers: section.covers, length: section.length, sources: section.sources,
      ...extraOf(section.extra),
    })),
  };
}

/**
 * `<orbit_wiki_page of="plan">`: the document's whole definition in the confirmed plan, which a session cannot read —
 * as a plan card's change takes it (`doc`), with the version, the document's number, the section the page shows, and how
 * a plan card changes it (contract `chat.notes.page`).
 */
async function planPageNote(tx: Prisma.TransactionClient, delivery: WikiChatDelivery, page: { docSlug: string; sectionKey?: string }): Promise<string> {
  const plan = await confirmedPlan(tx, delivery);
  const planDoc = plan?.docs.find((doc) => doc.slug === page.docSlug);
  if (!plan || !planDoc) {
    return block(WIKI_CHAT_NOTE_TAGS.page, [['of', 'plan'], ['doc', page.docSlug], ['slug', page.docSlug]], [
      `The plan page the owner had open, document ${page.docSlug}, is not in this space's confirmed plan any more, so nothing `
        + 'of it is attached.',
    ]);
  }
  const place = numbering(plan).get(planDoc.slug)!;
  const index = page.sectionKey === undefined ? -1 : planDoc.sections.findIndex((section) => section.key === page.sectionKey);
  const shown = index >= 0 ? planDoc.sections[index]! : null;
  const definition = {
    planVersion: plan.version,
    number: place.number,
    categoryTitle: place.category.title,
    ...(shown ? { section: { number: index + 1, key: shown.key, title: shown.title } } : {}),
    ...(page.sectionKey !== undefined && !shown ? { sectionGone: `The section the owner had open, ${page.sectionKey}, is not in this document any more.` } : {}),
    howToChange: PLAN_CARD_HOW,
    doc: planDocDefinition(planDoc),
  };
  return block(
    WIKI_CHAT_NOTE_TAGS.page,
    [['of', 'plan'], ['doc', place.number], ['slug', planDoc.slug], ...(shown ? [['section', index + 1] as const, ['key', shown.key] as const] : [])],
    [JSON.stringify(definition, null, 2)],
  );
}

/**
 * `<orbit_wiki_selection>`: each selected sentence the document still holds, in reading order under its section's
 * title, with its footnotes; then the ones it no longer holds, named and left out.
 */
async function selectionNote(
  tx: Prisma.TransactionClient,
  delivery: WikiChatDelivery,
  selection: { docSlug: string; sectionKey: string; sentenceIds: string[] },
): Promise<string> {
  const plan = await confirmedPlan(tx, delivery);
  const planDoc = plan?.docs.find((doc) => doc.slug === selection.docSlug);
  if (!plan || !planDoc) {
    return block(
      WIKI_CHAT_NOTE_TAGS.selection,
      [['doc', selection.docSlug], ['slug', selection.docSlug], ['section', selection.sectionKey], ['key', selection.sectionKey], ['sentences', 0], ['sources', 0]],
      [
        `The document the owner selected ${selection.sentenceIds.length === 1 ? 'a sentence' : `${selection.sentenceIds.length} sentences`} `
          + `in, ${selection.docSlug}, is not in this space's confirmed plan any more, so none of them is attached.`,
      ],
    );
  }
  const number = numbering(plan).get(planDoc.slug)!.number;
  const written = await writtenSections(tx, delivery, planDoc.slug);
  const wanted = new Set(selection.sentenceIds.map(uuidOf).filter((id): id is string => id !== null));
  const found: Array<{ index: number; title: string; sentence: WrittenSentence }> = [];
  planDoc.sections.forEach((planSection, index) => {
    for (const sentence of written.get(planSection.key)?.sentences ?? []) {
      if (wanted.has(sentence.id)) found.push({ index, title: planSection.title, sentence });
    }
  });
  const held = new Set(found.map((item) => item.sentence.id));
  const missing = selection.sentenceIds.filter((id) => !held.has(uuidOf(id) ?? ''));
  const start = planDoc.sections.findIndex((section) => section.key === selection.sectionKey);
  const indexes = [...(start >= 0 ? [start] : []), ...found.map((item) => item.index)];
  const first = indexes.length > 0 ? Math.min(...indexes) : -1;
  const last = indexes.length > 0 ? Math.max(...indexes) : -1;
  const repoSha = first >= 0 ? written.get(planDoc.sections[first]!.key)?.repoSha : undefined;
  const sources = new Set(found.flatMap((item) => item.sentence.footnotes.map(footnoteLine))).size;
  const body: string[] = [];
  let section = -1;
  for (const item of found) {
    if (item.index !== section) {
      body.push(`§${item.index + 1} ${item.title}`);
      section = item.index;
    }
    body.push(...sentenceLines(item.sentence));
  }
  if (missing.length > 0) {
    const one = missing.length === 1;
    body.push(
      `Left out: ${one ? 'a selected sentence' : `${missing.length} selected sentences`} the document no longer holds `
        + `(${missing.join(', ')}): the section was written again after the owner selected ${one ? 'it' : 'them'}.`,
    );
  }
  return block(
    WIKI_CHAT_NOTE_TAGS.selection,
    [
      ['doc', number], ['slug', planDoc.slug], ['section', first >= 0 ? first + 1 : selection.sectionKey], ['key', selection.sectionKey],
      ...(last > first ? [['to', last + 1] as const] : []),
      ['sentences', found.length], ['sources', sources],
      ...(repoSha ? [['repoSha', repoSha] as const] : []),
    ],
    body,
  );
}
