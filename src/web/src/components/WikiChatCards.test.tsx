// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiChatDraftView, WikiDocChangeRow, WikiDocSectionVersionView, WikiDocView, WikiDocsDirectory } from '@orbit/shared';
import { EMPTY_LIVE_TOOL_OUTPUTS } from '../lib/liveToolOutputs';
import { EMPTY_LIVE_TASK_PROGRESS } from '../lib/liveTaskProgress';
import type { WikiChatList, WikiChatWorkspace } from '../lib/wikiChat';
import { wikiSeenKey } from '../lib/wiki';

// A section's diagram is drawn by Mermaid, which jsdom cannot lay out.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

// The chat's live stream needs an EventSource and a runner; here it holds what a case sets — the events of the chat's
// transcript among them — and the conversation that draws them is the session page's own (SessionConversation).
const stream = vi.hoisted(() => ({ events: [] as unknown[], approvals: [] as unknown[], idle: true }));
vi.mock('../lib/useSessionStream', () => ({
  useSessionStream: () => ({
    events: [],
    eventsSessionId: null,
    transcriptEvents: stream.events,
    queued: [],
    visibleQueuedTurns: [],
    setQueued: () => {},
    approvals: stream.approvals,
    setApprovals: () => {},
    idle: stream.idle,
    setIdle: () => {},
    setAcceptedUserTurns: () => {},
    fetchEventFull: async () => null,
    liveToolOutputs: EMPTY_LIVE_TOOL_OUTPUTS,
    taskActivity: { live: EMPTY_LIVE_TASK_PROGRESS, running: new Set() },
    streamingDrafts: null,
    streamingAfterSeq: null,
  }),
}));

const { WikiPage } = await import('../pages/WikiPage');

/**
 * A chat's cards on the real Wiki pages (docs/wiki-chat-design.md §2, §7–§8; board 42 ② ③ ④), over a fake API: the
 * panel draws the card its agent's drafting call made, and the page beside it marks the sections that card would
 * rewrite before the press; Rewrites open beside the chat; the composer asks for a reply to the draft; after Apply the
 * mark goes. A section written since the reader last looked wears Updated, opening See changes, its new sentences lined
 * green. Activity lists the Docs rows of Recently changed, and its amber banner counts the chat's rewrites that wait
 * in W and opens the chat at the first of them. And the C8 review's three: a chat that ended says so and offers a new
 * one, a message that did not go says why, and Ask floats above the selection's first line, not on it.
 */

interface Shared {
  docs: { directory: { read: WikiDocsDirectory }; doc: { read: WikiDocView } };
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
  planWaiting: 0,
  chatWaiting: 0,
};

/** When the reader last looked at the document, and the two writes on either side of it. */
const LOOKED = Date.parse('2026-11-06T09:00:00.000Z');
const BEFORE_LOOK = '2026-11-05T09:00:00.000Z';
const AFTER_LOOK = '2026-11-06T10:05:00.000Z';
/** A sourced sentence of §3 that the write added. */
const ADDED = '若 runner 在此窗口内因自更新或 lease-loss 触发 detach，合并请求恒被拒为 `superseded`。';

/** The fixture's document as a server serving the chat reads it: sentences with ids, and §3 and §4 written again. */
function served(): WikiDocView {
  const copy = structuredClone(SHARED.docs.doc.read);
  for (const section of copy.sections) {
    section.blocks.forEach((block, b) => block.sentences.forEach((sentence, s) => (sentence.id = `${section.key}-${b}-${s}`)));
    section.change = null;
  }
  copy.sections.find((s) => s.key === 's7')!.change = { versionId: 'V7', reason: { kind: 'chat', title: 'Runner offline: why three heartbeats' }, at: AFTER_LOOK, changed: 1 };
  copy.sections.find((s) => s.key === 's9')!.change = { versionId: 'V9', reason: { kind: 'maintenance' }, at: BEFORE_LOOK, changed: 2 };
  return copy;
}
const DOC = served();
const S7 = DOC.sections.find((s) => s.key === 's7')!;
const VERSIONS_S7: WikiDocSectionVersionView[] = [
  {
    id: 'V7',
    reason: { kind: 'chat', title: 'Runner offline: why three heartbeats' },
    at: AFTER_LOOK,
    replacedBy: { kind: 'job', jobId: 'J1' },
    changed: 1,
    rows: [
      ...S7.blocks[0]!.sentences.filter((sentence) => sentence.text !== ADDED).map((sentence) => ({ op: 'same' as const, text: sentence.text })),
      { op: 'removed', text: 'The merge was always refused as superseded.' },
      { op: 'added', text: ADDED },
    ],
  },
];

