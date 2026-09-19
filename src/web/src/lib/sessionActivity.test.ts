import { describe, expect, it } from 'vitest';
import {
  backgroundWorkIsActive,
  isSessionTurnActive,
  outlivingSessionWork,
} from './sessionActivity';

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

describe('background work that is a job rather than a process left up', () => {
  it('is active only for the shells the server counted as jobs', () => {
    // Two processes up, one of them a job: the row breathes.
    expect(backgroundWorkIsActive({ runningBgCount: 2, runningBgJobCount: 1 })).toBe(true);
    // The same two processes, none of them a job — a dev server and a watcher. This is the case the
    // static glyph exists for, and the one that must not animate however long it lasts.
    expect(backgroundWorkIsActive({ runningBgCount: 2, runningBgJobCount: 0 })).toBe(false);
  });

  it('keeps the static reading against a control plane that predates the count', () => {
    expect(backgroundWorkIsActive({ runningBgCount: 3 })).toBe(false);
    expect(backgroundWorkIsActive({})).toBe(false);
    expect(backgroundWorkIsActive(null)).toBe(false);
  });
});
