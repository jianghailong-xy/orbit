// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriveChatList, DriveChatRow } from '@orbit/shared';

// The conversation is the session page's own, whose tests own it: here a stand-in that names the session shown.
const streamState = vi.hoisted(() => ({ events: [] as Array<{ seq: number; turnId: string; text: string }> }));
vi.mock('../lib/useSessionStream', () => ({
  useSessionStream: () => ({
    events: [],
    eventsSessionId: null,
    transcriptEvents: streamState.events,
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
  // The events as one line each, with the inserts drawn after the event they are anchored to (as Transcript does).
  SessionConversation: ({ sessionId, inserts }: { sessionId: string; inserts: Array<{ anchor: number | 'head'; key: string; element: React.ReactNode }> }) => (
    <div className="conversation" data-session={sessionId}>
      {streamState.events.map((event) => (
        <div key={event.seq}>
          <p className="msg">{event.text}</p>
          {inserts.filter((insert) => insert.anchor === event.seq).map((insert) => <div key={insert.key}>{insert.element}</div>)}
        </div>
      ))}
    </div>
  ),
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
let questions: unknown[] = [];
const entryView = (f: { id: string; parentId: string | null; name: string }) => ({
  id: f.id, parentId: f.parentId, kind: 'FOLDER', name: f.name, sizeBytes: 0, mtime: AT, currentVersionId: null, seq: 1,
  createdAt: AT, updatedAt: AT, lastWriter: { kind: 'OWNER', sessionId: null, runnerId: null, at: AT }, trashedAt: null, trashGroupId: null,
});
const fileView = (id: string, name: string) => ({ ...entryView({ id, parentId: 'root', name }), kind: 'FILE', sizeBytes: 1200 });
const files = [fileView('fa', 'a.pdf'), fileView('fb', 'b.pdf'), fileView('fc', 'c.pdf')];
let groups: unknown[] = [];

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
    const here = parentId === 'root' ? files : [];
    return reply(200, { folder: entryView(folder), entries: [...Object.values(folders).filter((f) => f.parentId === parentId).map(entryView), ...here], nextCursor: null });
  }
  const groupsRead = /^\/api\/drive\/chats\/[^/]+\/groups$/.exec(path);
  if (groupsRead) return reply(200, { groups });
  if (/^\/api\/drive\/chats\/[^/]+\/questions$/.test(path)) return reply(200, { questions });
  const entry = /^\/api\/drive\/entries\/([^/]+)$/.exec(path);
  const loose = entry && files.find((f) => f.id === entry[1]);
  if (loose) return reply(200, { ...loose, path: `/${loose.name}` });
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
  groups = [];
  questions = [];
  streamState.events = [];
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

const place = (name: string | null, parentPath: string | null = '/Receipts') => ({ parentId: 'p', parentPath, name });
const item = (id: string, kind: string, entryId: string, before: string | null, after: string | null, state = 'DONE') => ({
  id, kind, entryId, entryKind: 'FILE', before: place(before), after: place(after), state, reason: null,
});
const group = (over: Record<string, unknown> = {}) => ({
  id: 'g1', sessionId: 'S1', turnId: 't1', status: 'DONE', held: false, createdAt: AT, appliedAt: null, undoneAt: null,
  counts: {}, total: 6, skipped: 0, heldItems: [],
  items: [
    item('i1', 'NEW_FOLDER', 'scans', null, 'Scans'),
    item('i2', 'MOVE', 'fa', 'a.pdf', 'a.pdf'),
    item('i3', 'RENAME', 'fb', 'b.pdf', 'b-may.pdf'),
    item('i4', 'TRASH', 'x', 'old.txt', null),
    item('i5', 'MOVE', 'x2', 'z.pdf', 'z.pdf'),
    item('i6', 'MOVE', 'x3', 'y.pdf', 'y.pdf'),
  ],
  ...over,
});
const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.drive-card')];
const buttons = (scope: ParentNode = document): string[] => [...scope.querySelectorAll('.drive-card-actions button')].map((b) => b.textContent ?? '');
const text = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const clickWith = async (node: Element | null, init: MouseEventInit): Promise<void> => {
  await act(async () => node!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })));
  await settle();
};
const rowOf = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`tr[data-entry="${name}"]`);

