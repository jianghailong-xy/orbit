// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * The wiki reads ride the control-plane stream as a refetch nudge, never as data.
 *
 * A `wiki.changed` names a SPACE and arrives after the write that moved it committed: a changeset
 * recorded, or the owner's own decision in Review (contract `realtime`). It says only that — no
 * entry, title, status, op or count — so what it re-reads is the whole wiki group and nothing else.
 *
 * The group is named explicitly because `groupsFor`'s default branch is `['sessions']`: unmapped, a
 * wiki write would re-read a session list the event says nothing about, which is the one thing this
 * event must not do. Mounted over a fake EventSource, read off the cache's own `isInvalidated` flag.
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

const WIKI: QueryKey = ['wiki'];
// Any one read inside the group — a space's entries, one entry, the Review queue, wherever T8's
// pages key them. Prefix invalidation is what makes one nudge reach every wiki view on screen, so
// the assertion holds whatever the inner segments are named.
const ONE_WIKI_READ: QueryKey = ['wiki', 'review'];
const SESSIONS: QueryKey = ['sessions'];
const TASKS: QueryKey = ['tasks'];

const frame = (type: string, data: Record<string, unknown>, sessionId = '') => ({
  type,
  sessionId,
  agentId: null,
  ts: '2026-09-25T12:00:00.000Z',
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

describe('the wiki reads ride the control-plane stream', () => {
  it('a wiki.changed re-reads the whole wiki group at once', async () => {
    const client = await mount([WIKI, ONE_WIKI_READ]);

    // What the server sends for a recorded changeset or for the owner's decision in Review: the
    // space's id and nothing else about it.
    await publish(frame('wiki.changed', { id: 'SP1' }));
    await untilInvalidated(client, WIKI);
    await untilInvalidated(client, ONE_WIKI_READ);
  });

  it('a wiki.changed re-reads the wiki group, and NOT the sessions the default branch names', async () => {
    const client = await mount([WIKI, SESSIONS, TASKS]);

    await publish(frame('wiki.changed', { id: 'SP1' }));
    await untilInvalidated(client, WIKI);

    // The whole point of naming the group: an unmapped `wiki.` event falls through to `['sessions']`,
    // and a wiki write would re-read a session list it says nothing about.
    expect(invalidated(client, SESSIONS)).toBe(false);
    expect(invalidated(client, TASKS)).toBe(false);
  });

  it('no other event re-reads the wiki', async () => {
    const client = await mount([WIKI, SESSIONS]);

    await publish(frame('session.updated', { id: 'S1', status: 'AWAITING_INPUT' }, 'S1'));

    // Paired with the positive that proves the flush ran and reached what the event does name.
    await untilInvalidated(client, SESSIONS);
    expect(invalidated(client, WIKI)).toBe(false);
  });
});
