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
import { sharedStreamUrl, type SharedEvent, type SharedSession, type SharedSessionNow } from '../api';
import { Transcript } from '../components/Transcript';
import { encodeId } from '../lib/idCodec';
import { TASK_START_OPEN_TASK } from '../lib/taskStartCard';
import { SharedSessionPage } from './SharedSessionPage';
import * as rows from './SharedSessionPage.fixtures';
import { hoverTooltip } from '../test/tooltipHover';

/**
 * The public page of a shared session (`/s/<token>`), mounted whole on the routes T1 gave it:
 * GET /shared/:token for the newest page, /events?before= for each page above it, /events/:seq for
 * a clipped card opened, /events?after= for what a live conversation adds. What is held here is what
 * leaves the page and what a signed-out reader is shown: one request to open it, one per page
 * scrolled into, one per clipped card opened, one every few seconds while the conversation is going
 * and none once it is over; a header that says the session's state as the share answers it; and no
 * link into the app, whose every page sends that reader to sign in.
 *
 * The transcript is this deployment's own rows (SharedSessionPage.fixtures.ts), and the page runs
 * at this deployment's own address, so a link a person pasted to one of its sessions is the in-app
 * link it would be in the browser.
 */


const TOKEN = 'k3Qx9vR2mT7wLpN8sYdF0aBcE1gHjKuZ';
const SHARE = `/api/shared/${TOKEN}`;

const at = (row: Omit<SharedEvent, 'seq'>, seq: number): SharedEvent => ({ ...row, seq });

/** The page above the newest one. */
const OLDER: SharedEvent[] = [at(rows.OLDER_PROGRESS_1, 101), at(rows.OLDER_PROGRESS_2, 102)];

/** The newest page, whole — as /events/:seq answers. */
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
/** The session row as it stands now, and what it has added past TAIL: what `/events?after=` reads. */
let current: rows.SessionRow;
let added: SharedEvent[];
let followAnswer: (after: number, limit: number) => unknown;
/** What `/stream` answers; null is a server from before the stream, whose answer is the share's 404. */
let streamReply: ((url: string, init?: RequestInit) => Response | Promise<Response>) | null;

/** What `/events?after=` answers (sessions.service.ts `getSharedEventsAfter`): the header as
 *  `current` stands now, and the events of `added` past the seq asked for, `limit` at a time with
 *  the cursor to the rest. */
function followed(after: number, limit: number): SharedSessionNow {
  const rest = added.filter((e) => e.seq > after);
  const events = rest.slice(0, limit);
  const { hasMore: _, ...header } = served(current, events, false);
  return { ...header, after: rest.length > limit ? events[events.length - 1].seq : null };
}

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }) as Response;
const notFound = () =>
  ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ message: 'not found' }) }) as Response;

/** The share's routes, as T1 serves them (shared.controller.ts). */
function share(url: string): Response {
  const u = new URL(url, window.location.origin);
  if (u.pathname === SHARE) return okJson(answer);
  if (u.pathname === `${SHARE}/events`) {
    const after = u.searchParams.get('after');
    if (after !== null) return okJson(followAnswer(Number(after), Number(u.searchParams.get('limit'))));
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
  current = rows.T6_RUN;
  added = [];
  followAnswer = followed;
  streamReply = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (streamReply && new URL(url, window.location.origin).pathname === `${SHARE}/stream`) return streamReply(url, init);
      return share(url);
    }),
  );
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
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
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

