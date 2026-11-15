import { describe, expect, it } from 'vitest';
import {
  capacityHeldMessageText,
  capacityHeldTag,
  capacityHeldTitle,
  capacityHeldWaited,
  isCapacityHeld,
  type CapacityGate,
} from './queuedCapacity';

/** Board queued-card-runner-full ③: HPC on 11-15, 10 turns and 6 slots held by bg_run jobs, of 16. */
const hpc: CapacityGate = {
  queuedReason: 'runner_at_capacity',
  queuedActive: 16,
  queuedLimit: 16,
  queuedHeldByJobs: 6,
  lastTurnAt: '2026-11-14T17:14:54.436Z',
};

describe('a queued message a full runner, run or batch holds', () => {
  it('is held by the three capacity gates and no other', () => {
    expect(isCapacityHeld(hpc)).toBe(true);
    expect(isCapacityHeld({ queuedReason: 'tree_at_capacity' })).toBe(true);
    expect(isCapacityHeld({ queuedReason: 'batch_at_capacity' })).toBe(true);
    for (const queuedReason of ['runner_updating', 'runner_offline', 'worktree_op_pending', null, undefined]) {
      expect(isCapacityHeld({ queuedReason })).toBe(false);
    }
    expect(isCapacityHeld(null)).toBe(false);
  });

  it('names what is full in its tag and title', () => {
    expect([capacityHeldTag(hpc), capacityHeldTitle(hpc)]).toEqual(['runner full', 'Runner full']);
    const run = { queuedReason: 'tree_at_capacity' };
    expect([capacityHeldTag(run), capacityHeldTitle(run)]).toEqual(['run full', 'Run full']);
    const batch = { queuedReason: 'batch_at_capacity' };
    expect([capacityHeldTag(batch), capacityHeldTitle(batch)]).toEqual(['batch full', 'Batch full']);
  });

  it('counts turns and slots held by background jobs apart (board ③)', () => {
    expect(capacityHeldMessageText(hpc, 'HPC')).toBe(
      'HPC is using all 16 slots: 10 sessions are running a turn and 6 hold a slot with a background job. This message is sent as soon as one frees up.',
    );
    expect(capacityHeldMessageText({ ...hpc, queuedActive: 2, queuedLimit: 2, queuedHeldByJobs: 1 }, 'HPC')).toBe(
      'HPC is using all 2 slots: 1 session is running a turn and 1 holds a slot with a background job. This message is sent as soon as one frees up.',
    );
  });

  it('counts turns alone where no job holds a slot, or from a runner too old to say (board ⑤)', () => {
    expect(capacityHeldMessageText({ ...hpc, queuedHeldByJobs: 0 }, 'HPC')).toBe(
      'HPC is running 16 of 16 sessions. This message is sent as soon as one finishes.',
    );
    expect(capacityHeldMessageText({ ...hpc, queuedHeldByJobs: undefined }, '  ')).toBe(
      'The runner is running 16 of 16 sessions. This message is sent as soon as one finishes.',
    );
    expect(capacityHeldMessageText({ queuedReason: 'runner_at_capacity' }, 'HPC')).toBe(
      'HPC is using all its slots. This message is sent as soon as one frees up.',
    );
  });

  it('says a run or a batch is full in its own words', () => {
    expect(capacityHeldMessageText({ queuedReason: 'tree_at_capacity', queuedActive: 13, queuedLimit: 13 }, 'HPC')).toBe(
      'This run is already using all its slots (13/13). This message is sent as soon as one of its sessions finishes.',
    );
    expect(capacityHeldMessageText({ queuedReason: 'batch_at_capacity', queuedActive: 4, queuedLimit: 4 })).toBe(
      'This batch is running its maximum (4/4). This message is sent as soon as one of its sessions finishes.',
    );
  });

  it('counts the wait from when the session went PENDING', () => {
    const at = Date.parse(hpc.lastTurnAt!);
    expect(capacityHeldWaited(hpc, at + 15 * 60_000 + 30_000)).toBe('Waiting 15 min');
    expect(capacityHeldWaited(hpc, at + 20_000)).toBe('Waiting less than a minute');
    expect(capacityHeldWaited(hpc, at + 75 * 60_000)).toBe('Waiting 1 h 15 min');
    expect(capacityHeldWaited({ ...hpc, lastTurnAt: null }, at)).toBeNull();
    expect(capacityHeldWaited(hpc, at - 1)).toBeNull();
  });
});
