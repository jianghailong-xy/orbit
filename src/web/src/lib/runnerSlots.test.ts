import { describe, expect, it } from 'vitest';
import { activeSlotCount, runnerSlotUsage } from './runnerSlots';

const sessions = (status: string, count: number) =>
  Array.from({ length: count }, () => ({ status }));

describe('runner slot accounting', () => {
  it('does not count awaiting-input sessions, whether they are warm or cold', () => {
    const awaiting = Array.from({ length: 32 }, (_, index) => ({
      status: 'AWAITING_INPUT',
      runtimeState: index % 2 === 0 ? 'warm' : 'cold',
    }));

    expect(activeSlotCount(awaiting)).toBe(0);
    expect(runnerSlotUsage(awaiting, 32)).toEqual({ active: 0, atCapacity: false });
  });

  it('keeps the 31/32 and 32/32 running boundaries exact', () => {
    expect(runnerSlotUsage(sessions('RUNNING', 31), 32)).toEqual({
      active: 31,
      atCapacity: false,
    });
    expect(runnerSlotUsage(sessions('RUNNING', 32), 32)).toEqual({
      active: 32,
      atCapacity: true,
    });
  });

  it('only counts RUNNING in a mixed session list', () => {
    const mixed = [
      ...sessions('RUNNING', 2),
      ...sessions('AWAITING_INPUT', 32),
      ...sessions('PENDING', 4),
      ...sessions('INTERRUPTED', 1),
    ];

    expect(runnerSlotUsage(mixed, 3)).toEqual({ active: 2, atCapacity: false });
  });

  it('prefers runStatus while retaining the legacy status alias', () => {
    const mixed = [
      { runStatus: 'RUNNING', status: 'AWAITING_INPUT' },
      { runStatus: 'AWAITING_INPUT', status: 'RUNNING' },
      { runStatus: 'running' },
      { status: 'RUNNING' },
    ];

    expect(activeSlotCount(mixed)).toBe(3);
  });
});
