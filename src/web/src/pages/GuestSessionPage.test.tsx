// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestSession, GuestSessionNow, SharedEvent } from '../api';

/**
 * The guest page, `/g/<sessionId>` (docs/session-guests-design.md §4; board docs/mocks/share-links/10-session-guests-3),
 * mounted whole on its route over the guest door: the frame says who shared it, how it stands and that the reader is
 * a Guest; the composer only takes text and says where it runs; the session waiting on its owner, having ended, and
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
}));
const { api, ApiError, getGuestSession, getGuestEventsAfter, sendGuestTurn } = await import('../api');
const { GuestSessionPage } = await import('./GuestSessionPage');
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
        <MemoryRouter initialEntries={[`/g/${encodeId(SESSION)}`]}>
          <Routes>
            <Route path="/g/:sessionId" element={<GuestSessionPage />} />
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
  for (const fn of [getGuestSession, getGuestEventsAfter, sendGuestTurn]) vi.mocked(fn).mockReset();
  vi.mocked(getGuestEventsAfter).mockImplementation(async () => now('RUNNING', []));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the guest page', { timeout: 30_000 }, () => {
  it('running: Shared by, the status and Guest, the transcript, and a composer that only takes text', async () => {
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
    // Text and Send, nothing else: no mode, model or effort chips, no attachments.
    const form = q('form.guest-composer')!;
    expect(q<HTMLTextAreaElement>('textarea.guest-composer-input')!.placeholder).toBe('Message Lin Wei’s agent…');
    expect([...form.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Send']);
    expect(form.querySelector('input')).toBeNull();
    expect(hint()).toBe('Runs on Lin Wei’s machine');
    expect(q('.guest-waiting')).toBeNull();
  });

  it('sends text as it is — a leading ! is no shell — and follows the echo and the reply', async () => {
    vi.mocked(getGuestSession).mockResolvedValue(head('RUNNING'));
    vi.mocked(sendGuestTurn).mockResolvedValue({ turnId: 't9', revived: false });
    await visit();
    const echo = user(5, '!ls -la', 'Alice Chen');
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
