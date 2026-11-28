// @vitest-environment jsdom
// The days (Today, Yesterday) are the browser's: held to UTC so the captured times fall on the same days everywhere.
process.env.TZ = 'UTC';
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

const uploadCalls: Array<[string, string]> = [];
let heldUploads: unknown[] = [];
vi.mock('../lib/driveUploads', async (original) => ({
  ...(await original<typeof import('../lib/driveUploads')>()),
  useDriveUploads: () => ({ uploads: heldUploads, completed: 0 }),
  resumeUpload: (key: string) => (uploadCalls.push(['resume', key]), null),
  pauseUpload: (key: string) => void uploadCalls.push(['pause', key]),
  cancelUpload: (key: string) => void uploadCalls.push(['cancel', key]),
}));

const { DrivePage } = await import('./DrivePage');

/**
 * The Drive chat (board docs/mocks/drive-chat/01-board.html ② ⑤, owner Q1 A and Q3 A) on the real Drive page over a fake
 * API: the Wiki's chat host, open by default as the right-hand panel at ≥ 1200 on the chat that needs the owner, else
 * the most recent open one, else New chat; ✕ remembered per account on this device until Agents is pressed;
 * the button's four looks; a new chat's Runs in with the server's default workspace, gone once the first message went;
 * the folder open as a removable chip `Folder · <name>`; and the history of Drive chats.
 */


import activityJson from '../components/drive/__captured__/activity.json';
import syncsJson from '../components/drive/__captured__/syncs.json';
import chatsJson from '../components/drive/__captured__/chats.json';
import groupsJson from '../components/drive/__captured__/groups.json';

/**
 * The activity icon in the Drive chat panel and the view it shows (board drive-web 01 ④⑤). Every server answer is a
 * payload captured from a local apiserver on PostgreSQL (`__captured__/`, seeded through the runner door and the
 * sessions' own tables): GET /drive/activity, /drive/syncs, /drive/chats and /drive/chats/:id/groups. The page is the real
 * Drive page; only the network is a fake that serves those payloads and records what is written.
 */

const AT = '2026-11-28T01:00:00.000Z';
const CHAT = chatsJson.chats[0]!.sessionId;
const [DONE_GROUP, HELD_GROUP] = groupsJson.groups as Array<{ id: string }>;
// The list as the server sends it (drive-sync-fix.pg.spec.ts writes it): newest first, so the first books-stage is the
// failure still waiting on the owner; its session can take a turn. photos-stage's session has ended; covers-stage was
// handed to its session, which asks a question; anime-stage's session is working on it.
const FAILED_SYNC = syncsJson.syncs.find((s) => s.sourceName === 'books-stage')!;
const ENDED_SYNC = syncsJson.syncs.find((s) => s.sourceName === 'photos-stage')!;
const ASKING_SYNC = syncsJson.syncs.find((s) => s.sourceName === 'covers-stage')!;
const FIX_SYNC = syncsJson.syncs.find((s) => s.sourceName === 'anime-stage')!;
const TRASH_GROUP = activityJson.groups.flatMap((g) => g.lines).find((l) => l.undo?.kind === 'TRASH_GROUP')!.undo!.id;

const folders: Record<string, { id: string; parentId: string | null; name: string }> = { root: { id: 'root', parentId: null, name: '' } };
const entryView = (f: { id: string; parentId: string | null; name: string }) => ({
  id: f.id, parentId: f.parentId, kind: 'FOLDER', name: f.name, sizeBytes: 0, mtime: AT, currentVersionId: null, seq: 1,
  createdAt: AT, updatedAt: AT, lastWriter: { kind: 'OWNER', sessionId: null, runnerId: null, at: AT }, trashedAt: null, trashGroupId: null,
});

