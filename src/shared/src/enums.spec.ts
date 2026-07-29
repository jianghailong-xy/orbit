import { describe, expect, it } from 'vitest';
import { RunStatus, SessionEndReason, gracefulEndStatus } from './enums';

describe('gracefulEndStatus', () => {
  it('settles an idle recycle / user end at CANCELLED, never FAILED', () => {
    // The reported bug: a healthy session the reaper recycled after 4h idle came back
    // as FAILED because the runner never acknowledged the teardown. Returning a non-null
    // status is what prevents that — the reaper's forceFinalize defaults to FAILED — so
    // these two must stay explicit rather than falling through to null.
    expect(gracefulEndStatus(SessionEndReason.IDLE)).toBe(RunStatus.CANCELLED);
    expect(gracefulEndStatus(SessionEndReason.ENDED)).toBe(RunStatus.CANCELLED);
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
