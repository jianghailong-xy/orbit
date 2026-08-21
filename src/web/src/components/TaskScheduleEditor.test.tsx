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
import { RUN_AT_IMPOSSIBLE } from '../lib/taskSchedule';
import {
  TaskScheduleEditor,
  TaskScheduleFields,
  taskScheduleMutations,
  type WriteToast,
} from './TaskScheduleEditor';

// A static (effect-free) render never invokes a queryFn or a mutationFn, so `api` is stubbed both
// as a backstop against an accidental live call and as the place a request shows up when a test
// drives one of the two exported request functions by hand. Partial, because the module also
// exports the attachment resolver a sibling import pulls in at load time.
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(() => new Promise(() => {})),
}));

/**
 * A scheduled start is the one thing here whose correct answer depends on WHERE the reader is, so
 * every render below runs in a pinned zone rather than the machine's own — otherwise this would
 * pass in UTC (where local and UTC agree, and the bug it guards is invisible) and fail everywhere
 * else. Node re-reads `process.env.TZ` on the next Date/Intl call, so setting it around one call
 * is enough; restoring it keeps the rest of the file in the host's zone.
 */
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

// One thing in this file is genuinely unreachable without a reconciler driving re-renders — see
// the last describe block, which is the only source-level assertion here.
const source = readFileSync(fileURLToPath(new URL('./TaskScheduleEditor.tsx', import.meta.url)), 'utf8');