const DEVELOP: WikiChatWorkspace = { id: 'w1', name: 'orbit-develop', runner: 'HPC', online: true };

function card(over: Partial<WikiChatDraftView> = {}): WikiChatDraftView {
  return {
    id: 'D1',
    sessionId: 'S1chat',
    kind: 'entry',
    state: 'draft',
    label: 'Add decision',
    rationale: 'To ride out one gateway restart.',
    ops: [{
      seq: 0, op: 'add', entryId: null, baseRevision: null, similar: [], tainted: false, entry: null, decision: null,
      payload: { entry: { kind: 'decision', title: 'Runner offline after three missed heartbeats', fields: { decision: 'Three missed heartbeats mark a runner offline.' } }, sources: [{ kind: 'turn', session: 'self' }] },
    }],
    sections: [],
    rewrites: [{ doc: 'session-runtime', key: 's3', where: '3.1 §2', title: 'Turn delivery and inbox claims' }],
    similar: [],
    tainted: false,
    replaces: null,
    replacedBy: null,
    decision: null,
    decidedAt: null,
    undoneAt: null,
    undoable: false,
    changesetId: null,
    rewrite: null,
    createdAt: '2026-11-06T10:00:00.000Z',
    ...over,
  };
}

/** The agent's drafting call and its answer, as the chat's transcript holds them. */
const DRAFTING = [
  { seq: 1, type: 'user', turnId: 't1', payload: { text: 'This sentence lacks its reason: three heartbeats ride out a gateway restart.' } },
  { seq: 2, type: 'assistant', turnId: 't1', payload: { text: 'The code waits for three, but the wiki never says why: one decision is missing.', messageId: 'm1' } },
  { seq: 3, type: 'tool_use', turnId: 't1', payload: { id: 'toolu_1', name: 'mcp__orbit__wiki_propose', input: { rationale: 'x' } } },
  {
    seq: 4,
    type: 'tool_result',
    turnId: 't1',
    payload: { toolUseId: 'toolu_1', isError: false, content: JSON.stringify({ changesetId: '', replayed: false, ops: [{ seq: 0, status: 'draft', entryId: null }], status: 'draft', draftId: 'D1', similar: [], rewrites: [] }) },
  },
];

let chats: WikiChatList;
let spaceRow: typeof SPACE;
/** The owner's other spaces, after this one in the spaces list. */
let others: Array<typeof SPACE>;
let theCard: WikiChatDraftView;
let session: Record<string, unknown>;
let docChanges: WikiDocChangeRow[];
let writes: Array<{ method: string; path: string; body: Record<string, unknown> }>;
/** How the next message's send fails, if it does. */
let sendFails: { status: number; body: Record<string, unknown> } | 'network' | null;

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split('?')[0]!;
  const method = (init?.method ?? 'GET').toUpperCase();
  const space = `/api/wiki/spaces/${SPACE_ID}`;
  if (method !== 'GET') {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    writes.push({ method, path, body });
    if (path.endsWith('/turns/current-work-routing')) {
      if (sendFails === 'network') throw new TypeError('Failed to fetch');
      if (sendFails) return reply(sendFails.status, sendFails.body);
      return reply(201, { turnId: 'T2', seq: 2, kind: 'message', placement: 'accepted' });
    }
    if (path === '/api/wiki/chat-drafts/D1/apply') {
      theCard = { ...theCard, state: 'applied', decision: 'applied', undoable: true };
      return reply(200, { replayed: false, draft: theCard });
    }
    return reply(200, { ok: true });
  }
  if (path === '/api/wiki/spaces') return reply(200, [spaceRow, ...others]);
  if (path === space) return reply(200, spaceRow);
  if (path === `${space}/chats`) return reply(200, chats);
  if (path === '/api/wiki/chats/S1chat/drafts') return reply(200, { sessionId: 'S1chat', drafts: [theCard] });
  if (path === '/api/wiki/chat-drafts/D1') return reply(200, theCard);
  if (path === `${space}/docs`) return reply(200, SHARED.docs.directory.read);
  if (path === `${space}/docs/session-runtime`) return reply(200, DOC);
  if (path === `${space}/docs/session-runtime/sections/s7/versions`) return reply(200, { spaceId: SPACE_ID, slug: 'session-runtime', key: 's7', versions: VERSIONS_S7 });
  if (path === `${space}/doc-changes`) return reply(200, { spaceId: SPACE_ID, changes: docChanges });
  if (path === `${space}/entries`) return reply(200, []);
  if (path === `${space}/timeline`) return reply(200, { items: [] });
  if (path === '/api/wiki/review') return reply(200, []);
  if (path === '/api/sessions/S1chat') return reply(200, session);
  if (path === '/api/workspaces') return reply(200, [{ id: 'w1', name: 'orbit-develop', runnerId: 'r1', provider: null, model: null }]);
  if (path === '/api/runners') return reply(200, [{ id: 'r1', name: 'hpc-01', displayName: 'HPC', online: true }]);
  if (path === '/api/providers') return reply(200, []);
  if (path === '/api/users/me') return reply(200, { id: 'u1', preferences: { defaultPermissionMode: 'default' } });
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;
let storage: { local: Map<string, string>; session: Map<string, string> };
let scrolled: string[];

