// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestSession, GuestSessionNow, SharedEvent } from '../api';

/**
 * The guest view (docs/session-guests-design.md §4; boards docs/mocks/share-links/10-session-guests-3 and
 * 11-guest-one-link-2), mounted whole over the guest door as `/sessions/<id>` draws it in the app's pane: the frame says who shared it, how it stands and that the reader is
 * a Guest; the composer takes words and images (pasted, dropped or picked, uploaded through the guest door) and says
 * where it runs; the session waiting on its owner, having ended, and
 * no longer being shared each read as the board draws them; and what the conversation adds is followed.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getGuestSession: vi.fn(),
  getGuestEventPage: vi.fn(),
  getGuestEventsAfter: vi.fn(),
  getGuestEventFull: vi.fn(),
  sendGuestTurn: vi.fn(),
  uploadGuestAttachment: vi.fn(),
  fetchAttachmentObjectUrl: vi.fn(),
  fetchGuestAttachmentObjectUrl: vi.fn(),
}));
const {
  api, ApiError, fetchAttachmentObjectUrl, fetchGuestAttachmentObjectUrl, getGuestSession, getGuestEventsAfter, sendGuestTurn,
  uploadGuestAttachment,
} = await import('../api');
const { GUEST_NOT_SHARED, GuestLinkRedirect, GuestSessionView } = await import('./GuestSessionPage');
const { encodeId } = await import('../lib/idCodec');

const SESSION = '0196f8a2-7c1e-7b3a-9d4e-5f6a7b8c9d0e';
const ts = '2026-11-12T10:02:00.000Z';

const user = (seq: number, text: string, from?: string): SharedEvent => ({
  seq, type: 'user', turnId: `t${seq}`, ts,
  payload: { text, ...(from ? { externalSender: { source: 'ORBIT_GUEST', name: from } } : {}) },
});
const assistant = (seq: number, text: string): SharedEvent => ({
  seq, type: 'assistant', turnId: `t${seq}`, ts, payload: { text },
});
const EVENTS: SharedEvent[] = [
  user(1, 'Can we give pg specs a retry budget instead of skipping link-heartbeat?'),
  assistant(2, 'I’d retry only tests tagged @flaky, at most twice.'),
  user(3, 'Twice is fine, but CI should fail if the same test needed a retry three runs in a row.', 'Alice Chen'),
  user(4, 'And list them in the summary.', 'Ravi Kumar'),
];

type Run = 'RUNNING' | 'AWAITING_INPUT' | 'ENDED';
const head = (run: Run, over: Partial<GuestSession> = {}): GuestSession => ({
  title: 'Retry budget for flaky pg specs',
  workspaceName: null,
  status: run === 'ENDED' ? 'CANCELLED' : run,
  runStatus: run === 'ENDED' ? 'CANCELLED' : run,
  runState: run,
  lifecycleState: 'OPEN',
  createdAt: ts,
  events: EVENTS,
  hasMore: false,
  ownerName: 'Lin Wei',
  waitingOnOwner: false,
  ...over,
});
const now = (run: Run, events: SharedEvent[], over: Partial<GuestSessionNow> = {}): GuestSessionNow => {
  const { hasMore: _h, kind: _k, task: _t, project: _p, scope: _s, ownerName: _o, ...rest } = head(run);
  return { ...rest, events, after: null, ...over };
};

let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/sessions/${encodeId(SESSION)}`]}>
          <Routes>
            <Route path="/sessions/:id" element={<GuestSessionView sessionId={encodeId(SESSION)} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const page = () => container.textContent ?? '';
const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const hint = () => q('.guest-composer-hint')?.textContent;

async function typeAndSend(text: string): Promise<void> {
  const box = q<HTMLTextAreaElement>('textarea.guest-composer-input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    q('button.guest-composer-send')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/users/me') return { id: 'u-alice', name: 'Alice Chen', email: 'alice@example.com' };
    throw new Error(`unexpected ${path}`);
  });
  for (const fn of [getGuestSession, getGuestEventsAfter, sendGuestTurn, uploadGuestAttachment]) vi.mocked(fn).mockReset();
  vi.mocked(getGuestEventsAfter).mockImplementation(async () => now('RUNNING', []));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the guest page', { timeout: 30_000 }, () => {
  it('running: Shared by, the status and Guest, the transcript, and a composer of words and images', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    await visit();
    expect(vi.mocked(getGuestSession)).toHaveBeenCalledWith(encodeId(SESSION), 200);
    expect(q('.share-crumb.is-here')?.textContent).toBe('Retry budget for flaky pg specs');
    expect(q('.share-subtitle')?.textContent).toBe('Shared by Lin Wei');
    expect(q('.share-right .status-pill')?.textContent).toBe('Running');
    expect(q('.share-badge')?.textContent).toBe('Guest');
    expect(page()).not.toContain('Read-only');
    // The transcript: the owner's words unheaded, the reader's own headed You, another guest's From <name>.
    const heads = [...container.querySelectorAll('.chat-user-from')].map((el) => el.textContent);
    expect(heads).toEqual(['You', 'From Ravi Kumar']);
    expect(page()).toContain('Can we give pg specs a retry budget');
    expect(page()).toContain('at most twice');
    // Words, an image picker and Send, nothing else: no mode, model or effort chips, no other files.
    const form = q('form.guest-composer')!;
    expect(q<HTMLTextAreaElement>('textarea.guest-composer-input')!.placeholder).toBe('Message Lin Wei’s agent…');
    expect([...form.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Attach image', 'Send']);
    const inputs = [...form.querySelectorAll('input')];
    expect(inputs.map((i) => [i.type, i.accept])).toEqual([['file', 'image/png,image/jpeg,image/webp,image/gif']]);
    expect(hint()).toBe('Runs on Lin Wei’s machine');
    expect(q('.guest-waiting')).toBeNull();
  });

  it('draws a turn’s image through the guest door, never the owner’s /attachments/:id', async () => {
    vi.mocked(fetchAttachmentObjectUrl).mockReset();
    vi.mocked(fetchGuestAttachmentObjectUrl).mockReset();
    vi.mocked(fetchGuestAttachmentObjectUrl).mockResolvedValue('blob:guest-image');
    const shot: SharedEvent = {
      seq: 5, type: 'user', turnId: 't5', ts,
      payload: { text: 'This does not list the sessions', attachments: [{ id: 'att-1', mime: 'image/png', name: 'shot.png' }] },
    };
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING', { events: [...EVENTS, shot] }));
    await visit();
    expect(vi.mocked(fetchGuestAttachmentObjectUrl)).toHaveBeenCalledWith(encodeId(SESSION), 'att-1');
    expect(vi.mocked(fetchAttachmentObjectUrl)).not.toHaveBeenCalled();
    expect(q<HTMLImageElement>('img[src="blob:guest-image"]')).not.toBeNull();
  });

  it('sends text as it is — a leading ! is no shell — and follows the echo and the reply', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    await visit();
    const echo = { ...user(5, '!ls -la', 'Alice Chen'), turnId: 't9' };
    const reply = assistant(6, 'That reads as a message, not a command.');
    vi.mocked(getGuestEventsAfter).mockImplementation(async (_id, { after }) =>
      now('RUNNING', [echo, reply].filter((e) => e.seq > after)),
    );
    await typeAndSend('!ls -la');
    expect(vi.mocked(sendGuestTurn)).toHaveBeenCalledTimes(1);
    const [id, body] = vi.mocked(sendGuestTurn).mock.calls[0]!;
    expect(id).toBe(encodeId(SESSION));
    expect(Object.keys(body).sort()).toEqual(['clientTurnId', 'content']);
    expect(body.content).toBe('!ls -la');
    // Asked at once after the send, from the newest event the page holds.
    expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledWith(encodeId(SESSION), { after: 4, limit: 200 });
    expect(page()).toContain('That reads as a message, not a command.');
    expect([...container.querySelectorAll('.chat-user-from')].map((el) => el.textContent)).toEqual(['You', 'From Ravi Kumar', 'You']);
    expect(q<HTMLTextAreaElement>('textarea.guest-composer-input')!.value).toBe('');
  });

  it('an image picked, previewed and removable, goes out through the guest door with the words', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    vi.mocked(uploadGuestAttachment).mockImplementation(async (_id, file) => ({ id: `id-${file.name}` }));
    URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name}`);
    URL.revokeObjectURL = vi.fn();
    await visit();
    const pick = async (...files: File[]) => {
      const input = q<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, 'files', { value: files, configurable: true });
      await act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await settle();
    };
    await pick(new File([new Uint8Array([1])], 'one.png', { type: 'image/png' }), new File([new Uint8Array([2])], 'two.jpg', { type: 'image/jpeg' }));
    expect(vi.mocked(uploadGuestAttachment).mock.calls.map(([id, f]) => [id, f.name])).toEqual([
      [encodeId(SESSION), 'one.png'], [encodeId(SESSION), 'two.jpg'],
    ]);
    expect([...container.querySelectorAll('.composer-attach img')].map((img) => img.getAttribute('src'))).toEqual(['blob:one.png', 'blob:two.jpg']);
    // Removed before sending: it does not go.
    await act(async () => {
      container.querySelectorAll<HTMLButtonElement>('.composer-attach-remove')[1]!.click();
    });
    expect(container.querySelectorAll('.composer-attach')).toHaveLength(1);
    await typeAndSend('This is what I see');
    const [, body] = vi.mocked(sendGuestTurn).mock.calls[0]!;
    expect(Object.keys(body).sort()).toEqual(['attachmentIds', 'clientTurnId', 'content']);
    expect(body).toMatchObject({ content: 'This is what I see', attachmentIds: ['id-one.png'] });
    expect(container.querySelectorAll('.composer-attach')).toHaveLength(0);
  });

  it('an image pasted or dropped is staged; an image alone may be sent; a file that is no image is not taken', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    vi.mocked(uploadGuestAttachment).mockImplementation(async (_id, file) => ({ id: `id-${file.name}` }));
    URL.createObjectURL = vi.fn((f: Blob) => `blob:${(f as File).name}`);
    URL.revokeObjectURL = vi.fn();
    await visit();
    const send = q<HTMLButtonElement>('button.guest-composer-send')!;
    expect(send.disabled).toBe(true);
    const pasted = new File([new Uint8Array([1])], 'pasted.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => pasted }] } });
    await act(async () => {
      q('textarea.guest-composer-input')!.dispatchEvent(paste);
    });
    await settle();
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    const dropped = new File([new Uint8Array([2])], 'dropped.webp', { type: 'image/webp' });
    const notImage = new File([new Uint8Array([3])], 'notes.pdf', { type: 'application/pdf' });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [dropped, notImage], types: ['Files'] } });
    await act(async () => {
      q('form.guest-composer')!.dispatchEvent(drop);
    });
    await settle();
    expect(vi.mocked(uploadGuestAttachment).mock.calls.map(([, f]) => f.name)).toEqual(['pasted.png', 'dropped.webp']);
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
    });
    await settle();
    expect(vi.mocked(sendGuestTurn).mock.calls[0]![1]).toMatchObject({ content: '', attachmentIds: ['id-pasted.png', 'id-dropped.webp'] });
  });

  it('draws the message the moment Send is pressed, before the door answers', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    let accept!: (answer: { turnId: string; revived: boolean }) => void;
    vi.mocked(sendGuestTurn).mockReturnValue(new Promise((resolve) => { accept = resolve; }));
    await visit();
    await typeAndSend('Ship it on Friday');
    expect(page()).toContain('Ship it on Friday');
    expect([...container.querySelectorAll('.chat-user-from')].map((el) => el.textContent)).toEqual(['You', 'From Ravi Kumar', 'You']);
    expect(q<HTMLTextAreaElement>('textarea.guest-composer-input')!.value).toBe('');
    // The runner's echo replaces it: one bubble, not two.
    vi.mocked(getGuestEventsAfter).mockImplementation(async (_id, { after }) =>
      now('RUNNING', [{ ...user(5, 'Ship it on Friday', 'Alice Chen'), turnId: 't9' }].filter((e) => e.seq > after)),
    );
    accept({ turnId: 't9', revived: false });
    await settle();
    expect(page().split('Ship it on Friday').length - 1).toBe(1);
    expect([...container.querySelectorAll('.chat-user-from')].map((el) => el.textContent)).toEqual(['You', 'From Ravi Kumar', 'You']);
  });

  it('asks again within half a second while its echo is not there yet, not four seconds later', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        void visit();
        await vi.advanceTimersByTimeAsync(10);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(q('textarea.guest-composer-input')).not.toBeNull();
      // The read right after the send comes back before the runner has written the message (production 11-16).
      vi.mocked(getGuestEventsAfter).mockImplementation(async () => now('RUNNING', []));
      const box = q<HTMLTextAreaElement>('textarea.guest-composer-input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Ship it on Friday');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        q('button.guest-composer-send')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(10);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledTimes(1);
      vi.mocked(getGuestEventsAfter).mockImplementation(async () =>
        now('RUNNING', [{ ...user(5, 'Ship it on Friday', 'Alice Chen'), turnId: 't9' }]),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledTimes(2);
      expect(page().split('Ship it on Friday').length - 1).toBe(1);
      // Echoed: back on the working clock.
      vi.mocked(getGuestEventsAfter).mockImplementation(async () => now('RUNNING', []));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a send the door refuses takes its bubble away and puts the words back in the composer', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockRejectedValue(new ApiError('The runner is offline.', 409));
    await visit();
    await typeAndSend('Ship it on Friday');
    expect(q<HTMLTextAreaElement>('textarea.guest-composer-input')!.value).toBe('Ship it on Friday');
    expect([...container.querySelectorAll('.chat-user-from')].map((el) => el.textContent)).toEqual(['You', 'From Ravi Kumar']);
    expect(hint()).toBe('The runner is offline.');
  });

  it('follows a running session on the public page’s clock: asked again after four seconds, the new reply below', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await act(async () => {
        void visit();
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
      vi.mocked(getGuestEventsAfter).mockImplementation(async () => now('RUNNING', [assistant(5, 'Retries are capped at two.')]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledWith(encodeId(SESSION), { after: 4, limit: 200 });
      expect(page()).toContain('Retries are capped at two.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waiting on the owner: Waiting for <owner> to approve, and the composer still takes a message', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('AWAITING_INPUT', { waitingOnOwner: true }));
    await visit();
    expect(q('.guest-waiting')?.textContent).toBe('Waiting for Lin Wei to approve');
    expect(hint()).toBe('Your message waits its turn');
    expect(q<HTMLTextAreaElement>('textarea.guest-composer-input')!.disabled).toBe(false);
  });

  it('idle and waiting for its next message is not waiting on an approval', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('AWAITING_INPUT'));
    await visit();
    expect(q('.guest-waiting')).toBeNull();
    expect(hint()).toBe('Runs on Lin Wei’s machine');
  });

  it('ended: sending restarts the session on the owner’s machine', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('ENDED'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: true });
    await visit();
    expect(hint()).toBe('Send to continue — this restarts the session on Lin Wei’s machine.');
    expect(q('.guest-waiting')).toBeNull();
    // Over: nothing is followed until the guest sends.
    expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
    vi.mocked(getGuestEventsAfter).mockImplementation(async () => now('RUNNING', [user(5, 'One more: log the retry count', 'Alice Chen')]));
    await typeAndSend('One more: log the retry count');
    expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalled();
    expect(q('.share-right .status-pill')?.textContent).toBe('Running');
    expect(hint()).toBe('Runs on Lin Wei’s machine');
  });

  it('removed, left, Trash or deleted: the one page that says it is no longer shared', async () => {
    vi.mocked(getGuestSession).mockRejectedValue(new ApiError('This conversation is no longer shared with you.', 404));
    await visit();
    expect(q('.share-state-title')?.textContent).toBe('This conversation is no longer shared with you.');
    expect(page()).toContain('Ask the person who shared it if you need it again.');
    expect(q('form.guest-composer')).toBeNull();
  });

  it('removed while open: the next read turns the page into the same answer', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    await visit();
    vi.mocked(getGuestEventsAfter).mockRejectedValue(new ApiError('This conversation is no longer shared with you.', 404));
    await typeAndSend('still there?');
    expect(q('.share-state-title')?.textContent).toBe('This conversation is no longer shared with you.');
  });
});

/**
 * The guest stream (docs/session-viewer-stream-design.md §3–§4, §7): with an EventSource, the page follows over
 * `/guest-sessions/:id/stream` rather than asking every few seconds. jsdom has none, so every test above reads the
 * polling follow the page falls back to; here a fake stands in for the browser's.
 */
