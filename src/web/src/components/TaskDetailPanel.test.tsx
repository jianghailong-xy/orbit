import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import {
  MutationObserver,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { newRunRequestToken } from '../lib/runRequestToken';
import type { WriteToast } from './TaskScheduleEditor';
import { TaskDetailPanel, runNowHint, runNowMutationOptions } from './TaskDetailPanel';

// A static (effect-free) render never invokes a queryFn, so the cache is seeded instead. Partial,
// because the module also exports the attachment resolver Transcript reads at load time.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

// The panel restores its drag-resized width on mount; Node has no localStorage to restore from.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

// The panel binds its two schedule-aware pieces to the SERVER's answer rather than the list-row
// summary, which a static render cannot show (a project id reaches no markup) and a mutation
// cannot either. That one binding is the only source-level assertion in this file.
const source = readFileSync(fileURLToPath(new URL('./TaskDetailPanel.tsx', import.meta.url)), 'utf8');

/** A pair of spies in place of the real toast, which needs a router and a portal. */
function toast() {
  return { success: vi.fn(), error: vi.fn() } as unknown as WriteToast & {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

/** A cache holding every view a started run touches, plus one that must be left alone. */
function seededCache() {
  const qc = new QueryClient();
  qc.setQueryData(['task', TASK_ID], { id: TASK_ID, runAt: '2026-09-01T01:00:00.000Z' });
  qc.setQueryData(['tasks', 'page', null], { items: [] });
  qc.setQueryData(['project', PROJECT_ID, 'tasks', 'root'], { items: [] });
  qc.setQueryData(['project', PROJECT_ID, 'tasks', 'children', 'parent62'], { items: [] });
  qc.setQueryData(['project', OTHER_PROJECT_ID, 'tasks', 'root'], { items: [] });
  return qc;
}

const invalidatedIn = (qc: QueryClient) => (key: unknown[]) =>
  qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;

/** One turn of the microtask/macrotask queue — enough for a settled promise chain to run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function inTimeZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const SHANGHAI = 'Asia/Shanghai';
// The short public id the panel is handed and puts straight into every path it builds.
const TASK_ID = '3kL9pQr2';
const PROJECT_ID = '7bV4mNc1';
const OTHER_PROJECT_ID = '2wX8dHt5';

/** A runnable task: assigned, unblocked, nothing in flight. */
function task(over: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    title: 'Run the nightly ingest',
    status: 'OPEN',
    assignee: { id: 'w-codex', name: 'Builder' },
    sessions: [],
    comments: [],
    dependsOn: [],
    dependedOnBy: [],
    ...over,
  };
}

function renderPanel(data: Record<string, unknown>): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
  qc.setQueryData(['task', TASK_ID], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskDetailPanel taskId={TASK_ID} onOpenTask={() => {}} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The header's primary action, as its label and whether it can be pressed. */
function primaryAction(html: string): { label: string; disabled: boolean } | null {
  const head = /<div class="tdp-head-actions">([\s\S]*?)<\/div><\/div>/.exec(html);
  const m = /<button\s+([^>]*ant-btn-variant-solid[^>]*)>([\s\S]*?)<\/button>/.exec(head?.[1] ?? html);
  if (!m) return null;
  return {
    label: /<span>([^<]*)<\/span>\s*$/.exec(m[2])?.[1] ?? '',
    disabled: /\bdisabled(?:=|\s|$)/i.test(m[1]),
  };
}

describe('the task panel’s header action', () => {
  it('is called Run now, not Run', () => {
    // "Run" reads like a mode this task is put into. "Run now" is what the button actually does,
    // and the distinction is load-bearing on a task that has a start scheduled for later.
    const out = renderPanel(task());
    expect(primaryAction(out)!.label).toBe('Run now');
    expect(out).not.toMatch(/<span>Run<\/span>/);
  });

  it('still says Running, and stays disabled, while a session is busy', () => {
    // The rename must not cost the state that debounces the button against a second trigger.
    const out = renderPanel(task({ sessions: [{ id: 's1', status: 'RUNNING' }] }));
    expect(primaryAction(out)).toEqual({ label: 'Running', disabled: true });
  });

  it('keeps every gate that decided whether it could be pressed at all', () => {
    // Unassigned: there is no workspace to trigger.
    expect(primaryAction(renderPanel(task({ assignee: null })))!.disabled).toBe(true);
    // Blocked on a prerequisite: mirrors the backend's own execute gate.
    expect(
      primaryAction(
        renderPanel(
          task({
            dependencyState: 'BLOCKED',
            dependsOn: [{ dependsOnTask: { id: 'p1', title: 'first', status: 'OPEN' } }],
          }),
        ),
      )!.disabled,
    ).toBe(true);
    // And a runnable task is still runnable.
    expect(primaryAction(renderPanel(task()))!.disabled).toBe(false);
  });

  it('replaces Run now with the verification state on a completion-owned subject', () => {
    const out = renderPanel(task({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
    }));
    expect(primaryAction(out)).toEqual({ label: 'Awaiting verification', disabled: true });
    expect(out).not.toContain('>Run now</span>');
  });

  it('mounts the Start at editor on the server’s own schedule and project', () => {
    const out = inTimeZone(SHANGHAI, () =>
      renderPanel(task({ runAt: '2026-09-01T01:00:00.000Z', projectId: PROJECT_ID })),
    );
    expect(out).toContain('>Start at</label>');
    expect(out).toMatch(/<input[^>]*type="datetime-local"[^>]*value="2026-09-01T09:00"/);
    // ...and says, in the panel itself, what Run now would cost — the tooltip below is a hover
    // away, and this sentence is where a reader comparing the two buttons is looking.
    expect(out).toContain('Run now starts immediately and clears this scheduled start.');
  });
});

describe('runNowHint — what the header button says on hover', () => {
  const runnable = { blocked: false, canExecute: true, running: false };

  it('explains that running now spends the scheduled start', () => {
    // The server consumes `runAt` on the first accepted run, one-shot by construction — so a
    // reader who presses this to "see it work" loses the appointment they set. Saying so is what
    // makes a confirmation dialog unnecessary.
    expect(runNowHint({ ...runnable, scheduledLocal: 'Sep 1, 9:00 AM' })).toBe(
      'Starts immediately and clears the start scheduled for Sep 1, 9:00 AM.',
    );
    // It names the start it would clear, so the reader knows which appointment is at stake.
    expect(runNowHint({ ...runnable, scheduledLocal: 'Sep 1, 9:00 AM' })).toContain('Sep 1, 9:00 AM');
  });

  it('says nothing at all on an unscheduled task that can just run', () => {
    // '' is no tooltip — antd renders nothing for an empty title, which is right when there is
    // neither an obstacle nor anything to lose.
    for (const none of [undefined, null, '']) {
      expect(runNowHint({ ...runnable, scheduledLocal: none })).toBe('');
    }
  });

  it('puts the reasons the button is disabled ahead of the schedule', () => {
    // Each of these is also a reason the button cannot be pressed, so the tooltip is the only
    // place the reader is told why — a schedule is irrelevant to a task that cannot start.
    const scheduled = { scheduledLocal: 'Sep 1, 9:00 AM' };
    expect(runNowHint({ ...runnable, ...scheduled, completionOwned: true })).toBe(
      'Awaiting verification — subject work cannot be started',
    );
    expect(runNowHint({ ...runnable, ...scheduled, blocked: true })).toBe('Waiting for prerequisites');
    expect(
      runNowHint({ ...runnable, ...scheduled, blocked: true, dependencyState: 'BLOCKED_FAILED' }),
    ).toBe('Prerequisite cancelled — resolve it first');
    expect(runNowHint({ ...runnable, ...scheduled, canExecute: false })).toBe('Assign a workspace first');
    expect(runNowHint({ ...runnable, ...scheduled, running: true })).toBe('Task running…');
  });

  it('keeps those four answers exactly as they were on an unscheduled task', () => {
    // The rename and the new sentence must not have changed what the existing gates say.
    expect(runNowHint({ blocked: true, canExecute: true, running: false })).toBe(
      'Waiting for prerequisites',
    );
    expect(
      runNowHint({ blocked: true, dependencyState: 'BLOCKED_FAILED', canExecute: true, running: false }),
    ).toBe('Prerequisite cancelled — resolve it first');
    expect(runNowHint({ blocked: false, canExecute: false, running: false })).toBe(
      'Assign a workspace first',
    );
    expect(runNowHint({ blocked: false, canExecute: true, running: true })).toBe('Task running…');
  });
});

describe('what a successful Run now refreshes', () => {
  it('starts the run, and refreshes the task views and the task’s project', async () => {
    // An accepted run CONSUMES the schedule — the server sets `runAt` back to NULL, one-shot by
    // construction — so a Project row that is not refreshed goes on advertising a start that has
    // already been spent.
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({});

    const observer = new MutationObserver(qc, {
      ...runNowMutationOptions(qc, message, TASK_ID, PROJECT_ID),
      retry: false,
    });
    // Drawn at the click and handed to the mutation as a variable, so this is exactly what goes
    // out — and exactly what any automatic resend below this line would send again.
    const triggerId = newRunRequestToken();
    await observer.mutate({ triggerId });

    expect(vi.mocked(api)).toHaveBeenCalledWith(`/tasks/${TASK_ID}/execute`, {
      method: 'POST',
      body: { triggerId },
    });
    expect(message.success).toHaveBeenCalledWith('Assignee workspace triggered');
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', TASK_ID])).toBe(true);
    expect(invalidated(['tasks', 'page', null])).toBe(true);
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'children', 'parent62'])).toBe(true);
    // Another project's page never contained this task.
    expect(invalidated(['project', OTHER_PROJECT_ID, 'tasks', 'root'])).toBe(false);
  });

  it('refreshes nothing when the run is refused, so the schedule stays on screen', async () => {
    // Invalidating here would refetch a task whose schedule never moved, and a row redrawn as
    // though it had is the one report that would be wrong.
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(new Error('no runner available'));

    const observer = new MutationObserver(qc, {
      ...runNowMutationOptions(qc, message, TASK_ID, PROJECT_ID),
      retry: false,
    });
    await observer.mutate({ triggerId: newRunRequestToken() }).catch(() => {});

    expect(observer.getCurrentResult().isError).toBe(true);
    // The schedule is exactly where it was, and nothing was even marked stale.
    expect(qc.getQueryData(['task', TASK_ID])).toEqual({
      id: TASK_ID,
      runAt: '2026-09-01T01:00:00.000Z',
    });
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', TASK_ID])).toBe(false);
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(false);
    // ...and the reason reaches the reader whole, through the existing toast path.
    expect(message.error).toHaveBeenCalledWith('no runner available');
    expect(message.success).not.toHaveBeenCalled();
  });

  it('sends a NEW name when the reader presses Run now again over a failed run', async () => {
    // The press that failed left no run to be idempotent WITH, so a second press is a second
    // request and must say so. Nothing here remembers the failed name — the name is drawn at the
    // CLICK and carried down as a variable, so two clicks cannot agree by construction.
    const qc = seededCache();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(new Error('no runner available'));
    vi.mocked(api).mockResolvedValueOnce({});

    const options = { ...runNowMutationOptions(qc, toast(), TASK_ID, PROJECT_ID), retry: false };
    await new MutationObserver(qc, options)
      .mutate({ triggerId: newRunRequestToken() })
      .catch(() => {});
    await new MutationObserver(qc, options).mutate({ triggerId: newRunRequestToken() });

    const names = vi
      .mocked(api)
      .mock.calls.map(([, init]) => (init as { body: { triggerId: string } }).body.triggerId);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  it('draws the name at the CLICK, not inside the request', () => {
    // Not expressible as a type, and invisible to every other test here. Inside `mutationFn` it
    // would be redrawn by react-query's own retry — one press, two names, two runs; remembered
    // across presses it would answer a deliberate second press from the first one's receipt.
    expect(source).toContain('onClick={() => execute.mutate({ triggerId: newRunRequestToken() })}');
    expect(source).not.toMatch(/mutationFn[\s\S]{0,300}newRunRequestToken/);
  });

  it('refreshes no project at all for a task filed under none', async () => {
    const qc = seededCache();
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({});
    const observer = new MutationObserver(qc, {
      ...runNowMutationOptions(qc, toast(), TASK_ID, null),
      retry: false,
    });
    await observer.mutate({ triggerId: newRunRequestToken() });

    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', TASK_ID])).toBe(true);
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(false);
  });

  it('stays pending until those views have actually refetched', async () => {
    // Otherwise the button leaves its loading state the instant the server accepts the run and
    // before a single query has refetched — enabled again, still showing the schedule that run
    // just spent, which is an invitation to trigger it twice.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release!: () => void;
    const refetching = new Promise<void>((resolve) => {
      release = resolve;
    });
    qc.setQueryData(['task', TASK_ID], { id: TASK_ID });
    // An ACTIVE observer, because an invalidation only refetches queries something is watching —
    // which is exactly the open panel this runs behind.
    const watcher = new QueryObserver(qc, {
      queryKey: ['task', TASK_ID],
      queryFn: async () => {
        await refetching;
        return { id: TASK_ID };
      },
      refetchOnMount: false,
    });
    const unsubscribe = watcher.subscribe(() => {});
    vi.mocked(api).mockClear();
    vi.mocked(api).mockResolvedValueOnce({});

    const observer = new MutationObserver(qc, {
      ...runNowMutationOptions(qc, toast(), TASK_ID),
      retry: false,
    });
    const landed = observer.mutate({ triggerId: newRunRequestToken() });

    // The execute POST is long done; the panel has not caught up.
    await tick();
    await tick();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().isPending).toBe(true);

    release();
    await landed;
    expect(observer.getCurrentResult().isPending).toBe(false);
    unsubscribe();
  });

  it('is built from the server’s own task, never the list-row summary', () => {
    // The summary carries neither a schedule nor a project, so binding either to it would drop
    // the start for the moment before /tasks/:id resolves and refresh no project at all. Neither
    // binding reaches markup or a mutation, which is why this one is read from the source.
    expect(source).toContain(
      'const execute = useMutation(runNowMutationOptions(qc, message, taskId, q.data?.projectId));',
    );
    expect(source).toContain(
      '<TaskScheduleEditor taskId={taskId} runAt={q.data?.runAt} projectId={q.data?.projectId} />',
    );
  });
});
