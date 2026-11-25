// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * A session held by its runner's update, as the server sends it (docs/runner-update-drain-design.md §7.3): a turn
 * ended on the draining runner with a follow-up queued and a dev server still up. The fixture is the apiserver's own
 * replies, captured by turn-complete-draining.pg.spec.ts case 7; the same file runs the OrbitKit and Android tests.
 * Held to: every surface reads it queued behind the update (board 5 of docs/mocks/runner-update-drain), never
 * Running, and its Stop asks for the background work too — the request case 7 shows the server accepting.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // `interruptSession` stays REAL: the press below wants the request that reaches the wire.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn(), cancelQueuedTurn: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({ loadTranscript: async () => null, saveTranscript: async () => {} }));

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView, sessionLine, statusLabel } = await import('./WorkspaceView');
const { sessionRunStateOf } = await import('../lib/sessionState');

const FIXTURE = [
  resolve(process.cwd(), '../shared/src/runner-update-held-session.fixture.json'),
  resolve(process.cwd(), 'src/shared/src/runner-update-held-session.fixture.json'),
];
function readFixture(): any {
  for (const path of FIXTURE) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`runner-update-held-session.fixture.json not found from ${process.cwd()}`);
}
const held = readFixture();
const { listRow, detail, queuedTurns } = held;
const RUNNER = held.runner as Runner;

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
const fetchMock = vi.fn();

const mounted = () => container!;
const stopButton = () => mounted().querySelector('[aria-label="Stop"]');

const waitForUi = async (assertion: () => void): Promise<void> => {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  fetchMock.mockReset().mockImplementation(async (url: string) => {
    const body = String(url).includes('/interrupt') ? { ok: true } : [];
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body), json: async () => body };
  });
  vi.stubGlobal('fetch', fetchMock);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(listQueuedTurns).mockImplementation(async () => queuedTurns);
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') return reply([held.workspace]);
    if (path === '/runners') return reply([RUNNER]);
    if (path.startsWith(`/sessions/${listRow.id}`)) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply(detail);
    }
    if (path.startsWith('/sessions')) return reply([listRow]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
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
  try {
    if (root) await act(async () => root!.unmount());
  } finally {
    await client?.cancelQueries();
    client?.clear();
    container?.remove();
    root = null;
    client = null;
    container = null;
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

async function mountHeld(): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  root = createRoot(container);
  document.body.appendChild(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter initialEntries={[`/sessions/${listRow.id}`]}>
          <WorkspaceView runner={RUNNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => expect(mounted().textContent).toContain(listRow.title));
}

describe('the server’s payload for a session held by a runner update', { timeout: 60_000 }, () => {
  it('is what the server sends for one', () => {
    for (const payload of [listRow, detail]) {
      expect([payload.phase, payload.waitingOn]).toEqual(['PENDING', 'HOLD']);
    }
    expect(listRow.queuedReason).toBe('runner_updating');
    expect(listRow.queuedRunnerUpdate.turns).toHaveLength(2);
    expect(listRow.runningBgCount).toBe(1);
  });

  it('reads queued behind the update on the list row and the header, never Running', () => {
    expect(sessionRunStateOf(listRow)).toBe('QUEUED');
    expect(sessionLine(listRow, true)).toEqual({ text: 'Runner updating', tone: 'warning' });
    expect(statusLabel(listRow)).toBe('Runner updating');
    // The detail names no gate of its own: laid over the row, as the page lays it, it changes no word.
    expect(sessionRunStateOf(detail)).toBe('QUEUED');
    expect(statusLabel({ ...listRow, ...detail })).toBe('Runner updating');
  });

  it('draws board 5’s queued page, with the turns it waits for and Later and Update Now', async () => {
    await mountHeld();
    await waitForUi(() => expect(mounted().querySelector('.chat-queued-title')?.textContent).toBe('Runner updating'));
    expect(mounted().querySelector('.chat-queued-desc')?.textContent).toBe(
      'studio-mac is updating to 0.1.254. It starts no new work until 2 turns finish: Backfill missing shard rows and Why are 11-08 metrics zero. This session starts right after.',
    );
    expect(mounted().querySelector('.chat-queued-waited')?.textContent).toMatch(/^Waiting /);
    const actions = [...mounted().querySelectorAll('.chat-queued-state .runner-update-actions button')].map((b) => b.textContent?.trim());
    expect(actions).toEqual(['Later', 'Update Now…']);
    expect(mounted().textContent).not.toMatch(/\bRunning\b/);
  });

  it('tags the queued follow-up `Queued · runner updating`', async () => {
    await mountHeld();
    await waitForUi(() => expect(mounted().querySelector('.chat-runner-updating')?.textContent).toBe('Queued·runner updating'));
    expect(mounted().textContent).toContain('And check the queue after that.');
  });

  it('offers Stop for the background work, and the press asks the server to end it', async () => {
    await mountHeld();
    await waitForUi(() => expect(stopButton(), 'a queued session with background work offers Stop').not.toBeNull());
    await act(async () => {
      stopButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitForUi(() => {
      const posted = fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith('/interrupt'))
        .map(([url, init]) => [url, (init as RequestInit).method, JSON.parse(String((init as RequestInit).body))]);
      expect(posted).toEqual([[`/api/sessions/${listRow.id}/interrupt`, 'POST', { stopBackgroundWork: true }]]);
    });
  });
});
