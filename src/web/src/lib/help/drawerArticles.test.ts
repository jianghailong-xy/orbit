import { describe, expect, it } from 'vitest';
import type { HelpArticleMeta } from '@orbit/shared';
import { forThisPage, getStartedArticles, highlightPieces, routeLabel, routeMatches } from './drawerArticles';

const meta = (slug: string, over: Partial<HelpArticleMeta> = {}): HelpArticleMeta => ({
  slug,
  title: slug,
  summary: '',
  category: 'machines-and-engines',
  routes: [],
  errors: [],
  platforms: ['web'],
  common: false,
  updated: '2026-11-14',
  ...over,
});

describe('routeMatches', () => {
  it('reads :name and * as one segment, ** as any number, the rest literally', () => {
    expect(routeMatches('/settings/machines/:id', '/settings/machines/r1')).toBe(true);
    expect(routeMatches('/settings/machines/*', '/settings/machines/r1')).toBe(true);
    expect(routeMatches('/settings/machines/:id', '/settings/machines')).toBe(false);
    expect(routeMatches('/settings/machines/:id', '/settings/machines/r1/extra')).toBe(false);
    expect(routeMatches('/settings/**', '/settings')).toBe(true);
    expect(routeMatches('/settings/**', '/settings/machines/r1')).toBe(true);
    expect(routeMatches('/', '/')).toBe(true);
    expect(routeMatches('/', '/tasks')).toBe(false);
    expect(routeMatches('/settings/machines/new', '/settings/machines/r1')).toBe(false);
    expect(routeMatches('/tasks', '/tasks/?view=board')).toBe(true);
  });
});

describe('forThisPage', () => {
  const machine = ['a', 'b', 'c', 'd', 'e'].map((s) => meta(s, { routes: ['/settings/machines/:id'] }));
  const offline = meta('machine-offline', { routes: ['/infrastructure'], errors: ['runner.offline'] });
  const library = [...machine, offline, meta('ws', { routes: ['/settings/workspaces/:id'] })];

  it('lists the route’s articles in library order, at most 4', () => {
    expect(forThisPage(library, '/settings/machines/r1', []).map((r) => r.article.slug)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('is empty when no article’s routes match', () => {
    expect(forThisPage(library, '/tasks', [])).toEqual([]);
  });

  it('puts the article for a visible error first, pinned, still within 4', () => {
    const rows = forThisPage(library, '/settings/machines/r1', ['runner.offline']);
    expect(rows.map((r) => [r.article.slug, r.pinned])).toEqual([
      ['machine-offline', true],
      ['a', false],
      ['b', false],
      ['c', false],
    ]);
    // Pinned even where its routes do not match.
    expect(forThisPage(library, '/tasks', ['runner.offline']).map((r) => r.article.slug)).toEqual(['machine-offline']);
  });

  it('of two articles on the same error, puts the one about this page first', () => {
    const elsewhere = meta('sessions-that-pause', { routes: ['/sessions/:id'], errors: ['runner.offline'] });
    const here = meta('machine-offline', { routes: ['/settings/machines/:id'], errors: ['runner.offline'] });
    expect(forThisPage([elsewhere, here], '/settings/machines/r1', ['runner.offline']).map((r) => [r.article.slug, r.pinned])).toEqual([
      ['machine-offline', true],
      ['sessions-that-pause', true],
    ]);
  });

  it('Get started is the get-started category', () => {
    expect(getStartedArticles([...library, meta('five', { category: 'get-started' })]).map((a) => a.slug)).toEqual(['five']);
  });
});

describe('highlightPieces', () => {
  it('cuts a text into plain and marked pieces', () => {
    expect(highlightPieces('A machine shows Offline', [{ start: 16, length: 7 }])).toEqual([
      { text: 'A machine shows ', mark: false },
      { text: 'Offline', mark: true },
    ]);
    expect(highlightPieces('no hits', [])).toEqual([{ text: 'no hits', mark: false }]);
  });
});

describe('routeLabel', () => {
  it('names the page from its first words', () => {
    expect(routeLabel('/settings/machines/0196f000')).toBe('Settings → Machines');
    expect(routeLabel('/')).toBe('Home');
  });
});
