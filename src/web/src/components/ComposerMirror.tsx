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
}: {
  text: string;
  refs: ReferenceMap;
  /** The textarea's scroll offset, so the two layers stay in step once it overflows. */
  scrollTop: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = scrollTop;
  }, [scrollTop, text]);

  return (
    <div ref={ref} className="composer-mirror" aria-hidden="true">
      {segmentComposer(text, refs).map((seg, i) => {
        if (seg.type === 'text') return <span key={i}>{seg.text}</span>;
        return (
          <span
            key={i}
            className={`composer-chip composer-chip--${seg.type === 'ref' ? seg.kind : 'mention'}`}
          >
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
