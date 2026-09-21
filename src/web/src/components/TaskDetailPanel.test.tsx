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
import { ApiError, api } from '../api';
import { newRunRequestToken } from '../lib/runRequestToken';
import { encodeId } from '../lib/idCodec';
import { TASK_RUN_HELD_TITLE, TASK_RUN_PIN_TITLE } from '../lib/taskRunHandoff';
import type { TaskRunConflictToast } from './TaskRunHandoffNotice';
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
// cannot either. That binding, and where the check card's entry leads, are the source-level
// assertions in this file.
const source = readFileSync(fileURLToPath(new URL('./TaskDetailPanel.tsx', import.meta.url)), 'utf8');

/** A pair of spies in place of the real toast, which needs a router and a portal. */
function toast() {
  return {
    success: vi.fn(),
    error: vi.fn(),
    sessionNotice: vi.fn(),
  } as unknown as WriteToast & TaskRunConflictToast & {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    sessionNotice: ReturnType<typeof vi.fn>;
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
/** A run of the task, as the public id the panel links by. */
const LIVE_RUN = '34MOJw69NzKSq2X0exxf9';

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

function renderPanel(data: Record<string, unknown>, deleting = false): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
  });
  qc.setQueryData(['task', TASK_ID], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskDetailPanel
          taskId={TASK_ID}
          onOpenTask={() => {}}
          onClose={() => {}}
          onDelete={() => {}}
          deleting={deleting}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The header's primary action, as its label and whether it can be pressed. */
function primaryAction(html: string): { label: string; disabled: boolean } | null {
  const head = /<div class="tdp-head-actions">([\s\S]*?)<\/div>/.exec(html);
  const m = /<button\s+([^>]*ant-btn-variant-solid[^>]*)>([\s\S]*?)<\/button>/.exec(head?.[1] ?? html);
  if (!m) return null;
  return {
    label: /<span>([^<]*)<\/span>\s*$/.exec(m[2])?.[1] ?? '',
    disabled: /\bdisabled(?:=|\s|$)/i.test(m[1]),
  };
}

/**
 * OWNER_CONFIRMED in the panel: one place to confirm at a time. A task no run is waiting on — above
 * all one that never ran and is only a record — gets Confirm done beside Run now. While a run is
 * waiting on its owner, the answer is the card in that run's session, so the panel only points there
 * and offers no button of its own.
 */
describe('an OWNER_CONFIRMED task in the panel', () => {
  const OWNER_CONFIRMED = { completionCriterion: 'OWNER_CONFIRMED', completionPolicy: 'MANUAL' };
  const RUN_SESSION = '34MOJw69NzKSq2X0exxf9';

  /** The panel over a task and, when given, the confirmation read the server returned for it. */
  function renderWithConfirmation(
    data: Record<string, unknown>,
    confirmation?: Record<string, unknown>,
  ): string {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnMount: false, retryOnMount: false } },
    });
    qc.setQueryData(['task', TASK_ID], data);
    if (confirmation) qc.setQueryData(['task', TASK_ID, 'owner-confirmation'], confirmation);
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TaskDetailPanel
            taskId={TASK_ID}
            onOpenTask={() => {}}
            onClose={() => {}}
            onDelete={() => {}}
            deleting={false}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  // The actions row alone — the panel's two window buttons (🗑 ✕) are its siblings, not its
  // contents, so a slice that ran past its close would read them as actions.
  const head = (html: string): string =>
    /<div class="tdp-head-actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  const buttonLabels = (html: string): string[] =>
    [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gu)].map((m) => m[1].replace(/<[^>]*>/gu, ''));
  const confirmation = (over: Record<string, unknown> = {}) => ({
    taskId: TASK_ID,
    title: 'Run the nightly ingest',
    status: 'OPEN',
    projectId: null,
    completionCriterion: 'OWNER_CONFIRMED',
    acceptanceCriteria: null,
    waiting: null,
    decisions: [],
    ...over,
  });

  it('offers Confirm done beside Run now on a task that never ran', () => {
    const actions = head(renderWithConfirmation(task(OWNER_CONFIRMED)));
    expect(buttonLabels(actions)).toContain('Confirm done');
    // Beside, not instead: the task can still be run.
    expect(buttonLabels(actions)).toContain('Run now');
  });

  it('only points at the card while a run of the task is waiting on its owner', () => {
    const html = renderWithConfirmation(
      task({ ...OWNER_CONFIRMED, sessions: [{ id: RUN_SESSION, status: 'AWAITING_INPUT' }] }),
      confirmation({
        waiting: {
          requestId: '01920000-0000-7000-8000-0000000000f1',
          sessionId: RUN_SESSION,
          requestedAt: '2026-09-13T10:39:00.000Z',
          report: { text: 'Done.', reportedAt: '2026-09-13T10:39:00.000Z' },
        },
      }),
    );
    const actions = head(html);
    expect(buttonLabels(actions)).not.toContain('Confirm done');
    expect(buttonLabels(actions)).not.toContain('Chat about this');
    expect(actions).toMatch(
      new RegExp(`<a[^>]*href="/sessions/${RUN_SESSION}"[^>]*>Waiting for your confirmation</a>`, 'u'),
    );
  });

  it('offers Confirm done again once nothing is waiting, as the read says', () => {
    const actions = head(renderWithConfirmation(
      task({ ...OWNER_CONFIRMED, sessions: [{ id: RUN_SESSION, status: 'AWAITING_INPUT' }] }),
      confirmation(),
    ));
    expect(buttonLabels(actions)).toContain('Confirm done');
    expect(actions).not.toContain('Waiting for your confirmation');
  });

  it('offers nothing it cannot stand behind', () => {
    // A task that has run, before the read says whether a run is waiting: a button here could be
    // a second place to answer the card.
    expect(buttonLabels(head(renderWithConfirmation(
      task({ ...OWNER_CONFIRMED, sessions: [{ id: RUN_SESSION, status: 'AWAITING_INPUT' }] }),
    )))).not.toContain('Confirm done');
    // A settled task.
    expect(buttonLabels(head(renderWithConfirmation(task({ ...OWNER_CONFIRMED, status: 'DONE' })))))
      .not.toContain('Confirm done');
    // Another criterion: the owner's confirmation settles nothing there.
    expect(buttonLabels(head(renderWithConfirmation(task({ completionCriterion: 'EXECUTABLE' })))))
      .not.toContain('Confirm done');
  });
});

