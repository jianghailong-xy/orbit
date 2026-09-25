// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://orbit.wikova.com/s/k3Qx9vR2mT7wLpN8sYdF0aBcE1gHjKuZ"}
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveSessionFilingState,
  deriveSessionLifecycleState,
  deriveSessionRunState,
  deriveSessionState,
} from '@orbit/shared';
import type { SharedEvent, SharedSession } from '../api';
import { Transcript } from '../components/Transcript';
import { encodeId } from '../lib/idCodec';
import { TASK_START_OPEN_TASK } from '../lib/taskStartCard';
import { SharedSessionPage } from './SharedSessionPage';
import * as rows from './SharedSessionPage.fixtures';

/**
 * The public page of a shared session (`/s/<token>`), mounted whole on the routes T1 gave it:
 * GET /shared/:token for the newest page, /events?before= for each page above it, /events/:seq for
 * a clipped card opened. What is held here is what leaves the page and what a signed-out reader is
 * shown: one request to open it, one per page scrolled into, one per clipped card opened; a header
 * that says the session's state as the share answers it; and no link into the app, whose every page
 * sends that reader to sign in.
 *
 * The transcript is this deployment's own rows (SharedSessionPage.fixtures.ts), and the page runs
 * at this deployment's own address, so a link a person pasted to one of its sessions is the in-app
 * link it would be in the browser.
 */

vi.mock('../lib/sessionExport', () => ({ exportSessionHtml: vi.fn(async () => undefined) }));
const { exportSessionHtml } = await import('../lib/sessionExport');

const TOKEN = 'k3Qx9vR2mT7wLpN8sYdF0aBcE1gHjKuZ';
const SHARE = `/api/shared/${TOKEN}`;

const at = (row: Omit<SharedEvent, 'seq'>, seq: number): SharedEvent => ({ ...row, seq });

/** The page above the newest one. */
const OLDER: SharedEvent[] = [at(rows.OLDER_PROGRESS_1, 101), at(rows.OLDER_PROGRESS_2, 102)];

/** The newest page, whole — as the Download HTML walk reads it, and as /events/:seq answers. */
const TAIL_WHOLE: SharedEvent[] = [
  at(rows.SAME_ORIGIN_URL, 201),
  at(rows.TASK_STARTED, 202),
  at(rows.BASH_CALL, 203),
  at(rows.BASH_RESULT, 204),
  at(rows.REFERENCES_REPLY, 205),
  at(rows.REFERENCED_TASK, 206),
  at(rows.WATCH_WAKE, 207),
  at(rows.EXCEPTION_ITEM, 208),
];
const CLIPPED_SEQ = 204;
const RESULT_TEXT: string = rows.BASH_RESULT.payload.content;

/** The newest page as the share pages it with `maxPayload=2048`: the tool result's text cut to its
 *  first 2048 characters and the event marked, as truncatePayload does on the server. */
const TAIL: SharedEvent[] = TAIL_WHOLE.map((e) =>
  e.seq === CLIPPED_SEQ
    ? { ...e, payload: { ...e.payload, content: RESULT_TEXT.slice(0, 2048) }, truncated: true }
    : e,
);

/** What GET /shared/:token answers for a session row: its title, workspace and start, and its state
 *  as the share derives it (sessions.service.ts `getShared` → `withSessionState`, same derivations). */
function served(session: rows.SessionRow, events: SharedEvent[], hasMore: boolean): SharedSession {
  const state = {
    status: session.status,
    endReason: session.endReason,
    completedAt: session.completedAt,
    archivedAt: session.archivedAt,
    deletedAt: session.deletedAt,
  };
  return {
    title: session.title,
    workspaceName: session.workspaceName,
    status: session.status,
    runStatus: session.status,
    sessionState: deriveSessionState(state),
    runState: deriveSessionRunState(state),
    lifecycleState: deriveSessionLifecycleState(state),
    filingState: deriveSessionFilingState(state),
    createdAt: session.createdAt,
    events,
    hasMore,
  };
}

let container: HTMLDivElement;
let root: Root;
let answer: SharedSession;
let requests: string[];

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }) as Response;
const notFound = () =>
  ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'not found' }) }) as Response;

