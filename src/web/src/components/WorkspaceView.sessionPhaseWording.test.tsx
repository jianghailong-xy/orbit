import { describe, expect, it } from 'vitest';
import { olderServer, SITUATIONS } from '../lib/sessionPhaseFields.fixture';
import { sessionEndedBanner, sessionStateWord } from '../lib/sessionState';
import { SESSION_MARKS, sessionMarks } from '../lib/sessionDisplay';
import { statusGlyphMotion, statusLabel } from './WorkspaceView';

/**
 * The state wording the console reads from the session fields (contracts/session-state.contract.json). With the facts,
 * the approved board docs/mocks/session-display-three-states (owner approval 2026-11-25, which replaced plan step 5.2's
 * seven words): the word is `phase` alone and every other fact is a mark beside it (lib/sessionDisplay). The same
 * payload from an older server keeps today's words.
 */
describe('state wording, with the new fields and without them', () => {
  // [situation, the header and row word with the new fields, its marks, the word from an older server]
  const cases: [string, string, string[], string][] = [
    ['held idle', 'Idle', [], 'Waiting for your reply'],
    ['released by a failed turn', 'Idle', ['Failed'], 'Failed'],
    ['released by End', 'Idle', ['Ended'], 'Ended'],
    // D2: a session never "succeeds"; a task's run that finished its work wears Finished, whichever server says so.
    ['a task run that finished', 'Idle', ['Finished'], 'Finished'],
    ['waiting on an approval', 'Running', ['Needs you'], 'Waiting for approval'],
    // Held by the dispatch pause or a hold notice, which no runner gate names: only the new field can say it.
    ['on hold', 'Queued', ['On hold'], 'Queued'],
    ['will wake', 'Idle', ['Will resume'], 'Waiting to resume'],
    // An end was asked for; the runner's silence is not a failure of the conversation (design §12).
    ['ended, runner never confirmed', 'Idle', ['Ended'], 'Failed'],
    // D2: a plain conversation is Ended or Failed. An older server cannot tell it from a task's finished run.
    ['old plain row stored SUCCEEDED', 'Idle', ['Ended'], 'Finished'],
    // Still held until the runner lets go; the older reading said Ended at once.
    ['ending after an interrupted turn', 'Idle', ['Interrupted'], 'Ended'],
  ];
  for (const [name, withFields, marks, without] of cases) {
    it(`${name}: "${withFields}"${marks.length ? ` + ${marks.join(', ')}` : ''} with the new fields, "${without}" without them`, () => {
      expect(statusLabel(SITUATIONS[name])).toBe(withFields);
      expect((sessionMarks(SITUATIONS[name]) ?? []).map((m) => SESSION_MARKS[m].word)).toEqual(marks);
      expect(statusLabel(olderServer(SITUATIONS[name]))).toBe(without);
      expect(sessionMarks(olderServer(SITUATIONS[name]))).toBeNull();
    });
  }

  it('running a job with no turn is Running with the Background mark; an older server keeps its breathing glyph', () => {
    const s = SITUATIONS['running a job with no turn'];
    expect(statusLabel(s)).toBe('Running');
    expect(sessionMarks(s)).toEqual(['BACKGROUND']);
    expect(statusGlyphMotion(s)).toBe('spinner');
    expect(statusLabel(olderServer(s))).toBe('Background process running');
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

  it('a shared session reads Idle + Finished for a task run that finished, never Succeeded', () => {
    expect(sessionStateWord(SITUATIONS['a task run that finished'])).toBe('Idle');
    expect(sessionMarks(SITUATIONS['a task run that finished'])).toEqual(['FINISHED']);
    expect(sessionStateWord(olderServer(SITUATIONS['a task run that finished']))).toBe('Finished');
  });
});
