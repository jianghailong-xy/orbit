// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
const CANCELLED_ID = '0195c0de-0000-7000-8000-0000000000c3';

const OPEN_PROJECT = {
  id: OPEN_ID,
  title: 'Row folding',
  status: 'OPEN',
  goal: 'Give the title the line',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 3 },
  buckets: { running: 1, ready: 2, blocked: 0, done: 0, cancelled: 0 },
  lastActivityAt: new Date().toISOString(),
};
const DONE_PROJECT = {
  id: DONE_ID,
  title: 'Shipped work',
  status: 'DONE',
  goal: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 1 },
  buckets: { running: 0, ready: 0, blocked: 0, done: 1, cancelled: 0 },
  lastActivityAt: '2026-01-02T00:00:00Z',
};
/** A project nobody has started, whose coordinator asked to start it two minutes ago (mock board3 ①). */
const STARTABLE_ID = '0195c0de-0000-7000-8000-0000000000c4';
const STARTABLE_PROJECT = {
  id: STARTABLE_ID,
  title: 'Runner 页整页改版（iOS/macOS + web）',
  status: 'OPEN',
  goal: 'One page for runners on every client',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 5 },
  buckets: { running: 0, ready: 1, blocked: 4, done: 0, cancelled: 0 },
  lastActivityAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  attention: {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
    ownerItems: [],
    coordinatorItems: null,
    startRequest: { waitingSince: new Date(Date.now() - 2 * 60 * 1000 - 5_000).toISOString() },
  },
};
const CANCELLED_PROJECT = {
  id: CANCELLED_ID,
  title: 'Discarded work',
  status: 'CANCELLED',
  goal: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-03T00:00:00Z',
  _count: { tasks: 1 },
  buckets: { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 1 },
  lastActivityAt: '2026-01-03T00:00:00Z',
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

function mountedContainer(): HTMLDivElement {
  if (!container) throw new Error('ProjectsPage is not mounted');
  return container;
}

async function waitForUi(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
}

function RouteProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

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
  const answers: Record<string, unknown[]> = {
    '/projects?status=OPEN': [OPEN_PROJECT],
    '/projects?status=DONE': [DONE_PROJECT],
    '/projects?status=CANCELLED': [CANCELLED_PROJECT],
    '/workspaces': [],
    '/runners': [],
  };
  apiMock.mockImplementation((path: string) => {
    const answer = answers[path];
    if (!answer) return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    return Promise.resolve(answer) as Promise<never>;
  });
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
  const mountedRoot = root;
  const mountedClient = client;
  const mountedNode = container;
  root = null;
  client = null;
  container = null;
  try {
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    try {
      if (mountedClient) {
        await mountedClient.cancelQueries();
        mountedClient.clear();
      }
    } finally {
      mountedNode?.remove();
      vi.unstubAllGlobals();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  }
});

async function mount(firstTitle = 'Row folding'): Promise<void> {
  const nextClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={['/projects']}>
          <ProjectsPage />
          <RouteProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(nextContainer.querySelector('.project-row-title')?.textContent).toBe(firstTitle);
    expect(nextContainer.querySelector('[data-testid="location"]')?.textContent).toBe('/projects');
  });
}

function currentLocation(): string | null {
  return mountedContainer().querySelector('[data-testid="location"]')?.textContent ?? null;
}

function segment(label: string): HTMLInputElement {
  const item = [...mountedContainer().querySelectorAll('.ant-segmented-item')].find((el) =>
    el.textContent?.trim().startsWith(label),
  );
  expect(item, `segment ${label}`).toBeTruthy();
  return item!.querySelector('input')! as HTMLInputElement;
}

async function click(element: HTMLElement, assertion: () => void): Promise<void> {
  await act(async () => {
    element.click();
  });
  await waitForUi(assertion);
}

