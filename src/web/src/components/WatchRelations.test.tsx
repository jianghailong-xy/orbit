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

/** Answers as WatchesService does, from `watches` listed newest first: the newest 100 of every state, or of one. */
function serve(watches: WatchView[], rows: Record<string, TaskRow> = {}) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/watches') return watches.slice(0, 100);
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

  it('keeps one line above the composer naming the lone target a watch waits on', async () => {
    serve(
      [
        watch('WAITING', {
          targets: [target('TASK', 'T1')],
          expiresAt: at(6 * HOUR + 10 * MINUTE),
          ...resumes('S_ME'),
        }),
      ],
      { T1: { status: 'IN_PROGRESS' } },
    );
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    expect(strip.querySelector('.watch-strip-title')?.textContent).toBe('Watching');
    expect(strip.querySelector('.watch-strip-target')?.textContent).toBe('A task');
    // Where that one target stands, off the read its name came from: folded shut, the line answers
    // "is it even running" without the strip being opened.
    expect(strip.querySelector('.watch-target-status')?.textContent).toBe('In progress');
    expect(strip.querySelector('.watch-strip-time')?.textContent).toBe('0 met · 6h left');
    expect(strip.querySelector('.watch-strip-caret')?.textContent).toBe('›');
    expect(strip.querySelector('.watch-strip-block')).toBeNull();
  });

  it('counts the distinct targets and the soonest deadline on one line for several watches', async () => {
    serve([
      watch('W1', {
        targets: [target('TASK', 'T1'), target('TASK', 'T2')],
        expiresAt: at(6 * HOUR + 10 * MINUTE),
        ...resumes('S_ME'),
      }),
      watch('W2', {
        targets: [target('TASK', 'T2')],
        // Held off the whole-minute line: the strip floors what remains, and a deadline exactly
        // 30 minutes out renders 29m only while the clock never steps backward between building
        // this fixture and drawing it — on CI it does, and this test failed there for it (twice).
        expiresAt: at(30 * MINUTE - 30 * 1000),
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    // T1 and T2, not T1, T2 and T2 again: each target is counted once.
    expect(strip.querySelector('.watch-strip-target')?.textContent).toBe('2 tasks');
    expect(strip.querySelector('.watch-strip-time')?.textContent).toBe('earliest 0 met · 29m left');
    // No status on a line that names no one target: several targets have no one status, and
    // reading every row to say so would be a request per target on a line that is folded shut.
    expect(strip.querySelector('.watch-target-status')).toBeNull();
  });

  it('counts out what a lone watch’s own condition needs, in the card’s noun', async () => {
    const four = [target('TASK', 'T1'), target('TASK', 'T2'), target('TASK', 'T3'), target('TASK', 'T4')];
    const middle = async (predicate: WatchView['predicate']) => {
      serve([watch('W1', { predicate, targets: four, ...resumes('S_ME') })]);
      await mount(<SessionWatchStrip sessionId="S_ME" />);
      return container!.querySelector('.watch-strip-target')?.textContent;
    };
    // Four targets, three conditions, three different amounts of work — today all three read
    // "4 targets", which is the count of what the watch covers and not what it is waiting for.
    expect(await middle({ kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' })).toBe('any 1 of 4 tasks');
    expect(await middle({ kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' })).toBe('all 4 tasks');
    expect(await middle({ kind: 'AT_LEAST', count: 2, over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' })).toBe(
      '2 of 4 tasks',
    );
  });

  it('counts the targets that met the condition, so 0 met and 2 met never read alike', async () => {
    const two = [target('TASK', 'T1'), target('TASK', 'T2')];
    serve([watch('W1', { targets: two, ...resumes('S_ME') })]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const waiting = container!.querySelector('.watch-strip-row')?.textContent ?? '';

    serve([watch('W1', { targets: [satisfied('TASK', 'T1'), satisfied('TASK', 'T2')], ...resumes('S_ME') })]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const met = container!.querySelector('.watch-strip-row')?.textContent ?? '';

    expect(met).not.toBe(waiting);
    expect(met).toContain('2 met');
  });

  it('drops "earliest" from a lone watch, whose one deadline is nobody’s earliest', async () => {
    serve([
      watch('W1', {
        targets: [target('TASK', 'T1'), target('TASK', 'T2'), target('TASK', 'T3'), target('TASK', 'T4')],
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const time = container!.querySelector('.watch-strip-time')!;
    // One watch has exactly one deadline, so there is no soonest of several to qualify.
    expect(time.textContent).toBe('0 met · 20h left');
    expect(time.textContent).not.toContain('earliest');
  });

  it('opens into read-only facts, with no controls and a way to the Following page', async () => {
    serve([
      watch('W1', {
        targets: [target('TASK', 'T1')],
        expiresAt: at(6 * HOUR + 10 * MINUTE),
        ...resumes('S_ME'),
      }),
      watch('W2', { targets: [target('TASK', 'T2')], ...resumes('S_ME') }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    await click(strip.querySelector('.watch-strip-row'), 'the strip');
    expect(strip.querySelector('.watch-strip-caret')?.textContent).toBe('⌄');
    const blocks = [...strip.querySelectorAll<HTMLElement>('.watch-strip-block')];
    expect(blocks.map((b) => b.dataset.watchId)).toEqual(['W1', 'W2']);
    // Read-only: the strip holds no View/Edit/Pause/Stop anywhere, and no button at all.
    expect(buttons(strip.querySelector('.watch-strip-list')!)).toEqual([]);
    for (const verb of ['View', 'Edit', 'Pause', 'Stop']) {
      expect(strip.textContent, `no ${verb}`).not.toContain(verb);
    }
    const labels = (block: HTMLElement) => [...block.querySelectorAll('dt')].map((dt) => dt.textContent);
    expect(labels(blocks[0])).toEqual(['Until', 'Progress', 'Watching', 'Then', 'Expires']);
    expect(labels(blocks[1])).toEqual(['Until', 'Progress', 'Watching', 'Expires']);
    // Until says the condition without the sentence's "When", which the label already is.
    expect(blocks[0].querySelectorAll('dd')[0]?.textContent).toBe('The task finishes');
    // Progress carries the evaluator's last look.
    expect(blocks[0].querySelectorAll('dd')[1]?.textContent).toBe('0 met · checked 5m ago');
    // Then is said once, on the first watch: every strip watch resumes this session.
    expect(blocks[0].querySelectorAll('dd')[3]?.textContent).toBe('Resume this session');
    // The deadline says both the span left and the moment it lands, as the card's Expires does.
    expect(blocks[1].querySelectorAll('dd')[3]?.textContent).toMatch(/^in 20h · /);
    const manage = strip.querySelector('a.watch-strip-manage');
    expect(manage?.textContent).toBe('Manage in Watches ›');
    expect(manage?.getAttribute('href')).toBe('/following');
  });

  it('caps the Watching row at three targets and folds the rest into a link', async () => {
    // A watch may name 200 targets; drawn flat, the names push Until, Progress, Then and Expires
    // past the list's max-height and the strip is a directory again.
    serve([
      watch('WIDE', {
        targets: Array.from({ length: 24 }, (_, i) => target('TASK', `T${i + 1}`)),
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    await click(strip.querySelector('.watch-strip-row'), 'the strip');

    const block = strip.querySelector('.watch-strip-block')!;
    expect(block.querySelectorAll('.watch-target')).toHaveLength(3);
    const more = [...block.querySelectorAll('a')].find((a) => a.textContent === '+21 more');
    expect(more, 'the fold is on screen').toBeTruthy();
    expect(more!.tagName).toBe('A');
    expect(more!.getAttribute('href')).toBe('/following?watch=WIDE');
    // One word each, and it is the task's own — never the watch's `met`, which the Progress row counts.
    expect([...block.querySelectorAll('.watch-target-status')].map((s) => s.textContent)).toEqual([
      'Open',
      'Open',
      'Open',
    ]);
    expect(block.querySelector('.watch-target-state'), 'no state word on the shown three').toBeNull();
    expect(buttons(strip.querySelector('.watch-strip-list')!)).toEqual([]);
  });

  it('names the targets that met the condition first, and words each with its own status', async () => {
    serve(
      [
        watch('W', {
          targets: [
            target('TASK', 'T1'),
            target('TASK', 'T2', { state: 'SATISFIED' }),
            target('TASK', 'T3'),
            target('TASK', 'T4', { state: 'SATISFIED' }),
          ],
          ...resumes('S_ME'),
        }),
      ],
      {
        T1: { status: 'IN_PROGRESS' },
        T2: { status: 'DONE' },
        T4: { status: 'CANCELLED', terminalReason: 'SUPERSEDED' },
      },
    );
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    await click(strip.querySelector('.watch-strip-row'), 'the strip');

    const shown = [...strip.querySelectorAll<HTMLElement>('.watch-target')];
    // T2 and T4 first, each group keeping the watch's own order; T3 falls past the cap.
    expect(shown.map((t) => t.getAttribute('title'))).toEqual(['Task T2', 'Task T4', 'Task T1']);
    // One word per row, and it is the task's own — including T4, which met the condition and has
    // since been replaced. `met` said here as well would be a second word to arbitrate against.
    expect(shown.map((t) => t.querySelector('.watch-target-status')?.textContent ?? null)).toEqual([
      'Done',
      'Superseded',
      'In progress',
    ]);
    expect(shown.map((t) => t.querySelector('.watch-target-state')), 'met is not repeated per target')
      .toEqual([null, null, null]);
    // It is still counted once, above, and the satisfied ones are still sorted first.
    const progress = strip.querySelectorAll('.watch-strip-block dd')[1]?.textContent ?? '';
    expect(progress).toMatch(/^2 of 4 met · /);
  });

  it('keeps the recorded word on a session target, which has no status chip of its own', async () => {
    serve([
      watch('W', {
        predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_RUN_TERMINAL' },
        targets: [satisfied('SESSION', 'S_OTHER')],
        ...resumes('S_ME'),
      }),
    ]);
    await mount(<SessionWatchStrip sessionId="S_ME" />);
    const strip = container!.querySelector('.watch-strip')!;
    await click(strip.querySelector('.watch-strip-row'), 'the strip');

    const shown = strip.querySelector('.watch-strip-block .watch-target')!;
    expect(shown.querySelector('.watch-target-status'), 'no task chip for a session').toBeNull();
    expect(shown.querySelector('.watch-target-state')?.textContent).toBe('met');
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

    expect(container!.querySelector('.watch-strip-title')?.textContent).toBe('Watching');
    expect(buttons(container!.querySelector('.watch-badges')!)).toEqual(['Following 2 tasks', 'Follow']);
    const followedBy = container!.querySelector('section')!;
    expect(followedBy.querySelector('.tdp-section-title span')?.textContent).toBe('Followed by (1)');
    expect([...followedBy.querySelectorAll<HTMLElement>('.watch-row')].map((r) => r.dataset.watchId)).toEqual([
      'OLD_WAIT',
    ]);
  });
});
