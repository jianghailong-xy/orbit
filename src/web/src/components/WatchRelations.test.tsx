// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchTargetView, WatchView } from '@orbit/shared';
import { SessionWatchBadges, SessionWatchStrip, TaskFollowedBy } from './WatchRelations';

/**
 * Following and Followed by, where they are read: on a task, in a session's header, and above a
 * session's composer. Each is drawn from the owner's watches, so each is given one list with watches it
 * must show next to watches it must not.
 */

vi.mock('../api', () => ({ api: vi.fn(), getSession: vi.fn() }));
vi.mock('../lib/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const { api, getSession } = await import('../api');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (fromNow: number) => new Date(Date.now() + fromNow).toISOString();

const target = (kind: 'TASK' | 'SESSION', id: string): WatchTargetView => ({
  targetKind: kind,
  targetResourceId: id,
  state: 'OBSERVED',
  targetEpoch: 0,
  lastEvaluatedAt: at(-HOUR),
});

// Times in whole minutes: a loaded run takes seconds between building a fixture and drawing it.
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
  expiresAt: at(20 * HOUR + 30 * MINUTE),
  nextEvaluateAt: null,
  lastEvaluatedAt: at(-5 * MINUTE),
  idempotencyKey: null,
  createdAt: at(-HOUR),
  updatedAt: at(-HOUR),
  targets: [target('TASK', 'T1')],
  matches: [],
  expiryDeliveries: [],
  ...over,
});

const resumes = (observer: string) =>
  ({ action: 'RESUME_SESSION', observerType: 'SESSION', observerSessionId: observer }) as const;

/** Answers as WatchesService does, from `watches` listed newest first: the newest 100 of every state, or of one. */
function serve(watches: WatchView[]) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/watches') return watches.slice(0, 100);
    const state = /^\/watches\?state=([A-Z]+)$/.exec(path);
    if (state) return watches.filter((w) => w.state === state[1]).slice(0, 100);
    if (/^\/tasks\/[^/]+\/row$/.test(path)) return { title: 'A task', status: 'OPEN' };
    throw new Error(`unstubbed ${path}`);
  }) as never);
  vi.mocked(getSession).mockImplementation((async (id: string) => ({ id, title: `Session ${id}` })) as never);
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

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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

const buttons = (scope: ParentNode) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent?.trim());

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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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

describe('a task’s Followed by', { timeout: 30_000 }, () => {
  it('lists the live watches that name the task, counts the ended ones, and follows it', async () => {
    serve([
      watch('LIVE', { targets: [target('TASK', 'T_X'), target('TASK', 'T_Y')], ...resumes('S_COORD') }),
      watch('ELSEWHERE', { targets: [target('TASK', 'T_OTHER')] }),
      watch('ENDED', { state: 'CANCELLED', targets: [target('TASK', 'T_X')] }),
    ]);
    await mount(<TaskFollowedBy taskId="T_X" />);

    const section = container!.querySelector('section')!;
    expect(section.querySelector('.tdp-section-title span')?.textContent).toBe('Followed by (1)');
    const rows = [...section.querySelectorAll<HTMLElement>('.watch-row')];
    expect(rows.map((r) => r.dataset.watchId)).toEqual(['LIVE']);
    expect(rows[0].querySelector('.watch-row-condition')?.textContent).toBe('When both tasks finish');
    expect(rows[0].querySelector('.watch-row-sub')?.textContent).toBe(
      'Then resume Session S_COORD · 0 of 2 met · checked 5m ago · expires in 20h',
    );
    expect(rows[0].querySelector('a.watch-row-open')?.getAttribute('href')).toBe('/following?watch=LIVE');
    const ended = section.querySelector('a.watch-relations-more');
    expect(ended?.textContent).toBe('1 ended watch');
    expect(ended?.getAttribute('href')).toBe('/following?tab=history');

    await click(
      [...section.querySelectorAll('button')].find((b) => b.textContent?.includes('Follow task')),
      'Follow task',
    );
    expect(document.body.querySelector('.ant-modal-title')?.textContent).toBe('Follow task');
  });

  it('says nothing is watching the task rather than drawing an empty list', async () => {
    serve([watch('ELSEWHERE', { targets: [target('TASK', 'T_OTHER')] })]);
    await mount(<TaskFollowedBy taskId="T_X" />);
    expect(container!.querySelector('.tdp-muted')?.textContent).toBe('Nothing is watching this task.');
  });
});

