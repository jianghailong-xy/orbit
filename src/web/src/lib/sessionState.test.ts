import { describe, expect, it } from 'vitest';
import {
  hasAuthoritativeFilingState,
  hasAuthoritativeRunState,
  isSessionBusy,
  isSessionLive,
  isSessionTerminal,
  sessionEndedBanner,
  sessionFilingLabel,
  sessionFilingStateOf,
  sessionHoldsRunnerSlot,
  sessionRunStateOf,
  sessionRunStatusOf,
  sessionStateOf,
} from './sessionState';

describe('sessionRunStateOf', () => {
  it('treats runState as authoritative without letting filing change the outcome', () => {
    const session = {
      runState: 'SUCCEEDED',
      filingState: 'OPEN',
      sessionState: 'FAILED',
      runStatus: 'CANCELLED',
      archivedAt: '2026-08-01T00:00:00Z',
    };

    expect(hasAuthoritativeRunState(session)).toBe(true);
    expect(sessionRunStateOf(session)).toBe('SUCCEEDED');
    expect(sessionFilingStateOf(session)).toBe('OPEN');
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

  it('derives ordinary legacy runner statuses without consulting filing timestamps', () => {
    expect(sessionRunStateOf({ status: 'PENDING' })).toBe('QUEUED');
    expect(sessionRunStateOf({ status: 'RUNNING' })).toBe('RUNNING');
    expect(sessionRunStateOf({ status: 'AWAITING_INPUT' })).toBe('AWAITING_INPUT');
    expect(sessionRunStateOf({ status: 'SUCCEEDED', archivedAt: null })).toBe('SUCCEEDED');
    expect(sessionRunStateOf({ status: 'FAILED', archivedAt: new Date() })).toBe('FAILED');
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

describe('sessionFilingStateOf', () => {
  it('prefers filingState and falls back to timestamps or the legacy list view', () => {
    const authoritative = {
      filingState: 'OPEN',
      archivedAt: '2026-08-01T00:00:00Z',
      deletedAt: '2026-08-02T00:00:00Z',
    };
    expect(hasAuthoritativeFilingState(authoritative)).toBe(true);
    expect(sessionFilingStateOf(authoritative)).toBe('OPEN');
    expect(sessionFilingStateOf({ deletedAt: new Date() })).toBe('TRASH');
    expect(sessionFilingStateOf({ archivedAt: new Date() })).toBe('ARCHIVED');
    expect(sessionFilingStateOf({}, { legacyView: 'archived' })).toBe('ARCHIVED');
    expect(sessionFilingStateOf({}, { legacyView: 'deleted' })).toBe('TRASH');
    expect(sessionFilingStateOf({})).toBe('OPEN');
  });

  it('labels locations independently from the run outcome', () => {
    expect(sessionFilingLabel('OPEN')).toBe('Open');
    expect(sessionFilingLabel('ARCHIVED')).toBe('Completed');
    expect(sessionFilingLabel('TRASH')).toBe('Trash');
    expect(
      [
        sessionRunStateOf({ runState: 'FAILED', filingState: 'ARCHIVED' }),
        sessionFilingStateOf({ runState: 'FAILED', filingState: 'ARCHIVED' }),
      ],
    ).toEqual(['FAILED', 'ARCHIVED']);
  });
});

describe('session state predicates', () => {
  it('uses runState for liveness and busy state', () => {
    expect(isSessionLive({ runState: 'INTERRUPTED', filingState: 'ARCHIVED' })).toBe(true);
    expect(isSessionLive({ runState: 'DORMANT', filingState: 'OPEN' })).toBe(false);
    expect(isSessionTerminal({ runState: 'SUCCEEDED', filingState: 'OPEN' })).toBe(true);
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
        { runState: 'SUCCEEDED', filingState: 'ARCHIVED' },
        true,
        true,
      ),
    ).toBe('Session succeeded. Sending a message will resume this session in Open.');
    expect(
      sessionEndedBanner(
        { runState: 'CANCELLED', filingState: 'OPEN', endReason: 'task_cancelled' },
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
        { runState: 'SUCCEEDED', filingState: 'OPEN' },
        false,
        true,
        'The previous session context is no longer available.',
      ),
    ).toBe(
      'Session succeeded. The previous session context is no longer available. Sending a message starts a new session.',
    );
  });
});
