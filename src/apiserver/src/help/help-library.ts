import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HELP_ADMIN_CATEGORY,
  HELP_CATEGORIES,
  HELP_PLATFORMS,
  type HelpArticle,
  type HelpArticleMeta,
  type HelpCategorySlug,
  type HelpIndex,
  type HelpMatch,
  type HelpPlatform,
  type HelpSearchHit,
  type HelpSearchResult,
} from '@orbit/shared';

/**
 * The help article library (docs/help, design: docs/mocks/help-center board 03), read once at boot. It ships with
 * the apiserver: the Dockerfile copies docs/help next to runner-release.json, and from here — src/help in the
 * sources, dist/help or build/help once compiled — that is four directories up either way.
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

/** A Markdown body as the words a reader sees, on one line: what search matches and a snippet quotes. */
export function plainText(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/^\s*(```|:::)/.test(line))
    .map((line) => line
      .replace(/^\s*#+\s+/, '')
      .replace(/^\s*(?:[-*+]|>)\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

export class HelpLibrary {
  private readonly entries: Entry[];

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
  }

  /** The library under `dir`: docs/help/<category>/<slug>.md. */
  static load(dir: string = HELP_LIBRARY_DIR): HelpLibrary {
    const articles: HelpArticle[] = [];
    for (const category of readdirSync(dir, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      for (const file of readdirSync(path.join(dir, category.name))) {
        if (!file.endsWith('.md')) continue;
        articles.push(parseArticle(category.name, file, readFileSync(path.join(dir, category.name, file), 'utf8')));
      }
    }
    if (articles.length === 0) throw new Error(`${dir}: no help articles`);
    return new HelpLibrary(articles);
  }

  private visible(admin: boolean): Entry[] {
    return admin ? this.entries : this.entries.filter((e) => e.article.category !== HELP_ADMIN_CATEGORY);
  }

  index(admin: boolean): HelpIndex {
    return {
      categories: HELP_CATEGORIES.filter((c) => admin || c.slug !== HELP_ADMIN_CATEGORY).map(({ slug, title }) => ({ slug, title })),
      articles: this.visible(admin).map((e) => meta(e.article)),
    };
  }

  /** The article, or null when there is none — or none this caller may read, which it is told alike. */
  article(slug: string, admin: boolean): HelpArticle | null {
    return this.visible(admin).find((e) => e.article.slug === slug)?.article ?? null;
  }

  /**
   * The articles holding every word of `query` in their title, summary or body, ignoring case. A title that holds
   * more of the words ranks first, then a summary that does, then how often the body says them.
   */
  search(query: string, admin: boolean): HelpSearchResult {
    const terms = [...new Set(query.slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
    if (terms.length === 0) return { query, hits: [] };
    const scored: Array<{ hit: HelpSearchHit; score: number }> = [];
    for (const { article, text } of this.visible(admin)) {
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
