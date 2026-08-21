import { describe, expect, it } from 'vitest';
import { supersessionNote, taskOutcome, taskOutcomeChip } from './taskOutcome';

describe('taskOutcome', () => {
  it('tells failed, cancelled and superseded apart', () => {
    expect(taskOutcome({ status: 'FAILED' })).toBe('FAILED');
    expect(taskOutcome({ status: 'CANCELLED' })).toBe('CANCELLED');
    expect(taskOutcome({ status: 'CANCELLED', terminalReason: 'SUPERSEDED' })).toBe('SUPERSEDED');
    expect(taskOutcome({ status: 'CANCELLED', terminalReason: 'ABANDONED' })).toBe('ABANDONED');
  });

  it('reads a superseded FAILURE as superseded without hiding that it failed', () => {
    // The status column still says FAILED; nothing about supersession rewrites it.
    const task = { status: 'FAILED', terminalReason: 'SUPERSEDED' };
    expect(taskOutcome(task)).toBe('SUPERSEDED');
    expect(task.status).toBe('FAILED');
  });

  it('never paints an unknown status as healthy', () => {
    expect(taskOutcome({ status: 'PARKED' })).toBe('PARKED');
    expect(taskOutcomeChip({ status: 'PARKED' })).toEqual({ label: 'PARKED', tone: 'muted' });
    expect(taskOutcomeChip(null)).toEqual({ label: '', tone: 'muted' });
  });

  it('gives superseded its own colour — the work is still happening', () => {
    expect(taskOutcomeChip({ status: 'CANCELLED', terminalReason: 'SUPERSEDED' })).toEqual({
      label: 'Superseded',
      tone: 'amber',
    });
    // ...and a dropped task stays grey, which is the distinction the chip exists for.
    expect(taskOutcomeChip({ status: 'CANCELLED', terminalReason: 'ABANDONED' }).tone).toBe('muted');
  });
});

describe('supersessionNote', () => {
  it('says nothing when there is nothing to say', () => {
    expect(supersessionNote(null)).toBeNull();
    expect(supersessionNote({ terminalReason: null })).toBeNull();
    expect(supersessionNote({ terminalReason: null, supersedes: [] })).toBeNull();
  });

  it('names the successor', () => {
    expect(
      supersessionNote({
        terminalReason: 'SUPERSEDED',
        successorChain: [{ id: 'b', title: '04R4 review' }],
      }),
    ).toBe('Superseded by 04R4 review');
  });

  it('follows a chain of replacements to the live attempt', () => {
    expect(
      supersessionNote({
        terminalReason: 'SUPERSEDED',
        successorChain: [
          { id: 'b', title: '04R2' },
          { id: 'c', title: '04R3' },
          { id: 'd', title: '04R4' },
        ],
      }),
    ).toBe('Superseded — 04R4 is the live attempt, 3 replacements on');
  });

  it('a deleted successor is not "nothing replaced this"', () => {
    expect(
      supersessionNote({
        terminalReason: 'SUPERSEDED',
        supersededByTaskIdAbsentReason: 'SUCCESSOR_DELETED',
        successorChain: [],
      }),
    ).toBe('Superseded — the task that replaced it has been deleted');
  });

  it('reads from the other end too', () => {
    expect(supersessionNote({ supersedes: [{ id: 'a', title: '04R' }] })).toBe('Replaces 04R');
    expect(
      supersessionNote({
        supersedes: [
          { id: 'a', title: '04R' },
          { id: 'b', title: '04R2' },
          { id: 'c', title: '04R3' },
        ],
      }),
    ).toBe('Replaces 3 earlier attempts');
  });
});
