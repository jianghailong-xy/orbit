import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WikiDocView, WikiDocsDirectory, WikiDocsIndexItem } from '@orbit/shared';
import {
  WIKI_BROWSE_SECTIONS_SHOWN_PHONE,
  WIKI_DIRECTORY_PLAN,
  WIKI_DOC_COVERS,
  WIKI_DOC_ENTRIES,
  WIKI_DOC_FOOTNOTES,
  WIKI_DOC_GROUP_SHOWN_PHONE,
  WIKI_DOC_NEEDS_REVIEW,
  WIKI_DOC_NOT_COVERED,
  WIKI_DOC_NOT_WRITTEN,
  WIKI_DOC_NOT_WRITTEN_SHORT,
  WIKI_DOC_QUESTION,
  WIKI_DOC_SCOPE_FOLDED,
  WIKI_DOC_SECTIONS,
  WIKI_DOC_SECTION_NOT_WRITTEN,
  WIKI_DOC_WRITTEN_FOR,
  WIKI_EXCERPT_LINES_PHONE,
  WIKI_FOOTNOTES_SHOWN,
  WIKI_FOOTNOTE_CARD_PARTS,
  WIKI_FOOTNOTE_KIND_LABELS,
  WIKI_MARK_LABELS,
  WIKI_MARK_NOT_VERIFIED,
  WIKI_MARK_NO_SOURCE,
  WIKI_MARK_WITHDRAWN,
  WIKI_NEXT_MARKED,
  WIKI_NO_QUOTE_GIVEN,
  WIKI_OPEN_THE_ENTRY,
  WIKI_REWRITE_PENDING,
  WIKI_SECTION_KIND_LABELS,
  WIKI_VERDICT_CARD,
  WIKI_VERDICT_LIST,
  WIKI_VIA_ENTRY,
  wikiDocDirectoryGroups,
  wikiDocEntriesHint,
  wikiDocEntryGroups,
  wikiDocLegend,
  wikiDocNeedsReviewText,
  wikiDocNotWrittenNote,
  wikiDocPath,
  wikiDocRewriteNote,
  wikiDocScopeCounts,
  wikiDocSectionPath,
  wikiDocTags,
  wikiDocUpdatedParts,
  wikiDocUpdatedWarn,
  wikiDocsBrowseSummary,
  wikiDocsCategoryLine,
  wikiDocsDocLine,
  wikiDocsIndexGroups,
  wikiDocsIndexMeta,
  wikiDocsIndexPath,
  wikiDocsIndexSummary,
  wikiExcerptLines,
  wikiFootnoteIsRepo,
  wikiFootnoteOpen,
  wikiFootnotePlace,
  wikiFootnoteProblem,
  wikiFootnoteSubLabel,
  wikiFootnoteWhere,
  wikiFootnotesSummary,
  wikiGithubRepo,
  wikiLineRange,
  wikiMarkNote,
  wikiMonthDayTime,
  wikiMoreLines,
  wikiMoreSections,
  wikiQuoted,
  wikiReadsByDocs,
  wikiScopeTarget,
  wikiSectionList,
  wikiSeeFootnote,
  wikiSentenceMark,
  wikiViaEntryNote,
  wikiViaEntryStatus,
} from './wikiDocs';

/**
 * The documents' words and readings (criterion 10 revised, mocks 23–28), proved against the `docs` half of
 * `src/shared/src/wiki-docs.fixture.json` — the same cases OrbitKit's `WikiDocsCopyParityTests` reads, so a
 * document's page, its marks and footnotes, the directory, Browse and the A–Z index say and count the same
 * things on the web phone and on iOS.
 */

interface Says<T = number> {
  n: T;
  says: string;
}

