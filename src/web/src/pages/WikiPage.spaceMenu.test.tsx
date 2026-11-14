// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiSpaceWithUsage } from '../lib/wiki';
import { WikiPage } from './WikiPage';

/**
 * The space menu the Wiki's name opens among several spaces (board docs/mocks/wiki-space-menu B): the console's own
 * menu, not the browser's select — a row a space, its name over its repository and documents, what waits in it as the
 * sidebar's amber count, the current one lit; Manage spaces at its foot, into Wiki settings.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: () => new Promise(() => undefined),
}));

const space = (over: Partial<WikiSpaceWithUsage> & Pick<WikiSpaceWithUsage, 'id' | 'slug'>): WikiSpaceWithUsage => ({
  title: over.slug,
  repoUrlNorm: `github.com/wikova/${over.slug}`,
  rootCommitSha: 'b'.repeat(40),
  settings: { push: true, autoAcceptReinforce: true },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pendingOps: 0,
  planWaiting: 0,
  workspaceIds: [],
  docs: null,
  ...over,
});
const SPACES = [
  space({ id: '2zwQZ2hd93IvLb59t6pDl', slug: 'orbit', pendingOps: 1, planWaiting: 1, docs: { written: 30, total: 35 } }),
  space({ id: '2zwQZ2hd93IvLb59t6pDm', slug: 'wikova', docs: { written: 5, total: 12 } }),
  space({ id: '2zwQZ2hd93IvLb59t6pDn', slug: 'cbai' }),
];

let container: HTMLDivElement;
let root: Root | null = null;
let at = '';

function Where() {
  at = useLocation().pathname;
  return null;
}

async function visit(path: string) {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['wiki', 'spaces'], SPACES);
  for (const row of SPACES) client.setQueryData(['wiki', 'space', row.id], row);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/wiki/:space" element={<WikiPage route="home" />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => (el as HTMLElement).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const trigger = () => container.querySelector('.wk-rail-head .wk-select');
const rows = () => [...document.querySelectorAll('[role="menu"].wk-space-menu [role="menuitem"]')];

describe('the Wiki’s space menu', () => {
  it('is the console’s menu: a row a space with its repository and documents, the amber count, the current one lit, then Manage spaces', async () => {
    await visit('/wiki/orbit');
    expect(trigger()?.tagName).toBe('BUTTON');
    expect(trigger()?.textContent).toBe('orbit');
    expect(container.querySelector('select')).toBeNull();

    await click(trigger());
    const lines = rows().map((row) => [
      row.querySelector('.n')?.textContent ?? row.textContent,
      row.querySelector('.s')?.textContent ?? null,
      row.querySelector('.needs-you')?.textContent ?? null,
      row.hasAttribute('data-selected'),
    ]);
    expect(lines).toEqual([
      ['orbit', 'github.com/wikova/orbit · 35 documents', '2', true],
      ['wikova', 'github.com/wikova/wikova · 12 documents', null, false],
      ['cbai', 'github.com/wikova/cbai · No documents yet', null, false],
      ['Manage spaces', null, null, false],
    ]);
    // A reader that cannot see the amber hears what waits.
    expect(rows()[0].getAttribute('aria-label') ?? rows()[0].textContent).toContain('orbit');
    expect(rows()[0].querySelector('.needs-you')?.getAttribute('title')).toBe('2 waiting on you');
  });

  it('opens another space at its home, and Manage spaces into Wiki settings', async () => {
    await visit('/wiki/orbit');
    await click(trigger());
    await click(rows().find((row) => row.textContent?.startsWith('wikova')));
    expect(at).toBe('/wiki/wikova');

    await click(trigger());
    await click(rows().find((row) => row.textContent === 'Manage spaces'));
    expect(at).toBe('/wiki/wikova/settings');
  });
});
