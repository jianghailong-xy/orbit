// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiDocView, WikiDocsDirectory } from '@orbit/shared';
import { wikiChatQuoteCounts, type WikiChatList, type WikiChatWorkspace } from '../lib/wikiChat';
import { readSidebarFolded } from '../lib/sidebarFold';

// A section's diagram is drawn by Mermaid, which jsdom cannot lay out.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

// The conversation is the session page's own (SessionConversation over useSessionStream), whose tests own it; its
// live stream needs an EventSource and a runner. Here a stand-in stream holds what a case sets: the approvals
// waiting, whether a turn is running, and the messages queued or sent into the turn (the tray's).
const stream = vi.hoisted(() => ({ approvals: [] as unknown[], idle: true, accepted: [] as unknown[], queued: [] as unknown[] }));
vi.mock('../lib/useSessionStream', () => ({
  useSessionStream: () => ({
    events: [],
    eventsSessionId: null,
    transcriptEvents: [],
    approvals: stream.approvals,
    setApprovals: (next: unknown) => {
      stream.approvals = typeof next === 'function' ? (next as (v: unknown[]) => unknown[])(stream.approvals) : (next as unknown[]);
    },
    idle: stream.idle,
    setIdle: (idle: boolean) => {
      stream.idle = idle;
    },
    setAcceptedUserTurns: (next: unknown) => {
      stream.accepted = typeof next === 'function' ? (next as (v: unknown[]) => unknown[])(stream.accepted) : (next as unknown[]);
    },
    queued: stream.queued,
    visibleQueuedTurns: stream.queued,
    setQueued: (next: unknown) => {
      stream.queued = typeof next === 'function' ? (next as (v: unknown[]) => unknown[])(stream.queued) : (next as unknown[]);
    },
  }),
}));
vi.mock('./SessionConversation', () => ({
  SessionConversation: ({ sessionId }: { sessionId: string }) => <div className="conversation" data-session={sessionId} />,
}));

const { WikiPage } = await import('../pages/WikiPage');
const { WIKI_DOC_SECTION_EVENT } = await import('./WikiDirectory');

/**
 * The wiki chat on a real Wiki page (docs/wiki-chat-design.md §2–§5, board 42 ⓪ ①), driven through the real routes
 * over a fake API: the round button on every page but Settings, in its four looks; the panel it opens, docked or
 * over the page by the window's width, kept open across pages by `?chat=`; a selection on a document snapped to
 * whole sentences under the cap of 20, offered as Ask; the page and the quote as chips, crossed out and frozen
 * into what a message sends; the first choice of where a space's chats run; and the session's approval cards
 * answered in the panel.
 */

interface Shared {
  docs: { directory: { read: WikiDocsDirectory }; doc: { read: WikiDocView } };
  plan: { versions: Record<string, unknown> };
}
const SHARED = JSON.parse(
  readFileSync(
    [resolve(process.cwd(), '../shared/src/wiki-docs.fixture.json'), resolve(process.cwd(), 'src/shared/src/wiki-docs.fixture.json')].find((path) =>
      existsSync(path),
    )!,
    'utf8',
  ),
) as Shared;

const SPACE_ID = '0196f000-0000-7000-8000-000000000001';
const SPACE = {
  id: SPACE_ID,
  slug: 'orbit',
  title: 'orbit',
  repoUrlNorm: 'github.com/jianghailong-xy/orbit',
  rootCommitSha: 'b'.repeat(40),
  settings: {},
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  pendingOps: 0,
};

/** The fixture's document as a server serving the chat reads it: every sentence with its id. */
function withIds(doc: WikiDocView): WikiDocView {
  const copy = structuredClone(doc);
  for (const section of copy.sections) {
    section.blocks.forEach((block, b) => block.sentences.forEach((sentence, s) => (sentence.id = `${section.key}-${b}-${s}`)));
  }
  return copy;
}
const DOC = withIds(SHARED.docs.doc.read);
/** The same document with a long last section: 30 sentences in one paragraph. */
const LONG: WikiDocView = (() => {
  const copy = structuredClone(DOC);
  copy.slug = 'long-read';
  const last = copy.sections[copy.sections.length - 1]!;
  last.blocks = [
    {
      kind: 'paragraph',
      text: null,
      sentences: Array.from({ length: 30 }, (_, i) => ({
        id: `long-${i + 1}`,
        text: `Sentence ${i + 1} of the long section.`,
        status: 'sourced' as const,
        notes: [i + 1],
        newTokens: [],
        withdrawn: null,
      })),
    },
  ];
  return copy;
})();

const DEVELOP: WikiChatWorkspace = { id: 'w1', name: 'orbit-develop', runner: 'HPC', online: true };
const MAC: WikiChatWorkspace = { id: 'w2', name: 'orbit-mac', runner: 'austin', online: false };
const NO_COUNTS = { needsYou: 0, working: false, updated: 0 };

