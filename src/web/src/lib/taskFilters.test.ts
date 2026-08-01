import { describe, expect, it } from 'vitest';
import { canStartTask, DEFAULT_TASK_FILTER, matchesTaskFilter } from './taskFilters';

const runnable = {
  status: 'OPEN',
  assignee: { runner: { id: 'runner-1' } },
  running: false,
  queued: false,
  blocked: false,
};

describe('task filters', () => {
  it('defaults to tasks that can be started now', () => {
    expect(DEFAULT_TASK_FILTER).toBe('RUNNABLE');
    expect(matchesTaskFilter(runnable, DEFAULT_TASK_FILTER)).toBe(true);
  });

  it.each([
    ['done', { status: 'DONE' }],
    ['cancelled', { status: 'CANCELLED' }],
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

  it('preserves the existing lifecycle filters', () => {
    expect(matchesTaskFilter({ ...runnable, status: 'IN_PROGRESS' }, 'ONGOING')).toBe(true);
    expect(matchesTaskFilter({ ...runnable, status: 'FAILED' }, 'FAILED')).toBe(true);
    expect(matchesTaskFilter({ ...runnable, status: 'DONE' }, 'ALL')).toBe(true);
  });
});
