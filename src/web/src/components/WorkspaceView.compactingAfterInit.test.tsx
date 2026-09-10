import { describe, expect, it } from 'vitest';
import { waitingNoticeFor } from '../lib/runnerSlots';
import { sessionLine, statusLabel } from './WorkspaceView';

/**
 * The compaction the notices were blind to. Claude Code sends a per-turn `init` 0.1–0.4s after each
 * message and `init` stamps engineStartedAt, and both pre-turn automatic compactions found on
 * production (sessions 01a07229… and 7c7db692…) began after it. So the session was RUNNING and past
 * starting, with engine_phase already 'compacting', while its row said "You: <message>" and its
 * transcript said nothing — for minutes.
 */
const afterInit = {
  status: 'RUNNING',
  engineStartedAt: '2026-09-10T12:00:00.000Z',
  enginePhase: 'compacting',
  enginePhaseSince: '2026-09-10T12:00:03.400Z',
  lastUserText: 'carry on',
};

describe('a compaction that begins after the per-turn init', () => {
  it('reads as compacting in the session list', () => {
    expect(sessionLine(afterInit, true)).toEqual({ text: 'Compacting…', tone: 'running' });
    expect(statusLabel(afterInit)).toBe('Compacting');
  });

  it('gets the compacting notice, counted from when the compaction began', () => {
    expect(waitingNoticeFor(afterInit)).toEqual({
      kind: 'compacting',
      since: '2026-09-10T12:00:03.400Z',
    });
  });

  // Paired with the two above: the rule is the phase, not "RUNNING after init". With no phase the row
  // is the ordinary running line and there is no notice at all.
  it('is the ordinary running row, with no notice, once the phase is gone', () => {
    const noPhase = { ...afterInit, enginePhase: null, enginePhaseSince: null };
    expect(sessionLine(noPhase, true)).toEqual({ text: 'You: carry on', tone: 'preview' });
    expect(waitingNoticeFor(noPhase)).toBeNull();
  });

  // A runner newer than this client may name a phase it has never heard of; printing that word is
  // worse than the ordinary line.
  it('does not treat a phase it cannot explain as a wait', () => {
    const unknown = { ...afterInit, enginePhase: 'reticulating' };
    expect(sessionLine(unknown, true)).toEqual({ text: 'You: carry on', tone: 'preview' });
    expect(waitingNoticeFor(unknown)).toBeNull();
  });
});