/** A pair of spies in place of the real toast, which needs a router and a portal. */
function toast() {
  return { success: vi.fn(), error: vi.fn() } as unknown as WriteToast & {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

const SHANGHAI = 'Asia/Shanghai'; // UTC+8 year-round
const NEW_YORK = 'America/New_York'; // UTC-4 in September
const BERLIN = 'Europe/Berlin'; // springs forward 02:00 -> 03:00 on 2026-03-29

// The short public id the panel holds and puts straight into the path, exactly as every other
// request in it does — never a raw UUID, which is not what the server names a task by here.
const TASK_ID = '3kL9pQr2';
const PROJECT_ID = '7bV4mNc1';
const OTHER_PROJECT_ID = '2wX8dHt5';

/** A cache holding the views a schedule write touches, plus one that must be left alone. */
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

function renderEditor(
  props: { runAt?: string | null; projectId?: string | null } = {},
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TaskScheduleEditor taskId={TASK_ID} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The one datetime-local input, as its attributes. By NAME rather than by substring: React's
 *  static renderer spells props out in its own casing, which a browser parses case-insensitively,
 *  so pinning one casing would break on a change nothing can observe. */
function control(html: string): Record<string, string> | null {
  const el = /<input\s+([^>]*type="datetime-local"[^>]*)\/?>/i.exec(html);
  if (!el) return null;
  const out: Record<string, string> = {};
  for (const m of el[1].matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/** A button by its label, with the attributes that say whether it can be pressed. */
function button(html: string, label: string): { disabled: boolean; loading: boolean } | null {
  const re = new RegExp(`<button\\s+([^>]*)>((?:(?!</button>).)*)</button>`, 'gis');
  for (const m of html.matchAll(re)) {
    if (!m[2].includes(`>${label}<`)) continue;
    return { disabled: /\bdisabled(?:=|\s|$)/i.test(m[1]), loading: m[1].includes('ant-btn-loading') };
  }
  return null;
}

describe('the Start at editor — showing the schedule the server holds', () => {
  it('shows the stored instant on the VIEWER’s wall clock', () => {
    // One instant, two readers. Handing the `...Z` value straight to the control would blank it;
    // slicing it would show the reader in Shanghai the UTC hour and call it theirs.
    const at = '2026-09-01T01:00:00.000Z';
    expect(inTimeZone(SHANGHAI, () => control(renderEditor({ runAt: at }))!.value)).toBe(
      '2026-09-01T09:00',
    );
    expect(inTimeZone(NEW_YORK, () => control(renderEditor({ runAt: at }))!.value)).toBe(
      '2026-08-31T21:00',
    );
    expect(inTimeZone(SHANGHAI, () => renderEditor({ runAt: at }))).not.toContain(at);
  });

  it('collects seconds as well as minutes, so a stored :30 survives being looked at', () => {
    const out = inTimeZone(SHANGHAI, () => renderEditor({ runAt: '2026-09-01T01:00:30.000Z' }));
    expect(control(out)!.value).toBe('2026-09-01T09:00:30');
    // Without step=1 the control offers minutes only, and the seconds would be rounded away the
    // moment the reader touched the field.
    expect(control(out)!.step).toBe('1');
  });

  it('renders an empty control — never "Invalid Date" — with nothing valid to show', () => {
    for (const nothing of [undefined, null, '', 'not a date']) {
      const out = renderEditor({ runAt: nothing });
      expect(control(out)!.value).toBe('');
      expect(out).not.toContain('Invalid Date');
      expect(out).not.toContain('NaN');
    }
  });

  it('offers Cancel schedule for any stored start, including one it cannot read', () => {
    expect(button(renderEditor({ runAt: '2026-09-01T01:00:00.000Z' }), 'Cancel schedule')).not.toBeNull();
    // A stored value this control cannot parse is the case with no other way out: the box shows
    // nothing to edit, so without Cancel the reader is left with a start the server will still
    // act on and no control that touches it. `runAt: null` clears it whatever it says.
    const garbled = renderEditor({ runAt: 'not a date' });
    expect(button(garbled, 'Cancel schedule')).not.toBeNull();
    expect(control(garbled)!.value).toBe('');
    expect(garbled).not.toContain('Invalid Date');
    // ...and it says so, rather than showing an empty box that reads as "unscheduled".
    expect(garbled).toContain('A start is scheduled that this control cannot read.');
    expect(garbled).toContain('Cancel schedule clears it, or pick a time to replace it.');

    // On a task with no schedule at all it would be a button that does nothing.
    for (const nothing of [undefined, null, ''] as const) {
      expect(button(renderEditor({ runAt: nothing }), 'Cancel schedule')).toBeNull();
    }
  });

  it('says whose clock it reads, and — when scheduled — what Run now costs', () => {
    const scheduled = inTimeZone(SHANGHAI, () => renderEditor({ runAt: '2026-09-01T01:00:00.000Z' }));
    expect(scheduled).toContain('in your own time zone');
    // The start itself, spelled the way a reader reads one — the control shows 24-hour digits and
    // nothing about which of them is today.
    expect(scheduled).toContain('Starts once, on Sep 1, 9:00 AM, in your own time zone.');
    // The whole reason this sentence is in the panel and not only in a hover tooltip: a reader
    // choosing between Save schedule and Run now is looking right here.
    expect(scheduled).toContain('Run now starts immediately and clears this scheduled start.');
    // On an unscheduled task there is nothing to lose, and the sentence would be noise.
    const bare = renderEditor({});
    expect(bare).toContain('Optional, in your own time zone. The task starts once, at that time.');
    expect(bare).not.toContain('clears this scheduled start');
  });

  it('names the control and points its hint and its error at it', () => {
    const bare = renderEditor({});
    const labelFor = /<label[^>]*for="([^"]*)"[^>]*>Start at<\/label>/.exec(bare);
    expect(labelFor).not.toBeNull();
    // A real label, wired to this input — the difference between "Start at" and "edit text, blank".
    expect(control(bare)!.id).toBe(labelFor![1]);
    // The hint is announced with the field even when nothing is wrong: it carries the two things
    // the control cannot say for itself.
    const hintId = control(bare)!['aria-describedby'];
    expect(hintId).toBeTruthy();
    expect(bare).toMatch(new RegExp(`id="${hintId}"[^>]*>[^<]*in your own time zone`));
    expect(control(bare)!['aria-invalid']).toBeUndefined();
  });
});

describe('the Start at editor — what reaches the wire, and what does not', () => {
  /** The two writes, built the way the component builds them. */
  const writes = (projectId?: string | null) =>
    taskScheduleMutations(new QueryClient(), toast(), TASK_ID, projectId);

  it('sends the local reading as a UTC instant, zone by zone', () => {
    const apiMock = vi.mocked(api);
    for (const [tz, expected] of [
      [SHANGHAI, '2026-09-01T01:00:00.000Z'],
      [NEW_YORK, '2026-09-01T13:00:00.000Z'],
      ['UTC', '2026-09-01T09:00:00.000Z'],
    ] as const) {
      apiMock.mockClear();
      inTimeZone(tz, () => writes().save.mutationFn('2026-09-01T09:00'));
      expect(apiMock).toHaveBeenCalledTimes(1);
      const [path, init] = apiMock.mock.calls[0] as [string, { method?: string; body?: unknown }];
      // The public id straight into the path, as every other request in the panel does.
      expect(path).toBe(`/tasks/${TASK_ID}`);
      expect(init.method).toBe('PATCH');
      // A STRING schedules or reschedules. Named `runAt`, never `dueDate`: they are different
      // fields on the server and only one of them starts anything.
      expect(init.body).toEqual({ runAt: expected });
      expect(init.body).not.toHaveProperty('dueDate');
    }
  });

  it('keeps the seconds the reader can now see', () => {
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    inTimeZone(SHANGHAI, () => writes().save.mutationFn('2026-09-01T09:00:30'));
    expect((apiMock.mock.calls[0][1] as { body: { runAt: string } }).body.runAt).toBe(
      '2026-09-01T01:00:30.000Z',
    );
  });

  it('cancels with an explicit null, never by leaving the field out', () => {
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    writes().cancel.mutationFn();
    const [path, init] = apiMock.mock.calls[0] as [string, { method?: string; body?: unknown }];
    expect(path).toBe(`/tasks/${TASK_ID}`);
    expect(init.method).toBe('PATCH');
    // Absence means "leave the schedule alone" to the server — the one change this must not make.
    expect(init.body).toEqual({ runAt: null });
    expect('runAt' in (init.body as object)).toBe(true);
  });

  it('sends nothing at all for a time the reader’s own clock skips', () => {
    // The downgrade this forbids: quietly dropping the impossible value would PATCH nothing,
    // succeed, and leave the panel reporting a saved schedule it never changed.
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    inTimeZone(BERLIN, () => {
      expect(() => writes().save.mutationFn('2026-03-29T02:30')).toThrow(RUN_AT_IMPOSSIBLE);
    });
    expect(apiMock).not.toHaveBeenCalled();

    // A part-typed value is the same refusal — and the reason this control never auto-saves.
    for (const partial of ['', '2026', '2026-09-01', '2026-02-31T12:00']) {
      apiMock.mockClear();
      expect(() => writes().save.mutationFn(partial)).toThrow(RUN_AT_IMPOSSIBLE);
      expect(apiMock).not.toHaveBeenCalled();
    }
  });

  it('surfaces the refusal as a failed mutation rather than letting it escape', async () => {
    // The throw is synchronous inside the mutationFn; this is what proves react-query turns it
    // into the error state the toast path reads. A calendar-impossible value on purpose: it is
    // refused in every zone, so nothing here races the zone restore across the await.
    const apiMock = vi.mocked(api);
    apiMock.mockClear();
    const message = toast();
    const observer = new MutationObserver(new QueryClient(), {
      ...taskScheduleMutations(new QueryClient(), message, TASK_ID).save,
      retry: false,
    });
    await observer.mutate('2026-02-31T12:00').catch(() => {});
    expect(observer.getCurrentResult().isError).toBe(true);
    // The same sentence the field itself shows — one message, so the two cannot disagree.
    expect(observer.getCurrentResult().error?.message).toBe(RUN_AT_IMPOSSIBLE);
    expect(apiMock).not.toHaveBeenCalled();
    // ...and the reader is told, through the path every other failure in the panel uses.
    expect(message.error).toHaveBeenCalledWith(RUN_AT_IMPOSSIBLE);
  });

  it('refreshes the task, the task views and the task’s project once a save lands', async () => {
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockResolvedValueOnce({});
    const observer = new MutationObserver(qc, {
      ...taskScheduleMutations(qc, message, TASK_ID, PROJECT_ID).save,
      retry: false,
    });

    await observer.mutate('2026-09-01T09:00');

    expect(message.success).toHaveBeenCalledWith('Start time saved');
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', TASK_ID])).toBe(true);
    expect(invalidated(['tasks', 'page', null])).toBe(true);
    // The Project row that shows this task's start, and the subtask level under it.
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'children', 'parent62'])).toBe(true);
    // Another project's page is left where it was.
    expect(invalidated(['project', OTHER_PROJECT_ID, 'tasks', 'root'])).toBe(false);
  });

  it('refreshes the same views once a cancel lands', async () => {
    const qc = seededCache();
    const message = toast();
    vi.mocked(api).mockResolvedValueOnce({});
    const observer = new MutationObserver(qc, {
      ...taskScheduleMutations(qc, message, TASK_ID, PROJECT_ID).cancel,
      retry: false,
    });

    await observer.mutate();

    expect(message.success).toHaveBeenCalledWith('Scheduled start cancelled');
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', TASK_ID])).toBe(true);
    expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(true);
  });

  it.each([
    ['a save', (qc: QueryClient, m: WriteToast) => taskScheduleMutations(qc, m, TASK_ID, PROJECT_ID).save, '2026-09-02T09:00'],
    ['a cancel', (qc: QueryClient, m: WriteToast) => taskScheduleMutations(qc, m, TASK_ID, PROJECT_ID).cancel, undefined],
  ] as const)(
    'leaves every cache untouched when the server refuses %s, so nothing pretends',
    async (_name, options, variables) => {
      // No optimistic write anywhere: a failed cancel must not blank a schedule the server still
      // holds and the next sweep will still act on, and a failed save must not show the new time
      // as though it had landed.
      const qc = seededCache();
      const message = toast();
      vi.mocked(api).mockClear();
      vi.mocked(api).mockRejectedValueOnce(new Error('task is already running'));

      const observer = new MutationObserver(qc, { ...options(qc, message), retry: false });
      await observer.mutate(variables as never).catch(() => {});

      expect(observer.getCurrentResult().isError).toBe(true);
      // Still scheduled, still exactly the instant it was, and not marked stale — there is nothing
      // new to fetch, and the same button is the retry.
      expect(qc.getQueryData(['task', TASK_ID])).toEqual({
        id: TASK_ID,
        runAt: '2026-09-01T01:00:00.000Z',
      });
      const invalidated = invalidatedIn(qc);
      expect(invalidated(['task', TASK_ID])).toBe(false);
      expect(invalidated(['tasks', 'page', null])).toBe(false);
      expect(invalidated(['project', PROJECT_ID, 'tasks', 'root'])).toBe(false);
      // And the failure reaches the reader whole, through the existing toast path.
      expect(message.error).toHaveBeenCalledWith('task is already running');
      expect(message.success).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a save', (qc: QueryClient, message: WriteToast) => taskScheduleMutations(qc, message, TASK_ID).save, '2026-09-01T09:00'],
    ['a cancel', (qc: QueryClient, message: WriteToast) => taskScheduleMutations(qc, message, TASK_ID).cancel, undefined],
  ] as const)('stays pending after %s until the views it refreshed have actually refetched', async (_name, options, variables) => {
    // Otherwise the button leaves its loading state the instant the server answers and before a
    // single query has refetched — enabled again, still showing the schedule the write replaced,
    // which is an invitation to send the same request twice.
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

    const observer = new MutationObserver(qc, { ...options(qc, toast()), retry: false });
    const landed = observer.mutate(variables as never);

    // The PATCH itself is long done; the panel has not caught up.
    await tick();
    await tick();
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().isPending).toBe(true);

    release();
    await landed;
    expect(observer.getCurrentResult().isPending).toBe(false);
    unsubscribe();
  });
});

