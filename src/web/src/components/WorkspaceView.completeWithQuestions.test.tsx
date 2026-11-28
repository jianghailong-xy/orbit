// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/**
 * ⌘D on a session that still has a question waiting on the owner: the server would bring it straight back to Open,
 * so Complete asks first, and only a confirmed Complete is sent, withdrawing the question. Cancelling sends nothing.
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
let waiting: unknown[];
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
  waiting = [{
    id: 'req1', kind: 'CONFIRM', state: 'PENDING', title: 'Ship the release', why: 'The tag waits for it.',
    blocksTaskIds: [], ifUnanswered: null, options: null, recommendedOption: null, steps: null, secretSpec: null,
    secretGrant: null, verifyHint: null, expiresAt: null, askedBySessionId: OPEN_ID, projectId: null, resolvedAt: null,
    resolvedByUserId: null, resolvedBySessionId: null, resolutionNote: null, answer: null,
    createdAt: '2026-10-03T08:00:00Z',
  }];
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
    if (path.startsWith('/owner-requests?')) return { requests: waiting } as never;
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

async function mount(): Promise<void> {
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
  await until(() => expect(client!.getQueryData(['owner-requests', 'open'])).toBeTruthy());
}

const pressComplete = async (): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true, cancelable: true }));
  });
};
const dialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"], [role="dialog"]');
const button = (label: string): HTMLButtonElement =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;

it('asks before completing a session with a question waiting, and withdraws it once confirmed', async () => {
  await mount();
  await pressComplete();
  await until(() => expect(dialog()?.textContent).toContain('This session has a question waiting on you'));
  expect(apiModule.completeSession).not.toHaveBeenCalled();

  await act(async () => { button('Complete and withdraw').click(); });
  await until(() => expect(apiModule.completeSession)
    .toHaveBeenCalledExactlyOnceWith(OPEN_ID, { withdrawPendingQuestions: true }));
  await until(() => expect(titles()).toEqual(['Other conversation']));
}, 120_000);

it('sends nothing when the owner keeps it open', async () => {
  await mount();
  await pressComplete();
  await until(() => expect(dialog()?.textContent).toContain('This session has a question waiting on you'));
  await act(async () => { button('Keep it open').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(apiModule.completeSession).not.toHaveBeenCalled();
  expect([...titles()].sort()).toEqual(['Open conversation', 'Other conversation']);
}, 120_000);

it('completes at once when nothing waits', async () => {
  waiting = [];
  await mount();
  await pressComplete();
  await until(() => expect(apiModule.completeSession).toHaveBeenCalledExactlyOnceWith(OPEN_ID));
  expect(dialog()).toBeNull();
}, 120_000);