/** The space's chats as the server serves them; a case sets what it needs. */
let chats: WikiChatList;
/** What the fake API was asked to write, in order. */
let writes: Array<{ method: string; path: string; body: Record<string, unknown> }>;
/** The files uploaded, in order: what they were scoped to (`sessionId=…`, or nothing for a new chat's). */
let uploads: Array<{ scope: string; name: string; type: string; id: string }>;
/** The chat session's detail. */
let session: Record<string, unknown>;
/** Every chats read's query, in order (`q=…&offset=…`, or empty). */
let chatReads: string[];
/** How many chats one read serves: the server's rules.chatsListed, made small where paging is the point. */
let chatsPage: number;

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split('?')[0]!;
  const method = (init?.method ?? 'GET').toUpperCase();
  const space = `/api/wiki/spaces/${SPACE_ID}`;
  if (method === 'POST' && path === '/api/attachments') {
    // An upload is multipart: what it was scoped to, and the file, are what a case reads.
    const file = (init?.body as FormData).get('file') as File;
    const id = `ATT${uploads.length + 1}`;
    uploads.push({ scope: url.split('?')[1] ?? '', name: file.name, type: file.type, id });
    return reply(201, { id });
  }
  if (method !== 'GET') {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    writes.push({ method, path, body });
    if (path === `${space}/chats`) {
      chats = { ...chats, workspace: { ...(chats.choices.find((c) => c.id === body.workspaceId) ?? DEVELOP), eligible: true } };
      return reply(201, { sessionId: 'S1chat', chat: { sessionId: 'S1chat', title: '', status: 'QUEUED', open: true } });
    }
    if (path.endsWith('/turns/current-work-routing')) {
      const turnId = `T${writes.length + 1}`;
      // While a turn runs, the server writes a message sent into it as a steer, and queues one for the next turn.
      const placement = session.runState === 'RUNNING' ? (body.intent === 'CURRENT_WORK' ? 'steer' : 'queued') : 'accepted';
      return reply(201, { turnId, seq: writes.length + 1, kind: placement === 'steer' ? 'steer' : 'message', placement, ...(placement === 'steer' ? { targetTurnId: 'T1' } : {}) });
    }
    return reply(200, { ok: true });
  }
  if (path === '/api/wiki/spaces') return reply(200, [SPACE]);
  if (path === space) return reply(200, SPACE);
  if (path === `${space}/chats`) {
    // One page, as the server pages it (contract `chat.list.page`): a title search and an offset.
    const params = new URLSearchParams(url.split('?')[1] ?? '');
    chatReads.push(params.toString());
    const q = (params.get('q') ?? '').toLowerCase();
    const matched = chats.chats.filter((row) => !q || row.title.toLowerCase().includes(q));
    const offset = Number(params.get('offset') ?? 0);
    return reply(200, { ...chats, chats: matched.slice(offset, offset + chatsPage), more: matched.length > offset + chatsPage });
  }
  if (path === `${space}/docs`) return reply(200, SHARED.docs.directory.read);
  if (path === `${space}/docs/session-runtime`) return reply(200, DOC);
  if (path === `${space}/plan`) return reply(200, { spaceId: SPACE_ID, confirmed: SHARED.plan.versions.v1, draft: null, proposals: [], job: null });
  if (path === `${space}/docs/long-read`) return reply(200, LONG);
  if (path === `${space}/entries`) return reply(200, []);
  if (path === `${space}/timeline`) return reply(200, { items: [] });
  if (path === '/api/sessions/S1chat') return reply(200, session);
  if (path === '/api/workspaces') return reply(200, [{ id: 'w1', name: 'orbit-develop', runnerId: 'r1', provider: null, model: null }]);
  if (path === '/api/runners') {
    return reply(200, [
      {
        id: 'r1', name: 'hpc-01', displayName: 'HPC', online: true,
        modelCatalog: { claude: [{ value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }] },
      },
    ]);
  }
  if (path === '/api/providers') return reply(200, []);
  if (path === '/api/users/me') return reply(200, { id: 'u1', preferences: { defaultPermissionMode: 'default' } });
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
  chats = { spaceId: SPACE_ID, workspace: { ...DEVELOP, eligible: true }, choices: [DEVELOP, MAC], fab: NO_COUNTS, chats: [] };
  writes = [];
  uploads = [];
  chatReads = [];
  chatsPage = 50;
  session = {
    id: 'S1chat', title: 'Runner offline: why three heartbeats', runState: 'AWAITING_INPUT', status: 'AWAITING_INPUT',
    workspace: { id: 'w1', name: 'orbit-develop' }, assignedRunnerId: 'r1', engine: 'claude', provider: 'claude',
    model: 'claude-opus-5-5', permissionMode: 'default',
  };
  stream.approvals = [];
  stream.idle = true;
  stream.accepted = [];
  stream.queued = [];
  // The panel as these cases knew it: hidden until the button opens it. Board 45 opens it by default where it docks
  // unless the owner hid it with ✕, which is what this says; the cases of board 45 below take it out.
  storage = { local: new Map([['orbit.wikiChat.closed', JSON.stringify({ orbit: true })]]), session: new Map() };
  windowWidth(1500);
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
  window.getSelection()?.removeAllRanges();
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

/** Open `path` as a fresh load: a new router and a new cache, as a reload would (the tab's storage is kept). */
async function open(path: string): Promise<void> {
  act(() => root.unmount());
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/wiki/review" element={<WikiPage route="review" />} />
            <Route path="/wiki/:space" element={<WikiPage route="home" />} />
            <Route path="/wiki/:space/activity" element={<WikiPage route="activity" />} />
            <Route path="/wiki/:space/review" element={<WikiPage route="review" />} />
            <Route path="/wiki/:space/t/:topic" element={<WikiPage route="topic" />} />
            <Route path="/wiki/:space/d/:doc" element={<WikiPage route="doc" />} />
            <Route path="/wiki/:space/plan" element={<WikiPage route="plan" />} />
            <Route path="/wiki/:space/plan/d/:doc" element={<WikiPage route="planDoc" />} />
            <Route path="/wiki/:space/plan/d/:doc/:section" element={<WikiPage route="planSection" />} />
            <Route path="/wiki/:space/browse" element={<WikiPage route="browse" />} />
            <Route path="/wiki/:space/az" element={<WikiPage route="index" />} />
            <Route path="/wiki/:space/e/:entry" element={<WikiPage route="entry" />} />
            <Route path="/wiki/:space/settings" element={<WikiPage route="settings" />} />
            <Route path="/wiki/:space/run/:run" element={<WikiPage route="run" />} />
            <Route path="/sessions/:id" element={<span className="session-page">session</span>} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const fab = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.wk-chat-fab');
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-panel');
const host = (): HTMLElement => document.querySelector<HTMLElement>('.wk-chat-host')!;
const chips = (): string[] =>
  [...document.querySelectorAll('.wk-chat-chip')].map((chip) => chip.textContent?.replace(/\s+/g, ' ').trim() ?? '');
const press = async (node: Element | null | undefined): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};
const byLabel = (label: string): HTMLElement | null => document.querySelector<HTMLElement>(`[aria-label="${label}"]`);

/** The panel's composer: the session page's own (board 43). */
const composer = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-composer .composer-box');
const field = (): HTMLTextAreaElement => composer()!.querySelector<HTMLTextAreaElement>('.composer-field textarea')!;

