// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * A tab whose control-plane stream keeps failing must not stop asking for it. While the stream is
 * down the session lists poll every project every 4 s, and a tab that gave up after twenty failures
 * stayed on those polls until it was reloaded: on 2026-10-20 one such tab, 42 projects deep, was
 * most of production's database time. Past the quick retries the stream is asked for once a minute,
 * and at once when the tab comes back into view or the browser back online.
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider>
          <div />
        </ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
}

const streams = (): number => FakeEventSource.open.length;
const latest = (): FakeEventSource => FakeEventSource.open[FakeEventSource.open.length - 1];

const fail = (): Promise<void> => act(async () => latest().onerror?.());
const wait = (ms: number): Promise<void> => act(async () => {
  vi.advanceTimersByTime(ms);
});

/** Twenty failures in a row, each retried: every quick retry spent (backoff ≤ 15 s plus jitter). */
async function spendQuickRetries(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await fail();
    await wait(15_500);
  }
  expect(streams()).toBe(21);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(async () => {
  try {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
  } finally {
    container?.remove();
    container = null;
    root = null;
    FakeEventSource.open = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('the control-plane stream is never given up on', () => {
  it('is asked for once a minute after twenty failures in a row', async () => {
    await mount();
    await spendQuickRetries();
    await fail();
    await wait(59_000);
    expect(streams(), 'asked again before the minute was up').toBe(21);
    await wait(1_500);
    expect(streams(), 'gave up on the stream').toBe(22);
    await fail();
    await wait(60_500);
    expect(streams(), 'stopped after one slow retry').toBe(23);
  });

  it('is asked for at once when the tab comes back into view or the browser back online', async () => {
    await mount();
    await spendQuickRetries();
    await fail();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(streams(), 'coming back into view waited out the retry').toBe(22);
    await fail();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(streams(), 'coming back online waited out the retry').toBe(23);
    // A tab going out of view waits for its retry like before.
    visibility.mockReturnValue('hidden');
    await fail();
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(streams()).toBe(23);
  });

  it('backs off a stream that keeps opening and dying before its first message', async () => {
    await mount();
    for (let failure = 1; failure <= 5; failure += 1) {
      await act(async () => latest().onopen?.());
      await fail();
      await wait(1000 * failure - 1);
      expect(streams(), `asked again before the backoff of failure ${failure} was up`).toBe(failure);
      await wait(501);
      expect(streams()).toBe(failure + 1);
    }
    // Something came down the stream: the next failure starts the backoff over.
    await act(async () => latest().onopen?.());
    await act(async () => latest().onmessage?.({ data: JSON.stringify({ type: 'ping' }) }));
    await fail();
    await wait(1_500);
    expect(streams(), 'a stream that delivered a message still waited out the long backoff').toBe(7);
  });

  it('leaves a stream that is open alone', async () => {
    await mount();
    await act(async () => latest().onopen?.());
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
    });
    expect(streams()).toBe(1);
  });
});
