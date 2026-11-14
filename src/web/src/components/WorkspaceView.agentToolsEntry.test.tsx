// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * The session's door to Agent tools (docs/mocks/agent-tools/01-board.png ①, D1), on the real WorkspaceView: the
 * header's More actions lists "Agent tools" right after Find in session, with the connection's word on the row
 * — read from the session's own detail, the runner's report — and the row opens the read-only drawer.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), getSession: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({ loadTranscript: async () => null, saveTranscript: async () => {} }));

const { api, getSession, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000d1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000d2');
const REPORTED = encodeId('0195c0de-0000-7000-8000-0000000000d3');
const SILENT = encodeId('0195c0de-0000-7000-8000-0000000000d4');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;
const WORKSPACE = { id: WORKSPACE_PUBLIC, name: 'orbit', model: null, effort: null };

const row = (id: string, title: string) => ({
  id,
  workspaceId: WORKSPACE_PUBLIC,
  workspace: WORKSPACE,
  runnerId: RUNNER_ID,
  title,
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  engine: 'claude',
  createdAt: '2026-11-14T09:00:00Z',
  lastTurnAt: '2026-11-14T09:05:00Z',
});
const ROWS = [row(REPORTED, 'Rotate the staging key'), row(SILENT, 'An older runner')];
const REPORT = {
  v: 1,
  at: '2026-11-14T09:04:00Z',
  engine: 'claude',
  engineVersion: '2.1.325',
  versions: { contract: '1.8.0', catalog: '1.7.0', primer: '1.2.0', guide: '1.1.0', playbooks: '1.0.0' },
  mcp: { status: 'connected', tools: 80 },
  families: [{ id: 'tasks', served: 21, total: 21 }, { id: 'orchestration', served: 0, total: 22, reason: 'orchestration' }],
  switches: { orchestration: false, watches: true, wiki: true },
  permissionMode: 'default',
  instructions: { carrier: 'append_system_prompt' },
  skill: { name: 'orbit:playbooks', offered: true, loaded: true },
};
const DETAIL: Record<string, Record<string, unknown>> = {
  [REPORTED]: { ...ROWS[0], agentTools: REPORT },
  [SILENT]: { ...ROWS[1], agentTools: null },
};

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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(sessionId: string): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  root = createRoot(container);
  document.body.appendChild(container);
  const nextClient = client;
  const nextRoot = root;
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${sessionId}`]}>
          <WorkspaceView runner={RUNNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await vi.waitFor(() => expect(mounted().querySelectorAll('.session-row')).toHaveLength(2), { timeout: 20_000, interval: 20 });
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function openHeaderMenu(): Promise<HTMLElement> {
  await click(mounted().querySelector('.workspace-header button[title="More actions"]'), 'the header ⋯ button');
  await act(async () => {
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]:not([data-closed])')).not.toBeNull(), {
      timeout: 10_000,
      interval: 20,
    });
  });
  return document.querySelector<HTMLElement>('[role="menu"]:not([data-closed])')!;
}

const rows = (menu: HTMLElement): string[] =>
  [...menu.querySelectorAll(':scope > [role="menuitem"]')].map((el) => (el.textContent ?? '').trim());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(async (id: string) => DETAIL[id] as never);
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (init?.method && init.method !== 'GET') return reply(undefined);
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: { enableOrchestration: false } });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    for (const id of [REPORTED, SILENT]) {
      if (path.startsWith(`/sessions/${id}`)) {
        if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
        return reply(DETAIL[id]);
      }
    }
    if (path.startsWith('/sessions')) return reply(ROWS);
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

describe('the session menu’s door to Agent tools', { timeout: 60_000 }, () => {
  it('sits right after Find in session, says the connection, and opens the read-only drawer', async () => {
    await mount(REPORTED);
    const menu = await openHeaderMenu();
    const items = rows(menu);
    expect(items[0]).toMatch(/^Find in session/);
    expect(items[1]).toBe('Agent toolsConnected');
    const door = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')][1];
    const word = door.querySelector('.agent-tools-menu-status');
    expect(word?.textContent).toBe('Connected');
    expect(word?.className).toContain('is-ok');

    await click(door, 'the Agent tools row');
    const drawer = await vi.waitFor(() => {
      const found = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector('.agent-tools'));
      expect(found).toBeTruthy();
      return found!;
    });
    expect(drawer.querySelector('.agent-tools-status-line')?.textContent).toBe(
      "Claude Code 2.1.325 started Orbit's MCP server and lists 80 Orbit tools.",
    );
    // The account's switch is off here, and the report says the engine was spawned without it.
    expect(drawer.querySelector('.agent-tools-why')?.textContent).toContain('Session orchestration is off for this account');
    expect(drawer.querySelectorAll('input, textarea, [role="switch"]')).toHaveLength(0);
  });

  it('says Not reported for a session whose runner sent no report', async () => {
    await mount(SILENT);
    const menu = await openHeaderMenu();
    expect(rows(menu)[1]).toBe('Agent toolsNot reported');
    expect(menu.querySelector('.agent-tools-menu-status')?.className).toContain('is-quiet');
  });
});