async function type(value: string): Promise<void> {
  const area = field();
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Select from `from` characters into one sentence to `to` characters into another, and let go of the mouse. */
async function select(first: string, from: number, last: string, to: number): Promise<void> {
  const text = (id: string) => {
    const node = document.querySelector(`[data-wk-sid="${id}"]`);
    expect(node, id).toBeTruthy();
    const walker = document.createTreeWalker(node!, NodeFilter.SHOW_TEXT);
    return walker.nextNode() as Text;
  };
  const range = document.createRange();
  range.setStart(text(first), from);
  range.setEnd(text(last), to);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  await act(async () => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await settle();
}

describe('the round button (design §3, board 42 ⓪)', () => {
  it('is on every page of a space but its Settings', async () => {
    const pages = [
      '/wiki/orbit',
      '/wiki/orbit/activity',
      '/wiki/orbit/review',
      '/wiki/orbit/t/tasks-dispatch',
      '/wiki/orbit/d/session-runtime',
      '/wiki/orbit/plan',
      '/wiki/orbit/browse',
      '/wiki/orbit/az',
      '/wiki/orbit/e/0196f000-0000-7000-8000-0000000000e1',
      '/wiki/orbit/run/0196f000-0000-7000-8000-0000000000c1',
    ];
    for (const path of pages) {
      await open(path);
      expect(fab(), path).toBeTruthy();
      expect(fab()!.getAttribute('aria-label')).toBe('Chat');
    }
    await open('/wiki/orbit/settings');
    expect(fab()).toBeNull();
    // Review across every space has no space, so no chats to open.
    await open('/wiki/review');
    expect(fab()).toBeNull();
  });

  it('draws its four looks from the counts the chats read serves', async () => {
    const looks: Array<[WikiChatList['fab'], string, string, string]> = [
      [NO_COUNTS, 'idle', 'Chat', ''],
      [{ needsYou: 0, working: true, updated: 0 }, 'working', 'Working…', ''],
      [{ needsYou: 2, working: true, updated: 1 }, 'needs_you', '2 need you', '2'],
      [{ needsYou: 0, working: false, updated: 1 }, 'updated', 'Wiki updated', ''],
    ];
    for (const [counts, state, label, badge] of looks) {
      chats = { ...chats, fab: counts };
      await open('/wiki/orbit');
      expect(fab()!.dataset.state).toBe(state);
      expect(fab()!.getAttribute('aria-label')).toBe(label);
      expect(fab()!.querySelector('.wk-chat-fab-ring') !== null).toBe(state === 'working');
      expect(fab()!.querySelector('.wk-chat-fab-badge.amb')?.textContent ?? '').toBe(badge);
      expect(fab()!.querySelector('.wk-chat-fab-badge.ok') !== null).toBe(state === 'updated');
    }
  });

  it('opens the chat that needs the owner, and hides while the panel is open; ✕ brings it back', async () => {
    chats = {
      ...chats,
      fab: { needsYou: 1, working: false, updated: 0 },
      chats: [
        { sessionId: 'S0new', title: 'Newer', status: 'AWAITING_INPUT', open: true, createdAt: '', updatedAt: '', drafts: 0, needsYou: 0 },
        { sessionId: 'S1chat', title: 'Runner offline', status: 'AWAITING_INPUT', open: true, createdAt: '', updatedAt: '', drafts: 1, needsYou: 1 },
      ],
    };
    await open('/wiki/orbit');
    await press(fab());
    expect(where()).toBe('/wiki/orbit?chat=S1chat');
    expect(panel()).toBeTruthy();
    expect(fab()).toBeNull();
    await press(byLabel('Hide chat'));
    expect(where()).toBe('/wiki/orbit');
    expect(panel()).toBeNull();
    expect(fab()).toBeTruthy();
  });

  it('keeps 88 clear at the page’s foot and floats over the entry drawer: 52 and 24 on a desktop, 56 and 16 with the safe area on a phone', () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    const rule = (selector: string, within = css): string => {
      const at = within.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return within.slice(at, within.indexOf('}', at));
    };
    expect(css).toMatch(/\.wk-chat-host\.has-fab \.wk-page,\s*\.wk-chat-host\.has-fab \.wk-drawer \{ padding-bottom: 88px; \}/);
    const button = rule('.wk-chat-fab');
    for (const part of ['position: fixed', 'right: 24px', 'bottom: 24px', 'width: 52px', 'height: 52px', 'border-radius: 50%', 'background: var(--brand)']) {
      expect(button).toContain(part);
    }
    const drawerZ = Number(/z-index: (\d+)/.exec(rule('.wk-drawer'))![1]);
    expect(Number(/z-index: (\d+)/.exec(button)![1])).toBeGreaterThan(drawerZ);
    const phone = css.slice(css.indexOf('@media (max-width: 639px) {\n  .wk-chat-fab'));
    expect(rule('.wk-chat-fab', phone)).toContain('right: 16px; bottom: calc(16px + env(safe-area-inset-bottom, 0px)); width: 56px; height: 56px');
  });
});

describe('the panel (design §4.1, board 42 ①)', () => {
  it('docks at 1440 and wider, a third of the window or as dragged up to half of it, the directory where it was; ✕ hides it', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=new');
    expect(panel()!.style.width, 'a third of 1500').toBe('500px');
    storage.local.set('orbit.wikiChat.width', '900');
    await open('/wiki/orbit/d/session-runtime?chat=new');
    expect(host().className).toContain('is-wide');
    expect(host().className).toContain('is-docked');
    expect(host().className).not.toContain('is-fold');
    expect(panel()!.style.width, 'dragged, held to half of 1500').toBe('750px');
    expect(host().style.getPropertyValue('--wk-chat-w')).toBe('750px');
    // Head: the title (the chat history), +, ↗ (nothing to open before the first message) and ✕.
    expect(panel()!.querySelector('.wk-chat-title')?.textContent).toBe('New chat');
    expect(byLabel('New chat')).toBeTruthy();
    expect((byLabel('Open as a full session') as HTMLButtonElement).disabled).toBe(true);
    expect(byLabel('Hide chat')).toBeTruthy();
    expect(panel()!.querySelector('.wk-chat-empty')?.textContent).toBe(
      'Ask about this page, or say what should change.Nothing in the wiki changes until you apply it.',
    );
  });

  it('is a column from 1200, the app sidebar its icon rail and the directory where it was; lies over the page from 640; is a sheet below', async () => {
    windowWidth(1300);
    await open('/wiki/orbit/d/session-runtime?chat=new');
    expect(host().className).toMatch(/is-docked/);
    // Board docs/mocks/wiki-rail 03 Ⓑ C2: a column beside the page, which keeps its directory; the sidebar gives the width.
    expect(host().className).not.toMatch(/is-fold/);
    expect(host().parentElement!.className).toBe('wk-chat-frame is-columned');
    expect(panel()!.parentElement).toBe(host().parentElement);
    expect(panel()!.style.width, 'a third of 1300').toBe('433px');
    expect(panel()!.style.top, 'a column has no top of its own').toBe('');
    expect(readSidebarFolded()).toBe(true);

    windowWidth(900);
    await act(async () => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(host().className).toMatch(/is-over/);
    expect(host().className).not.toMatch(/is-docked/);
    expect(host().className).toMatch(/is-fold/);
    expect(panel()!.className).toContain('is-over');
    expect(readSidebarFolded(), 'over the page, the sidebar keeps its width').toBe(false);

    windowWidth(500);
    await act(async () => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(panel()!.className).toContain('is-sheet');
    expect(panel()!.style.width).toBe('');
    // Half the window, then all of it.
    await press(document.querySelector('.wk-chat-grab'));
    expect(panel()!.className).toContain('is-full');
  });

  it('stays open across pages: the address keeps ?chat=, and a reload brings it back', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=new');
    expect(panel()).toBeTruthy();
    // The crumb is a link of the wiki's own, which carries no query.
    await press(document.querySelector('.wk-crumb a'));
    expect(where()).toBe('/wiki/orbit?chat=new');
    expect(panel()).toBeTruthy();
    // A reload of that address opens it again.
    await open('/wiki/orbit?chat=new');
    expect(panel()).toBeTruthy();
    // Hidden, it stays hidden on the next page.
    await press(byLabel('Hide chat'));
    await open('/wiki/orbit/browse');
    expect(panel()).toBeNull();
    expect(where()).toBe('/wiki/orbit/browse');
  });

  it('opens the entry drawer to its left, under the button', async () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    expect(css).toContain('.wk-chat-host.is-open:not(.is-sheet) .wk-drawer,\n.wk-chat-host.is-open:not(.is-sheet) .wk-with-drawer .wk-scrim { right: var(--wk-chat-w, 400px); }');
    await open('/wiki/orbit/e/0196f000-0000-7000-8000-0000000000e1?chat=new');
    expect(document.querySelector('.wk-chat-host.is-open .wk-drawer')).toBeTruthy();
  });

  it('shows a message’s attachment line whole: a line of its own under the bubble, wrapped, the copy and time under it (C15)', () => {
    // jsdom lays nothing out, so the rule is read as text; the C15 screenshots measure it in a browser at 400 wide.
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    // The session page keeps its one line, run out into the free gutter left of the bubble.
    expect(rule('.chat-user-meta')).toContain('white-space: nowrap');
    // The panel's body is a scroll box, which cuts off what runs past its left edge: there the row wraps…
    const row = rule('.wk-chat-body .chat-user-meta');
    for (const part of ['flex-wrap: wrap', 'height: auto', 'min-height: 18px']) expect(row).toContain(part);
    // …the attachment line first, on a line of its own, its words wrapping…
    const line = rule('.wk-chat-body .chat-user-meta > .chat-injected-head');
    for (const part of ['order: -1', 'flex: 1 1 100%', 'white-space: normal']) expect(line).toContain(part);
    // …and the dot that led from the time into it goes with it.
    expect(rule('.wk-chat-body .chat-user-meta > .chat-meta-sep:has(+ .chat-injected-head)')).toContain('display: none');
  });

  it('lists the space’s chats under its title and switches to one', async () => {
    chats = {
      ...chats,
      chats: [{ sessionId: 'S1chat', title: 'Runner offline: why three heartbeats', status: 'AWAITING_INPUT', open: true, createdAt: '', updatedAt: '', drafts: 0, needsYou: 0 }],
    };
    await open('/wiki/orbit?chat=new');
    await press(panel()!.querySelector('.wk-chat-title'));
    const rows = [...document.querySelectorAll('.wk-chat-history-row')];
    expect(rows.map((row) => row.querySelector('.t')?.textContent)).toEqual(['Runner offline: why three heartbeats']);
    await press(rows[0]!.querySelector('.wk-chat-history-open'));
    expect(where()).toBe('/wiki/orbit?chat=S1chat');
    expect(panel()!.querySelector('.wk-chat-title')?.textContent).toBe('Runner offline: why three heartbeats');
  });
});