interface Fixture {
  timeZone: string;
  docs: {
    words: Record<string, unknown> & {
      sectionKinds: Record<string, string>;
      footnoteKinds: Record<string, string>;
      verdictCard: Record<string, string>;
      verdictList: Record<string, string>;
    };
    orders: { docSections: string[]; footnoteCard: string[] };
    directory: { read: WikiDocsDirectory; readsByDocs: boolean; groups: unknown[] };
    browse: {
      summary: string[];
      shownPhone: number;
      categories: Array<{ key: string; line: string; docs: Array<{ slug: string; sections: string; state: { text: string; tone: string } | null }> }>;
    };
    doc: {
      read: WikiDocView;
      tags: string[];
      updated: string[];
      warn: string | null;
      needsReview: string;
      legend: unknown[];
      rewrite: string | null;
      scopeCounts: string;
      scopeTargets: string[];
      marks: Array<{ section: string; block: number; sentence: number; mark: string; label: string; note: unknown }>;
      footnotes: Array<{
        n: number;
        kindLabel: string;
        sub: string | null;
        isRepo: boolean;
        verdictCard: string;
        verdictList: string;
        where: string;
        place: string;
        open: { label: string; href: string; external: boolean } | null;
        problem: string | null;
        quote: string | null;
        listQuote: string;
        excerpt: unknown;
        via: string | null;
        viaStatus: string | null;
      }>;
      summary: string;
      entriesHint: string;
      entryGroups: Array<{ title: string; note: string; ids: string[] }>;
      viaNotes: Array<{ id: string; note: string | null; status: string | null }>;
    };
    fine: { read: Pick<WikiDocView, 'written' | 'status' | 'counts'>; warn: string | null; updated: string[] };
    notWritten: { read: WikiDocView; updated: string[]; notes: Array<{ docs: { written: number; total: number } | null; says: string }> };
    index: { items: WikiDocsIndexItem[]; summary: string; groups: Array<{ letter: string; rows: Array<{ title: string; kind: string; meta: string }> }> };
    counts: {
      moreLines: Says[];
      moreSections: Says[];
      entriesHint: Says[];
      sectionLists: Array<{ numbers: number[]; says: string }>;
      seeFootnote: Says[];
      lineRanges: Array<{ start: number; end: number | null; says: string }>;
      github: Array<{ repo: string | null; says: string | null }>;
      monthDayTime: Array<{ iso: string; says: string | null }>;
    };
  };
}

