import { describe, expect, it } from 'vitest';
import { isSessionTurnActive, outlivingSessionWork } from './sessionActivity';

describe('session activity', () => {
  it('keeps a parked parent active while a sub-workspace is still running', () => {
    const session = { runningSubagentCount: 1, runningBgCount: 0 };

    expect(outlivingSessionWork(session)).toBe('subagent');
    expect(isSessionTurnActive(session, true, true)).toBe(true);
  });

  it('surfaces a background shell as outliving work without freezing the worktree', () => {
    const session = { runningSubagentCount: 0, runningBgCount: 2 };

    // Still not idle for the status line — but a left-up dev server never exits, so it neither
    // holds the worktree gate (and Commit) closed for the rest of the session's life nor reads
    // as the workspace working.
    expect(outlivingSessionWork(session)).toBe('background');
    expect(isSessionTurnActive(session, true, true)).toBe(false);
  });

  it('lets a sub-workspace outrank a background shell when both are live', () => {
    expect(outlivingSessionWork({ runningSubagentCount: 1, runningBgCount: 2 })).toBe('subagent');
  });

  it('reports an idle session as having no outliving work', () => {
    expect(outlivingSessionWork({ runningSubagentCount: 0, runningBgCount: 0 })).toBe(null);
    expect(outlivingSessionWork({})).toBe(null);
    expect(outlivingSessionWork(null)).toBe(null);
  });

  it('uses the parent turn boundary when no work outlives it', () => {
    expect(isSessionTurnActive({}, true, false)).toBe(true);
    expect(isSessionTurnActive({}, true, true)).toBe(false);
  });

  it('never treats a terminal session as an active turn', () => {
    expect(isSessionTurnActive({ runningSubagentCount: 1 }, false, false)).toBe(false);
  });
});