describe('where a chat runs (design §5.1)', () => {
  it('is chosen the first time, among the workspaces with worktrees, and sent with the first message', async () => {
    chats = { ...chats, workspace: null };
    await open('/wiki/orbit/d/session-runtime?chat=new');
    expect(panel()!.querySelector('.wk-chat-choose .h')?.textContent).toBe("Choose where this space's chats run");
    expect([...document.querySelectorAll('.wk-chat-choice')].map((choice) => choice.textContent)).toEqual(['orbit-developHPC', 'orbit-macaustin']);
    await type('这句少了原因：留三次心跳的余量，是为了扛住一次网关重启。');
    // Nothing is chosen for the owner, so nothing can go yet.
    expect((byLabel('Send') as HTMLButtonElement).disabled).toBe(true);

    await press(document.querySelectorAll('.wk-chat-choice')[0]);
    expect(document.querySelector('.wk-chat-choose')).toBeNull();
    // Runs in holds the workspace alone (board 43 ②): the model and the mode are the composer's toolbar's.
    expect([...document.querySelectorAll('.wk-chat-run .k, .wk-chat-run .v')].map((node) => node.textContent)).toEqual([
      'Runs in', 'orbit-develop · HPC',
    ]);
    expect(composer()!.querySelector('.composer-model-name')?.textContent).toBe('Claude Opus 5.5');
    await press(byLabel('Send'));
    const created = writes.find((write) => write.path === `/api/wiki/spaces/${SPACE_ID}/chats`)!;
    expect(created.body).toEqual({
      workspaceId: 'w1',
      content: '这句少了原因：留三次心跳的余量，是为了扛住一次网关重启。',
      clientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      wikiContext: { page: { kind: 'doc', docSlug: 'session-runtime', sectionKey: 's1' } },
    });
    // The panel is the chat now, and the server remembers the workspace: the next new chat asks nothing.
    expect(where()).toBe('/wiki/orbit/d/session-runtime?chat=S1chat');
    expect(stream.accepted).toEqual([expect.objectContaining({ key: 'initial:S1chat', text: '这句少了原因：留三次心跳的余量，是为了扛住一次网关重启。' })]);
    await press(byLabel('New chat'));
    expect(document.querySelector('.wk-chat-choose')).toBeNull();
    expect(document.querySelector('.wk-chat-run .wk-chat-pick .v')?.textContent).toBe('orbit-develop · HPC');
  });

  it('is chosen again when the remembered one no longer qualifies', async () => {
    chats = { ...chats, workspace: { ...MAC, eligible: false }, choices: [DEVELOP] };
    await open('/wiki/orbit?chat=new');
    expect(panel()!.querySelector('.wk-chat-choose .h')?.textContent).toBe("Choose where this space's chats run");
  });

  it('says what to do when no workspace runs in worktrees, and offers no composer', async () => {
    chats = { ...chats, workspace: null, choices: [] };
    await open('/wiki/orbit?chat=new');
    expect(panel()!.querySelector('.wk-chat-empty')?.textContent).toBe('Turn on worktrees for a workspace in this repository to chat here');
    expect(composer()).toBeNull();
    // The button stays, as ever.
    await press(byLabel('Hide chat'));
    expect(fab()).toBeTruthy();
  });

  it('says so when the machine is offline, and keeps it', async () => {
    chats = { ...chats, workspace: { ...MAC, eligible: true } };
    await open('/wiki/orbit?chat=new');
    expect(document.querySelector('.wk-chat-note')?.textContent).toBe('austin is offline. The chat waits for it to come back.');
    expect(document.querySelector('.wk-chat-run .wk-chat-pick .v')?.textContent).toBe('orbit-mac · austin');
  });
});

