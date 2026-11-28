import { describe, expect, it } from 'vitest';
import { taskFailureReason, taskStatusReasonText } from './taskStatusReason';

const said = (run: Parameters<typeof taskFailureReason>[0]): string | null => {
  const reason = taskFailureReason(run);
  return reason ? taskStatusReasonText(reason) : null;
};

describe('task status reason', () => {
  it('names the newest acceptance round that disagreed, with its code', () => {
    expect(said({ acceptanceRounds: [{ exitCode: 1, expectedExitCode: 0 }, { exitCode: 0, expectedExitCode: 0 }] }))
      .toBe('check exited 1');
    expect(said({ acceptanceRounds: [{ exitCode: null, expectedExitCode: 0 }] })).toBe('check exited -1');
  });

  it('reads the apiserver sentence when no round is listed', () => {
    expect(said({ error: 'acceptance command exited 2; expected 0' })).toBe('check exited 2');
  });

  it('names a lost runner, a budget, a stop and an interruption', () => {
    expect(said({ error: 'runner offline' })).toBe('runner lost');
    expect(said({ error: 'the run went over budget' })).toBe('over budget');
    expect(said({ endReason: 'cancelled' })).toBe('run stopped');
    expect(said({ lastTurnOutcome: 'CANCELLED' })).toBe('run stopped');
    expect(said({ lastTurnOutcome: 'INTERRUPTED' })).toBe('run interrupted');
  });

  it('falls back to "run failed" for an engine error, and says nothing without a cause', () => {
    expect(said({ error: 'engine crashed' })).toBe('run failed');
    expect(said({ lastTurnOutcome: 'FAILED' })).toBe('run failed');
    expect(said({ acceptanceRounds: [{ exitCode: 0, expectedExitCode: 0 }], lastTurnOutcome: 'ANSWERED' })).toBeNull();
    expect(said(null)).toBeNull();
  });
});