describe('the selection chip (board ③ note 1)', () => {
  it('⌘/Ctrl and Shift click pick rows into one "N files" chip that opens to the names, and is sent as entryIds', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    await open('/drive');
    await clickWith(rowOf('a.pdf'), { ctrlKey: true });
    await clickWith(rowOf('c.pdf'), { ctrlKey: true });
    expect(chips()).toContain('2 files');
    await press(document.querySelector('.wk-chat-files-toggle'));
    expect(text(document.querySelector('.wk-chat-files-names'))).toBe('a.pdfc.pdf');
    await type('Put these in Receipts');
    await press(byLabel('Send'));
    const sent = writes.find((w) => w.path === '/api/sessions/S1/turns/current-work-routing')!;
    expect(sent.body).toMatchObject({ driveContext: { entryIds: ['fa', 'fc'] } });

    await clickWith(rowOf('a.pdf'), {});
    await clickWith(rowOf('c.pdf'), { shiftKey: true });
    expect(text(document.querySelector('.wk-chat-files-toggle'))).toBe('3 files');
    await press(byLabel('Remove 3 files'));
    expect(chips().some((c) => c.includes('files'))).toBe(false);
  });
});

describe('the Drive changes card (board ③ note 3)', () => {
  it('shows Done · N changes, the first items by kind, "and N more", Show all, and Undo ends in Undone', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    groups = [group()];
    await open('/drive');
    const card = cards()[0]!;
    expect(text(card.querySelector('.drive-card-title'))).toBe('Drive changes');
    expect(text(card.querySelector('.drive-card-state'))).toBe('Done · 6 changes');
    expect([...card.querySelectorAll('.drive-card-items b')].map(text)).toEqual(['New folder', 'Moved', 'Renamed', 'To Trash']);
    expect(text(card.querySelector('.drive-card-more'))).toBe('and 2 more');
    expect(buttons(card)).toEqual(['Show all', 'Undo']);
    await press([...card.querySelectorAll('button')].find((b) => b.textContent === 'Show all'));
    expect(card.querySelectorAll('.drive-card-items li')).toHaveLength(6);

    groups = [group({ status: 'UNDONE' })];
    await press([...card.querySelectorAll('button')].find((b) => b.textContent === 'Undo'));
    expect(writes.some((w) => w.path === '/api/drive/chats/S1/groups/g1/undo' && w.method === 'POST')).toBe(true);
    expect(text(cards()[0]!.querySelector('.drive-card-state'))).toBe('Undone');
    expect(buttons(cards()[0]!)).not.toContain('Undo');
  });

  it('a PENDING group is amber "Needs you" with Apply, which posts apply', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    groups = [group({
      status: 'PENDING', held: true, items: [],
      heldItems: [{ id: 'h1', kind: 'MOVE', entryId: 'fa', name: 'a.pdf', fromPath: '/a.pdf', toPath: '/Receipts/a.pdf', state: 'PENDING', reason: null }],
    })];
    await open('/drive');
    const card = cards()[0]!;
    expect(card.classList.contains('needs-you')).toBe(true);
    expect(text(card.querySelector('.drive-card-state'))).toBe('Needs you');
    expect(buttons(card)).toEqual(['Apply']);
    await press(card.querySelector('.drive-card-actions button'));
    expect(writes.some((w) => w.path === '/api/drive/chats/S1/groups/g1/apply')).toBe(true);
  });
});