describe('a selection on a document (design §2, comment design §2 step 1)', () => {
  it('snaps to whole sentences, lights them and floats Ask; Ask puts them in the composer as a quote', async () => {
    await open('/wiki/orbit/d/session-runtime');
    // From the middle of the first sentence of §1 to two characters into its second.
    await select('s1-0-0', 3, 's1-0-1', 2);
    const ask = document.querySelector('.wk-chat-ask');
    expect(ask?.textContent).toBe('Ask');
    expect([...document.querySelectorAll('.wk-snap')].map((node) => node.getAttribute('data-wk-sid'))).toEqual(['s1-0-0', 's1-0-1']);

    await press(ask);
    // No dialog: the panel opens with the quote in its composer, beside the page.
    expect(where()).toBe('/wiki/orbit/d/session-runtime?chat=new');
    const first = DOC.sections[0]!.blocks[0]!.sentences[0]!;
    const notes = new Set([...first.notes, ...DOC.sections[0]!.blocks[0]!.sentences[1]!.notes]).size;
    expect(chips()).toEqual(['3.1 §1', `${first.text}${wikiChatQuoteCounts(2, notes)}`.replace(/\s+/g, ' ').trim()]);
    expect(document.querySelector('.wk-chat-ask')).toBeNull();
    // The quoted sentences stay lit while the quote is in the composer.
    expect([...document.querySelectorAll('.wk-snap')].map((node) => node.getAttribute('data-wk-sid'))).toEqual(['s1-0-0', 's1-0-1']);
  });

  it('takes a heading as its whole section', async () => {
    await open('/wiki/orbit/d/session-runtime');
    const heading = document.querySelector('section[data-section="s7"] > h2')!;
    const range = document.createRange();
    range.selectNodeContents(heading);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    await settle();
    const s7 = DOC.sections.find((section) => section.key === 's7')!;
    const ids = s7.blocks.flatMap((block) => block.sentences.map((sentence) => sentence.id));
    expect([...document.querySelectorAll('.wk-snap')].map((node) => node.getAttribute('data-wk-sid'))).toEqual(ids);
  });

  it('takes at most 20 sentences, the first ones, and says so', async () => {
    await open('/wiki/orbit/d/long-read');
    await select('long-1', 2, 'long-25', 3);
    expect(document.querySelector('.wk-chat-ask')?.textContent).toBe('AskThe first 20 of 25 sentences');
    expect(document.querySelectorAll('.wk-snap')).toHaveLength(20);
    await press(document.querySelector('.wk-chat-ask'));
    const quote = document.querySelector('.wk-chat-chip.q')!;
    expect(quote.querySelector('.sub')?.textContent).toBe('20 sentences · 20 sources');
    expect(quote.getAttribute('title')).toBe('The first 20 of 25 sentences');
  });
});

describe('the attachments (design §4.2, board 42 ①)', () => {
  it('follow the reader, cross out, and freeze into the message’s wikiContext when it is sent', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=S1chat');
    expect(chips()).toEqual(['3.1 §1']);
    // The page follows the section nearest the top of the reading.
    await act(async () => window.dispatchEvent(new CustomEvent(WIKI_DOC_SECTION_EVENT, { detail: { slug: 'session-runtime', key: 's7' } })));
    expect(chips()).toEqual(['3.1 §3']);

    await select('s7-0-1', 1, 's7-0-1', 4);
    await press(document.querySelector('.wk-chat-ask'));
    expect(chips()).toHaveLength(2);
    // Crossed out, the page is not sent; the quote is.
    await press(byLabel('Remove 3.1 §3'));
    expect(chips()).toHaveLength(1);
    await type('Why three?');
    await press(byLabel('Send'));
    const sent = writes.find((write) => write.path === '/api/sessions/S1chat/turns/current-work-routing')!;
    expect(sent.body).toEqual({
      clientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      content: 'Why three?',
      intent: 'NEXT_TURN',
      wikiContext: { selection: { docSlug: 'session-runtime', sectionKey: 's7', sentenceIds: ['s7-0-1'] } },
    });
    // The next message starts with the page in view again and no quote; what went stays as it went.
    expect(chips()).toEqual(['3.1 §3']);
    await act(async () => window.dispatchEvent(new CustomEvent(WIKI_DOC_SECTION_EVENT, { detail: { slug: 'session-runtime', key: 's9' } })));
    expect(chips()).toEqual(['3.1 §4']);
    expect(sent.body.wikiContext).toEqual({ selection: { docSlug: 'session-runtime', sectionKey: 's7', sentenceIds: ['s7-0-1'] } });
    expect(document.querySelectorAll('.wk-snap')).toHaveLength(0);
  });

  it('opened at a section’s anchor attach that section, though the last one cannot scroll to the top; scrolling on follows the reading (C15)', async () => {
    const reading = (key: string) =>
      act(async () => window.dispatchEvent(new CustomEvent(WIKI_DOC_SECTION_EVENT, { detail: { slug: 'session-runtime', key } })));
    await open('/wiki/orbit/d/session-runtime?chat=S1chat#sec-s9');
    expect(chips()).toEqual(['3.1 §4']);
    // The jump to the last section lands with §3 nearest the top of the reading, and says so again as it settles.
    await reading('s7');
    await reading('s7');
    expect(chips()).toEqual(['3.1 §4']);
    await type('Is this still true?');
    await press(byLabel('Send'));
    const sent = writes.find((write) => write.path === '/api/sessions/S1chat/turns/current-work-routing')!;
    expect(sent.body.wikiContext).toEqual({ page: { kind: 'doc', docSlug: 'session-runtime', sectionKey: 's9' } });
    // Then the reader scrolls: the page follows the reading as it did before.
    await reading('s3');
    expect(chips()).toEqual(['3.1 §2']);
    await reading('s7');
    expect(chips()).toEqual(['3.1 §3']);
    expect(where()).toBe('/wiki/orbit/d/session-runtime?chat=S1chat');
  });

  it('take a section row’s anchor the same way: the directory opens the last section, and that is what goes (C15)', async () => {
    const reading = (key: string) =>
      act(async () => window.dispatchEvent(new CustomEvent(WIKI_DOC_SECTION_EVENT, { detail: { slug: 'session-runtime', key } })));
    await open('/wiki/orbit/d/session-runtime?chat=S1chat');
    await reading('s1');
    expect(chips()).toEqual(['3.1 §1']);
    await press(document.querySelector('a[href="/wiki/orbit/d/session-runtime#sec-s9"]'));
    expect(chips()).toEqual(['3.1 §4']);
    await reading('s7');
    expect(chips()).toEqual(['3.1 §4']);
    await reading('s3');
    expect(chips()).toEqual(['3.1 §2']);
  });

  it('on the plan page attach its document, and the section it shows at one (C12): the page brings the plan to the agent', async () => {
    await open('/wiki/orbit/plan/d/session-runtime/2?chat=S1chat');
    expect(chips()).toEqual(['3.1 §2']);
    await type('Write this one for a first-time reader.');
    await press(byLabel('Send'));
    const atSection = writes.find((write) => write.path === '/api/sessions/S1chat/turns/current-work-routing')!;
    expect(atSection.body.wikiContext).toEqual({ page: { kind: 'plan', docSlug: 'session-runtime', sectionKey: 's3' } });

    writes.length = 0;
    await open('/wiki/orbit/plan/d/session-runtime?chat=S1chat');
    expect(chips()).toEqual(['3.1']);
    await type('Split it.');
    await press(byLabel('Send'));
    const atDoc = writes.find((write) => write.path === '/api/sessions/S1chat/turns/current-work-routing')!;
    expect(atDoc.body.wikiContext).toEqual({ page: { kind: 'plan', docSlug: 'session-runtime' } });
  });

  it('cross the quote out, and send nothing when neither is shown', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=S1chat');
    await select('s1-0-0', 0, 's1-0-0', 5);
    await press(document.querySelector('.wk-chat-ask'));
    await press(document.querySelector('.wk-chat-chip.q .x'));
    await press(byLabel('Remove 3.1 §1'));
    expect(chips()).toEqual([]);
    await type('Just a question.');
    await press(byLabel('Send'));
    const sent = writes.find((write) => write.path === '/api/sessions/S1chat/turns/current-work-routing')!;
    expect(sent.body).not.toHaveProperty('wikiContext');
  });
});

