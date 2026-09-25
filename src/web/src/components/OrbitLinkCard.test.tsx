// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkPreview } from '@orbit/shared';
import {
  OrbitLinkCard,
  OrbitLinkCardsProvider,
  orbitLinkLastRun,
  orbitLinkProgressLine,
  orbitLinkRuns,
  orbitLinkStalled,
  orbitLinkTurns,
} from './OrbitLinkCard';
import { Transcript, type RunEvent } from './Transcript';
import { statusLabel } from './WorkspaceView';
import { SharedSessionPage } from '../pages/SharedSessionPage';
import type { OrbitLinkKind, OrbitLinkRef } from '../lib/orbitLink';
import { decodeId } from '../lib/idCodec';

// The export inlines its stylesheets through Vite's `?raw`, and a worktree cannot read one of them
// (it lives in node_modules, outside this checkout's root). What this case is about is the markup
// the export renders, not the CSS it carries, so the stylesheet is stubbed here rather than the
// export being tested through a copy of itself.
vi.mock('highlight.js/styles/github.css?raw', () => ({ default: '' }));

/**
 * The cards an Orbit link becomes in a conversation — the four contents, the two states with
 * nothing to show, and the two places that must NOT draw one.
 *
 * Which links are read, and where a card stands, is proved in lib/orbitLink.test.ts against the
 * fixture both clients share. What this file is about is what reaches the page: a card per object,
 * its words, its click, and the one request a conversation view makes for every link it is showing
 * — and the shared page and the exported file, where no card is drawn and no card data is asked
 * for at all.
 *
 * `fetch` is stubbed rather than the api module, so what the positive case asserts is the REQUEST
 * that leaves the client: one POST carrying every link of the conversation.
 */

const HOST = 'localhost:3000';
const BASE = `http://${HOST}`;
const TASK = '34TcwNgAIo6tGUiIKjqnQ';
const SESSION = '34TYUP5wb87XfuYCInJRY';
const PROJECT = '34Tcl0kralZrY8opuLJU4';
const LIST = '347en66xizlGSG9a6Nej5';
const AT = '2026-09-23T12:00:00.000Z';

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

const okJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as unknown as Response;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // Node ships a shadowing `localStorage`, and `api` reads the bearer token off it before every
  // request.
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  fetchMock = vi.fn(async () => okJson({ previews: [] }));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** A link as the plugin hands one over: the object it names, and the text it replaced. */
function link(kind: OrbitLinkKind, publicId: string, url: string): OrbitLinkRef {
  return { target: { kind, id: decodeId(publicId) as string }, source: { kind: 'url', url } };
}

const previews = {
  task: (over: Record<string, unknown> = {}): LinkPreview => ({
    kind: 'task',
    id: TASK,
    state: 'ok',
    task: {
      title: 'runner + web：配额按账户归属',
      status: 'DONE',
      running: false,
      queued: false,
      project: { id: PROJECT, title: 'Codex 多账户：一台机器上登录多个 Codex' },
      assignee: { id: 'w', name: 'orbit' },
      runs: 2,
      lastRun: { status: 'SUCCEEDED', runState: 'SUCCEEDED', numTurns: 93, endedAt: AT },
      updatedAt: AT,
      ...over,
    },
  }),
  session: (over: Record<string, unknown> = {}): LinkPreview => ({
    kind: 'session',
    id: SESSION,
    state: 'ok',
    session: {
      id: SESSION,
      title: '执行任务：web 卡片',
      status: 'AWAITING_INPUT',
      runStatus: 'AWAITING_INPUT',
      runState: 'AWAITING_INPUT',
      sessionState: 'AWAITING_INPUT',
      lifecycleState: 'OPEN',
      endReason: null,
      error: null,
      retryAt: null,
      engineTurnActive: false,
      pendingApprovals: 0,
      waitingKind: null,
      runningBgCount: 0,
      runningBgJobCount: 0,
      watching: null,
      workspace: { id: 'w', name: 'orbit' },
      model: 'Opus 5.5',
      numTurns: 240,
      createdAt: AT,
      lastTurnAt: AT,
      updatedAt: AT,
      projectId: null,
      projectTitle: null,
      ...over,
    },
  }),
  project: (over: Record<string, unknown> = {}): LinkPreview => ({
    kind: 'project',
    id: PROJECT,
    state: 'ok',
    project: {
      title: 'Codex 多账户：一台机器上登录多个 Codex',
      status: 'OPEN',
      total: 8,
      buckets: {
        running: 0,
        ready: 1,
        blocked: 0,
        awaitingVerification: 0,
        done: 7,
        failed: 0,
        cancelled: 0,
      },
      coordinatorSessionId: SESSION,
      coordinator: (previews.session() as { session: unknown }).session,
      ...over,
    },
  }),
  list: (over: Record<string, unknown> = {}): LinkPreview => ({
    kind: 'list',
    id: LIST,
    state: 'ok',
    list: {
      title: 'FineWeb Parquet 文件下载（手动启动）',
      counts: {
        total: 27468,
        open: 27350,
        inProgress: 0,
        done: 117,
        failed: 1,
        cancelled: 0,
        running: 0,
        queued: 0,
        runnable: 27350,
      },
      ...over,
    },
  }),
};

