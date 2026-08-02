import { describe, expect, it } from 'vitest';
import {
  compareTasksBy,
  DEFAULT_TASK_SORT_DIRECTION,
  DEFAULT_TASK_SORT_FIELD,
  readTaskSort,
  taskStatusRank,
  writeTaskSort,
} from './taskSorting';

describe('task sorting', () => {
  it('defaults to ascending status order', () => {
    expect(DEFAULT_TASK_SORT_FIELD).toBe('status');
    expect(DEFAULT_TASK_SORT_DIRECTION).toBe('asc');
    expect(readTaskSort(new URLSearchParams())).toEqual({ field: 'status', direction: 'asc' });
  });

  it('keeps old field-only links descending and writes new non-default sorts explicitly', () => {
    expect(readTaskSort(new URLSearchParams('sort=title'))).toEqual({
      field: 'title',
      direction: 'desc',
    });
    expect(writeTaskSort(new URLSearchParams('filter=ALL'), 'title', 'asc').toString()).toBe(
      'filter=ALL&sort=title&dir=asc',
    );
    expect(
      writeTaskSort(new URLSearchParams('filter=ALL&sort=title&dir=desc'), 'status', 'asc').toString(),
    ).toBe('filter=ALL');
  });

  it('falls back safely when a shared link contains an unknown sort field', () => {
    expect(readTaskSort(new URLSearchParams('sort=unknown'))).toEqual({
      field: 'status',
      direction: 'asc',
    });
  });

  it('puts running tasks ahead of queued and lifecycle statuses', () => {
    const running = { status: 'DONE', running: true };
    const queued = { status: 'OPEN', queued: true };
    const inProgress = { status: 'IN_PROGRESS' };
    const open = { status: 'OPEN' };

    expect(taskStatusRank(running)).toBeLessThan(taskStatusRank(queued));
    expect(taskStatusRank(queued)).toBeLessThan(taskStatusRank(inProgress));
    expect(taskStatusRank(inProgress)).toBeLessThan(taskStatusRank(open));

    const rows = [open, queued, running, inProgress];
    expect([...rows].sort((a, b) => compareTasksBy(a, b, DEFAULT_TASK_SORT_FIELD))).toEqual([
      running,
      queued,
      inProgress,
      open,
    ]);
  });

  it('keeps the incoming newest-first order when two tasks have the same status rank', () => {
    const newer = { status: 'OPEN', createdAt: '2026-08-02T10:00:00.000Z' };
    const older = { status: 'OPEN', createdAt: '2026-08-01T10:00:00.000Z' };

    expect(compareTasksBy(newer, older, 'status')).toBe(0);
    expect([newer, older].sort((a, b) => compareTasksBy(a, b, 'status'))).toEqual([
      newer,
      older,
    ]);
  });
});
