import { describe, expect, it } from 'vitest';
import {
  RunStatus,
  SessionEndReason,
  SessionFilingState,
  SessionLifecycleState,
  SessionRunState,
  SessionState,
  deriveSessionFilingState,
  deriveSessionLifecycleState,
  deriveSessionRunState,
  deriveSessionState,
  gracefulEndStatus,
} from './enums';

describe('deriveSessionState', () => {
  it('gives deleted and archived filing state precedence while preserving archived failures', () => {
    expect(
      deriveSessionState({ status: RunStatus.RUNNING, deletedAt: '2026-08-01T00:00:00Z' }),
    ).toBe(SessionState.DELETED);
    expect(
      deriveSessionState({ status: RunStatus.CANCELLED, archivedAt: new Date() }),
    ).toBe(SessionState.COMPLETED);
    expect(
      deriveSessionState({ status: RunStatus.FAILED, archivedAt: new Date() }),
    ).toBe(SessionState.FAILED);
  });

  it.each([
    [RunStatus.PENDING, SessionState.QUEUED],
    [RunStatus.RUNNING, SessionState.RUNNING],
    [RunStatus.AWAITING_INPUT, SessionState.AWAITING_INPUT],
    [RunStatus.SUCCEEDED, SessionState.COMPLETED],
    [RunStatus.FAILED, SessionState.FAILED],
  ])('maps raw %s to %s', (status, expected) => {
    expect(deriveSessionState({ status })).toBe(expected);
  });

  it('derives overloaded cancelled/interrupted outcomes from endReason', () => {
    // 'idle' is a retired reason with no writer left; the frozen legacy mapping still decodes it.
    for (const endReason of ['idle', SessionEndReason.TASK_DONE, SessionEndReason.ENDED]) {
      expect(deriveSessionState({ status: 'CANCELLED', endReason })).toBe(SessionState.DORMANT);
    }
    expect(deriveSessionState({ status: 'CANCELLED' })).toBe(SessionState.DORMANT);
    expect(deriveSessionState({ status: 'CANCELLED', endReason: 'future_reason' })).toBe(
      SessionState.DORMANT,
    );
    expect(deriveSessionState({ status: 'CANCELLED', endReason: 'orphaned' })).toBe(
      SessionState.ENDED,
    );
    for (const endReason of ['completed', 'deleted', 'cancelled']) {
      expect(deriveSessionState({ status: 'CANCELLED', endReason })).toBe(SessionState.CANCELLED);
    }
    expect(deriveSessionState({ status: 'INTERRUPTED' })).toBe(SessionState.INTERRUPTED);
    expect(deriveSessionState({ status: 'INTERRUPTED', endReason: 'idle' })).toBe(
      SessionState.DORMANT,
    );
  });

  it('accepts the explicit runStatus string alias', () => {
    expect(deriveSessionState({ runStatus: 'running' })).toBe(SessionState.RUNNING);
  });
});