const text = (selector: string) =>
  [...container.querySelectorAll(selector)].map((node) => node.textContent ?? '');

/** One card, on its own: the four contents and the two states are each a render of this. */
async function renderCard(linkRef: OrbitLinkRef, preview?: LinkPreview) {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <OrbitLinkCard link={linkRef} preview={preview} host={HOST} stateWord={statusLabel} />
      </MemoryRouter>,
    );
  });
  return container.firstElementChild as HTMLElement;
}

describe('the four cards', () => {
  it('draws a task: its pill, the project it is filed under, and how its run came out', async () => {
    const card = await renderCard(link('task', TASK, `${BASE}/tasks/${TASK}`), previews.task());
    expect(card.dataset.state).toBe('ready');
    expect(text('.olc-kind')).toEqual(['Task']);
    expect(container.querySelector('.olc-title a')?.getAttribute('href')).toBe(`/tasks/${TASK}`);
    expect(text('.olc-title')).toEqual(['runner + web：配额按账户归属']);
    expect(text('.olc-line')[0]).toBe('Codex 多账户：一台机器上登录多个 Codex');
    // The relative time is `relTime`'s (the transcript's own), so only what precedes it is pinned
    // here; the sentences themselves are asserted whole in their own case below.
    expect(text('.olc-line')[1]).toContain('orbit · 2 runs · last Succeeded, 93 turns');
    expect(text('.status-pill')).toEqual(['Done']);
  });

  it('draws a session: the page’s own word, and the Coordinator badge it coordinates with', async () => {
    await renderCard(
      link('session', SESSION, `${BASE}/sessions/${SESSION}`),
      previews.session(),
    );
    expect(text('.olc-kind')).toEqual(['Session']);
    expect(text('.olc-state')).toEqual(['Waiting for your reply']);
    expect(container.querySelector('.olc-state')?.className).toContain('is-attention');
    expect(text('.olc-line')[0]).toContain('orbit · Opus 5.5 · 240 turns');
    expect(text('.olc-badge')).toEqual([]);

    // The same session, running and coordinating a project, says so and wears the badge the list
    // rows wear.
    await renderCard(
      link('session', SESSION, `${BASE}/sessions/${SESSION}`),
      previews.session({ projectId: PROJECT, status: 'RUNNING', runState: 'RUNNING' }),
    );
    expect(text('.olc-state')).toEqual(['Running']);
    expect(text('.olc-badge')).toEqual(['Coordinator']);
  });

  it('draws a project: the meter, the progress line, the stall, and who coordinates it', async () => {
    await renderCard(link('project', PROJECT, `${BASE}/projects/${PROJECT}`), previews.project());
    expect(text('.olc-line')).toEqual([
      'Done 7 / 8 · Open 1',
      '1 task is ready, but nothing is running.',
    ]);
    expect(text('.olc-meter-seg.is-done')).toHaveLength(1);
    expect(text('.olc-meter-seg.is-ready')).toHaveLength(1);
    expect(text('.olc-meter-seg.is-failed')).toHaveLength(0);
    expect(text('.olc-foot-text')).toEqual(['Coordinator · Waiting for your reply']);
    expect(container.querySelector('.olc-foot-arrow')).toBeTruthy();

    // Ready work with something already running is not a stall, and a project with no coordinator
    // session draws no foot at all.
    await renderCard(
      link('project', PROJECT, `${BASE}/projects/${PROJECT}`),
      previews.project({
        total: 4,
        buckets: {
          running: 2,
          ready: 2,
          blocked: 0,
          awaitingVerification: 0,
          done: 0,
          failed: 0,
          cancelled: 0,
        },
        coordinatorSessionId: null,
        coordinator: null,
      }),
    );
    expect(text('.olc-line')).toEqual(['Done 0 / 4 · Open 4 · Running 2']);
    expect(text('.olc-foot-text')).toEqual([]);
  });

  it('draws a task list, counting the way the tasks page counts', async () => {
    await renderCard(link('list', LIST, `${BASE}/lists/${LIST}`), previews.list());
    expect(text('.olc-kind')).toEqual(['Task list']);
    expect(text('.olc-title')).toEqual(['FineWeb Parquet 文件下载（手动启动）']);
    expect(text('.olc-line')).toEqual(['Done 117 / 27,468 · Open 27,350 · Failed 1']);
  });
});

