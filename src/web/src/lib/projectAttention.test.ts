import { describe, expect, it } from 'vitest';
import {
  attentionSectionOf,
  orderWithinSection,
  projectAttentionSections,
  type AttentionProject,
  type AttentionSectionKey,
} from './projectAttention';

/** A project as the endpoint returns one, named by what makes it interesting. Buckets default to
 *  five zeroes so each case states only the numbers it is about. */
function project(
  over: Partial<AttentionProject> & { buckets?: Partial<AttentionProject['buckets']> } = {},
): AttentionProject {
  return {
    status: 'OPEN',
    lastActivityAt: '2026-01-01T00:00:00.000Z',
    ...over,
    buckets: { running: 0, ready: 0, blocked: 0, done: 0, cancelled: 0, ...(over.buckets ?? {}) },
  };
}

describe('attentionSectionOf', () => {
  it('sends ready work with nothing running to Stalled', () => {
    expect(attentionSectionOf(project({ buckets: { ready: 9, blocked: 1, done: 1 } }))).toBe(
      'stalled',
    );
    // One ready task is enough: the condition is "nothing is serving the queue", not "a lot is
    // waiting".
    expect(attentionSectionOf(project({ buckets: { ready: 1 } }))).toBe('stalled');
  });

  it('sends an OPEN project whose tasks are all settled to Wrapping up', () => {
    expect(attentionSectionOf(project({ buckets: { done: 12 } }))).toBe('wrapping-up');
    expect(attentionSectionOf(project({ buckets: { done: 5, cancelled: 7 } }))).toBe('wrapping-up');
    // Cancelled alone still counts as settled — the work stopped on a decision, and there is
    // nothing left to run either way.
    expect(attentionSectionOf(project({ buckets: { cancelled: 3 } }))).toBe('wrapping-up');
  });

  it('sends anything with a task running to In progress', () => {
    expect(attentionSectionOf(project({ buckets: { running: 1, blocked: 117 } }))).toBe('running');
    // Running WINS over ready: the project holds ready tasks and is also being served, so it is
    // not the case Stalled exists to surface.
    expect(attentionSectionOf(project({ buckets: { running: 1, ready: 3, blocked: 10 } }))).toBe(
      'running',
    );
  });

  it('sends DONE and CANCELLED projects to Completed whatever their buckets say', () => {
    expect(attentionSectionOf(project({ status: 'DONE', buckets: { done: 16 } }))).toBe('completed');
    expect(attentionSectionOf(project({ status: 'CANCELLED', buckets: { done: 7 } }))).toBe(
      'completed',
    );
    // A closed project with work still open or in flight is still closed: `status` is the
    // decision, and the buckets do not overrule it.
    expect(attentionSectionOf(project({ status: 'DONE', buckets: { running: 2, ready: 4 } }))).toBe(
      'completed',
    );
  });

  it('sends an OPEN project with no tasks at all to In progress, never to Wrapping up', () => {
    const untouched = project({ buckets: {}, lastActivityAt: null });

    // Wrapping up says "every task settled"; this project has settled nothing. In progress is
    // where a project that has just been created belongs, and its null activity puts it at the
    // tail of that section on its own — see the ordering suite below.
    expect(attentionSectionOf(untouched)).toBe('running');
    expect(attentionSectionOf(untouched)).not.toBe('wrapping-up');
  });

  it('sends a project blocked on another project to Stalled, not off the list', () => {
    // Nothing running, nothing ready, and open work that cannot start: reachable whenever every
    // open task waits on a prerequisite filed in ANOTHER project. None of the four plain rules
    // claims it, so this is the case that would silently vanish.
    const externallyBlocked = project({ buckets: { blocked: 4 } });

    expect(attentionSectionOf(externallyBlocked)).toBe('stalled');
    expect(attentionSectionOf(externallyBlocked)).not.toBe('wrapping-up');
  });

  it('lands every combination of buckets and statuses in exactly one section', () => {
    const counts = [0, 1, 2];
    const seen = new Set<AttentionSectionKey>();
    for (const status of ['OPEN', 'DONE', 'CANCELLED'] as const)
      for (const running of counts)
        for (const ready of counts)
          for (const blocked of counts)
            for (const done of counts)
              for (const cancelled of counts) {
                const key = attentionSectionOf(
                  project({ status, buckets: { running, ready, blocked, done, cancelled } }),
                );
                // The type says four; what matters is that it is always one of the four and never
                // undefined — a project that classified nowhere would be a project off the page.
                expect(['stalled', 'wrapping-up', 'running', 'completed']).toContain(key);
                seen.add(key);
              }
    expect([...seen].sort()).toEqual(['completed', 'running', 'stalled', 'wrapping-up']);
  });
});

