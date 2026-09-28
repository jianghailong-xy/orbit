import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WikiArticleDirectory, WikiArticleIndex, WikiEntry } from '@orbit/shared';
import { WIKI_ACTION_OPEN, WIKI_AGENTS_USED, WIKI_PRINCIPLES, WIKI_RECENT_DECISIONS, WIKI_RECENTLY_CHANGED } from './wiki';
import {
  WIKI_ARTICLE_ENTRIES,
  WIKI_ARTICLE_SECTIONS,
  WIKI_AZ_INDEX,
  WIKI_BROWSE,
  WIKI_BROWSE_SHOWN,
  WIKI_BROWSE_SHOWN_PHONE,
  WIKI_CONTENTS,
  WIKI_DIRECTORY_HOME,
  WIKI_FOOTNOTES,
  WIKI_FOOTNOTE_GONE,
  WIKI_INDEX_LETTERS,
  WIKI_NO_ARTICLES,
  WIKI_NO_ARTICLE_YET,
  WIKI_OTHER_TOPICS,
  WIKI_TOPIC_OVERVIEW,
  wikiArticleEntriesHint,
  wikiArticleGroups,
  wikiArticleKindTags,
  wikiArticlePath,
  wikiArticleUpdated,
  wikiBrowseCategories,
  wikiBrowsePath,
  wikiBrowseSummary,
  wikiBrowseTopicLine,
  wikiBrowseTotals,
  wikiCategorySummary,
  wikiCount,
  wikiDirectoryGroups,
  wikiEntriesCited,
  wikiIndexGroups,
  wikiIndexInitial,
  wikiIndexMeta,
  wikiIndexPath,
  wikiIndexSummary,
  wikiMoreArticles,
  wikiNoteLabel,
  wikiSentenceSegments,
  wikiSourceCounts,
  wikiSourcesLine,
  type WikiSentenceSegment,
} from './wikiArticles';

/**
 * The articles' words and readings, proved against `src/shared/src/wiki-articles.fixture.json` — the
 * same cases OrbitKit's `WikiArticlesCopyParityTests` reads, so the directory, an article's head and
 * footnotes, Browse and the A–Z index say and count the same things on the web phone and on iOS.
 */

interface Fixture {
  timeZone: string;
  words: {
    contents: string;
    home: string;
    browse: string;
    azIndex: string;
    other: string;
    footnotes: string;
    entries: string;
    footnoteGone: string;
    openEntry: string;
    topicOverview: string;
    noArticleYet: string;
    noArticles: string;
    moreArticles: Array<{ n: number; says: string }>;
  };
  orders: {
    homeBands: string[];
    homeBandTitles: Array<string | null>;
    articleSections: string[];
    directoryHead: string[];
    browseSections: string[];
    indexSections: string[];
    indexLetters: string[];
  };
  directory: {
    read: WikiArticleDirectory;
    groups: Array<{ title: string; topics: Array<{ slug: string; title: string; count: number | null; parts: string[] }> }>;
  };
  browse: {
    summary: string;
    shown: number;
    shownPhone: number;
    categories: Array<{
      title: string;
      summary: string;
      topics: Array<{ slug: string; title: string; line: string | null; parts: number }>;
    }>;
  };
  index: {
    items: WikiArticleIndex['items'];
    summary: string;
    groups: Array<{ letter: string; rows: Array<{ title: string; meta: string }> }>;
  };
  initials: Array<{ title: string; says: string }>;
  counts: Array<{ n: number; says: string }>;
  updated: Array<{ article: { generatedAt: string; ref: string | null; entryCount: number }; says: string }>;
  entriesCited: Array<{ n: number; says: string }>;
  entriesHints: Array<{ n: number; says: string }>;
  sourcesLines: Array<{ sources: number; sessions: number; says: string }>;
  segments: Array<{ text: string; says: WikiSentenceSegment[] }>;
  noteLabels: Array<{ n: number; says: string }>;
  kindTags: Array<{ kinds: string[]; says: string[] }>;
  articleGroups: {
    entries: Array<{ id: string; kind: string; validFrom: string }>;
    cited: string[];
    groups: Array<{ title: string; ids: string[] }>;
  };
}