const store = (items: Map<string, string>) => ({
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  spaceRow = { ...SPACE };
  others = [];
  chats = {
    spaceId: SPACE_ID,
    workspace: { ...DEVELOP, eligible: true },
    choices: [DEVELOP],
    fab: { needsYou: 0, working: false, updated: 0 },
    chats: [{ sessionId: 'S1chat', title: 'Runner offline: why three heartbeats', status: 'AWAITING_INPUT', open: true, createdAt: '', updatedAt: '', drafts: 1, needsYou: 1 }],
  };
  theCard = card();
  session = {
    id: 'S1chat', title: 'Runner offline: why three heartbeats', runState: 'AWAITING_INPUT', status: 'AWAITING_INPUT',
    workspace: { id: 'w1', name: 'orbit-develop' }, assignedRunnerId: 'r1', engine: 'claude', provider: 'claude',
    model: 'claude-opus-5-5', permissionMode: 'default', wikiChatSpaceId: SPACE_ID,
  };
  docChanges = [];
  writes = [];
  sendFails = null;
  stream.events = DRAFTING;
  stream.approvals = [];
  stream.idle = true;
  // The panel as these cases knew it: hidden until the button opens it. Board 45 opens it by default where it docks
  // unless the owner hid it with ✕, which is what this says; the cases of board 45 below take it out.
  storage = { local: new Map([['orbit.wikiChat.closed', JSON.stringify({ orbit: true })]]), session: new Map() };
  scrolled = [];
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1500 });
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', store(storage.local));
  vi.stubGlobal('sessionStorage', store(storage.session));
  vi.stubGlobal('fetch', vi.fn(serve));
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this.getAttribute('data-draft') ?? this.id ?? this.tagName);
  };
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
  for (let tick = 0; tick < 12; tick += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function Where() {
  const location = useLocation();
  return <output data-where={`${location.pathname}${location.search}${location.hash}`} />;
}

async function open(path: string): Promise<void> {
  act(() => root.unmount());
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/wiki/:space" element={<WikiPage route="home" />} />
            <Route path="/wiki/:space/activity" element={<WikiPage route="activity" />} />
            <Route path="/wiki/:space/d/:doc" element={<WikiPage route="doc" />} />
            <Route path="/wiki/:space/settings" element={<WikiPage route="settings" />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-panel');
const text = (node: Element | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const buttonIn = (scope: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((button) => text(button) === label);
async function press(node: Element | null | undefined): Promise<void> {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
}
/** The panel's composer's field: the session page's composer (board 43). */
const field = (): HTMLTextAreaElement | null => document.querySelector<HTMLTextAreaElement>('.wk-chat-composer .composer-field textarea');
const sendButton = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-composer [aria-label="Send"]');
async function type(value: string): Promise<void> {
  const area = field()!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const marked = (): string[] =>
  [...document.querySelectorAll('.wk-dc-would')].map((node) => node.closest('section')?.getAttribute('data-section') ?? '');

describe('a card in the panel, and the page beside it (board 42 ②)', () => {
  it('draws the card its agent’s drafting call made, marks the sections it would rewrite, and opens them beside the chat', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=S1chat');
    const drawn = panel()!.querySelector('.wk-draft[data-draft="D1"]');
    expect(drawn).toBeTruthy();
    expect(text(drawn!.querySelector('.wk-draft-k'))).toBe('Draft · Add decision');
    // The call itself is the card: no tool row stands for it.
    expect(panel()!.querySelectorAll('.chat-tool-card')).toHaveLength(0);
    // Before the press, the left marks the section the card would rewrite, and only it.
    expect(marked()).toEqual(['s3']);
    expect(text(document.querySelector('section[data-section="s3"] .wk-dc-would-tag'))).toBe('Draft would rewrite this section');
    // The composer asks for a reply to the draft while it is open.
    expect(field()!.getAttribute('placeholder')).toBe('Reply, or say what to change in the draft');

    // A Rewrites section opens on the left, the chat staying beside it.
    await press(buttonIn(drawn!, '3.1 §2'));
    expect(where()).toBe('/wiki/orbit/d/session-runtime?chat=S1chat#sec-s3');
    expect(panel()).toBeTruthy();
  });

  it('takes the mark away once the card is pressed, and the composer’s words go back', async () => {
    await open('/wiki/orbit/d/session-runtime?chat=S1chat');
    await press(buttonIn(panel()!, 'Apply'));
    expect(writes.map((write) => write.path)).toEqual(['/api/wiki/chat-drafts/D1/apply']);
    expect(text(panel()!.querySelector('.wk-draft-k'))).toBe('Applied · Confirmed by you');
    expect(marked()).toEqual([]);
    expect(field()!.getAttribute('placeholder')).toBe('Ask about this page, or say what should change');
  });

  it('opens at the card that needs the owner when the round button opens the chat (design §3)', async () => {
    chats = { ...chats, fab: { needsYou: 1, working: false, updated: 0 } };
    await open('/wiki/orbit/d/session-runtime');
    await press(document.querySelector('.wk-chat-fab'));
    expect(where()).toBe('/wiki/orbit/d/session-runtime?chat=S1chat');
    expect(scrolled).toContain('D1');
    expect(panel()!.querySelector('.wk-draft-card')!.className).toContain('focus');
  });
});

describe('a section written since the reader last looked (board 42 ③, contract `docs.versions.reads.doc`)', () => {
  it('wears Updated, which opens See changes; the sentences the write added are lined green; an older write is not news', async () => {
    storage.local.set(wikiSeenKey('orbit', 'doc:session-runtime'), String(LOOKED));
    await open('/wiki/orbit/d/session-runtime');
    const updated = [...document.querySelectorAll('.wk-dc-upd')].map((node) => node.closest('section')?.getAttribute('data-section'));
    expect(updated).toEqual(['s7']);
    expect(text(document.querySelector('section[data-section="s7"] h2 .wk-dc-upd'))).toBe('Updated');
    // The new sentence, lined green; the others as they were.
    const lined = [...document.querySelectorAll('.wk-newline')].map((node) => node.getAttribute('data-wk-sid'));
    const addedId = S7.blocks[0]!.sentences.find((sentence) => sentence.text === ADDED)!.id;
    expect(lined).toEqual([addedId]);

    await press(document.querySelector('section[data-section="s7"] .wk-dc-upd'));
    const see = document.querySelector('section[data-section="s7"] .wk-dc-see')!;
    expect(text(see.querySelector('.wk-see-h'))).toBe('See changes · 3.1 §3');
    expect(text(see.querySelector('.wk-see-cause'))).toMatch(/^After chat Runner offline: why three heartbeats · 1 sentence changed · /u);
    expect([...see.querySelectorAll('.wk-see-rows > div')].map((row) => [row.className, row.textContent])).toEqual([
      ['wk-see-del', 'The merge was always refused as superseded.'],
      ['wk-see-ins', ADDED],
    ]);
    // Leaving moves the stamp: what was seen is not news the next time.
    act(() => root.unmount());
    root = createRoot(container);
    expect(Number(storage.local.get(wikiSeenKey('orbit', 'doc:session-runtime')))).toBeGreaterThan(Date.parse(AFTER_LOOK));
  });

  it('counts a first look from the moment the page opened', async () => {
    await open('/wiki/orbit/d/session-runtime');
    expect(document.querySelectorAll('.wk-dc-upd')).toHaveLength(0);
  });
});

describe('Activity (contract `docs.versions.reads.changes`, `chat.waiting`)', () => {
  it('lists the Docs rows of Recently changed, each opening its section and its See changes; a follow job’s leftover in grey', async () => {
    docChanges = [
      { kind: 'section', doc: 'session-runtime', key: 's7', where: '3.1 §3', title: 'Known pitfalls', versionId: 'V7', reason: { kind: 'chat', title: 'Runner offline: why three heartbeats' }, at: AFTER_LOOK, changed: 1 },
      { kind: 'left', jobId: 'J2', at: BEFORE_LOOK, left: 6 },
    ];
    await open('/wiki/orbit/activity');
    const rows = [...document.querySelectorAll('.wk-changed-card .wk-tl-doc')];
    expect(rows.map((row) => text(row.querySelector('.wk-tl-h b')))).toEqual(['Docs', 'Docs']);
    expect(text(rows[0]!.querySelector('.wk-tl-t'))).toBe('3.1 §3 rewritten · after chat Runner offline: why three heartbeats · 1 sentence changed');
    expect(rows[0]!.querySelector('.wk-tl-t a')!.getAttribute('href')).toBe('/wiki/orbit/d/session-runtime#sec-s7');
    expect(text(rows[0]!.querySelector('.wk-tl-n'))).toBe('Known pitfalls');
    expect(text(rows[1]!.querySelector('.wk-tl-t'))).toBe('6 sections left for the next maintenance run');
    expect(rows[1]!.className).toContain('left');
    expect(rows[1]!.querySelector('button')).toBeNull();

    await press(buttonIn(rows[0]!, 'See changes'));
    expect([...rows[0]!.querySelectorAll('.wk-see-rows > div')].map((row) => row.className)).toEqual(['wk-see-del', 'wk-see-ins']);
  });

  it('counts the chat’s rewrites that wait in W, draws them as one amber banner, and opens the chat at the first of them', async () => {
    spaceRow = { ...SPACE, chatWaiting: 1 };
    chats = { ...chats, fab: { needsYou: 1, working: false, updated: 0 } };
    theCard = card({
      state: 'applied',
      decision: 'applied',
      undoable: true,
      rewrite: {
        jobId: 'J1', result: 'waiting', reason: 'maintenance_running', sha: null, seen: false, settledAt: null,
        sections: [{ doc: 'session-runtime', key: 's3', where: '3.1 §2', result: null, changed: null, versionId: null }],
      },
    });
    await open('/wiki/orbit/activity');
    const banner = document.querySelector('a.wk-banner.wk-chat-banner')!;
    expect(text(banner.querySelector('.t'))).toBe('1 rewrite needs you');
    expect(banner.getAttribute('data-waiting')).toBe('1');
    // W, on the head's Activity badge: the chat's rewrite with the space's proposals and plan (none here).
    expect(text(document.querySelector('.wk-activity-btn .tp-rail-badge'))).toBe('1');

    await press(banner);
    expect(where()).toBe('/wiki/orbit/activity?chat=S1chat');
    expect(text(panel()!.querySelector('.wk-draft-result > .t'))).toBe('Rewrite waiting · Maintenance is running');
    expect(scrolled).toContain('D1');
  });

  it('says another space’s waiting rewrites with its name, opening that space’s Activity; adds nothing when none wait', async () => {
    await open('/wiki/orbit/activity');
    expect(document.querySelector('.wk-chat-banner')).toBeNull();
    expect(document.querySelector('.wk-activity-btn .tp-rail-badge')).toBeNull();

    others = [{ ...SPACE, id: '0196f000-0000-7000-8000-000000000002', slug: 'wikova', title: 'wikova', repoUrlNorm: 'github.com/jianghailong-xy/wikova', chatWaiting: 2 }];
    await open('/wiki/orbit/activity');
    const banner = document.querySelector('a.wk-banner.wk-chat-banner.elsewhere')!;
    expect(text(banner.querySelector('.t'))).toBe('2 rewrites need you · in wikova');
    expect(banner.getAttribute('data-waiting')).toBe('2');
    expect(banner.getAttribute('href')).toBe('/wiki/wikova/activity');
    expect(document.querySelectorAll('.wk-chat-banner')).toHaveLength(1);
    expect(text(document.querySelector('.wk-activity-btn .tp-rail-badge'))).toBe('2');
  });
});

describe('the C8 review’s three', () => {
  it('says a chat that ended takes no more messages, and offers a new one', async () => {
    session = { ...session, runState: 'COMPLETED', status: 'COMPLETED' };
    await open('/wiki/orbit?chat=S1chat');
    expect(field()).toBeNull();
    expect(text(document.querySelector('.wk-chat-ended .t'))).toBe('This chat has ended, so it takes no more messages. Start a new chat to keep going.');
    await press(document.querySelector('.wk-chat-ended-new'));
    expect(where()).toBe('/wiki/orbit?chat=new');
    expect(field()).toBeTruthy();
  });

  it('says a chat in Trash takes no more messages either', async () => {
    session = { ...session, deletedAt: '2026-11-06T12:00:00.000Z' };
    await open('/wiki/orbit?chat=S1chat');
    expect(text(document.querySelector('.wk-chat-ended .t'))).toBe('This chat is in Trash, so it takes no more messages. Start a new chat to keep going.');
  });

  it('says why a message did not go: the server’s refusal in its words, and the connection only when there was none', async () => {
    await open('/wiki/orbit?chat=S1chat');
    const failure = () => text(document.querySelector('.wk-chat-failed'));
    sendFails = { status: 409, body: { statusCode: 409, message: 'The workspace turned its worktrees off: a wiki chat needs one of its own.' } };
    await type('Why three?');
    await press(sendButton());
    expect(failure()).toBe('Not sent: The workspace turned its worktrees off: a wiki chat needs one of its own.');
    expect(failure()).not.toMatch(/connection/u);

    sendFails = {
      status: 400,
      body: { code: 'WIKI_SCHEMA', message: 'wikiContext is { page?, selection? }', errors: [{ path: 'wikiContext.selection.sentenceIds', message: 'x' }] },
    };
    await press(sendButton());
    expect(failure()).toBe('The attachments weren’t taken: wikiContext is { page?, selection? }. Remove them and send again.');

    sendFails = 'network';
    await press(sendButton());
    expect(failure()).toBe('The message couldn’t be sent. Check the connection, then try again.');
    // The words stay for the next try.
    expect(field()!.value).toBe('Why three?');
  });

  it('floats Ask above the first line of what is lit, centred on it, never on the text (board 42 ①)', async () => {
    await open('/wiki/orbit/d/session-runtime');
    const article = document.querySelector<HTMLElement>('.wk-dc-page')!;
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    article.getBoundingClientRect = () => box(100, 50, 700, 900);
    // The snap starts a line above the selection: the first sentence's first line is at 300, the selection's at 330.
    const first = document.querySelector<HTMLElement>('[data-wk-sid="s1-0-0"]')!;
    first.getClientRects = () => [box(420, 300, 380, 24), box(100, 330, 200, 24)] as unknown as DOMRectList;
    const range = document.createRange();
    const node = (id: string) => document.createTreeWalker(document.querySelector(`[data-wk-sid="${id}"]`)!, NodeFilter.SHOW_TEXT).nextNode() as Text;
    range.setStart(node('s1-0-0'), 20);
    range.setEnd(node('s1-0-1'), 2);
    range.getClientRects = () => [box(500, 330, 100, 24)] as unknown as DOMRectList;
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    await settle();
    const ask = document.querySelector<HTMLElement>('.wk-chat-ask')!;
    // Its foot sits on the first lit line's top (the stylesheet lifts it by its height and 10 more): 300 − 50.
    expect(ask.style.top).toBe('250px');
    // Centred over that line: 420 + 380 / 2 − 100.
    expect(ask.style.left).toBe('510px');
  });

  it('keeps Ask inside the article when the first line runs to its edge', async () => {
    await open('/wiki/orbit/d/session-runtime');
    const article = document.querySelector<HTMLElement>('.wk-dc-page')!;
    const box = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    article.getBoundingClientRect = () => box(100, 50, 700, 900);
    document.querySelector<HTMLElement>('[data-wk-sid="s1-0-0"]')!.getClientRects = () => [box(780, 300, 20, 24)] as unknown as DOMRectList;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-wk-sid="s1-0-0"]')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await act(async () => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
    await settle();
    expect(document.querySelector<HTMLElement>('.wk-chat-ask')!.style.left).toBe(`${700 - 48}px`);
  });
});
