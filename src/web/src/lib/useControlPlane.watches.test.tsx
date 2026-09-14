// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { watchesQuery } from './queries';

/**
 * The watches read rides the control-plane stream as a refetch nudge, never as data.
 *
 * No event names a watch: what moves one is the evaluator reading a session or task row after the
 * event that hinted at it (docs/watch-contract.md §8). So the events that can move a watch —
 * a session's, an approval's, a task's — invalidate the read at once and again a few seconds later,
 * and the library events that cannot, leave it alone. Mounted over a fake EventSource, read off the
 * cache's own `isInvalidated` flag with keys from the factory the pages use.
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
const TAGS: QueryKey = ['session-tags'];
const TASKS: QueryKey = ['tasks'];

const frame = (type: string, data: Record<string, unknown>, sessionId = '') => ({
  type,
  sessionId,
  agentId: null,
  ts: '2026-09-14T12:00:00.000Z',
  data,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(keys: QueryKey[]): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded rather than fetched: a read with no observer is only marked by an invalidation, never
  // refetched, so the flag is the provider's doing and nothing else's.
  for (const key of keys) client.setQueryData(key, []);
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

describe('the watches read rides the control-plane stream', { timeout: 30_000 }, () => {
  it('session.updated invalidates the watches, and again once the evaluation it set off can have landed', async () => {
    const client = await mount([WATCHES]);

    await publish(frame('session.updated', { id: 'S1', status: 'AWAITING_INPUT' }, 'S1'));
    await untilInvalidated(client, WATCHES);

    // Read again, as an observer would, and the second look still comes.
    client.setQueryData(WATCHES, []);
    expect(invalidated(client, WATCHES)).toBe(false);
    await untilInvalidated(client, WATCHES, 8_000);
  });

  it('an approval and a task change invalidate the watches too', async () => {
    const client = await mount([WATCHES]);

    await publish(frame('approval.requested', { id: 'A1' }, 'S1'));
    await untilInvalidated(client, WATCHES);

    client.setQueryData(WATCHES, []);
    await publish(frame('task.changed', { taskId: 'T1', taskIds: ['T1'], resync: false }));
    await untilInvalidated(client, WATCHES);
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
