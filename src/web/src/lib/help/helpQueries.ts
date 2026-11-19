import { queryOptions } from '@tanstack/react-query';
import type { HelpArticle, HelpIndex, HelpSearchResult } from '@orbit/shared';
import { api, getToken } from '../../api';

// The help doors answer signed out too (src/apiserver/src/help): a request with no token is a signed-out
// reader, one with a token is judged as everywhere else, so an administrator is shown Admin & self-hosting.
// The token is part of each key, so signing in or out reads the library again for who is reading now.
const reader = () => (getToken() ? 'signed-in' : 'signed-out');

/** GET /api/help: the categories the reader may see and every article's front matter. */
export const helpIndexQuery = () =>
  queryOptions({
    queryKey: ['help', 'index', reader()] as const,
    queryFn: () => api<HelpIndex>('/help'),
    staleTime: 5 * 60_000,
  });

/** GET /api/help/articles/:slug: one article with its Markdown body. */
export const helpArticleQuery = (slug: string) =>
  queryOptions({
    queryKey: ['help', 'article', slug, reader()] as const,
    queryFn: () => api<HelpArticle>(`/help/articles/${encodeURIComponent(slug)}`),
    staleTime: 5 * 60_000,
    retry: false,
  });

/** GET /api/help/search?q=: articles holding every word, title hits first. */
export const helpSearchQuery = (q: string) =>
  queryOptions({
    queryKey: ['help', 'search', q, reader()] as const,
    queryFn: () => api<HelpSearchResult>(`/help/search?q=${encodeURIComponent(q)}`),
    staleTime: 60_000,
  });

/** An article's page on the web. */
export const helpArticlePath = (article: { category: string; slug: string }): string =>
  `/help/${article.category}/${article.slug}`;
