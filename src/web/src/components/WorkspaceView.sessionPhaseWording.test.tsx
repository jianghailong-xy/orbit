import { describe, expect, it } from 'vitest';
import { olderServer, SITUATIONS } from '../lib/sessionPhaseFields.fixture';
import { sessionEndedBanner, sessionStateWord } from '../lib/sessionState';
import { statusGlyphMotion, statusLabel } from './WorkspaceView';

/**
 * Plan step 5.2: the state wording the console reads from the new session fields (contracts/session-state.contract.json),
 * as the owner approved it on the board docs/mocks/session-three-state-web (commit 9cd5506813; "Approve as shown",
 * 2026-11-22), and the same payload from an older server, which keeps today's words (decision D2's "Finished" aside).
 */
describe('state wording, with the new fields and without them', () => {
  // [situation, the header and row word with the new fields, the same from an older server]
  const cases: [string, string, string][] = [
    ['held idle', 'Waiting for your reply', 'Waiting for your reply'],
    ['released by a failed turn', 'Failed', 'Failed'],
    ['released by End', 'Ended', 'Ended'],
    // D2: a session never "succeeds"; a task's run that finished its work is Finished, whichever server says so.
    ['a task run that finished', 'Finished', 'Finished'],
    ['waiting on an approval', 'Waiting for approval', 'Waiting for approval'],
    // Held by the dispatch pause or a hold notice, which no runner gate names: only the new field can say it.
    ['on hold', 'On hold', 'Queued'],
    ['will wake', 'Waiting to resume', 'Waiting to resume'],
    // An end was asked for; the runner's silence is not a failure of the conversation (design §12).
    ['ended, runner never confirmed', 'Ended', 'Failed'],
    // D2: a plain conversation is Ended or Failed. An older server cannot tell it from a task's finished run.
    ['old plain row stored SUCCEEDED', 'Ended', 'Finished'],
    // Still held until the runner lets go; the older reading said Ended at once.
    ['ending after an interrupted turn', 'Interrupted', 'Ended'],
  ];
  for (const [name, withFields, without] of cases) {
    it(`${name}: "${withFields}" with the new fields, "${without}" without them`, () => {
      expect(statusLabel(SITUATIONS[name])).toBe(withFields);
      expect(statusLabel(olderServer(SITUATIONS[name]))).toBe(without);
    });
  }

  it('running a job with no turn keeps its background line and breathing glyph, never the working spinner', () => {
    const s = SITUATIONS['running a job with no turn'];
    expect(statusLabel(s)).toBe(statusLabel(olderServer(s)));
    expect(statusLabel(s)).not.toBe('Running');
    expect(statusLabel(s)).toBe('Background process running');
    expect(statusGlyphMotion(s)).toBe('pulse');
    expect(statusGlyphMotion(olderServer(s))).toBe('pulse');
  });

  it('a task run that finished says so above the composer, with or without the new fields', () => {
    const line = 'The linked task is done, so the session finished. Send a message to resume this session.';
    expect(sessionEndedBanner(SITUATIONS['a task run that finished'], true, true)).toBe(line);
    expect(sessionEndedBanner(olderServer(SITUATIONS['a task run that finished']), true, true)).toBe(line);
  });

  it('the end the runner never confirmed is an end above the composer, an older server still a failure', () => {
    const s = SITUATIONS['ended, runner never confirmed'];
    expect(sessionEndedBanner(s, true, true)).toBe('Session ended. Send a message to resume this session.');
    expect(sessionEndedBanner(olderServer(s), true, true)).toBe('Session failed. Send a message to resume this session.');
  });

  it('a shared session reads Finished for a task run that finished, never Succeeded', () => {
    expect(sessionStateWord(SITUATIONS['a task run that finished'])).toBe('Finished');
    expect(sessionStateWord(olderServer(SITUATIONS['a task run that finished']))).toBe('Finished');
  });
});
