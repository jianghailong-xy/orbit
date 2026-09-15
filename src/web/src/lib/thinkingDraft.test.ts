import { describe, expect, it } from 'vitest';
import { formatThinkingDuration, formatThinkingSize, settleThinking } from './thinkingDraft';

describe('what a finished thinking block keeps', () => {
  it('keeps what was streamed when the provider closes the block with no text', () => {
    // Claude's own shape: {"thinking":"","signature":"CAIS…"}. Before this, the draft was
    // cleared and the empty durable event rendered nothing — the reasoning disappeared at the
    // instant it finished.
    const patch = settleThinking('', 'weighing whether to go straight to L3', 1000, 13000);

    expect(patch.text).toBe('weighing whether to go straight to L3');
  });

  it('leaves a provider that did report its reasoning alone', () => {
    // The draft may already hold the first chunks of the NEXT block, so overwriting a
    // provider's own text with it would both duplicate and mis-attribute.
    const patch = settleThinking('the reasoning, in full', 'first chunk of what comes next', 1000, 13000);

    expect(patch.text).toBeUndefined();
  });

  it('records nothing when the block closed empty and nothing was streamed either', () => {
    // A reload mid-session replays durable events with no deltas behind them. Inventing an
    // empty node here is what would paper the transcript with blank rows.
    expect(settleThinking('', '', null, 13000)).toEqual({});
  });

  it('measures the stretch it actually watched, and declines to guess at one it did not', () => {
    expect(settleThinking('', 'x', 1000, 13000).thinkingMs).toBe(12000);
    // Page opened mid-block: no start, so no duration rather than a wrong one.
    expect(settleThinking('', 'x', null, 13000).thinkingMs).toBeUndefined();
  });
});

describe('how a folded row states duration and size', () => {
  it('reads as seconds under a minute and minutes past it', () => {
    expect(formatThinkingDuration(12_000)).toBe('12s');
    expect(formatThinkingDuration(107_000)).toBe('1m 47s');
    expect(formatThinkingDuration(120_000)).toBe('2m');
  });

  it('never claims a block took 0s', () => {
    // Rounding a 400ms block to "0s" reads as "it did not happen".
    expect(formatThinkingDuration(400)).toBe('1s');
  });

  it('states size in characters, since the reasoning is as often CJK as English', () => {
    expect(formatThinkingSize(445)).toBe('445 chars');
    expect(formatThinkingSize(2300)).toBe('2.3k chars');
    expect(formatThinkingSize(21_000)).toBe('21k chars');
  });
});
