import { describe, expect, it } from 'vitest';
import { tagChipLabels, type Mode } from './tagColor';

// The seeded palette (session-tags.service.ts) — every tag a picker can offer.
const PALETTE = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#007AFF', '#AF52DE', '#8E8E93'];

// Contrast, written out again rather than imported: the point of the test is that the shipped
// colours measure legible, so it should not lean on the same helper that chose them.
type RGB = [number, number, number];
function rgb(hex: string): RGB {
  const s = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;
}
function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** The chip's actual background: the tag colour washed over the row at the CSS alpha. */
function chipBg(hex: string, mode: Mode): RGB {
  const row: RGB = mode === 'light' ? [255, 255, 255] : [43, 43, 46];
  const alpha = mode === 'light' ? 0.13 : 0.22;
  const c = rgb(hex);
  return [0, 1, 2].map((i) => c[i] * alpha + row[i] * (1 - alpha)) as RGB;
}

describe('tagChipLabels', () => {
  it('clears AA on its own chip background, in both themes', () => {
    for (const hex of PALETTE) {
      const { light, dark } = tagChipLabels(hex);
      expect(ratio(rgb(light), chipBg(hex, 'light')), `${hex} light`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(rgb(dark), chipBg(hex, 'dark')), `${hex} dark`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('is the failure the raw palette colour has — yellow was the smudge', () => {
    // What the chip used to do: the tag's own hex as text.
    expect(ratio(rgb('#FFCC00'), chipBg('#FFCC00', 'light'))).toBeLessThan(2);
  });

  it('keeps the hue: darkens only as far as AA needs, never to flat black or white', () => {
    for (const hex of PALETTE) {
      const { light, dark } = tagChipLabels(hex);
      expect(light, hex).not.toBe('#000000');
      expect(dark, hex).not.toBe('#ffffff');
    }
    // A colour that was already legible barely moves; a pale one moves a lot. Blue is dark enough
    // to pass nearly untouched, yellow is not — one fixed blend could not serve both.
    const blue = luminance(rgb('#007AFF')) - luminance(rgb(tagChipLabels('#007AFF').light));
    const yellow = luminance(rgb('#FFCC00')) - luminance(rgb(tagChipLabels('#FFCC00').light));
    expect(yellow).toBeGreaterThan(blue * 2);
  });

  it('falls back to the row text colour on a hex the palette never made', () => {
    expect(tagChipLabels('nonsense')).toEqual({ light: 'inherit', dark: 'inherit' });
    expect(tagChipLabels('#12345')).toEqual({ light: 'inherit', dark: 'inherit' });
  });
});
