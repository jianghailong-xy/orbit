import type { HelpArticleMeta, HelpMatch } from '@orbit/shared';

/**
 * The help drawer's Articles list (board docs/mocks/help-center/01-web.png ①): which articles are "For this page",
 * the one a visible error pins first, and the highlighted pieces of a search hit. Pure, so it is tested alone.
 */

/** At most this many articles under "For this page". */
export const FOR_THIS_PAGE_MAX = 4;

/**
 * An error card names the error it shows with this attribute (`data-help-error="runner.offline"`); while the card is on
 * the page, the drawer puts the article whose front matter lists that error first.
 */
export const HELP_ERROR_ATTR = 'data-help-error';

const segmentsOf = (path: string) => path.split('?')[0].split('#')[0].split('/').filter(Boolean);

/**
 * Whether a front-matter route (`/settings/machines/:id`, `/settings/machines/*`, `/help/**`) matches a pathname.
 * `:name` and `*` stand for exactly one segment, `**` for any number of them; every other segment must be equal.
 */
export function routeMatches(pattern: string, pathname: string): boolean {
  const want = segmentsOf(pattern);
  const have = segmentsOf(pathname);
  const walk = (i: number, j: number): boolean => {
    if (i === want.length) return j === have.length;
    const seg = want[i];
    if (seg === '**') return walk(i + 1, j) || (j < have.length && walk(i, j + 1));
    if (j === have.length) return false;
    if (seg === '*' || seg.startsWith(':') || seg === have[j]) return walk(i + 1, j + 1);
    return false;
  };
  return walk(0, 0);
}

export interface ForThisPageRow {
  article: HelpArticleMeta;
  /** The article is about an error a card on the page shows: drawn first, with a warning icon. */
  pinned: boolean;
}

/**
 * "For this page": the articles about an error a card on the page shows (those whose routes match the page first),
 * then the ones whose routes match the
 * pathname, in the library's order, at most `FOR_THIS_PAGE_MAX`. Empty when nothing matches (the group is hidden).
 */
export function forThisPage(
  articles: readonly HelpArticleMeta[],
  pathname: string,
  visibleErrors: readonly string[],
): ForThisPageRow[] {
  const onPage = (a: HelpArticleMeta) => a.routes.some((r) => routeMatches(r, pathname));
  // Of several articles about the same error, the one about this page comes first.
  const pinned = articles
    .filter((a) => a.errors.some((e) => visibleErrors.includes(e)))
    .sort((a, b) => Number(onPage(b)) - Number(onPage(a)));
  const matched = articles.filter((a) => !pinned.includes(a) && onPage(a));
  return [
    ...pinned.map((article) => ({ article, pinned: true })),
    ...matched.map((article) => ({ article, pinned: false })),
  ].slice(0, FOR_THIS_PAGE_MAX);
}

/** The Get started articles, in the library's order. */
export const getStartedArticles = (articles: readonly HelpArticleMeta[]) => articles.filter((a) => a.category === 'get-started');

/** Where the reader is, for the chip beside FOR THIS PAGE: "/settings/machines/abc" reads "Settings → Machines". */
export function routeLabel(pathname: string): string {
  const words = segmentsOf(pathname)
    .slice(0, 2)
    .filter((s) => /^[a-z][a-z-]*$/.test(s))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, ' '));
  return words.length ? words.join(' → ') : 'Home';
}

/** A text cut into plain and matched pieces, for drawing the matches as <mark>. */
export function highlightPieces(text: string, matches: readonly HelpMatch[]): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = [];
  let at = 0;
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    if (m.start < at || m.length <= 0) continue;
    if (m.start > at) out.push({ text: text.slice(at, m.start), mark: false });
    out.push({ text: text.slice(m.start, m.start + m.length), mark: true });
    at = m.start + m.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
