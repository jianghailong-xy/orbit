import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  WikiDocBlockKind,
  WikiDocFootnoteKind,
  WikiDocFootnoteView,
  WikiDocVerdict,
  WikiDocView,
} from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import type { WikiDocs } from '../wiki/wiki-docs';
import { linkNotFound, type ShareInclude } from './share-link';

/**
 * A wiki space as a public link shows it: docs/share-links-design.md §10 (what a wiki link opens and
 * its one layer), §6 (what no layer ever shows).
 *
 * The documents are read through the owner's own reads (`WikiDocs.directory`, `WikiDocs.doc`), so a
 * visitor sees the numbering, the leads and the sections the owner sees — and the answer is built
 * field by field from them. A field those reads gain later reaches a visitor only when somebody adds
 * it here. What never does: the commit a document or a footnote was read at, the model that wrote
 * it, the plan behind it, the entries its quotes came through, a sentence's marks and the ones
 * withdrawn, and every id, title and link a footnote names its record by — a visitor gets the words a
 * footnote quotes and where they are, never the way into the account they came from.
 * share-links/public-wiki.pg.spec.ts plants those values in the owner's data to show they stay out.
 */

/** A space's name as its pages say it: the last part of its repository's address (`orbit` for
 *  `github.com/acme/orbit`), else its title. The address itself is never part of a public answer. */
export function wikiSpaceName(space: { title: string; repoUrlNorm: string | null }): string {
  return (space.repoUrlNorm ?? '').split('/').filter(Boolean).pop() ?? space.title;
}

/** One written document as the home lists it. */
export interface PublicWikiDocRow {
  slug: string;
  /** `<category>.<place>`, as the owner's pages number it: `3.1`. */
  number: string;
  title: string;
  /** Its first sentences (contract `docs.lead`); null while it has none. */
  lead: string | null;
}

/** The link's root page: the space's written documents by category. A category with none written
 *  is left out, and so is every document not written yet: the plan behind them is the owner's. */
export interface PublicWiki {
  name: string;
  documents: number;
  categories: Array<{ key: string; number: number; title: string; docs: PublicWikiDocRow[] }>;
}

export interface PublicWikiSentence {
  text: string;
  /** Its footnotes' numbers — empty unless the link includes Footnotes. */
  notes: number[];
}

export interface PublicWikiBlock {
  kind: WikiDocBlockKind;
  /** A heading's or a code block's text; null for a paragraph or a list item. */
  text: string | null;
  sentences: PublicWikiSentence[];
}

export interface PublicWikiSection {
  key: string;
  number: number;
  title: string;
  blocks: PublicWikiBlock[];
}

/**
 * One footnote, with Footnotes on: the words it quotes and where they are — a repository file's path
 * and lines, or a record's kind, number and time. Never the commit, the record's id, or the session,
 * task or project it is in.
 */
export interface PublicWikiFootnote {
  n: number;
  kind: WikiDocFootnoteKind;
  verdict: WikiDocVerdict;
  quote: string | null;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  section: string | null;
  symbol: string | null;
  excerpt: string | null;
  seq: number | null;
  at: string | null;
  label: string | null;
  notePath: string | null;
}

/** One written document. `footnotes` only with the Footnotes layer. */
export interface PublicWikiDoc {
  slug: string;
  number: string;
  title: string;
  question: string;
  audience: string[];
  scopeIn: string[];
  /** What it leaves to other documents. A target's `slug` is set only when the link opens it. */
  scopeOut: Array<{ text: string; docs: Array<{ slug: string | null; number: string | null; title: string | null }> }>;
  category: { key: string; number: number; title: string };
  updatedAt: string | null;
  sections: PublicWikiSection[];
  footnotes?: PublicWikiFootnote[];
}

/** How much a wiki link holds: its written documents, and the footnotes their pages carry. */
export interface WikiShareCounts {
  documents: number;
  footnotes: number;
}

/**
 * The records a footnote may name whose words no layer ever shows (contract §6): a merge receipt's
 * details, and a project's owner decisions, which are its blockers. Their footnotes are left out
 * whole — a number with nothing behind it would only say something was hidden.
 */
const PRIVATE_RECORDS: ReadonlySet<WikiDocFootnoteKind> = new Set(['merge_receipt', 'owner_decision']);

/** The records whose `label` says what they are without saying anything of the account: a turn's
 *  kind, an event's type, a tool's name, whether a comment was an agent's, the tool an approval
 *  asked about. Every other record's label is dropped. */
const LABELLED: ReadonlySet<WikiDocFootnoteKind> = new Set(['turn', 'event', 'tool_call', 'task_comment', 'approval']);

/** The space's home: its written documents by category, in the plan's order. */
export async function readPublicWiki(docs: WikiDocs, ownerId: string, space: { id: string; name: string }): Promise<PublicWiki> {
  const directory = await docs.directory(ownerId, space.id);
  const categories = directory.categories
    .map((category) => ({
      key: category.key,
      number: category.number,
      title: category.title,
      docs: category.docs
        .filter((doc) => doc.written)
        .map((doc) => ({ slug: doc.slug, number: doc.number, title: doc.title, lead: doc.lead ?? null })),
    }))
    .filter((category) => category.docs.length > 0);
  return { name: space.name, documents: categories.reduce((sum, category) => sum + category.docs.length, 0), categories };
}

/** One written document of the space, or the one 404 — for a slug the plan does not have and one it
 *  has that nobody has written yet alike. */