function readDocsFixture(): Fixture {
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-docs.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-docs.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-docs.fixture.json not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

/** Run `fn` with the process in `tz`: Node re-reads `process.env.TZ` on the next Date call. */
function inTimeZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const fixture = readDocsFixture();
const { docs } = fixture;
const doc = docs.doc.read;

describe("the documents' words", () => {
  it('are the fixture’s, every one', () => {
    const w = docs.words;
    expect([
      WIKI_DIRECTORY_PLAN,
      WIKI_DOC_QUESTION,
      WIKI_DOC_WRITTEN_FOR,
      WIKI_DOC_COVERS,
      WIKI_DOC_NOT_COVERED,
      WIKI_DOC_SCOPE_FOLDED,
      WIKI_MARK_NO_SOURCE,
      WIKI_MARK_NOT_VERIFIED,
      WIKI_MARK_WITHDRAWN,
      WIKI_REWRITE_PENDING,
      WIKI_DOC_NEEDS_REVIEW,
      WIKI_NEXT_MARKED,
      WIKI_DOC_NOT_WRITTEN,
      WIKI_DOC_SECTION_NOT_WRITTEN,
      WIKI_DOC_FOOTNOTES,
      WIKI_VIA_ENTRY,
      WIKI_NO_QUOTE_GIVEN,
      WIKI_DOC_ENTRIES,
      WIKI_OPEN_THE_ENTRY,
      WIKI_DOC_NOT_WRITTEN_SHORT,
    ]).toEqual([
      w.plan,
      w.question,
      w.writtenFor,
      w.covers,
      w.notCovered,
      w.scopeFolded,
      w.noSource,
      w.notVerified,
      w.withdrawn,
      w.rewritePending,
      w.needsReview,
      w.nextMarked,
      w.notWritten,
      w.sectionNotWritten,
      w.footnotes,
      w.viaEntry,
      w.noQuoteGiven,
      w.entries,
      w.openTheEntry,
      w.notWrittenShort,
    ]);
    expect(WIKI_SECTION_KIND_LABELS).toEqual(w.sectionKinds);
    expect(WIKI_FOOTNOTE_KIND_LABELS).toEqual(w.footnoteKinds);
    expect(WIKI_VERDICT_CARD).toEqual(w.verdictCard);
    expect(WIKI_VERDICT_LIST).toEqual(w.verdictList);
    expect([WIKI_EXCERPT_LINES_PHONE, WIKI_FOOTNOTES_SHOWN, WIKI_DOC_GROUP_SHOWN_PHONE, WIKI_BROWSE_SECTIONS_SHOWN_PHONE]).toEqual([
      w.excerptLinesPhone,
      w.footnotesShown,
      w.groupShownPhone,
      w.browseSectionsShownPhone,
    ]);
  });

  it('count, list and range as the fixture says', () => {
    const c = docs.counts;
    for (const row of c.moreLines) expect(wikiMoreLines(row.n)).toBe(row.says);
    for (const row of c.moreSections) expect(wikiMoreSections(row.n)).toBe(row.says);
    for (const row of c.entriesHint) expect(wikiDocEntriesHint(row.n)).toBe(row.says);
    for (const row of c.sectionLists) expect(wikiSectionList(row.numbers)).toBe(row.says);
    for (const row of c.seeFootnote) expect(wikiSeeFootnote(row.n)).toBe(row.says);
    for (const row of c.lineRanges) expect(wikiLineRange(row.start, row.end)).toBe(row.says);
    for (const row of c.github) expect(wikiGithubRepo(row.repo)).toBe(row.says);
    inTimeZone(fixture.timeZone, () => {
      for (const row of c.monthDayTime) expect(wikiMonthDayTime(row.iso)).toBe(row.says);
    });
  });

  it('are drawn in the fixture’s orders: the page, and a footnote’s card', () => {
    expect([...WIKI_DOC_SECTIONS]).toEqual(docs.orders.docSections);
    expect([...WIKI_FOOTNOTE_CARD_PARTS]).toEqual(docs.orders.footnoteCard);
  });
});

describe("a document's page", () => {
  it('heads it with its tags, when it was written, and the banner past the threshold', () => {
    expect(wikiDocTags(doc)).toEqual(docs.doc.tags);
    inTimeZone(fixture.timeZone, () => {
      expect(wikiDocUpdatedParts(doc)).toEqual(docs.doc.updated);
      expect(wikiDocUpdatedParts({ ...doc, ...docs.fine.read })).toEqual(docs.fine.updated);
    });
    expect(wikiDocUpdatedWarn(doc)).toBe(docs.doc.warn);
    expect(wikiDocUpdatedWarn(docs.fine.read)).toBe(docs.fine.warn);
    expect(wikiDocNeedsReviewText(doc)).toBe(docs.doc.needsReview);
    expect(wikiDocLegend(doc)).toEqual(docs.doc.legend);
    expect(wikiDocRewriteNote(doc.sections)).toBe(docs.doc.rewrite);
    expect(wikiDocScopeCounts(doc)).toBe(docs.doc.scopeCounts);
    expect(doc.scopeOut.flatMap((out) => out.docs.map(wikiScopeTarget))).toEqual(docs.doc.scopeTargets);
  });

  it('says a document no run has written is not, and what writes it', () => {
    expect(wikiDocUpdatedParts(docs.notWritten.read)).toEqual(docs.notWritten.updated);
    for (const row of docs.notWritten.notes) expect(wikiDocNotWrittenNote(row.docs)).toBe(row.says);
  });

  it('marks each sentence the fixture marks, and says why in its words', () => {
    const marked: unknown[] = [];
    inTimeZone(fixture.timeZone, () => {
      for (const section of doc.sections) {
        section.blocks.forEach((block, b) =>
          block.sentences.forEach((sentence, s) => {
            const mark = wikiSentenceMark(sentence);
            if (mark) marked.push({ section: section.key, block: b, sentence: s, mark, label: WIKI_MARK_LABELS[mark], note: wikiMarkNote(sentence, section, doc) });
          }),
        );
      }
    });
    expect(marked).toEqual(docs.doc.marks);
    // Every mark the page has a legend word for is among them.
    expect(new Set(docs.doc.marks.map((row) => row.mark))).toEqual(new Set(['unsourced', 'unverified', 'withdrawn']));
  });

  it('reads each footnote the fixture reads: its kind, verdict, place, the way to its original and what went wrong', () => {
    const github = wikiGithubRepo('github.com/jianghailong-xy/orbit');
    inTimeZone(fixture.timeZone, () => {
      for (const expected of docs.doc.footnotes) {
        const note = doc.footnotes.find((row) => row.n === expected.n)!;
        expect(WIKI_FOOTNOTE_KIND_LABELS[note.kind], `[${note.n}]`).toBe(expected.kindLabel);
        expect(wikiFootnoteSubLabel(note), `[${note.n}]`).toBe(expected.sub);
        expect(wikiFootnoteIsRepo(note)).toBe(expected.isRepo);
        expect(WIKI_VERDICT_CARD[note.verdict]).toBe(expected.verdictCard);
        expect(WIKI_VERDICT_LIST[note.verdict]).toBe(expected.verdictList);
        expect(wikiFootnoteWhere(note), `[${note.n}]`).toBe(expected.where);
        expect(wikiFootnotePlace(note), `[${note.n}]`).toBe(expected.place);
        const open = wikiFootnoteOpen(note, github);
        expect(open ? { label: open.label, href: open.href, external: open.external } : null, `[${note.n}]`).toEqual(
          expected.open ? { label: expected.open.label, href: expected.open.href, external: expected.open.external } : null,
        );
        expect(wikiFootnoteProblem(note), `[${note.n}]`).toBe(expected.problem);
        expect(note.quote ? wikiQuoted(note.quote) : null).toBe(expected.quote);
        expect(note.quote ? wikiQuoted(note.quote) : WIKI_NO_QUOTE_GIVEN).toBe(expected.listQuote);
        const excerpt = note.kind !== 'design_doc' && wikiFootnoteIsRepo(note) && note.excerpt ? wikiExcerptLines(note, WIKI_EXCERPT_LINES_PHONE) : null;
        expect(excerpt, `[${note.n}]`).toEqual(expected.excerpt);
      }
    });
    expect(wikiFootnotesSummary(doc.footnotes)).toBe(docs.doc.summary);
  });

  it('opens a session record at that very record, repository lines on GitHub at the sha, a note nowhere', () => {
    const github = wikiGithubRepo('github.com/jianghailong-xy/orbit');
    const turn = doc.footnotes.find((row) => row.kind === 'turn')!;
    expect(wikiFootnoteOpen(turn, github)?.href).toBe(`/sessions/${turn.sessionId}?at=${turn.recordId}`);
    const code = doc.footnotes.find((row) => row.kind === 'code')!;
    expect(wikiFootnoteOpen(code, github)?.href).toContain(`/blob/${code.sha}/`);
    expect(wikiFootnoteOpen(code, null)).toBeNull();
    expect(wikiFootnoteOpen(doc.footnotes.find((row) => row.kind === 'note')!, github)).toBeNull();
  });

  it('lists the entries its quotes came through by kind, and says what became of one that left', () => {
    expect(wikiDocEntriesHint(doc.entries.length)).toBe(docs.doc.entriesHint);
    expect(wikiDocEntryGroups(doc.entries).map((group) => ({ title: group.title, note: group.note, ids: group.entries.map((entry) => entry.id) }))).toEqual(
      docs.doc.entryGroups,
    );
    expect(doc.entries.map((entry) => ({ id: entry.id, note: wikiViaEntryNote(entry, doc), status: wikiViaEntryStatus(entry) }))).toEqual(docs.doc.viaNotes);
  });
});

describe('the directory, Browse and the A–Z index by document', () => {
  it('group the confirmed plan’s categories and documents as the fixture does', () => {
    expect(wikiReadsByDocs(docs.directory.read)).toBe(docs.directory.readsByDocs);
    expect(wikiReadsByDocs({ ...docs.directory.read, plan: null })).toBe(false);
    expect(wikiDocDirectoryGroups(docs.directory.read)).toEqual(docs.directory.groups);
  });

  it('say Browse’s lines as the fixture does', () => {
    expect(wikiDocsBrowseSummary(docs.directory.read)).toEqual(docs.browse.summary);
    const categories = docs.directory.read.categories.filter((category) => category.docs.length > 0);
    expect(categories.map((category) => category.key)).toEqual(docs.browse.categories.map((row) => row.key));
    for (const [category, expected] of categories.map((row, i) => [row, docs.browse.categories[i]] as const)) {
      expect(wikiDocsCategoryLine(category)).toBe(expected.line);
      expect(category.docs.map((row) => ({ slug: row.slug, ...wikiDocsDocLine(row) }))).toEqual(expected.docs);
    }
  });

  it('file every document and section title under its letter, Chinese by pinyin', () => {
    expect(wikiDocsIndexSummary(docs.index.items)).toBe(docs.index.summary);
    expect(
      wikiDocsIndexGroups(docs.index.items).map((group) => ({
        letter: group.letter,
        rows: group.items.map((item) => ({ title: item.title, kind: item.kind, meta: wikiDocsIndexMeta(item) })),
      })),
    ).toEqual(docs.index.groups);
  });

  it('link a document to its page and a section to its place on it', () => {
    expect(wikiDocPath('orbit', 'session-runtime')).toBe('/wiki/orbit/d/session-runtime');
    expect(wikiDocSectionPath('orbit', 'session-runtime', 's3')).toBe('/wiki/orbit/d/session-runtime#sec-s3');
    const [first] = docs.index.items;
    expect(wikiDocsIndexPath('orbit', first)).toBe(`/wiki/orbit/d/${first.docSlug}`);
    const section = docs.index.items.find((item) => item.kind === 'section')!;
    expect(wikiDocsIndexPath('orbit', section)).toBe(`/wiki/orbit/d/${section.docSlug}#sec-${section.sectionKey}`);
  });
});