function fixture(): Fixture {
  // Vitest runs from src/web; the path is tried from the repository root too, so the test reads the
  // one file whichever directory it is started in.
  const candidates = [
    resolve(process.cwd(), '../shared/src/wiki-articles.fixture.json'),
    resolve(process.cwd(), 'src/shared/src/wiki-articles.fixture.json'),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`wiki-articles.fixture.json not found from ${process.cwd()}`);
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

describe("the articles' words", () => {
  it('are the fixture’s, every one', () => {
    const { words } = fixture();
    expect(WIKI_CONTENTS).toBe(words.contents);
    expect(WIKI_DIRECTORY_HOME).toBe(words.home);
    expect(WIKI_BROWSE).toBe(words.browse);
    expect(WIKI_AZ_INDEX).toBe(words.azIndex);
    expect(WIKI_OTHER_TOPICS).toBe(words.other);
    expect(WIKI_FOOTNOTES).toBe(words.footnotes);
    expect(WIKI_ARTICLE_ENTRIES).toBe(words.entries);
    expect(WIKI_FOOTNOTE_GONE).toBe(words.footnoteGone);
    expect(WIKI_ACTION_OPEN).toBe(words.openEntry);
    expect(WIKI_TOPIC_OVERVIEW).toBe(words.topicOverview);
    expect(WIKI_NO_ARTICLE_YET).toBe(words.noArticleYet);
    expect(WIKI_NO_ARTICLES).toBe(words.noArticles);
    for (const row of words.moreArticles) expect(wikiMoreArticles(row.n)).toBe(row.says);
  });

  it('count, cite and label as the fixture says', () => {
    const shared = fixture();
    for (const row of shared.counts) expect(wikiCount(row.n)).toBe(row.says);
    for (const row of shared.entriesCited) expect(wikiEntriesCited(row.n)).toBe(row.says);
    for (const row of shared.entriesHints) expect(wikiArticleEntriesHint(row.n)).toBe(row.says);
    for (const row of shared.sourcesLines) expect(wikiSourcesLine(row.sources, row.sessions)).toBe(row.says);
    for (const row of shared.noteLabels) expect(wikiNoteLabel(row.n)).toBe(row.says);
  });

  it("date an article's head in the reader's zone", () => {
    const shared = fixture();
    inTimeZone(shared.timeZone, () => {
      for (const row of shared.updated) expect(wikiArticleUpdated(row.article)).toBe(row.says);
    });
  });
});

describe('the orders both ends draw', () => {
  it('are the fixture’s: the article page, the index letters, the home bands a phone draws', () => {
    const { orders } = fixture();
    expect([...WIKI_ARTICLE_SECTIONS]).toEqual(orders.articleSections);
    expect([...WIKI_INDEX_LETTERS]).toEqual(orders.indexLetters);
    expect([WIKI_DIRECTORY_HOME, WIKI_BROWSE, WIKI_AZ_INDEX]).toEqual(orders.directoryHead);
    expect(orders.homeBandTitles.filter(Boolean)).toEqual([
      WIKI_PRINCIPLES,
      WIKI_RECENT_DECISIONS,
      WIKI_RECENTLY_CHANGED,
      WIKI_AGENTS_USED,
    ]);
    expect(WIKI_BROWSE_SHOWN).toBe(fixture().browse.shown);
    expect(WIKI_BROWSE_SHOWN_PHONE).toBe(fixture().browse.shownPhone);
  });
});

describe('the directory', () => {
  it('lists the categories in order, drops an empty one, and files the uncategorized under Other', () => {
    const { directory } = fixture();
    const groups = wikiDirectoryGroups(directory.read);
    expect(
      groups.map((group) => ({
        title: group.title,
        topics: group.topics.map((topic) => ({
          slug: topic.slug,
          title: topic.title,
          count: topic.count,
          parts: topic.parts.map((part) => part.title),
        })),
      })),
    ).toEqual(directory.groups);
  });

  it("is where a topic's article, Browse and the index live", () => {
    expect(wikiArticlePath('orbit', 'ui-design')).toBe('/wiki/orbit/t/ui-design');
    expect(wikiArticlePath('orbit', 'ui-design', 1)).toBe('/wiki/orbit/t/ui-design/1');
    expect(wikiBrowsePath('orbit')).toBe('/wiki/orbit/browse');
    expect(wikiIndexPath('orbit')).toBe('/wiki/orbit/az');
  });
});

describe('Browse by category', () => {
  it('sums each category and the space as the fixture says', () => {
    const { directory, browse } = fixture();
    const categories = wikiBrowseCategories(directory.read);
    const totals = wikiBrowseTotals(categories);
    expect(wikiBrowseSummary(totals.articles, totals.topics, totals.entries)).toBe(browse.summary);
    expect(
      categories.map((category) => ({
        title: category.title,
        summary: wikiCategorySummary(category.topics, category.articles, category.entries),
        topics: category.rows.map((row) => ({
          slug: row.slug,
          title: row.title,
          line: row.hasArticle ? wikiBrowseTopicLine(row.entries, row.articles) : null,
          parts: row.parts.length,
        })),
      })),
    ).toEqual(browse.categories);
  });
});

describe('the A–Z index', () => {
  it('files a title under its letter — a Chinese one by pinyin — and sorts each group by pinyin', () => {
    const { index } = fixture();
    expect(wikiIndexSummary(index.items.length)).toBe(index.summary);
    expect(
      wikiIndexGroups(index.items).map((group) => ({
        letter: group.letter,
        rows: group.items.map((item) => ({ title: item.title, meta: wikiIndexMeta(item) })),
      })),
    ).toEqual(index.groups);
  });

  it('reads the initials the fixture pins, the old boundary string’s misfiles among them', () => {
    for (const row of fixture().initials) expect([row.title, wikiIndexInitial(row.title)]).toEqual([row.title, row.says]);
  });
});

describe('one article', () => {
  it("reads a sentence's code and strong words, and leaves an unpaired mark as it is", () => {
    for (const row of fixture().segments) expect(wikiSentenceSegments(row.text)).toEqual(row.says);
  });

  it('counts the kinds its entries hold, in the registry’s order', () => {
    for (const row of fixture().kindTags) {
      expect(wikiArticleKindTags(row.kinds.map((kind) => ({ kind: kind as WikiEntry['kind'] })))).toEqual(row.says);
    }
  });

  it('groups its entries by kind, the cited ones first in footnote order, the rest newest first', () => {
    const { articleGroups } = fixture();
    const entries = articleGroups.entries.map(
      (row) => ({ ...row, title: row.id, summary: '', status: 'active', trust: 'auto' }) as unknown as WikiEntry,
    );
    expect(
      wikiArticleGroups(entries, articleGroups.cited).map((group) => ({ title: group.title, ids: group.entries.map((entry) => entry.id) })),
    ).toEqual(articleGroups.groups);
  });

  it("counts a footnote's sources, and a turn cited from its session as that session", () => {
    const turn = (session: string, turnId: string | null) => ({
      kind: 'turn' as const,
      ref: session,
      locator: turnId ? { turnId } : {},
    });
    expect(
      wikiSourceCounts([
        turn('s1', 't1'),
        turn('s1', 't2'),
        turn('s2', 't3'),
        turn('t9', null),
        { kind: 'commit' as const, ref: 'abc', locator: {} },
      ]),
    ).toEqual({ sources: 5, sessions: 2 });
  });
});
