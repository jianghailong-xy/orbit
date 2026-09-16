import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canDispatchTask,
  canStartTask,
  DEFAULT_TASK_FILTER,
  initialTaskFilter,
  matchesTaskFilter,
  rememberTaskFilter,
  taskStartOwnedByCompletionDeclaration,
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

  it('uses the server task_start verdict and fails closed for a verification subject', () => {
    expect(canStartTask({ ...runnable, runnable: false })).toBe(false);
    expect(canStartTask({
      ...runnable,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'VERIFICATION_PASSED',
      verifiesTaskId: null,
    })).toBe(false);
    // A verifier task names its subject and remains ordinary executable work.
    expect(canStartTask({
      ...runnable,
      completionCriterion: 'VERIFICATION',
      completionPolicy: 'MANUAL',
      verifiesTaskId: 'subject-1',
    })).toBe(true);
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

/**
 * The completion declaration — the row nothing dispatches, because it has no work of its own.
 *
 * Cross-layer anchor, web half. The server half is the kill clause in `manualRunnableTaskSql`
 * (src/apiserver/src/tasks/manual-runnable-task-sql.ts), asserted against the SQL it actually emits
 * in src/apiserver/src/tasks/verification-subject-guard-removal.spec.ts under "(a) and the Ready
 * predicate kills the gate row by policy, never by criterion": the clause reads `completion_policy`
 * and `verifies_task_id`, and never `completion_criterion`. This block is that same rule in the
 * browser, on the same three rows. The criterion says who settles a task, not whether the row has
 * work to do — a task can perfectly well run and still need another session to check it — so the
 * two sides must be read the same way or the Ready tab and this page disagree about one task.
 * Changing the rule on either side is what reddens that side's anchor.
 */
describe('the completion declaration that owns the row', () => {
  // The three shapes the server distinguishes, each spelled with the criterion present — the field
  // the two questions used to be confused over.
  const workRow = {
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'MANUAL',
    verifiesTaskId: null,
  };
  const gateRow = {
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'VERIFICATION_PASSED',
    verifiesTaskId: null,
  };
  const verifierRow = {
    completionCriterion: 'VERIFICATION',
    completionPolicy: 'MANUAL',
    verifiesTaskId: 'subject-1',
  };

  it('reaches the same three verdicts the server’s Ready predicate reaches', () => {
    // The gate row: nothing but an independent verdict finishes it, so nothing here is dispatched.
    expect(taskStartOwnedByCompletionDeclaration({ ...runnable, ...gateRow })).toBe(true);
    expect(canDispatchTask({ ...runnable, ...gateRow })).toBe(false);
    expect(canStartTask({ ...runnable, ...gateRow })).toBe(false);
    // The work row: it declares VERIFICATION and still has work of its own. This is the row that
    // was undispatachable while the criterion was read as "no work here"; it starts like any other.
    expect(taskStartOwnedByCompletionDeclaration({ ...runnable, ...workRow })).toBe(false);
    expect(canDispatchTask({ ...runnable, ...workRow })).toBe(true);
    expect(canStartTask({ ...runnable, ...workRow })).toBe(true);
    // The verifier names the task it checks, so it is executable work in its own right.
    expect(taskStartOwnedByCompletionDeclaration({ ...runnable, ...verifierRow })).toBe(false);
    expect(canStartTask({ ...runnable, ...verifierRow })).toBe(true);
  });

  it('asks the criterion nothing, in either direction', () => {
    // The distinguishing input is a row carrying the two columns and no criterion at all. Asking the
    // criterion anywhere in the predicate — the `completionCriterion === 'VERIFICATION'` this used
    // to require — reddens both of these, which is what keeps the browser on the server's rule.
    expect(canStartTask({ ...runnable, completionPolicy: 'MANUAL', verifiesTaskId: null })).toBe(true);
    expect(
      canStartTask({ ...runnable, completionPolicy: 'VERIFICATION_PASSED', verifiesTaskId: null }),
    ).toBe(false);
  });
});