describe('a chat that runs', () => {
  it('shows no workspace once it runs: its model and mode are the composer\'s, as on the session page (board 43 ④)', async () => {
    await open('/wiki/orbit?chat=S1chat');
    expect(document.querySelector('.wk-chat-run')).toBeNull();
    expect(composer()!.querySelector('.composer-model-name')?.textContent).toBe('Claude Opus 5.5');
    expect(document.querySelector('.conversation')?.getAttribute('data-session')).toBe('S1chat');
    await press(byLabel('Open as a full session'));
    expect(where()).toBe('/sessions/S1chat');
  });

  it('answers its approval cards in the panel, and stops a running turn', async () => {
    session = { ...session, runState: 'RUNNING', status: 'RUNNING' };
    stream.idle = false;
    stream.approvals = [
      { id: 'AP1', sessionId: 'S1chat', toolName: 'Bash', input: { command: 'git log -1' }, status: 'PENDING', createdAt: '2026-11-06T00:00:00.000Z' },
    ];
    await open('/wiki/orbit?chat=S1chat');
    const approve = [...document.querySelectorAll<HTMLButtonElement>('.wk-chat-body button')].find((button) => /^Approve/.test(button.textContent ?? ''));
    await press(approve);
    expect(writes.find((write) => write.path === '/api/sessions/S1chat/approvals/AP1/decision')?.body).toMatchObject({ behavior: 'allow' });
    // Stop, as the session page's: the turn, and the background work it left running.
    await press(byLabel('Stop'));
    expect(writes.find((write) => write.path === '/api/sessions/S1chat/interrupt')?.body).toEqual({ stopBackgroundWork: true });
  });
});