class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    act(() => this.onopen?.(new Event('open')));
  }
  frame(data: unknown) {
    act(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) })));
  }
  /** What the browser does when the connection drops, or when the answer is no stream at all (a 404, a 429):
   *  EventSource is told nothing but `error`. */
  fail(_status?: number) {
    act(() => this.onerror?.(new Event('error')));
  }
}
const streams = () => FakeEventSource.all;
const lastStream = () => FakeEventSource.all.at(-1)!;
const sinceOf = (es: FakeEventSource) => new URL(es.url, 'http://x').searchParams.get('sinceSeq');
const pill = () => q('.share-right .status-pill')?.textContent;

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** `visit` under fake timers: its settling waits on setTimeout, so the clock is moved for it. */
async function visitWithFakeClock(): Promise<void> {
  await act(async () => {
    void visit();
    await vi.advanceTimersByTimeAsync(10);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
}
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('the guest page over the guest stream', { timeout: 30_000 }, () => {
  beforeEach(() => {
    FakeEventSource.all = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as { hidden?: boolean }).hidden;
    delete (document as { visibilityState?: string }).visibilityState;
  });

  it('opens the guest stream from the newest event on the page, signed in by access_token, and asks nothing', async () => {
    localStorage.setItem('orbit_token', 'tok-1');
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    await visit();
    expect(streams()).toHaveLength(1);
    const url = new URL(lastStream().url, 'http://x');
    expect(url.pathname).toBe(`/api/guest-sessions/${encodeId(SESSION)}/stream`);
    expect(url.searchParams.has('access_token')).toBe(true);
    expect(sinceOf(lastStream())).toBe('4');
    lastStream().open();
    await settle();
    expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
  });

  it('the sent message is drawn at once and replaced once by the echo the stream brings, with no echo polling', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    await visit();
    const es = lastStream();
    es.open();
    await typeAndSend('Ship it on Friday');
    expect(page().split('Ship it on Friday').length - 1).toBe(1);
    expect([...container.querySelectorAll('.chat-user-from')].map((el) => el.textContent)).toEqual(['You', 'From Ravi Kumar', 'You']);
    es.frame({ ...user(5, 'Ship it on Friday', 'Alice Chen'), turnId: 't9' });
    await settle();
    expect(page().split('Ship it on Friday').length - 1).toBe(1);
    expect([...container.querySelectorAll('.chat-user-from')].map((el) => el.textContent)).toEqual(['You', 'From Ravi Kumar', 'You']);
    // The echo came on the stream: nothing was asked for it, then or half a second on.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
    expect(streams()).toHaveLength(1);
  });

  it('the reply appears as it is typed, and the finished message takes the draft’s place', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    await visit();
    const es = lastStream();
    es.open();
    es.frame({ seq: 0, type: 'text_delta', payload: { text: 'Retry only ' } });
    await settle();
    expect(page()).toContain('Retry only');
    es.frame({ seq: 0, type: 'text_delta', payload: { text: 'the flaky ones.' } });
    // The draft is redrawn at most every 90 ms (StreamingMessage).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(page()).toContain('Retry only the flaky ones.');
    es.frame(assistant(5, 'Retry only the flaky ones.'));
    await settle();
    expect(page().split('Retry only the flaky ones.').length - 1).toBe(1);
  });

  it('head frames drive the status pill and the Waiting for <owner> to approve line', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    await visit();
    const es = lastStream();
    es.open();
    expect(pill()).toBe('Running');
    expect(q('.guest-waiting')).toBeNull();
    const { events: _e, after: _a, ...running } = now('RUNNING', []);
    es.frame({ seq: 0, type: 'head', payload: { ...running, waitingOnOwner: true } });
    await settle();
    expect(q('.guest-waiting')?.textContent).toBe('Waiting for Lin Wei to approve');
    expect(hint()).toBe('Your message waits its turn');
    const { events: _e2, after: _a2, ...ended } = now('ENDED', []);
    es.frame({ seq: 0, type: 'head', payload: { ...ended, waitingOnOwner: false } });
    await settle();
    expect(q('.guest-waiting')).toBeNull();
    expect(pill()).not.toBe('Running');
    expect(hint()).toBe('Send to continue — this restarts the session on Lin Wei’s machine.');
    expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
  });

  it('a dropped stream is opened again from the newest seq read, after a backoff', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await visitWithFakeClock();
      const first = lastStream();
      first.open();
      first.frame(assistant(5, 'First half.'));
      first.fail();
      expect(first.closed).toBe(true);
      await tick(900);
      expect(streams()).toHaveLength(1);
      await tick(400);
      expect(streams()).toHaveLength(2);
      expect(sinceOf(lastStream())).toBe('5');
      // That reopen fails too: the next waits twice as long.
      lastStream().fail();
      await tick(1_900);
      expect(streams()).toHaveLength(2);
      await tick(400);
      expect(streams()).toHaveLength(3);
      lastStream().open();
      lastStream().frame(assistant(6, 'Second half.'));
      expect(page()).toContain('First half.');
      expect(page()).toContain('Second half.');
      expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hidden tab closes the stream, and returning opens it again from where it was', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    await visit();
    const first = lastStream();
    first.open();
    first.frame(assistant(5, 'Before you looked away.'));
    setHidden(true);
    expect(first.closed).toBe(true);
    await settle();
    expect(streams()).toHaveLength(1);
    expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
    setHidden(false);
    await settle();
    expect(streams()).toHaveLength(2);
    expect(sinceOf(lastStream())).toBe('5');
  });

  it('gone: the stream ends and the page says it is no longer shared', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    await visit();
    const es = lastStream();
    es.open();
    es.frame({ type: 'gone' });
    await settle();
    expect(es.closed).toBe(true);
    expect(q('.share-state-title')?.textContent).toBe(GUEST_NOT_SHARED);
    expect(q('form.guest-composer')).toBeNull();
  });

  it('a stream refused with 429 falls back to polling on the working clock', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await visitWithFakeClock();
      lastStream().fail(429);
      vi.mocked(getGuestEventsAfter).mockImplementation(async (_id, { after }) =>
        now('RUNNING', [assistant(5, 'Polled in.')].filter((e) => e.seq > after)),
      );
      await tick(3_900);
      expect(vi.mocked(getGuestEventsAfter)).not.toHaveBeenCalled();
      await tick(200);
      expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledWith(encodeId(SESSION), { after: 4, limit: 200 });
      expect(page()).toContain('Polled in.');
      // Polling now: no stream is opened again.
      await tick(60_000);
      expect(streams()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a server without the stream (404) falls back to polling, the half-second echo polling included', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await visitWithFakeClock();
      lastStream().fail(404);
      await tick(10);
      vi.mocked(getGuestEventsAfter).mockImplementation(async () => now('RUNNING', []));
      const box = q<HTMLTextAreaElement>('textarea.guest-composer-input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Ship it on Friday');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        q('button.guest-composer-send')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(10);
      });
      await tick(10);
      expect(page()).toContain('Ship it on Friday');
      expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledTimes(1);
      vi.mocked(getGuestEventsAfter).mockImplementation(async () =>
        now('RUNNING', [{ ...user(5, 'Ship it on Friday', 'Alice Chen'), turnId: 't9' }]),
      );
      await tick(500);
      expect(vi.mocked(getGuestEventsAfter)).toHaveBeenCalledTimes(2);
      expect(page().split('Ship it on Friday').length - 1).toBe(1);
      expect(streams()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the guest page’s first address', () => {
  it('`/g/<id>` goes to `/sessions/<id>`, the one address a shared session has (board 11, D8)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const id = encodeId(SESSION);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/g/${id}`]}>
          <Routes>
            <Route path="/g/:sessionId" element={<GuestLinkRedirect />} />
            <Route path="/sessions/:id" element={<div id="landed">landed</div>} />
          </Routes>
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('#landed')).not.toBeNull();
  });
});
