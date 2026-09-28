/**
 * The Wiki's articles on the web (criterion 10, mocks 11–16): the category directory beside every
 * reading page, a topic's article with its footnotes, Browse by category and the A–Z index — the
 * words those pages say and every reading of the article reads they say it about.
 *
 * ONE PLACE FOR THE WORDS, as in `lib/wiki.ts`: OrbitKit's `WikiArticleCopy` says the same sentences
 * and `WikiArticlesCopyParityTests` looks each one up here, so a literal written inside a component
 * would be a sentence iOS cannot see. The cases both ends are held to are
 * `src/shared/src/wiki-articles.fixture.json`.
 *
 * WHAT IS READ, NOT INVENTED. The directory, an article and the index are the server's three article
 * reads (contract `articles.reads`); the entries under an article are the topic read's, which is the
 * one read that answers a topic's entries (see `WIKI_ARTICLE_ENTRIES_HINT`). A count the reads do not
 * carry — how many sessions a footnote's entry came from, say — is read from the entry when its card
 * opens, or not drawn.
 */
import {
  type WikiArticleDirectory,
  type WikiArticleDirectoryTopic,
  type WikiArticleIndex,
  type WikiArticlePartRef,
  type WikiArticleView,
  type WikiEntryKind,
} from '@orbit/shared';
import { WIKI_HISTORY_MAINTENANCE, WIKI_PATH, WIKI_TOPIC_GROUPS, byChangedAtDesc, shortSha, type WikiEntry, type WikiSource } from './wiki';
import { wikiMonthDay } from './wikiReviewMode';

export type {
  WikiArticleDirectory,
  WikiArticleDirectoryTopic,
  WikiArticleFootnote,
  WikiArticleIndex,
  WikiArticlePartRef,
  WikiArticleSentence,
  WikiArticleView,
} from '@orbit/shared';

// ── Routes ──────────────────────────────────────────────────────────────────────────────────────

/**
 * A topic's article is the topic's page (design §12.1's `/wiki/:space/t/:topic`): part 0 there, and a
 * subtopic article one segment further. The page the design always meant to lead with a generated,
 * footnoted text is this one, so every link that already opens a topic lands on its article.
 */
export const wikiArticlePath = (spaceSlug: string, topicSlug: string, part = 0): string =>
  part > 0 ? `${WIKI_PATH}/${spaceSlug}/t/${topicSlug}/${part}` : `${WIKI_PATH}/${spaceSlug}/t/${topicSlug}`;
export const wikiBrowsePath = (spaceSlug: string): string => `${WIKI_PATH}/${spaceSlug}/browse`;
export const wikiIndexPath = (spaceSlug: string): string => `${WIKI_PATH}/${spaceSlug}/az`;

// ── The words ───────────────────────────────────────────────────────────────────────────────────

/** The directory: its three ways in, then the categories. `Contents` heads it in the phone drawer. */
export const WIKI_CONTENTS = 'Contents';
export const WIKI_DIRECTORY_HOME = 'Home';
export const WIKI_BROWSE = 'Browse by category';
export const WIKI_AZ_INDEX = 'A–Z index';
/** The heading over topics no category has been given (`uncategorized`). */
export const WIKI_OTHER_TOPICS = 'Other';

/** An article's head: the line under its tags. */
export function wikiArticleUpdated(article: Pick<WikiArticleView, 'generatedAt' | 'ref' | 'entryCount'>): string {
  const day = wikiMonthDay(article.generatedAt) ?? '';
  const at = article.ref ? ` at ${shortSha(article.ref)}` : '';
  return `Updated ${day}${at} · written by ${WIKI_HISTORY_MAINTENANCE} from ${wikiCount(article.entryCount)} ${
    article.entryCount === 1 ? 'entry' : 'entries'
  }`;
}

/** The footnotes under the text, and the entries under them. */
export const WIKI_FOOTNOTES = 'Footnotes';
export const wikiEntriesCited = (count: number): string => `${count} ${count === 1 ? 'entry' : 'entries'} cited`;
export const WIKI_ARTICLE_ENTRIES = 'Entries';
/**
 * What the list under an article is. NOT "the entries this article is written from" (mock 13's
 * words): the article read names the entries it cites, not the ones it was written from, so the list
 * is the topic read's — the entries that file themselves under this topic. The two sets meet at the
 * cited ones, which lead their groups.
 */
