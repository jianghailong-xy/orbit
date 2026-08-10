import { describe, expect, it } from 'vitest';
import { taskPagePath } from './taskPages';

describe('taskPagePath', () => {
  it('sends the runnable pseudo-status used by the default task filter', () => {
    expect(taskPagePath({ status: 'RUNNABLE' })).toBe('/tasks/page?status=RUNNABLE');
  });

  it('sends the running execution-state filter', () => {
    expect(taskPagePath({ status: 'RUNNING' })).toBe('/tasks/page?status=RUNNING');
  });

  it('keeps an explicit All UI filter unfiltered at the API', () => {
    expect(taskPagePath({ status: 'ALL' })).toBe('/tasks/page');
  });

  it('asks the server to skip the scope-wide aggregates when they are not read', () => {
    expect(taskPagePath({ cursor: 'abc', counts: 'none' })).toBe(
      '/tasks/page?cursor=abc&counts=none',
    );
  });

  it('keeps the aggregates on the first page, which is the one carrying the tab badges', () => {
    expect(taskPagePath({ status: 'RUNNABLE', counts: undefined })).toBe(
      '/tasks/page?status=RUNNABLE',
    );
  });
});