describe('orthogonal session states', () => {
  it('keeps a successful run successful across every filing state', () => {
    for (const filing of [
      {},
      { archivedAt: '2026-08-01T00:00:00Z' },
      { archivedAt: '2026-08-01T00:00:00Z', deletedAt: '2026-08-02T00:00:00Z' },
    ]) {
      expect(deriveSessionRunState({ status: RunStatus.SUCCEEDED, ...filing })).toBe(
        SessionRunState.SUCCEEDED,
      );
    }
  });

  it('derives filing state only from archive/trash timestamps', () => {
    expect(deriveSessionFilingState({})).toBe(SessionFilingState.OPEN);
    expect(deriveSessionFilingState({ archivedAt: new Date() })).toBe(SessionFilingState.ARCHIVED);
    expect(deriveSessionFilingState({ archivedAt: new Date(), deletedAt: new Date() })).toBe(
      SessionFilingState.TRASH,
    );
  });

  it('uses Completed as the canonical lifecycle while accepting archivedAt compatibility', () => {
    expect(deriveSessionLifecycleState({})).toBe(SessionLifecycleState.OPEN);
    expect(deriveSessionLifecycleState({ completedAt: new Date() })).toBe(
      SessionLifecycleState.COMPLETED,
    );
    expect(deriveSessionLifecycleState({ archivedAt: new Date() })).toBe(
      SessionLifecycleState.COMPLETED,
    );
    expect(deriveSessionLifecycleState({ completedAt: new Date(), deletedAt: new Date() })).toBe(
      SessionLifecycleState.TRASH,
    );
  });

  it('still separates a run that reported success from one that was merely ended', () => {
    expect(
      deriveSessionRunState({
        status: RunStatus.CANCELLED,
        endReason: SessionEndReason.TASK_CANCELLED,
      }),
    ).toBe(SessionRunState.ENDED);
    expect(
      deriveSessionRunState({ status: RunStatus.SUCCEEDED, endReason: SessionEndReason.TASK_DONE }),
    ).toBe(SessionRunState.SUCCEEDED);
  });

  it('collapses every deliberate end into one neutral terminal state', () => {
    // The reason a run ended says nothing about what the user can do next — resume
    // eligibility is decided by capabilities, which never reads endReason. Retired
    // 'idle'/'orphaned' rows land here too, which is why dropping their branches was safe.
    for (const endReason of [
      SessionEndReason.COMPLETED,
      SessionEndReason.ENDED,
      SessionEndReason.CANCELLED,
      SessionEndReason.DELETED,
      SessionEndReason.TASK_CANCELLED,
      'idle',
      'orphaned',
      'some_future_reason',
      undefined,
    ]) {
      expect(deriveSessionRunState({ status: RunStatus.CANCELLED, endReason })).toBe(
        SessionRunState.ENDED,
      );
    }
  });

  it('keeps a bare INTERRUPTED live — a stopped turn is not a stopped session', () => {
    expect(deriveSessionRunState({ status: RunStatus.INTERRUPTED })).toBe(
      SessionRunState.INTERRUPTED,
    );
    expect(
      deriveSessionRunState({ status: RunStatus.INTERRUPTED, endReason: SessionEndReason.ENDED }),
    ).toBe(SessionRunState.ENDED);
  });

  it('leaves the legacy SessionState vocabulary split for old clients', () => {
    // deriveSessionState is frozen wire compatibility: it must NOT follow the collapse.
    expect(
      deriveSessionState({ status: RunStatus.CANCELLED, endReason: SessionEndReason.CANCELLED }),
    ).toBe(SessionState.CANCELLED);
    expect(deriveSessionState({ status: RunStatus.CANCELLED, endReason: 'idle' })).toBe(
      SessionState.DORMANT,
    );
    expect(deriveSessionState({ status: RunStatus.CANCELLED, endReason: 'orphaned' })).toBe(
      SessionState.ENDED,
    );
  });
});

describe('gracefulEndStatus', () => {
  it('settles a user end / cancelled task at CANCELLED, never FAILED', () => {
    // The reported bug: a healthy session torn down gracefully came back as FAILED
    // because the runner never acknowledged the teardown. Returning a non-null status is
    // what prevents that — the reaper's forceFinalize defaults to FAILED — so these must
    // stay explicit rather than falling through to null.
    expect(gracefulEndStatus(SessionEndReason.ENDED)).toBe(RunStatus.CANCELLED);
    expect(gracefulEndStatus(SessionEndReason.TASK_CANCELLED)).toBe(RunStatus.CANCELLED);
  });

  it('settles a finished task at SUCCEEDED — a completed run must not read as cancelled', () => {
    expect(gracefulEndStatus(SessionEndReason.TASK_DONE)).toBe(RunStatus.SUCCEEDED);
  });

  it('settles a cancelled task at CANCELLED, never SUCCEEDED', () => {
    expect(gracefulEndStatus(SessionEndReason.TASK_CANCELLED)).toBe(RunStatus.CANCELLED);
  });

  it('returns null for a hard end or an unrecorded reason, so callers keep their own', () => {
    expect(gracefulEndStatus(SessionEndReason.COMPLETED)).toBeNull();
    expect(gracefulEndStatus(SessionEndReason.DELETED)).toBeNull();
    expect(gracefulEndStatus(SessionEndReason.CANCELLED)).toBeNull();
    expect(gracefulEndStatus(null)).toBeNull();
    expect(gracefulEndStatus(undefined)).toBeNull();
  });
});
