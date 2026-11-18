// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiDocView, WikiDocsDirectory } from '@orbit/shared';
import type { WikiChatList, WikiChatWorkspace } from '../lib/wikiChat';
import { HelpDrawerProvider, useHelpDrawer } from '../lib/helpDrawer';
import { HelpDrawer } from './HelpDrawer';

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

/**
 * The help drawer and the wiki chat share the right-hand dock slot (board docs/mocks/help-center/01-web.png ①): one at a
 * time. Driven through a real Wiki page over the wiki chat suite's fake API (WikiChat.test.tsx), with the help drawer's
 * provider around it as App mounts it.
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
          <HelpDrawerProvider>
          <HelpToggle />
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
          <HelpDrawer />
          <Where />
          </HelpDrawerProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const fab = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.wk-chat-fab');
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-panel');
const press = async (node: Element | null | undefined): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};

/** A stand-in for the sidebar's ? button: what any caller of the drawer's API does. */
function HelpToggle() {
  const help = useHelpDrawer();
  return <button type="button" className="help-toggle" onClick={help.toggleHelp}>Help</button>;
}
const helpDrawer = (): HTMLElement | null => document.querySelector<HTMLElement>('aside.help-drawer');
const pressQuestion = async (): Promise<void> => {
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true, cancelable: true }));
  });
  await settle();
};

describe('the help drawer and the wiki chat share one dock', () => {
  it('opening help closes an open chat panel', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=new');
    expect(panel()).toBeTruthy();
    expect(helpDrawer()).toBeNull();

    await pressQuestion();
    expect(helpDrawer()).toBeTruthy();
    expect(panel()).toBeNull();
    expect(where(), 'the address no longer names the chat').toBe('/wiki/orbit/d/session-runtime');
  });

  it('opening the chat panel closes help', async () => {
    await open('/wiki/orbit/d/session-runtime');
    await press(document.querySelector('.help-toggle'));
    expect(helpDrawer()).toBeTruthy();
    expect(panel()).toBeNull();

    await press(fab());
    expect(panel()).toBeTruthy();
    expect(helpDrawer()).toBeNull();
  });

  it('while help is open, the panel does not come up by default where it docks; closing help gives the slot back', async () => {
    // Board 45: with nothing hidden, a page that docks the panel shows it by default.
    storage.local.delete('orbit.wikiChat.closed');
    await open('/wiki/orbit/d/session-runtime');
    expect(panel(), 'shown by default').toBeTruthy();

    await press(document.querySelector('.help-toggle'));
    expect(helpDrawer()).toBeTruthy();
    expect(panel()).toBeNull();

    await press(document.querySelector('.help-toggle'));
    expect(helpDrawer()).toBeNull();
    expect(panel(), 'back by default').toBeTruthy();
  });
});