/** Open card details that draw links when open. */
async function openFolds() {
  // A turn Orbit opened is folded with its answer (OrbitExchangeFold): open each, the group first.
  for (const sel of ['.orbit-exchanges:not(.is-open) > .orbit-exchanges-line', '.orbit-branch:not(.is-open) > .orbit-branch-line', '.orbit-exchange:not(.is-open) > .orbit-exchange-line']) {
    for (let fold = container.querySelector<HTMLElement>(sel); fold; fold = container.querySelector<HTMLElement>(sel)) await click(fold);
  }
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
    expect(container.textContent).not.toContain('Orbit attached');
    expect(container.querySelector('[class*="chat-injected"]')).toBeNull();
    expect(container.textContent).not.toContain(rows.OLDER_PROGRESS_1.payload.text);
  });

  it('is read-only: no composer, no text box and no file picker (only an invited guest may write, in the app)', async () => {
    await mountPage();
    expect(container.querySelector('form, textarea, input[type="file"], .guest-composer, .guest-dock')).toBeNull();
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
    // The call sits behind its steps line; opening the line opens no card, so it fetches nothing.
    for (const line of [...container.querySelectorAll<HTMLElement>('.chat-steps-line')]) await click(line);
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

describe('a conversation still going', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let `ms` of the page's clock pass, and what it set off land. */
  async function elapse(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
  }
  /** The reads of what the conversation has added, in the order they left. */
  const followReads = () => transcriptReads().filter((url) => url.includes('after='));
  const after = (seq: number) => `${SHARE}/events?after=${seq}&limit=200&maxPayload=2048`;
  const pill = () => container.querySelector('header .status-pill')!.textContent;
  // How the two progress lines read on the page: the second's words before its inline code.
  const FIRST: string = rows.OLDER_PROGRESS_1.payload.text;
  const SECOND: string = rows.OLDER_PROGRESS_2.payload.text.slice(0, 16);

  async function mountRunning() {
    answer = served(rows.THIS_RUN, TAIL, true);
    current = rows.THIS_RUN;
    await mountPage();
  }

  it('asks a running one what it has added every few seconds, and draws it below what is there', async () => {
    await mountRunning();
    added = [at(rows.OLDER_PROGRESS_1, 209)];
    await elapse(3_999);
    expect(followReads()).toEqual([]);

    await elapse(1);
    expect(followReads()).toEqual([after(208)]);
    const text = container.textContent!;
    expect(text.indexOf(FIRST)).toBeGreaterThan(
      text.indexOf(rows.REFERENCES_REPLY.payload.text.slice(0, 8)),
    );

    added = [...added, at(rows.OLDER_PROGRESS_2, 210)];
    await elapse(4_000);
    expect(followReads()).toEqual([after(208), after(209)]);
    expect(container.textContent).toContain(SECOND);
    expect(pill()).toBe('Running');
  });

  it('redraws the header from each answer, and stops asking once the run is over and quiet', async () => {
    await mountRunning();
    expect(pill()).toBe('Running');
    current = { ...rows.THIS_RUN, status: 'SUCCEEDED' };
    added = [at(rows.OLDER_PROGRESS_1, 209)];

    await elapse(4_000);
    expect(pill()).toBe('Finished');
    expect(container.textContent).toContain(FIRST);
    // It moved as it ended, so it is asked once more, in case the last of it was still on its way.
    await elapse(4_000);
    expect(followReads()).toEqual([after(208), after(209)]);
    await elapse(10 * 60_000);
    expect(followReads()).toHaveLength(2);
  });

  it('asks one waiting on its owner now and then, and every few seconds again once it moves', async () => {
    answer = served(rows.COORDINATOR, TAIL, true);
    current = rows.COORDINATOR;
    await mountPage();
    await elapse(29_999);
    expect(followReads()).toEqual([]);
    await elapse(1);
    expect(followReads()).toEqual([after(208)]);

    // The owner answers: it is running again, and has said something.
    current = { ...rows.COORDINATOR, status: 'RUNNING' };
    added = [at(rows.OLDER_PROGRESS_1, 209)];
    await elapse(30_000);
    expect(followReads()).toEqual([after(208), after(208)]);
    expect(pill()).toBe('Running');
    await elapse(4_000);
    expect(followReads()).toEqual([after(208), after(208), after(209)]);
  });

  it('asks a finished one nothing', async () => {
    // beforeEach's answer: the T6 run, filed Completed.
    added = [at(rows.OLDER_PROGRESS_1, 209)];
    await mountPage();
    await elapse(10 * 60_000);
    expect(transcriptReads()).toEqual([`${SHARE}?limit=200&maxPayload=2048`]);
  });

  it('reads a backlog through at once, a page at a time, then waits again', async () => {
    await mountRunning();
    added = Array.from({ length: 250 }, (_, i) => at(rows.OLDER_PROGRESS_1, 209 + i));
    await elapse(4_000);
    expect(followReads()).toEqual([after(208), after(408)]);
    await elapse(4_000);
    expect(followReads()).toEqual([after(208), after(408), after(458)]);
  });

  it('asks nothing while its tab is not looked at, and catches up the moment it is', async () => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      await mountRunning();
      hidden = true;
      added = [at(rows.OLDER_PROGRESS_1, 209)];
      await elapse(10 * 60_000);
      expect(followReads()).toEqual([]);

      hidden = false;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await settle();
      expect(followReads()).toEqual([after(208)]);
      expect(container.textContent).toContain(FIRST);
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  it('keeps a reader at the end at the end, and leaves one who scrolled up where they are', async () => {
    await mountRunning();
    // The layout jsdom has none of: a 500px viewport over content as tall as its text is long.
    const scroller = container.querySelector<HTMLElement>('.share-scroll')!;
    let top = 0;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 500 },
      scrollHeight: { configurable: true, get: () => scroller.textContent!.length },
      scrollTop: { configurable: true, get: () => top, set: (v: number) => { top = v; } },
    });
    expect(scroller.scrollHeight).toBeGreaterThan(2_000);

    top = scroller.scrollHeight - 500;
    added = [at(rows.OLDER_PROGRESS_1, 209)];
    await elapse(4_000);
    expect(container.textContent).toContain(FIRST);
    expect(top).toBe(scroller.scrollHeight);

    top = 1_000;
    added = [...added, at(rows.OLDER_PROGRESS_2, 210)];
    await elapse(4_000);
    expect(container.textContent).toContain(SECOND);
    expect(top).toBe(1_000);
  });

  it('against a server from before `after`, adds only what is new and keeps its header', async () => {
    await mountRunning();
    // That server reads `after` as nothing: its tail page, newest last, and no header.
    followAnswer = () => ({ events: [...TAIL, ...added], hasMore: true });
    added = [at(rows.OLDER_PROGRESS_1, 209)];
    await elapse(4_000);
    expect(followReads()).toEqual([after(208)]);
    const text = container.textContent!;
    expect(text.split(FIRST)).toHaveLength(2);
    expect(text.split(rows.REFERENCES_REPLY.payload.text.slice(0, 8))).toHaveLength(2);
    expect(pill()).toBe('Running');
    await elapse(4_000);
    expect(followReads()).toEqual([after(208), after(209)]);
  });

  describe('over its stream', () => {
    /** One stream the page opened: the URL it asked, and the server's end of it. */
    interface Wire {
      url: string;
      send: (frame: unknown) => Promise<void>;
      end: () => Promise<void>;
      closed: () => boolean;
    }
    let wires: Wire[];
    const encoder = new TextEncoder();
    const streamAt = (since: number) => `${SHARE}/stream?sinceSeq=${since}&maxPayload=2048`;

    /** The stream as viewer-stream.service.ts serves it: `data: <json>` messages, until the server
     *  ends it or the page closes it. */
    function openWire(url: string, init?: RequestInit): Response {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let closed = false;
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
      });
      init?.signal?.addEventListener('abort', () => {
        closed = true;
        controller.error(new DOMException('aborted', 'AbortError'));
      });
      wires.push({
        url,
        send: async (frame) => {
          await act(async () => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
          });
          await settle();
        },
        end: async () => {
          closed = true;
          await act(async () => controller.close());
          await settle();
        },
        closed: () => closed,
      });
      return { ok: true, status: 200, statusText: 'OK', body } as Response;
    }

    beforeEach(() => {
      wires = [];
      streamReply = openWire;
      // The reconnect's jitter at its longest wait: 1 s, 2 s, 4 s…
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const reply = (seq: number, text: string): SharedEvent => ({
      seq,
      type: 'assistant',
      payload: { text },
      turnId: 'turn-1',
      ts: '2026-11-16T12:00:00.000Z',
    });
    const headOf = (row: rows.SessionRow) => {
      const { events: _e, hasMore: _h, ...head } = served(row, [], false);
      return head;
    };

    it('streams a conversation inside a project or task link from its own route', () => {
      expect(sharedStreamUrl(TOKEN, { sinceSeq: 208, sessionId: 'abc' })).toBe(
        `${SHARE}/sessions/abc/stream?sinceSeq=208&maxPayload=2048`,
      );
      expect(sharedStreamUrl(TOKEN, { sinceSeq: 0 })).toBe(`${SHARE}/stream?maxPayload=2048`);
    });

    it('opens the stream from the newest seq on the page, and asks nothing by polling', async () => {
      await mountRunning();
      expect(wires.map((w) => w.url)).toEqual([streamAt(208)]);
      await elapse(60_000);
      expect(followReads()).toEqual([]);
    });

    it('draws the reply as it is typed, then the reply itself in its place', async () => {
      await mountRunning();
      const [wire] = wires;
      await wire.send({ seq: 0, type: 'text_delta', payload: { text: 'The build is ' } });
      expect(container.textContent).toContain('The build is');
      await wire.send({ seq: 0, type: 'text_delta', payload: { text: 'green on every' } });
      // The draft is drawn at most every 90 ms, as the owner's is (StreamingMessage).
      await elapse(90);
      expect(container.textContent).toContain('The build is green on every');

      await wire.send(reply(209, 'The build is green on every platform.'));
      const text = container.textContent!;
      expect(text).toContain('The build is green on every platform.');
      // The draft gave way to the reply: the words are on the page once.
      expect(text.split('The build is green on every')).toHaveLength(2);
      // Below what was there.
      expect(text.indexOf('The build is green')).toBeGreaterThan(text.indexOf(rows.REFERENCES_REPLY.payload.text.slice(0, 8)));
    });

    it('merges durable events by seq, each once', async () => {
      await mountRunning();
      const [wire] = wires;
      await wire.send(reply(210, 'Second answer.'));
      await wire.send(reply(209, 'First answer.'));
      await wire.send(reply(210, 'Second answer.'));
      await wire.send(reply(205, 'An event the page already holds.'));
      const text = container.textContent!;
      expect(text.indexOf('First answer.')).toBeGreaterThan(-1);
      expect(text.indexOf('First answer.')).toBeLessThan(text.indexOf('Second answer.'));
      expect(text.split('Second answer.')).toHaveLength(2);
      expect(text).not.toContain('An event the page already holds.');
    });

    it('redraws the status pill from head frames', async () => {
      await mountRunning();
      expect(pill()).toBe('Running');
      await wires[0].send({ seq: 0, type: 'head', payload: headOf({ ...rows.THIS_RUN, status: 'SUCCEEDED' }) });
      expect(pill()).toBe('Finished');
      expect(followReads()).toEqual([]);
    });

    it('opens a dropped stream again from the newest seq, after 1 s, then 2 s', async () => {
      await mountRunning();
      await wires[0].send(reply(209, 'First answer.'));
      await wires[0].end();
      await elapse(999);
      expect(wires).toHaveLength(1);
      await elapse(1);
      expect(wires.map((w) => w.url)).toEqual([streamAt(208), streamAt(209)]);

      // Dropped again before it said anything: the wait doubles.
      await wires[1].end();
      await elapse(1_999);
      expect(wires).toHaveLength(2);
      await elapse(1);
      expect(wires.map((w) => w.url)).toEqual([streamAt(208), streamAt(209), streamAt(209)]);
      expect(followReads()).toEqual([]);
    });

    it('closes the stream while the tab is hidden, and opens it again from where it was on return', async () => {
      let hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      try {
        await mountRunning();
        await wires[0].send(reply(209, 'First answer.'));
        hidden = true;
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await settle();
        expect(wires[0].closed()).toBe(true);
        await elapse(10 * 60_000);
        expect(wires).toHaveLength(1);
        expect(followReads()).toEqual([]);

        hidden = false;
        await act(async () => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await settle();
        expect(wires.map((w) => w.url)).toEqual([streamAt(208), streamAt(209)]);
        await wires[1].send(reply(210, 'Second answer.'));
        expect(container.textContent).toContain('Second answer.');
      } finally {
        delete (document as { hidden?: boolean }).hidden;
      }
    });

    it('shows the link-gone state when the stream says the link is gone', async () => {
      await mountRunning();
      await wires[0].send({ type: 'gone' });
      expect(container.textContent).toContain('This shared link isn’t available');
      await elapse(10 * 60_000);
      expect(wires).toHaveLength(1);
      expect(followReads()).toEqual([]);
    });

    it('falls back to polling when the stream is refused with a 429', async () => {
      streamReply = () => ({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) }) as Response;
      await mountRunning();
      added = [at(rows.OLDER_PROGRESS_1, 209)];
      await elapse(4_000);
      expect(followReads()).toEqual([after(208)]);
      expect(container.textContent).toContain(FIRST);
      await elapse(4_000);
      expect(followReads()).toEqual([after(208), after(209)]);
      expect(requests.filter((url) => url.includes('/stream'))).toHaveLength(1);
    });

    it('falls back to polling when reopening a dropped stream is refused with a 429', async () => {
      await mountRunning();
      await wires[0].end();
      streamReply = () => ({ ok: false, status: 429, statusText: 'Too Many Requests', json: async () => ({}) }) as Response;
      await elapse(1_000);
      expect(requests.filter((url) => url.includes('/stream'))).toHaveLength(2);
      added = [at(rows.OLDER_PROGRESS_1, 209)];
      await elapse(4_000);
      expect(followReads()).toEqual([after(208)]);
      expect(container.textContent).toContain(FIRST);
      await elapse(60_000);
      expect(requests.filter((url) => url.includes('/stream'))).toHaveLength(2);
    });

    it('falls back to polling against a server from before the stream (404)', async () => {
      streamReply = () => notFound();
      await mountRunning();
      added = [at(rows.OLDER_PROGRESS_1, 209)];
      await elapse(4_000);
      expect(followReads()).toEqual([after(208)]);
      expect(container.textContent).toContain(FIRST);
      expect(container.textContent).not.toContain('This shared link isn’t available');
      expect(requests.filter((url) => url.includes('/stream'))).toHaveLength(1);
    });

    it('falls back to polling when the network will not carry the stream', async () => {
      streamReply = () => Promise.reject(new TypeError('Failed to fetch'));
      await mountRunning();
      await elapse(4_000);
      expect(followReads()).toEqual([after(208)]);
    });

    it('catches up a gap too long to replay a page at a time, then opens the stream from its end', async () => {
      await mountRunning();
      added = [at(rows.OLDER_PROGRESS_1, 209), at(rows.OLDER_PROGRESS_2, 210)];
      await wires[0].send({ seq: 0, type: 'resync' });
      expect(followReads()).toEqual([after(208)]);
      expect(container.textContent).toContain(FIRST);
      expect(wires.map((w) => w.url)).toEqual([streamAt(208), streamAt(210)]);
    });
  });
});

