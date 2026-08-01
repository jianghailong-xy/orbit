import { describe, expect, it } from 'vitest';
import { PROVIDER_GLYPHS } from './providerGlyphs';

describe('provider glyph aliases', () => {
  it('keeps the Kimi mark when the Moonshot preset uses its vendor slug', () => {
    expect(PROVIDER_GLYPHS.moonshot).toBe(PROVIDER_GLYPHS.kimi);
  });
});