export const WIKI_ARTICLE_ENTRIES_HINT = 'filed under this topic, by kind';
/** A footnote whose entry the wiki no longer has: the number stays, the card says so. */
export const WIKI_FOOTNOTE_GONE = 'This entry is no longer in the wiki.';
/** The entry card's last line: what backs it, and the ref its anchor was checked at. */
export function wikiSourcesLine(sources: number, sessions: number): string {
  const parts = [`${sources} ${sources === 1 ? 'source' : 'sources'}`];
  if (sessions > 0) parts.push(`${sessions} ${sessions === 1 ? 'session' : 'sessions'}`);
  return parts.join(' · ');
}
/** A topic with no article yet, on its own page: why there is no text over its entries. */
export const WIKI_NO_ARTICLE_YET = 'No article yet. The maintenance run writes one once this topic has entries.';

/** Browse by category. */
export const wikiBrowseSummary = (articles: number, topics: number, entries: number): string =>
  `${wikiArticleCount(articles)} · ${wikiCount(topics)} ${topics === 1 ? 'topic' : 'topics'} · ${wikiEntryCount(entries)}`;
export const wikiCategorySummary = (topics: number, articles: number, entries: number): string =>
  `${wikiCount(topics)} ${topics === 1 ? 'topic' : 'topics'} · ${wikiArticleCount(articles)} · ${wikiEntryCount(entries)}`;
/** A topic's line in Browse: the entries its article was written from, and its articles. */
export const wikiBrowseTopicLine = (entries: number, articles: number): string =>
  `${wikiEntryCount(entries)} · ${wikiArticleCount(articles)}`;
export const wikiArticleCount = (count: number): string => `${wikiCount(count)} ${count === 1 ? 'article' : 'articles'}`;
export const wikiEntryCount = (count: number): string => `${wikiCount(count)} ${count === 1 ? 'entry' : 'entries'}`;
export const wikiMoreArticles = (count: number): string => `${count} more`;
export const WIKI_NO_ARTICLES = 'No article has been written yet. The maintenance run writes one for each topic that has entries.';

/** The A–Z index. */
export const wikiIndexSummary = (count: number): string =>
  `${wikiArticleCount(count)} by title · Chinese titles by pinyin`;
export const WIKI_TOPIC_OVERVIEW = 'Topic overview';

/** A count as the pages print it: `11,689`. */
export function wikiCount(count: number): string {
  return String(Math.trunc(count)).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

// ── The directory ───────────────────────────────────────────────────────────────────────────────

/** One topic as the directory lists it. */
export interface WikiDirectoryTopic {
  slug: string;
  title: string;
  /** The entries its article was written from; null before it has one. */
  count: number | null;
  /** Its subtopic articles, in order — what opens under it while one of its articles is open. */
  parts: Array<{ part: number; title: string }>;
}

export interface WikiDirectoryGroup {
  key: string;
  title: string;
  topics: WikiDirectoryTopic[];
}

/**
 * The directory's groups: the categories in the contract's order, each with its topics in the order
 * the server keeps them, and the topics no category was given last, under `Other`. A category with no
 * topic is left out rather than drawn as a heading over nothing.
 */
export function wikiDirectoryGroups(directory: WikiArticleDirectory): WikiDirectoryGroup[] {
  const row = (topic: WikiArticleDirectoryTopic): WikiDirectoryTopic => ({
    slug: topic.slug,
    title: topic.title || topic.slug,
    count: topic.article ? topic.article.entryCount : null,
    parts: topic.parts.map((part) => ({ part: part.part, title: part.title })),
  });
  const groups: WikiDirectoryGroup[] = directory.categories
    .filter((category) => category.topics.length > 0)
    .map((category) => ({ key: category.key, title: category.title, topics: category.topics.map(row) }));
  if (directory.uncategorized.length > 0) {
    groups.push({ key: 'other', title: WIKI_OTHER_TOPICS, topics: directory.uncategorized.map(row) });
  }
  return groups;
}

// ── Browse by category ──────────────────────────────────────────────────────────────────────────

export interface WikiBrowseTopic {
  slug: string;
  title: string;
  description: string | null;
  /** Entries its article was written from, and how many articles it has (its own and its parts). */
  entries: number;
  articles: number;
  parts: WikiArticlePartRef[];
  hasArticle: boolean;
}

export interface WikiBrowseCategory {
  key: string;
  title: string;
  topics: number;
  articles: number;
  entries: number;
  rows: WikiBrowseTopic[];
}

/** The subtopic articles a topic shows before `N more`, on the desktop's two columns and the phone's list. */
export const WIKI_BROWSE_SHOWN = 8;
export const WIKI_BROWSE_SHOWN_PHONE = 5;

/** Browse by category: every group of the directory, with its topics' counts summed. */
export function wikiBrowseCategories(directory: WikiArticleDirectory): WikiBrowseCategory[] {
  const byGroup = wikiDirectoryGroups(directory);
  const topics = new Map(
    [...directory.categories.flatMap((category) => category.topics), ...directory.uncategorized].map((topic) => [topic.slug, topic]),
  );
  return byGroup.map((group) => {
    const rows = group.topics.map((row): WikiBrowseTopic => {
      const topic = topics.get(row.slug)!;
      return {
        slug: topic.slug,
        title: row.title,
        description: topic.description,
        entries: topic.article?.entryCount ?? 0,
        articles: (topic.article ? 1 : 0) + topic.parts.length,
        parts: topic.parts,
        hasArticle: topic.article !== null,
      };
    });
    return {
      key: group.key,
      title: group.title,
      topics: rows.length,
      articles: rows.reduce((sum, row) => sum + row.articles, 0),
      entries: rows.reduce((sum, row) => sum + row.entries, 0),
      rows,
    };
  });
}

/** The whole space's line under Browse's title. */
export function wikiBrowseTotals(categories: readonly WikiBrowseCategory[]): { articles: number; topics: number; entries: number } {
  return {
    articles: categories.reduce((sum, category) => sum + category.articles, 0),
    topics: categories.reduce((sum, category) => sum + category.topics, 0),
    entries: categories.reduce((sum, category) => sum + category.entries, 0),
  };
}

// ── The A–Z index ───────────────────────────────────────────────────────────────────────────────

/** The letter bar's letters, in its order: A to Z, then `#` for a title no letter starts. */
export const WIKI_INDEX_LETTERS: readonly string[] = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '#'];

