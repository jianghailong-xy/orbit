// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BootGate } from './BootGate';
import { routeId } from '../lib/idCodec';

/**
 * BootGate's reads are for the splash only. Left on after it, they are lists on screen as far as the
 * control-plane stream can tell, and it refreshes them on every event: the scoped Open list it warms
 * is one page (`limit=40`) while a workspace that shows projects reads its whole list, so every event
 * cost a large account two full Open-list reads instead of one (2026-10-25: 426 of the one shape and
 * 306 of the other in 65 minutes, from one browser).
 */

const h = vi.hoisted(() => ({ calls: [] as string[], workspaceId: '' }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getToken: () => 'token',
  api: vi.fn(async (path: string) => {
    h.calls.push(path);
    if (path === '/workspaces') return [{ id: h.workspaceId, runnerId: 'R1', name: 'orbit' }];
    if (path === '/runners') return [{ id: 'R1', name: 'runner' }];
    if (path === '/users/me') return { id: 'U1', email: 'owner@example.com' };
    return [];
  }),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function boot(): Promise<QueryClient> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  h.workspaceId = routeId('W1') ?? 'W1';
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/workspaces/${h.workspaceId}`]}>
          <BootGate><div data-testid="app">app</div></BootGate>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 10 && !container.querySelector('[data-testid="app"]'); i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }
  expect(container.querySelector('[data-testid="app"]'), 'the splash never lifted').not.toBeNull();
  return client;
}

const pageReads = (): string[] => h.calls.filter((path) => path.startsWith('/sessions?') && path.includes('limit=40'));

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.calls = [];
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
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('BootGate warms the first screen and then lets go', () => {
  it('reads the scoped Open list once, for the splash, and not again when the lists are refreshed', async () => {
    const client = await boot();
    expect(pageReads(), 'the splash did not warm the scoped Open list').toHaveLength(1);

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['sessions'] });
      await client.invalidateQueries({ queryKey: ['runners'] });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(pageReads(), 'a refresh after the splash read the pre-warmed page again').toHaveLength(1);
    expect(h.calls.filter((path) => path === '/runners'), 'a refresh after the splash read the runners again').toHaveLength(1);
  });
});
