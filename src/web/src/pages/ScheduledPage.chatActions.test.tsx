// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_TIME_RECORD, LIST_ROWS, listAnswer, scheduleDetail } from '../test/scheduleFixtures';
import { chatRow as SERVER_ROW, opening as SERVER_OPENING, openAnswer as SERVER_OPEN_ANSWER, openList } from '../test/scheduledChatFixtures';
import { readSidebarFolded } from '../lib/sidebarFold';

// The conversation is the session page's own, whose tests own it: here a stand-in that names the session shown.
const streamState: { events: Array<Record<string, unknown>> } = { events: [] };
vi.mock('../lib/useSessionStream', () => ({
  useSessionStream: () => ({
    events: streamState.events,
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
  SessionConversation: ({ sessionId, inserts }: { sessionId: string; inserts?: Array<{ key: string; element: React.ReactNode }> }) => (
    <div className="conversation" data-session={sessionId}>
      {(inserts ?? []).map((insert) => <div key={insert.key} className="insert">{insert.element}</div>)}
    </div>
  ),
}));
vi.mock('../lib/schedules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/schedules')>()),
  viewerTimezone: () => 'Asia/Shanghai',
}));

const { ScheduledPage } = await import('./ScheduledPage');

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
let listRows: typeof LIST_ROWS;
let cards: { run: null; cards: unknown[]; records: unknown[] };
const CODEX = LIST_ROWS.find((row) => row.title === 'Codex stable check')!;

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const [path, query = ''] = url.split('?') as [string, string?];
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    writes.push({ method, path, body });
    if (path === '/api/schedules/chat') return reply(200, { ...SERVER_OPEN_ANSWER, sessionId: 'S-new', sessionPublicId: 'S-new' });
    if (/^\/api\/sessions\/[^/]+\/turns\/current-work-routing$/.test(path)) return reply(200, { turnId: 'T1', seq: 9, kind: 'message', placement: 'NEXT_TURN' });
    if (path === `/api/schedules/${CODEX.id}/run`) return reply(200, { run: { id: 'run-1', scheduleId: CODEX.id, sessionId: 'run-session', state: 'RUNNING' } });
    return reply(200, { ok: true });
  }
  reads.push(url);
  if (path === '/api/schedules') return reply(200, listAnswer(listRows));
  if (/^\/api\/sessions\/[^/]+\/schedule-cards$/.test(path)) return reply(200, cards);
  if (path === `/api/schedules/${CODEX.id}`) return reply(200, scheduleDetail(CODEX.id));
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
      chatOrigin: session[1] === 'S-plain' ? null : 'SCHEDULE_CHAT', assignedRunnerId: 'r-mac', engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', permissionMode: 'default',
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


// beforeEach of the harness above resets its own state; this file's own:
beforeEach(() => {
  cards = { run: null, cards: [], records: [] };
  listRows = LIST_ROWS;
  streamState.events = [];
});

const asRow = (id: string, over: Partial<ListRow> = {}) => chatRow(id, { chatOrigin: 'SCHEDULE_CHAT', status: 'AWAITING_INPUT', phase: 'AWAITING_INPUT', waitingOn: null, pendingApprovals: 0, ...over });
const codexRow = (): HTMLElement => document.querySelector<HTMLElement>(`.sched-row[data-row$=":${CODEX.id}"]`)!;
const typeInto = async (node: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  await act(async () => {
    setValue.call(node, text);
    node.dispatchEvent(new Event(node instanceof HTMLTextAreaElement ? 'input' : 'input', { bubbles: true }));
  });
};
const turnsTo = (session: string) => writes.filter((w) => w.path === `/api/sessions/${session}/turns/current-work-routing`);

