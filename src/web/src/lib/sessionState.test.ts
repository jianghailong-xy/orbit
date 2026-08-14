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
  sessionRetryPending,
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
    ).toBe('ENDED');
    expect(
      sessionRunStateOf({
        runState: 'ENDED',
        sessionState: 'COMPLETED',
        runStatus: 'SUCCEEDED',
      }),
    ).toBe('ENDED');
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

  it('collapses every ended run into one neutral terminal state', () => {
    for (const endReason of [
      undefined,
      'completed',
      'ended',
      'cancelled',
      'deleted',
      'task_cancelled',
      'task_done',
      // Retired PARKED-era reasons: no writer left, but stored rows still decode here.
      'idle',
      'orphaned',
      'future_reason',
    ]) {
      expect(sessionRunStateOf({ status: 'CANCELLED', endReason })).toBe('ENDED');
    }
  });

  it('keeps a bare INTERRUPTED live — a stopped turn is not a stopped session', () => {
    expect(sessionRunStateOf({ status: 'INTERRUPTED' })).toBe('INTERRUPTED');
    expect(sessionRunStateOf({ status: 'INTERRUPTED', endReason: 'ended' })).toBe('ENDED');
  });

  it('maps the legacy sessionState vocabulary onto the collapsed run states', () => {
    // Old payloads with no raw status still split CANCELLED/DORMANT; both mean "ended".
    expect(sessionRunStateOf({ sessionState: 'CANCELLED' })).toBe('ENDED');
    expect(sessionRunStateOf({ sessionState: 'DORMANT' })).toBe('ENDED');
    expect(sessionRunStateOf({ sessionState: 'COMPLETED' })).toBe('SUCCEEDED');
    expect(sessionRunStateOf({ sessionState: 'INTERRUPTED' })).toBe('INTERRUPTED');
  });

  it('ignores a runState an older client would not recognise, not the reverse', () => {
    // Forward compatibility both ways: an unknown value falls back to the raw pair.
    expect(sessionRunStateOf({ runState: 'DORMANT', status: 'CANCELLED', endReason: 'ended' })).toBe(
      'ENDED',
    );
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
    expect(isSessionLive({ runState: 'ENDED', lifecycleState: 'OPEN' })).toBe(false);
    expect(isSessionTerminal({ runState: 'SUCCEEDED', lifecycleState: 'OPEN' })).toBe(true);
    expect(isSessionBusy({ runState: 'QUEUED', status: 'CANCELLED' })).toBe(true);
    expect(isSessionBusy({ runState: 'RUNNING', status: 'CANCELLED' })).toBe(true);
    expect(isSessionBusy({ runState: 'AWAITING_INPUT', status: 'RUNNING' })).toBe(false);
  });

  // The console releases its in-flight turn state on this split, so that a run which reached a
  // terminal status without ever completing a turn doesn't leave the composer queueing behind a
  // turn that will never end. QUEUED is the carve-out: nothing is running yet, but the next
  // message still has to queue behind the turn it is waiting for.
  it('counts only settled runs as terminal, keeping QUEUED and INTERRUPTED live', () => {
    for (const runState of ['FAILED', 'SUCCEEDED', 'ENDED']) {
      expect([runState, isSessionTerminal({ runState })]).toEqual([runState, true]);
    }
    for (const runState of ['QUEUED', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']) {
      expect([runState, isSessionTerminal({ runState })]).toEqual([runState, false]);
    }
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

describe('sessionRetryPending', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  it('holds a FAILED run open while the server still means to re-send it', () => {
    expect(sessionRetryPending({ runState: 'FAILED', retryAt: at(30_000) }, now)).toBe(true);
    // Armed for right now — what the reaper does for a runner that vanished mid-turn. The sweep
    // that fires it is seconds away, so this is the middle of a retry, not the end of one.
    expect(sessionRetryPending({ runState: 'FAILED', retryAt: at(0) }, now)).toBe(true);
    expect(sessionRetryPending({ runState: 'FAILED', retryAt: at(-30_000) }, now)).toBe(true);
  });

  it('falls back to the failure when nothing is armed, or nothing came for it', () => {
    expect(sessionRetryPending({ runState: 'FAILED', retryAt: null }, now)).toBe(false);
    expect(sessionRetryPending({ runState: 'FAILED' }, now)).toBe(false);
    expect(sessionRetryPending({ runState: 'FAILED', retryAt: 'not a date' }, now)).toBe(false);
    // Long past due with the row untouched: the single-replica sweeper never came, and saying
    // "Retrying" forever would be a worse lie than the one this rule exists to fix.
    expect(sessionRetryPending({ runState: 'FAILED', retryAt: at(-10 * 60_000) }, now)).toBe(false);
  });

  it('leaves every other run state alone', () => {
    // The quota case can park here instead. Nothing claims that session is over, and a window
    // that resets in four hours would read absurdly as "Retrying".
    expect(sessionRetryPending({ runState: 'AWAITING_INPUT', retryAt: at(4 * 3600_000) }, now)).toBe(
      false,
    );
    expect(sessionRetryPending({ runState: 'RUNNING', retryAt: at(30_000) }, now)).toBe(false);
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
        { runState: 'ENDED', lifecycleState: 'OPEN', endReason: 'task_cancelled' },
        false,
        true,
      ),
    ).toBe('Session cancelled. Sending a message starts a new session.');
  });

  it('calls a filed session completed rather than cancelled', () => {
    expect(
      sessionEndedBanner(
        { runState: 'ENDED', lifecycleState: 'COMPLETED', endReason: 'completed' },
        true,
        true,
      ),
    ).toBe('Session completed. Sending a message will resume this session in Open.');
  });

  it('keeps the end reason as prose after the glyph stopped distinguishing it', () => {
    // The whole point of the collapse: one neutral state, but copy may still explain why.
    expect(
      sessionEndedBanner({ runState: 'ENDED', endReason: 'idle' }, false, false),
    ).toBe(
      'Session ended automatically after a long idle period. Runner offline — bring it online to resume.',
    );
    expect(
      sessionEndedBanner({ runState: 'ENDED', endReason: 'orphaned' }, false, true),
    ).toBe('The linked task is done, so the session ended. Sending a message starts a new session.');
    expect(
      sessionEndedBanner({ runState: 'ENDED', endReason: 'future_reason' }, false, true),
    ).toBe('Session ended. Sending a message starts a new session.');
  });

  it('does not call a session failed while the server is about to re-send it', () => {
    const armed = new Date(Date.now() + 30_000).toISOString();
    expect(
      sessionEndedBanner({ runState: 'FAILED', error: 'API Error: 529', retryAt: armed }, true, true),
    ).toBe('Retrying automatically. Send a message to resume this session.');
    // Once the retries are spent the server clears retryAt, and the failure is the outcome.
    expect(
      sessionEndedBanner({ runState: 'FAILED', error: 'API Error: 529', retryAt: null }, true, true),
    ).toBe('Session failed. Send a message to resume this session.');
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
