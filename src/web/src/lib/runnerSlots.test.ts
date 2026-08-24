import { describe, expect, it } from 'vitest';
import {
  activeSlotCount,
  pendingSlotDescription,
  queuedLabel,
  queuedTitle,
  runnerSlotUsage,
} from './runnerSlots';

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
    // The list holds one workspace's page; the runner-wide count it can derive is not the count
    // the claim actually compared against.
    expect(
      pendingSlotDescription(2, 16, {
        queuedReason: 'runner_at_capacity',
        queuedActive: 16,
        queuedLimit: 16,
      }),
    ).toBe('Runner at capacity (16/16). This session starts as soon as a slot frees up.');
  });

  // The case this deployment is almost always in, and the one the old copy got wrong: the
  // server checked every gate and found none, so nothing is contended and nothing about
  // capacity is worth reporting. It is simply not picked up yet.
  it('does not blame capacity when the server found no gate at all', () => {
    expect(pendingSlotDescription(1, 16, { queuedReason: null })).toBe(
      'Waiting for the runner to pick it up.',
    );
  });

  it('names an offline runner, which no count can explain', () => {
    expect(pendingSlotDescription(0, 16, { queuedReason: 'runner_offline' })).toBe(
      'The assigned runner is offline. This session starts when it comes back.',
    );
  });

  it('names the git operation fencing the checkout', () => {
    expect(pendingSlotDescription(0, 16, { queuedReason: 'worktree_op_pending' })).toBe(
      'A merge or commit is finishing on this session\u2019s checkout. It starts as soon as that settles.',
    );
  });

  // A null and an absent value are different claims and must not collapse into one another:
  // one is "no gate", the other is "nobody asked". Only the first may be reported as a plain
  // queue — reporting the second that way would state, on an old server, something it never said.
  it('keeps null and undefined apart', () => {
    expect(queuedTitle({ queuedReason: null })).toBe('Queued');
    expect(queuedTitle(undefined)).toBe('Waiting for a free slot');
    expect(queuedTitle(null)).toBe('Waiting for a free slot');
    expect(queuedLabel({ queuedReason: null })).toBe('Queued');
    expect(queuedLabel(undefined)).toBe('Waiting for slot');
  });

  it('keeps slot wording only for the gates that really are slots', () => {
    expect(queuedTitle({ queuedReason: 'runner_at_capacity' })).toBe('Waiting for a free slot');
    expect(queuedTitle({ queuedReason: 'tree_at_capacity' })).toBe('Waiting for a free slot');
    expect(queuedTitle({ queuedReason: 'batch_at_capacity' })).toBe('Waiting for a free slot');
    expect(queuedTitle({ queuedReason: 'runner_offline' })).toBe('Runner offline');
    expect(queuedTitle({ queuedReason: 'worktree_op_pending' })).toBe(
      'Waiting for a git operation',
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
