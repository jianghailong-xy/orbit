// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIST_ROWS, listAnswer } from '../test/scheduleFixtures';
import { chatRow as SERVER_ROW, opening as SERVER_OPENING, openAnswer as SERVER_OPEN_ANSWER, openList } from '../test/scheduledChatFixtures';
import { readSidebarFolded } from '../lib/sidebarFold';

// The conversation is the session page's own, whose tests own it: here a stand-in that names the session shown.
vi.mock('../lib/useSessionStream', () => ({
  useSessionStream: () => ({
    events: [],
    eventsSessionId: null,
    transcriptEvents: [],
    approvals: [],
    setApprovals: () => {},
    idle: true,
    setIdle: () => {},
    setAcceptedUserTurns: () => {},
    queued: [],
    visibleQueuedTurns: [],
    setQueued: () => {},
  }),
}));
vi.mock('../components/SessionConversation', () => ({
  SessionConversation: ({ sessionId }: { sessionId: string }) => <div className="conversation" data-session={sessionId} />,
}));
vi.mock('../lib/schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/schedules')>()),
  viewerTimezone: () => 'Asia/Shanghai',
}));

const { ScheduledPage } = await import('./ScheduledPage');

/**
 * The Scheduled page's chat (docs/scheduled-chat-design.md §2, §3, §5, §6; board scheduled-chat 01 parts 1–2) on the
 * real Scheduled page over a fake API: the tools row's Chat button toggles a docked panel built on the shared chat
 * host; it never opens by itself, its open or closed is kept per account on this device, and `?chat=<session>` names
 * the chat shown. A new chat shows Orbit's opening and Runs in — the page's workspace filter, else the account's
 * default workspace, never the last one used — and its first message goes to `POST /api/schedules/chat`.
 */

const AT = '2025-11-14T04:00:00.000Z';
// In the sidebar's order `ws-web` comes first (position 0), though `ws-apiserver` is older and listed first.
const WORKSPACES = [
  { id: 'ws-apiserver', name: 'apiserver', runnerId: 'r-hpc', position: 1, createdAt: '2025-01-01T00:00:00.000Z', provider: null, model: null },
  { id: 'ws-web', name: 'web', runnerId: 'r-mac', position: 0, createdAt: '2025-02-01T00:00:00.000Z', provider: null, model: null },
  { id: 'ws-baseline', name: 'Orbit baseline', runnerId: null, position: null, createdAt: '2025-03-01T00:00:00.000Z', provider: null, model: null },
];

// Rows, the opening and the open answer are the server's own (test/scheduledChatFixtures, recorded from this branch's
// apiserver); a scenario overrides only what it is about.
type ListRow = Record<string, unknown> & { id: string };
const chatRow = (id: string, over: Partial<ListRow> = {}): ListRow => ({
  ...SERVER_ROW, id, title: `Chat ${id}`, createdAt: AT, listedAt: AT, ...over,
});

let me: { id: string };
let openSessions: ListRow[];
let completedSessions: ListRow[];
let openChat: string | null;
let writes: Array<{ method: string; path: string; body: Record<string, unknown> }>;
let reads: string[];
let client: QueryClient;

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const [path, query = ''] = url.split('?') as [string, string?];
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    writes.push({ method, path, body });
    if (path === '/api/schedules/chat') return reply(200, { ...SERVER_OPEN_ANSWER, sessionId: 'S-new', sessionPublicId: 'S-new' });
    return reply(200, { ok: true });
  }
  reads.push(url);
  if (path === '/api/schedules') return reply(200, listAnswer(LIST_ROWS));
  if (path === '/api/schedules/drafts') return reply(200, { drafts: [] });
  if (path === '/api/schedules/chat') return reply(200, { ...SERVER_OPENING, sessionId: openChat, sessionPublicId: openChat });
  if (path.startsWith('/api/owner-requests')) return reply(200, { requests: [] });
  if (path === '/api/users/me') return reply(200, { ...me, preferences: { defaultPermissionMode: 'default' } });
  if (path === '/api/workspaces') return reply(200, WORKSPACES);
  if (path === '/api/runners') {
    return reply(200, [
      { id: 'r-hpc', name: 'hpc-01', displayName: 'HPC', online: true },
      { id: 'r-mac', name: 'mac-mini', displayName: 'mac-mini', online: true },
    ]);
  }
  if (path === '/api/providers') return reply(200, []);
  if (path === '/api/sessions') {
    const params = new URLSearchParams(query);
    if (params.get('view') === 'completed') return reply(200, completedSessions);
    // The Open list is read as a delta (`since`): a first read is answered whole, as the server does.
    return reply(200, params.has('since') ? openList(openSessions) : openSessions);
  }
  const session = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (session) {
    return reply(200, {
      id: session[1], title: `Chat ${session[1]}`, runState: 'AWAITING_INPUT', status: 'AWAITING_INPUT', workspace: { id: 'ws-web', name: 'web' },
      assignedRunnerId: 'r-mac', engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', permissionMode: 'default',
    });
  }
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;
let storage: { local: Map<string, string>; session: Map<string, string> };

