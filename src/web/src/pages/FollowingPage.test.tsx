// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchDeliveryView, WatchView } from '@orbit/shared';
import { FollowingPage } from './FollowingPage';

/**
 * The Following page as a reader browses it: three tabs that file every watch exactly once, each one
 * press away, and a link to one watch that lands on its card, opened.
 */

vi.mock('../api', () => ({ api: vi.fn(), getSession: vi.fn() }));
vi.mock('../lib/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const { api, getSession } = await import('../api');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();

const delivery = (over: Partial<WatchDeliveryView> = {}): WatchDeliveryView => ({
  id: 'd1',
  action: 'NOTIFY_USER',
  state: 'DELIVERED',
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  deliveredAt: at(-HOUR),
  deadLetteredAt: null,
  createdAt: at(-HOUR),
  updatedAt: at(-HOUR),
  ...over,
});

const watch = (id: string, over: Partial<WatchView> = {}): WatchView => ({
  id,
  observerType: 'USER',
  observerSessionId: null,
  predicateVersion: 1,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  mode: 'ONE_SHOT',
  action: 'NOTIFY_USER',
  state: 'ACTIVE',
  generation: 0,
  expiresAt: at(20 * HOUR),
  nextEvaluateAt: null,
  lastEvaluatedAt: at(-MINUTE),
  idempotencyKey: null,
  createdAt: at(-HOUR),
  updatedAt: at(-HOUR),
  targets: [{ targetKind: 'TASK', targetResourceId: `task-of-${id}`, state: 'OBSERVED', targetEpoch: 0, lastEvaluatedAt: null }],
  matches: [],
  expiryDeliveries: [],
  ...over,
});

const matched = (id: string, matchedAt: string, deliveries: WatchDeliveryView[]): WatchView =>
  watch(id, {
    state: 'MATCHED',
    generation: 1,
    matches: [
      {
        id: `${id}-m`,
        generation: 1,
        matchedAt,
        reason: 'ALL TASK_TERMINAL 1/1',
        predicateVersion: 1,
        perTargetSnapshot: { evaluatedAt: matchedAt, targets: [] },
        deliveries,
      },
    ],
  });

const WATCHES: WatchView[] = [
  watch('A1'),
  watch('R1', { state: 'REVOKED' }),
  matched('M1', at(-10 * MINUTE), [delivery()]),
  watch('A2', { state: 'PAUSED' }),
  matched('D1', at(-2 * HOUR), [delivery({ state: 'DEAD_LETTER', attempts: 8, deliveredAt: null, lastError: 'BOOM: it broke' })]),
  watch('C1', { state: 'CANCELLED', updatedAt: at(-3 * HOUR) }),
];

function serve(watches: () => WatchView[]) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/watches') return watches();
    if (/^\/tasks\/[^/]+\/row$/.test(path)) return { title: 'A task', status: 'OPEN' };
    throw new Error(`unstubbed ${path}`);
  }) as never);
  vi.mocked(getSession).mockImplementation((async (id: string) => ({ id, title: 'A session' })) as never);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/following" element={<FollowingPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const tabs = () => [...container!.querySelectorAll<HTMLButtonElement>('.following-tab')];
const tab = (label: string) => tabs().find((t) => t.textContent?.startsWith(label));
const shownIds = () =>
  [...container!.querySelectorAll<HTMLElement>('.following-panel .watch-card')].map((c) => c.dataset.watchId);

async function press(label: string): Promise<void> {
  const target = tab(label);
  expect(target, `the ${label} tab`).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
});

describe('the Following page', { timeout: 30_000 }, () => {
  it('files every watch under exactly one tab, counts all three, and opens on Active', async () => {
    serve(() => WATCHES);
    await visit('/following');

    expect(container!.querySelector('h1')?.textContent).toBe('Following');
    expect(tabs().map((t) => t.textContent)).toEqual(['Active2', 'Needs attention2', 'Triggered history2']);
    expect(tab('Active')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Needs attention')?.querySelector('.following-count.is-alert')).toBeTruthy();
    expect(shownIds()).toEqual(['A1', 'A2']);
  });

  it('browses Needs attention and Triggered history one press each', async () => {
    serve(() => WATCHES);
    await visit('/following');

    await press('Needs attention');
    expect(shownIds()).toEqual(['R1', 'D1']);
    const problems = [...container!.querySelectorAll('.following-panel .watch-problem strong')].map((p) => p.textContent);
    expect(problems).toEqual(['Stopped: this account can no longer read a target', 'The notification was not delivered']);

    await press('Triggered history');
    // Newest end first: M1 triggered ten minutes ago, C1 was stopped three hours ago.
    expect(shownIds()).toEqual(['M1', 'C1']);
    expect(tab('Triggered history')?.getAttribute('aria-selected')).toBe('true');
  });

  it('lands a link to one watch on its own tab, with its card opened', async () => {
    serve(() => WATCHES);
    await visit('/following?watch=D1');

    expect(tab('Needs attention')?.getAttribute('aria-selected')).toBe('true');
    const card = container!.querySelector<HTMLElement>('[data-watch-id="D1"]')!;
    expect(card.classList.contains('is-focused')).toBe(true);
    expect(card.querySelector('.watch-details')?.textContent).toContain('BOOM: it broke');
  });

  it('says why a tab is empty', async () => {
    serve(() => []);
    await visit('/following');
    expect(container!.querySelector('.following-empty')?.textContent).toContain('Nothing is being followed right now');
    await press('Needs attention');
    expect(container!.querySelector('.following-empty')?.textContent).toContain('Nothing needs attention');
  });

  it('says so when the watches could not be read', async () => {
    serve(() => {
      throw new Error('Bad Gateway');
    });
    await visit('/following');
    expect(container!.querySelector('.following-empty')?.textContent).toContain('Couldn’t load watches: Bad Gateway');
  });
});
