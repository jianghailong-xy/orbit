// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveChatList, DriveChatRow } from '@orbit/shared';

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

const { DrivePage } = await import('./DrivePage');

/**
 * The Drive chat (board docs/mocks/drive-chat/01-board.html ② ⑤, owner Q1 A and Q3 A) on the real Drive page over a fake
 * API: the Wiki's chat host, open by default as the right-hand panel at ≥ 1200 on the chat that needs the owner, else
 * the most recent open one, else New chat; ✕ remembered per account on this device until the round button is pressed;
 * the button's four looks; a new chat's Runs in with the server's default workspace, gone once the first message went;
 * the folder open as a removable chip `Folder · <name>`; and the history of Drive chats.
 */

const AT = '2026-11-26T09:00:00.000Z';
const CLOUD = { id: 'w-cloud', name: 'Orbit Cloud', runner: 'Orbit Cloud', online: true };

const folders: Record<string, { id: string; parentId: string | null; name: string }> = {
  root: { id: 'root', parentId: null, name: '' },
  scans: { id: 'scans', parentId: 'root', name: 'Scans' },
};
const entryView = (f: { id: string; parentId: string | null; name: string }) => ({
  id: f.id, parentId: f.parentId, kind: 'FOLDER', name: f.name, sizeBytes: 0, mtime: AT, currentVersionId: null, seq: 1,
  createdAt: AT, updatedAt: AT, lastWriter: { kind: 'OWNER', sessionId: null, runnerId: null, at: AT }, trashedAt: null, trashGroupId: null,
});

const row = (over: Partial<DriveChatRow> & { sessionId: string }): DriveChatRow => ({
  title: over.sessionId, status: 'AWAITING_INPUT', open: true, completed: false, working: false, needsYou: 0,
  workspaceId: 'w-cloud', createdAt: AT, updatedAt: AT, lastActiveAt: AT, ...over,
});