describe('the selected row rides along as a chip (design §2.4)', () => {
  beforeEach(() => {
    openSessions = [asRow('S-open')];
    openChat = 'S-open';
  });

  it('shows the selected row as a removable chip, swaps it with the selection, and sends it as context.scheduleId', async () => {
    await open(`/scheduled?chat=S-open&id=${CODEX.id}`);
    const chip = document.querySelector('.wk-chat-chip[data-kind="schedule"]')!;
    expect(chip.textContent).toContain('Codex stable check');

    await typeInto(field(), 'Move it to 09:00');
    await press(byLabel('Send'));
    expect(turnsTo('S-open')[0]!.body).toMatchObject({ content: 'Move it to 09:00', context: { scheduleId: CODEX.id } });
    // After a send the chip is on again for the next message.
    expect(document.querySelector('.wk-chat-chip[data-kind="schedule"]')).toBeTruthy();

    const other = LIST_ROWS.find((row) => row.id !== CODEX.id)!;
    await press(document.querySelector(`.sched-row[data-row$=":${other.id}"]`));
    expect(document.querySelector('.wk-chat-chip[data-kind="schedule"]')!.textContent).toContain(other.title);
  });

  it('a chip crossed out is not sent, and the filter rides as context.scheduleFilter', async () => {
    await open(`/scheduled?chat=S-open&id=${CODEX.id}&workspace=ws-apiserver`);
    await press(document.querySelector('.wk-chat-chip[data-kind="schedule"] .composer-file-remove'));
    expect(document.querySelector('.wk-chat-chip[data-kind="schedule"]')).toBeNull();
    await typeInto(field(), 'Why was it slow?');
    await press(byLabel('Send'));
    const context = (turnsTo('S-open')[0]!.body as { context: Record<string, string> }).context;
    expect(context).toEqual({ scheduleFilter: 'ws-apiserver' });
  });

  it('no row selected: no chip and no scheduleId', async () => {
    await open('/scheduled?chat=S-open');
    expect(document.querySelector('.wk-chat-chip[data-kind="schedule"]')).toBeNull();
    await typeInto(field(), 'What runs tomorrow?');
    await press(byLabel('Send'));
    expect(turnsTo('S-open')[0]!.body).not.toHaveProperty('context');
  });
});

describe('a change line from the chat (board 1 ①, design §2.6)', () => {
  beforeEach(() => {
    openSessions = [asRow('S-open')];
    openChat = 'S-open';
  });

  it('re-reads the schedule list, flashes the row once, and its name selects the row (closing the slide-over below 1200)', async () => {
    await open('/scheduled?chat=S-open');
    const readsBefore = reads.filter((url) => url.startsWith('/api/schedules?') || url === '/api/schedules').length;
    expect(document.querySelector('[data-schedule-record]'), 'nothing yet').toBeNull();

    // The chat changes a schedule: the cards read comes back with its record.
    cards = { run: null, cards: [], records: [CODEX_TIME_RECORD] };
    await act(async () => { await client.invalidateQueries({ queryKey: ['schedules', 'session', 'S-open'] }); });
    await settle();
    expect(document.querySelector('[data-schedule-record] button')!.textContent).toBe('Codex stable check');
    expect(reads.filter((url) => url.startsWith('/api/schedules?') || url === '/api/schedules').length).toBeGreaterThan(readsBefore);
    expect(codexRow().className).toContain('is-flash');

    // A record that was already there when the chat was opened is not a change of this view.
    await open('/scheduled?chat=S-open');
    expect(codexRow().className).not.toContain('is-flash');

    await resize(1100);
    await press(document.querySelector('[data-schedule-name]'));
    expect(where()).toContain(`id=${CODEX.id}`);
    expect(panel(), 'the slide-over closed').toBeNull();
  });
});

describe('Run now from the chat (design §4.6, board 3 ③)', () => {
  beforeEach(() => {
    openSessions = [asRow('S-open')];
    openChat = 'S-open';
  });

  it('draws the agent’s offer as a button that presses through the owner’s POST /api/schedules/:id/run, then shows Started with a link', async () => {
    streamState.events = [{ seq: 5, type: 'assistant', ts: AT, payload: { text: `Press it here: [Run now](orbit-run-now:${CODEX.id})` } }];
    await open('/scheduled?chat=S-open');
    const offer = document.querySelector('[data-run-now]')!;
    expect(offer.textContent).toContain('Codex stable check');
    expect(offer.textContent).not.toContain('Started');
    await press(offer.querySelector('button'));
    expect(writes.filter((w) => w.path.endsWith('/run'))).toEqual([{ method: 'POST', path: `/api/schedules/${CODEX.id}/run`, body: {} }]);
    expect(writes.filter((w) => w.path.includes('/sessions/')), 'never a message of the session').toEqual([]);
    expect(offer.textContent).toContain('Started · open run');
    await press([...offer.querySelectorAll('button')].find((b) => b.textContent === 'open run'));
    expect(where()).toBe('/sessions/run-session');
  });
});