describe('the composer: the session page’s own (board 43, plan A)', () => {
  /** The writes of the session's own message door, in order. */
  const turns = () => writes.filter((write) => write.path === '/api/sessions/S1chat/turns/current-work-routing');
  /** Stage a file through the composer's `+`: its File picker, or its Image one. */
  async function attach(name: string, type: string, picker: 'File' | 'Image' = 'File'): Promise<void> {
    const input = composer()!.querySelector<HTMLInputElement>(picker === 'Image' ? 'input[type="file"][accept]' : 'input[type="file"]:not([accept])')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['a line of the log'], name, { type })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await settle();
  }
  /** A press as a pointer makes it, for the house Select and Menu (base-ui reads the pointer, not just the click). */
  async function point(node: Element | null | undefined): Promise<void> {
    expect(node).toBeTruthy();
    await act(async () => {
      const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
      node!.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
      node!.dispatchEvent(new MouseEvent('mousedown', init));
      node!.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse', isPrimary: true }));
      node!.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      node!.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    });
    await settle();
  }
  /** Open the toolbar's mode picker, as the session page's tests open a house Select, and wait for its options. */
  async function openMode(): Promise<void> {
    const trigger = composer()!.querySelector('.composer-toolbar .orbit-select [role="combobox"]');
    expect(trigger).toBeTruthy();
    await act(async () => {
      const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
      trigger!.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
      trigger!.dispatchEvent(new MouseEvent('mousedown', init));
      trigger!.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
      trigger!.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      trigger!.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
    });
    // It opens a few frames later (base-ui's floating layer), each of which React has to be let through.
    for (let frame = 0; frame < 100; frame += 1) {
      if (document.querySelectorAll('[role="listbox"] [role="option"]').length > 0) return;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    throw new Error('the mode picker did not open');
  }
  const menuRow = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((row) => row.textContent?.trim() === label);
  const option = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].find((row) => row.textContent?.startsWith(label));

  it('is the session page’s SessionComposer, with the page and the selection first in its attachment row, each with its cross (④)', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=S1chat');
    await select('s1-0-0', 0, 's1-0-1', 2);
    await press(document.querySelector('.wk-chat-ask'));
    await attach('runner.log', 'text/plain');
    const box = composer()!;
    // The attachment row: the page, the selection, then the file staged beside them — each a chip with its cross.
    const row = [...box.querySelector('.composer-attachments')!.children];
    expect(row.map((chip) => chip.getAttribute('data-kind') ?? chip.className)).toEqual(['page', 'quote', 'composer-pill composer-file']);
    expect(row.map((chip) => chip.querySelector('button')?.getAttribute('aria-label'))).toEqual([
      'Remove 3.1 §1', `Remove ${DOC.sections[0]!.blocks[0]!.sentences[0]!.text}`, 'Remove file',
    ]);
    // The rest is the session page's: its field, and its toolbar of +, mode, model and effort, the context gauge and Send.
    expect(field().getAttribute('placeholder')).toBe('Ask about this page, or say what should change');
    const toolbar = box.querySelector('.composer-toolbar')!;
    expect(toolbar.querySelector('[aria-label="Add attachment"]')).toBeTruthy();
    expect(toolbar.querySelectorAll('.orbit-select')).toHaveLength(1);
    expect(toolbar.querySelector('.composer-model-chip')?.getAttribute('aria-label')).toBe('Model Claude Opus 5.5, effort Default');
    expect(toolbar.querySelector('.composer-usage')).toBeTruthy();
    expect(toolbar.querySelector('[aria-label="Send"]')).toBeTruthy();
    // The very component the session page renders, not one drawn to look like it.
    const source = (file: string) => readFileSync(resolve(__dirname, file), 'utf8');
    expect(source('WikiChatPanel.tsx')).toMatch(/import \{[^}]*\bSessionComposer,[^}]*\} from '\.\/WorkspaceView';/su);
    expect(source('WikiChatPanel.tsx').match(/<SessionComposer\n/gu)).toHaveLength(2);
    expect(source('WorkspaceView.tsx').match(/<SessionComposer\n/gu)).toHaveLength(1);
    expect(source('WikiChatPanel.tsx')).not.toMatch(/<textarea|function WikiChatComposer/u);
  });

  it('a new chat’s Runs in holds only the workspace; the model and the mode picked in the toolbar go with its create (②)', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=new');
    expect([...document.querySelectorAll('.wk-chat-run select')].map((picker) => picker.getAttribute('aria-label'))).toEqual(['Workspace']);
    // The mode from its picker, the model from the chip's menu: where the session page has them.
    await openMode();
    await point(option('Plan'));
    await act(async () => composer()!.querySelector('.composer-model-chip')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    await act(async () => menuRow('Claude Sonnet 5.5')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await settle();
    expect(composer()!.querySelector('.composer-model-name')?.textContent).toBe('Claude Sonnet 5.5');
    await type('Split 3.1 in two: what a turn is, and how it is delivered.');
    await press(byLabel('Send'));
    const created = writes.find((write) => write.path === `/api/wiki/spaces/${SPACE_ID}/chats`)!;
    expect(created.body).toEqual({
      workspaceId: 'w1',
      content: 'Split 3.1 in two: what a turn is, and how it is delivered.',
      clientTurnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      wikiContext: { page: { kind: 'doc', docSlug: 'session-runtime', sectionKey: 's1' } },
      model: 'claude-sonnet-5-5',
      permissionMode: 'plan',
    });
    // Once the chat runs, Runs in is gone.
    expect(where()).toBe('/wiki/orbit/d/session-runtime?chat=S1chat');
    expect(document.querySelector('.wk-chat-run')).toBeNull();
  });

  it('a chat that runs changes its session’s config as the session page does', async () => {
    await open('/wiki/orbit?chat=S1chat');
    await openMode();
    await point(option('Accept Edits'));
    expect(writes.find((write) => write.path === '/api/sessions/S1chat/config')?.body).toEqual({ permissionMode: 'acceptEdits' });
  });

  it('while a turn runs: Stop with nothing typed; a message goes into the turn, or waits for the next held or with ⌥Enter, in the tray (⑤)', async () => {
    session = { ...session, runState: 'RUNNING', status: 'RUNNING' };
    stream.idle = false;
    await open('/wiki/orbit?chat=S1chat');
    expect(byLabel('Stop')).toBeTruthy();
    expect(byLabel('Send')).toBeNull();
    // Typed while it runs, Send says where it goes: into the running turn, the way the session page sends it.
    await type('Read the lease from the config, not the constant.');
    const into = byLabel('Add to current work')!;
    expect(into.getAttribute('title')).toMatch(/^Send into the current turn · .*Enter, or hold, to queue it for the next turn$/u);
    await press(into);
    expect(turns()[0]!.body).toMatchObject({ content: 'Read the lease from the config, not the constant.', intent: 'CURRENT_WORK' });
    // ⌥Enter queues it for the next turn instead.
    await type('Then run the spec again.');
    await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(turns()[1]!.body).toMatchObject({ content: 'Then run the spec again.', intent: 'NEXT_TURN' });
    // Both wait over the composer, as on the session page: the one sent into the turn, and the one queued behind it.
    const rows = [...document.querySelectorAll('.wk-chat-composer .pending-tray-row')];
    expect(rows.map((row) => [row.querySelector('.pending-tray-text')?.textContent, row.querySelector('.pending-tray-state')?.textContent])).toEqual([
      ['Read the lease from the config, not the constant.', 'Sending…'],
      ['Then run the spec again.', 'Queued for next turn'],
    ]);
    expect(byLabel('Stop')).toBeTruthy();
  });

  it('sends pictures and files with a new chat’s first message, and with a later one through the session’s own door', async () => {
    // A picture is previewed from this tab's own bytes; jsdom makes no object URLs, so they are stood in for.
    const own = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    try {
      await open('/wiki/orbit/d/session-runtime?chat=new');
      await attach('lease-timeline.png', 'image/png', 'Image');
      await attach('runner.log', 'text/plain');
      // Staged after the page chip, each with its cross: the picture as a thumbnail, the file as a chip.
      const staged = [...composer()!.querySelectorAll('.composer-attachments > :not(.wk-chat-chip)')];
      expect(staged.map((chip) => [chip.className, chip.querySelector('button')?.getAttribute('aria-label')])).toEqual([
        ['composer-pill composer-attach', 'Remove image'],
        ['composer-pill composer-file', 'Remove file'],
      ]);
      await type('The timeline and the runner log from the night it went offline.');
      await press(byLabel('Send'));
      // Uploaded before any session exists, and named in the create, which links them to the chat's first turn.
      expect(uploads).toEqual([
        { scope: '', name: 'lease-timeline.png', type: 'image/png', id: 'ATT1' },
        { scope: '', name: 'runner.log', type: 'text/plain', id: 'ATT2' },
      ]);
      expect(writes.find((write) => write.path === `/api/wiki/spaces/${SPACE_ID}/chats`)!.body).toMatchObject({
        content: 'The timeline and the runner log from the night it went offline.',
        attachmentIds: ['ATT1', 'ATT2'],
      });
      expect(stream.accepted).toEqual([
        expect.objectContaining({
          key: 'initial:S1chat',
          attachments: [
            { id: 'ATT1', mime: 'image/png', name: 'lease-timeline.png' },
            { id: 'ATT2', mime: 'text/plain', name: 'runner.log' },
          ],
        }),
      ]);
      // The chat runs now: later files are the session's own uploads, and go with the message through its door.
      expect(composer()!.querySelector('.composer-attachments > :not(.wk-chat-chip)')).toBeNull();
      await attach('heartbeats.png', 'image/png', 'Image');
      await attach('heartbeats.csv', 'text/csv');
      await type('And the heartbeats.');
      await press(byLabel('Send'));
      expect(uploads.slice(2)).toEqual([
        { scope: 'sessionId=S1chat', name: 'heartbeats.png', type: 'image/png', id: 'ATT3' },
        { scope: 'sessionId=S1chat', name: 'heartbeats.csv', type: 'text/csv', id: 'ATT4' },
      ]);
      expect(turns().at(-1)!.body).toMatchObject({ content: 'And the heartbeats.', intent: 'NEXT_TURN', attachmentIds: ['ATT3', 'ATT4'] });
      expect(composer()!.querySelector('.composer-attachments > :not(.wk-chat-chip)')).toBeNull();
    } finally {
      URL.createObjectURL = own.create;
      URL.revokeObjectURL = own.revoke;
    }
  });
});

