// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchDeliveryView, WatchMatchView, WatchTargetView, WatchView } from '@orbit/shared';
import { watchesQuery } from '../lib/queries';
import { watchProblem } from '../lib/watches';
import { WatchCard } from './WatchCard';

/**
 * A watch card read the way the acceptance asks for it: with nothing opened, it has to say what it
 * watches, what it waits for, how stale that reading is and what happens next. The controls are
 * pressed in a real document, and the card is drawn from the cache the way the pages draw it, so a
 * control that writes but never redraws fails here.
 */

// `ApiError` REAL, not restated: a target's name asks whether a failed read was a 404 with
// `error instanceof ApiError && error.status === 404`, and a stand-in class here would let that
// branch pass against a shape the client never throws.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api, getSession } = await import('../api');

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();

const target = (id: string, over: Partial<WatchTargetView> = {}): WatchTargetView => ({
  targetKind: 'TASK',
  targetResourceId: id,
  state: 'OBSERVED',
  targetEpoch: 0,
  lastEvaluatedAt: at(-2 * HOUR),
  ...over,
});

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

const match = (deliveries: WatchDeliveryView[], over: Partial<WatchMatchView> = {}): WatchMatchView => ({
  id: 'm1',
  generation: 1,
  matchedAt: at(-HOUR),
  reason: 'ALL TASK_TERMINAL 1/1',
  predicateVersion: 1,
  perTargetSnapshot: { evaluatedAt: at(-HOUR), targets: [] },
  deliveries,
  ...over,
});

const watch = (over: Partial<WatchView> = {}): WatchView => ({
  id: 'W1',
  observerType: 'USER',
  observerSessionId: null,
  predicateVersion: 1,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  mode: 'ONE_SHOT',
  action: 'NOTIFY_USER',
  state: 'ACTIVE',
  generation: 0,
  expiresAt: at(21 * HOUR + 30 * MINUTE),
  nextEvaluateAt: at(MINUTE),
  lastEvaluatedAt: at(-12 * SECOND),
  idempotencyKey: null,
  createdAt: at(-2 * HOUR),
  updatedAt: at(-2 * HOUR),
  targets: [target('T1')],
  matches: [],
  expiryDeliveries: [],
  ...over,
});

type Init = { method?: string; body?: unknown };

