// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchTargetView, WatchView } from '@orbit/shared';
import { watchProblem } from '../lib/watches';
import { SessionWatchBadges, SessionWatchStrip, TaskFollowedBy } from './WatchRelations';

/**
 * Following and Followed by, where they are read: on a task, in a session's header, and above a
 * session's composer. Each is drawn from the owner's watches, so each is given one list with watches it
 * must show next to watches it must not.
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

const target = (kind: 'TASK' | 'SESSION', id: string, over: Partial<WatchTargetView> = {}): WatchTargetView => ({
  targetKind: kind,
  targetResourceId: id,
  state: 'OBSERVED',
  targetEpoch: 0,
  lastEvaluatedAt: at(-HOUR),
  ...over,
});

/** The same target once the evaluator has seen it meet the condition. */
const satisfied = (kind: 'TASK' | 'SESSION', id: string): WatchTargetView => ({
  ...target(kind, id),
  state: 'SATISFIED',
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

/** What a target's own row says, by target id, for the cases where the targets differ. */
type TaskRow = { title?: string; status?: string; terminalReason?: string };

/**
 * Answers as WatchesService does, from `watches` listed newest first: the newest 100 of every state, of one, or of
 * those that need attention — which the server picks by the contract's `attention` rule, the one `watchProblem`
 * files by (lib/watches.test).
 */
function serve(watches: WatchView[], rows: Record<string, TaskRow> = {}) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/watches') return watches.slice(0, 100);
    if (path === '/watches?needsAttention=true') return watches.filter((w) => watchProblem(w)).slice(0, 100);
    const state = /^\/watches\?state=([A-Z]+)$/.exec(path);
    if (state) return watches.filter((w) => w.state === state[1]).slice(0, 100);
    const row = /^\/tasks\/([^/]+)\/row$/.exec(path);
    if (row) return { title: 'A task', status: 'OPEN', ...rows[row[1]] };
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

describe('a task’s Followed by', () => {
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

describe('a session’s Following and Followed by', () => {
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

  /** A target's own standing as the watch read carries it: a task by status and overlays. */
  const standing = (status: string, over: { running?: boolean; queued?: boolean } = {}) => ({
    targetStatus: { status, running: over.running ?? false, queued: over.queued ?? false },
  });

  it('keeps one line above the composer: the lone target by name, and where it stands', async () => {
    serve([
      watch('WAITING', {
        targets: [target('TASK', 'T1', { targetTitle: 'A task', ...standing('OPEN', { running: true }) })],
        expiresAt: at(6 * HOUR + 10 * MINUTE),
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    // The Background processes tray's own shell, as Tasks created here is drawn in.
    expect(strip.classList.contains('bg-tray')).toBe(true);
    expect(strip.querySelector('.bg-tray-title')?.textContent).toBe('Watching');
    // The name the watch carries, and the task list's own pill for where the task is: no read of its own.
    expect(strip.querySelector('.ct-one')?.textContent).toBe('A task');
    expect(strip.querySelector('.status-pill')?.textContent).toBe('Running');
    expect(vi.mocked(api).mock.calls.map(([path]) => path).filter((path) => !path.startsWith('/watches'))).toEqual([]);
    // Neither the watch's own `met` nor its deadline is on the folded line: the pill says how far it
    // has got, and the deadline is the opened sentence's.
    expect(strip.textContent).not.toContain('met');
    expect(strip.textContent).not.toContain('left');
    expect(strip.querySelector('.wt-expand')?.textContent).toBe('▸');
    expect(strip.querySelector('.ct-list')).toBeNull();
  });

  it('counts several targets in Tasks created here’s sentence, each target once', async () => {
    serve([
      watch('W1', {
        targets: [
          target('TASK', 'T1', standing('OPEN', { running: true })),
          target('TASK', 'T2', standing('FAILED')),
        ],
        ...resumes('S_ME'),
      }),
      watch('W2', { targets: [target('TASK', 'T2', standing('FAILED'))], ...resumes('S_ME') }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    // T1 and T2, not T1, T2 and T2 again.
    expect(strip.querySelector('.watch-strip-target')?.textContent).toBe('2 tasks');
    expect(strip.querySelector('.ct-count')?.textContent).toBe('1 running · 1 failed · 0/2 done');
    expect(strip.querySelector('.ct-count .ct-failed')?.textContent).toBe('1 failed');
    // No one target's pill on a line that names none.
    expect(strip.querySelector('.bg-tray-row .status-pill')).toBeNull();
  });

  it('counts out what a lone watch’s own condition needs, in the card’s noun', async () => {
    const four = [target('TASK', 'T1'), target('TASK', 'T2'), target('TASK', 'T3'), target('TASK', 'T4')];
    const middle = async (predicate: WatchView['predicate']) => {
      serve([watch('W1', { predicate, targets: four, ...resumes('S_ME') })]);
      await mount(<SessionWatchStrip sessionId="S_ME" />);
      return container!.querySelector('.watch-strip-target')?.textContent;
    };
    // Four targets, three conditions, three different amounts of work.
    expect(await middle({ kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' })).toBe('any 1 of 4 tasks');
    expect(await middle({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' })).toBe('all 4 tasks');
    expect(await middle({ kind: 'AT_LEAST', count: 2, over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' })).toBe(
      '2 of 4 tasks',
    );
  });

  it('opens a lone target into its sentence and the ways to it and to the Following page', async () => {
    serve([
      watch('W1', {
        lastEvaluatedAt: at(-MINUTE),
        predicate: { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        targets: [target('TASK', 'T1', { targetTitle: 'A task', ...standing('OPEN') })],
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    await click(strip.querySelector('.bg-tray-row'), 'the strip');
    expect(strip.querySelector('.wt-expand')?.textContent).toBe('▾');
    // One sentence says what the five rows said: the condition, the resume, and the deadline.
    expect(strip.querySelector('.watch-say')?.textContent).toBe(
      'Resumes this session when it finishes, or in 20h at the latest.',
    );
    // The line above already names the one target, so the list doesn't again; the foot leads to it.
    expect(strip.querySelectorAll('.ct-row')).toHaveLength(0);
    const links = [...strip.querySelectorAll<HTMLAnchorElement>('.ct-foot a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Open task ›', '/tasks/T1'],
      ['Manage in Watches ›', '/following'],
    ]);
    // Read-only: no View/Edit/Pause/Stop anywhere, and no button but the caret.
    expect(buttons(strip)).toEqual(['▾']);
    for (const verb of ['View', 'Edit', 'Pause', 'Stop']) {
      expect(strip.textContent, `no ${verb}`).not.toContain(verb);
    }
  });

  it('opens several watches into one sentence each, over the targets each waits on', async () => {
    serve([
      watch('W1', {
        lastEvaluatedAt: at(-MINUTE),
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        targets: [
          target('TASK', 'T1', { targetTitle: 'First', ...standing('OPEN', { running: true }) }),
          target('TASK', 'T2', { state: 'SATISFIED', targetTitle: 'Second', ...standing('DONE') }),
        ],
        expiresAt: at(6 * HOUR + 10 * MINUTE),
        ...resumes('S_ME'),
      }),
      watch('W2', {
        lastEvaluatedAt: at(-MINUTE),
        predicate: { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
        targets: [target('TASK', 'T3', { targetTitle: 'Third', ...standing('OPEN', { queued: true }) })],
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    await click(strip.querySelector('.bg-tray-row'), 'the strip');

    const watches = [...strip.querySelectorAll<HTMLElement>('.watch-strip-watch')];
    expect(watches.map((w) => w.dataset.watchId)).toEqual(['W1', 'W2']);
    expect(watches.map((w) => w.querySelector('.watch-say')?.textContent)).toEqual([
      'Resumes this session when all of them finish, or in 6h at the latest.',
      'Resumes this session when it finishes, or in 20h at the latest.',
    ]);
    // Each target a row in the task list's words, opening its own page; what met the condition first.
    const rows = (w: HTMLElement) =>
      [...w.querySelectorAll<HTMLAnchorElement>('a.ct-row')].map((a) => [
        a.querySelector('.status-pill')?.textContent,
        a.querySelector('.ct-title')?.textContent,
        a.getAttribute('href'),
      ]);
    expect(rows(watches[0])).toEqual([
      ['Done', 'Second', '/tasks/T2'],
      ['Running', 'First', '/tasks/T1'],
    ]);
    expect(rows(watches[1])).toEqual([['Queued', 'Third', '/tasks/T3']]);
    // Several targets: the foot is the way to the Following page alone.
    expect([...strip.querySelectorAll('.ct-foot a')].map((a) => a.textContent)).toEqual(['Manage in Watches ›']);
    expect(buttons(strip.querySelector('.ct-list')!)).toEqual([]);
  });

  it('lists every target a wide watch waits on, the list scrolling past its height', async () => {
    serve([
      watch('WIDE', {
        targets: Array.from({ length: 24 }, (_, i) => target('TASK', `T${i + 1}`, standing('OPEN'))),
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    await click(strip.querySelector('.bg-tray-row'), 'the strip');
    expect(strip.querySelectorAll('.ct-list .ct-row')).toHaveLength(24);
    expect(strip.textContent).not.toContain('more');
  });

  it('says a session target in its own header’s words', async () => {
    serve([
      watch('W', {
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
        targets: [
          target('SESSION', 'S_A', { targetTitle: 'Child A', targetStatus: { status: 'RUNNING', running: true, queued: false } }),
          target('SESSION', 'S_B', {
            targetTitle: 'Child B',
            targetStatus: { status: 'AWAITING_INPUT', running: false, queued: false },
          }),
        ],
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    expect(strip.querySelector('.watch-strip-target')?.textContent).toBe('all 2 sessions');
    // A session whose turn is over is done with what it was doing.
    expect(strip.querySelector('.ct-count')?.textContent).toBe('1 running · 1/2 done');
    await click(strip.querySelector('.bg-tray-row'), 'the strip');
    expect([...strip.querySelectorAll('a.ct-row')].map((a) => [a.querySelector('.status-pill')?.textContent, a.getAttribute('href')])).toEqual([
      ['Running', '/sessions/S_A'],
      ['Waiting for your reply', '/sessions/S_B'],
    ]);
  });

  it('says so under a watch nobody has checked for more than three minutes', async () => {
    const strip = async (lastEvaluatedAt: string) => {
      serve([watch('W', { lastEvaluatedAt, targets: [target('TASK', 'T1', standing('OPEN'))], ...resumes('S_ME') })]);
      await mount(<SessionWatchStrip sessionId="S_ME" />);
      const shown = container!.querySelector('.watch-strip')!;
      await click(shown.querySelector('.bg-tray-row'), 'the strip');
      return shown.querySelector('.watch-say-stale')?.textContent ?? null;
    };
    expect(await strip(at(-MINUTE))).toBeNull();
    expect(await strip(at(-12 * MINUTE))).toBe('Not checked for 12m — the resume may be late.');
  });

  it('draws no strip when the session waits on nothing live', async () => {
    serve(watches().filter((w) => w.id !== 'WAITING'));
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    expect(container!.innerHTML).toBe('');
  });

  it('counts a notifying watch out, though the session is named as its observer', async () => {
    // The runner door files every watch an agent makes with that session as its observer, and that
    // includes NOTIFY_USER — "tell the person when this task is over" waits on the person, not on
    // this session. Drawn here it would say the session is waiting on something that never wakes it,
    // and the block's constant Then row would promise a resume this watch never sends. macOS's
    // `WatchIndex.observing` has always left it out; this is the web reading the same set.
    serve([
      watch('NOTIFYING', {
        action: 'NOTIFY_USER',
        observerType: 'SESSION',
        observerSessionId: 'S_ME',
        targets: [target('TASK', 'T1')],
      }),
    ]);
    await mount(
      <>
        <SessionWatchStrip sessionId="S_ME" />
        <SessionWatchBadges sessionId="S_ME" />
      </>,
    );
    expect(container!.querySelector('.watch-strip'), 'no strip: it waits on the person').toBeNull();
    // The header's chip counts the same set, so it must not count this one either: only Follow left.
    expect(buttons(container!)).toEqual(['Follow']);
  });
});

describe('a live watch older than the newest 100', () => {
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

    expect(container!.querySelector('.watch-strip .bg-tray-title')?.textContent).toBe('Watching');
    expect(buttons(container!.querySelector('.watch-badges')!)).toEqual(['Following 2 tasks', 'Follow']);
    const followedBy = container!.querySelector('section')!;
    expect(followedBy.querySelector('.tdp-section-title span')?.textContent).toBe('Followed by (1)');
    expect([...followedBy.querySelectorAll<HTMLElement>('.watch-row')].map((r) => r.dataset.watchId)).toEqual([
      'OLD_WAIT',
    ]);
  });
});
