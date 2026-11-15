// The help center's article library (docs/help, design: docs/mocks/help-center board 03 "how it reaches clients"):
// the categories, an article's front matter, and the answers of the apiserver's three help doors —
// GET /api/help, GET /api/help/articles/:slug and GET /api/help/search?q=. The library ships with the apiserver,
// so a client reads the help of the server it talks to.

/** The nine categories, in the order the help center lists them (board 03), each with its English name. */
export const HELP_CATEGORIES = [
  { slug: 'get-started', title: 'Get started' },
  { slug: 'workspaces-and-sessions', title: 'Workspaces & sessions' },
  { slug: 'projects-and-tasks', title: 'Projects & tasks' },
  { slug: 'wiki', title: 'Wiki' },
  { slug: 'machines-and-engines', title: 'Machines & engines' },
  { slug: 'models-keys-and-accounts', title: 'Models, keys & accounts' },
  { slug: 'phone-and-desktop-apps', title: 'Phone & desktop apps' },
  { slug: 'integrations-and-api', title: 'Integrations & API' },
  { slug: 'admin-and-self-hosting', title: 'Admin & self-hosting' },
] as const;
export type HelpCategorySlug = (typeof HELP_CATEGORIES)[number]['slug'];

/** The category only administrators are shown: absent from a non-admin's index and search, its articles a 404. */
export const HELP_ADMIN_CATEGORY: HelpCategorySlug = 'admin-and-self-hosting';

export const HELP_PLATFORMS = ['web', 'macos', 'ios', 'android'] as const;
export type HelpPlatform = (typeof HELP_PLATFORMS)[number];

export interface HelpCategory {
  slug: HelpCategorySlug;
  title: string;
}

/** An article's front matter, and its slug (the file's name: docs/help/<category>/<slug>.md). */
export interface HelpArticleMeta {
  slug: string;
  title: string;
  summary: string;
  category: HelpCategorySlug;
  /** The app routes the article is about, such as `/settings/machines/:id`: the drawer's "For this page". */
  routes: string[];
  /** The error slugs, such as `runner.offline`, whose cards link to this article. */
  errors: string[];
  platforms: HelpPlatform[];
  /** Listed under Common problems. */
  common: boolean;
  /** `YYYY-MM-DD`. */
  updated: string;
}

/** GET /api/help: the categories the caller may see, and every one of their articles' front matter (no bodies). */
export interface HelpIndex {
  categories: HelpCategory[];
  articles: HelpArticleMeta[];
}

/** GET /api/help/articles/:slug: the front matter and the Markdown body (after the front matter). */
export interface HelpArticle extends HelpArticleMeta {
  body: string;
}

/** Where a match is, in UTF-16 code units of the text it is in. */
export interface HelpMatch {
  start: number;
  length: number;
}

/** One search result. */
export interface HelpSearchHit {
  slug: string;
  title: string;
  category: HelpCategorySlug;
  /** The query's words in the title, for highlighting it. */
  titleMatches: HelpMatch[];
  /** A short plain-text passage around the first match in the body (else the summary), and the matches in it. */
  snippet: { text: string; matches: HelpMatch[] };
}

/** GET /api/help/search?q=: articles holding every word of the query, title hits first. */
export interface HelpSearchResult {
  query: string;
  hits: HelpSearchHit[];
}
