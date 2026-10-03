// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * The owner's session folders ride the control-plane stream as a refetch nudge. A `folder.changed`
 * says a folder was made, renamed or deleted on some client; nothing else re-reads the folder list,
 * which doesn't poll. The session lists come with it, since a deleted folder's sessions are back in
 * their workspace's list. Filing a session moves one row and arrives as `session.updated` instead.
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

const FOLDERS: QueryKey = ['session-folders'];
const SESSIONS: QueryKey = ['sessions'];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(keys: QueryKey[]): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded rather than fetched: a read with no observer is only marked by an invalidation.
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

async function publish(type: string, sessionId = ''): Promise<void> {
  let stream: FakeEventSource | undefined;
  await vi.waitFor(
    () => {
      stream = FakeEventSource.open.find((es) => !es.closed && es.url.startsWith('/api/events'));
      expect(stream, 'the control plane opened no event stream').toBeTruthy();
    },
    { timeout: 5_000, interval: 20 },
  );
  await act(async () => {
    stream!.onmessage?.({
      data: JSON.stringify({ type, sessionId, agentId: null, ts: '2026-10-03T12:00:00.000Z', data: { id: 'F1' } }),
    });
  });
}

const invalidated = (client: QueryClient, key: QueryKey): boolean =>
  client.getQueryState(key)?.isInvalidated === true;

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

describe('session folders ride the control-plane stream', () => {
  it('a folder.changed re-reads the folders and the session lists', async () => {
    const client = await mount([FOLDERS, SESSIONS]);
    await publish('folder.changed');
    await vi.waitFor(() => {
      expect(invalidated(client, FOLDERS)).toBe(true);
      expect(invalidated(client, SESSIONS)).toBe(true);
    }, { timeout: 5_000, interval: 20 });
  });

  it('a session moving between folders re-reads the lists, not the folders', async () => {
    const client = await mount([FOLDERS, SESSIONS]);
    await publish('session.updated', 'S1');
    await vi.waitFor(() => expect(invalidated(client, SESSIONS)).toBe(true), { timeout: 5_000, interval: 20 });
    expect(invalidated(client, FOLDERS)).toBe(false);
  });
});