/** The share's routes, as T1 serves them (shared.controller.ts). */
function share(url: string): Response {
  const u = new URL(url, window.location.origin);
  if (u.pathname === SHARE) return okJson(answer);
  if (u.pathname === `${SHARE}/events`) {
    const before = u.searchParams.get('before');
    const whole = !u.searchParams.has('maxPayload');
    if (before === null) return okJson({ events: whole ? TAIL_WHOLE : TAIL, hasMore: true });
    if (before === '201') return okJson({ events: OLDER, hasMore: false });
    return okJson({ events: [], hasMore: false });
  }
  const one = new RegExp(`^${SHARE}/events/(\\d+)$`).exec(u.pathname);
  const event = one && [...OLDER, ...TAIL_WHOLE].find((e) => e.seq === Number(one[1]));
  return event ? okJson(event) : notFound();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  answer = served(rows.T6_RUN, TAIL, true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      return share(url);
    }),
  );
  vi.mocked(exportSessionHtml).mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/s/${TOKEN}`]}>
          <Routes>
            <Route path="/s/:token" element={<SharedSessionPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** The requests that read the transcript — the root and its events — in the order they left. */
const transcriptReads = () => requests.filter((url) => url === SHARE || url.startsWith(`${SHARE}?`) || url.startsWith(`${SHARE}/events`));

/** Open every fold that draws links when open: the notes delivery appends to a message. */
async function openFolds() {
  for (const fold of [...container.querySelectorAll('button.chat-injected-head')]) await click(fold);
}

/** Every link on the page that goes to an app page for a task, project or session. */
const appLinks = () =>
  [...container.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href')!)
    .filter((href) => /^\/(tasks|projects|sessions)\//.test(href));

describe('the shared page, a page at a time', () => {
  it('opens on the newest page, with one request', async () => {
    await mountPage();

    expect(transcriptReads()).toEqual([`${SHARE}?limit=200&maxPayload=2048`]);
    expect(container.textContent).toContain(rows.REFERENCES_REPLY.payload.text.slice(0, 8));
    expect(container.textContent).not.toContain(rows.OLDER_PROGRESS_1.payload.text);
  });

  it('brings in the page before the oldest one it holds when the reader scrolls up', async () => {
    await mountPage();
    const scroller = container.querySelector('.share-scroll')!;

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    await settle();

    expect(transcriptReads()).toEqual([
      `${SHARE}?limit=200&maxPayload=2048`,
      `${SHARE}/events?before=201&limit=200&maxPayload=2048`,
    ]);
    // Above what was there, not below it.
    const text = container.textContent!;
    expect(text.indexOf(rows.OLDER_PROGRESS_1.payload.text)).toBeGreaterThan(-1);
    expect(text.indexOf(rows.OLDER_PROGRESS_1.payload.text)).toBeLessThan(
      text.indexOf(rows.REFERENCES_REPLY.payload.text.slice(0, 8)),
    );

    // That was the first page of the conversation: scrolling on asks for nothing more.
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    await settle();
    expect(transcriptReads()).toHaveLength(2);
  });

  it('fetches a clipped card whole when it is opened, and not before', async () => {
    await mountPage();
    const card = [...container.querySelectorAll('.chat-tool-card')].find((c) =>
      c.textContent?.includes(rows.BASH_CALL.payload.input.description),
    );
    expect(card, 'the Bash call was not drawn').toBeTruthy();
    expect(requests.filter((url) => url.startsWith(`${SHARE}/events/`))).toEqual([]);

    await click(card!.querySelector('.chat-tool-row')!);

    expect(requests.filter((url) => url.startsWith(`${SHARE}/events/`))).toEqual([
      `${SHARE}/events/${CLIPPED_SEQ}`,
    ]);
    // The page kept all but the last three characters of the result ("….pg.spec"); what the card
    // shows now, unfolded, is the whole of it.
    await click([...card!.querySelectorAll('button.chat-more')].find((b) => /more lines/.test(b.textContent!))!);
    expect(RESULT_TEXT.endsWith('pool-claim-selection.pg.spec.ts')).toBe(true);
    expect(card!.textContent).toContain('pool-claim-selection.pg.spec.ts');
  });
});

describe('the header', () => {
  it('reads Orbit, the title, the state, Live, Read-only, Download HTML — in that order', async () => {
    await mountPage();
    const header = container.querySelector('header.share-header')!;
    const parts = [
      ...header.querySelectorAll('.share-brand, .share-crumb, .status-pill, .share-live, .share-badge, .share-download'),
    ].map((el) => el.textContent!.trim());

    expect(parts).toEqual([
      'Orbit',
      '执行任务：T6 安全边界：跨 owner、准入与凭据不外泄的回归断言',
      'Completed',
      'Live',
      'Read-only',
      'Download HTML',
    ]);
    expect(header.querySelector('.share-live')!.getAttribute('title')).toBe(
      'Live — viewers see changes as they happen',
    );
    expect(container.querySelector('footer')!.textContent).toBe('Shared from Orbit · read-only');
  });

  it.each([
    ['a finished run, filed Completed', rows.T6_RUN, 'Completed'],
    ['an open conversation waiting for its next message', rows.COORDINATOR, 'Awaiting reply'],
    ['a run that is running', rows.THIS_RUN, 'Running'],
  ])('says the state the share answers with: %s', async (_, session, word) => {
    answer = served(session, TAIL, true);
    await mountPage();

    expect(container.querySelector('header .status-pill')!.textContent).toBe(word);
  });
});

describe('links on the shared page', () => {
  // Where each of these rows links to in the app, by the ids the rows carry.
  const APP_LINKS = [
    '/sessions/33bYErXW8JTlgtJeBFfG5', // the pasted address, as written (SAME_ORIGIN_URL)
    `/projects/${encodeId(rows.TASK_STARTED.payload.taskStart.project.id)}`, // Task started: its project
    `/tasks/${encodeId(rows.TASK_STARTED.payload.taskStart.taskId)}`, // Task started: Open the task
    `/tasks/${encodeId('34ORZ0jC7dpeqvYxg35Rn')}`, // REFERENCES_REPLY: orbit-task
    `/sessions/${encodeId('1wSVXdBhiCI1t54AHKoaVv')}`, // REFERENCES_REPLY: orbit-session
    `/projects/${encodeId('34JNIW4b31ujSVqEG784v')}`, // REFERENCES_REPLY: orbit-project
    `/tasks/${encodeId('34OEE9MQXMEm0h0Ptm1GG')}`, // REFERENCED_TASK: orbit-task, and the note's card
    `/tasks/${encodeId('01a0c49c-468f-766f-80ff-1fd6245c6dd0')}`, // WATCH_WAKE: the task that changed
    `/tasks/${encodeId(rows.EXCEPTION_ITEM.payload.openItemDelivery.task.id)}`, // Open item: its task
    `/sessions/${encodeId(rows.EXCEPTION_ITEM.payload.openItemDelivery.task.sessionId)}`, // Open item: failed session
  ];

  it('in the app, these rows do link into it', async () => {
    // The control: the same rows drawn as the app draws them, with no public page around them.
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Transcript events={TAIL} />
        </MemoryRouter>,
      );
    });
    await settle();
    await openFolds();

    expect(new Set(appLinks())).toEqual(new Set(APP_LINKS));
  });

  it('draws none of them as a link, and keeps their words', async () => {
    await mountPage();
    await openFolds();

    expect(appLinks()).toEqual([]);
    // Nor a link to any other page of the app: every link left leaves this deployment.
    for (const a of container.querySelectorAll('a[href]')) {
      expect(new URL(a.getAttribute('href')!, window.location.origin).origin).not.toBe(window.location.origin);
    }
    const text = container.textContent!;
    for (const words of [
      'https://orbit.wikova.com/sessions/33bYErXW8JTlgtJeBFfG5',
      rows.TASK_STARTED.payload.taskStart.project.title,
      TASK_START_OPEN_TASK,
      'T3b 放开池 slug 的写入口',
      '执行任务：T3b',
      'runner 从项目集成线的 tip 创建 worktree',
      encodeId('01a0c49c-468f-766f-80ff-1fd6245c6dd0'),
      'View watch',
      rows.EXCEPTION_ITEM.payload.openItemDelivery.task.title,
      'Open the failed session ↗',
    ]) {
      expect(text).toContain(words);
    }
  });
});

describe('Download HTML', () => {
  it('saves the whole conversation, every page of it unclipped, linking no further than the page', async () => {
    await mountPage();

    await click(container.querySelector('button.share-download')!);

    expect(transcriptReads().slice(1)).toEqual([
      `${SHARE}/events?limit=500`,
      `${SHARE}/events?before=201&limit=500`,
    ]);
    expect(exportSessionHtml).toHaveBeenCalledTimes(1);
    const [session, events, , resolver] = vi.mocked(exportSessionHtml).mock.calls[0];
    expect(session.title).toBe(rows.T6_RUN.title);
    expect(events).toEqual([...OLDER, ...TAIL_WHOLE]);
    expect(resolver?.({ kind: 'task', id: '34ORZ0jC7dpeqvYxg35Rn' })).toBeNull();
  });
});
