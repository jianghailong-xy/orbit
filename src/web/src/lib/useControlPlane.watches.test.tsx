// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { watchQuery, watchesQuery } from './queries';

/**
 * The watches read rides the control-plane stream as a refetch nudge, never as data.
 *
 * Two kinds of event reach it. A `watch.changed` NAMES a watch and arrives after the server already
 * moved it (docs/watch-contract.md §8.1): a delivery, a deadline, a dead letter, an agent making or
 * releasing one — none of which writes a task or a session row, so before this event the list found
 * them only on its 60s poll. A session's, an approval's or a task's event names no watch: it moves a
 * watch card only when it is about one of the watch's targets, whose standing the card draws from
 * the same read (`targetStatus`, `targetTask`), so only those re-read it, once. A watch the evaluator
 * moves after such an event arrives as its own `watch.changed`. The library events that can move no
 * watch leave it alone. Mounted over a fake EventSource, read off the cache's own `isInvalidated`
 * flag with keys from the factory the pages use.
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

const WATCHES: QueryKey = watchesQuery().queryKey;
const ONE_WATCH: QueryKey = watchQuery('W1').queryKey;
const TAGS: QueryKey = ['session-tags'];
const TASKS: QueryKey = ['tasks'];
const SESSIONS: QueryKey = ['sessions'];

/** A watch on hand that follows session S1, and session S2 whose run is task T2, and task T1. */
const FOLLOWING = [{
  id: 'W1',
  targets: [
    { targetKind: 'SESSION', targetResourceId: 'S1' },
    { targetKind: 'SESSION', targetResourceId: 'S2', targetTask: { id: 'T2' } },
    { targetKind: 'TASK', targetResourceId: 'T1' },
  ],
}];

