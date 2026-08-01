import { describe, expect, it } from 'vitest';
import {
  hasAuthoritativeLifecycleState,
  hasAuthoritativeRunState,
  isSessionBusy,
  isSessionLive,
  isSessionTerminal,
  sessionEndedBanner,
  sessionLifecycleLabel,
  sessionLifecycleStateOf,
  sessionHoldsRunnerSlot,
  sessionRunStateOf,
  sessionRunStatusOf,
  sessionStateOf,
} from './sessionState';

describe('sessionRunStateOf', () => {
  it('treats runState as authoritative without letting lifecycle membership change the outcome', () => {
    const session = {
      runState: 'SUCCEEDED',
      lifecycleState: 'OPEN',
      sessionState: 'FAILED',
      runStatus: 'CANCELLED',
      completedAt: '2026-08-01T00:00:00Z',
    };

    expect(hasAuthoritativeRunState(session)).toBe(true);
    expect(sessionRunStateOf(session)).toBe('SUCCEEDED');
    expect(sessionLifecycleStateOf(session)).toBe('OPEN');
  });

  it('uses the legacy mixed sessionState only when both runState and raw status are absent', () => {
    expect(
      sessionRunStateOf({ sessionState: 'COMPLETED' }),
    ).toBe('SUCCEEDED');
    expect(
      sessionRunStateOf({
        sessionState: 'COMPLETED',
        runStatus: 'CANCELLED',
        endReason: 'completed',
      }),
    ).toBe('CANCELLED');
    expect(
      sessionRunStateOf({
        runState: 'CANCELLED',
        sessionState: 'COMPLETED',
        runStatus: 'SUCCEEDED',
      }),
    ).toBe('CANCELLED');
    expect(sessionStateOf({ runState: 'SUCCEEDED' })).toBe('COMPLETED');
  });

  it('prefers runStatus to the legacy status alias and normalizes casing', () => {
    const session = { runStatus: 'running', status: 'FAILED' };
    expect(sessionRunStatusOf(session)).toBe('RUNNING');
    expect(sessionRunStateOf(session)).toBe('RUNNING');
  });

  it('derives ordinary legacy runner statuses without consulting lifecycle timestamps', () => {
    expect(sessionRunStateOf({ status: 'PENDING' })).toBe('QUEUED');
    expect(sessionRunStateOf({ status: 'RUNNING' })).toBe('RUNNING');
    expect(sessionRunStateOf({ status: 'AWAITING_INPUT' })).toBe('AWAITING_INPUT');
    expect(sessionRunStateOf({ status: 'SUCCEEDED', completedAt: null })).toBe('SUCCEEDED');
    expect(sessionRunStateOf({ status: 'FAILED', completedAt: new Date() })).toBe('FAILED');
    expect(sessionRunStateOf({ status: 'future_state' })).toBe('ENDED');
  });

  it('keeps overloaded cancelled/interrupted inference inside the legacy fallback', () => {
    for (const endReason of [undefined, 'idle', 'task_done', 'ended', 'future_reason']) {
      expect(sessionRunStateOf({ status: 'CANCELLED', endReason })).toBe('DORMANT');
    }
    expect(sessionRunStateOf({ status: 'CANCELLED', endReason: 'orphaned' })).toBe('ENDED');
    for (const endReason of ['completed', 'deleted', 'cancelled', 'task_cancelled']) {
      expect(sessionRunStateOf({ status: 'CANCELLED', endReason })).toBe('CANCELLED');
    }
    expect(sessionRunStateOf({ status: 'INTERRUPTED' })).toBe('INTERRUPTED');
    expect(sessionRunStateOf({ status: 'INTERRUPTED', endReason: 'idle' })).toBe('DORMANT');
  });
});

