import type { Prisma } from '@prisma/client';
import { toUuid, uuidToBase62, WIKI_CHAT_READ, WIKI_CHAT_RULES, WIKI_DOCS_FOLLOW, WIKI_VOUCHED_TRUST } from '@orbit/shared';
import { addTwins } from '../common/public-id-body';
import { DRAFT_SELECT, draftViews } from './wiki-chat-cards';
import {
  confirmedPlan,
  contentsLines,
  PLAN_CARD_HOW,
  planDocDefinition,
  sentenceLines,
  WRITTEN_SECTION_SELECT,
  type PlanNoteDoc,
  type WikiChatSpaceRef,
  type WrittenSection,
} from './wiki-chat-notes';
import { numbering } from './wiki-docs';
import { WikiRefusalError } from './wiki.service';

/**
 * `wiki_read`: a wiki chat's read of its own space (contracts/wiki.contract.json `chat.read`; docs/wiki-contract.md §11 and
 * §22.8; design docs/wiki-chat-design.md §4.2; decision D10). What the owner sees of the wiki, so the agent finds a page for
 * itself rather than asking the owner to open it:
 *
 *   - no arguments: the contents, as `<orbit_wiki_contents>` lists them, in full;
 *   - `q`: the sections whose title, covers and sentences together hold every word, with the sentences that hold one;
 *   - `doc`: the document's whole definition in the confirmed plan (what a plan card's change.docs takes, covers and all) and
 *     every section's sentences with their footnotes; with `section`, that one section alone;
 *   - `draft`: a card of this chat as the card read serves it, and its rewrite's sentences before and after.
 *
 * Every answer opens with the header (WIKI_CHAT_READ.header) and says whether a draft of the plan waits for the owner (a plan
 * card is then refused WIKI_PLAN_STALE) and which writer jobs are queued or running. It is cut at a line at
 * WIKI_CHAT_RULES.readMaxChars and answers `more`, the cursor that reads on.
 *
 * A sentence written only from entries that are tainted and that nobody vouched for is left out, as wiki_get leaves such an
 * entry out; the entries the sentences of an answer came through are what the caller records as the read's exposure.
 *
 * Reads only.
 */

export interface WikiChatReadInput extends WikiChatSpaceRef {
  /** The chat that reads: a `draft` is one of its own cards. */
  sessionId: string;
  q?: string;
  doc?: string;
  section?: string;
  draft?: string;
  more?: string;
}

export type WikiChatReadView = 'contents' | 'search' | 'doc' | 'section' | 'draft';

export interface WikiChatReadAnswer {
  view: WikiChatReadView;
  /** The confirmed plan's version, or null when the space has none. */
  planVersion: number | null;
  /** A draft of the plan that waits for the owner: while there is one, wiki_draft refuses a plan card WIKI_PLAN_STALE. */
  planDraft: { version: number } | null;
  /** The space's jobs that write documents (docs.follow.writers), queued, waiting or running, oldest first. */
  writerJobs: Array<{ kind: string; state: string; createdAt: string; startedAt: string | null }>;
  /** The answer, opening with the header; at most WIKI_CHAT_RULES.readMaxChars characters. */
  text: string;
  /** Where the next part starts, to send back as `more` with the same other arguments; null when this part is the last. */
  more: string | null;
}

export interface WikiChatRead {
  answer: WikiChatReadAnswer;
  /** The entries the sentences of this part came through (footnotes' via entries): the read's exposure. */
  exposed: string[];
}

/** One line of an answer's body, and the entries the sentence it starts came through. */
interface Line {
  text: string;
  via?: readonly string[];
}

/** A line longer than this is split: a part always holds a whole line, and the cut is at a line. */
const LINE_MAX_CHARS = 10_000;
/** What a part keeps free for the line that says where it was cut. */
const TRAILER_RESERVE = 400;
/** The writer jobs an answer names, at most; more are counted. */
const WRITER_JOBS_LISTED = 20;
/** The cursor: the confirmed plan's version (0 with none), a colon, the line the next part starts at. */
const CURSOR = /^(\d{1,9}):(\d{1,9})$/u;

const WITHHELD = '(A sentence is left out here: it was written only from entries that rest on the web and that nobody vouched for.)';

const schema = (path: string, message: string) => new WikiRefusalError({
  code: 'WIKI_SCHEMA',
  message: `wiki_read: ${message}`,
  errors: [{ path, message }],
});

const blank = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim());

