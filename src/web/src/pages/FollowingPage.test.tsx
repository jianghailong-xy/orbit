// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchDeliveryView, WatchView } from '@orbit/shared';
import { watchProblem } from '../lib/watches';
import { FollowingPage } from './FollowingPage';

/**
 * The Following page as a reader browses it: three tabs that file every watch exactly once, each one
 * press away, and a link to one watch that lands on its card, opened.
 */

// `ApiError` REAL, not restated: a target's name asks whether a failed read was a 404 with
// `error instanceof ApiError && error.status === 404`, and a stand-in class here would let that
// branch pass against a shape the client never throws.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
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

/** A hundred watches newer than any other, every one of them ended: what a busy account's latest reads hold. */
const HUNDRED_ENDED: WatchView[] = Array.from({ length: 100 }, (_, i) => matched(`E${i}`, at(-MINUTE), [delivery()]));

/**
 * Answers as WatchesService does, from `watches` listed newest first: `GET /watches` is the newest 100 of
 * every state, `?state=` the newest 100 in that state, `?needsAttention=true` the newest 100 that need
 * attention — which the server picks by the contract's `attention` rule, the one `watchProblem` files an ended
 * watch by (lib/watches.test) — and `GET /watches/:id` any one of them.
 */
function serve(watches: () => WatchView[]) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/watches') return watches().slice(0, 100);
    if (path === '/watches?needsAttention=true') return watches().filter((w) => watchProblem(w)).slice(0, 100);
    const state = /^\/watches\?state=([A-Z]+)$/.exec(path);
    if (state) return watches().filter((w) => w.state === state[1]).slice(0, 100);
    const one = /^\/watches\/([^/?]+)$/.exec(path);
    if (one) {
      const found = watches().find((w) => w.id === decodeURIComponent(one[1]));
      if (!found) throw Object.assign(new Error('watch not found'), { status: 404 });
      return found;
    }
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

  it('files a wake withdrawn before it ran under Triggered history, and one an interrupt swept away under Needs attention', async () => {
    const resumed = (id: string, lastError: string): WatchView => ({
      ...matched(id, at(-5 * MINUTE), [
        delivery({ action: 'RESUME_SESSION', state: 'DEAD_LETTER', attempts: 0, deliveredAt: null, lastError }),
      ]),
      action: 'RESUME_SESSION',
      observerType: 'SESSION',
      observerSessionId: 'S1',
    });
    serve(() => [
      // As the server writes it when a session_create(wait) that got its answer inline releases the wake.
      resumed('WITHDRAWN', "WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it"),
      resumed(
        'INTERRUPTED',
        'OBSERVER_TURN_INTERRUPTED: the observer session was interrupted before a runner took its queued wake, and an interrupt drops what is queued behind the turn it stops',
      ),
    ]);
    await visit('/following?tab=history');

    expect(tabs().map((t) => t.textContent)).toEqual(['Active0', 'Needs attention1', 'Triggered history1']);
    expect(shownIds()).toEqual(['WITHDRAWN']);
    const card = container!.querySelector<HTMLElement>('[data-watch-id="WITHDRAWN"]')!;
    expect(card.classList.contains('tone-error')).toBe(false);
    expect(card.querySelector('.watch-problem')).toBeNull();
    // Still visible: the card says what became of the wake, in no error color.
    const state = card.querySelector('.watch-delivery-state')!;
    expect(state.textContent).toContain('wake withdrawn');
    expect(state.classList.contains('is-dead_letter')).toBe(false);

    await press('Needs attention');
    expect(shownIds()).toEqual(['INTERRUPTED']);
    expect(container!.querySelector('.following-panel .watch-problem strong')?.textContent).toBe('The session was not woken');
  });

  it('keeps every live watch on Active when a hundred newer watches have ended', async () => {
    serve(() => [
      ...HUNDRED_ENDED,
      watch('OLD_ACTIVE', { createdAt: at(-30 * HOUR) }),
      watch('OLD_PAUSED', { state: 'PAUSED', createdAt: at(-40 * HOUR) }),
    ]);
    await visit('/following');

    expect(tabs().map((t) => t.textContent)).toEqual(['Active2', 'Needs attention0', 'Triggered history100']);
    expect(shownIds()).toEqual(['OLD_ACTIVE', 'OLD_PAUSED']);
    expect(container!.textContent).not.toContain('Nothing is being followed right now');
  });

  it('lands a link to one watch on its own tab, with its card opened', async () => {
    serve(() => WATCHES);
    await visit('/following?watch=D1');

    expect(tab('Needs attention')?.getAttribute('aria-selected')).toBe('true');
    const card = container!.querySelector<HTMLElement>('[data-watch-id="D1"]')!;
    expect(card.classList.contains('is-focused')).toBe(true);
    expect(card.querySelector('.watch-details')?.textContent).toContain('BOOM: it broke');
  });

  it('opens a link to a watch no list holds by reading that watch on its own', async () => {
    // One nobody has to act on: a watch that needs attention is read by a list of its own however old it is, so the
    // one no list holds is an end that asks nothing of anybody — here a wake taken back before it ran.
    const old = matched('OLD', at(-30 * HOUR), [
      delivery({
        action: 'RESUME_SESSION',
        state: 'DEAD_LETTER',
        attempts: 0,
        deliveredAt: null,
        lastError: "WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it",
      }),
    ]);
    serve(() => [...HUNDRED_ENDED, old]);
    await visit('/following?watch=OLD');
    await settle();

    expect(vi.mocked(api)).toHaveBeenCalledWith('/watches/OLD');
    expect(tab('Triggered history')?.getAttribute('aria-selected')).toBe('true');
    const card = container!.querySelector<HTMLElement>('[data-watch-id="OLD"]');
    expect(card, 'the linked card is on screen').toBeTruthy();
    expect(card!.classList.contains('is-focused')).toBe(true);
    expect(card!.querySelector('.watch-details')?.textContent).toContain('WAKE_WITHDRAWN: the wake was withdrawn');
    expect(container!.textContent).not.toContain('couldn’t be opened');
  });

  it('says so when a linked watch cannot be read', async () => {
    serve(() => WATCHES);
    await visit('/following?watch=GONE');
    await settle();

    expect(container!.querySelector('.following-note')?.textContent).toBe('That watch couldn’t be opened: watch not found');
    expect(shownIds()).toEqual(['A1', 'A2']);
  });

  it('says why a tab is empty', async () => {
    serve(() => []);
    await visit('/following');
    expect(container!.querySelector('.following-empty')?.textContent).toContain('Nothing is being followed right now');
    await press('Needs attention');
    expect(container!.querySelector('.following-empty')?.textContent).toContain('Nothing needs attention');
  });

  it('keeps every watch that needs attention when a hundred newer ones have ended', async () => {
    const OLD = -30 * HOUR;
    const revoked = watch('R_OLD', { state: 'REVOKED', createdAt: at(OLD) });
    const unresolvable = watch('U_OLD', { state: 'UNRESOLVABLE', createdAt: at(OLD) });
    // A notify watch has no waiting session, so nothing was delivered to say it ran out.
    const expired = watch('X_OLD', { state: 'EXPIRED', expiresAt: at(-2 * HOUR), createdAt: at(OLD) });
    const failed = {
      ...matched('D_OLD', at(-25 * HOUR), [
        delivery({ state: 'DEAD_LETTER', attempts: 8, deliveredAt: null, lastError: 'TURN_REFUSED: the queue refused it' }),
      ]),
      createdAt: at(OLD),
    };
    // Ended just as long ago and nobody's to act on: the read that finds the four above must not find these.
    const withdrawn = {
      ...matched('W_OLD', at(-26 * HOUR), [
        delivery({
          action: 'RESUME_SESSION',
          state: 'DEAD_LETTER',
          attempts: 0,
          deliveredAt: null,
          lastError: "WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it",
        }),
      ]),
      createdAt: at(OLD),
    };
    const stopped = watch('C_OLD', { state: 'CANCELLED', createdAt: at(OLD), updatedAt: at(-27 * HOUR) });
    serve(() => [...HUNDRED_ENDED, revoked, unresolvable, expired, failed, withdrawn, stopped]);
    await visit('/following?tab=attention');

    expect(tabs().map((t) => t.textContent)).toEqual(['Active0', 'Needs attention4', 'Triggered history100']);
    expect(shownIds()).toEqual(['R_OLD', 'U_OLD', 'X_OLD', 'D_OLD']);
    expect(container!.textContent).not.toContain('Nothing needs attention');
    // Nothing is missing from this tab, so it promises nothing about a cap.
    expect(container!.querySelector('.following-note')).toBeNull();
  });

  it('says so when more watches need attention than one read answers with', async () => {
    const needy = Array.from({ length: 100 }, (_, i) =>
      watch(`N${i}`, { state: 'REVOKED', createdAt: at(-30 * HOUR) }),
    );
    serve(() => [...HUNDRED_ENDED, ...needy]);
    await visit('/following?tab=attention');

    expect(tab('Needs attention')?.textContent).toBe('Needs attention100');
    expect(container!.querySelector('.following-note')?.textContent).toBe(
      'Showing the 100 newest watches that need attention.',
    );
  });

  it('says so when the watches could not be read', async () => {
    serve(() => {
      throw new Error('Bad Gateway');
    });
    await visit('/following');
    expect(container!.querySelector('.following-empty')?.textContent).toContain('Couldn’t load watches: Bad Gateway');
  });
});
