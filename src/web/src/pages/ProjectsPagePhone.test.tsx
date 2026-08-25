// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the projects list drops on a phone, and what it keeps.
 *
 * Two of the narrow-screen decisions cannot be made in the stylesheet — a status tag that should
 * not be in the DOM at all, and a button that has to lose its label without losing its accessible
 * name — so they run off `useMediaQuery(PROJECTS_PHONE_QUERY)` and are asserted here. The rest of
 * the phone layout is CSS (see the `@media (max-width: 640px)` block in index.css), which a jsdom
 * render computes nothing of; that half is measured in a browser instead.
 *
 * Mounted rather than statically rendered, because `useMediaQuery` reports the desktop reading
 * until its effect runs — a static render can only ever see the wide branch.
 */
vi.mock('../api', () => ({ api: vi.fn() }));
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { ProjectsPage } = await import('./ProjectsPage');

const OPEN_ID = '0195c0de-0000-7000-8000-0000000000c1';
const DONE_ID = '0195c0de-0000-7000-8000-0000000000c2';

const PROJECTS = [
  {
    id: OPEN_ID,
    title: 'Row folding',
    status: 'OPEN',
    goal: 'Give the title the line',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    _count: { tasks: 3 },
    buckets: { running: 1, ready: 2, blocked: 0, done: 0, cancelled: 0 },
    lastActivityAt: '2026-01-02T00:00:00Z',
  },
  {
    id: DONE_ID,
    title: 'Shipped work',
    status: 'DONE',
    goal: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    _count: { tasks: 1 },
    buckets: { running: 0, ready: 0, blocked: 0, done: 1, cancelled: 0 },
    lastActivityAt: '2026-01-02T00:00:00Z',
  },
];

let container: HTMLDivElement;
let root: Root;

/** `matches` for the projects breakpoint only — everything else answers false, which is what
 *  antd's own breakpoint subscriptions want and is the desktop reading they already assume. */
function stubViewport(phone: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === '(max-width: 640px)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMock.mockReset();
  apiMock.mockResolvedValue(PROJECTS as never);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // One macrotask: an `await act` alone drains microtasks, which is not where react-query settles.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The tags inside project ROWS. Scoped to the row head so a status word appearing in a section
 *  header or a pill cannot answer for the badge this is about. */
const rowTags = (): string[] =>
  [...container.querySelectorAll('.project-row-head .ant-tag')].map((el) =>
    (el.textContent ?? '').trim(),
  );

/** A DIRECT child of the toolbar: antd 6 renders the search box's own clear affordance as a real
 *  `<button>` inside the Input, and a descendant selector finds that one first. */
const createButton = (): HTMLButtonElement =>
  container.querySelector('.projects-toolbar > button') as HTMLButtonElement;

describe('projects list on a phone', () => {
  it('drops the OPEN tag the section header already states', async () => {
    stubViewport(true);
    await mount();

    expect(container.querySelectorAll('.project-row').length).toBeGreaterThan(0);
    expect(rowTags()).toEqual([]);
    // The row itself is intact — only the badge went.
    expect(container.querySelector('.project-row-title')?.textContent).toBe('Row folding');
  });

  it('keeps the OPEN tag on a desktop, where the row has room for it', async () => {
    stubViewport(false);
    await mount();

    expect(rowTags()).toEqual(['OPEN']);
  });

  it('keeps a DONE tag on a phone — that one is not predictable from the header', async () => {
    stubViewport(true);
    await mount();

    // Completed folds shut on first render, so the finished project is a pill until asked for.
    const expand = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').trim().startsWith('Expand'),
    );
    expect(expand, 'Completed section expander').toBeTruthy();
    await act(async () => expand!.click());

    expect(rowTags()).toEqual(['DONE']);
  });

  it('shrinks the create button to its icon without losing its name', async () => {
    stubViewport(true);
    await mount();

    const btn = createButton();
    expect(btn.textContent).toBe('');
    expect(btn.getAttribute('aria-label')).toBe('New project');
    // Still the same control: the icon is what is left to press.
    expect(btn.querySelector('.anticon-plus')).toBeTruthy();
  });

  it('spells the label out on a desktop, and needs no aria-label to do it', async () => {
    stubViewport(false);
    await mount();

    const btn = createButton();
    expect(btn.textContent).toContain('New project');
    expect(btn.getAttribute('aria-label')).toBeNull();
  });
});