describe('the header', () => {
  it('reads Orbit, the title, the state, Live, Read-only — in that order, and offers no download', async () => {
    await mountPage();
    const header = container.querySelector('header.share-header')!;
    const parts = [
      ...header.querySelectorAll('.share-brand, .share-crumb, .status-pill, .share-live, .share-badge'),
    ].map((el) => el.textContent!.trim());

    expect(parts).toEqual([
      'Orbit',
      '执行任务：T6 安全边界：跨 owner、准入与凭据不外泄的回归断言',
      'Completed',
      'Live',
      'Read-only',
    ]);
    expect(header.querySelector('button')).toBeNull();
    expect(await hoverTooltip(header.querySelector('.share-live')!)).toBe(
      'Live — viewers see changes as they happen',
    );
    expect(container.querySelector('footer')!.textContent).toBe('Shared from Orbit · read-only');
  });

  it.each([
    ['a finished run, filed Completed', rows.T6_RUN, 'Completed'],
    // A public link's reader cannot send that next message, so it is not asked for one.
    ['an open conversation waiting for its next message', rows.COORDINATOR, 'Waiting for owner'],
    ['a run that is running', rows.THIS_RUN, 'Running'],
  ])('says the state the share answers with: %s', async (_, session, word) => {
    answer = served(session, TAIL, true);
    await mountPage();

    expect(container.querySelector('header .status-pill')!.textContent).toBe(word);
  });

  // 2026-11-13: a session running a background task read "Awaiting reply" here, because the page
  // read the parked status alone. The server now says what a parked session is still doing.
  it.each([
    ['TURN', 'Running', 'running'],
    ['BACKGROUND_JOB', 'Running in background', 'ongoing'],
    ['WAITING', 'Waiting to resume', 'ongoing'],
    [null, 'Waiting for owner', 'todo'],
  ])('a parked conversation with activity %s says %s', async (activity, word, tone) => {
    answer = { ...served(rows.COORDINATOR, TAIL, true), activity };
    await mountPage();

    const pill = container.querySelector('header .status-pill')!;
    expect(pill.textContent).toBe(word);
    expect(pill.classList.contains(tone)).toBe(true);
    expect(pill.classList.contains('awaiting')).toBe(false);
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
    `/tasks/${encodeId('34OEE9MQXMEm0h0Ptm1GG')}`, // REFERENCED_TASK: the orbit-task link in the typed words
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