export async function readWikiChat(db: Prisma.TransactionClient, input: WikiChatReadInput): Promise<WikiChatRead> {
  const q = blank(input.q);
  const docSlug = blank(input.doc);
  const sectionKey = blank(input.section);
  const draftId = blank(input.draft);
  const asked = [q !== undefined && 'q', docSlug !== undefined && 'doc', draftId !== undefined && 'draft'].filter(Boolean);
  if (asked.length > 1) throw schema(String(asked[1]), `takes one of q, doc and draft, and was given ${asked.join(' and ')}`);
  if (sectionKey !== undefined && docSlug === undefined) throw schema('section', 'narrows a doc: give doc with it');
  let cursor: { version: number; line: number } | null = null;
  const more = blank(input.more);
  if (more !== undefined) {
    const parsed = CURSOR.exec(more);
    if (!parsed) throw schema('more', 'is the more cursor an answer gave, sent back as it was');
    cursor = { version: Number(parsed[1]), line: Number(parsed[2]) };
  }

  const plan = await confirmedPlan(db, input);
  const [planDraft, writerJobs] = await Promise.all([pendingPlanDraft(db, input, plan?.version ?? null), queuedWriters(db, input)]);

  let view: WikiChatReadView;
  let body: Line[];
  if (draftId !== undefined) {
    view = 'draft';
    body = await draftBody(db, input, draftId);
  } else if (docSlug !== undefined) {
    view = sectionKey === undefined ? 'doc' : 'section';
    body = await docBody(db, input, plan, docSlug, sectionKey);
  } else if (q !== undefined) {
    view = 'search';
    body = await searchBody(db, input, plan, q);
  } else {
    view = 'contents';
    body = plan
      ? [{ text: 'Contents: every document of the confirmed plan, and each section with whether it is written.' },
        ...(await contentsLines(db, input, plan))(false).map((text) => ({ text }))]
      : [{ text: 'This space has no confirmed plan yet, so it has no documents: the owner confirms one on the Plan page.' }];
  }

  const head = [
    WIKI_CHAT_READ.header,
    plan ? `Plan: version ${plan.version} is in force.` : 'Plan: none is confirmed.',
    planDraft
      ? `Plan draft: version ${planDraft.version} waits for the owner on the Plan page. Until they confirm or redraft it, wiki_draft `
        + 'refuses a plan card WIKI_PLAN_STALE: tell the owner that draft comes first.'
      : 'Plan draft: none waits for the owner.',
    writerJobs.length === 0
      ? 'Writer jobs: none queued or running in this space.'
      : `Writer jobs: ${writerJobs.slice(0, WRITER_JOBS_LISTED).map((job) => `${job.kind} ${job.state}`).join(', ')}`
        + `${writerJobs.length > WRITER_JOBS_LISTED ? `, and ${writerJobs.length - WRITER_JOBS_LISTED} more` : ''}.`,
  ].join('\n');

  const version = plan?.version ?? 0;
  const lines = split(body);
  let start = 0;
  const notes: string[] = [];
  if (cursor) {
    if (cursor.version !== version) {
      notes.push(`The plan moved from version ${cursor.version} to ${version} since the part before, so this answer starts over.`);
    } else if (cursor.line >= lines.length) {
      notes.push('Nothing more: the part before was the last.');
      start = lines.length;
    } else {
      start = cursor.line;
      notes.push(`Continued from line ${start + 1} of ${lines.length}.`);
    }
  }
  const part = cut(head, notes, lines, start, version);
  return {
    answer: {
      view,
      planVersion: plan?.version ?? null,
      planDraft,
      writerJobs,
      text: part.text,
      more: part.more,
    },
    exposed: [...new Set(part.lines.flatMap((line) => line.via ?? []))],
  };
}

/** Each line no longer than LINE_MAX_CHARS, its entries on its first piece. */
function split(body: readonly Line[]): Line[] {
  const out: Line[] = [];
  for (const line of body) {
    if (line.text.length <= LINE_MAX_CHARS) {
      out.push(line);
      continue;
    }
    for (let at = 0; at < line.text.length; at += LINE_MAX_CHARS) {
      out.push({ text: line.text.slice(at, at + LINE_MAX_CHARS), ...(at === 0 && line.via ? { via: line.via } : {}) });
    }
  }
  return out;
}

/**
 * The part of `lines` from `start` that fits in WIKI_CHAT_RULES.readMaxChars with the head; cut at a line, with a last line
 * saying how to read on. The cursor counts lines of the split body, which the same arguments build again.
 */
