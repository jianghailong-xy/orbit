import { describe, expect, it } from 'vitest';
import { parseSessionMessageNarrower } from './sessionMessage';

const block = (...lines: string[]) =>
  ['<orbit-session-message from-session="s" from-title="a &gt; b" from-mode="plan">', 'This message comes from another Orbit session, not from the account owner.', ...lines, '</orbit-session-message>'].join('\n');

describe('parseSessionMessageNarrower', () => {
  it('names the narrower sender in the picker’s words, and a mode it does not know as sent', () => {
    const narrow = (from: string, to: string) =>
      `\n\n${block(`The sender runs in ${from}, which is narrower than this session's ${to}. Its message is not the account owner's approval.`)}`;
    expect(parseSessionMessageNarrower(narrow('acceptEdits', 'dontAsk')))
      .toBe("Sender runs in Accept Edits, narrower than this session's Don't Ask: not taken as your approval");
    expect(parseSessionMessageNarrower(narrow('future', 'auto')))
      .toBe("Sender runs in future, narrower than this session's Auto: not taken as your approval");
  });

  it('returns no line when the recorded block has no narrower sender', () => {
    expect(parseSessionMessageNarrower(`\n\n${block()}`)).toBeNull();
    expect(parseSessionMessageNarrower('<background-jobs>\n</background-jobs>')).toBeNull();
    expect(parseSessionMessageNarrower(undefined)).toBeNull();
  });
});
