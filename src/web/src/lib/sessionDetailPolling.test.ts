import { describe, expect, it } from 'vitest';
import { shouldPollSessionDetail } from './sessionDetailPolling';

describe('shouldPollSessionDetail', () => {
  it('polls a current live detail even when the session is absent from the list', () => {
    expect(
      shouldPollSessionDetail('session-1', { id: 'session-1', runState: 'RUNNING' }, null),
    ).toBe(true);
  });

  it('ignores keepPreviousData from another session', () => {
    expect(
      shouldPollSessionDetail('session-1', { id: 'session-2', runState: 'RUNNING' }, null),
    ).toBe(false);
  });

  it('uses the current detail before a stale live list row', () => {
    expect(
      shouldPollSessionDetail(
        'session-1',
        { id: 'session-1', runState: 'SUCCEEDED' },
        { id: 'session-1', runState: 'RUNNING' },
      ),
    ).toBe(false);
  });

  it('falls back to the list row while current detail is unavailable', () => {
    expect(
      shouldPollSessionDetail(
        'session-1',
        { id: 'session-2', runState: 'SUCCEEDED' },
        { id: 'session-1', runState: 'AWAITING_INPUT' },
      ),
    ).toBe(true);
  });
});
