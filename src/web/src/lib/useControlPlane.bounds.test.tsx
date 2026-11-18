// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * How much a burst of control events may cost now that the stream selects reads by their
 * `meta.entities` declaration instead of by key prefixes. Predicate invalidation scans the cache
 * (useControlPlane's `derivedFrom`) rather than walking an index of prefixes, and an event reaches
 * every read that names its entity instead of the few a hand-kept list remembered — so the two
 * bounds the prefix whitelists gave for free are asserted here, because nothing in the new
 * selection shape enforces them:
 *
 *   1. A burst is still COALESCED: `REFRESH_DEBOUNCE_MS` folds any number of events arriving in
 *      one window into one read of a query the burst reaches.
 *   2. A read whose declaration does not name the entity is NOT re-read: a `task.*` event leaves a
 *      project-page read that declares no `task` alone.
 *
 * Both are assertions that something did not happen, and both would pass with the whole push chain
 * dead. Each test therefore carries a sibling in the same fixture that must produce: the coalescing
 * test's query has to be read exactly once (not zero, not five), and the untouched project-page read
 * stands beside a project-page read that declares `task` and has to be read. The coalescing query
 * is deliberately not a project-page one: a project-page read is additionally held to one read per
 * `PROJECT_PAGE_MIN_INTERVAL_MS`, and the floor must not be what makes a five-event burst look
 * coalesced. That floor is a second, separate gate; this file does not need it to pass here.
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

/** A read on screen whose requests the test counts. */
interface Read {
  /** Requests made so far. */
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

/** Puts a read on screen, cached already, so it asks for nothing until the stream nudges it. The
 *  `entities` are the query's own declaration, as its real counterpart makes it. Every request
 *  answers at once: a request left out would swallow the next nudge into React Query's own
 *  in-flight dedupe, and a burst that reached the query five times would then count once. */
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

describe('a burst of task events stays bounded', () => {
  it('reads a task-declaring query once for five events — not never, not five times', async () => {
    const client = await mount();
    // The active strip above the task list (`activeTasksQuery`): a `task`-declaring read whose key
    // root is not `project`, so the project page's own gate is not what holds it back here.
    const strip = onScreen(client, ['tasks', 'active', null], ['task', 'session']);

    // Five events inside one coalescing window — the shape of a run writing tasks in bulk.
    for (const type of ['task.changed', 'task.list.changed', 'task.changed', 'task.list.changed', 'task.changed']) {
      await publish(type, { taskIds: ['t1'] });
      await advance(0);
    }
    await advance(1_100);

    expect(
      strip.asked,
      'the burst never reached the strip: the push chain is dead and the "only once" below proves nothing',
    ).toBeGreaterThanOrEqual(1);
    expect(strip.asked, 'five events were read as five rounds instead of one').toBe(1);

    // Nothing trails the window: the burst is one read in total.
    await advance(5_000);
    expect(strip.asked, 'a read followed the coalesced window').toBe(1);
  });

  it('reads a project-page read that declares task, and leaves a project-page read that does not alone', async () => {
    const client = await mount();
    // Two reads on the same project page, as the page declares them: the task tree derives from
    // `task` (and `session`), while the coordinator status card derives from `project` and
    // `session` — a task event says nothing about it.
    const tree = onScreen(client, ['project', 'p1', 'tasks', 'root'], ['task', 'session']);
    const status = onScreen(client, ['project', 'p1', 'coordinator', 'status'], ['project', 'session']);

    await publish('task.changed', { taskIds: ['t1'] });
    await publish('task.changed', { taskIds: ['t2'] });
    await advance(1_100);

    expect(
      status.asked,
      'a project-page read that declares no task was re-read on a task event',
    ).toBe(0);
    expect(
      tree.asked,
      'the task tree was not re-read: the silence above would pass with the project-page path dead',
    ).toBe(1);

    // The page is not read again for the burst, and the unrelated read stays untouched.
    await advance(5_000);
    expect(status.asked, 'a read followed the task events on an unrelated project-page query').toBe(0);
    expect(tree.asked, 'the page was read more than once for the burst').toBe(1);
  });
});
