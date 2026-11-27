import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_HELP_LANGUAGE,
  HELP_ADMIN_CATEGORY,
  HELP_CATEGORIES,
  HELP_PLATFORMS,
  isHelpLanguage,
  type HelpArticle,
  type HelpArticleMeta,
  type HelpCategorySlug,
  type HelpIndex,
  type HelpLanguage,
  type HelpMatch,
  type HelpPlatform,
  type HelpSearchHit,
  type HelpSearchResult,
} from '@orbit/shared';

/**
 * The help article library (docs/help, design: docs/mocks/help-center board 03), read once at boot. It ships with
 * the apiserver: the Dockerfile copies docs/help next to runner-release.json, and from here — src/help in the
 * sources, dist/help or build/help once compiled — that is four directories up either way.
 *
 * English is the source: docs/help/<category>/<slug>.md. A translated copy sits beside it under the language's
 * folder, docs/help/<language>/<category>/<slug>.md, and carries only its title, summary and body — the article's
 * routes, errors, platforms and updated date stay the English article's, so the two cannot drift apart.
 */
export const HELP_LIBRARY_DIR = path.resolve(__dirname, '../../../../docs/help');

/** The most hits one search answers. */
export const HELP_SEARCH_LIMIT = 20;
/** The most words of a query that count, and the most characters of it read. */
const MAX_TERMS = 8;
const MAX_QUERY_CHARS = 200;
/** How much of the body a snippet shows: some context before the first match, the rest after it. */
const SNIPPET_BEFORE = 60;
const SNIPPET_CHARS = 180;

const FIELDS = ['title', 'summary', 'category', 'routes', 'errors', 'platforms', 'common', 'updated'] as const;

interface Entry {
  article: HelpArticle;
  /** The body as text a person reads: no Markdown syntax, one line. What search reads and snippets quote. */
  text: string;
}

/**
 * The board's front matter: flat `key: value` lines, a value a scalar or an inline `[a, b]` list — the format
 * scripts/check-help-articles.mjs holds every article to, parsed the same way.
 */
function parseFrontMatter(source: string): { fields: Record<string, string | boolean | string[]>; body: string } | null {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields: Record<string, string | boolean | string[]> = {};
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^([a-z]+):\s*(.*)$/);
    if (!pair) throw new Error(`unreadable front matter line: ${line}`);
    const raw = pair[2].trim();
    fields[pair[1]] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean)
      : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return { fields, body: source.slice(match[0].length).replace(/^\n+/, '') };
}

/** One article file as the library serves it, or the reason it cannot be: a broken library stops the boot. */
export function parseArticle(category: string, file: string, source: string): HelpArticle {
  const where = `docs/help/${category}/${file}`;
  const parsed = parseFrontMatter(source);
  if (!parsed) throw new Error(`${where}: no front matter`);
  const { fields, body } = parsed;
  for (const field of FIELDS) if (!(field in fields)) throw new Error(`${where}: missing ${field}`);
  const text = (field: string) => {
    const value = fields[field];
    if (typeof value !== 'string' || !value) throw new Error(`${where}: ${field} must be text`);
    return value;
  };
  const list = (field: string) => {
    const value = fields[field];
    if (!Array.isArray(value)) throw new Error(`${where}: ${field} must be a [list]`);
    return value;
  };
  if (fields.category !== category || !HELP_CATEGORIES.some((c) => c.slug === category)) {
    throw new Error(`${where}: category ${String(fields.category)} is not its folder's`);
  }
  if (typeof fields.common !== 'boolean') throw new Error(`${where}: common must be true or false`);
  const platforms = list('platforms');
  for (const p of platforms) if (!(HELP_PLATFORMS as readonly string[]).includes(p)) throw new Error(`${where}: unknown platform ${p}`);
  return {
    slug: file.replace(/\.md$/, ''),
    title: text('title'),
    summary: text('summary'),
    category: category as HelpCategorySlug,
    routes: list('routes'),
    errors: list('errors'),
    platforms: platforms as HelpPlatform[],
    common: fields.common,
    updated: text('updated'),
    body,
  };
}

/**
 * A translated copy's front matter: only the words that change, `title` and `summary`, and the translated body. Every
 * other field is the English article's; naming one here is an error, so a translation cannot quietly disagree about
 * the category, routes, errors, platforms or date it was made from.
 */
export function parseTranslation(where: string, source: string): { title: string; summary: string; body: string } {
  const parsed = parseFrontMatter(source);
  if (!parsed) throw new Error(`${where}: no front matter`);
  const { fields, body } = parsed;
  for (const field of Object.keys(fields)) {
    if (field !== 'title' && field !== 'summary') throw new Error(`${where}: ${field} belongs to the English article`);
  }
  const text = (field: string) => {
    const value = fields[field];
    if (typeof value !== 'string' || !value) throw new Error(`${where}: missing ${field}`);
    return value;
  };
  return { title: text('title'), summary: text('summary'), body };
}