function button(label: string): HTMLButtonElement {
  const found = [...mountedContainer().querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeTruthy();
  return found! as HTMLButtonElement;
}

/** The tags inside project ROWS. Scoped to the row head so a status word appearing in a section
 *  header or a pill cannot answer for the badge this is about. */
const rowTags = (): string[] =>
  [...mountedContainer().querySelectorAll('.project-row-head .ant-tag')].map((el) =>
    (el.textContent ?? '').trim(),
  );

const createButton = (): HTMLButtonElement =>
  mountedContainer().querySelector('.projects-new-button') as HTMLButtonElement;

describe('projects list on a phone', () => {
  it('drops the OPEN tag the section header already states', async () => {
    stubViewport(true);
    await mount();

    await waitForUi(() => {
      expect(rowTags()).toEqual([]);
      expect(createButton().textContent).toBe('');
    });
    expect(mountedContainer().querySelectorAll('.project-row').length).toBeGreaterThan(0);
    // The row itself is intact — only the badge went.
    expect(mountedContainer().querySelector('.project-row-title')?.textContent).toBe('Row folding');
    expect(currentLocation()).toBe('/projects');
    expect(apiMock).toHaveBeenCalledWith('/projects?status=OPEN');
  });

  it('keeps the OPEN tag on a desktop, where the row has room for it', async () => {
    stubViewport(false);
    await mount();

    await waitForUi(() => expect(rowTags()).toEqual(['OPEN']));
  });

  it('shows completed history flat without repeating its lifecycle in a header or row tag', async () => {
    stubViewport(true);
    await mount();
    await click(button('History'), () => expect(segment('Completed')).toBeTruthy());
    await click(segment('Completed'), () => {
      expect(
        mountedContainer().querySelector('section[data-section="completed"] .project-row-title')
          ?.textContent,
      ).toBe('Shipped work');
      expect(currentLocation()).toBe('/projects?status=DONE');
    });

    const terminal = mountedContainer().querySelector('section[data-section="completed"]')!;
    expect(terminal).toBeTruthy();
    expect(terminal.querySelector('h3')).toBeNull();
    expect(terminal.querySelector('button')).toBeNull();
    expect(terminal.querySelector('.project-row-title')?.textContent).toBe('Shipped work');
    expect(rowTags()).toEqual([]);
    expect(currentLocation()).toBe('/projects?status=DONE');
    expect(apiMock).toHaveBeenCalledWith('/projects?status=DONE');
  });

  it('gives cancelled history the same flat, non-repeating phone treatment', async () => {
    stubViewport(true);
    await mount();
    await click(button('History'), () => expect(segment('Cancelled')).toBeTruthy());
    await click(segment('Cancelled'), () => {
      expect(
        mountedContainer().querySelector('section[data-section="cancelled"] .project-row-title')
          ?.textContent,
      ).toBe('Discarded work');
      expect(currentLocation()).toBe('/projects?status=CANCELLED');
    });

    const terminal = mountedContainer().querySelector('section[data-section="cancelled"]')!;
    expect(terminal).toBeTruthy();
    expect(terminal.querySelector('h3')).toBeNull();
    expect(terminal.querySelector('button')).toBeNull();
    expect(terminal.querySelector('.project-row-title')?.textContent).toBe('Discarded work');
    expect(rowTags()).toEqual([]);
    expect(currentLocation()).toBe('/projects?status=CANCELLED');
    expect(apiMock).toHaveBeenCalledWith('/projects?status=CANCELLED');
  });

  it('shrinks the create button to its icon without losing its name', async () => {
    stubViewport(true);
    await mount();

    await waitForUi(() => expect(createButton().textContent).toBe(''));
    const btn = createButton();
    expect(btn.textContent).toBe('');
    expect(btn.getAttribute('aria-label')).toBe('New project');
    // Still the same control: the icon is what is left to press.
    expect(btn.querySelector('.anticon-plus')).toBeTruthy();
  });

  it('leads with a project waiting to be started: Needs attention, and Needs you · Ready to start', async () => {
    stubViewport(true);
    apiMock.mockImplementation((path: string) => {
      if (path === '/projects?status=OPEN') return Promise.resolve([OPEN_PROJECT, STARTABLE_PROJECT]) as Promise<never>;
      if (path === '/workspaces' || path === '/runners') return Promise.resolve([]) as Promise<never>;
      return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
    });
    await mount(STARTABLE_PROJECT.title);

    const attention = mountedContainer().querySelector('section[data-section="attention"]')!;
    expect(attention).toBeTruthy();
    expect(attention.querySelector('.project-row-title')?.textContent).toBe(STARTABLE_PROJECT.title);
    expect(attention.querySelector('.project-row-chip')?.textContent).toBe('Needs you · Ready to start · 2m');
    expect(attention.querySelector('.project-row-chip')?.classList.contains('project-row-chip-warning')).toBe(true);
    // The phone drops the status tag, for this row as for every other.
    await waitForUi(() => expect(rowTags()).toEqual([]));
    // The project nobody is waiting on stays where its work puts it.
    expect(
      mountedContainer().querySelector('section[data-section="running"] .project-row-title')?.textContent,
    ).toBe('Row folding');
  });

  it('spells the label out on a desktop, and needs no aria-label to do it', async () => {
    stubViewport(false);
    await mount();

    await waitForUi(() => expect(createButton().textContent).toContain('New project'));
    const btn = createButton();
    expect(btn.textContent).toContain('New project');
    expect(btn.getAttribute('aria-label')).toBeNull();
  });
});