describe('the Replace a file? card (board ④ note 3)', () => {
  const file = (path: string, writer: Record<string, unknown>) => ({ entryId: 'e', path, sizeBytes: 2_400_000, modifiedAt: AT, lastWriter: writer });
  const question = (over: Record<string, unknown> = {}) => ({
    id: 'q1', sessionId: 'S1', turnId: 't', status: 'OPEN', choice: null, destination: { parentId: 'p', name: 'lease.pdf' }, outcome: null,
    reason: null, createdAt: AT, answeredAt: null,
    moving: file('/Inbox/lease.pdf', { kind: 'AGENT', sessionId: 'S1', sessionTitle: 'Sort leases' }),
    existing: file('/Leases/lease.pdf', { kind: 'OWNER', sessionId: null, sessionTitle: null }), ...over,
  });

  it('names both files, recommends keeping both, and the buttons answer', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    questions = [question()];
    await open('/drive');
    const card = cards()[0]!;
    expect(text(card.querySelector('.drive-card-title'))).toBe('Replace a file?');
    expect(text(card)).toContain('/Leases/lease.pdf');
    expect(text(card)).toContain('/Inbox/lease.pdf');
    expect(text(card)).toContain('2.4 MB · You');
    expect(text(card)).toContain('Agent in Sort leases');
    expect(text(card), 'no advice the agent did not give').not.toMatch(/recommend/i);
    expect(buttons(card)).toEqual(['Keep both', 'Replace']);
    expect(card.querySelector('.drive-card-actions button')?.className).toContain('orbit-button-primary');
    await press([...card.querySelectorAll('button')].find((b) => b.textContent === 'Replace'));
    expect(writes.find((w) => w.path === '/api/drive/chats/S1/questions/q1')?.body).toEqual({ choice: 'REPLACE' });
  });
});

describe('cards sit with their turn (board ③ ④)', () => {
  it('a turn\'s card follows that turn\'s last message, and a later turn\'s messages come after an earlier turn\'s card', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    streamState.events = [
      { seq: 1, turnId: 't1', text: 'Sort my receipts' },
      { seq: 2, turnId: 't1', text: 'Done, 24 changes' },
      { seq: 3, turnId: 't2', text: 'Move the lease' },
      { seq: 4, turnId: 't2', text: 'It already exists' },
      { seq: 5, turnId: 't3', text: 'Thanks' },
    ];
    groups = [group({ id: 'g1', turnId: 't1', createdAt: '2026-11-26T09:01:00.000Z' })];
    questions = [{
      id: 'q1', sessionId: 'S1', turnId: 't2', status: 'OPEN', choice: null, destination: { parentId: 'p', name: 'lease.pdf' }, outcome: null,
      reason: null, createdAt: '2026-11-26T09:02:00.000Z', answeredAt: null,
      moving: { entryId: 'm', path: '/Inbox/lease.pdf', sizeBytes: 1, modifiedAt: AT, lastWriter: { kind: 'OWNER' } },
      existing: { entryId: 'x', path: '/Leases/lease.pdf', sizeBytes: 1, modifiedAt: AT, lastWriter: { kind: 'OWNER' } },
    }];
    await open('/drive');
    const flow = [...document.querySelectorAll('.conversation .msg, .conversation .drive-card')].map((node) =>
      node.classList.contains('drive-card') ? `[${text(node.querySelector('.drive-card-title'))}]` : text(node),
    );
    expect(flow).toEqual([
      'Sort my receipts',
      'Done, 24 changes',
      '[Drive changes]',
      'Move the lease',
      'It already exists',
      '[Replace a file?]',
      'Thanks',
    ]);
  });

  it('a card whose turn is not among the events read goes under the conversation', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    streamState.events = [{ seq: 1, turnId: 't9', text: 'Hello' }];
    groups = [group({ turnId: 'older' })];
    await open('/drive');
    expect(document.querySelector('.conversation .drive-card')).toBeNull();
    expect(cards()).toHaveLength(1);
  });
});

describe('list marks (board ③ note 4)', () => {
  it('rows a group created, moved in or renamed are green with New / Moved / Renamed, and clear once opened', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    groups = [group()];
    await open('/drive');
    const mark = (name: string) => text(rowOf(name)?.querySelector('.files-mark'));
    expect(mark('a.pdf')).toBe('Moved');
    expect(mark('b.pdf')).toBe('Renamed');
    expect(mark('c.pdf')).toBe('');
    expect(rowOf('a.pdf')!.classList.contains('marked')).toBe(true);
    expect(text(document.querySelector('.files-tree-row.marked .files-mark')), 'Receipts: in the tree too').toBe('New');

    await press(rowOf('a.pdf'));
    expect(rowOf('a.pdf')!.classList.contains('marked')).toBe(false);
    expect(mark('b.pdf')).toBe('Renamed');
    expect(JSON.parse(storage.local.get('orbit.driveChat.seen.u1')!)).toEqual(['i2']);

    await open('/drive');
    expect(mark('a.pdf'), 'stays cleared on a reload').toBe('');
  });

  it('an undone group leaves no marks', async () => {
    chats.chats = [row({ sessionId: 'S1' })];
    groups = [group({ status: 'UNDONE' })];
    await open('/drive');
    expect(document.querySelectorAll('.files-mark')).toHaveLength(0);
  });
});

