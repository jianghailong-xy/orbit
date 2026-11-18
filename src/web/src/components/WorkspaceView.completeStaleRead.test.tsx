// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * ⌘D with the stream live: an Open-list read the stream started before the Complete reached the
 * server lands after the row was dropped. Its answer still holds the row, and must not draw it again
 * until the next read takes it away.
 */

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  getToken: () => 'token',
  api: vi.fn(), getSession: vi.fn(), getSessionEventPage: vi.fn(),
  completeSession: vi.fn(), getShareLink: vi.fn(),
}));
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null, saveTranscript: async () => {},
}));

const apiModule = await import('../api');
const { WorkspaceView } = await import('./WorkspaceView');
const { ControlPlaneProvider } = await import('../lib/useControlPlane');
const { forgetOpenListCursors } = await import('../lib/openListDelta');
const { encodeId } = await import('../lib/idCodec');
const uuid = (n: number) => `0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
const RUNNER_ID = uuid(971);
const WORKSPACE_ID = encodeId(uuid(972));
const OPEN_ID = encodeId(uuid(973));
const OTHER_ID = encodeId(uuid(974));
const RUNNER = {
  id: RUNNER_ID, name: 'desktop-runner', online: true, maxConcurrent: 2, activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;
const session = (id: string, title: string) => ({
  id, title, workspaceId: WORKSPACE_ID, workspace: { id: WORKSPACE_ID, name: 'orbit' },
  runnerId: RUNNER_ID, provider: 'claude', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN', createdAt: '2026-10-01T10:00:00Z',
  lastTurnAt: '2026-10-03T09:00:00Z', pinnedAt: null as string | null,
  capabilities: { canComplete: true, canRestore: true }, shared: false,
});

class FakeEventSource {
  static open: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.open.push(this);
  }
  close() {}
}

let rows: ReturnType<typeof session>[];
/** While set, an Open-list read waits on it and answers what the server held when it was asked. */
let hold: Promise<void> | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

async function until(assertion: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try { await vi.waitFor(assertion, { timeout: 10_000, interval: 20 }); }
  finally { env.IS_REACT_ACT_ENVIRONMENT = previous; }
  await act(async () => {});
}
const titles = (): string[] =>
  [...container!.querySelectorAll('.session-row .session-title')].map((el) => el.textContent ?? '');
const openReads = (): number =>
  vi.mocked(apiModule.api).mock.calls.filter(([path]) => String(path).startsWith('/sessions?') &&
    (new URLSearchParams(String(path).split('?')[1]).get('view') ?? 'open') === 'open').length;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rows = [session(OPEN_ID, 'Open conversation'), session(OTHER_ID, 'Other conversation')];
  hold = null;
  FakeEventSource.open = [];
  forgetOpenListCursors();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)', media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  vi.mocked(apiModule.completeSession).mockReset();
  vi.mocked(apiModule.completeSession).mockImplementation(async (id) => {
    rows = rows.map((s) => (s.id === id ? { ...s, lifecycleState: 'COMPLETED' } : s));
    return {};
  });
  vi.mocked(apiModule.getSession).mockReset();
  vi.mocked(apiModule.getSession).mockImplementation(async (id) => rows.find((s) => s.id === id) as never);
  vi.mocked(apiModule.getSessionEventPage).mockReset();
  vi.mocked(apiModule.getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(apiModule.getShareLink).mockReset();
  vi.mocked(apiModule.getShareLink).mockResolvedValue({ link: null, counts: { messages: 2, toolCalls: 0 } });
  vi.mocked(apiModule.api).mockReset();
  vi.mocked(apiModule.api).mockImplementation(async (path: string) => {
    if (path === '/users/me') return { id: 'user-1', name: 'Reader', email: 'reader@example.com', preferences: {} } as never;
    if (path === '/workspaces') return [{ id: WORKSPACE_ID, name: 'orbit', runnerId: RUNNER_ID, lastProvider: 'claude' }] as never;
    if (path.startsWith('/sessions?')) {
      const view = new URLSearchParams(path.split('?')[1]).get('view') ?? 'open';
      const wanted = view === 'trash' ? 'TRASH' : view.toUpperCase();
      const answer = rows.filter((s) => s.lifecycleState === wanted);
      if (view === 'open' && hold) await hold;
      return answer as never;
    }
    if (path.startsWith('/sessions/')) {
      if (path.includes('/created-tasks')) return { total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] } as never;
      if (path.includes('/diff')) return { files: [] } as never;
      return [] as never;
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) return { decidingSessionId: null, count: 0, pending: [], waitingOnYou: [] } as never;
    if (path.startsWith('/tasks/page')) return { items: [], nextCursor: null } as never;
    if (path.startsWith('/tasks')) return { items: [], total: 0, counts: {} } as never;
    return [] as never;
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  if (client) { await client.cancelQueries(); client.clear(); }
  root = null;
  client = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

it('a list read that started before ⌘D does not draw the completed row again', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <ControlPlaneProvider>
          <MemoryRouter initialEntries={[`/sessions/${OPEN_ID}`]}>
            <WorkspaceView runner={RUNNER} />
          </MemoryRouter>
        </ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  await until(() => expect([...titles()].sort()).toEqual(['Open conversation', 'Other conversation']));
  const stream = FakeEventSource.open[FakeEventSource.open.length - 1];
  await act(async () => { stream.onopen?.(); });

  // The server hints the Open list moved (another row's turn, say); its read goes out and is slow.
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const before = openReads();
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify({ type: 'sessions.list_changed', data: {} }) });
  });
  await until(() => expect(openReads()).toBe(before + 1));

  // ⌘D lands while that read is out: the row leaves at once.
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => expect(apiModule.completeSession).toHaveBeenCalledExactlyOnceWith(OPEN_ID));
  await until(() => expect(titles()).toEqual(['Other conversation']));

  // The slow read answers what the server held before the Complete.
  hold = null;
  await act(async () => { release(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(titles()).toEqual(['Other conversation']);

  // The read the Complete asked for follows, and agrees.
  await until(() => expect(openReads()).toBeGreaterThan(before + 1));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(titles()).toEqual(['Other conversation']);
}, 120_000);
