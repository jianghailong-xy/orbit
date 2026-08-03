import { describe, expect, it } from 'vitest';
import { hasOutlivingSessionWork, isSessionTurnActive } from './sessionActivity';

describe('session activity', () => {
  it('keeps a parked parent active while a sub-agent is still running', () => {
    const session = { runningSubagentCount: 1, runningBgCount: 0 };

    expect(hasOutlivingSessionWork(session)).toBe(true);
    expect(isSessionTurnActive(session, true, true)).toBe(true);
  });

  it('surfaces a background shell as outliving work without freezing the worktree', () => {
    const session = { runningSubagentCount: 0, runningBgCount: 2 };

    // Still "working" for the status line — but a left-up dev server never exits, so it must not
    // hold the worktree gate (and Commit) closed for the rest of the session's life.
    expect(hasOutlivingSessionWork(session)).toBe(true);
    expect(isSessionTurnActive(session, true, true)).toBe(false);
  });

  it('uses the parent turn boundary when no work outlives it', () => {
    expect(isSessionTurnActive({}, true, false)).toBe(true);
    expect(isSessionTurnActive({}, true, true)).toBe(false);
  });

  it('never treats a terminal session as an active turn', () => {
    expect(isSessionTurnActive({ runningSubagentCount: 1 }, false, false)).toBe(false);
  });
});