/**
 * Chinese titles sort and group by pinyin (mock 15 ④): the collation every modern browser carries,
 * and a Han character's initial read off where it falls in it. `PINYIN_BOUNDARIES[i]` is the first
 * character, in this collation, of the syllables `PINYIN_LETTERS[i]` starts (pinyin has no I, U or V
 * initial). Derived from the whole CJK block against iOS's `mandarinToLatin`, which is what the
 * native index reads the same initials with: the two agree on every character the demo's 11,689
 * titles start with, and differ only on rarely-used ones. The string most pages quote for this —
 * `阿八嚓…` — no longer fits current ICU data: its `痳` and `扨` file 六 under M and 入 under S.
 */
const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ';
const PINYIN_BOUNDARIES = '阿丷嚓咑妸发旮哈丌咔垃呣拏喔妑七呥仨他屲夕丫帀';
/** The CJK ideograph blocks — the same ranges `WikiArticleLogic.isHan` reads on iOS. */
const HAN = /^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2FFFF}]$/u;
const LATIN = /^[A-Za-z]$/u;

let collator: Intl.Collator | null = null;
/** The index's order: Chinese by pinyin, Latin letters after the Chinese of the same letter. */
export function wikiPinyinCollator(): Intl.Collator {
  collator ??= new Intl.Collator('zh-u-co-pinyin');
  return collator;
}

/** The index letter a title is filed under: its first letter, a Chinese first character's pinyin initial, or `#`. */
export function wikiIndexInitial(title: string): string {
  const first = [...title.trim()][0] ?? '';
  if (LATIN.test(first)) return first.toUpperCase();
  if (!HAN.test(first)) return '#';
  const compare = wikiPinyinCollator().compare;
  let letter = '#';
  for (let i = 0; i < PINYIN_BOUNDARIES.length; i += 1) {
    if (compare(first, PINYIN_BOUNDARIES[i]) < 0) break;
    letter = PINYIN_LETTERS[i];
  }
  return letter;
}

export type WikiIndexItem = WikiArticleIndex['items'][number];

export interface WikiIndexGroup {
  letter: string;
  items: WikiIndexItem[];
}

/** Every article of the index under its letter, the letters in the bar's order, each group A to Z by pinyin. */
export function wikiIndexGroups(items: readonly WikiIndexItem[]): WikiIndexGroup[] {
  const compare = wikiPinyinCollator().compare;
  const sorted = [...items].sort(
    (a, b) =>
      compare(a.title, b.title)
      || (a.topic.slug < b.topic.slug ? -1 : a.topic.slug > b.topic.slug ? 1 : 0)
      || a.part - b.part,
  );
  const byLetter = new Map<string, WikiIndexItem[]>();
  for (const item of sorted) {
    const letter = wikiIndexInitial(item.title);
    byLetter.set(letter, [...(byLetter.get(letter) ?? []), item]);
  }
  return WIKI_INDEX_LETTERS.filter((letter) => byLetter.has(letter)).map((letter) => ({ letter, items: byLetter.get(letter)! }));
}