let writes: Array<{ method: string; path: string; body?: unknown }>;
/** What POST /drive/syncs/:id/fix answers; a test that holds it sets a promise here. */
let fixAnswer: (id: string) => Promise<Response>;
let syncs: typeof syncsJson.syncs;
let client: QueryClient;
let container: HTMLDivElement;
let root: Root;
let local: Map<string, string>;

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const [path, query = ''] = url.split('?') as [string, string?];
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    writes.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const fix = /^\/api\/drive\/syncs\/([^/]+)\/fix$/.exec(path);
    if (fix) return fixAnswer(fix[1]!);
    const handled = /^\/api\/drive\/syncs\/([^/]+)\/handled$/.exec(path);
    if (handled) {
      syncs = syncs.map((s) => (s.id === handled[1] ? { ...s, handledAt: AT } : s));
      return reply(200, syncs.find((s) => s.id === handled[1]));
    }
    return reply(200, { ok: true });
  }
  if (path === '/api/drive/entries') return reply(200, { folder: entryView(folders.root!), entries: [], nextCursor: null });
  if (path === '/api/drive/entries/root') return reply(200, { ...entryView(folders.root!), path: '/' });
  if (path === '/api/drive/chats') return reply(200, { ...chatsJson, workspace: null });
  if (path === '/api/drive/activity') return reply(200, activityJson);
  if (path === '/api/drive/syncs') return reply(200, { syncs });
  if (path === `/api/drive/chats/${CHAT}/groups`) return reply(200, groupsJson);
  if (path === `/api/drive/chats/${CHAT}/questions`) return reply(200, { questions: [] });
  if (path === '/api/share-links') return reply(200, { links: [] });
  if (path === '/api/users/me') return reply(200, { id: 'u1', preferences: { defaultPermissionMode: 'default' } });
  if (path === '/api/workspaces' || path === '/api/runners' || path === '/api/providers') return reply(200, []);
  const session = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (session) {
    return reply(200, {
      id: session[1], title: 'Tidy up Books', runState: 'AWAITING_INPUT', status: 'AWAITING_INPUT', workspace: { id: 'w', name: 'Orbit Cloud' },
      assignedRunnerId: 'r', engine: 'claude', provider: 'claude', model: 'claude-opus-5-5', permissionMode: 'default',
    });
  }
  return reply(404, { message: `${url} is not in this fixture` });
}