const store = (items: Map<string, string>) => ({
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
  clear: () => items.clear(),
});

function windowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  me = { id: 'u1' };
  openSessions = [chatRow('S-other', { title: 'Fix flaky upload test', status: 'RUNNING', chatOrigin: null })];
  completedSessions = [];
  openChat = null;
  writes = [];
  reads = [];
  storage = { local: new Map(), session: new Map() };
  windowWidth(1460);
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', store(storage.local));
  vi.stubGlobal('sessionStorage', store(storage.session));
  vi.stubGlobal('fetch', vi.fn(serve));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

function Where() {
  const location = useLocation();
  return <output data-where={`${location.pathname}${location.search}`} />;
}

/** Open `path` as a fresh load: a new router and a new cache (the device's storage is kept). */
async function open(path: string): Promise<void> {
  act(() => root.unmount());
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/scheduled" element={<ScheduledPage />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** A reload of the same address in a new tab: the tab's own storage is gone, the device's is kept. */
async function reload(): Promise<void> {
  const address = where()!;
  storage.session.clear();
  await open(address);
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const chatButton = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('.sched-chat-btn')!;
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-panel');
const frame = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-frame');
const title = (): string | null => document.querySelector('.wk-chat-title .t')?.textContent ?? null;
const shownSession = (): string | null => document.querySelector('.conversation')?.getAttribute('data-session') ?? null;
const byLabel = (label: string): HTMLElement | null => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('.wk-chat-composer .composer-field textarea')!;
const runsIn = (): string | null => document.querySelector<HTMLSelectElement>('.wk-chat-run select')?.value ?? null;
const shown = (): unknown => JSON.parse(storage.local.get('orbit.scheduledChat.shown') ?? '{}');
const press = async (node: Element | null | undefined): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};
async function resize(width: number): Promise<void> {
  windowWidth(width);
  await act(async () => window.dispatchEvent(new Event('resize')));
  await settle();
}

describe('the Chat button (board 1 ①, design §2.1)', () => {
  it('sits at the far right of the tools row, after Show past runs', async () => {
    await open('/scheduled');
    const tools = document.querySelector('.sched-tools')!;
    expect(tools.lastElementChild).toBe(chatButton());
    expect(chatButton().previousElementSibling?.classList.contains('sched-past-toggle')).toBe(true);
    expect(chatButton().textContent).toBe('Chat');
  });

  it('toggles the panel, shows as pressed while it is open, and ✕ closes it too', async () => {
    await open('/scheduled');
    expect(panel(), 'not open by default, even where it would dock').toBeNull();
    expect(chatButton().getAttribute('aria-pressed')).toBe('false');

    await press(chatButton());
    expect(panel()).toBeTruthy();
    expect(chatButton().getAttribute('aria-pressed')).toBe('true');
    // Its head: the title (→ history), + new, ↗ the full session, ✕ close (board 1 ②).
    expect(title()).toBe('New chat');
    expect(byLabel('New chat')).toBeTruthy();
    expect(byLabel('Open as a full session')).toBeTruthy();
    expect(byLabel('Hide chat')).toBeTruthy();
    expect(document.querySelector('.wk-chat-fab'), 'no round button: the header button is the entry').toBeNull();

    await press(chatButton());
    expect(panel()).toBeNull();
    expect(chatButton().getAttribute('aria-pressed')).toBe('false');

    await press(chatButton());
    await press(byLabel('Hide chat'));
    expect(panel()).toBeNull();
    expect(chatButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('is there on an empty account too', async () => {
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).startsWith('/api/schedules?') || String(url) === '/api/schedules'
        ? reply(200, listAnswer([]))
        : serve(String(url), init));
    await open('/scheduled');
    await press(chatButton());
    expect(panel()).toBeTruthy();
  });

  it('opens the chat that needs the owner, else the account’s open one, else a new one', async () => {
    openSessions = [...openSessions, chatRow('S-recent'), chatRow('S-asks', { pendingApprovals: 1, lastTurnAt: '2025-11-13T00:00:00.000Z' })];
    await open('/scheduled');
    await press(chatButton());
    expect(shownSession()).toBe('S-asks');

    openSessions = [openSessions[0]!, chatRow('S-recent')];
    storage.local.clear();
    storage.session.clear();
    await open('/scheduled');
    await press(chatButton());
    expect(shownSession()).toBe('S-recent');
  });
});

describe('open or closed, remembered per device (D3 A)', () => {
  it('stays open across a reload once opened, and closed once closed', async () => {
    await open('/scheduled');
    await press(chatButton());
    expect(shown()).toEqual({ u1: true });

    storage.session.clear();
    await open('/scheduled');
    expect(panel(), 'left open: a fresh load shows it').toBeTruthy();
    expect(chatButton().getAttribute('aria-pressed')).toBe('true');

    await press(byLabel('Hide chat'));
    expect(shown()).toEqual({});
    storage.session.clear();
    await open('/scheduled');
    expect(panel()).toBeNull();
  });

  it('is per account on this device', async () => {
    await open('/scheduled');
    await press(chatButton());
    me = { id: 'u2' };
    storage.session.clear();
    await open('/scheduled');
    expect(panel(), 'another account never opened it here').toBeNull();
  });

  it('reads Orbit’s opening only while the panel is open', async () => {
    await open('/scheduled');
    expect(reads.some((url) => url.startsWith('/api/schedules/chat'))).toBe(false);
    await press(chatButton());
    expect(reads).toContain('/api/schedules/chat?timezone=Asia%2FShanghai');
  });
});

describe('?chat=<session> (design §3)', () => {
  it('names the chat shown, and a refresh keeps it', async () => {
    openSessions = [...openSessions, chatRow('S-recent')];
    await open('/scheduled?workspace=ws-web');
    await press(chatButton());
    expect(where()).toBe('/scheduled?workspace=ws-web&chat=S-recent');

    await reload();
    expect(where()).toBe('/scheduled?workspace=ws-web&chat=S-recent');
    expect(shownSession()).toBe('S-recent');
  });

  it('opens on the chat an address names, whatever the device remembers', async () => {
    await open('/scheduled?chat=S-linked');
    expect(panel()).toBeTruthy();
    expect(shownSession()).toBe('S-linked');
  });

  it('writes the chat to the address when a remembered panel comes back on its own', async () => {
    storage.local.set('orbit.scheduledChat.shown', JSON.stringify({ u1: true }));
    await open('/scheduled');
    expect(where()).toBe('/scheduled?chat=new');
  });

  it('closing takes it out of the address', async () => {
    await open('/scheduled?chat=new&id=sch-codex');
    await press(chatButton());
    expect(where()).toBe('/scheduled?id=sch-codex');
  });
});

describe('Runs in (design §5)', () => {
  it('starts on the page’s workspace filter', async () => {
    await open('/scheduled?workspace=ws-apiserver');
    await press(chatButton());
    expect(document.querySelector('.wk-chat-run .k')?.textContent).toBe('Runs in');
    expect(runsIn()).toBe('ws-apiserver');
    expect([...document.querySelectorAll('.wk-chat-run option')].map((o) => o.textContent)).toEqual(['apiserver · HPC', 'web · mac-mini']);
  });

  it('else on the account’s default workspace — first in the sidebar’s order with a machine — never the last one used', async () => {
    storage.local.set('orbit:scheduled-quick-add-workspace', 'ws-apiserver');
    await open('/scheduled');
    await press(chatButton());
    expect(runsIn()).toBe('ws-web');
  });

  it('shows Orbit’s opening, sends the first message through POST /api/schedules/chat, and folds away after it', async () => {
    await open('/scheduled?workspace=ws-apiserver');
    await press(chatButton());
    const empty = document.querySelector('.wk-chat-empty')!.textContent!;
    expect(empty).toContain('You have 4 scheduled tasks: 2 active, 2 paused, none failing. Next: Codex stable check, tomorrow at 06:00 on apiserver.');
    expect(empty).toContain('Ask about them, or tell me what to change. For example:');
    expect([...document.querySelectorAll('.wk-chat-example')].map((b) => b.textContent)).toEqual([
      '“Pause everything on orbit-ws04 until Monday”',
      '“Why did the last run take so long?”',
      "“Every weekday at 09:00, check a changelog and tell me what's new”",
    ]);
    expect(document.querySelector('.wk-chat-closing')?.textContent).toBe(SERVER_OPENING.opening.closing);
    expect(field().getAttribute('placeholder')).toBe('Ask about your schedules, or say what to change…');

    const area = field();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(area, 'What runs tomorrow?');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(byLabel('Send'));
    expect(writes.filter((w) => w.path === '/api/schedules/chat')).toEqual([
      { method: 'POST', path: '/api/schedules/chat', body: { workspaceId: 'ws-apiserver', text: 'What runs tomorrow?' } },
    ]);
    expect(shownSession()).toBe('S-new');
    expect(document.querySelector('.wk-chat-run'), 'folded after the first message').toBeNull();
    expect(where()).toBe('/scheduled?workspace=ws-apiserver&chat=S-new');
  });
});

describe('the width bands (design §6, board 2)', () => {
  it('docks as a third column at ≥ 1440, 400 wide and dragged between 400 and 480', async () => {
    await open('/scheduled?id=sch-codex');
    await press(chatButton());
    expect(panel()?.classList.contains('is-wide')).toBe(true);
    expect(frame()?.className).toBe('wk-chat-frame is-columned is-sched');
    expect(panel()?.style.width).toBe('400px');
    const resizer = document.querySelector('.wk-chat-resizer')!;
    expect([resizer.getAttribute('aria-valuemin'), resizer.getAttribute('aria-valuemax')]).toEqual(['400', '480']);
    expect(document.querySelector('.sched-inspector'), 'the inspector stays between the list and the chat').toBeTruthy();
    expect(readSidebarFolded()).toBe(false);
  });

  it('folds the app sidebar to its icon rail at 1200–1439 and keeps the three columns', async () => {
    windowWidth(1280);
    await open('/scheduled?id=sch-codex');
    await press(chatButton());
    expect(panel()?.classList.contains('is-docked')).toBe(true);
    expect(frame()?.classList.contains('is-columned')).toBe(true);
    expect(readSidebarFolded()).toBe(true);
    await press(chatButton());
    expect(readSidebarFolded(), 'closed, the sidebar comes back').toBe(false);
  });

  it('slides over the page below 1200 and is a sheet below 640', async () => {
    windowWidth(1024);
    await open('/scheduled');
    await press(chatButton());
    expect(panel()?.classList.contains('is-over')).toBe(true);
    expect(frame()?.classList.contains('is-columned')).toBe(false);
    expect(readSidebarFolded()).toBe(false);

    await resize(600);
    expect(panel()?.classList.contains('is-sheet')).toBe(true);
    await resize(1460);
    expect(panel()?.classList.contains('is-wide')).toBe(true);
  });
});

describe('the history (design §3)', () => {
  it('lists this account’s Scheduled chats only, Open and Completed', async () => {
    openSessions = [...openSessions, chatRow('S-open', { title: 'Move the audit' })];
    completedSessions = [chatRow('S-done', { title: 'Pause the watches', lifecycleState: 'COMPLETED', completedAt: AT }),
      chatRow('S-wiki', { title: 'A wiki chat', chatOrigin: 'WIKI_CHAT', lifecycleState: 'COMPLETED', completedAt: AT })];
    await open('/scheduled');
    await press(chatButton());
    await press(document.querySelector('.wk-chat-title'));
    const history = document.querySelector('.wk-chat-history')!;
    expect(history.getAttribute('aria-label')).toBe('Scheduled chats');
    expect([...history.querySelectorAll('.wk-chat-history-group')].map((g) => g.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Open 1', 'Completed 1']);
    await press(history.querySelector('.wk-chat-history-group.is-fold'));
    expect([...history.querySelectorAll('.wk-chat-history-row .t')].map((t) => t.textContent)).toEqual(['Move the audit', 'Pause the watches']);
  });
});