let chats: DriveChatList;
let me: { id: string };
let writes: Array<{ method: string; path: string; body: Record<string, unknown> }>;
let chatReads: string[];
let client: QueryClient;

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const [path, query = ''] = url.split('?') as [string, string?];
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    writes.push({ method, path, body });
    if (path === '/api/drive/chats') {
      const made = row({ sessionId: 'S1', title: '' });
      chats = { ...chats, chats: [made, ...chats.chats] };
      return reply(201, { sessionId: 'S1', chat: made, workspace: CLOUD });
    }
    if (path.endsWith('/turns/current-work-routing')) {
      return reply(201, { turnId: `T${writes.length}`, seq: writes.length, kind: 'message', placement: 'accepted' });
    }
    return reply(200, { ok: true });
  }
  if (path === '/api/drive/entries') {
    const parentId = new URLSearchParams(query).get('parentId') ?? 'root';
    const folder = folders[parentId]!;
    return reply(200, { folder: entryView(folder), entries: Object.values(folders).filter((f) => f.parentId === parentId).map(entryView), nextCursor: null });
  }
  const entry = /^\/api\/drive\/entries\/([^/]+)$/.exec(path);
  if (entry) return reply(200, { ...entryView(folders[entry[1]!]!), path: entry[1] === 'root' ? '/' : `/${folders[entry[1]!]!.name}` });
  if (path === '/api/drive/chats') {
    chatReads.push(query);
    const params = new URLSearchParams(query);
    const q = (params.get('q') ?? '').toLowerCase();
    return reply(200, { ...chats, chats: chats.chats.filter((c) => !q || c.title.toLowerCase().includes(q)) });
  }
  if (path === '/api/share-links') return reply(200, { links: [] });
  if (path === '/api/drive/syncs') return reply(200, { syncs: [] });
  if (path === '/api/users/me') return reply(200, { ...me, preferences: { defaultPermissionMode: 'default' } });
  if (path === '/api/workspaces') {
    return reply(200, [
      { id: 'w-cloud', name: 'Orbit Cloud', runnerId: 'r-cloud', provider: null, model: null },
      { id: 'w-hpc', name: 'orbit-develop', runnerId: 'r-hpc', provider: null, model: null },
    ]);
  }
  if (path === '/api/runners') {
    return reply(200, [
      { id: 'r-cloud', name: 'cloud-1', displayName: 'Orbit Cloud', online: true, modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }] } },
      { id: 'r-hpc', name: 'hpc-01', displayName: 'HPC', online: true },
    ]);
  }
  if (path === '/api/providers') return reply(200, []);
  const session = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (session) {
    return reply(200, {
      id: session[1], title: `Chat ${session[1]}`, runState: 'AWAITING_INPUT', status: 'AWAITING_INPUT', workspace: { id: 'w-cloud', name: 'Orbit Cloud' },
      assignedRunnerId: 'r-cloud', engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', permissionMode: 'default',
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
});

function windowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  chats = { workspace: CLOUD, workspaceFrom: 'ORBIT_CLOUD', fab: { needsYou: 0, working: false }, chats: [], more: false };
  me = { id: 'u1' };
  writes = [];
  chatReads = [];
  storage = { local: new Map(), session: new Map() };
  windowWidth(1440);
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
            <Route path="/drive" element={<DrivePage />} />
            <Route path="/drive/trash" element={<DrivePage view="trash" />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The chats read again, as a session event or the working poll reads it. */
async function reread(): Promise<void> {
  await act(async () => client.invalidateQueries({ queryKey: ['drive', 'chats'] }));
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const fab = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.wk-chat-fab');
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-panel');
const frame = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-frame');
const title = (): string | null => document.querySelector('.wk-chat-title .t')?.textContent ?? null;
const shownSession = (): string | null => document.querySelector('.conversation')?.getAttribute('data-session') ?? null;
const chips = (): string[] => [...document.querySelectorAll('.wk-chat-chip')].map((chip) => chip.textContent?.replace(/\s+/g, ' ').trim() ?? '');
const byLabel = (label: string): HTMLElement | null => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('.wk-chat-composer .composer-field textarea')!;
const press = async (node: Element | null | undefined): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};

async function type(value: string): Promise<void> {
  const area = field();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('open by default (board ②, owner Q1 A)', () => {
  it('docks as the right-hand panel at ≥ 1200 on a new chat when there is none', async () => {
    await open('/drive?folder=scans');
    expect(panel()?.classList.contains('is-wide')).toBe(true);
    expect(frame()?.className).toBe('wk-chat-frame is-columned is-drive');
    expect(title()).toBe('New chat');
    expect(fab(), 'the button is hidden while the panel shows').toBeNull();
    expect(where(), 'derived, never written to the address').toBe('/drive?folder=scans');

    windowWidth(1200);
    await act(async () => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(panel()?.classList.contains('is-docked')).toBe(true);
  });

  it('continues the chat that needs the owner, else the most recent open one; never a completed one', async () => {
    chats.chats = [row({ sessionId: 'S-done', completed: true }), row({ sessionId: 'S-recent' }), row({ sessionId: 'S-asks', needsYou: 1 })];
    chats.fab = { needsYou: 1, working: false };
    await open('/drive');
    expect(shownSession()).toBe('S-asks');

    chats.chats = [row({ sessionId: 'S-done', completed: true }), row({ sessionId: 'S-recent' }), row({ sessionId: 'S-older' })];
    chats.fab = { needsYou: 0, working: false };
    await open('/drive');
    expect(shownSession()).toBe('S-recent');
  });

  it('is not opened by default at 640–1199: the button slides it over the list with no scrim; under 640 it is a sheet', async () => {
    windowWidth(1000);
    await open('/drive');
    expect(panel()).toBeNull();
    await press(fab());
    expect(panel()?.classList.contains('is-over')).toBe(true);
    expect(frame()?.classList.contains('is-columned')).toBe(false);
    expect(document.querySelector('.wk-scrim')).toBeNull();

    windowWidth(500);
    storage.session.clear();
    await open('/drive');
    expect(panel()).toBeNull();
    await press(fab());
    expect(panel()?.classList.contains('is-sheet')).toBe(true);
  });

  it('is not on Trash', async () => {
    await open('/drive/trash');
    expect(panel()).toBeNull();
    expect(fab()).toBeNull();
  });
});

describe('✕ (board ② note 1)', () => {
  it('is remembered per account on this device until the round button is pressed', async () => {
    await open('/drive');
    await press(byLabel('Hide chat'));
    expect(panel()).toBeNull();
    expect(fab()).toBeTruthy();
    expect(JSON.parse(storage.local.get('orbit.driveChat.closed')!)).toEqual({ u1: true });

    // A reload, and a new tab: still hidden.
    storage.session.clear();
    await open('/drive');
    expect(panel()).toBeNull();
    expect(fab()).toBeTruthy();

    // Another account on this device opens by default as ever.
    me = { id: 'u2' };
    await open('/drive');
    expect(panel()).toBeTruthy();

    // Back to the first account: the button undoes ✕, and pages open with the panel again.
    me = { id: 'u1' };
    storage.session.clear();
    await open('/drive');
    expect(panel()).toBeNull();
    await press(fab());
    expect(panel()).toBeTruthy();
    expect(JSON.parse(storage.local.get('orbit.driveChat.closed')!)).toEqual({});
    storage.session.clear();
    await open('/drive');
    expect(panel()).toBeTruthy();
  });

  it('leaves the Wiki’s own ✕ alone', async () => {
    storage.local.set('orbit.wikiChat.closed', JSON.stringify({ orbit: true }));
    await open('/drive');
    expect(panel()).toBeTruthy();
    await press(byLabel('Hide chat'));
    expect(JSON.parse(storage.local.get('orbit.wikiChat.closed')!)).toEqual({ orbit: true });
  });
});

describe('the round button (board ⑤): the Wiki’s four looks', () => {
  beforeEach(() => storage.local.set('orbit.driveChat.closed', JSON.stringify({ u1: true })));

  const look = () => ({ state: fab()?.getAttribute('data-state'), label: fab()?.getAttribute('aria-label'), badge: fab()?.querySelector('.wk-chat-fab-badge')?.textContent ?? null });

  it('reads Chat at rest, Working… while a chat works, N needs you, and Drive updated once work finished unseen', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    await open('/drive');
    expect(look()).toEqual({ state: 'idle', label: 'Chat', badge: null });

    chats.chats = [row({ sessionId: 'S1', working: true })];
    chats.fab = { needsYou: 0, working: true };
    await reread();
    expect(look()).toEqual({ state: 'working', label: 'Working…', badge: null });
    expect(fab()?.querySelector('.wk-chat-fab-ring')).toBeTruthy();

    chats.chats = [row({ sessionId: 'S1' })];
    chats.fab = { needsYou: 0, working: false };
    await reread();
    expect(look().state).toBe('updated');
    expect(look().label).toBe('Drive updated');
    expect(fab()?.querySelector('.wk-chat-fab-badge.ok')).toBeTruthy();

    chats.chats = [row({ sessionId: 'S1', needsYou: 2 })];
    chats.fab = { needsYou: 2, working: false };
    await reread();
    expect(look()).toEqual({ state: 'needs_you', label: '2 need you', badge: '2' });

    // Pressing it opens the chat that needs the owner, and has seen the update.
    await press(fab());
    expect(shownSession()).toBe('S1');
    await press(byLabel('Hide chat'));
    chats.chats = [row({ sessionId: 'S1' })];
    chats.fab = { needsYou: 0, working: false };
    await reread();
    expect(look().state).toBe('idle');
  });
});

describe('a new chat (board ②)', () => {
  it('shows Runs in with the server’s default workspace, the empty state and three examples that fill the box without sending', async () => {
    await open('/drive?folder=scans');
    const run = document.querySelector('.wk-chat-run')!;
    expect(run.querySelector('.k')?.textContent).toBe('Runs in');
    expect(run.querySelector<HTMLSelectElement>('select')?.value).toBe('w-cloud');
    expect([...run.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Orbit Cloud · Orbit Cloud', 'orbit-develop · HPC']);
    expect(document.querySelector('.wk-chat-empty')?.textContent).toContain('Ask about your files, or say how to sort them.');
    expect(document.querySelector('.wk-chat-empty')?.textContent).toContain('Every change it makes shows here, and can be undone.');
    expect(field().getAttribute('placeholder')).toBe('Ask about your files, or say how to sort them');
    const examples = [...document.querySelectorAll<HTMLButtonElement>('.wk-chat-example')];
    expect(examples.map((b) => b.textContent)).toEqual([
      '“Sort these receipts into Receipts 2026 by month”',
      '“What’s taking up the most space?”',
      '“Find the lease and tell me when the notice period ends”',
    ]);
    await press(examples[1]);
    expect(field().value).toBe('What’s taking up the most space?');
    expect(writes, 'an example sends nothing').toEqual([]);
    expect(document.querySelectorAll('.wk-chat-example'), 'gone once the box holds words').toHaveLength(0);
  });

  it('goes to POST /api/drive/chats with the folder and the workspace, and Runs in is gone after the first message', async () => {
    await open('/drive?folder=scans');
    await type('Sort these scans by month');
    await press(byLabel('Send'));
    const created = writes.find((w) => w.path === '/api/drive/chats')!;
    expect(created.method).toBe('POST');
    expect(created.body).toMatchObject({ text: 'Sort these scans by month', workspaceId: 'w-cloud', folderId: 'scans' });
    expect(created.body).not.toHaveProperty('noFolder');
    expect(typeof created.body.clientTurnId).toBe('string');
    expect(shownSession()).toBe('S1');
    expect(document.querySelector('.wk-chat-run')).toBeNull();
    expect(where()).toBe('/drive?folder=scans&chat=S1');
  });

  it('runs where the owner picks instead', async () => {
    await open('/drive');
    const picker = document.querySelector<HTMLSelectElement>('.wk-chat-run select')!;
    await act(async () => {
      picker.value = 'w-hpc';
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    await type('What is here?');
    await press(byLabel('Send'));
    expect(writes.find((w) => w.path === '/api/drive/chats')?.body).toMatchObject({ workspaceId: 'w-hpc' });
  });
});

describe('the folder chip (board ② note 3)', () => {
  it('attaches the folder open as Folder · <name>, follows the folder, and once crossed out is not sent', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    await open('/drive?folder=scans');
    expect(shownSession()).toBe('S1');
    expect(chips()).toEqual(['Folder · Scans']);
    await type('What is in here?');
    await press(byLabel('Send'));
    const first = writes.find((w) => w.path === '/api/sessions/S1/turns/current-work-routing')!;
    expect(first.body).toMatchObject({ content: 'What is in here?', driveContext: { folderId: 'scans', entryIds: [] } });

    await press(byLabel('Remove Folder · Scans'));
    expect(chips()).toEqual([]);
    await type('And in general?');
    await press(byLabel('Send'));
    const second = writes.filter((w) => w.path === '/api/sessions/S1/turns/current-work-routing')[1]!;
    expect(second.body.content).toBe('And in general?');
    expect(second.body).not.toHaveProperty('driveContext');

    // After a message the folder is attached again; at the top level it is the drive itself, sent as null.
    await press([...document.querySelectorAll('.files-title a')].find((a) => a.textContent === 'Drive'));
    expect(chips()).toEqual(['Folder · Drive']);
    await type('Anything big?');
    await press(byLabel('Send'));
    const third = writes.filter((w) => w.path === '/api/sessions/S1/turns/current-work-routing')[2]!;
    expect(third.body).toMatchObject({ driveContext: { folderId: null, entryIds: [] } });
    expect(shownSession(), 'turning folders keeps the chat').toBe('S1');
  });
});

describe('the folder chip on a new chat (board ② note 3: what is not shown is not sent)', () => {
  it('crossed out, the first message names no folder: noFolder, and no folderId the server would read as the top level', async () => {
    await open('/drive?folder=scans');
    expect(chips()).toEqual(['Folder · Scans']);
    await press(byLabel('Remove Folder · Scans'));
    expect(chips()).toEqual([]);
    await type('What is taking up the most space?');
    await press(byLabel('Send'));
    const created = writes.find((w) => w.path === '/api/drive/chats')!;
    expect(created.body).toMatchObject({ text: 'What is taking up the most space?', workspaceId: 'w-cloud', noFolder: true });
    expect(created.body).not.toHaveProperty('folderId');
  });

  it('at the top level, shown, it goes as folderId null', async () => {
    await open('/drive');
    expect(chips()).toEqual(['Folder · Drive']);
    await type('Anything big?');
    await press(byLabel('Send'));
    const created = writes.find((w) => w.path === '/api/drive/chats')!;
    expect(created.body).toMatchObject({ folderId: null });
    expect(created.body).not.toHaveProperty('noFolder');
  });
});

describe('the history (board ④ note 3)', () => {
  it('lists Drive chats only, Open and Completed, searched on the server, with the row ⋯ of the Wiki', async () => {
    chats.chats = [row({ sessionId: 'S1', title: 'Sort receipts' }), row({ sessionId: 'S2', title: 'Find the lease', completed: true })];
    await open('/drive');
    await press(document.querySelector('.wk-chat-title'));
    const history = document.querySelector('.wk-chat-history')!;
    expect(history.getAttribute('aria-label')).toBe('Drive chats');
    expect(title()).toBe('Chats');
    expect([...history.querySelectorAll('.wk-chat-history-group')].map((g) => g.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Open 1', 'Completed 1']);
    expect(chatReads.every((q) => !q.includes('space')), 'the Drive chats read, not a space’s').toBe(true);

    const search = history.querySelector<HTMLInputElement>('.wk-chat-history-search input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(search, 'lease');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(chatReads).toContain('q=lease');

    await press(document.querySelector('.wk-chat-history-row .wk-chat-history-more'));
    expect([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent)).toEqual([
      'Rename…', 'Open as a full session', 'Move to Trash',
    ]);
  });
});
