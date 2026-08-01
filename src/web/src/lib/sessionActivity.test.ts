import { describe, expect, it } from 'vitest';
import { hasOutlivingSessionWork, isSessionTurnActive } from './sessionActivity';

describe('session activity', () => {
  it('keeps a parked parent active while a sub-agent is still running', () => {
    const session = { runningSubagentCount: 1, runningBgCount: 0 };

    expect(hasOutlivingSessionWork(session)).toBe(true);
    expect(isSessionTurnActive(session, true, true)).toBe(true);
  });

  it('keeps a parked parent active while a background shell is still running', () => {
    expect(isSessionTurnActive({ runningBgCount: 2 }, true, true)).toBe(true);
  });

  it('uses the parent turn boundary when no work outlives it', () => {
    expect(isSessionTurnActive({}, true, false)).toBe(true);
    expect(isSessionTurnActive({}, true, true)).toBe(false);
  });

  it('never treats a terminal session as an active turn', () => {
    expect(isSessionTurnActive({ runningSubagentCount: 1 }, false, false)).toBe(false);
  });
});
