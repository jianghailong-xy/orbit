// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The session list's touch swipes, through the real row on a phone-width page: swiping right
 * exposes Complete then Pin, swiping left exposes Delete — the iOS list's layout
 * (`SessionRowActions.swift`). lib/sessionSwipe pins the gesture arithmetic; this pins that the row
 * wires it to the requests.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    completeSession: vi.fn(),
    deleteSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, completeSession, deleteSession, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const completeMock = vi.mocked(completeSession);
const deleteMock = vi.mocked(deleteSession);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');
const { MOBILE_QUERY } = await import('../lib/useMediaQuery');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000021';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000022');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000023');

const RUNNER = {
  id: RUNNER_ID,
  name: 'phone-runner',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: 'Fix login redirect loop',
  status: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-09-13T10:00:00Z',
  updatedAt: '2026-09-13T10:05:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  completeMock.mockReset();
  deleteMock.mockReset();
  completeMock.mockResolvedValue({});
  deleteMock.mockResolvedValue({});
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      return reply(SESSION);
    }
    if (path.startsWith('/sessions')) return reply([SESSION]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
  // A phone: the list's mobile layout (and its swipe handling) keys off MOBILE_QUERY.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === MOBILE_QUERY, media: query, onchange: null,
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

/** Mounts the page and returns the session's list row once it is on screen. */
async function mountRow(): Promise<HTMLElement> {
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
        <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(nextContainer.querySelector('.session-row')?.textContent).toContain(SESSION.title);
  });
  return nextContainer.querySelector<HTMLElement>('.session-row')!;
}

const touch = async (el: Element, type: 'touchstart' | 'touchmove' | 'touchend', x: number): Promise<void> => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 30 }] });
  await act(async () => {
    el.dispatchEvent(event);
  });
};

/** A horizontal finger drag of `dx` px across a 400px-wide row. */
async function swipe(row: HTMLElement, dx: number): Promise<void> {
  Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 400 }) });
  await touch(row, 'touchstart', 200);
  await touch(row, 'touchmove', 200 + Math.sign(dx) * 10);
  await touch(row, 'touchmove', 200 + dx);
  await touch(row, 'touchend', 200 + dx);
}

const labels = (row: HTMLElement, side: 'leading' | 'trailing'): (string | null)[] =>
  [...row.querySelectorAll(`.session-swipe-actions.${side} button`)].map((b) => b.getAttribute('aria-label'));
const offset = (row: HTMLElement): string => row.querySelector<HTMLElement>('.session-swipe')!.style.transform;
const tap = async (el: Element): Promise<void> => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('session row swipes on a phone', { timeout: 30_000 }, () => {
  it('swiping right exposes Complete then Pin, and Complete completes the session', async () => {
    const row = await mountRow();
    expect(labels(row, 'leading')).toEqual(['Complete', 'Pin']);
    expect(labels(row, 'trailing')).toEqual(['Delete']);
    expect(offset(row), 'a row at rest is not slid').toBe('');

    await swipe(row, 100);
    expect(offset(row)).toBe('translateX(144px)');
    expect(row.querySelector<HTMLElement>('.session-swipe-actions.leading')!.style.width).toBe('144px');
    expect(completeMock).not.toHaveBeenCalled();

    await tap(row.querySelector('[aria-label="Complete"]')!);
    await waitForUi(() => expect(completeMock).toHaveBeenCalledWith(SESSION_PUBLIC));
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('swiping left exposes Delete, which moves the session to Trash', async () => {
    const row = await mountRow();
    await swipe(row, -60);
    expect(offset(row)).toBe('translateX(-72px)');
    expect(row.querySelector<HTMLElement>('.session-swipe-actions.trailing')!.style.width).toBe('72px');

    await tap(row.querySelector('[aria-label="Delete"]')!);
    await waitForUi(() => expect(deleteMock).toHaveBeenCalledWith(SESSION_PUBLIC));
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('a long swipe right completes on release; a long swipe left only opens Delete', async () => {
    const row = await mountRow();
    await swipe(row, -390);
    expect(offset(row)).toBe('translateX(-72px)');
    expect(deleteMock, 'Delete never fires from a swipe alone').not.toHaveBeenCalled();

    // Straight from the open Delete edge through to past 60% of the row.
    await swipe(row, 330);
    await waitForUi(() => expect(completeMock).toHaveBeenCalledWith(SESSION_PUBLIC));
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