/** An index row's second line: its topic and entries, or `Topic overview` for a topic's own article (part 0). */
export function wikiIndexMeta(item: WikiIndexItem): string {
  if (item.part === 0) return WIKI_TOPIC_OVERVIEW;
  return `${item.topic.title} · ${wikiEntryCount(item.entryCount)}`;
}

// ── One article ─────────────────────────────────────────────────────────────────────────────────

/** A footnote marker as the text carries it: `[7]`. */
export const wikiNoteLabel = (n: number): string => `[${n}]`;

/** A run of a sentence: plain words, inline code, or strong words. */
export interface WikiSentenceSegment {
  kind: 'text' | 'code' | 'strong';
  text: string;
}

/**
 * A sentence as its runs. The writer's Markdown survives the server's validation inside a sentence
 * (`validateArticlePart` splits and strips markers, it does not render), so the two marks a model
 * writes inside prose — backticked code and `**strong**` words — are read here and nothing else is:
 * an unpaired backtick or asterisk stays the character it is.
 */
export function wikiSentenceSegments(text: string): WikiSentenceSegment[] {
  const segments: WikiSentenceSegment[] = [];
  const push = (kind: WikiSentenceSegment['kind'], value: string) => {
    if (value === '') return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && kind === 'text') last.text += value;
    else segments.push({ kind, text: value });
  };
  let at = 0;
  while (at < text.length) {
    if (text[at] === '`') {
      const end = text.indexOf('`', at + 1);
      if (end > at + 1) {
        push('code', text.slice(at + 1, end));
        at = end + 1;
        continue;
      }
    }
    if (text.startsWith('**', at)) {
      const end = text.indexOf('**', at + 2);
      if (end > at + 2) {
        push('strong', text.slice(at + 2, end));
        at = end + 2;
        continue;
      }
    }
    push('text', text[at]);
    at += 1;
  }
  return segments;
}

/** The kinds an article's tags count, in the registry's order, and what each count is called. */
const KIND_PLURALS: Record<WikiEntryKind, [string, string]> = {
  principle: ['principle', 'principles'],
  convention: ['convention', 'conventions'],
  decision: ['decision', 'decisions'],
  pitfall: ['pitfall', 'pitfalls'],
  recipe: ['recipe', 'recipes'],
  concept: ['concept', 'concepts'],
  assumption: ['assumption', 'assumptions'],
};

/** The tags after the category and the topic: how many entries of each kind the list under the article holds. */
export function wikiArticleKindTags(entries: ReadonlyArray<Pick<WikiEntry, 'kind'>>): string[] {
  return (Object.keys(KIND_PLURALS) as WikiEntryKind[]).flatMap((kind) => {
    const count = entries.filter((entry) => entry.kind === kind).length;
    if (count === 0) return [];
    return [`${wikiCount(count)} ${KIND_PLURALS[kind][count === 1 ? 0 : 1]}`];
  });
}

/**
 * The groups under an article: the topic page's kind groups (`WIKI_TOPIC_GROUPS`), each leading with
 * the entries this article cites, in footnote order, then the rest newest first — so what a reader
 * just followed a footnote to is the first thing its group shows (mock 14 ④).
 */
export function wikiArticleGroups(
  entries: readonly WikiEntry[],
  cited: readonly string[],
): Array<{ title: string; note: string; entries: WikiEntry[] }> {
  const rank = new Map(cited.map((id, i) => [id, i]));
  return WIKI_TOPIC_GROUPS.map((group) => {
    const held = entries.filter((entry) => group.kinds.includes(entry.kind as never));
    const first = held.filter((entry) => rank.has(entry.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    const rest = held.filter((entry) => !rank.has(entry.id)).sort(byChangedAtDesc);
    return { title: group.title, note: group.note, entries: [...first, ...rest] };
  }).filter((group) => group.entries.length > 0);
}

/** How many sources back an entry, and how many sessions they are from (a turn cited from its session). */
export function wikiSourceCounts(sources: readonly Pick<WikiSource, 'kind' | 'ref' | 'locator'>[]): { sources: number; sessions: number } {
  const sessions = new Set(
    sources.filter((source) => source.kind === 'turn' && typeof source.locator?.turnId === 'string').map((source) => source.ref),
  );
  return { sources: sources.length, sessions: sessions.size };
}

/** The sections of an article's page, top to bottom — the web phone's order, and the one iOS draws. */
export const WIKI_ARTICLE_SECTIONS = ['crumb', 'title', 'tags', 'updated', 'body', 'footnotes', 'entries'] as const;
