import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../lib/theme';
import type { WikiSpaceRow } from '../lib/wiki';
import { wikiWaiting } from '../lib/wikiSpace';
import { TasksSidePanel } from './TasksSidePanel';

// The panel is drawn in a browser and reads the browser's own state as it renders: the theme's
// media query and the sidebar's stored width are both module-level reads, so the two stubs have to
// exist BEFORE the imports are evaluated — which is what `vi.hoisted` is for.
vi.hoisted(() => {
  const noop = (): void => undefined;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: noop, removeItem: noop });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    location: { host: 'localhost', origin: 'http://localhost', pathname: '/' },
  });
});

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

/**
 * The Wiki's row in the left sidebar: where it sits, what its amber number counts, and the sentence
 * that number explains itself with.
 *
 * WHAT THE NUMBER IS: what waits on the owner across every space — the proposals in Review and what
 * each plan waits on them for (design §12.3.3) — the number the Wiki head's Activity badge shows, from
 * the same function (`wikiWaiting`), and what Activity's amber banners add up to: the number and its
 * destination have to agree or the pill is a dead end. It wears `.tp-count.needs-you`, which is the pill
 * a workspace row uses for the same kind of fact ("this is on you"), says itself the way the Projects
 * row does (`N waiting on you`), and is not drawn at zero: an amber 0 is a demand that isn't there.
 */

function space(pendingOps: number, planWaiting = 0): WikiSpaceRow {
  return {
    id: `0196d000-0000-7000-8000-00000000000${pendingOps}`,
    slug: 'orbit',
    title: 'Orbit',
    repoUrlNorm: 'github.com/jianghailong-xy/orbit',
    rootCommitSha: null,
    settings: { push: true, autoAcceptReinforce: true },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    pendingOps,
    planWaiting,
  };
}

/** `null` is the server's WIKI_DISABLED (`wikiSpacesQuery`); `undefined` is a read not answered yet. */
function paint(spaces: WikiSpaceRow[] | null | undefined, path = '/'): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (spaces !== undefined) client.setQueryData(['wiki', 'spaces'], spaces);
  client.setQueryData(['user', 'me'], { id: 'user', email: 'a@b.c', name: 'wikova', createdAt: '', role: 'MEMBER' });
  client.setQueryData(['workspaces'], []);
  client.setQueryData(['runners'], []);
  client.setQueryData(['session-counts'], []);
  client.setQueryData(['tasklists'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <TasksSidePanel />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('the sidebar’s Wiki entry', () => {
  it('sits under Projects, with the book mark and no shortcut of its own', () => {
    const html = paint([space(3)]);
    // The labels as the expanded nav spells them (`>Projects<` is the row's own label span; the
    // collapsed rail carries the same words only in `title` attributes).
    const projects = html.indexOf('>Projects<');
    const wiki = html.indexOf('>Wiki<');
    const infrastructure = html.indexOf('>Infrastructure<');
    expect(projects).toBeGreaterThan(-1);
    expect(wiki).toBeGreaterThan(projects);
    expect(infrastructure).toBeGreaterThan(wiki);
    expect(html).toContain('sidebar-nav-icon-wiki');
    // Reachable and activatable by keyboard, which is what the row's `role="link"` promises.
    expect(html).toContain('role="link" tabindex="0" title="Wiki"');
  });

  it('counts what waits on the owner, and explains the number on hover and to a screen reader', () => {
    const html = paint([space(3)]);
    expect(html).toContain('tp-count needs-you');
    expect(html).toContain('>3</span>');
    expect(html).toContain('title="3 waiting on you" aria-label="3 waiting on you"');
    // The collapsed rail's badge says the same.
    expect(html).toContain('class="tp-rail-badge needs-you" title="3 waiting on you"');
    expect(html).not.toContain('proposals to review');
  });

  it('draws no amber number when nothing is waiting', () => {
    const html = paint([space(0)]);
    expect(html).toContain('>Wiki<');
    expect(html).not.toContain('needs-you');
    expect(html).not.toContain('waiting on you');
  });

  it('adds up every space’s proposals and every thing its plan waits on — the head badge’s own sum', () => {
    // orbit: 2 proposals and a draft to confirm; wikova: 1 proposal and 2 plan changes.
    const rows = [space(2, 1), { ...space(1, 2), id: 'other', slug: 'wikova', repoUrlNorm: 'github.com/jianghailong-xy/wikova' }];
    const html = paint(rows);
    expect(wikiWaiting(rows)).toBe(6);
    expect(html).toContain('title="6 waiting on you"');
    expect(html).toContain('>6</span>');
  });

  it('counts a plan waiting when no proposal is', () => {
    const html = paint([space(0, 2)]);
    expect(html).toContain('title="2 waiting on you"');
  });

  it('marks the row as the open one on a wiki route', () => {
    const html = paint([space(1)], '/wiki/orbit');
    expect(html).toContain('aria-current="page"');
  });
});

describe('the sidebar, for an account the server has not switched the wiki on for', () => {
  it('has no Wiki row in either form, and keeps every other row', () => {
    const html = paint(null);
    expect(html).not.toContain('>Wiki<');
    expect(html).not.toContain('title="Wiki"');
    expect(html).not.toContain('sidebar-nav-icon-wiki');
    expect(html).toContain('>Projects<');
    expect(html).toContain('>Infrastructure<');
  });

  it('offers no Wiki row before the server has answered, either', () => {
    const html = paint(undefined);
    expect(html).not.toContain('>Wiki<');
    expect(html).toContain('>Projects<');
  });
});
