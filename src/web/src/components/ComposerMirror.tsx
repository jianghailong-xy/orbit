import { useLayoutEffect, useRef } from 'react';
import { segmentComposer, type ReferenceMap } from '../lib/composerRefs';

/**
 * The layer that draws the composer's chips.
 *
 * A `<textarea>` cannot contain styled elements, so the chips are painted here — a div sitting
 * exactly behind the input, rendering the same characters with the same metrics, while the
 * textarea's own text is transparent and only its caret and selection show through.
 *
 * The constraint that makes this work is narrow: this layer may change **colour and background
 * and nothing else**. Any change to the characters, the font, or a chip's layout width slides
 * every glyph after it, and the caret goes with the textarea rather than with what is drawn. The
 * chips therefore cancel their own padding with an equal negative margin (see `.composer-chip`),
 * so the pill bleeds outward without occupying width.
 *
 * `scrollTop` is mirrored because the textarea scrolls once the draft passes its auto-grow cap,
 * and a static mirror would leave the chips behind.
 */
export function ComposerMirror({
  text,
  refs,
  scrollTop,
  anchorAt = null,
}: {
  text: string;
  refs: ReferenceMap;
  /** The textarea's scroll offset, so the two layers stay in step once it overflows. */
  scrollTop: number;
  /**
   * A character offset to mark with a zero-size `.composer-mirror-anchor`: where the `@` or `#` being
   * typed sits, so its popup can be placed under it. Zero-size, so it moves no glyph.
   */
  anchorAt?: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = scrollTop;
  }, [scrollTop, text]);

  return (
    <div ref={ref} className="composer-mirror" aria-hidden="true">
      {withOffsets(segmentComposer(text, refs)).map(({ seg, start }, i) => {
        if (seg.type === 'text') {
          if (anchorAt != null && anchorAt >= start && anchorAt <= start + seg.text.length) {
            const cut = anchorAt - start;
            return (
              <span key={i}>
                {seg.text.slice(0, cut)}
                <span className="composer-mirror-anchor" />
                {seg.text.slice(cut)}
              </span>
            );
          }
          return <span key={i}>{seg.text}</span>;
        }
        return (
          <span key={i} className={`composer-chip composer-chip--${seg.kind}`}>
            {seg.text}
          </span>
        );
      })}
      {/* A draft ending in a newline is one line taller in the textarea than in a div, which
          would misalign every chip after the user presses Enter at the end. */}
      {'\n'}
    </div>
  );
}

/** Each segment with the offset it starts at in the draft. */
function withOffsets<T extends { text: string }>(segs: T[]): Array<{ seg: T; start: number }> {
  let at = 0;
  return segs.map((seg) => {
    const start = at;
    at += seg.text.length;
    return { seg, start };
  });
}
