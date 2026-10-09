// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The session list's second line over a session the server has recapped (0418): the recap, and
 * the time it was written, take the place of the raw last reply the row used to show. What is
 * asserted here is that priority — a recap-less session still shows its reply, and a working
 * session still shows its tool rather than the recap of the turn before it.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), getSession: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSession, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000c1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000c2');
const RECAPPED_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000d1');
const REPLY_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000d2');
const RUNNING_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000d3');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const WORKSPACE = { id: WORKSPACE_PUBLIC, name: 'orbit', model: null, effort: null };

/** A list row, as GET /sessions answers it. */
const row = (id: string, title: string, extra: Record<string, unknown>) => ({
  id,
  workspaceId: WORKSPACE_PUBLIC,
  workspace: WORKSPACE,
  runnerId: RUNNER_ID,
  title,
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  createdAt: '2026-10-02T05:00:00Z',
  lastTurnAt: '2026-10-02T05:34:00Z',
  ...extra,
});

// Written just now, so the label is a bare clock time: the date only joins it on another day.
const RECAP_AT = new Date().toISOString();
const RECAP_TEXT = 'Moved the recap onto the list row; the three states are covered by tests.';
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const RECAP_LABEL = `Recap · ${clock(RECAP_AT)}`;

const RECAPPED = row(RECAPPED_PUBLIC, 'Recap on the list row', {
  recapText: RECAP_TEXT, recapAt: RECAP_AT, lastAssistantText: 'Committed the row change.',
});
const REPLY = row(REPLY_PUBLIC, 'Drawer shadow fix', {
  lastAssistantText: 'Fixed the drawer shadow; tests pass.',
});
const RUNNING = row(RUNNING_PUBLIC, 'Rebuilding the transcript page', {
  status: 'RUNNING', runState: 'RUNNING', engineStartedAt: '2026-10-02T05:00:00Z',
  lastToolUse: 'Bash', recapText: RECAP_TEXT, recapAt: RECAP_AT,
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const listRow = (title: string): HTMLElement => {
  const found = [...mounted().querySelectorAll<HTMLElement>('.session-row')].find(
    (el) => el.querySelector('.session-title')?.textContent === title,
  );
  if (!found) throw new Error(`no list row titled ${title}`);
  return found;
};

const line = (title: string): HTMLElement => {
  const found = listRow(title).querySelector<HTMLElement>('.session-preview');
  if (!found) throw new Error(`no line on the row titled ${title}`);
  return found;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(async (id: string) =>
    ([RECAPPED, REPLY, RUNNING].find((r) => r.id === id) ?? REPLY) as never);
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (init?.method && init.method !== 'GET') return reply(undefined);
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    for (const session of [RECAPPED, REPLY, RUNNING]) {
      if (path.startsWith(`/sessions/${session.id}`)) {
        if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(session);
      }
    }
    if (path.startsWith('/sessions')) return reply([RECAPPED, REPLY, RUNNING]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof api);
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
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('the session list over a recapped session', { timeout: 60_000 }, () => {
  it('shows the recap and its time, and leaves a reply-only or working row alone', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const nextContainer = document.createElement('div');
    const nextRoot = createRoot(nextContainer);
    client = nextClient;
    container = nextContainer;
    root = nextRoot;
    document.body.appendChild(nextContainer);
    // The reply-only session is open, so the recap and working rows are drawn from the list's
    // own copy of them rather than from the opened session's detail.
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${REPLY_PUBLIC}`]}>
            <AntApp>
              <WorkspaceView runner={RUNNER} />
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(listRow(RECAPPED.title)).not.toBeNull(), { timeout: 20_000, interval: 20 });
    });

    // With a recap: its label carries the time the server wrote it, and the line is the recap —
    // not the raw reply it replaced.
    const recapped = line(RECAPPED.title);
    expect(recapped.querySelector('.session-preview-label')?.textContent).toBe(RECAP_LABEL);
    expect(recapped.textContent).toBe(`${RECAP_LABEL} ${RECAP_TEXT}`);
    expect(recapped.textContent).not.toContain(RECAPPED.lastAssistantText);

    // No recap: the reply preview it always had, and no label in front of it.
    const reply = line(REPLY.title);
    expect(reply.querySelector('.session-preview-label')).toBeNull();
    expect(reply.textContent).toBe(REPLY.lastAssistantText);

    // Working: the tool in flight outranks the recap of the turn before it.
    const running = line(RUNNING.title);
    expect(running.querySelector('.session-preview-label')).toBeNull();
    expect(running.textContent).toBe('Running Bash…');
  });
});