describe('the task panel’s delete', () => {
  /** The header's delete button's opening tag, or null when the header has none. */
  const deleteButton = (html: string) =>
    /<button[^>]*aria-label="Delete task"[^>]*>/.exec(html)?.[0] ?? null;

  it('sits in the header, so a task can be deleted without hovering its row', () => {
    // The row's trash only appears on hover, which a touch screen never produces.
    expect(deleteButton(renderPanel(task()))).not.toBeNull();
  });

  it('sits beside the actions row rather than in it, so the phone rule keeps it by the title', () => {
    // Below 600px index.css lifts exactly `.tdp-head > .ant-btn-icon-only` — the panel's own two
    // window buttons — out of the pressing row and leaves them on the title's line. Put either of
    // them back inside `.tdp-head-actions` and that rule stops matching it and the phone header
    // quietly goes back to four presses on one line.
    expect(renderPanel(task())).toMatch(
      /<div class="tdp-head-actions">[\s\S]*?<\/div><button[^>]*aria-label="Delete task"[\s\S]*?<button[^>]*aria-label="Close"/,
    );
  });

  it('shows the delete in progress', () => {
    expect(deleteButton(renderPanel(task()))).not.toMatch(/ant-btn-loading/);
    expect(deleteButton(renderPanel(task(), true))).toMatch(/ant-btn-loading/);
  });
});