describe('orderWithinSection', () => {
  const stalled = (ready: number, lastActivityAt: string | null): AttentionProject =>
    project({ buckets: { ready }, lastActivityAt });

  it('orders Stalled by ready count, descending', () => {
    const ordered = orderWithinSection('stalled', [
      stalled(4, '2026-01-05T00:00:00.000Z'),
      stalled(6118, '2026-01-01T00:00:00.000Z'),
      stalled(9, '2026-01-04T00:00:00.000Z'),
    ]);

    // The biggest ask first — and NOT the most recently touched, which would put the 4 on top.
    expect(ordered.map((p) => p.buckets.ready)).toEqual([6118, 9, 4]);
  });

  it('breaks a tie in Stalled on activity, so equal ready counts still have a readable order', () => {
    const older = stalled(3, '2026-01-01T00:00:00.000Z');
    const newer = stalled(3, '2026-02-01T00:00:00.000Z');

    // Both orderings of the same input give the same answer: the tie is decided by a value on the
    // row, not by the order the server happened to send.
    expect(orderWithinSection('stalled', [older, newer])).toEqual([newer, older]);
    expect(orderWithinSection('stalled', [newer, older])).toEqual([newer, older]);
  });

  it('orders In progress by last activity, descending', () => {
    const days = (d: string) => project({ buckets: { running: 1 }, lastActivityAt: d });
    const recent = days('2026-03-01T12:00:00.000Z');
    const middle = days('2026-02-01T12:00:00.000Z');
    const stale = days('2026-01-01T12:00:00.000Z');

    expect(orderWithinSection('running', [middle, stale, recent])).toEqual([recent, middle, stale]);
  });

  it('puts a project that has never had activity at the tail, not the head', () => {
    const never = project({ lastActivityAt: null });
    const longAgo = project({ buckets: { running: 1 }, lastActivityAt: '2020-01-01T00:00:00Z' });

    // Null is "nothing has ever happened here", which must not read as "happened at the epoch,
    // therefore newest" — nor sort above a project that moved six years ago.
    expect(orderWithinSection('running', [never, longAgo])).toEqual([longAgo, never]);
  });

  it('gives two projects that have never had a task a definite order', () => {
    const a = project({ lastActivityAt: null });
    const b = project({ lastActivityAt: null });

    // Neither outranks the other, so the incoming order stands — and stands the same way round
    // whichever way it arrived. Never an order left to whatever the engine does with a NaN.
    expect(orderWithinSection('running', [a, b])).toEqual([a, b]);
    expect(orderWithinSection('running', [b, a])).toEqual([b, a]);
  });

  it('orders Wrapping up and Completed by activity too', () => {
    const older = project({ buckets: { done: 2 }, lastActivityAt: '2026-01-01T00:00:00.000Z' });
    const newer = project({ buckets: { done: 5 }, lastActivityAt: '2026-06-01T00:00:00.000Z' });

    expect(orderWithinSection('wrapping-up', [older, newer])).toEqual([newer, older]);
    expect(orderWithinSection('completed', [older, newer])).toEqual([newer, older]);
  });

  it('leaves the array it was handed alone', () => {
    const input = [stalled(1, '2026-01-01T00:00:00.000Z'), stalled(9, '2026-01-01T00:00:00.000Z')];
    const before = [...input];

    orderWithinSection('stalled', input);

    // The array is react-query's cache entry; sorting it in place would reorder the cache.
    expect(input).toEqual(before);
  });
});

describe('projectAttentionSections', () => {
  /** Rows carrying the fields `ProjectSections` needs on top of the ones this module reads. */
  const row = (id: string, over: Parameters<typeof project>[0] = {}) => ({
    id: `0195c0de-0000-7000-8000-0000000000${id}`,
    title: `Project ${id}`,
    _count: { tasks: 1 },
    ...project(over),
  });

  it('returns the four sections in reading order, attention first', () => {
    const sections = projectAttentionSections([]);

    // In progress sits BELOW Stalled on purpose: work that is already running does not need the
    // reader, and work that could run but isn't does.
    expect(sections.map((s) => s.key)).toEqual(['stalled', 'wrapping-up', 'running', 'completed']);
    expect(sections.map((s) => s.title)).toEqual([
      'Stalled',
      'Wrapping up',
      'In progress',
      'Completed',
    ]);
  });

  it('gives every section a header line naming what orders it', () => {
    for (const section of projectAttentionSections([])) {
      expect(section.note.length).toBeGreaterThan(0);
      // Each note names its ordering key in words a reader can check against the row: the ready
      // count, or the activity column. An order whose key is not on the page is not verifiable.
      expect(section.note).toMatch(/ready|activity/);
    }
  });

  it('folds only Completed by default', () => {
    const collapsed = projectAttentionSections([])
      .filter((s) => s.defaultCollapsed)
      .map((s) => s.key);

    expect(collapsed).toEqual(['completed']);
  });

  it('files a mixed list into its four sections and orders each', () => {
    const sections = projectAttentionSections([
      row('01', { buckets: { running: 1 }, lastActivityAt: '2026-01-02T00:00:00.000Z' }),
      row('02', { buckets: { ready: 9, blocked: 1 }, lastActivityAt: '2026-01-01T00:00:00.000Z' }),
      row('03', { status: 'DONE', buckets: { done: 16 } }),
      row('04', { buckets: { done: 12 } }),
      row('05', { buckets: { ready: 6118, blocked: 17324 } }),
      row('06', { buckets: { running: 1 }, lastActivityAt: '2026-05-02T00:00:00.000Z' }),
      row('07', { status: 'CANCELLED', buckets: { done: 3 } }),
      row('08', { buckets: {}, lastActivityAt: null }),
    ]);

    const titles = (key: AttentionSectionKey) =>
      sections.find((s) => s.key === key)!.projects.map((p) => p.title);

    expect(titles('stalled')).toEqual(['Project 05', 'Project 02']);
    expect(titles('wrapping-up')).toEqual(['Project 04']);
    // The task-less project 08 is here, and it is LAST — no special case in the sort, just null
    // activity sorting below every real instant.
    expect(titles('running')).toEqual(['Project 06', 'Project 01', 'Project 08']);
    expect(titles('completed')).toEqual(['Project 03', 'Project 07']);
  });

  it('keeps a section that matched nothing, for its caller to drop', () => {
    const sections = projectAttentionSections([row('01', { buckets: { running: 1 } })]);

    // Four sections come back whatever the data — ProjectSections is the one place that decides
    // an empty section is not worth a header, and deciding it twice is how the two drift.
    expect(sections).toHaveLength(4);
    expect(sections.find((s) => s.key === 'stalled')!.projects).toEqual([]);
  });
});
