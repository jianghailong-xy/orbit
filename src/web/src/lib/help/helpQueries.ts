import { queryOptions } from '@tanstack/react-query';
import { DEFAULT_HELP_LANGUAGE, type HelpArticle, type HelpIndex, type HelpLanguage, type HelpSearchResult } from '@orbit/shared';
import { api, getToken } from '../../api';

// The help doors answer signed out too (src/apiserver/src/help): a request with no token is a signed-out
// reader, one with a token is judged as everywhere else, so an administrator is shown Admin & self-hosting.
// The token is part of each key, so signing in or out reads the library again for who is reading now.
const reader = () => (getToken() ? 'signed-in' : 'signed-out');

/** The language is part of every key, so choosing another reads the library again in it. English keeps the plain
 *  address it had before there was a choice. */
const withLanguage = (route: string, language: HelpLanguage): string =>
  language === DEFAULT_HELP_LANGUAGE
    ? route
    : `${route}${route.includes('?') ? '&' : '?'}lang=${encodeURIComponent(language)}`;

/** GET /api/help: the categories the reader may see and every article's front matter. */
export const helpIndexQuery = (language: HelpLanguage = DEFAULT_HELP_LANGUAGE) =>
  queryOptions({
    queryKey: ['help', 'index', reader(), language] as const,
    queryFn: () => api<HelpIndex>(withLanguage('/help', language)),
    staleTime: 5 * 60_000,
  });

/** GET /api/help/articles/:slug: one article with its Markdown body. */
export const helpArticleQuery = (slug: string, language: HelpLanguage = DEFAULT_HELP_LANGUAGE) =>
  queryOptions({
    queryKey: ['help', 'article', slug, reader(), language] as const,
    queryFn: () => api<HelpArticle>(withLanguage(`/help/articles/${encodeURIComponent(slug)}`, language)),
    staleTime: 5 * 60_000,
    retry: false,
  });

/** GET /api/help/search?q=: articles holding every word, title hits first. */
export const helpSearchQuery = (q: string, language: HelpLanguage = DEFAULT_HELP_LANGUAGE) =>
  queryOptions({
    queryKey: ['help', 'search', q, reader(), language] as const,
    queryFn: () => api<HelpSearchResult>(withLanguage(`/help/search?q=${encodeURIComponent(q)}`, language)),
    staleTime: 60_000,
  });

/** An article's page on the web. */
export const helpArticlePath = (article: { category: string; slug: string }): string =>
  `/help/${article.category}/${article.slug}`;
