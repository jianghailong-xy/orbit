// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainCheckoutActionResult, MainCheckoutRepoHealth } from '@orbit/shared';
import { MainCheckoutCtx } from '../lib/mainCheckout';
import { workspacesQuery } from '../lib/queries';
import { createAppQueryClient } from '../lib/queryClient';
import { ControlPlaneProvider } from '../lib/useControlPlane';
import { MainCheckoutBar } from './MainCheckout';
import { useMainCheckoutController } from './MainCheckoutDrawer';

/**
 * The Main checkout bar follows the checkout without a reload. An action's result comes back before the runner's
 * rescan reaches its heartbeat, so the workspace list read on the result still says what was there before; the bar
 * moves when the heartbeat that does carry the rescan is told to the owner's stream (`agent.changed`, `repoHealth`).
 */

const DIRTY: MainCheckoutRepoHealth = {
  root: '/root/orbit',
  state: 'dirty',
  branch: 'main',
  fileCount: 3,
  ahead: 0,
  upstream: 'origin/main',
  fingerprint: 'mc1:a',
  agentIds: ['W1'],
};

const h = vi.hoisted(() => ({
  health: null as unknown,
  result: null as unknown,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getToken: () => 'token',
    api: vi.fn(async (path: string) => {
      if (path === '/workspaces') {
        return [{ id: 'W1', runnerId: 'R1', mainCheckoutActions: true, repoHealth: h.health }];
      }
      return [];
    }),
    getMainCheckout: vi.fn(async () => ({
      snapshot: { root: '/root/orbit', branch: 'main', upstream: 'origin/main', fingerprint: 'mc1:b', files: [] },
    })),
    postMainCheckoutAction: vi.fn(async () => ({ status: 'done', result: h.result })),
  };
});

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close(): void {
    this.closed = true;
  }
}
const stream = (): FakeEventSource | undefined => FakeEventSource.all.filter((es) => !es.closed).at(-1);

/** The session page's host, as WorkspaceView builds it: the bar's health is the workspace list's. */
function Console() {
  const workspaces = useQuery(workspacesQuery());
  const health = (workspaces.data?.find((w) => w.id === 'W1')?.repoHealth ?? null) as MainCheckoutRepoHealth | null;
  const { host, drawer } = useMainCheckoutController({
    workspaceId: 'W1',
    sessionId: 'S1',
    sessionBranch: 'orbit/s1',
    actionsSupported: true,
    health,
    targets: [],
  });
  return (
    <MainCheckoutCtx.Provider value={host}>
      <MainCheckoutBar />
      {drawer}
    </MainCheckoutCtx.Provider>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function publish(type: string, data: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    stream()!.onmessage?.({ data: JSON.stringify({ type, sessionId: '', agentId: null, ts: new Date().toISOString(), data }) });
  });
}

/** The runner's rescan reaches the server, and the heartbeat that stored it tells the owner's stream. */
async function heartbeat(next: MainCheckoutRepoHealth): Promise<void> {
  h.health = next;
  await publish('agent.changed', { agentId: 'W1', affectsTaskRows: false, repoHealth: true });
  await advance(2_000); // the stream's one-second refresh window, and the read it opens
}

const bar = () => container!.querySelector('.mck-bar')?.textContent ?? null;
const button = (name: string) =>
  [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name);

const result = (over: Partial<MainCheckoutActionResult>): MainCheckoutActionResult => ({
  requestId: 'r1',
  kind: 'commit',
  root: '/root/orbit',
  status: 'done',
  finishedAt: new Date().toISOString(),
  ...over,
});

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  h.health = DIRTY;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = createAppQueryClient();
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ControlPlaneProvider>
            <Console />
          </ControlPlaneProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let waited = 0; !stream() && waited < 120_000; waited += 500) await advance(500);
  await act(async () => stream()!.onopen?.());
  await publish('ping');
  await advance(10);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  FakeEventSource.all = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the Main checkout bar follows the checkout after an action, without a reload', () => {
  it('after a commit, then a push, then the checkout going clean', async () => {
    expect(bar()).toBe('Main checkoutmain3 uncommitted filesReview');

    // Commit 2 of 3: the result lands while the server still holds the pre-commit heartbeat.
    await heartbeat({ ...DIRTY, fileCount: 1, ahead: 1, fingerprint: 'mc1:c' });
    expect(bar()).toBe('Main checkoutmain1 uncommitted file · 1 commit not pushedReviewPush to origin/main');

    // Push: the result is read at once, while the heartbeat still says ahead 1.
    h.result = result({ kind: 'push', upstream: 'origin/main', remoteBefore: 'a'.repeat(40), remoteAfter: 'b'.repeat(40) });
    await act(async () => button('Push to origin/main')!.click());
    await advance(1_000);
    expect(bar(), 'the stale heartbeat is what the result read').toContain('1 commit not pushed');
    await heartbeat({ ...DIRTY, fileCount: 1, ahead: 0, fingerprint: 'mc1:d' });
    expect(bar()).toBe('Main checkoutmain1 uncommitted fileReview');

    // Move / Save & clean leave it clean: the bar goes.
    await heartbeat({ ...DIRTY, state: 'clean', fileCount: 0, ahead: 0, fingerprint: 'mc1:e' });
    expect(bar()).toBeNull();
  });
});
