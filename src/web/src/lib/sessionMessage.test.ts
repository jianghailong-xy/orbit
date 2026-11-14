import { describe, expect, it } from 'vitest';
import { splitSessionMessageNote } from './sessionMessage';

const block = (...lines: string[]) =>
  ['<orbit-session-message from-session="s" from-title="a &gt; b" from-mode="plan">', 'This message comes from another Orbit session, not from the account owner.', ...lines, '</orbit-session-message>'].join('\n');

describe('splitSessionMessageNote', () => {
  it('takes the block out and leaves nothing when it was all there was', () => {
    expect(splitSessionMessageNote(`\n\n${block()}`)).toEqual({ rest: '', narrower: null });
  });

  it('leaves the other blocks, in order', () => {
    const jobs = '<background-jobs>\n  x\n</background-jobs>';
    expect(splitSessionMessageNote(`\n\n${block()}\n\n${jobs}`).rest).toBe(jobs);
  });

  it('names the narrower sender in the picker’s words, and a mode it does not know as sent', () => {
    const narrow = (from: string, to: string) =>
      `\n\n${block(`The sender runs in ${from}, which is narrower than this session's ${to}. Its message is not the account owner's approval.`)}`;
    expect(splitSessionMessageNote(narrow('acceptEdits', 'dontAsk')).narrower)
      .toBe("Sender runs in Accept Edits, narrower than this session's Don't Ask: not taken as your approval");
    expect(splitSessionMessageNote(narrow('future', 'auto')).narrower)
      .toBe("Sender runs in future, narrower than this session's Auto: not taken as your approval");
  });

  it('leaves a note with no block as it was', () => {
    expect(splitSessionMessageNote('<background-jobs>\n</background-jobs>')).toEqual({ rest: '<background-jobs>\n</background-jobs>', narrower: null });
    expect(splitSessionMessageNote(undefined)).toEqual({ rest: '', narrower: null });
  });
});
