import { describe, expect, it } from 'vitest';
import { taskPagePath } from './taskPages';

describe('taskPagePath', () => {
  it('sends the runnable pseudo-status used by the default task filter', () => {
    expect(taskPagePath({ status: 'RUNNABLE' })).toBe('/tasks/page?status=RUNNABLE');
  });

  it('keeps an explicit All UI filter unfiltered at the API', () => {
    expect(taskPagePath({ status: 'ALL' })).toBe('/tasks/page');
  });
});