const frame = (type: string, data: Record<string, unknown>, sessionId = '') => ({
  type,
  sessionId,
  agentId: null,
  ts: '2026-09-14T12:00:00.000Z',
  data,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Seeds a cached read with the declaration its real counterpart makes: the stream selects on
 *  `meta.entities`, and a bare `setQueryData` creates an entry that declares nothing. */
function seed(client: QueryClient, key: QueryKey, data: unknown): void {
  const entities = key[0] === 'watches' ? ['watch', 'session', 'task']
    : key[0] === 'session-tags' ? ['tag']
    : key[0] === 'tasks' ? ['task']
    : ['session', 'workspace', 'tag', 'folder', 'project'];
  client.getQueryCache().build(client, { queryKey: key, meta: { entities } });
  client.setQueryData(key, data);
}

async function mount(keys: QueryKey[]): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded rather than fetched: a read with no observer is only marked by an invalidation, never
  // refetched, so the flag is the provider's doing and nothing else's.
  for (const key of keys) seed(client, key, key === WATCHES ? FOLLOWING : []);
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
  return client;
}

async function publish(event: Record<string, unknown>): Promise<void> {
  let stream: FakeEventSource | undefined;
  await vi.waitFor(
    () => {
      stream = FakeEventSource.open.find((es) => !es.closed && es.url.startsWith('/api/events'));
      expect(stream, 'the control plane opened no event stream').toBeTruthy();
    },
    { timeout: 5_000, interval: 20 },
  );
  await act(async () => {
    stream!.onmessage?.({ data: JSON.stringify(event) });
  });
}

const invalidated = (client: QueryClient, key: QueryKey): boolean =>
  client.getQueryState(key)?.isInvalidated === true;

async function untilInvalidated(client: QueryClient, key: QueryKey, timeout = 5_000): Promise<void> {
  await vi.waitFor(
    () => expect(invalidated(client, key), `${JSON.stringify(key)} was never invalidated`).toBe(true),
    { timeout, interval: 20 },
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('the watches read rides the control-plane stream', () => {
  it('a session.updated about a followed session invalidates the watches, and only once', async () => {
    const client = await mount([WATCHES, SESSIONS]);

    await publish(frame('session.updated', { id: 'S1', status: 'AWAITING_INPUT' }, 'S1'));
    await untilInvalidated(client, WATCHES);

    // Read again, as an observer would: no second look comes for the same event.
    client.setQueryData(WATCHES, FOLLOWING);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(invalidated(client, WATCHES), 'the watches were read a second time for one event').toBe(false);
  }, 10_000);

  it('a session.updated about a session no watch follows leaves the watches alone', async () => {
    const client = await mount([WATCHES, SESSIONS]);

    await publish(frame('session.updated', { id: 'S9', status: 'AWAITING_INPUT' }, 'S9'));
    // The positive this negative is paired with: the flush ran and reached the sessions.
    await untilInvalidated(client, SESSIONS);
    expect(invalidated(client, WATCHES)).toBe(false);
  });

  it('an approval and a task change about what a watch follows invalidate the watches too', async () => {
    const client = await mount([WATCHES, TASKS]);

    await publish(frame('approval.requested', { id: 'A1' }, 'S1'));
    await untilInvalidated(client, WATCHES);

    client.setQueryData(WATCHES, FOLLOWING);
    await publish(frame('task.changed', { taskId: 'T1', taskIds: ['T1'], resync: false }));
    await untilInvalidated(client, WATCHES);

    // A followed session's own task, as the watch names it.
    client.setQueryData(WATCHES, FOLLOWING);
    await publish(frame('task.changed', { taskIds: ['T2'], resync: false }));
    await untilInvalidated(client, WATCHES);

    // A task no watch follows reaches the task lists and not the watches.
    client.setQueryData(WATCHES, FOLLOWING);
    client.setQueryData(TASKS, []);
    await publish(frame('task.changed', { taskId: 'T9', taskIds: ['T9'], resync: false }));
    await untilInvalidated(client, TASKS);
    expect(invalidated(client, WATCHES)).toBe(false);
  });

  it('a watch.changed re-reads the watches at once, without the 60s poll', async () => {
    const client = await mount([WATCHES, ONE_WATCH]);

    // What the server sends for a NOTIFY_USER delivery, an expiry, a dead letter, or an agent
    // making or releasing a watch: the watch's id and nothing else about it.
    await publish(frame('watch.changed', { id: 'W1' }));
    await untilInvalidated(client, WATCHES);
    // The whole group, so a wake card drawn from `['watches', 'one', id]` is re-read with the list.
    await untilInvalidated(client, ONE_WATCH);
  });

  it('a watch.changed re-reads only the watches', async () => {
    const client = await mount([WATCHES, SESSIONS, TASKS]);

    await publish(frame('watch.changed', { id: 'W1' }));
    await untilInvalidated(client, WATCHES);

    // The nudge says a watch moved, and says nothing about a session or a task: re-reading those
    // would be work the event gives no reason for.
    expect(invalidated(client, SESSIONS)).toBe(false);
    expect(invalidated(client, TASKS)).toBe(false);
  });

  it('keeps the 60s poll the event only accelerates', () => {
    // The nudge is an accelerant with no delivery guarantee (docs/watch-contract.md §8.1): a replica
    // restarting or a socket going quiet drops it without a word, and the read may not go a minute
    // stale for that. Asserted here because this is the file that would otherwise make the poll look
    // redundant.
    expect(watchesQuery().refetchInterval).toBe(60_000);
  });

  it('library events leave the watches alone', async () => {
    const client = await mount([WATCHES, TAGS, TASKS]);

    await publish(frame('tag.changed', { id: 'tag-1' }));
    await publish(frame('task.list.changed', { id: 'list-1' }));

    // The positives these negatives are paired with: the flush ran and reached what the events name.
    await untilInvalidated(client, TAGS);
    await untilInvalidated(client, TASKS);
    expect(invalidated(client, WATCHES)).toBe(false);
  });
});
