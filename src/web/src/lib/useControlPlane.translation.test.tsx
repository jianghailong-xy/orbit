// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';

/**
 * The translator circuit breaker (docs/ux/translation-failure-policy.html, frame 6): every change of
 * MeTranslation.translationUnavailableUntil is announced as `translation.status_changed`, a nudge to read
 * `GET /users/me` again, which the composer's "unavailable, messages will wait" tag draws from.
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

const ME: QueryKey = ['user', 'me'];
const SESSIONS: QueryKey = ['sessions'];

const frame = (type: string, data: Record<string, unknown>, sessionId = '') => ({
  type,
  sessionId,
  agentId: null,
  ts: '2026-09-25T12:00:00.000Z',
  data,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Seeds a cached read with the declaration its real counterpart makes: the stream selects on
 *  `meta.entities`, and a bare `setQueryData` creates an entry that declares nothing. */
function seed(client: QueryClient, key: QueryKey): void {
  const entities = key[0] === 'sessions' ? ['session', 'workspace', 'tag', 'folder', 'project'] : undefined;
  client.getQueryCache().build(client, { queryKey: key, ...(entities ? { meta: { entities } } : {}) });
  client.setQueryData(key, []);
}

async function mount(keys: QueryKey[]): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded rather than fetched: a read with no observer is only marked by an invalidation, never
  // refetched, so the flag is the provider's doing and nothing else's.
  for (const key of keys) seed(client, key);
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

describe('translation.status_changed', () => {
  it('re-reads /users/me', async () => {
    const client = await mount([ME, SESSIONS]);
    await publish(frame('translation.status_changed', { id: 'translation' }));
    await untilInvalidated(client, ME);
    expect(invalidated(client, SESSIONS)).toBe(false);
  });

  it('no other event re-reads /users/me', async () => {
    const client = await mount([ME, SESSIONS]);
    await publish(frame('session.updated', { id: 'S1', status: 'AWAITING_INPUT' }, 'S1'));
    await untilInvalidated(client, SESSIONS);
    expect(invalidated(client, ME)).toBe(false);
  });
});
