import { describe, expect, it } from 'vitest';
import { RunStatus, SessionEndReason, gracefulEndStatus } from './enums';

describe('gracefulEndStatus', () => {
  it('settles an idle recycle / user end at PARKED (terminal but resumable)', () => {
    // The reported bug: a healthy session the reaper recycled after 4h idle came back
    // as FAILED because the runner never acknowledged the teardown.
    expect(gracefulEndStatus(SessionEndReason.IDLE)).toBe(RunStatus.PARKED);
    expect(gracefulEndStatus(SessionEndReason.ENDED)).toBe(RunStatus.PARKED);
  });

  it('settles a finished task at SUCCEEDED — a completed run must not read as cancelled', () => {
    expect(gracefulEndStatus(SessionEndReason.TASK_DONE)).toBe(RunStatus.SUCCEEDED);
  });

  it('returns null for a hard end or an unrecorded reason, so callers keep their own', () => {
    expect(gracefulEndStatus(SessionEndReason.COMPLETED)).toBeNull();
    expect(gracefulEndStatus(SessionEndReason.DELETED)).toBeNull();
    expect(gracefulEndStatus(SessionEndReason.CANCELLED)).toBeNull();
    expect(gracefulEndStatus(null)).toBeNull();
    expect(gracefulEndStatus(undefined)).toBeNull();
  });
});
