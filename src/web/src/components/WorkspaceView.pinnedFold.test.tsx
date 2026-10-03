// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The session list's Pinned section folds to its heading, as Notes' Pinned does (and as the iOS list
 * does, `AgentsView.swift`): its heading is a button, folding takes the pinned rows off the list and
 * out of Up/Down, and the fold is remembered across reloads.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const FOLD_KEY = 'orbit.sessionPinnedCollapsed';
const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');

const RUNNER = {
  id: RUNNER_ID,
  name: 'desk-runner',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const session = (n: number, title: string, pinnedAt: string | null) => ({
  id: encodeId(`0195c0de-0000-7000-8000-00000000003${n}`),
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title,
  status: 'AWAITING_INPUT',
  provider: 'claude',
  pinnedAt,
  createdAt: '2026-09-13T10:00:00Z',
  updatedAt: '2026-09-13T10:05:00Z',
});
const PINNED = session(3, 'Release checklist', '2026-09-13T11:00:00Z');
const OTHER = session(4, 'Fix login redirect loop', null);

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let stored: Record<string, string> = {};
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const waitForUi = async (assertion: () => void): Promise<void> => {
  // The act environment is off while the window is waited out, as RTL's own asyncWrapper
  // does it: React queues every render scheduled inside an in-flight act callback and flushes
  // none of them until that callback settles, so a page that answers inside the window can
  // never draw what the window exists to see — the wait times out with the data already in
  // the cache (workstation-gpu: e85b63ee9's second full run; the merge check reds here).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  // And one act to close the window: the last commit the wait saw leaves its passive effects
  // scheduled, and what they carry — React Query's mutation options among it — is what the
  // test's next press runs on. The old act-wrapped wait flushed them on its way out; this
  // keeps that, without the freeze that made the wait itself blind.
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  stored = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
    removeItem: (k: string) => {
      delete stored[k];
    },
  });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    const one = [PINNED, OTHER].find((s) => path.startsWith(`/sessions/${s.id}`));
    if (one) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply(one);
    }
    if (path.startsWith('/sessions')) return reply([PINNED, OTHER]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
  // A desktop window: no media query matches.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const node = container;
  root = null;
  client = null;
  container = null;
  try {
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    if (mountedClient) {
      await mountedClient.cancelQueries();
      mountedClient.clear();
    }
    node?.remove();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Mounts the page on OTHER and waits for the Pinned heading and OTHER's row. */
async function mountList(): Promise<HTMLDivElement> {
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${OTHER.id}`]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(heading(nextContainer)).not.toBeNull();
    expect(rowTitles(nextContainer)).toContain(OTHER.title);
  });
  return nextContainer;
}

const heading = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button.session-section-fold');
const rowTitles = (el: HTMLElement) =>
  [...el.querySelectorAll('.session-row .session-title')].map((t) => t.textContent);
const click = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('the Pinned section folds', () => {
  it('folds to its heading and back from the heading, remembering each', async () => {
    const page = await mountList();
    expect(heading(page)!.textContent).toBe('Pinned');
    expect(heading(page)!.getAttribute('aria-expanded')).toBe('true');
    expect(rowTitles(page)).toEqual([PINNED.title, OTHER.title]);

    await click(heading(page)!);
    expect(heading(page)!.getAttribute('aria-expanded')).toBe('false');
    expect(rowTitles(page)).toEqual([OTHER.title]);
    expect(stored[FOLD_KEY]).toBe('1');

    await click(heading(page)!);
    expect(heading(page)!.getAttribute('aria-expanded')).toBe('true');
    expect(rowTitles(page)).toEqual([PINNED.title, OTHER.title]);
    expect(stored[FOLD_KEY]).toBe('0');
  });

  it('opens folded when the fold was stored', async () => {
    stored[FOLD_KEY] = '1';
    const page = await mountList();
    expect(heading(page)!.getAttribute('aria-expanded')).toBe('false');
    expect(rowTitles(page)).toEqual([OTHER.title]);
  });

  it('leaves folded rows out of Up/Down', async () => {
    const page = await mountList();
    const active = () => page.querySelector('.session-row.active .session-title')?.textContent;
    await waitForUi(() => expect(active()).toBe(OTHER.title));
    const up = async () => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      });
    };

    await click(heading(page)!);
    await up();
    // Up from the first row on screen stops there; it doesn't open the folded session.
    expect(active()).toBe(OTHER.title);

    await click(heading(page)!);
    await up();
    await waitForUi(() => expect(active()).toBe(PINNED.title));
  });
});