describe('the two states with nothing to show', () => {
  it('draws a link while it is still being read', async () => {
    const card = await renderCard(link('task', TASK, `${BASE}/tasks/${TASK}`));
    expect(card.dataset.state).toBe('loading');
    expect(container.querySelectorAll('.olc-skeleton span')).toHaveLength(2);
    expect(text('.olc-path')).toEqual([`${HOST}/tasks/${TASK}`]);
    expect(text('.olc-title')).toEqual([]);
  });

  it('draws a link the server will not describe, and one whose answer described nothing', async () => {
    await renderCard(link('task', TASK, `${BASE}/tasks/${TASK}`), {
      kind: 'task',
      id: TASK,
      state: 'unavailable',
    });
    expect(text('.olc-title')).toEqual(['Not available']);
    expect(text('.olc-line')).toEqual(['Deleted, or not in this account.']);
    expect(text('.olc-path')).toEqual([`${HOST}/tasks/${TASK}`]);

    // An `ok` answer missing the object it promised is drawn the same way: the server did not
    // describe it, so there is nothing to draw.
    await renderCard(link('project', PROJECT, `${BASE}/projects/${PROJECT}`), {
      kind: 'project',
      id: PROJECT,
      state: 'ok',
    });
    expect(text('.olc-title')).toEqual(['Not available']);
  });

  it('says the id the link wrote, even when the link was a reference', async () => {
    await renderCard({
      target: { kind: 'list', id: decodeId(LIST) as string },
      source: { kind: 'ref', ref: `orbit-list:${LIST}` },
    });
    expect(text('.olc-path')).toEqual([`${HOST}/lists/${LIST}`]);
  });
});

describe('every sentence a card can say', () => {
  it('is the app’s own wording, whole', () => {
    expect(orbitLinkProgressLine({ done: 7, total: 8, open: 1 })).toBe('Done 7 / 8 · Open 1');
    expect(orbitLinkProgressLine({ done: 7, total: 8, open: 1, running: 2, failed: 0 })).toBe(
      'Done 7 / 8 · Open 1 · Running 2',
    );
    expect(orbitLinkProgressLine({ done: 117, total: 27468, open: 27350, failed: 1 })).toBe(
      'Done 117 / 27,468 · Open 27,350 · Failed 1',
    );
    expect(orbitLinkStalled(1)).toBe('1 task is ready, but nothing is running.');
    expect(orbitLinkStalled(3)).toBe('3 tasks are ready, but nothing is running.');
    expect(orbitLinkRuns(0)).toBe('never run');
    expect(orbitLinkRuns(1)).toBe('1 run');
    expect(orbitLinkRuns(2)).toBe('2 runs');
    expect(orbitLinkTurns(1)).toBe('1 turn');
    expect(orbitLinkTurns(240)).toBe('240 turns');
    expect(orbitLinkLastRun('Succeeded', 93)).toBe('last Succeeded, 93 turns');
    expect(orbitLinkLastRun('Failed', 0)).toBe('last Failed');
  });
});

// MARK: - where a card is drawn, and where it is not

/** A `user` turn as ingest stores it: the person's own message, a link and all. */
function userTurn(message: string, seq = 1): RunEvent {
  return { seq, type: 'user', turnId: `turn-${seq}`, ts: AT, payload: { text: message } };
}

/** The wire answers: one preview per ref, in the order asked, as the endpoint does. */
function answers() {
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/link-previews') {
      const { refs } = JSON.parse(String(init.body)) as {
        refs: Array<{ kind: string; id: string }>;
      };
      return okJson({
        previews: refs.map((ref) =>
          ref.kind === 'task'
            ? previews.task()
            : ref.kind === 'session'
              ? previews.session()
              : ref.kind === 'project'
                ? previews.project()
                : previews.list(),
        ),
      });
    }
    return okJson({});
  });
}