describe('the task panel’s header action', () => {
  it('is called Run now, not Run', () => {
    // "Run" reads like a mode this task is put into. "Run now" is what the button actually does,
    // and the distinction is load-bearing on a task that has a start scheduled for later.
    const out = renderPanel(task());
    expect(primaryAction(out)!.label).toBe('Run now');
    expect(out).not.toMatch(/<span>Run<\/span>/);
  });

  it('points at the run in flight, where it used to say Running and refuse to be pressed', () => {
    // What it replaced: a disabled button naming a state. True, and the one thing a reader who
    // wants to SEE that run cannot act on — and on a row whose status still reads FAILED the same
    // gap drew a Retry whose only possible answer was a 409. The live run decides, not `status`
    // (`lib/taskRunHandoff.ts#taskRunEntry`), and this panel holds the sessions so it can say
    // which one.
    const out = renderPanel(task({ sessions: [{ id: LIVE_RUN, status: 'RUNNING' }] }));
    expect(primaryAction(out)).toEqual({ label: 'Open the run', disabled: false });
    expect(out).toMatch(new RegExp(`<a[^>]*href="/sessions/${encodeId(LIVE_RUN)}"`, 'u'));
    // The reported case: this copy still says FAILED because the platform re-dispatched the task
    // seconds ago. The entry follows the run, not the label.
    expect(
      primaryAction(
        renderPanel(task({ status: 'FAILED', sessions: [{ id: LIVE_RUN, status: 'RUNNING' }] })),
      )!.label,
    ).toBe('Open the run');
    // A run still waiting for a slot holds the task's claim just as a running one does.
    expect(
      primaryAction(
        renderPanel(task({ status: 'FAILED', sessions: [{ id: LIVE_RUN, status: 'PENDING' }] })),
      )!.label,
    ).toBe('Open the run');
  });

  it('is still a retry once nothing of the task is going', () => {
    const out = renderPanel(task({ status: 'FAILED', sessions: [{ id: LIVE_RUN, status: 'FAILED' }] }));
    expect(primaryAction(out)).toEqual({ label: 'Retry', disabled: false });
    expect(out).not.toMatch(new RegExp(`<a[^>]*href="/sessions/${encodeId(LIVE_RUN)}"[^>]*>Open`, 'u'));
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

  it('runs a work row that declares it is judged by an independent review', () => {
    // The shape the split axis exists for: work to do AND a verdict that settles it. The button is
    // an ordinary Run now — the row can be started, and starting it is what the reader wants.
    // (The criterion alone used to replace this button; the work-row half of that gate is gone.)
    const out = renderPanel(task({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'MANUAL',
      verifiesTaskId: null,
    }));
    expect(primaryAction(out)).toEqual({ label: 'Run now', disabled: false });
    expect(out).toContain('Judged by · an independent check');
    expect(out).not.toContain('Missing verifier');
  });

  it('replaces Run now with the gate on a row that has no work of its own', () => {
    const out = renderPanel(task({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
    }));
    expect(primaryAction(out)).toEqual({ label: 'Decided by its verification task', disabled: true });
    expect(out).not.toContain('>Run now</span>');
  });

  it('takes the gate from the policy, not from the criterion', () => {
    // The row nothing can dispatch is the one with no verifier of its own, whatever criterion it
    // declares. This is the pair the write doors refuse today and rows written before that rule
    // still hold: the server's own Ready predicate kills it by policy, so the panel must too — and
    // the gate chip wins over the criterion's own chip.
    const out = renderPanel(task({
      completionCriterion: 'EVIDENCE_JUDGMENT',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
    }));
    expect(primaryAction(out)).toEqual({ label: 'Decided by its verification task', disabled: true });
    expect(out).toContain('Gate · no work of its own');
    expect(out).not.toContain('Judged by · submitted evidence');
    // ...and its verifier is an ordinary runnable row, not a gate.
    expect(renderPanel(task({ completionCriterion: 'VERIFICATION', completionPolicy: 'MANUAL', verifiesTaskId: 'subj' })))
      .toContain('>Run now</span>');
  });

  /** The declaration that makes a task a gate row, as the detail read carries it. */
  const subject = (over: Record<string, unknown> = {}) =>
    task({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
      ...over,
    });

  it.each(['MISSING', 'PENDING', 'RUNNING', 'BLOCKED', 'FAILED', 'PASSED'])(
    'says one honest thing on a %s gate row, and still cannot be pressed',
    (verificationState) => {
      // The label is what the button cannot do — nothing here starts a run. Which check, and how
      // far it has got, is said by the chip and by the card under the header, not by the button.
      // None of these states may put a "Missing verifier" the reader is told to go create back on
      // the button: no client in this repo can write a verification task.
      const out = renderPanel(subject({ verificationState }));
      expect(primaryAction(out)).toEqual({ label: 'Decided by its verification task', disabled: true });
      expect(out).not.toContain('Missing verifier');
      expect(out).not.toContain('create a verification task');
    },
  );

  it('never says a done gate row is still waiting on a verdict', () => {
    // A passed verifier, a newer one that has not reported yet, or an API too old to say.
    for (const verificationState of ['PASSED', 'PENDING', undefined]) {
      const out = renderPanel(subject({ status: 'DONE', verificationState }));
      expect(primaryAction(out)).toEqual({ label: 'Decided by its verification task', disabled: true });
      expect(out).not.toContain('Awaiting verification');
      expect(out).not.toContain('Missing verifier');
    }
  });

  it('leaves an ordinary task at Run now when the detail reports no verifier state', () => {
    expect(primaryAction(renderPanel(task({ verificationState: null })))).toEqual({
      label: 'Run now',
      disabled: false,
    });
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

/**
 * What the panel says about how a row is decided, and where the check itself is shown.
 *
 * The row's status badge says where the task stands; neither it nor anything else on the page said
 * WHO settles it — and the one thing the page did say about that, on a row nobody had checked yet,
 * was an instruction no client can carry out.
 */
describe('how the panel says a row is decided, and what checks it', () => {
  /** The chip under the title, as its text. */
  const chipOf = (html: string): string | null =>
    /<div class="tdp-judgment[^"]*">([\s\S]*?)<\/div>/.exec(html)?.[1]?.replace(/<[^>]*>/g, '') ?? null;

  const CHECK = {
    id: 'c1',
    title: '独立复核:导入收尾假失败的根因与修复',
    status: 'OPEN',
    verdict: null,
  };

  it.each([
    ['EXECUTABLE', 'Judged by · its acceptance command'],
    ['VERIFICATION', 'Judged by · an independent check'],
    ['EVIDENCE_JUDGMENT', 'Judged by · submitted evidence'],
    ['OWNER_CONFIRMED', 'Judged by · the account owner'],
  ])('names the judgment method a %s row declares', (completionCriterion, text) => {
    expect(chipOf(renderPanel(task({ completionCriterion })))).toBe(text);
  });

  it('says a gate row has no work of its own, in the place a missing verifier used to be named', () => {
    const out = renderPanel(task({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
      verificationState: 'MISSING',
    }));
    expect(chipOf(out)).toBe('Gate · no work of its own');
    // The old copy for this state, and the instruction behind it, are both gone from the panel.
    expect(out).not.toContain('Missing verifier');
    expect(out).not.toContain('create a verification task');
    expect(out).toContain('No verification task yet');
  });

  it('says nothing about judgment on a row that declares no method', () => {
    const out = renderPanel(task({ completionCriterion: null, completionPolicy: 'MANUAL' }));
    expect(chipOf(out)).toBeNull();
    // ...and no check card either: this row is decided by nothing in particular.
    expect(out).not.toContain('Verification task');
  });

  /** The card under the header, as its own text — tags out, and runs of whitespace collapsed to
   *  one space so a two-line sentence still reads as one string. */
  const cardOf = (html: string): string =>
    (/<section class="tdp-verifier">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ');

  it.each([
    ['a passed', 'PASS', 'PASS', 'tone-green'],
    ['a failed', 'FAIL', 'FAIL', 'tone-red'],
    ['an unanswered', null, 'Open', 'tone-muted'],
  ])('shows the check that decides the row: its title, %s verdict and the way in', (
    _case,
    verdict,
    label,
    tone,
  ) => {
    const out = renderPanel(task({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'MANUAL',
      verifier: { ...CHECK, verdict },
    }));
    expect(out).toMatch(new RegExp(`<span class="tdp-badge ${tone}">${label}</span>`));
    // Title, state and the way in, all three in the card.
    expect(cardOf(out)).toContain('Verification task');
    expect(cardOf(out)).toContain(CHECK.title);
    expect(cardOf(out)).toContain(label);
    expect(cardOf(out)).toContain('View');
  });

  it('shows the empty state on a gate row nothing checks, and not an impossible instruction', () => {
    const out = renderPanel(task({
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
      verificationState: 'MISSING',
    }));
    expect(out).toContain('Verification task');
    expect(out).toContain('No verification task yet — this row has no work of its own');
    expect(out).not.toMatch(/verifiesTaskId|create a verification task/);
  });

  it('leads the entry to the check, not back to the row it checks', () => {
    // A static render cannot press the button, so the destination is asserted where it is written:
    // the entry hands the opener the check's own id. `onOpenTask(taskId)` is how this panel swaps
    // what it shows, so this is the difference between a door and a decoration.
    expect(source).toContain('onOpenTask(verifier.id)');
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
      'The verification task is filed, and has not concluded yet.',
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

  it('tells a gate row’s reader what its check is doing, and asks for nothing they cannot do', () => {
    const subject = { ...runnable, completionOwned: true };
    expect(runNowHint({ ...subject, verificationState: 'MISSING' })).toBe(
      'No verification task yet — this row has no work of its own, and nothing in the ledger '
      + 'points at one.',
    );
    expect(runNowHint({ ...subject, verificationState: 'PENDING' })).toBe(
      'The verification task is filed, and has not concluded yet.',
    );
    expect(runNowHint({ ...subject, verificationState: 'RUNNING' })).toBe(
      'The verification task is running — its conclusion decides this row.',
    );
    expect(runNowHint({ ...subject, verificationState: 'BLOCKED' })).toBe(
      'The verification task is blocked — clear what is blocking it first.',
    );
    // FAIL and INCONCLUSIVE both arrive as FAILED, and neither is answered by running it again.
    expect(runNowHint({ ...subject, verificationState: 'FAILED' })).toBe(
      'The verification concluded it failed — this row will not settle.',
    );
    expect(runNowHint({ ...subject, verificationState: 'PASSED' })).toBe(
      'The verification passed — applying the result.',
    );
    expect(runNowHint({ ...subject, status: 'DONE', verificationState: 'PASSED' })).toBe(
      'The verification passed — this row is finished.',
    );
    // The check's own sentence still outranks every other gate, as the generic one did.
    expect(
      runNowHint({ ...subject, blocked: true, canExecute: false, verificationState: 'MISSING' }),
    ).toBe('No verification task yet — this row has no work of its own, and nothing in the ledger points at one.');
  });

  it('never sends a reader after a verification task they have no way to create', () => {
    // Every wording of every state, because this is the sentence that made the panel a liar: it
    // told the reader to create a verification task with `verifiesTaskId` set, and no client in
    // this repository — web, macOS or iOS — can write that field.
    const subject = { ...runnable, completionOwned: true };
    for (const verificationState of ['MISSING', 'PENDING', 'RUNNING', 'BLOCKED', 'FAILED', 'PASSED', null, undefined]) {
      const hint = runNowHint({ ...subject, verificationState: verificationState as never });
      expect(hint).not.toMatch(/create a verification task/i);
      expect(hint).not.toMatch(/verifiesTaskId/);
      expect(hint).not.toMatch(/file a new verification task/i);
    }
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

  it('answers a task that has already moved on with the run, not with the server’s English', async () => {
    // The panel's press meets the same gap the row's does: its copy of the task is from before
    // the re-dispatch. The refusal names the run that has it, so that is what the reader is given.
    const qc = seededCache();
    const message = toast();
    const RUN = '34MOJw69NzKSq2X0exxf9';
    const raw =
      `task ${TASK_ID} could not be started: session ${RUN} (RUNNING) holds its execution claim. `
      + 'Let that run reach a terminal status of its own, then start the task again';
    vi.mocked(api).mockClear();
    vi.mocked(api).mockRejectedValueOnce(
      new ApiError(raw, 409, 'TASK_ALREADY_RUNNING', {
        code: 'TASK_ALREADY_RUNNING',
        message: raw,
        taskId: TASK_ID,
        conflictingSessionId: RUN,
        conflictingSessionStatus: 'RUNNING',
        retryable: true,
      }),
    );

    await new MutationObserver(qc, {
      ...runNowMutationOptions(qc, message, TASK_ID, PROJECT_ID),
      retry: false,
    })
      .mutate({ triggerId: newRunRequestToken() })
      .catch(() => {});

    expect(message.error).not.toHaveBeenCalled();
    const card = message.sessionNotice.mock.calls[0][0];
    expect(card.sessionId).toBe(RUN);
    expect(card.headline).toBe(TASK_RUN_HELD_TITLE);
    expect(`${card.headline} ${card.detail}`).not.toContain('execution claim');
    // A pin conflict is a different remedy and says so, rather than sharing one "wait" card.
    const pinRaw = `task ${TASK_ID} is pinned to deepseek, but session ${RUN} holds its claim`;
    vi.mocked(api).mockRejectedValueOnce(
      new ApiError(pinRaw, 409, 'TASK_RUN_PIN_CONFLICT', {
        code: 'TASK_RUN_PIN_CONFLICT',
        message: pinRaw,
        taskId: TASK_ID,
        conflictingSessionId: RUN,
        pinnedTo: 'deepseek',
        runningOn: 'claude',
        retryable: true,
      }),
    );
    await new MutationObserver(qc, {
      ...runNowMutationOptions(qc, message, TASK_ID, PROJECT_ID),
      retry: false,
    })
      .mutate({ triggerId: newRunRequestToken() })
      .catch(() => {});
    expect(message.sessionNotice.mock.calls[1][0].headline).toBe(TASK_RUN_PIN_TITLE);
    expect(message.error).not.toHaveBeenCalled();
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