/** A Markdown body as the words a reader sees, on one line: what search matches and a snippet quotes. */
export function plainText(markdown: string): string {
  return markdown
    .split('\n')
    // Fences, and a table's separator row or a horizontal rule: nothing a reader sees.
    .filter((line) => !/^\s*(```|:::)/.test(line) && !/^\s*\|?[\s:|-]*-{3,}[\s:|-]*$/.test(line))
    // A table row reads as its cells, one after another.
    .map((line) => (/^\s*\|/.test(line) ? line.replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ' ') : line))
    .map((line) => line
      .replace(/^\s*#+\s+/, '')
      .replace(/^\s*(?:[-*+]|>)\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`/g, '')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1$2'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const HAN = /[㐀-䶿一-鿿]/;
/** Chinese is written without spaces, so a run of it is split into words the way a Chinese reader reads it. */
const WORDS = new Intl.Segmenter('zh', { granularity: 'word' });

/** The query's words: whitespace-separated, except a Chinese run, which is segmented (机器离线 is 机器 + 离线). */
export function queryTerms(query: string): string[] {
  const typed = query.slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean);
  const words = typed.flatMap((term) =>
    HAN.test(term) ? [...WORDS.segment(term)].filter((part) => part.isWordLike).map((part) => part.segment) : [term]);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** Every place a term occurs in `text`, ignoring case, in order and without overlaps. */
function matchesIn(text: string, terms: string[]): HelpMatch[] {
  const found: HelpMatch[] = [];
  for (const term of terms) {
    for (const m of text.matchAll(new RegExp(escape(term), 'gi'))) found.push({ start: m.index!, length: m[0].length });
  }
  found.sort((a, b) => a.start - b.start || b.length - a.length);
  const merged: HelpMatch[] = [];
  for (const m of found) {
    const last = merged[merged.length - 1];
    if (last && m.start < last.start + last.length) {
      last.length = Math.max(last.length, m.start + m.length - last.start);
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}

/** A passage of `text` around its first match, cut at word boundaries, with the matches inside it. */
function snippetOf(text: string, terms: string[], first: number): HelpSearchHit['snippet'] {
  let start = Math.max(0, first - SNIPPET_BEFORE);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    start = space >= 0 && space < first ? space + 1 : start;
  }
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > first) end = space;
  }
  const lead = start > 0 ? '…' : '';
  const passage = `${lead}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
  return { text: passage, matches: matchesIn(passage, terms) };
}

const meta = ({ body: _body, ...rest }: HelpArticle): HelpArticleMeta => rest;

interface TranslationSource {
  language: HelpLanguage;
  category: string;
  file: string;
  source: string;
}

export class HelpLibrary {
  private readonly entries: Entry[];
  /** The English articles by slug: a translation takes every field it does not translate from here. */
  private readonly english: Map<string, HelpArticle>;
  /** language → slug → the translated article. */
  private readonly translations = new Map<HelpLanguage, Map<string, HelpArticle>>();
  /** language → what that language's reader sees, English article by article where nothing is translated. */
  private readonly localized = new Map<HelpLanguage, Entry[]>();

  constructor(articles: HelpArticle[]) {
    const order = (slug: string) => HELP_CATEGORIES.findIndex((c) => c.slug === slug);
    const seen = new Set<string>();
    for (const { slug, category } of articles) {
      if (seen.has(slug)) throw new Error(`docs/help: slug ${slug} is used twice (${category})`);
      seen.add(slug);
    }
    this.entries = [...articles]
      .sort((a, b) => order(a.category) - order(b.category) || a.title.localeCompare(b.title))
      .map((article) => ({ article, text: plainText(article.body) }));
    this.english = new Map(articles.map((article) => [article.slug, article]));
  }

  /** One translated copy: its prose over the English article's routes, errors, platforms and date. */
  addTranslation(language: HelpLanguage, category: string, file: string, source: string): void {
    const where = `docs/help/${language}/${category}/${file}`;
    if (language === DEFAULT_HELP_LANGUAGE) throw new Error(`${where}: English is the source, not a translation`);
    const slug = file.replace(/\.md$/, '');
    const base = this.english.get(slug);
    if (!base) throw new Error(`${where}: no English article named ${slug}`);
    if (base.category !== category) throw new Error(`${where}: ${category} is not the article's category (${base.category})`);
    const { title, summary, body } = parseTranslation(where, source);
    const translated = this.translations.get(language) ?? new Map<string, HelpArticle>();
    if (translated.has(slug)) throw new Error(`${where}: ${slug} is translated twice`);
    translated.set(slug, { ...base, title, summary, body });
    this.translations.set(language, translated);
    this.localized.delete(language);
  }

  /**
   * The library under `dir`: the English articles in docs/help/<category>/<slug>.md, and each language's copies in
   * docs/help/<language>/<category>/<slug>.md. A library that does not parse, a translation with no English source,
   * or a folder that is neither, stops the boot.
   */
  static load(dir: string = HELP_LIBRARY_DIR): HelpLibrary {
    const english: HelpArticle[] = [];
    const translations: TranslationSource[] = [];
    for (const folder of readdirSync(dir, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
      if (folder.name === DEFAULT_HELP_LANGUAGE) {
        throw new Error(`docs/help/${folder.name}: English articles live under docs/help/<category>`);
      }
      if (isHelpLanguage(folder.name)) {
        for (const sub of readdirSync(path.join(dir, folder.name), { withFileTypes: true })) {
          if (!sub.isDirectory()) {
            if (sub.name.endsWith('.md')) throw new Error(`docs/help/${folder.name}/${sub.name}: a translation lives under its category`);
            continue;
          }
          if (!HELP_CATEGORIES.some((c) => c.slug === sub.name)) throw new Error(`docs/help/${folder.name}/${sub.name}: not a help category`);
          for (const file of readdirSync(path.join(dir, folder.name, sub.name))) {
            if (!file.endsWith('.md')) continue;
            translations.push({
              language: folder.name,
              category: sub.name,
              file,
              source: readFileSync(path.join(dir, folder.name, sub.name, file), 'utf8'),
            });
          }
        }
      } else if (HELP_CATEGORIES.some((c) => c.slug === folder.name)) {
        for (const file of readdirSync(path.join(dir, folder.name))) {
          if (!file.endsWith('.md')) continue;
          english.push(parseArticle(folder.name, file, readFileSync(path.join(dir, folder.name, file), 'utf8')));
        }
      } else {
        throw new Error(`docs/help/${folder.name}: not a help category or a language`);
      }
    }
    if (english.length === 0) throw new Error(`${dir}: no help articles`);
    const library = new HelpLibrary(english);
    for (const { language, category, file, source } of translations) library.addTranslation(language, category, file, source);
    return library;
  }

  /** What a reader of `language` sees: the translation where one shipped, the English article otherwise. */
  private entriesFor(language: HelpLanguage): Entry[] {
    if (language === DEFAULT_HELP_LANGUAGE) return this.entries;
    const cached = this.localized.get(language);
    if (cached) return cached;
    const translated = this.translations.get(language);
    const entries = this.entries.map(({ article, text }) => {
      const copy = translated?.get(article.slug);
      return copy ? { article: copy, text: plainText(copy.body) } : { article, text };
    });
    this.localized.set(language, entries);
    return entries;
  }

  private visible(admin: boolean, language: HelpLanguage): Entry[] {
    const entries = this.entriesFor(language);
    return admin ? entries : entries.filter((e) => e.article.category !== HELP_ADMIN_CATEGORY);
  }

  index(admin: boolean, language: HelpLanguage = DEFAULT_HELP_LANGUAGE): HelpIndex {
    return {
      categories: HELP_CATEGORIES.filter((c) => admin || c.slug !== HELP_ADMIN_CATEGORY).map(({ slug, title }) => ({ slug, title })),
      articles: this.visible(admin, language).map((e) => meta(e.article)),
    };
  }

  /** The article, or null when there is none — or none this caller may read, which it is told alike. */
  article(slug: string, admin: boolean, language: HelpLanguage = DEFAULT_HELP_LANGUAGE): HelpArticle | null {
    return this.visible(admin, language).find((e) => e.article.slug === slug)?.article ?? null;
  }

  /**
   * The articles holding every word of `query` in their title, summary or body, ignoring case. A title that holds
   * more of the words ranks first, then a summary that does, then how often the body says them.
   */
  search(query: string, admin: boolean, language: HelpLanguage = DEFAULT_HELP_LANGUAGE): HelpSearchResult {
    const terms = queryTerms(query);
    if (terms.length === 0) return { query, hits: [] };
    const scored: Array<{ hit: HelpSearchHit; score: number }> = [];
    for (const { article, text } of this.visible(admin, language)) {
      const title = article.title.toLowerCase();
      const summary = article.summary.toLowerCase();
      const body = text.toLowerCase();
      if (!terms.every((t) => title.includes(t) || summary.includes(t) || body.includes(t))) continue;
      const inTitle = terms.filter((t) => title.includes(t)).length;
      const inSummary = terms.filter((t) => summary.includes(t)).length;
      const bodyMatches = matchesIn(text, terms);
      const snippet = bodyMatches.length > 0
        ? snippetOf(text, terms, bodyMatches[0].start)
        : { text: article.summary, matches: matchesIn(article.summary, terms) };
      scored.push({
        hit: { slug: article.slug, title: article.title, category: article.category, titleMatches: matchesIn(article.title, terms), snippet },
        score: inTitle * 10_000 + inSummary * 100 + Math.min(bodyMatches.length, 99),
      });
    }
    scored.sort((a, b) => b.score - a.score || a.hit.title.localeCompare(b.hit.title));
    return { query, hits: scored.slice(0, HELP_SEARCH_LIMIT).map((s) => s.hit) };
  }
}