export async function readPublicWikiDoc(
  docs: WikiDocs,
  ownerId: string,
  spaceId: string,
  include: Required<ShareInclude>,
  slug: string,
): Promise<PublicWikiDoc> {
  const directory = await docs.directory(ownerId, spaceId);
  const written = new Set(directory.categories.flatMap((category) => category.docs.filter((doc) => doc.written).map((doc) => doc.slug)));
  if (!written.has(slug)) throw linkNotFound();
  let view: WikiDocView;
  try {
    view = await docs.doc(ownerId, spaceId, slug);
  } catch (error) {
    // The plan confirmed again between the two reads, without this document: gone, as a dead link is.
    if (error instanceof NotFoundException) throw linkNotFound();
    throw error;
  }
  return publicWikiDoc(view, written, include.footnotes);
}

/**
 * The owner's view of a document, as a visitor reads it. Sections not written yet and sentences
 * withdrawn are left out, and with them a paragraph or list item left with no sentence; footnotes are
 * numbered again by where they first appear in what is left, so the numbers a visitor reads run 1, 2,
 * 3 with no gap where something was taken out.
 */
export function publicWikiDoc(view: WikiDocView, written: ReadonlySet<string>, footnotes: boolean): PublicWikiDoc {
  const notes = new Map(view.footnotes.filter((note) => !PRIVATE_RECORDS.has(note.kind)).map((note) => [note.n, note]));
  const renumbered = new Map<number, number>();
  const numberOf = (n: number): number => {
    let shown = renumbered.get(n);
    if (shown === undefined) {
      shown = renumbered.size + 1;
      renumbered.set(n, shown);
    }
    return shown;
  };
  const sections = view.sections
    .filter((section) => section.written)
    .map((section) => ({
      key: section.key,
      number: section.number,
      title: section.title,
      blocks: section.blocks
        .map((block) => ({
          kind: block.kind,
          text: block.text,
          sentences: block.sentences
            .filter((sentence) => sentence.status !== 'withdrawn')
            .map((sentence) => ({
              text: sentence.text,
              notes: footnotes ? sentence.notes.filter((n) => notes.has(n)).map(numberOf) : [],
            })),
        }))
        .filter((block) => block.kind === 'heading' || block.kind === 'code' || block.sentences.length > 0),
    }));
  return {
    slug: view.slug,
    number: view.number,
    title: view.title,
    question: view.question,
    audience: [...view.audience],
    scopeIn: [...view.scopeIn],
    scopeOut: view.scopeOut.map((scope) => ({
      text: scope.text,
      docs: scope.docs
        .filter((target) => target.number !== null || target.title !== null)
        .map((target) => ({ slug: written.has(target.slug) ? target.slug : null, number: target.number, title: target.title })),
    })),
    category: { key: view.category.key, number: view.category.number, title: view.category.title },
    updatedAt: view.updatedAt,
    sections,
    ...(footnotes
      ? {
        footnotes: [...renumbered.entries()]
          .sort((a, b) => a[1] - b[1])
          .map(([n, shown]) => publicFootnote(notes.get(n)!, shown)),
      }
      : {}),
  };
}

function publicFootnote(note: WikiDocFootnoteView, n: number): PublicWikiFootnote {
  return {
    n,
    kind: note.kind,
    verdict: note.verdict,
    quote: note.quote,
    path: note.path,
    lineStart: note.lineStart,
    lineEnd: note.lineEnd,
    section: note.section,
    symbol: note.symbol,
    excerpt: note.excerpt,
    seq: note.seq,
    at: note.at,
    label: LABELLED.has(note.kind) ? note.label : null,
    notePath: note.notePath,
  };
}

/**
 * How much a wiki link holds, for the Share dialog: the documents written for the confirmed plan, and
 * the footnotes their pages carry — counted the way a page numbers them (one original, place and quote
 * cited twice in a document is one footnote), over the plan's written sections and their sentences
 * not withdrawn, without the records no layer shows.
 */
export async function wikiShareCounts(prisma: PrismaService, docs: WikiDocs, ownerId: string, spaceId: string): Promise<WikiShareCounts> {
  const directory = await docs.directory(ownerId, spaceId);
  const written = directory.categories.flatMap((category) => category.docs.filter((doc) => doc.written));
  const sections = written.flatMap((doc) =>
    doc.sections.filter((section) => section.written).map((section) => Prisma.sql`(${doc.slug}, ${section.key})`));
  if (sections.length === 0) return { documents: written.length, footnotes: 0 };
  const [row] = await prisma.$queryRaw<Array<{ footnotes: number }>>(Prisma.sql`
    SELECT count(*)::int AS "footnotes" FROM (
      SELECT DISTINCT d."id", f."kind", f."ref", f."sha", f."line_start", f."line_end", f."char_start", f."char_end",
                      f."quote", f."verdict", f."via_entry_id"
        FROM "wiki_doc" d
        JOIN "wiki_doc_section" s ON s."doc_id" = d."id" AND s."owner_id" = d."owner_id"
        JOIN "wiki_doc_sentence" t ON t."section_id" = s."id" AND t."owner_id" = s."owner_id"
        JOIN "wiki_doc_footnote" f ON f."sentence_id" = t."id" AND f."owner_id" = t."owner_id"
       WHERE d."owner_id" = ${ownerId}::uuid AND d."space_id" = ${spaceId}::uuid
         AND (d."slug", s."key") IN (${Prisma.join(sections)})
         AND t."status" <> 'withdrawn'
         AND f."kind" NOT IN (${Prisma.join([...PRIVATE_RECORDS])})
    ) "notes"`);
  return { documents: written.length, footnotes: row?.footnotes ?? 0 };
}