describe('the quick-add line while the panel is open (design §2.8)', () => {
  const quick = (): HTMLInputElement => document.querySelector<HTMLInputElement>('.sched-add-input')!;
  const enter = async (): Promise<void> => {
    await act(async () => quick().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
  };

  it('sends its sentence into the open chat as a message with the page’s view', async () => {
    openSessions = [asRow('S-open')];
    openChat = 'S-open';
    await open(`/scheduled?chat=S-open&id=${CODEX.id}`);
    await typeInto(quick(), 'Every Friday check the changelog');
    await enter();
    expect(turnsTo('S-open')[0]!.body).toMatchObject({ content: 'Every Friday check the changelog', context: { scheduleId: CODEX.id } });
    expect(writes.some((w) => w.path === '/api/schedules/drafts')).toBe(false);
    expect(quick().value).toBe('');
  });

  it('opens a new chat with it when none is open yet', async () => {
    await open('/scheduled?workspace=ws-apiserver');
    await press(chatButton());
    await typeInto(quick(), 'Every Friday check the changelog');
    await enter();
    expect(writes.filter((w) => w.path === '/api/schedules/chat').map((w) => w.body)).toEqual([
      { workspaceId: 'ws-apiserver', text: 'Every Friday check the changelog' },
    ]);
    expect(writes.some((w) => w.path === '/api/schedules/drafts')).toBe(false);
  });

  it('is the draft door as before while the panel is closed', async () => {
    await open('/scheduled');
    await typeInto(quick(), 'Every Friday check the changelog');
    await enter();
    expect(writes.some((w) => w.path === '/api/schedules/drafts')).toBe(true);
  });
});

describe('the Chat button states (board 3 ①)', () => {
  it('is at rest with no chat working or waiting', async () => {
    openSessions = [asRow('S-open')];
    await open('/scheduled');
    expect(chatButton().getAttribute('data-state')).toBe('idle');
    expect(document.querySelector('[data-chat-ring], [data-chat-count]')).toBeNull();
  });

  it('shows a ring while a turn runs', async () => {
    openSessions = [asRow('S-open', { status: 'RUNNING', phase: 'RUNNING' })];
    await open('/scheduled');
    expect(chatButton().getAttribute('data-state')).toBe('working');
    expect(document.querySelector('[data-chat-ring]')).toBeTruthy();
  });

  it('shows an amber count while cards wait, with the panel closed', async () => {
    openSessions = [asRow('S-a', { waitingOn: 'PERSON' }), asRow('S-b', { pendingApprovals: 2 })];
    await open('/scheduled');
    expect(chatButton().getAttribute('data-state')).toBe('needs_you');
    expect(document.querySelector('[data-chat-count]')!.textContent).toBe('3');
  });

  it('counts an envelope card waiting in a chat, read from the chat’s own cards, ahead of the ring', async () => {
    openSessions = [asRow('S-open', { status: 'RUNNING', phase: 'RUNNING' })];
    cards = { run: null, cards: [{ id: 'c1', kind: 'UPDATE', state: 'PENDING' }, { id: 'c2', kind: 'UPDATE', state: 'ALLOWED' }], records: [] };
    await open('/scheduled');
    expect(chatButton().getAttribute('data-state')).toBe('needs_you');
    expect(document.querySelector('[data-chat-count]')!.textContent).toBe('1');
    expect(document.querySelector('[data-chat-ring]')).toBeNull();
  });
});

describe('the Run now button is safe against agent text (design §4.6)', () => {
  const offerOf = (text: string) => [{ seq: 5, type: 'assistant', ts: AT, payload: { text } }];
  beforeEach(() => {
    openSessions = [asRow('S-open'), asRow('S-plain', { chatOrigin: null })];
    openChat = 'S-open';
  });

  it('draws nothing for an id that is not one of the account’s schedules', async () => {
    streamState.events = offerOf('[Run now](orbit-run-now:not-mine)');
    await open('/scheduled?chat=S-open');
    expect(document.querySelector('[data-run-now]')).toBeNull();
  });

  it('titles the button from the server’s list, never from the link’s words', async () => {
    streamState.events = offerOf(`[Delete everything now](orbit-run-now:${CODEX.id})`);
    await open('/scheduled?chat=S-open');
    const offer = document.querySelector('[data-run-now]')!;
    expect(offer.textContent).toContain('Codex stable check');
    expect(offer.textContent).not.toContain('Delete everything');
  });

  it('draws no button for an ended schedule', async () => {
    listRows = LIST_ROWS.map((row) => (row.id === CODEX.id ? { ...row, state: 'ENDED' as const } : row));
    streamState.events = offerOf(`[Run now](orbit-run-now:${CODEX.id})`);
    await open('/scheduled?chat=S-open');
    expect(document.querySelector('[data-run-now]')).toBeNull();
  });

  it('draws no button in a session that is not a Scheduled chat, even when the address names it', async () => {
    streamState.events = offerOf(`[Run now](orbit-run-now:${CODEX.id})`);
    await open('/scheduled?chat=S-plain');
    expect(shownSession()).toBe('S-plain');
    expect(document.querySelector('[data-run-now]')).toBeNull();
  });
});