const store = (items: Map<string, string>) => ({
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
  removeItem: (key: string) => void items.delete(key),
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-28T04:00:00Z') });
  writes = [];
  uploadCalls.length = 0;
  heldUploads = [];
  syncs = structuredClone(syncsJson.syncs);
  fixAnswer = async (id) => {
    // As the server answers a hand-off to the sync's own session: the row now reads as anime-stage's, working.
    syncs = syncs.map((s) => (s.id === id ? { ...s, fixSessionId: s.session!.id, fixRequestedAt: AT, fix: { ...FIX_SYNC.fix!, title: s.session!.title } } : s));
    const sync = syncs.find((s) => s.id === id)!;
    return reply(200, { via: 'SESSION', sessionId: sync.session!.id, sync });
  };
  local = new Map();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('localStorage', store(local));
  vi.stubGlobal('sessionStorage', store(new Map()));
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
  vi.useRealTimers();
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

async function open(path = '/drive'): Promise<void> {
  const { resetDriveSyncs } = await import('../lib/driveSyncs');
  resetDriveSyncs();
  act(() => root.unmount());
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/drive" element={<DrivePage />} />
            <Route path="/sessions/:id" element={<div className="session-page" />} />
          </Routes>
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const where = (): string | null => container.querySelector('output')?.getAttribute('data-where') ?? null;
const icon = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.wk-chat-head .files-activity');
const view = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="drive-activity"]');
const composer = (): HTMLElement | null => document.querySelector<HTMLElement>('.wk-chat-composer');
const headings = (): string[] => [...document.querySelectorAll('.drive-act-h')].map((h) => h.textContent ?? '');
const button = (within: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const press = async (node: Element | null | undefined): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};
const section = (name: string): HTMLElement => document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;

describe('the activity icon in the panel header', () => {
  it('carries the Agents button\'s count: one held group and three failed syncs no agent is working on', async () => {
    await open();
    const agents = document.querySelector('.files-head-actions .files-agents-count');
    expect(agents?.textContent, 'anime-stage, scans and exports have agents on them; covers-stage asks the owner').toBe('4');
    expect(icon()?.querySelector('.files-activity-count')?.textContent).toBe('4');
    expect(icon()?.getAttribute('aria-label')).toBe('Show activity');
    expect(icon()?.getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles between the chat and the activity view, and remembers the view on this browser', async () => {
    await open();
    expect(composer(), 'the chat shows first').not.toBeNull();
    expect(view()).toBeNull();

    await press(icon());
    expect(view()).not.toBeNull();
    expect(document.querySelector('.wk-chat-title .t')?.textContent).toBe('Activity');
    expect(document.querySelector('.wk-chat-main')?.hasAttribute('hidden'), 'no chat box in the log').toBe(true);
    expect(icon()?.getAttribute('aria-pressed')).toBe('true');
    expect(local.get('orbit:drive-panel-view')).toBe('activity');

    await open();
    expect(view(), 'a reload comes back to the activity view').not.toBeNull();

    await press(icon());
    expect(view()).toBeNull();
    expect(document.querySelector('.wk-chat-main')?.hasAttribute('hidden')).toBe(false);
    expect(local.get('orbit:drive-panel-view')).toBe('chat');
  });
});

describe('the activity view', () => {
  it('lists Needs you, Agents working on it, Running, then the days, in that order', async () => {
    heldUploads = [{
      key: 'up-1', name: 'a.zip', size: 1000, lastModified: 0, parentId: 'other', parentName: 'Elsewhere', relativePath: null, dropKey: null,
      uploadId: 'u', sentBytes: 400, status: 'uploading', error: null, rate: null, entryId: null, file: null,
    }];
    await open();
    await press(icon());
    expect(headings()).toEqual(['Needs you', 'Agents working on it', 'Running', 'Today', 'Yesterday']);

    const needs = section('Needs you');
    expect(needs.textContent).toContain('2 changes waiting for Apply');
    expect(needs.textContent).toContain('books-stage → /Books');
    expect(needs.textContent).toContain('4 failed');
    expect(needs.textContent).toContain('0412/scan.tiff');
    expect(needs.textContent).toContain('file changed while reading');
    expect(needs.textContent).toContain('2 more');
    expect(needs.textContent).not.toContain('anime-stage');

    const working = section('Agents working on it');
    expect(working.textContent).toContain('anime-stage → /Video');
    expect(working.textContent).toContain('Fixing 3 failed files');
    expect(working.textContent).toContain('Sync the anime');

    const running = section('Running');
    expect(running.textContent).toContain('live → /Live');
    expect(running.querySelectorAll('[role="progressbar"]').length).toBe(2);
    expect(running.textContent).toContain('a.zip');
    expect(running.textContent).toContain('Elsewhere');

    expect(section('Today').textContent).toContain('Renamed 3 files in Books');
    expect(section('Today').textContent).toContain('Wrote 2 files in Reports');
    expect(section('Yesterday').textContent).toContain('Synced 11,267 files in Books');
    expect(section('Today').textContent, 'held lines are in Needs you, not the day').not.toContain('Renamed 2 files');
  });

  it('Review in chat opens that chat and Undo undoes the held group', async () => {
    await open();
    await press(icon());
    const held = document.querySelector<HTMLElement>(`[data-group="${HELD_GROUP!.id}"]`)!;
    await press(button(held, 'Undo'));
    expect(writes).toContainEqual({ method: 'POST', path: `/api/drive/chats/${CHAT}/groups/${HELD_GROUP!.id}/undo` });

    await press(button(held, 'Review in chat'));
    expect(where()).toBe(`/drive?chat=${CHAT}`);
    expect(view(), 'back on the chat').toBeNull();
    expect(local.get('orbit:drive-panel-view')).toBe('chat');
  });

  it('Clear marks a failed sync handled, and the row leaves', async () => {
    await open();
    await press(icon());
    const row = document.querySelector<HTMLElement>(`[data-sync="${FAILED_SYNC.id}"]`)!;
    await press(button(row, 'Clear'));
    expect(writes).toContainEqual({ method: 'POST', path: `/api/drive/syncs/${FAILED_SYNC.id}/handled` });
    expect(document.querySelector(`section[aria-label="Needs you"] [data-sync="${FAILED_SYNC.id}"]`)).toBeNull();
    expect(icon()?.querySelector('.files-activity-count')?.textContent).toBe('3');
  });

  it('the hand-off button reads by whether the sync\'s session can take a turn', async () => {
    await open();
    await press(icon());
    const own = document.querySelector<HTMLElement>(`section[aria-label="Needs you"] [data-sync="${FAILED_SYNC.id}"]`)!;
    expect(button(own, 'Have the agent fix it'), 'its session can take a turn').toBeTruthy();
    expect(button(own, 'Fix in a new chat')).toBeUndefined();
    const ended = document.querySelector<HTMLElement>(`section[aria-label="Needs you"] [data-sync="${ENDED_SYNC.id}"]`)!;
    expect(button(ended, 'Fix in a new chat'), 'its session has ended').toBeTruthy();
    expect(button(ended, 'Have the agent fix it')).toBeUndefined();
    expect(ended.textContent).toContain('the session has ended');
  });

  it('Have the agent fix it moves the row under Agents working on it at once, and the count drops', async () => {
    let answer!: () => void;
    const held = new Promise<void>((resolve) => (answer = resolve));
    const served = fixAnswer;
    fixAnswer = async (id) => {
      await held;
      return served(id);
    };
    await open();
    await press(icon());
    const row = document.querySelector<HTMLElement>(`section[aria-label="Needs you"] [data-sync="${FAILED_SYNC.id}"]`)!;
    await press(button(row, 'Have the agent fix it'));
    expect(writes).toContainEqual({ method: 'POST', path: `/api/drive/syncs/${FAILED_SYNC.id}/fix`, body: { mode: 'fix' } });
    expect(document.querySelector(`section[aria-label="Needs you"] [data-sync="${FAILED_SYNC.id}"]`), 'left Needs you before the answer').toBeNull();
    const moved = section('Agents working on it').querySelector<HTMLElement>(`[data-sync="${FAILED_SYNC.id}"]`);
    expect(moved?.textContent).toContain('Fixing 4 failed files');
    expect(icon()?.querySelector('.files-activity-count')?.textContent).toBe('3');

    answer();
    await settle();
    const after = section('Agents working on it').querySelector<HTMLElement>(`[data-sync="${FAILED_SYNC.id}"]`)!;
    expect(after.textContent).toContain('Sync the books');
    await press(button(after, 'Open session ›'));
    expect(where()).toBe(`/sessions/${FAILED_SYNC.session!.id}`);
  });

  it('a refused hand-off puts the row back under Needs you', async () => {
    fixAnswer = async () => reply(409, { code: 'DRIVE_SYNC_HANDLED', message: "This sync's failures have been handled." });
    await open();
    await press(icon());
    const row = document.querySelector<HTMLElement>(`[data-sync="${ENDED_SYNC.id}"]`)!;
    await press(button(row, 'Fix in a new chat'));
    expect(writes).toContainEqual({ method: 'POST', path: `/api/drive/syncs/${ENDED_SYNC.id}/fix`, body: { mode: 'fix' } });
    expect(section('Needs you').querySelector(`[data-sync="${ENDED_SYNC.id}"]`)).not.toBeNull();
    expect(icon()?.querySelector('.files-activity-count')?.textContent).toBe('4');
  });

  it('Retry failed hands the failures off too, asking only for a resync', async () => {
    await open();
    await press(icon());
    const row = document.querySelector<HTMLElement>(`[data-sync="${FAILED_SYNC.id}"]`)!;
    await press(button(row, 'Retry failed'));
    expect(writes).toContainEqual({ method: 'POST', path: `/api/drive/syncs/${FAILED_SYNC.id}/fix`, body: { mode: 'retry' } });
    expect(section('Agents working on it').querySelector(`[data-sync="${FAILED_SYNC.id}"]`)).not.toBeNull();
  });

  it('a hand-off whose agent asks something is back under Needs you with its question and Answer in session', async () => {
    await open();
    await press(icon());
    const row = section('Needs you').querySelector<HTMLElement>(`[data-sync="${ASKING_SYNC.id}"]`)!;
    expect(row.textContent).toContain('The agent needs you: 0977/cover.png is owned by root. Allow sudo?');
    expect(button(row, 'Have the agent fix it'), 'answered in the session, not handed off again').toBeUndefined();
    await press(button(row, 'Answer in session'));
    expect(where()).toBe(`/sessions/${ASKING_SYNC.fixSessionId}`);
  });

  it('Undo a chat\'s change group and Restore a deletion call the routes that take them', async () => {
    await open();
    await press(icon());
    const today = section('Today');
    const lineOf = (text: string) => [...today.querySelectorAll<HTMLElement>('.drive-act-line')].find((l) => l.textContent?.includes(text))!;
    expect(button(lineOf('Wrote 2 files'), 'Undo'), 'plain writes have no undo').toBeUndefined();

    await press(button(lineOf('Renamed 3 files'), 'Undo'));
    expect(writes).toContainEqual({ method: 'POST', path: `/api/drive/chats/${CHAT}/groups/${DONE_GROUP!.id}/undo` });

    await press(button(lineOf('Deleted 2 files'), 'Restore'));
    expect(writes).toContainEqual({ method: 'POST', path: `/api/drive/trash/groups/${TRASH_GROUP}/restore` });
  });

  it('heads each group by its session: Open chat for a Drive chat, Open session otherwise', async () => {
    await open();
    await press(icon());
    const heads = [...section('Today').querySelectorAll<HTMLElement>('.drive-act-ghead')];
    const chatHead = heads.find((h) => h.textContent?.includes('Tidy up Books'))!;
    const sessionHead = heads.find((h) => h.textContent?.includes('Write the quarterly report'))!;
    expect(button(sessionHead, 'Open chat ›')).toBeUndefined();
    await press(button(sessionHead, 'Open session ›'));
    expect(where()).toMatch(/^\/sessions\//);
    await open();
    expect(view(), 'the activity view is remembered across the page change').not.toBeNull();
    const again = [...section('Today').querySelectorAll<HTMLElement>('.drive-act-ghead')].find((h) => h.textContent?.includes('Tidy up Books'))!;
    expect(button(again, 'Open chat ›')).toBeTruthy();
    expect(chatHead).toBeTruthy();
    await press(button(again, 'Open chat ›'));
    expect(where()).toBe(`/drive?chat=${CHAT}`);
  });

  it('Running carries the pending controls for an upload into another folder: a paused one is resumed from here', async () => {
    heldUploads = [{
      key: 'up-paused', name: 'big.iso', size: 2000, lastModified: 0, parentId: 'other', parentName: 'Elsewhere', relativePath: 'Pack/sub/big.iso',
      dropKey: 'd', uploadId: 'u', sentBytes: 500, status: 'paused', error: null, rate: null, entryId: null, file: null,
    }];
    await open();
    await press(icon());
    const row = document.querySelector<HTMLElement>('[data-upload="up-paused"]')!;
    expect(row.textContent).toContain('Pack/sub/big.iso');
    expect(row.textContent).toContain('Paused · 25%');
    await press(button(row, 'Resume'));
    expect(uploadCalls).toContainEqual(['resume', 'up-paused']);
    await press(button(row, 'Cancel'));
    expect(uploadCalls).toContainEqual(['cancel', 'up-paused']);
  });
});
