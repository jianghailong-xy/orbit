import { describe, expect, it } from 'vitest';
import { authRetryText } from './authRetry';

describe('authRetryText', () => {
  it('uses the latest emitted user message when credentials expire during a session', () => {
    expect(
      authRetryText([
        { type: 'user', payload: { text: 'first' } },
        { type: 'assistant', payload: { text: 'reply' } },
        { type: 'user', payload: { text: 'retry this' } },
      ]),
    ).toBe('retry this');
  });

  it('falls back to the opening prompt when first-run auth fails before a user event', () => {
    expect(authRetryText([{ type: 'error', payload: {} }], 'original prompt', 0)).toBe(
      'original prompt',
    );
  });

  it('does not mistake the opening prompt for the latest message of an established session', () => {
    expect(authRetryText([{ type: 'error', payload: {} }], 'old opening prompt', 2)).toBe('');
  });
});