describe('file links and the details rule (board ④ note 2)', () => {
  it('a link to a file selects it on the left and opens its details', async () => {
    await open('/drive?file=fb');
    expect(rowOf('b.pdf')!.classList.contains('selected')).toBe(true);
    expect(document.querySelector('.files-pane')?.getAttribute('aria-label')).toBe('b.pdf details');
  });

  it('with the chat open under 1760, details overlay the list with ✕ and Esc; at ≥ 1760 and with the chat closed they are a column', async () => {
    windowWidth(1440);
    await open('/drive?file=fb');
    const pane = () => document.querySelector('.files-pane');
    expect(pane()?.classList.contains('is-over')).toBe(true);
    expect(document.querySelector('.files-page')?.classList.contains('details-over')).toBe(true);
    // The overlay stands over the list's right only: inside the body, under the head, whose actions stay.
    expect(pane()?.parentElement?.classList.contains('files-body')).toBe(true);
    expect(pane()?.closest('.files-head')).toBeNull();
    const head = document.querySelector('.files-head')!;
    expect(head.contains(pane())).toBe(false);
    expect([...head.querySelectorAll('button')].map((b) => text(b))).toEqual(expect.arrayContaining(['Upload']));
    expect([...head.querySelectorAll('button')].map((b) => text(b))).not.toEqual(expect.arrayContaining(['Trash']));
    expect(head.querySelector('button[aria-label="Settings"]')).toBeTruthy();
    expect(document.querySelector('.files-tree'), 'the tree is untouched').toBeTruthy();
    await press(byLabel('Close details'));
    expect(pane()).toBeNull();
    expect(where()).toBe('/drive');

    await open('/drive?file=fb');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    expect(pane()).toBeNull();

    windowWidth(1760);
    await open('/drive?file=fb');
    expect(pane()?.classList.contains('is-over')).toBe(false);
    expect(byLabel('Close details')).toBeNull();

    windowWidth(1440);
    await open('/drive?file=fb');
    await press(byLabel('Hide chat'));
    expect(pane()?.classList.contains('is-over')).toBe(false);
  });
});

describe('the overlay\'s place in the stylesheet', () => {
  it('is positioned against the files body (below the head), not the page', () => {
    const css = readFileSync('src/pages/DrivePage.css', 'utf8');
    expect(css).toMatch(/\.files-page\.details-over \.files-body\s*\{\s*position:\s*relative;/);
    expect(css).not.toMatch(/\.files-page\.details-over\s*\{\s*position:\s*relative;/);
  });
});

describe('the round button count (board ⑤)', () => {
  it('adds held groups and open questions to the chats\' approvals', async () => {
    chats.chats = [row({ sessionId: 'S1', needsYou: 1 })];
    chats.fab = { needsYou: 1, working: false };
    groups = [group({ status: 'PENDING', heldItems: [], items: [] })];
    questions = [{ id: 'q1', sessionId: 'S1', status: 'OPEN', createdAt: AT, moving: { entryId: 'm', path: '/m', sizeBytes: 1, modifiedAt: AT, lastWriter: { kind: 'OWNER' } }, existing: { entryId: 'x', path: '/x', sizeBytes: 1, modifiedAt: AT, lastWriter: { kind: 'OWNER' } } }];
    await open('/drive');
    await press(byLabel('Hide chat'));
    expect(text(fab())).toBe('3');
    expect(fab()?.getAttribute('aria-label')).toContain('need you');
  });
});
