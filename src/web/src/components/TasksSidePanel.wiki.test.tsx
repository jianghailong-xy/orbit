import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../lib/theme';
import type { WikiSpaceRow } from '../lib/wiki';
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
 * WHAT THE NUMBER IS: the proposals waiting for the owner, summed over every space — the same count
 * Review's own page opens on, because the number and its destination have to agree or the pill is a
 * dead end. It wears `.tp-count.needs-you`, which is the pill a workspace row uses for the same kind
 * of fact ("this is on you"), and it is not drawn at zero: an amber 0 is a demand that isn't there.
 */

function space(pendingOps: number): WikiSpaceRow {
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
  };
}

function paint(spaces: WikiSpaceRow[], path = '/'): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['wiki', 'spaces'], spaces);
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
    const runners = html.indexOf('>Runners<');
    expect(projects).toBeGreaterThan(-1);
    expect(wiki).toBeGreaterThan(projects);
    expect(runners).toBeGreaterThan(wiki);
    expect(html).toContain('anticon-book');
    // Reachable and activatable by keyboard, which is what the row's `role="link"` promises.
    expect(html).toContain('role="link" tabindex="0" title="Wiki"');
  });

  it('counts the proposals waiting, and explains the number on hover', () => {
    const html = paint([space(3)]);
    expect(html).toContain('tp-count needs-you');
    expect(html).toContain('>3</span>');
    expect(html).toContain('title="3 proposals to review"');
  });

  it('draws no amber number when nothing is waiting', () => {
    const html = paint([space(0)]);
    expect(html).toContain('>Wiki<');
    expect(html).not.toContain('needs-you');
    expect(html).not.toContain('proposals to review');
  });

  it('adds up every space, because Review’s own page asks across all of them', () => {
    const html = paint([space(2), { ...space(1), id: 'other', slug: 'wikova' }]);
    expect(html).toContain('title="3 proposals to review"');
  });

  it('marks the row as the open one on a wiki route', () => {
    const html = paint([space(1)], '/wiki/orbit');
    expect(html).toContain('aria-current="page"');
  });
});
