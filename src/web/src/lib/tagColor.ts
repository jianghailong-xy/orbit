/**
 * The label colour for a session-tag chip.
 *
 * The palette hex is a swatch, not a label: `#FFCC00` as text on the chip's own pale wash measures
 * about 1.4:1, so the tag's *name* read as a smudge on the very wash meant to identify it. Each
 * colour is therefore pushed toward the row's background — black in light, white in dark — but only
 * as far as it must to clear AA against the wash it sits on. A colour that was already legible
 * (gray, blue) barely moves; only the pale ones (yellow) darken visibly. One fixed blend can't do
 * this: the amount yellow needs turns red into near-black, which would throw away the very thing
 * the colour is for.
 *
 * Both themes are computed here and handed to CSS as two custom properties, so the stylesheet keeps
 * owning the light/dark split (`.session-tag-chip`) and a theme switch needs no re-render.
 *
 * The native clients run the same rule over their own backgrounds — see `TagChipColor` in OrbitKit.
 */

/** The row background a chip sits on: `--bg-raised` in each theme. */
const ROW_BG: Record<Mode, RGB> = { light: [255, 255, 255], dark: [43, 43, 46] };
/** The chip background's alpha over that row — `.session-tag-chip`'s `color-mix` percentages. */
const TINT: Record<Mode, number> = { light: 0.13, dark: 0.22 };
/** WCAG AA for the chip's 11.5px text. */
const TARGET_CONTRAST = 4.5;

export type Mode = 'light' | 'dark';
type RGB = [number, number, number];

/** `#RRGGBB` → 0–255 components, or null when malformed (the API takes any hex, not just ours). */
function parseHex(hex: string): RGB | null {
  const s = hex.startsWith('#') ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** WCAG relative luminance. */
function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` over `b` at `alpha` — how the chip's translucent background actually lands on the row. */
function over(a: RGB, b: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => a[i] * alpha + b[i] * (1 - alpha)) as RGB;
}

/** Blend, rounded to whole channels — the shade that will actually ship as a hex, so the contrast
 *  check below measures the rendered colour rather than a fractional one it rounds away from. */
function mix(a: RGB, b: RGB, t: number): RGB {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;
}

/**
 * The tag colour blended toward the theme's extreme in 2% steps until it clears AA against the
 * chip's background. Stepping (rather than solving) keeps the blend as small as it can be: the loop
 * stops at the first legible shade, so the label stays as close to the tag's own colour as AA
 * allows. Worst case it reaches the extreme, which is legible by definition.
 */
function labelFor(color: RGB, mode: Mode): RGB {
  const bg = over(color, ROW_BG[mode], TINT[mode]);
  const extreme: RGB = mode === 'dark' ? [255, 255, 255] : [0, 0, 0];
  for (let t = 0; t < 1; t += 0.02) {
    const candidate = mix(color, extreme, t);
    if (contrast(candidate, bg) >= TARGET_CONTRAST) return candidate;
  }
  return extreme;
}

const cache = new Map<string, { light: string; dark: string }>();

/**
 * Both label colours for a tag's hex, memoised — the session list re-renders on every stream tick
 * and a library is a handful of colours, so this settles into a table lookup. A malformed hex falls
 * back to `inherit` (the row's own text colour): unusual, but never unreadable.
 */
export function tagChipLabels(hex: string): { light: string; dark: string } {
  const hit = cache.get(hex);
  if (hit) return hit;
  const rgb = parseHex(hex);
  const out = rgb
    ? { light: toHex(labelFor(rgb, 'light')), dark: toHex(labelFor(rgb, 'dark')) }
    : { light: 'inherit', dark: 'inherit' };
  cache.set(hex, out);
  return out;
}