/**
 * The one thing here that no render and no mutation can reach: it is a re-render with CHANGED
 * props, and a static render produces a fresh tree every time. There is no reconciler in this test
 * environment to drive one, so this reads the statement instead.
 */
describe('the Start at editor — when Save may be pressed', () => {
  it('is disabled on a draft that only mirrors the schedule already stored', () => {
    // The initial draft IS the server's value, so a freshly opened panel has nothing to save.
    const out = inTimeZone(SHANGHAI, () => renderEditor({ runAt: '2026-09-01T01:00:00.000Z' }));
    expect(button(out, 'Save schedule')!.disabled).toBe(true);
    // Cancel is the action that IS available on a scheduled task, and it is not disabled.
    expect(button(out, 'Cancel schedule')!.disabled).toBe(false);
  });

  it('is disabled on an unscheduled task until a time is actually chosen', () => {
    // An empty draft is not a schedule, and saving it as one would be a request with nothing in it.
    expect(button(renderEditor({}), 'Save schedule')!.disabled).toBe(true);
  });
});

/**
 * The states the reader gets to by typing, which a static render cannot reach through the stateful
 * wrapper — its draft starts life as the server's own value. The presenter takes that draft as a
 * prop, so each of them is one render.
 */
describe('the Start at editor — a draft the reader has changed', () => {
  function renderFields(over: Partial<Parameters<typeof TaskScheduleFields>[0]> = {}): string {
    return renderToStaticMarkup(
      <TaskScheduleFields
        draft=""
        current=""
        scheduled={false}
        savePending={false}
        cancelPending={false}
        onDraft={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
        {...over}
      />,
    );
  }

  it('names the problem on the field itself when the picked time cannot happen', () => {
    // 02:30 on Berlin's spring-forward day: a value the control will genuinely offer, because a
    // datetime-local knows nothing about the reader's daylight-saving rules.
    const out = inTimeZone(BERLIN, () =>
      renderFields({ draft: '2026-03-29T02:30', current: '2026-03-28T02:30' }),
    );

    // Said inline, in full, where the reader is looking — not deferred to a failed save later.
    expect(out).toContain(RUN_AT_IMPOSSIBLE);
    // Marked wrong on the control, for eyes and for anything reading the accessibility tree.
    expect(control(out)!['aria-invalid']).toBe('true');
    expect(out).toContain('ant-input-status-error');
    // The reason is announced WITH the field, alongside the hint rather than instead of it, and
    // as a live region so it is heard when it appears rather than on the next visit to the input.
    const described = control(out)!['aria-describedby'].split(' ');
    expect(described).toHaveLength(2);
    expect(out).toMatch(new RegExp(`id="${described[1]}" role="alert"[^>]*>${RUN_AT_IMPOSSIBLE}`));
    expect(out).toMatch(new RegExp(`id="${described[0]}"[^>]*>[^<]*in your own time zone`));
    // What they typed is still there to correct — clearing it for them would lose the choice.
    expect(control(out)!.value).toBe('2026-03-29T02:30');
    // And it cannot be sent. The whole point of refusing rather than normalizing is that 02:30
    // would otherwise become 03:30, indistinguishable from a deliberate 03:30 afterwards.
    expect(button(out, 'Save schedule')!.disabled).toBe(true);
  });

  it('refuses a calendar date that does not exist, in every zone', () => {
    const out = renderFields({ draft: '2026-02-31T12:00' });
    expect(out).toContain(RUN_AT_IMPOSSIBLE);
    expect(button(out, 'Save schedule')!.disabled).toBe(true);
  });

  it('lets a real edit be saved, and says nothing is wrong with it', () => {
    const out = renderFields({ draft: '2026-09-02T09:00', current: '2026-09-01T09:00' });
    expect(button(out, 'Save schedule')!.disabled).toBe(false);
    expect(out).not.toContain(RUN_AT_IMPOSSIBLE);
    expect(control(out)!['aria-invalid']).toBeUndefined();
    // One id in aria-describedby with nothing wrong: the hint, on its own.
    expect(control(out)!['aria-describedby'].split(' ')).toHaveLength(1);
  });

  it('will not save an emptied box as a schedule, and points at Cancel instead', () => {
    // Emptying the control is how a reader gets to a blank field, not how they cancel — the
    // difference between "I am retyping this" and "delete the appointment".
    const out = renderFields({
      draft: '',
      current: '2026-09-01T09:00',
      scheduled: true,
      scheduledLocal: 'Sep 1, 9:00 AM',
    });
    expect(button(out, 'Save schedule')!.disabled).toBe(true);
    // Nothing is WRONG with an empty box, so it is not marked as an error either.
    expect(out).not.toContain(RUN_AT_IMPOSSIBLE);
    expect(control(out)!['aria-invalid']).toBeUndefined();
    // The explicit action is right there.
    expect(button(out, 'Cancel schedule')!.disabled).toBe(false);
  });

  it('shows each write in flight on its own control, and freezes the field under both', () => {
    // Truthful about WHICH request is out: a spinner on both would say a cancel is running when
    // it is a save, and vice versa.
    const saving = renderFields({
      draft: '2026-09-02T09:00',
      current: '2026-09-01T09:00',
      scheduled: true,
      scheduledLocal: 'Sep 1, 9:00 AM',
      savePending: true,
    });
    expect(button(saving, 'Save schedule')!.loading).toBe(true);
    expect(button(saving, 'Cancel schedule')!.loading).toBe(false);

    const cancelling = renderFields({
      draft: '2026-09-01T09:00',
      current: '2026-09-01T09:00',
      scheduled: true,
      scheduledLocal: 'Sep 1, 9:00 AM',
      cancelPending: true,
    });
    expect(button(cancelling, 'Cancel schedule')!.loading).toBe(true);
    expect(button(cancelling, 'Save schedule')!.loading).toBe(false);

    // Under either, nothing else can be started and the value cannot drift away from the request
    // that is already gone.
    for (const out of [saving, cancelling]) {
      expect(control(out)!.disabled).toBeDefined();
      expect(button(out, 'Save schedule')!.disabled).toBe(true);
      expect(button(out, 'Cancel schedule')!.disabled).toBe(true);
    }
  });

  it('is the same markup the panel’s own editor renders for the schedule it was given', () => {
    // The wrapper's whole job is deriving these props from an instant; this is what pins that it
    // does, rather than the two drifting into different fields on the same screen.
    const at = '2026-09-01T01:00:00.000Z';
    const strip = (html: string) => html.replace(/(id|for|aria-describedby)="[^"]*"/g, '');
    expect(inTimeZone(SHANGHAI, () => strip(renderEditor({ runAt: at })))).toBe(
      inTimeZone(SHANGHAI, () =>
        strip(
          renderFields({
            draft: '2026-09-01T09:00',
            current: '2026-09-01T09:00',
            scheduled: true,
            scheduledLocal: 'Sep 1, 9:00 AM',
          }),
        ),
      ),
    );
  });
});

describe('the Start at editor — the draft across a re-render', () => {
  it('re-syncs only when the server’s own schedule changes', () => {
    // The panel polls itself every few seconds while a run is live. Re-deriving the draft on each
    // of those would wipe out whatever is half-typed; comparing against the value the draft was
    // last taken from is what tells a real change from a repeat of the same answer.
    expect(source).toMatch(
      /if \(syncedFrom !== current\) \{\s*setSyncedFrom\(current\);\s*setDraft\(current\);\s*\}/,
    );
    // And Save sends the draft that is on screen, not the schedule it started from: `current` is
    // the server's value and the thing an edit is compared against.
    expect(source).toContain('onSave={() => save.mutate(draft)}');
    expect(source).not.toContain('save.mutate(current)');
  });
});
