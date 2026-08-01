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
    for (const endReason of [SessionEndReason.IDLE, SessionEndReason.TASK_DONE, SessionEndReason.ENDED]) {
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

  it('distinguishes a cancelled task from a completed task', () => {
    expect(
      deriveSessionRunState({
        status: RunStatus.CANCELLED,
        endReason: SessionEndReason.TASK_CANCELLED,
      }),
    ).toBe(SessionRunState.CANCELLED);
    expect(
      deriveSessionRunState({ status: RunStatus.SUCCEEDED, endReason: SessionEndReason.TASK_DONE }),
    ).toBe(SessionRunState.SUCCEEDED);
  });
});

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
