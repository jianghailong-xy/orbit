// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * The project page's own reads — the task tree, a task's children, and the project detail (with its
 * `tasksByStatus` counts) — are read only when the stream asks for them: none of them polls. The
 * events that move them name a task (`task.changed`) or a member session (`session.*` with a
 * `projectMembership`), so `refetchProjectPages` is the only path that can reach them; a read that
 * declares itself derived from neither entity stays stale until the page is reloaded (the
 * 2026-11-13 report: a task started by the Automatic dispatcher stayed `ready` on screen).
 *
 * What the path selects is each query's own `meta.entities` declaration — not the shape of its key.
 * Every query below is synthetic, so each carries the declaration its real counterpart does.
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

/** A read on screen whose requests the test answers by hand. */
interface Read {
  /** Requests made so far. */
  asked: number;
  /** Requests made and not answered yet. */
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

/** Puts a read on screen, cached already, so it asks for nothing until the stream nudges it. The
 *  `entities` are the query's own declaration, as its real counterpart makes it. */
function onScreen(client: QueryClient, key: QueryKey, entities: string[]): Read {
  const pending: Array<() => void> = [];
  const read: Read = {
    asked: 0,
    get out() {
      return pending.length;
    },
    answer: () => pending.shift()?.(),
  };
  client.setQueryData(key, []);
  const observer = new QueryObserver(client, {
    queryKey: key,
    meta: { entities },
    queryFn: () => {
      read.asked += 1;
      return new Promise<never[]>((resolve) => pending.push(() => resolve([])));
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

async function answer(read: Read): Promise<void> {
  await act(async () => {
    read.answer();
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

describe('the stream re-reads the project page on a task event', () => {
  it('reads the task tree, a task\'s children and the project detail once each, and nothing else', async () => {
    const client = await mount();
    const tree = onScreen(client, ['project', 'p1', 'tasks', 'root'], ['task', 'session']);
    const children = onScreen(client, ['project', 'p1', 'tasks', 'children', 't1'], ['task', 'session']);
    const detail = onScreen(client, ['project', 'p1'], ['project', 'task']);
    // A project read that declares no `task`, on screen in the same fixture: the three reads above
    // are what proves the stream ran, so this one's silence means the selection is the declaration
    // and not the key.
    const offList = onScreen(client, ['project', 'p1', 'not-on-the-list'], ['project']);

    await publish('task.changed', { taskIds: ['t1'] });
    await advance(5_000);

    expect(offList.asked, 'a project read that declares no task was re-read').toBe(0);
    expect([tree.asked, children.asked, detail.asked], 'the project page was not read after the task event').toEqual([1, 1, 1]);

    for (const read of [tree, children, detail]) await answer(read);
    await advance(5_000);
    expect([tree.asked, children.asked, detail.asked], 'a project read was asked for more than once').toEqual([1, 1, 1]);
    expect(offList.asked).toBe(0);
  });

  it('reads one project\'s task tree for a member session event, and no other project\'s', async () => {
    const client = await mount();
    const p1Tree = onScreen(client, ['project', 'p1', 'tasks', 'root'], ['task', 'session']);
    const p2Tree = onScreen(client, ['project', 'p2', 'tasks', 'root'], ['task', 'session']);

    await publish('session.updated', { id: 'S1', projectMembership: { projectId: 'p1', role: 'TASK' } });
    await advance(5_000);

    expect(p2Tree.asked, 'an unrelated project\'s task tree was read').toBe(0);
    expect(p1Tree.asked, 'the member project\'s task tree was not read').toBe(1);

    await answer(p1Tree);
    await advance(5_000);
    expect(p1Tree.asked).toBe(1);
    expect(p2Tree.asked).toBe(0);
  });
});
