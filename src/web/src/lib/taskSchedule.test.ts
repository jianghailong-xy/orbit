import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  RUN_AT_IMPOSSIBLE,
  canSaveTaskSchedule,
  runAtIso,
  runAtLocalValue,
  runAtProblem,
  refreshManyTaskScheduleViews,
  refreshTaskScheduleViews,
  scheduledStart,
} from './taskSchedule';

/**
 * A scheduled start is the one thing here whose correct answer depends on WHERE the reader is, so
 * every conversion below runs in a pinned zone rather than the machine's own — otherwise the suite
 * would pass in UTC (where local and UTC agree, and the bug this guards is invisible) and fail
 * everywhere else. Node re-reads `process.env.TZ` on the next Date/Intl call, so setting it around
 * one call is enough; restoring it is what keeps the rest of the file in the host's zone.
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

const SHANGHAI = 'Asia/Shanghai'; // UTC+8 year-round
const NEW_YORK = 'America/New_York'; // UTC-4 in September
// Berlin springs forward 02:00 -> 03:00 on 2026-03-29 (so 02:30 never happens that day) and falls
// back on 2026-10-25 (so 02:30 happens twice). Both are fixed points of a fixed tzdata rule, not
// "today", so nothing here drifts.
const BERLIN = 'Europe/Berlin';

describe('runAtLocalValue — a stored instant as the control’s own value', () => {
  it('reads the instant on the VIEWER’s wall clock, not UTC’s', () => {
    // One instant, three readings. Slicing `toISOString()` would hand all three readers the UTC
    // one — an eight-hour lie in Shanghai that looks entirely plausible on screen.
    const at = '2026-09-01T01:00:00.000Z';
    expect(inTimeZone(SHANGHAI, () => runAtLocalValue(at))).toBe('2026-09-01T09:00');
    expect(inTimeZone(NEW_YORK, () => runAtLocalValue(at))).toBe('2026-08-31T21:00');
    expect(inTimeZone('UTC', () => runAtLocalValue(at))).toBe('2026-09-01T01:00');
    // New York is on the previous DAY at that instant, which is exactly the case a naive
    // conversion gets wrong while still producing a plausible-looking string.
    expect(inTimeZone(NEW_YORK, () => runAtLocalValue(at))).not.toContain('2026-09-01');
  });

  it('round-trips through runAtIso unchanged, in every pinned zone', () => {
    // The two halves of the same conversion: what the editor shows must be what a Save of the
    // untouched value would send back. A drift here silently moves a schedule on every edit.
    for (const tz of [SHANGHAI, NEW_YORK, BERLIN, 'UTC']) {
      for (const at of [
        '2026-09-01T01:00:00.000Z',
        '2026-01-15T23:45:00.000Z',
        '2026-03-29T00:30:00.000Z', // the hour before Berlin springs forward
        '2026-10-25T00:30:00.000Z', // the first of Berlin's two 02:30s
      ]) {
        expect(inTimeZone(tz, () => runAtIso(runAtLocalValue(at)))).toBe(at);
      }
    }
  });

  it('keeps seconds when the instant has them, and leaves them off when it does not', () => {
    // `step=1` on the control is what makes the first of these representable at all; without it
    // the box offers minutes only and a :30 schedule comes back rounded the moment it is touched.
    expect(inTimeZone(SHANGHAI, () => runAtLocalValue('2026-09-01T01:00:30.000Z'))).toBe(
      '2026-09-01T09:00:30',
    );
    expect(inTimeZone(SHANGHAI, () => runAtIso('2026-09-01T09:00:30'))).toBe(
      '2026-09-01T01:00:30.000Z',
    );
    // Not `:00` — the minute-precise spelling is the truthful one for a minute-precise instant,
    // and it is the one the round trip above already proved exact.
    expect(inTimeZone(SHANGHAI, () => runAtLocalValue('2026-09-01T01:00:00.000Z'))).toBe(
      '2026-09-01T09:00',
    );
  });

  it('pads every component, so a single-digit month or hour is still a legal value', () => {
    // `2026-1-5T9:00` is not a value a datetime-local accepts, and `runAtIso`'s own regex refuses
    // it too — an unpadded render would blank the control and look like an unscheduled task.
    expect(inTimeZone('UTC', () => runAtLocalValue('2026-01-05T09:07:00.000Z'))).toBe(
      '2026-01-05T09:07',
    );
    expect(inTimeZone('UTC', () => runAtIso(runAtLocalValue('2026-01-05T09:07:00.000Z')))).toBe(
      '2026-01-05T09:07:00.000Z',
    );
  });

  it('renders an empty control — never "Invalid Date" — for anything it cannot read', () => {
    // Absent is the normal case: most tasks have no schedule at all.
    expect(runAtLocalValue(null)).toBe('');
    expect(runAtLocalValue(undefined)).toBe('');
    expect(runAtLocalValue('')).toBe('');
    // And a value that is there but garbled must not become a schedule the reader appears to have
    // picked. `new Date('not a date')` is what puts the words "Invalid Date" on screen.
    for (const bad of ['not a date', '2026-13-45T99:99:99Z', 'null']) {
      expect(runAtLocalValue(bad)).toBe('');
    }
  });

  it('accepts any spelling of the instant the server might send', () => {
    // The wire value is normally `...Z`, but an offset-bearing instant is the same moment and has
    // to read as the same local time rather than fall through to an empty box.
    expect(inTimeZone(SHANGHAI, () => runAtLocalValue('2026-09-01T09:00:00+08:00'))).toBe(
      '2026-09-01T09:00',
    );
    expect(inTimeZone(NEW_YORK, () => runAtLocalValue('2026-09-01T09:00:00+08:00'))).toBe(
      '2026-08-31T21:00',
    );
  });
});

describe('canSaveTaskSchedule — when Save may fire at all', () => {
  it('refuses an empty draft, so clearing the box never deletes a schedule', () => {
    // Emptying the control is how a reader gets to a blank field, not how they cancel: PATCHing
    // `runAt: null` off the back of it would delete a schedule from a keystroke that could equally
    // be the start of retyping one. Cancelling is its own visible action.
    expect(canSaveTaskSchedule('', '2026-09-01T09:00')).toBe(false);
    expect(canSaveTaskSchedule('', '')).toBe(false);
  });

  it('refuses a draft the reader is still part-way through typing', () => {
    // A datetime-local emits a value on nearly every keystroke and half of them are partial —
    // which is the whole reason this control does not auto-save.
    for (const partial of ['2026', '2026-09', '2026-09-01', '2026-09-01T', '2026-09-01T09']) {
      expect(canSaveTaskSchedule(partial, '')).toBe(false);
    }
  });

  it('refuses a time the reader’s own clock skips', () => {
    // 02:30 on Berlin's spring-forward day: a value a real browser will genuinely offer, because a
    // datetime-local knows nothing about daylight-saving rules. Normalized it would become 03:30 —
    // indistinguishable afterwards from a deliberate 03:30.
    expect(inTimeZone(BERLIN, () => canSaveTaskSchedule('2026-03-29T02:30', ''))).toBe(false);
    expect(inTimeZone(BERLIN, () => runAtProblem('2026-03-29T02:30'))).toBe(RUN_AT_IMPOSSIBLE);
    // The hours either side of the gap are ordinary times and stay saveable.
    expect(inTimeZone(BERLIN, () => canSaveTaskSchedule('2026-03-29T01:30', ''))).toBe(true);
    expect(inTimeZone(BERLIN, () => canSaveTaskSchedule('2026-03-29T03:30', ''))).toBe(true);
    // The same wall time in a zone with no DST at all is untouched by any of this.
    expect(inTimeZone(SHANGHAI, () => canSaveTaskSchedule('2026-03-29T02:30', ''))).toBe(true);
  });

  it('refuses a calendar date that does not exist', () => {
    // Refused in EVERY zone, so this needs no pinning: `new Date(2026, 1, 31)` is March 3rd.
    for (const impossible of ['2026-02-31T12:00', '2026-02-29T12:00', '2026-04-31T09:00']) {
      expect(canSaveTaskSchedule(impossible, '')).toBe(false);
    }
    // A real leap day is not one of them.
    expect(canSaveTaskSchedule('2028-02-29T12:00', '')).toBe(true);
  });

  it('refuses a draft that matches the schedule already stored', () => {
    // Nothing to send — and, on a fall-back day, actively harmful to send: 02:30 happens twice and
    // the control can spell only one of them, so re-saving an untouched value could move the
    // schedule an hour earlier. Never sending it is what makes "I didn't touch it" true.
    expect(canSaveTaskSchedule('2026-10-25T02:30', '2026-10-25T02:30')).toBe(false);
    // A real edit of the same field is a different answer.
    expect(canSaveTaskSchedule('2026-10-25T03:30', '2026-10-25T02:30')).toBe(true);
    // As is the first schedule on a task that had none.
    expect(canSaveTaskSchedule('2026-09-01T09:00', '')).toBe(true);
  });
});

describe('refreshTaskScheduleViews — what a change to when a task runs refreshes', () => {
  /** A cache holding every view that can show this task's start, plus three that must be left
   *  alone. Seeded with `setQueryData` so each entry really exists to be invalidated. */
  function seeded() {
    const qc = new QueryClient();
    qc.setQueryData(['task', 'task62'], { id: 'task62' });
    qc.setQueryData(['tasks', 'page', null], { items: [] });
    qc.setQueryData(['tasks', 'counts', null, []], { open: 1 });
    qc.setQueryData(['project', 'proj62'], { id: 'proj62' });
    qc.setQueryData(['project', 'proj62', 'tasks', 'root'], { items: [] });
    qc.setQueryData(['project', 'proj62', 'tasks', 'children', 'parent62'], { items: [] });
    // Another project's page, open in another tab.
    qc.setQueryData(['project', 'other62'], { id: 'other62' });
    qc.setQueryData(['project', 'other62', 'tasks', 'root'], { items: [] });
    // And a view that has nothing to do with when anything runs.
    qc.setQueryData(['projects'], []);
    return qc;
  }

  const invalidatedIn = (qc: QueryClient) => (key: unknown[]) =>
    qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;

  it('covers the open panel, every task view, and every cached page of the task’s project', () => {
    const qc = seeded();
    refreshTaskScheduleViews(qc, 'task62', 'proj62');
    const invalidated = invalidatedIn(qc);
    expect(invalidated(['task', 'task62'])).toBe(true);
    expect(invalidated(['tasks', 'page', null])).toBe(true);
    expect(invalidated(['tasks', 'counts', null, []])).toBe(true);
    // The project document and BOTH levels of its tree — the root page and an opened subtask
    // page — which is what stops a Project row showing a start that is gone. One prefix reaches
    // all three, so a level nobody thought of is covered too.
    expect(invalidated(['project', 'proj62'])).toBe(true);
    expect(invalidated(['project', 'proj62', 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', 'proj62', 'tasks', 'children', 'parent62'])).toBe(true);
  });

  it('reaches no further than it has to', () => {
    const qc = seeded();
    refreshTaskScheduleViews(qc, 'task62', 'proj62');
    const invalidated = invalidatedIn(qc);
    // Another project never contained this task.
    expect(invalidated(['project', 'other62'])).toBe(false);
    expect(invalidated(['project', 'other62', 'tasks', 'root'])).toBe(false);
    // The projects list carries a task COUNT, which rescheduling moves not at all.
    expect(invalidated(['projects'])).toBe(false);
  });

  it('resolves only once the active views have refetched', async () => {
    // Awaited by each caller's `onSuccess`, which is what keeps a mutation pending until the UI
    // has caught up. Firing and forgetting these would resolve the write immediately, leaving the
    // controls enabled over the schedule it had just replaced.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release!: () => void;
    const refetching = new Promise<void>((resolve) => {
      release = resolve;
    });
    qc.setQueryData(['task', 'task62'], { id: 'task62' });
    // An ACTIVE observer: an invalidation only refetches a query something is watching, and the
    // open panel is exactly that.
    const watcher = new QueryObserver(qc, {
      queryKey: ['task', 'task62'],
      queryFn: async () => {
        await refetching;
        return { id: 'task62' };
      },
      refetchOnMount: false,
    });
    const unsubscribe = watcher.subscribe(() => {});

    let settled = false;
    const refreshed = refreshTaskScheduleViews(qc, 'task62').then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await refreshed;
    expect(settled).toBe(true);
    unsubscribe();
  });

  it('refreshes no project at all for a task that belongs to none', () => {
    // Most tasks are not filed under a project. Refetching an unrelated project page here would
    // be work done on behalf of a task it has never contained.
    for (const none of [null, undefined, ''] as const) {
      const qc = seeded();
      refreshTaskScheduleViews(qc, 'task62', none);
      const invalidated = invalidatedIn(qc);
      expect(invalidated(['task', 'task62'])).toBe(true);
      expect(invalidated(['tasks', 'page', null])).toBe(true);
      expect(invalidated(['project', 'proj62'])).toBe(false);
      expect(invalidated(['project', 'proj62', 'tasks', 'root'])).toBe(false);
    }
  });
});

describe('refreshManyTaskScheduleViews — the same rule for a whole batch at once', () => {
  /** A cache holding both projects a batch touches, one it does not, and the projects index. */
  function seeded() {
    const qc = new QueryClient();
    for (const id of ['t1', 't2', 't3']) qc.setQueryData(['task', id], { id });
    qc.setQueryData(['tasks', 'page', null], { items: [] });
    qc.setQueryData(['tasks', 'counts', null, []], { open: 3 });
    qc.setQueryData(['tasks', 'active', null], { items: [] });
    qc.setQueryData(['project', 'projA'], { id: 'projA' });
    qc.setQueryData(['project', 'projA', 'tasks', 'root'], { items: [] });
    qc.setQueryData(['project', 'projA', 'tasks', 'children', 'parent62'], { items: [] });
    qc.setQueryData(['project', 'projB'], { id: 'projB' });
    qc.setQueryData(['project', 'projB', 'tasks', 'root'], { items: [] });
    // A project no row in the batch belongs to, and the index that counts tasks per project.
    qc.setQueryData(['project', 'projC'], { id: 'projC' });
    qc.setQueryData(['project', 'projC', 'tasks', 'root'], { items: [] });
    qc.setQueryData(['projects'], []);
    return qc;
  }

  const invalidatedIn = (qc: QueryClient) => (key: unknown[]) =>
    qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;

  /** Two rows in one project, one in another, and one filed under no project at all. */
  const batch = [
    { id: 't1', projectId: 'projA' },
    { id: 't2', projectId: 'projA' },
    { id: 't3', projectId: 'projB' },
    { id: 't4', projectId: null },
  ];

  it('covers every task in the batch and every project any of them came from', () => {
    const qc = seeded();
    refreshManyTaskScheduleViews(qc, batch);
    const invalidated = invalidatedIn(qc);
    for (const id of ['t1', 't2', 't3']) expect(invalidated(['task', id])).toBe(true);
    expect(invalidated(['tasks', 'page', null])).toBe(true);
    expect(invalidated(['tasks', 'counts', null, []])).toBe(true);
    expect(invalidated(['tasks', 'active', null])).toBe(true);
    // Both projects, each through the prefix that reaches the document, the root page and every
    // opened subtask level below it.
    expect(invalidated(['project', 'projA'])).toBe(true);
    expect(invalidated(['project', 'projA', 'tasks', 'root'])).toBe(true);
    expect(invalidated(['project', 'projA', 'tasks', 'children', 'parent62'])).toBe(true);
    expect(invalidated(['project', 'projB'])).toBe(true);
    expect(invalidated(['project', 'projB', 'tasks', 'root'])).toBe(true);
  });

  it('reaches no further than the batch itself', () => {
    const qc = seeded();
    refreshManyTaskScheduleViews(qc, batch);
    const invalidated = invalidatedIn(qc);
    // A project none of these rows belong to — open in another tab, and none of its business.
    expect(invalidated(['project', 'projC'])).toBe(false);
    expect(invalidated(['project', 'projC', 'tasks', 'root'])).toBe(false);
    // The projects index carries a task COUNT per project, which running tasks does not move.
    expect(invalidated(['projects'])).toBe(false);
    // The unprojected row contributed no project key of its own — an `undefined` there would be
    // a prefix of EVERY project in the cache, so exactly the five views of the two projects the
    // batch really came from are stale, and projC's two are not.
    const staleProjectViews = qc
      .getQueryCache()
      .findAll({ queryKey: ['project'] })
      .filter((q) => q.state.isInvalidated);
    expect(staleProjectViews.length).toBe(5);
  });

  it('invalidates each key once, not once per row', () => {
    // Forty selected rows sharing two projects must not fire forty `['tasks']` invalidations:
    // each one is a refetch of views already being refetched by the one before it.
    const qc = seeded();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    refreshManyTaskScheduleViews(qc, [...batch, { id: 't1', projectId: 'projA' }]);
    const keys = spy.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys.filter((k) => k === JSON.stringify(['tasks'])).length).toBe(1);
    expect(keys.filter((k) => k === JSON.stringify(['project', 'projA'])).length).toBe(1);
    expect(keys.filter((k) => k === JSON.stringify(['task', 't1'])).length).toBe(1);
    // Four distinct tasks — the unprojected row's own detail included — one `['tasks']`, and two
    // distinct projects, from five rows naming three keys between them more than once.
    expect(keys.length).toBe(7);
    spy.mockRestore();
  });

  it('scales as forty rows across two projects: 43 invalidations, not 120', () => {
    // The exact shape the doc comment claims, pinned so neither can drift from the other. Every
    // task keeps its OWN detail invalidation — each of those rows really did change — and it is
    // only the two keys they SHARE that collapse.
    const qc = seeded();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const forty = Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      projectId: i % 2 ? 'projA' : 'projB',
    }));
    refreshManyTaskScheduleViews(qc, forty);

    const keys = spy.mock.calls.map(([arg]) => arg?.queryKey as unknown[]);
    expect(keys.length).toBe(43);
    // All forty details, none of them dropped or merged.
    const details = keys.filter((k) => k[0] === 'task');
    expect(details.length).toBe(40);
    expect(new Set(details.map((k) => k[1])).size).toBe(40);
    // And the shared keys exactly once each.
    expect(keys.filter((k) => k.length === 1 && k[0] === 'tasks').length).toBe(1);
    expect(keys.filter((k) => k[0] === 'project').length).toBe(2);
    spy.mockRestore();
  });

  it('refreshes nothing at all for an empty batch', async () => {
    // The caller with no tasks to report is one whose write moved nothing; refetching every task
    // view on its behalf would redraw exactly what is already on screen.
    const qc = seeded();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await refreshManyTaskScheduleViews(qc, []);
    expect(spy).not.toHaveBeenCalled();
    expect(invalidatedIn(qc)(['tasks', 'page', null])).toBe(false);
    spy.mockRestore();
  });

  it('resolves only once the active views have refetched', async () => {
    // Returned from each caller's `onSuccess`, which is what keeps the bulk Run pending until the
    // list it just changed has actually caught up.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let release!: () => void;
    const refetching = new Promise<void>((resolve) => {
      release = resolve;
    });
    qc.setQueryData(['tasks', 'page', null], { items: [] });
    const watcher = new QueryObserver(qc, {
      queryKey: ['tasks', 'page', null],
      queryFn: async () => {
        await refetching;
        return { items: [] };
      },
      refetchOnMount: false,
    });
    const unsubscribe = watcher.subscribe(() => {});

    let settled = false;
    const refreshed = refreshManyTaskScheduleViews(qc, batch).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await refreshed;
    expect(settled).toBe(true);
    unsubscribe();
  });

  it('is what the single-task refresh is built out of, unchanged', () => {
    // The panel's Run now and the schedule editor call the singular form; it must keep meaning
    // exactly what it meant when it held the rule itself.
    const one = seeded();
    const many = seeded();
    refreshTaskScheduleViews(one, 't1', 'projA');
    refreshManyTaskScheduleViews(many, [{ id: 't1', projectId: 'projA' }]);
    const keys = (qc: QueryClient) =>
      qc
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.isInvalidated)
        .map((q) => JSON.stringify(q.queryKey))
        .sort();
    expect(keys(one)).toEqual(keys(many));
    // And it really is the panel's set: this task, every task view, this project only.
    expect(keys(one)).toEqual(
      [
        ['task', 't1'],
        ['tasks', 'page', null],
        ['tasks', 'counts', null, []],
        ['tasks', 'active', null],
        ['project', 'projA'],
        ['project', 'projA', 'tasks', 'root'],
        ['project', 'projA', 'tasks', 'children', 'parent62'],
      ]
        .map((k) => JSON.stringify(k))
        .sort(),
    );
  });
});

describe('scheduledStart — still the row’s reading, now from one place', () => {
  it('is the same instant in two spellings, and null for anything unreadable', () => {
    // Moved here from ProjectsPage so the panel and the row cannot disagree; the project page's
    // own tests still assert its rendering. This is the contract both of them read.
    const out = inTimeZone(SHANGHAI, () => scheduledStart('2026-09-01T01:00:00.000Z'))!;
    expect(out.iso).toBe('2026-09-01T01:00:00.000Z');
    expect(out.local).toBe(
      inTimeZone(SHANGHAI, () =>
        new Date('2026-09-01T01:00:00.000Z').toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        }),
      ),
    );
    for (const nothing of [null, undefined, '', 'not a date']) {
      expect(scheduledStart(nothing)).toBeNull();
    }
  });
});
