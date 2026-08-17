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
  it('defaults to newest-first, the order the server already sent', () => {
    expect(DEFAULT_TASK_SORT_FIELD).toBe('created');
    expect(DEFAULT_TASK_SORT_DIRECTION).toBe('desc');
    expect(readTaskSort(new URLSearchParams())).toEqual({ field: 'created', direction: 'desc' });
  });

  // Links written before the default moved say `sort=status` explicitly, so they keep meaning
  // exactly what they said.
  it('still honours an explicit status sort from an older link', () => {
    expect(readTaskSort(new URLSearchParams('sort=status&dir=asc'))).toEqual({
      field: 'status',
      direction: 'asc',
    });
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
      writeTaskSort(new URLSearchParams('filter=ALL&sort=title&dir=desc'), 'created', 'desc').toString(),
    ).toBe('filter=ALL');
  });

  it('falls back safely when a shared link contains an unknown sort field', () => {
    expect(readTaskSort(new URLSearchParams('sort=unknown'))).toEqual({
      field: 'created',
      direction: 'desc',
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
    expect([...rows].sort((a, b) => compareTasksBy(a, b, 'status'))).toEqual([
      running,
      queued,
      inProgress,
      open,
    ]);
  });

  // The list arrives newest-first and stays that way until somebody asks for something else.
  // Defaulting to `status` implied the browser could rank the whole account, when it only ever
  // holds the pages fetched so far — and the running work sits at the far end of those.
  it('defaults to the order the server sent, not to a client-side ranking', () => {
    expect(DEFAULT_TASK_SORT_FIELD).toBe('created');
    expect(DEFAULT_TASK_SORT_DIRECTION).toBe('desc');

    const newer = { status: 'OPEN', createdAt: '2026-08-02T10:00:00.000Z' };
    const older = { status: 'OPEN', createdAt: '2026-08-01T10:00:00.000Z' };
    const sorted = [older, newer].sort(
      (a, b) => -compareTasksBy(a, b, DEFAULT_TASK_SORT_FIELD),
    );
    expect(sorted).toEqual([newer, older]);
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