describe('open by default where it docks (board 45 ①②, owner 11-11)', () => {
  const ROW = { status: 'AWAITING_INPUT', open: true, createdAt: '', updatedAt: '', drafts: 0, needsYou: 0 };
  beforeEach(() => storage.local.delete('orbit.wikiChat.closed'));

  it('opens a wiki page with the panel shown, on the chat the button would open, and writes no address', async () => {
    await open('/wiki/orbit');
    expect(panel()?.querySelector('.wk-chat-title')?.textContent).toBe('New chat');
    expect(fab()).toBeNull();
    expect(host().classList.contains('is-docked')).toBe(true);
    expect(where()).toBe('/wiki/orbit');

    chats = { ...chats, chats: [{ ...ROW, sessionId: 'S1chat', title: 'Runner offline: why three heartbeats' }] };
    await open('/wiki/orbit/d/session-runtime');
    expect(panel()?.querySelector('.wk-chat-title')?.textContent).toBe('Runner offline: why three heartbeats');
    expect(where()).toBe('/wiki/orbit/d/session-runtime');
  });

  it('stays folded where the panel would lie over the page, and on Settings', async () => {
    windowWidth(1000);
    await open('/wiki/orbit');
    expect(panel()).toBeNull();
    expect(fab()).toBeTruthy();
    windowWidth(1500);
    await open('/wiki/orbit/settings');
    expect(panel()).toBeNull();
  });

  it('folds away with the window narrowed past docking, and comes back widened', async () => {
    await open('/wiki/orbit');
    expect(panel()).toBeTruthy();
    windowWidth(1100);
    await act(async () => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(panel()).toBeNull();
    expect(fab()).toBeTruthy();
    windowWidth(1500);
    await act(async () => window.dispatchEvent(new Event('resize')));
    await settle();
    expect(panel()).toBeTruthy();
  });

  it('remembers ✕ on the device across loads until the round button opens it again; an address that names a chat still opens', async () => {
    chats = { ...chats, chats: [{ ...ROW, sessionId: 'S1chat', title: 'Runner offline' }] };
    await open('/wiki/orbit');
    await press(byLabel('Hide chat'));
    expect(panel()).toBeNull();
    expect(JSON.parse(storage.local.get('orbit.wikiChat.closed')!)).toEqual({ orbit: true });
    storage.session.clear();
    await open('/wiki/orbit');
    expect(panel(), 'a new load, a new tab: still hidden').toBeNull();
    await open('/wiki/orbit?chat=S1chat');
    expect(panel(), 'the address is a press of its own').toBeTruthy();
    storage.session.clear();
    await open('/wiki/orbit');
    expect(panel()).toBeNull();
    await press(fab());
    expect(panel()).toBeTruthy();
    expect(JSON.parse(storage.local.get('orbit.wikiChat.closed')!)).toEqual({});
    storage.session.clear();
    await open('/wiki/orbit');
    expect(panel(), 'the button undid ✕').toBeTruthy();
  });
});

describe('the history the title opens (board 45 ④, owner 11-11: Q3 A, Q4 A)', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const row = (sessionId: string, title: string, more: Record<string, unknown> = {}) => ({
    sessionId, title, status: 'AWAITING_INPUT', open: true, completed: false, working: false,
    createdAt: at(600), updatedAt: at(5), lastActiveAt: at(5), drafts: 0, needsYou: 0, ...more,
  });
  const historyRows = () =>
    [...document.querySelectorAll('.wk-chat-history-row')].map((one) =>
      `${one.querySelector('.t')?.textContent} | ${one.querySelector('.m')?.textContent}`);
  const openHistory = async () => press(panel()!.querySelector('.wk-chat-title'));

  beforeEach(() => {
    chats = {
      ...chats,
      chats: [
        row('S3quiet', 'Glossary: worktree', { lastActiveAt: at(3) }),
        row('S2work', 'Split chapter 4', { working: true }),
        row('S1chat', 'Runner offline', { needsYou: 1, lastActiveAt: at(120) }),
        row('S4done', 'English UI copy', { completed: true, open: false, status: 'SUCCEEDED', lastActiveAt: at(60 * 30) }),
      ],
    };
  });

  it('turns the panel into the list: Open with what needs the owner first, then the working, then by time; Completed folded', async () => {
    await open('/wiki/orbit?chat=S1chat');
    await openHistory();
    expect(panel()!.querySelector('.wk-chat-title .t')?.textContent).toBe('Chats');
    expect(panel()!.querySelector('.wk-chat-main')?.hasAttribute('hidden'), 'the chat stays, hidden').toBe(true);
    expect(historyRows()).toEqual(['Runner offline | 1 needs you', 'Split chapter 4 | Working…', 'Glossary: worktree | 3m ago']);
    expect(document.querySelector('.wk-chat-history-row.on .t')?.textContent).toBe('Runner offline');
    const fold = document.querySelector<HTMLButtonElement>('.wk-chat-history-group.is-fold')!;
    expect(fold.textContent).toContain('Completed');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    await press(fold);
    expect(historyRows()).toContain('English UI copy | Yesterday');
    // Esc goes back to the chat it was opened over.
    await act(async () => panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
    expect(document.querySelector('.wk-chat-history')).toBeNull();
    expect(panel()!.querySelector('.wk-chat-title .t')?.textContent, 'the session’s own title').toBe('Runner offline: why three heartbeats');
  });

  it('searches titles on the server, Completed included, and asks for the next page with Show more', async () => {
    chatsPage = 2;
    await open('/wiki/orbit?chat=new');
    await openHistory();
    expect(historyRows()).toHaveLength(2);
    await press([...document.querySelectorAll('button')].find((b) => b.textContent === 'Show more'));
    expect(chatReads).toContain('offset=2');
    expect(historyRows()).toHaveLength(3);
    const search = document.querySelector<HTMLInputElement>('.wk-chat-history-search input')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(search, 'english');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(chatReads).toContain('q=english');
    expect(historyRows()).toEqual(['English UI copy | Yesterday']);
    await act(async () => {
      setValue.call(search, 'nothing like it');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(document.querySelector('.wk-chat-history-none')?.textContent).toBe('No chats match');
  });

  const menuOf = async (title: string) => {
    const one = [...document.querySelectorAll('.wk-chat-history-row')].find((r) => r.querySelector('.t')?.textContent === title)!;
    await press(one.querySelector('.wk-chat-history-more'));
    return [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
  };

  it('holds the session list’s actions in a row’s ⋯, through the same doors', async () => {
    await open('/wiki/orbit?chat=new');
    await openHistory();
    const items = await menuOf('Split chapter 4');
    expect(items.map((item) => item.textContent)).toEqual(['Rename…', 'Open as a full session', 'Complete', 'Move to Trash']);
    await press(items.find((item) => item.textContent === 'Complete'));
    expect(writes.at(-1)).toMatchObject({ method: 'POST', path: '/api/sessions/S2work/complete' });

    await press((await menuOf('Glossary: worktree')).find((item) => item.textContent === 'Rename…'));
    const field = document.querySelector<HTMLInputElement>('.wk-chat-history-rename')!;
    expect(field.getAttribute('aria-label')).toBe('Chat name');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(field, 'Glossary: worktree and branch');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    expect(writes.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/sessions/S3quiet', body: { title: 'Glossary: worktree and branch' } });
  });

  it('moves a chat to Trash with no question, and the panel turns to a new chat when it was the one shown', async () => {
    await open('/wiki/orbit?chat=S1chat');
    await openHistory();
    await press((await menuOf('Runner offline')).find((item) => item.textContent === 'Move to Trash'));
    expect(writes.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/sessions/S1chat' });
    expect(where()).toBe('/wiki/orbit?chat=new');
    expect(document.querySelector('.wk-chat-history'), 'the list stays').toBeTruthy();
  });
});
