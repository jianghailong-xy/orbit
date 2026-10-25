// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * What a reconnect and a burst of events cost the server. On 2026-10-25 at 01:01Z one tab's stream
 * reconnected and its refetch went out in the same instant: every list, and one read per project the
 * workspace list shows. Each event that followed asked for the Open list again while the last read
 * was still out, and since no queryFn reads the abort signal, the server built every one of them.
 * Most requests from every client were slow for that minute. Both now go a few at a time, and a list
 * is never asked for twice at once.
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

/** A list on screen whose reads the test answers by hand. */
interface List {
  /** Reads asked for so far. */
  asked: number;
  /** Reads asked for and not answered yet. */
  readonly out: number;
  answer(): void;
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

/** Puts a list on screen: cached already, so it reads only when the stream asks it to, or, with
 *  `cached: false`, as a page load does, with its first read out. */
function onScreen(client: QueryClient, key: QueryKey, { cached = true } = {}): List {
  const pending: Array<() => void> = [];
  const list: List = {
    asked: 0,
    get out() {
      return pending.length;
    },
    answer: () => pending.shift()?.(),
  };
  if (cached) client.setQueryData(key, []);
  const observer = new QueryObserver(client, {
    queryKey: key,
    queryFn: () => {
      list.asked += 1;
      return new Promise<never[]>((resolve) => pending.push(() => resolve([])));
    },
    staleTime: Infinity,
  });
  observers.push(observer.subscribe(() => {}));
  return list;
}

const reconnect = (): Promise<void> => act(async () => FakeEventSource.open[0].onopen?.());

async function publish(type: string, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    FakeEventSource.open[0].onmessage?.({ data: JSON.stringify({ type, sessionId: 'S1', data }) });
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function answer(list: List): Promise<void> {
  await act(async () => {
    list.answer();
    await vi.advanceTimersByTimeAsync(0);
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

describe('the stream reaches the server a few reads at a time', () => {
  it('reconciles a large workspace after a reconnect without sending every read at once', async () => {
    const client = await mount();
    const workspace = onScreen(client, ['sessions', 'R1', 'W1', 'open', null, null]);
    const projects = Array.from({ length: 42 }, (_, i) => onScreen(client, ['project-sessions', `P${i}`, 'open', false]));
    const lists = [workspace, ...projects];
    const out = (): number => lists.reduce((n, list) => n + list.out, 0);

    await reconnect();
    expect(out(), 'the reconnect sent every read at once').toBeLessThanOrEqual(4);
    expect(workspace.asked, 'the workspace list waited behind the project reads').toBe(1);

    let mostOut = out();
    for (let round = 0; round < 100 && out() > 0; round += 1) {
      await answer(lists.find((list) => list.out > 0)!);
      mostOut = Math.max(mostOut, out());
    }
    expect(mostOut).toBeLessThanOrEqual(4);
    expect(out()).toBe(0);
    expect(lists.map((list) => list.asked), 'a list was not reconciled exactly once').toEqual(lists.map(() => 1));
  });

  it('asks again once after a read lands, however many events came while it was out', async () => {
    const client = await mount();
    const workspace = onScreen(client, ['sessions', 'R1', 'W1', 'open', null, null]);

    await reconnect();
    expect(workspace.asked).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      await publish('session.updated', { id: 'S1' });
      await advance(600);
    }
    expect(workspace.asked, 'an event asked for the list again while its read was out').toBe(1);

    await answer(workspace);
    expect(workspace.asked, 'the events that came during the read were dropped').toBe(2);
    await answer(workspace);
    expect(workspace.asked).toBe(2);
    expect(workspace.out).toBe(0);
  });

  it('leaves a page load\'s first reads to themselves when the stream opens', async () => {
    const client = await mount();
    const projects = Array.from({ length: 6 }, (_, i) => onScreen(client, ['project-sessions', `P${i}`, 'open', false], { cached: false }));
    expect(projects.map((list) => list.asked)).toEqual([1, 1, 1, 1, 1, 1]);

    await reconnect();
    for (const list of projects) await answer(list);
    expect(projects.map((list) => list.asked), 'the stream opening read the page a second time').toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('lets a read that started after the event answer it', async () => {
    const client = await mount();
    const projects = Array.from({ length: 6 }, (_, i) => onScreen(client, ['project-sessions', `P${i}`, 'open', false]));

    await reconnect();
    // Four are out; the last two wait their turn, and a poll reads one of them meanwhile.
    expect(projects.map((list) => list.asked)).toEqual([1, 1, 1, 1, 0, 0]);
    await act(async () => {
      void client.refetchQueries({ queryKey: ['project-sessions', 'P5', 'open', false], exact: true });
    });
    expect(projects[5].asked).toBe(1);
    for (const list of projects.slice(0, 4)) await answer(list);
    await answer(projects[5]);
    await answer(projects[4]);
    expect(projects.map((list) => list.asked), 'a list already read afresh was asked for again').toEqual([1, 1, 1, 1, 1, 1]);
  });
});
