import { describe, expect, it } from 'vitest';
import { activeSlotCount, pendingSlotDescription, runnerSlotUsage } from './runnerSlots';

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

describe('why a queued session has not started', () => {
  // The case the whole thing exists for: the machine has room, the run does not. Reading the
  // runner's own numbers here would say "plenty of slots" and explain nothing.
  it('blames the run, not the machine, when the tree is what is full', () => {
    expect(
      pendingSlotDescription(3, 16, {
        queuedReason: 'tree_at_capacity',
        queuedActive: 3,
        queuedLimit: 3,
      }),
    ).toBe(
      'This run is already using all its slots (3/3). The next sub-session starts as one finishes.',
    );
  });

  it('names the batch when a batch run is what is full', () => {
    expect(
      pendingSlotDescription(1, 16, {
        queuedReason: 'batch_at_capacity',
        queuedActive: 5,
        queuedLimit: 5,
      }),
    ).toBe('This batch is running its maximum (5/5). This session starts as soon as a slot frees up.');
  });

  it('uses the numbers the server judged on, not the ones this page can see', () => {
    // The list holds one agent's page; the runner-wide count it can derive is not the count
    // the claim actually compared against.
    expect(
      pendingSlotDescription(2, 16, {
        queuedReason: 'runner_at_capacity',
        queuedActive: 16,
        queuedLimit: 16,
      }),
    ).toBe('Runner at capacity (16/16). This session starts as soon as a slot frees up.');
  });

  it('says only that it is waiting when no gate is holding it', () => {
    expect(pendingSlotDescription(1, 16, { queuedReason: null })).toBe(
      'This session starts as soon as a slot frees up.',
    );
  });

  // A server that predates the field sends nothing; the old runner-capacity reading stands in.
  it('falls back to the local reading for an older payload', () => {
    expect(pendingSlotDescription(16, 16, null)).toBe(
      'Runner at capacity (16/16). This session starts as soon as a slot frees up.',
    );
    expect(pendingSlotDescription(3, 16, undefined)).toBe(
      'This session starts as soon as a slot frees up.',
    );
  });
});
