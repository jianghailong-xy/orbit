import { describe, expect, it } from 'vitest';
import {
  hasAuthoritativeSessionState,
  isSessionBusy,
  isSessionLive,
  isSessionTerminal,
  sessionEndedBanner,
  sessionHoldsRunnerSlot,
  sessionRunStatusOf,
  sessionStateOf,
} from './sessionState';

describe('sessionStateOf', () => {
  it('treats a valid sessionState as authoritative over contradictory legacy fields', () => {
    const completed = {
      sessionState: 'COMPLETED',
      runStatus: 'CANCELLED',
      status: 'FAILED',
      endReason: 'cancelled',
    };
    expect(hasAuthoritativeSessionState(completed)).toBe(true);
    expect(sessionStateOf(completed)).toBe('COMPLETED');

    expect(
      sessionStateOf({
        sessionState: 'CANCELLED',
        status: 'SUCCEEDED',
        archivedAt: '2026-08-01T00:00:00Z',
      }),
    ).toBe('CANCELLED');
  });

  it('prefers runStatus to the legacy status alias and normalizes legacy casing', () => {
    const session = { runStatus: 'running', status: 'FAILED' };
    expect(sessionRunStatusOf(session)).toBe('RUNNING');
    expect(sessionStateOf(session)).toBe('RUNNING');
  });

  it('matches the server derivation for ordinary legacy run statuses', () => {
    expect(sessionStateOf({ status: 'PENDING' })).toBe('QUEUED');
    expect(sessionStateOf({ status: 'RUNNING' })).toBe('RUNNING');
    expect(sessionStateOf({ status: 'AWAITING_INPUT' })).toBe('AWAITING_INPUT');
    expect(sessionStateOf({ status: 'SUCCEEDED' })).toBe('COMPLETED');
    expect(sessionStateOf({ status: 'FAILED' })).toBe('FAILED');
    expect(sessionStateOf({ status: 'future_state' })).toBe('ENDED');
  });

  it('keeps all overloaded cancelled/interrupted inference inside the legacy fallback', () => {
    for (const endReason of [undefined, 'idle', 'task_done', 'ended', 'future_reason']) {
      expect(sessionStateOf({ status: 'CANCELLED', endReason })).toBe('DORMANT');
    }
    expect(sessionStateOf({ status: 'CANCELLED', endReason: 'orphaned' })).toBe('ENDED');
    for (const endReason of ['completed', 'deleted', 'cancelled']) {
      expect(sessionStateOf({ status: 'CANCELLED', endReason })).toBe('CANCELLED');
    }
    expect(sessionStateOf({ status: 'INTERRUPTED' })).toBe('INTERRUPTED');
    expect(sessionStateOf({ status: 'INTERRUPTED', endReason: 'orphaned' })).toBe('ENDED');
    expect(sessionStateOf({ status: 'INTERRUPTED', endReason: 'idle' })).toBe('DORMANT');
  });

  it('retains filing-field compatibility for old detail/search/list payloads', () => {
    expect(sessionStateOf({ status: 'RUNNING', deletedAt: new Date() })).toBe('DELETED');
    expect(
      sessionStateOf({ status: 'CANCELLED', endReason: 'completed', archivedAt: new Date() }),
    ).toBe('COMPLETED');
    expect(sessionStateOf({ status: 'CANCELLED', endReason: 'completed' })).toBe('CANCELLED');
    expect(sessionStateOf({ status: 'FAILED', archivedAt: new Date() })).toBe('FAILED');
    expect(sessionStateOf({ status: 'CANCELLED' }, { legacyCompleted: true })).toBe('COMPLETED');
    expect(
      sessionStateOf(
        { sessionState: 'FAILED', status: 'CANCELLED' },
        { legacyCompleted: true },
      ),
    ).toBe('FAILED');
  });
});

describe('session state predicates', () => {
  it('uses product state for liveness and task busy state', () => {
    expect(isSessionLive({ sessionState: 'INTERRUPTED', status: 'INTERRUPTED' })).toBe(true);
    expect(isSessionLive({ sessionState: 'DORMANT', status: 'CANCELLED' })).toBe(false);
    expect(isSessionTerminal({ sessionState: 'COMPLETED', status: 'CANCELLED' })).toBe(true);
    expect(isSessionBusy({ sessionState: 'QUEUED', status: 'PENDING' })).toBe(true);
    expect(isSessionBusy({ sessionState: 'RUNNING', status: 'CANCELLED' })).toBe(true);
    expect(isSessionBusy({ sessionState: 'AWAITING_INPUT', status: 'RUNNING' })).toBe(false);
  });

  it('uses raw runStatus for runner slot accounting', () => {
    expect(
      sessionHoldsRunnerSlot({
        sessionState: 'COMPLETED',
        runStatus: 'RUNNING',
        status: 'CANCELLED',
      }),
    ).toBe(true);
    expect(
      sessionHoldsRunnerSlot({
        sessionState: 'RUNNING',
        runStatus: 'CANCELLED',
        status: 'RUNNING',
      }),
    ).toBe(false);
  });
});

describe('sessionEndedBanner', () => {
  it('takes the outcome from sessionState, not an overloaded cancelled run', () => {
    expect(
      sessionEndedBanner(
        { sessionState: 'COMPLETED', runStatus: 'CANCELLED', endReason: 'cancelled' },
        true,
        true,
      ),
    ).toBe('Session completed. Send a message to resume this session.');
    expect(
      sessionEndedBanner(
        { sessionState: 'CANCELLED', runStatus: 'CANCELLED', endReason: 'completed' },
        false,
        true,
      ),
    ).toBe('Session cancelled. Sending a message starts a new session.');
  });

  it('uses the reason only to enrich dormant/ended copy', () => {
    expect(
      sessionEndedBanner({ sessionState: 'DORMANT', endReason: 'idle' }, false, false),
    ).toBe(
      'Session ended automatically after a long idle period. Runner offline — bring it online to resume.',
    );
    expect(
      sessionEndedBanner({ sessionState: 'ENDED', endReason: 'orphaned' }, false, true),
    ).toBe('Session ended (the linked task is done). Sending a message starts a new session.');
  });
});
