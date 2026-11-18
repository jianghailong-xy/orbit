// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * The guest view of a session shared with this reader (`guestSessionQuery`, GuestSessionPage) declares `session`,
 * which is what it derives from, and the stream still leaves it alone. The page follows that session over the guest
 * door's own stream and keeps what the stream adds below the page this read returned: read again, the page comes
 * back holding those events too, and they are drawn twice. The events on this tab's stream are the reader's own
 * sessions', never the one shared with them, so neither an event nor a reconnect reads it.
 *
 * Both assertions are about a read that did not happen, so each test has a sibling that has to: a session read on
 * the same screen, which the same event (or the same reconnect) must read once.
 */

vi.mock('../api', () => ({ getToken: () => 'token' }));

class FakeEventSource {
  static open: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.open.push(this);
  }
  close() {
    this.closed = true;
  }
}

interface Read {
  asked: number;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let observers: Array<() => void> = [];

async function mount(): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider><div /></ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  return client;
}

/** A read on screen, cached already, so it asks for nothing until the stream nudges it. */
function onScreen(client: QueryClient, key: QueryKey, entities: string[]): Read {
  const read: Read = { asked: 0 };
  client.setQueryData(key, []);
  const observer = new QueryObserver(client, {
    queryKey: key,
    meta: { entities },
    queryFn: () => {
      read.asked += 1;
      return Promise.resolve([]);
    },
    staleTime: Infinity,
  });
  observers.push(observer.subscribe(() => {}));
  return read;
}

const latest = (): FakeEventSource => FakeEventSource.open[FakeEventSource.open.length - 1];

async function publish(type: string, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    latest().onmessage?.({ data: JSON.stringify({ type, sessionId: 'S1', data }) });
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(async () => {
  try {
    for (const unsubscribe of observers) unsubscribe();
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
  } finally {
    observers = [];
    container?.remove();
    container = null;
    root = null;
    FakeEventSource.open = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('the guest view is followed by its own stream, not by the control plane', () => {
  it('a session event reads the session reads on screen and leaves the guest view alone', async () => {
    const client = await mount();
    const guest = onScreen(client, ['guest-session', 'G1'], ['session']);
    // /help → Your questions: a session read beside it, which a session event has to read.
    const questions = onScreen(client, ['sessions', 'help-ask'], ['session']);

    await publish('session.updated', { id: 'S1' });
    await advance(1_100);

    expect(questions.asked, 'the session event read nothing: the silence below proves nothing').toBe(1);
    expect(guest.asked, "the guest view was read again on one of the reader's own sessions' events").toBe(0);
  });

  it('a stream reopened after a gap reads what is on screen again, but not the guest view', async () => {
    const client = await mount();
    await act(async () => latest().onopen?.());
    const guest = onScreen(client, ['guest-session', 'G1'], ['session']);
    const questions = onScreen(client, ['sessions', 'help-ask'], ['session']);

    await act(async () => latest().onerror?.());
    await advance(2_000); // the first retry's backoff
    await act(async () => latest().onopen?.());
    await advance(0);

    expect(questions.asked, 'the reconnect read nothing again: the silence below proves nothing').toBe(1);
    expect(guest.asked, 'the reconnect read the guest view again').toBe(0);
  });
});