const requests = () => fetchMock.mock.calls.map(([url, init]) => [String(url), init as RequestInit]);
const linkRequests = () => requests().filter(([url]) => url === '/api/link-previews');

/** Let react-query answer: it resolves on a macrotask, and cards ask for their link on mount. */
async function settle() {
  for (let tick = 0; tick < 3; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

describe('a conversation page', () => {
  const view = (events: RunEvent[], refreshKey: number, client: QueryClient) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OrbitLinkCardsProvider stateWord={statusLabel} host={HOST} refreshKey={refreshKey}>
          <Transcript events={events} />
        </OrbitLinkCardsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

  it('draws a card where the link was written, reading every link of the view in one request', async () => {
    fetchMock = answers();
    vi.stubGlobal('fetch', fetchMock);
    const taskUrl = `${BASE}/tasks/${TASK}`;
    const sessionUrl = `${BASE}/sessions/${SESSION}`;
    await act(async () => {
      root.render(view([userTurn(`看看这个 ${taskUrl}`), userTurn(`还有 ${sessionUrl}`, 2)], 1, queryClient()));
    });
    await settle();

    expect(container.querySelectorAll('.orbit-link-card')).toHaveLength(2);
    expect(text('.olc-title')).toEqual([
      'runner + web：配额按账户归属',
      '执行任务：web 卡片',
    ]);
    // The URL is gone from the message: the card stands where it was written.
    expect(container.querySelector('.chat-user')?.textContent).not.toContain(taskUrl);

    // One request for both links, canonicalised — the public id above, the uuid on the wire.
    const sent = linkRequests();
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(sent[0][1].body))).toEqual({
      refs: [
        { kind: 'task', id: decodeId(TASK) },
        { kind: 'session', id: decodeId(SESSION) },
      ],
    });
  });

  it('asks again when the conversation’s own data is re-read, and never on a timer', async () => {
    fetchMock = answers();
    vi.stubGlobal('fetch', fetchMock);
    const client = queryClient();
    const events = [userTurn(`看看这个 ${BASE}/tasks/${TASK}`)];
    await act(async () => root.render(view(events, 1, client)));
    await settle();
    expect(linkRequests()).toHaveLength(1);

    // Time passing changes nothing: the query carries no interval of its own.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(linkRequests()).toHaveLength(1);

    // The conversation re-read its data; the links are read once more, together.
    await act(async () => root.render(view(events, 2, client)));
    await settle();
    expect(linkRequests()).toHaveLength(2);
  });
});

describe('the shared page and the export', () => {
  it('draws no card and asks for no card data on a shared session', async () => {
    fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/shared/token-1?')
        ? okJson({
            title: 'x',
            workspaceName: 'orbit',
            createdAt: AT,
            events: [userTurn(`看看这个 ${BASE}/tasks/${TASK}`)],
          })
        : okJson({ previews: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient()}>
          <MemoryRouter initialEntries={['/s/token-1']}>
            <Routes>
              <Route path="/s/:token" element={<SharedSessionPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(container.querySelectorAll('.orbit-link-card')).toHaveLength(0);
    // The page read the session it was pointed at, and nothing else asked anything: a visitor here
    // may not be signed in at all, so a card is not a thing this page may try to draw.
    expect(requests().map(([url]) => url)).toEqual(['/api/shared/token-1?limit=200&maxPayload=2048']);
    // The address stays in the text, but not as a link: to a signed-out reader an app page is a
    // sign-in page, so a public page draws it as its words (PublicLinkResolverCtx).
    expect(container.querySelector(`a[href="/tasks/${TASK}"]`)).toBeNull();
    expect(container.textContent).toContain(`${BASE}/tasks/${TASK}`);
  });

  it('draws no card and asks for no card data in an exported file', async () => {
    const { buildSessionHtml } = await import('../lib/sessionExport');
    const html = buildSessionHtml(
      { id: TASK, title: 'x', workspace: { name: 'orbit' } },
      [userTurn(`看看这个 ${BASE}/tasks/${TASK}`)],
      new Map(),
      '',
    );
    expect(html).not.toContain('orbit-link-card');
    expect(fetchMock).not.toHaveBeenCalled();
    // A file has no request behind it, so the link stays a link — its address still in the text
    // where the card would have stood.
    expect(html).toContain(`${BASE}/tasks/${TASK}`);
  });
});
