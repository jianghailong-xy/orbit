import { describe, expect, it } from 'vitest';
import { suggestProviderName } from './providerAdmin';

describe('suggestProviderName', () => {
  it('keeps the vendor name for the first key', () => {
    expect(suggestProviderName('Anthropic (Claude)', [])).toBe('Anthropic (Claude)');
    expect(suggestProviderName('Anthropic (Claude)', ['DeepSeek'])).toBe('Anthropic (Claude)');
  });

  it('numbers each further key for the same vendor', () => {
    expect(suggestProviderName('Anthropic (Claude)', ['Anthropic (Claude)'])).toBe(
      'Anthropic (Claude) 2',
    );
    expect(
      suggestProviderName('Anthropic (Claude)', ['Anthropic (Claude)', 'Anthropic (Claude) 2']),
    ).toBe('Anthropic (Claude) 3');
  });

  it('skips a number a renamed row is already using, whatever its case or padding', () => {
    expect(
      suggestProviderName('Anthropic (Claude)', ['  anthropic (claude) 2 ', 'Anthropic (Claude)']),
    ).toBe('Anthropic (Claude) 3');
  });

  it('takes a free number rather than counting the rows', () => {
    // The first key was renamed to something of its own, so the vendor name itself is free again.
    expect(suggestProviderName('Anthropic (Claude)', ['Work key'])).toBe('Anthropic (Claude)');
  });
});