function cut(head: string, notes: readonly string[], lines: readonly Line[], start: number, version: number): { text: string; more: string | null; lines: Line[] } {
  const max = WIKI_CHAT_RULES.readMaxChars;
  const opening = [head, ...notes].join('\n');
  const rest = lines.slice(start);
  const whole = opening.length + rest.reduce((n, line) => n + 1 + line.text.length, 0);
  if (whole <= max) return { text: [opening, ...rest.map((line) => line.text)].join('\n'), more: null, lines: rest };
  const taken: Line[] = [];
  let length = opening.length;
  for (const line of rest) {
    if (length + 1 + line.text.length > max - TRAILER_RESERVE) break;
    taken.push(line);
    length += 1 + line.text.length;
  }
  const next = start + taken.length;
  const more = `${version}:${next}`;
  const trailer = `[Cut at ${max} characters: ${lines.length - next} more lines. Call wiki_read again with the same arguments and more "${more}" for the rest.]`;
  return { text: [opening, ...taken.map((line) => line.text), trailer].join('\n'), more, lines: taken };
}

/** The draft of the plan that waits for the owner, when there is one newer than the version in force (wiki-plan.ts checkCardChange). */
async function pendingPlanDraft(db: Prisma.TransactionClient, space: WikiChatSpaceRef, confirmed: number | null): Promise<{ version: number } | null> {
  const draft = await db.wikiPlan.findFirst({
    where: { ownerId: space.ownerId, spaceId: space.spaceId, status: 'draft' },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return draft && (confirmed === null || draft.version > confirmed) ? { version: draft.version } : null;
}

async function queuedWriters(db: Prisma.TransactionClient, space: WikiChatSpaceRef): Promise<WikiChatReadAnswer['writerJobs']> {
  const jobs = await db.wikiJob.findMany({
    where: { ownerId: space.ownerId, spaceId: space.spaceId, kind: { in: [...WIKI_DOCS_FOLLOW.writers] }, state: { in: ['queued', 'waiting', 'running'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { kind: true, state: true, createdAt: true, startedAt: true },
  });
  return jobs.map((job) => ({ kind: job.kind, state: job.state, createdAt: job.createdAt.toISOString(), startedAt: job.startedAt?.toISOString() ?? null }));
}

// ── Which sentences may be shown ─────────────────────────────────────────────────────────────────

interface ShownSentence {
  text: string;
  withdrawnAt: Date | null;
  footnotes: ReadonlyArray<Parameters<typeof sentenceLines>[0]['footnotes'][number]>;
}

/**
 * The via entries a set of sentences came through that are tainted, unvouched and active: what wiki_get leaves out
 * (WikiService.getEntry: tainted, trust not owner or confirmed, still active).
 */
async function unvouchedOf(db: Prisma.TransactionClient, ownerId: string, sentences: Iterable<ShownSentence>): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const sentence of sentences) for (const footnote of sentence.footnotes) if (footnote.viaEntryId) ids.add(footnote.viaEntryId);
  if (ids.size === 0) return new Set();
  const rows = await db.wikiEntry.findMany({
    where: { ownerId, id: { in: [...ids] }, tainted: true, status: 'active', trust: { notIn: [...WIKI_VOUCHED_TRUST] } },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

/** Left out: every footnote of it came through an entry that is tainted and unvouched (decision D10). */
const withheld = (sentence: ShownSentence, unvouched: ReadonlySet<string>): boolean =>
  sentence.footnotes.length > 0 && sentence.footnotes.every((footnote) => footnote.viaEntryId !== null && unvouched.has(footnote.viaEntryId));

/** A sentence's lines, indented, its via entries on the first; or the one line saying it was left out. */
function shownLines(sentence: ShownSentence, unvouched: ReadonlySet<string>, indent: string): Line[] {
  if (withheld(sentence, unvouched)) return [{ text: `${indent}${WITHHELD}` }];
  const via = [...new Set(sentence.footnotes.map((footnote) => footnote.viaEntryId).filter((id): id is string => id !== null))];
  return sentenceLines(sentence).map((text, index) => ({ text: `${indent}${text}`, ...(index === 0 && via.length > 0 ? { via } : {}) }));
}

// ── The views ──────────────────────────────────────────────────────────────────────────────────

type FullPlan = NonNullable<Awaited<ReturnType<typeof confirmedPlan>>>;

async function writtenOfSpace(db: Prisma.TransactionClient, space: WikiChatSpaceRef): Promise<Map<string, Map<string, WrittenSection>>> {
  const docs = await db.wikiDoc.findMany({
    where: { ownerId: space.ownerId, spaceId: space.spaceId },
    select: { slug: true, sections: { select: WRITTEN_SECTION_SELECT } },
  });
  return new Map(docs.map((doc) => [doc.slug, new Map(doc.sections.map((section) => [section.key, section]))]));
}

const writtenState = (section: WrittenSection | undefined): string => (section ? `written, repoSha ${section.repoSha}` : 'not written');

/**
 * `q`: the sections whose title, covers and sentences taken together hold every word of it, case folded, as substrings — no
 * stemming, no ranking, in the plan's order — each with the sentences that hold any of the words (decision D10). A sentence
 * left out is never matched.
 */
async function searchBody(db: Prisma.TransactionClient, space: WikiChatSpaceRef, plan: FullPlan | null, q: string): Promise<Line[]> {
  if (!plan) return [{ text: 'This space has no confirmed plan yet, so it has no documents to search: the owner confirms one on the Plan page.' }];
  const words = [...new Set(q.toLowerCase().split(/\s+/u).filter((word) => word !== ''))];
  const written = await writtenOfSpace(db, space);
  const unvouched = await unvouchedOf(db, space.ownerId, [...written.values()].flatMap((doc) => [...doc.values()].flatMap((section) => section.sentences)));
  const places = numbering(plan);
  const out: Line[] = [];
  let matched = 0;
  for (const doc of plan.docs) {
    doc.sections.forEach((section, index) => {
      const own = written.get(doc.slug)?.get(section.key);
      const sentences = (own?.sentences ?? []).filter((sentence) => !withheld(sentence, unvouched));
      const holds = (text: string, word: string) => text.toLowerCase().includes(word);
      const all = [section.title, section.covers, ...sentences.map((sentence) => sentence.text)].join('\n');
      if (!words.every((word) => holds(all, word))) return;
      matched += 1;
      out.push({ text: `${places.get(doc.slug)!.number} ${doc.slug} · ${doc.title} · §${index + 1} ${section.key} · ${section.title} · ${writtenState(own)}` });
      if (section.covers) out.push({ text: `  covers: ${section.covers}` });
      for (const sentence of sentences) {
        if (words.some((word) => holds(sentence.text, word))) out.push(...shownLines(sentence, unvouched, '  '));
      }
    });
  }
  const said = `Search for "${q}": ${matched === 0 ? 'no section' : matched === 1 ? '1 section' : `${matched} sections`} whose title, covers and sentences hold every word.`;
  if (matched === 0) return [{ text: said }, { text: 'wiki_read with no arguments lists every document and section.' }];
  return [{ text: said }, ...out];
}

/** `doc` and `section`: the document's definition in the confirmed plan, and its sentences with their footnotes. */
async function docBody(db: Prisma.TransactionClient, space: WikiChatSpaceRef, plan: FullPlan | null, slug: string, key: string | undefined): Promise<Line[]> {
  if (!plan) {
    throw new WikiRefusalError({
      code: 'WIKI_PLAN_UNCONFIRMED',
      message: 'wiki_read: this space has no confirmed plan, so it has no documents: the owner confirms one on the Plan page.',
    });
  }
  const planDoc: PlanNoteDoc | undefined = plan.docs.find((doc) => doc.slug === slug);
  if (!planDoc) throw schema('doc', `names no document of the confirmed plan (version ${plan.version}): wiki_read with no arguments lists them`);
  const index = key === undefined ? -1 : planDoc.sections.findIndex((section) => section.key === key);
  if (key !== undefined && index < 0) throw schema('section', `names no section of ${slug}: wiki_read with doc alone lists them`);
  const place = numbering(plan).get(planDoc.slug)!;
  const written = (await writtenOfSpace(db, space)).get(planDoc.slug) ?? new Map<string, WrittenSection>();
  const definition = planDocDefinition(planDoc);
  const shown = key === undefined ? planDoc.sections.map((section, i) => ({ section, i })) : [{ section: planDoc.sections[index]!, i: index }];
  const unvouched = await unvouchedOf(db, space.ownerId, shown.flatMap(({ section }) => written.get(section.key)?.sentences ?? []));
  const out: Line[] = [
    { text: `Document ${place.number} ${planDoc.slug} · ${planDoc.title} · ${place.category.title}, in plan version ${plan.version}` },
    {
      text: key === undefined
        ? 'Its definition, as a plan card\'s change.docs takes it:'
        : `Its definition, with section ${key} alone of its sections (read it without section for the whole, which a plan card sends):`,
    },
    ...JSON.stringify(key === undefined ? definition : { ...definition, sections: definition.sections.filter((section) => section.key === key) }, null, 2)
      .split('\n').map((text) => ({ text })),
    { text: PLAN_CARD_HOW },
  ];
  for (const { section, i } of shown) {
    const own = written.get(section.key);
    out.push({ text: `§${i + 1} ${section.key} · ${section.title} · ${writtenState(own)}` });
    if (!own) continue;
    for (const sentence of own.sentences) out.push(...shownLines(sentence, unvouched, ''));
  }
  return out;
}

/** A kept version's sentences, each with its footnotes, as the version stored them (`notes` the places in `footnotes`). */
function keptSentences(raw: { sentences: unknown; footnotes: unknown }): ShownSentence[] {
  const footnotes = Array.isArray(raw.footnotes) ? (raw.footnotes as Array<Record<string, unknown>>) : [];
  const sentences = Array.isArray(raw.sentences) ? (raw.sentences as Array<Record<string, unknown>>) : [];
  return sentences.map((sentence) => ({
    text: String(sentence.text ?? ''),
    withdrawnAt: sentence.withdrawn ? new Date(0) : null,
    footnotes: (Array.isArray(sentence.notes) ? (sentence.notes as unknown[]) : [])
      .map((at) => footnotes[Number(at)])
      .filter((note): note is Record<string, unknown> => note !== undefined && note !== null)
      .map((note) => ({
        kind: String(note.kind ?? ''),
        ref: String(note.ref ?? ''),
        sha: typeof note.sha === 'string' ? note.sha : null,
        lineStart: typeof note.lineStart === 'number' ? note.lineStart : null,
        lineEnd: typeof note.lineEnd === 'number' ? note.lineEnd : null,
        locator: (note.locator ?? null) as Prisma.JsonValue,
        viaEntryId: typeof note.viaEntryId === 'string' ? note.viaEntryId : null,
      })),
  }));
}

/** `draft`: a card of this chat as the card read serves it, and each section its rewrite wrote, before and now. */
async function draftBody(db: Prisma.TransactionClient, input: WikiChatReadInput, id: string): Promise<Line[]> {
  let uuid: string;
  try {
    uuid = toUuid(id);
  } catch {
    throw schema('draft', 'names no card of this chat');
  }
  const row = await db.wikiChatDraft.findFirst({
    where: { id: uuid, ownerId: input.ownerId, spaceId: input.spaceId, sessionId: input.sessionId },
    select: DRAFT_SELECT,
  });
  if (!row) throw schema('draft', 'names no card of this chat');
  const [view] = await draftViews(db, input.ownerId, [row]);
  const out: Line[] = [
    { text: `Card ${uuidToBase62(row.id)} · ${view!.label} · ${view!.state}` },
    // A clone: addTwins rewrites ids in place, and the versionIds below are read as the UUIDs they are.
    ...JSON.stringify(addTwins(structuredClone(view), true), null, 2).split('\n').map((text) => ({ text })),
  ];
  const sections = view!.rewrite?.sections ?? [];
  if (sections.length === 0) return out;
  const kept = await db.wikiDocSectionVersion.findMany({
    where: { ownerId: input.ownerId, spaceId: input.spaceId, id: { in: sections.map((s) => s.versionId).filter((one): one is string => one !== null) } },
    select: { id: true, sentences: true, footnotes: true },
  });
  const keptOf = new Map(kept.map((one) => [one.id, keptSentences(one)]));
  const written = await writtenOfSpace(db, input);
  const before = sections.map((s) => (s.versionId ? keptOf.get(s.versionId) ?? [] : []));
  const now = sections.map((s) => (s.result === 'updated' || s.result === 'same' ? written.get(s.doc)?.get(s.key)?.sentences ?? [] : []));
  const unvouched = await unvouchedOf(db, input.ownerId, [...before.flat(), ...now.flat()]);
  out.push({ text: 'Its rewrite, section by section: the sentences before it and as they stand now.' });
  sections.forEach((s, i) => {
    out.push({ text: `${s.where} · ${s.result ?? view!.rewrite!.result}${s.changed !== null ? `, ${s.changed} changed` : ''}` });
    if (s.result !== 'updated' && s.result !== 'same') {
      out.push({ text: '  Not written by this rewrite.' });
      return;
    }
    out.push({ text: s.versionId ? '  Before:' : '  Before: no version was kept, so this is its first writing.' });
    for (const sentence of before[i]!) out.push(...shownLines(sentence, unvouched, '    '));
    out.push({ text: '  Now:' });
    for (const sentence of now[i]!) out.push(...shownLines(sentence, unvouched, '    '));
  });
  return out;
}