/** Routes by `METHOD path`; a task's list row and a session's detail answer with the titles given. */
function serve(routes: Record<string, (init?: Init) => unknown>, titles: Record<string, string> = {}) {
  vi.mocked(api).mockImplementation((async (path: string, init?: Init) => {
    const row = /^\/tasks\/([^/]+)\/row$/.exec(path);
    if (row) return { id: row[1], title: titles[row[1]] ?? row[1], status: 'OPEN' };
    // The live states and the watches that need attention are read on their own beside the list, and answered from
    // its rows as the server would.
    const state = /^\/watches\?state=([A-Z]+)$/.exec(path);
    const list = routes['GET /watches'];
    if (state && list && (init?.method ?? 'GET') === 'GET') {
      return (list() as WatchView[]).filter((w) => w.state === state[1]);
    }
    if (path === '/watches?needsAttention=true' && (init?.method ?? 'GET') === 'GET') {
      return list ? (list() as WatchView[]).filter((w) => watchProblem(w)) : [];
    }
    const handler = routes[`${init?.method ?? 'GET'} ${path}`];
    if (!handler) throw new Error(`unstubbed ${init?.method ?? 'GET'} ${path}`);
    return handler(init);
  }) as never);
  vi.mocked(getSession).mockImplementation((async (id: string) => ({
    id,
    title: titles[id] ?? id,
    assignedRunnerId: null,
    workspace: null,
  })) as never);
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  // React Query hands a finished read over on a macrotask, and a card's names are reads of their own.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

const button = (text: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

/** The card's label → value rows, as one reads them. */
const factsOf = (card: Element): Record<string, string> =>
  Object.fromEntries(
    [...card.querySelectorAll('.watch-facts dt')].map((dt) => [
      dt.textContent ?? '',
      (dt.nextElementSibling?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ]),
  );

/** The cards as a page draws them: from the one watches read, so a control's answer redraws them. */
function WatchList() {
  const q = useQuery(watchesQuery());
  return (
    <>
      {(q.data ?? []).map((w) => (
        <WatchCard key={w.id} watch={w} />
      ))}
    </>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // antd's overlays read breakpoints and sizes that jsdom does not have.
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  toast.success.mockReset();
  toast.error.mockReset();
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

describe('a watch card', { timeout: 30_000 }, () => {
  it('says what it watches, what it waits for, how stale that is and what happens next, with nothing opened', async () => {
    // Only the observer session is still read by id; the targets' names come with the watch.
    serve({}, { OBSERVER: 'Coordinator: Watch project' });
    await mount(
      <WatchCard
        watch={watch({
          action: 'RESUME_SESSION',
          observerType: 'SESSION',
          observerSessionId: 'OBSERVER',
          predicate: {
            kind: 'ANY_OF',
            operands: [
              { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
              { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' },
            ],
          },
          targets: [
            target('T1', {
              state: 'SATISFIED',
              lastEvaluatedAt: at(-42 * MINUTE),
              targetTitle: 'Web Watch cards',
            }),
            target('T2', { targetTitle: 'macOS Watch' }),
            target('T3', { targetTitle: 'Agent tools' }),
          ],
          // Minutes, not seconds: a loaded run takes seconds between building this and drawing it.
          lastEvaluatedAt: at(-5 * MINUTE),
        })}
      />,
    );
    const card = container!.querySelector('.watch-card')!;
    expect(card.querySelector('.watch-state')?.textContent).toBe('Watching');
    // What it waits for.
    expect(card.querySelector('h3')?.textContent).toBe('When all 3 tasks finish, or any 1 of these 3 tasks fails');
    const facts = factsOf(card);
    expect(Object.keys(facts)).toEqual(['Watching', 'Progress', 'Updated', 'Then', 'Expires']);
    // What it watches, by name, with what the watch last recorded about each.
    expect(facts.Watching).toContain('Web Watch cards');
    expect(facts.Watching).toContain('macOS Watch');
    expect(facts.Watching).toContain('Agent tools');
    expect(card.querySelector('.watch-target.is-satisfied')?.textContent).toContain('met');
    expect(facts.Progress).toBe('1 of 3 met');
    // How stale: when what it sees last changed, and when it last looked.
    expect(facts.Updated).toBe('Last change 42m ago · checked 5m ago');
    // What happens next, and until when.
    expect(facts.Then).toBe('Resume Coordinator: Watch project');
    expect(facts.Expires).toMatch(/^in 21h · /);
    expect(card.querySelector('.watch-details'), 'nothing had to be opened').toBeNull();
    // Edit is gone (docs/watch-contract.md): a change is only a change once the server tells the
    // agent its wait moved, so the card offers Pause and Stop alone.
    expect(['Pause', 'Stop'].map((label) => !!button(label, card))).toEqual([true, true]);
    expect(button('Edit', card)).toBeUndefined();
  });

  /**
   * What the card calls a target, and what it may not. The names ride on the watch, so a page of
   * cards over hundreds of targets asks for nothing per target — and a target this account cannot
   * read is not named "Deleted": its own row answers 404 exactly as a deleted one would (a task
   * moved to another account does, which is where the false wording came from), so only what the
   * watch itself records as GONE is said to be gone.
   */
  it('names its targets from the watch, and calls deleted only what the watch records as gone', async () => {
    serve({});
    await mount(
      <WatchCard
        watch={watch({
          targets: [
            target('T1', { targetTitle: 'Land the redirect fix' }),
            target('T2', { state: 'GONE' }),
            // Readable by this account no longer, so the watch came back with no name for it.
            target('T3', { targetTitle: null }),
          ],
        })}
      />,
    );
    const card = container!.querySelector('.watch-card')!;
    expect([...card.querySelectorAll('.watch-target-name')].map((n) => n.textContent)).toEqual([
      'Land the redirect fix',
      'Deleted task',
      'T3…',
    ]);
    // Not one request for a name: whatever the card shows, it showed from the watch it was given.
    expect(vi.mocked(api).mock.calls.map(([path]) => String(path)).filter((p) => p.includes('/row'))).toEqual([]);
  });

  it('draws the bar against what the condition asks for, not the target count', async () => {
    const four = ['T1', 'T2', 'T3', 'T4'];
    const settled = (met: number) => four.map((id, i) => target(id, i < met ? { state: 'SATISFIED' } : {}));
    const leaf = { over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;
    const rows = [
      watch({ id: 'W1', predicate: { kind: 'ANY', ...leaf }, targets: settled(1) }),
      watch({ id: 'W2', predicate: { kind: 'ALL', ...leaf }, targets: settled(2) }),
      watch({ id: 'W3', predicate: { kind: 'AT_LEAST', count: 2, ...leaf }, targets: settled(1) }),
    ];
    serve(
      { 'GET /watches': () => rows },
      { T1: 'Task 1', T2: 'Task 2', T3: 'Task 3', T4: 'Task 4' },
    );
    await mount(<WatchList />);

    const bar = (id: string) =>
      container!.querySelector<HTMLElement>(`[data-watch-id="${id}"] .watch-bar > span`)!.style.width;
    // One target settles an ANY watch, so three of its four still waiting leaves the bar full.
    expect(bar('W1')).toBe('100%');
    // An ALL asks for every target: two of four met is half the bar, as it always was.
    expect(bar('W2')).toBe('50%');
    // An AT_LEAST is measured against its own quota, not the set it was written over.
    expect(bar('W3')).toBe('50%');
  });

  it('pauses from the card and redraws it from the answer', async () => {
    let row = watch();
    serve(
      {
        'GET /watches': () => [row],
        'POST /watches/W1/pause': () => (row = { ...row, state: 'PAUSED' }),
      },
      { T1: 'Ship it' },
    );
    await mount(<WatchList />);
    await click(button('Pause'), 'Pause');

    expect(vi.mocked(api)).toHaveBeenCalledWith('/watches/W1/pause', { method: 'POST' });
    const card = container!.querySelector('[data-watch-id="W1"]')!;
    expect(card.querySelector('.watch-state')?.textContent).toBe('Paused');
    expect(button('Resume', card)).toBeTruthy();
    expect(factsOf(card).Updated).toContain('(paused)');
    expect(toast.success).toHaveBeenCalledWith('Watch paused. Its deadline keeps running.');
  });

  it('asks before stopping, and stops only on the answer', async () => {
    let row = watch();
    serve(
      {
        'GET /watches': () => [row],
        'POST /watches/W1/cancel': () => (row = { ...row, state: 'CANCELLED' }),
      },
      { T1: 'Ship it' },
    );
    await mount(<WatchList />);
    await click(button('Stop'), 'Stop');

    expect(document.body.textContent).toContain('Stop this watch?');
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/watches/W1/cancel')).toBe(false);

    await click(button('Stop watching'), 'the confirmation');
    expect(vi.mocked(api)).toHaveBeenCalledWith('/watches/W1/cancel', { method: 'POST' });
    const card = container!.querySelector('[data-watch-id="W1"]')!;
    expect(card.querySelector('.watch-state')?.textContent).toBe('Stopped');
    // An ended watch has nothing left to control.
    expect(button('Pause', card)).toBeUndefined();
  });

  it('shows a control the server refused, and leaves the card as it was', async () => {
    const row = watch();
    serve(
      {
        'GET /watches': () => [row],
        'POST /watches/W1/pause': () => {
          throw Object.assign(new Error('a MATCHED watch cannot be paused'), { status: 409 });
        },
      },
      { T1: 'Ship it' },
    );
    await mount(<WatchList />);
    await click(button('Pause'), 'Pause');

    expect(toast.error).toHaveBeenCalledWith('a MATCHED watch cannot be paused');
    expect(container!.querySelector('.watch-state')?.textContent).toBe('Watching');
  });

  it('puts a failed delivery on the card itself, not behind Details', async () => {
    serve({}, { T1: 'Fix flaky spec', OBS: 'Nightly sweep' });
    await mount(
      <WatchCard
        watch={watch({
          state: 'MATCHED',
          generation: 1,
          action: 'RESUME_SESSION',
          observerType: 'SESSION',
          observerSessionId: 'OBS',
          targets: [target('T1', { state: 'SATISFIED' })],
          matches: [
            match([
              delivery({
                action: 'RESUME_SESSION',
                state: 'DEAD_LETTER',
                attempts: 1,
                deliveredAt: null,
                lastError:
                  "OBSERVER_SESSION_ENDED: the observer session's run is over (ENDED), and a watch does not revive it",
              }),
            ]),
          ],
        })}
      />,
    );
    const card = container!.querySelector('.watch-card')!;
    expect(card.classList.contains('tone-error')).toBe(true);
    const problem = card.querySelector('.watch-problem')!;
    expect(problem.querySelector('strong')?.textContent).toBe('The session was not woken');
    expect(problem.querySelector('span')?.textContent).toBe(
      "The observer session's run is over (ENDED), and a watch does not revive it",
    );
    const facts = factsOf(card);
    expect(facts.Result).toBe('1 of 1 finished');
    expect(facts.Then).toBe('Resume Nightly sweep · not delivered');
    expect(card.querySelector('.watch-age')?.textContent).toMatch(/^triggered /);
    expect(button('Pause', card)).toBeUndefined();
  });

  it('says a wake withdrawn before it ran plainly, and raises nothing about it', async () => {
    serve({}, { T1: 'Spawned session settled', OBS: 'Coordinator' });
    await mount(
      <WatchCard
        watch={watch({
          state: 'MATCHED',
          generation: 1,
          action: 'RESUME_SESSION',
          observerType: 'SESSION',
          observerSessionId: 'OBS',
          targets: [target('T1', { state: 'SATISFIED' })],
          matches: [
            match([
              delivery({
                action: 'RESUME_SESSION',
                state: 'DEAD_LETTER',
                attempts: 0,
                deliveredAt: null,
                lastError: "WAKE_WITHDRAWN: the wake was withdrawn from the observer session's queue before a runner took it",
              }),
            ]),
          ],
        })}
      />,
    );
    const card = container!.querySelector('.watch-card')!;
    expect(card.classList.contains('tone-error')).toBe(false);
    expect(card.querySelector('.watch-problem')).toBeNull();
    expect(factsOf(card).Then).toBe('Resume Coordinator · wake withdrawn');
    expect(card.querySelector('.watch-delivery-state')?.classList.contains('is-withdrawn')).toBe(true);

    await click(button('Details', card), 'Details');
    const row = card.querySelector('.watch-delivery')!;
    expect(row.textContent).toContain('Resume the session · withdrawn');
    // The server's own account stays readable, in no error color.
    expect(row.querySelector('.watch-delivery-error')).toBeNull();
    expect(row.textContent).toContain('before a runner took it');
  });

  it('opens every target, the snapshot its trigger recorded and each delivery under Details', async () => {
    const ids = ['T1', 'T2', 'T3', 'T4', 'T5'];
    serve({}, Object.fromEntries(ids.map((id, i) => [id, `Task number ${i + 1}`])));
    await mount(
      <WatchCard
        watch={watch({
          state: 'MATCHED',
          generation: 1,
          targets: ids.map((id) => target(id, { state: 'SATISFIED' })),
          matches: [
            match([delivery()], {
              reason: 'ALL TASK_TERMINAL 5/5',
              perTargetSnapshot: {
                evaluatedAt: at(-HOUR),
                targets: ids.map((id) => ({
                  kind: 'TASK' as const,
                  id,
                  epoch: 0,
                  state: 'SATISFIED' as const,
                  changed: true,
                  leaves: { TASK_TERMINAL: true },
                  observed: { status: 'DONE' },
                })),
              },
            }),
          ],
        })}
      />,
    );
    const card = container!.querySelector('.watch-card')!;
    expect(card.querySelectorAll('.watch-facts .watch-target')).toHaveLength(3);
    expect(factsOf(card).Then).toBe('Notify you · sent 1h ago');

    await click(button('Details', card), 'Details');
    const details = card.querySelector('.watch-details')!;
    expect(details.querySelectorAll('.watch-details-section')[0].querySelectorAll('.watch-target')).toHaveLength(5);
    expect(details.textContent).toContain('5 of 5 finished');
    expect(details.textContent).toContain('satisfied · status DONE');
    expect(details.textContent).toContain('Notify you · delivered');
    // Opened, the card names every target, not the first three.
    expect(card.querySelectorAll('.watch-facts .watch-target')).toHaveLength(5);
  });
});
