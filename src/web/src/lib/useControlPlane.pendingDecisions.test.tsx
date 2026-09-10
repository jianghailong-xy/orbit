// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPlaneProvider } from './useControlPlane';
import { pendingCriteriaDecisionsQuery, pendingDecisionsQuery } from './queries';

/**
 * The two reads a decision card is drawn from, re-read when the control-plane stream says so rather
 * than on their 20-second poll.
 *
 * `pendingDecisionsQuery` (evidence) and `pendingCriteriaDecisionsQuery` (a held criteria proposal)
 * are all either card renders from, so how long a submission takes to become a card on an open page
 * is how long it takes one of them to be invalidated. The server nudges on the four writes that move
 * them: evidence submitted or decided arrives as `task.changed`, a proposal held or decided as
 * `project.criteria_decisions.changed` naming its project. This mounts the real provider over a fake
 * EventSource, pushes those frames the way the server serves them, and reads the cache's own
 * `isInvalidated` flag — the keys come from the same factories the pages use, so a key that drifts
 * away from what the provider invalidates fails here rather than in a browser.
 *
 * Every "left alone" assertion is made only after something the SAME debounced flush invalidated
 * has been seen, so none of them can pass on a flush that simply has not run yet.
 */

// `getToken` is the provider's only import from the api module. Stubbed rather than seeded into
// localStorage, which under Node 24+ is Node's own global and shadows jsdom's.
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

// Public ids, as the wire spells them: the server's interceptor re-spells the uuids in every frame
// on the way out, and the pages key these reads by the same spelling.
const SESSION_A = '5Qp1yVbC1ezUCYnvw1Hn2R';
const SESSION_B = '2EhM8b5GxvpGTyDH1bY5Y7';
const PROJECT_A = '34MPiBgZ80YpSKt0lmTQA';
const PROJECT_B = '3xS6nCq8rWmYkq5dA0FZlB';
const TASK = '34MQU2Vfy2LW2aVXkX6fz';

const decisionsOf = (sessionId: string): QueryKey => pendingDecisionsQuery(sessionId).queryKey;
const criteriaOf = (projectId: string): QueryKey => pendingCriteriaDecisionsQuery(projectId).queryKey;
const PROVIDERS: QueryKey = ['providers'];

/** A user-scoped control event, in the envelope `GET /api/events` serves. */
const frame = (type: string, data: Record<string, unknown>) => ({
  type,
  sessionId: '',
  agentId: null,
  ts: '2026-09-10T14:00:00.000Z',
  data,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(keys: QueryKey[]): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seeded rather than fetched: a cached read with no observer is marked by an invalidation and
  // never refetched, so the flag read below is the provider's doing and nothing else's.
  for (const key of keys) client.setQueryData(key, { pending: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  const nextRoot = createRoot(container);
  root = nextRoot;
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={client}>
        <ControlPlaneProvider>
          <div />
        </ControlPlaneProvider>
      </QueryClientProvider>,
    );
  });
  for (const key of keys) expect(invalidated(client, key), `${JSON.stringify(key)} starts fresh`).toBe(false);
  return client;
}

/** Push one frame down the stream the provider opened — waited for rather than sampled once, so a
 *  stream opened behind a timer is found as soon as it exists instead of racing the mount. */
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

async function untilInvalidated(client: QueryClient, key: QueryKey): Promise<void> {
  await vi.waitFor(
    () => expect(invalidated(client, key), `${JSON.stringify(key)} was never invalidated`).toBe(true),
    { timeout: 5_000, interval: 20 },
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

describe('the pending-decision reads ride the control-plane stream', { timeout: 30_000 }, () => {
  it('task.changed — evidence submitted or decided — invalidates every session’s pending decisions', async () => {
    const client = await mount([decisionsOf(SESSION_A), decisionsOf(SESSION_B), criteriaOf(PROJECT_A)]);

    await publish(frame('task.changed', { taskId: TASK, taskIds: [TASK], resync: false }));

    await untilInvalidated(client, decisionsOf(SESSION_A));
    // Keyed by the session deciding, not by the task, so no session's copy can be told apart here.
    expect(invalidated(client, decisionsOf(SESSION_B))).toBe(true);
    // The same flush has run, and a task event says nothing about a criteria proposal.
    expect(invalidated(client, criteriaOf(PROJECT_A))).toBe(false);
  });

  it('project.criteria_decisions.changed invalidates the named project’s read, and one naming none every project’s', async () => {
    const client = await mount([criteriaOf(PROJECT_A), criteriaOf(PROJECT_B), decisionsOf(SESSION_A)]);

    await publish(frame('project.criteria_decisions.changed', { id: PROJECT_A }));

    await untilInvalidated(client, criteriaOf(PROJECT_A));
    expect(invalidated(client, criteriaOf(PROJECT_B)), 'another project’s read is left alone').toBe(false);
    expect(invalidated(client, decisionsOf(SESSION_A)), 'and so is the evidence read').toBe(false);

    await publish(frame('project.criteria_decisions.changed', {}));

    await untilInvalidated(client, criteriaOf(PROJECT_B));
    expect(invalidated(client, decisionsOf(SESSION_A))).toBe(false);
  });

  it('an unrelated event (provider.changed) invalidates neither read', async () => {
    const client = await mount([decisionsOf(SESSION_A), criteriaOf(PROJECT_A), PROVIDERS]);

    await publish(frame('provider.changed', { id: 'provider-1' }));

    // The positive this negative is paired with: the flush ran, and reached what the event names.
    await untilInvalidated(client, PROVIDERS);
    expect(invalidated(client, decisionsOf(SESSION_A))).toBe(false);
    expect(invalidated(client, criteriaOf(PROJECT_A))).toBe(false);
  });
});