describe('sessionLifecycleStateOf', () => {
  it('prefers lifecycleState and falls back to canonical timestamps or list view', () => {
    const authoritative = {
      lifecycleState: 'OPEN',
      completedAt: '2026-08-01T00:00:00Z',
      deletedAt: '2026-08-02T00:00:00Z',
    };
    expect(hasAuthoritativeLifecycleState(authoritative)).toBe(true);
    expect(sessionLifecycleStateOf(authoritative)).toBe('OPEN');
    expect(sessionLifecycleStateOf({ deletedAt: new Date() })).toBe('TRASH');
    expect(sessionLifecycleStateOf({ completedAt: new Date() })).toBe('COMPLETED');
    expect(sessionLifecycleStateOf({}, { listView: 'completed' })).toBe('COMPLETED');
    expect(sessionLifecycleStateOf({}, { listView: 'trash' })).toBe('TRASH');
    expect(sessionLifecycleStateOf({})).toBe('OPEN');
  });

  it('normalizes legacy Archive payloads only at the compatibility boundary', () => {
    expect(
      sessionLifecycleStateOf({ lifecycleState: 'COMPLETED', filingState: 'ARCHIVED' }),
    ).toBe('COMPLETED');
    expect(sessionLifecycleStateOf({ filingState: 'ARCHIVED' })).toBe('COMPLETED');
    expect(sessionLifecycleStateOf({ archivedAt: new Date() })).toBe('COMPLETED');
    expect(sessionLifecycleStateOf({}, { legacyView: 'archived' })).toBe('COMPLETED');
    expect(hasAuthoritativeLifecycleState({ filingState: 'ARCHIVED' })).toBe(true);
  });

  it('labels lifecycle locations independently from the run outcome', () => {
    expect(sessionLifecycleLabel('OPEN')).toBe('Open');
    expect(sessionLifecycleLabel('COMPLETED')).toBe('Completed');
    expect(sessionLifecycleLabel('TRASH')).toBe('Trash');
    expect(
      [
        sessionRunStateOf({ runState: 'FAILED', lifecycleState: 'COMPLETED' }),
        sessionLifecycleStateOf({ runState: 'FAILED', lifecycleState: 'COMPLETED' }),
      ],
    ).toEqual(['FAILED', 'COMPLETED']);
  });
});

describe('session state predicates', () => {
  it('uses runState for liveness and busy state', () => {
    expect(isSessionLive({ runState: 'INTERRUPTED', lifecycleState: 'COMPLETED' })).toBe(true);
    expect(isSessionLive({ runState: 'DORMANT', lifecycleState: 'OPEN' })).toBe(false);
    expect(isSessionTerminal({ runState: 'SUCCEEDED', lifecycleState: 'OPEN' })).toBe(true);
    expect(isSessionBusy({ runState: 'QUEUED', status: 'CANCELLED' })).toBe(true);
    expect(isSessionBusy({ runState: 'RUNNING', status: 'CANCELLED' })).toBe(true);
    expect(isSessionBusy({ runState: 'AWAITING_INPUT', status: 'RUNNING' })).toBe(false);
  });

  it('uses raw runStatus for runner slot accounting', () => {
    expect(
      sessionHoldsRunnerSlot({ runState: 'SUCCEEDED', runStatus: 'RUNNING' }),
    ).toBe(true);
    expect(
      sessionHoldsRunnerSlot({ runState: 'RUNNING', runStatus: 'CANCELLED' }),
    ).toBe(false);
    expect(sessionHoldsRunnerSlot({ status: 'running' })).toBe(true);
  });
});

describe('sessionEndedBanner', () => {
  it('uses the run outcome while separately explaining a Completed resume', () => {
    expect(
      sessionEndedBanner(
        { runState: 'SUCCEEDED', lifecycleState: 'COMPLETED' },
        true,
        true,
      ),
    ).toBe('Session succeeded. Sending a message will resume this session in Open.');
    expect(
      sessionEndedBanner(
        { runState: 'CANCELLED', lifecycleState: 'OPEN', endReason: 'task_cancelled' },
        false,
        true,
      ),
    ).toBe('Session cancelled. Sending a message starts a new session.');
  });

  it('uses the reason only to enrich dormant/ended copy', () => {
    expect(
      sessionEndedBanner({ runState: 'DORMANT', endReason: 'idle' }, false, false),
    ).toBe(
      'Session ended automatically after a long idle period. Runner offline — bring it online to resume.',
    );
    expect(
      sessionEndedBanner({ runState: 'ENDED', endReason: 'orphaned' }, false, true),
    ).toBe('Session ended (the linked task is done). Sending a message starts a new session.');
  });

  it('includes a server-provided resume blocker before explaining the fresh-session fallback', () => {
    expect(
      sessionEndedBanner(
        { runState: 'SUCCEEDED', lifecycleState: 'OPEN' },
        false,
        true,
        'The previous session context is no longer available.',
      ),
    ).toBe(
      'Session succeeded. The previous session context is no longer available. Sending a message starts a new session.',
    );
  });
});
