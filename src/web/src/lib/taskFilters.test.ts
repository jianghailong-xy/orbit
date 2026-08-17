import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canDispatchTask,
  canStartTask,
  DEFAULT_TASK_FILTER,
  initialTaskFilter,
  matchesTaskFilter,
  rememberTaskFilter,
  TASK_FILTER_STORAGE_KEY,
} from './taskFilters';

const runnable = {
  status: 'OPEN',
  assignee: { runner: { id: 'runner-1' } },
  running: false,
  queued: false,
  blocked: false,
};

describe('task filters', () => {
  // Ready is near-permanently zero in a dependency-ordered campaign, so landing on it showed an
  // empty table over a list of tens of thousands. The landing tab has to show the work.
  it('defaults to showing every task, not only the dispatchable ones', () => {
    expect(DEFAULT_TASK_FILTER).toBe('ALL');
    expect(matchesTaskFilter(runnable, DEFAULT_TASK_FILTER)).toBe(true);
    expect(matchesTaskFilter({ ...runnable, status: 'DONE' }, DEFAULT_TASK_FILTER)).toBe(true);
  });

  describe('the remembered tab', () => {
    // These tests run in the node environment the rest of the suite uses, which has no DOM and
    // therefore no localStorage — so the store is supplied here rather than pulling in jsdom.
    beforeEach(() => {
      const store = new Map<string, string>();
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
      };
    });
    afterEach(() => {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    it('falls back to the default until the user has picked something', () => {
      expect(initialTaskFilter(null)).toBe(DEFAULT_TASK_FILTER);
    });

    it('reopens on the last tab the user picked', () => {
      rememberTaskFilter('RUNNING');
      expect(initialTaskFilter(null)).toBe('RUNNING');
      expect(localStorage.getItem(TASK_FILTER_STORAGE_KEY)).toBe('RUNNING');
    });

    // A shared link has to mean what it says, whatever the recipient last looked at.
    it('lets an explicit URL filter win over the remembered one', () => {
      rememberTaskFilter('RUNNING');
      expect(initialTaskFilter('FAILED')).toBe('FAILED');
    });

    // Safari's private mode throws on access rather than returning null, and a task list that
    // will not render is a worse outcome than a forgotten preference.
    it('survives storage throwing', () => {
      (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      };
      expect(initialTaskFilter(null)).toBe(DEFAULT_TASK_FILTER);
      expect(() => rememberTaskFilter('RUNNING')).not.toThrow();
    });

    // The page itself renders server-side in these tests, where the global is simply absent.
    it('survives storage being absent entirely', () => {
      delete (globalThis as { localStorage?: unknown }).localStorage;
      expect(initialTaskFilter(null)).toBe(DEFAULT_TASK_FILTER);
      expect(() => rememberTaskFilter('RUNNING')).not.toThrow();
    });
  });

  it.each([
    ['done', { status: 'DONE' }],
    ['unassigned', { assignee: null }],
    ['without a runner', { assignee: { runner: null } }],
    ['running', { running: true }],
    ['queued', { queued: true }],
    ['waiting on a prerequisite', { blocked: true }],
  ])('excludes a task that is %s', (_label, override) => {
    expect(canStartTask({ ...runnable, ...override })).toBe(false);
  });

  it('keeps failed tasks available for retry', () => {
    expect(canStartTask({ ...runnable, status: 'FAILED' })).toBe(true);
  });

  it('keeps cancelled tasks restartable, matching the existing Run action', () => {
    expect(canStartTask({ ...runnable, status: 'CANCELLED' })).toBe(true);
  });

  it.each([
    ['unassigned', { assignee: null }],
    ['without a runner', { assignee: { runner: null } }],
    ['running', { running: true }],
    ['queued', { queued: true }],
    ['waiting on a prerequisite', { blocked: true }],
  ])('will not dispatch a task that is %s', (_label, override) => {
    expect(canDispatchTask({ ...runnable, ...override })).toBe(false);
  });

  it('still dispatches a done task, since neither execute endpoint refuses one', () => {
    expect(canDispatchTask({ ...runnable, status: 'DONE' })).toBe(true);
    // The row's Run button and the Ready filter do hide it — that's the only difference.
    expect(canStartTask({ ...runnable, status: 'DONE' })).toBe(false);
  });

  it('matches the live execution overlay for the Running filter', () => {
    expect(matchesTaskFilter({ ...runnable, status: 'DONE', running: true }, 'RUNNING')).toBe(true);
    expect(matchesTaskFilter({ ...runnable, status: 'IN_PROGRESS' }, 'RUNNING')).toBe(false);
    expect(matchesTaskFilter({ ...runnable, queued: true }, 'RUNNING')).toBe(false);
  });

  it('preserves the existing lifecycle filters', () => {
    expect(matchesTaskFilter({ ...runnable, status: 'IN_PROGRESS' }, 'ONGOING')).toBe(true);
    expect(matchesTaskFilter({ ...runnable, status: 'FAILED' }, 'FAILED')).toBe(true);
    expect(matchesTaskFilter({ ...runnable, status: 'DONE' }, 'ALL')).toBe(true);
  });
});