describe('a session’s Following and Followed by', { timeout: 30_000 }, () => {
  const watches = () => [
    watch('WAITING', { targets: [target('TASK', 'T1'), target('TASK', 'T2')], ...resumes('S_ME') }),
    watch('ON_ME', { targets: [target('SESSION', 'S_ME')] }),
    watch('WAITED', { state: 'MATCHED', targets: [target('TASK', 'T3')], ...resumes('S_ME') }),
    watch('UNRELATED', { targets: [target('SESSION', 'S_OTHER')] }),
  ];

  it('counts what the session waits on and what waits on it, live watches only', async () => {
    serve(watches());
    await mount(<SessionWatchBadges sessionId="S_ME" />);
    expect(buttons(container!)).toEqual(['Following 2 tasks', 'Followed by 1', 'Follow']);

    await click(
      [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes('Following')),
      'Following',
    );
    const rows = [...document.body.querySelectorAll<HTMLElement>('.ant-popover .watch-row')];
    expect(rows.map((r) => r.dataset.watchId)).toEqual(['WAITING']);
  });

  it('offers only Follow on a session nothing relates to', async () => {
    serve(watches());
    await mount(<SessionWatchBadges sessionId="S_QUIET" />);
    expect(buttons(container!)).toEqual(['Follow']);
  });

  it('keeps a strip above the composer while the session waits on a live watch, and opens it into cards', async () => {
    serve(watches());
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    expect(strip.querySelector('.watch-strip-title')?.textContent).toBe('Waiting on a watch');
    expect(strip.querySelector('.watch-strip-summary')?.textContent).toBe(
      'When both tasks finish · 0 of 2 met · checked 5m ago',
    );
    expect(strip.querySelector('.watch-card')).toBeNull();

    await click(strip.querySelector('.watch-strip-row'), 'the strip');
    expect([...strip.querySelectorAll<HTMLElement>('.watch-card')].map((c) => c.dataset.watchId)).toEqual(['WAITING']);
  });

  it('draws no strip when the session waits on nothing live', async () => {
    serve(watches().filter((w) => w.id !== 'WAITING'));
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    expect(container!.innerHTML).toBe('');
  });
});

describe('a live watch older than the newest 100', { timeout: 30_000 }, () => {
  // The session's own settled waits, each one ended: what every session_create(wait) it made leaves behind.
  const ended = Array.from({ length: 100 }, (_, i) =>
    watch(`ENDED_${i}`, { state: 'MATCHED', targets: [target('TASK', `T_DONE_${i}`)], ...resumes('S_ME') }),
  );
  const older = watch('OLD_WAIT', {
    createdAt: at(-30 * HOUR),
    targets: [target('TASK', 'T_OLD'), target('TASK', 'T_OLD_2')],
    ...resumes('S_ME'),
  });

  it('still keeps the session’s strip and Following, and the task’s Followed by', async () => {
    serve([...ended, older]);
    await mount(
      <>
        <SessionWatchBadges sessionId="S_ME" />
        <SessionWatchStrip sessionId="S_ME" />
        <TaskFollowedBy taskId="T_OLD" />
      </>,
    );

    expect(container!.querySelector('.watch-strip-title')?.textContent).toBe('Waiting on a watch');
    expect(buttons(container!.querySelector('.watch-badges')!)).toEqual(['Following 2 tasks', 'Follow']);
    const followedBy = container!.querySelector('section')!;
    expect(followedBy.querySelector('.tdp-section-title span')?.textContent).toBe('Followed by (1)');
    expect([...followedBy.querySelectorAll<HTMLElement>('.watch-row')].map((r) => r.dataset.watchId)).toEqual([
      'OLD_WAIT',
    ]);
  });
});
