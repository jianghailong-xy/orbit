import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ImagePreview } from './ImagePreview';
import './Image.css';

export interface ImageProps {
  src: string;
  alt?: string;
  /** On the `<img>`, which is sized by the caller's class, as on the replaced Image. */
  className?: string;
  /** Drawn over the picture on hover and keyboard focus, on a 30% black wash (the replaced `preview.mask`). */
  cover?: ReactNode;
}

/**
 * A picture that opens on its own in the full-screen viewer (ImagePreview) when pressed, or on Enter or Space — the
 * replaced Image with its preview. The wrapper is a button named by `alt`; the `<img>` fills its width at its own
 * aspect ratio unless the caller's class says otherwise. Pictures that page together (the transcript's) use
 * ImagePreview with `group` instead. The wrapper and the cover are spans, styled as the replaced divs were, so a
 * Markdown picture — inside the `<p>` react-markdown wraps it in — is still valid HTML.
 */
export function Image({ src, alt, className, cover }: ImageProps) {
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  // The viewer grows from the middle of what was pressed, as the replaced one did.
  const show = (target: EventTarget) => {
    const rect = (target as Element).getBoundingClientRect();
    setOrigin({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    setOpen(true);
  };
  return (
    <>
      <span
        className="orbit-image"
        role="button"
        tabIndex={0}
        aria-label={alt}
        onClick={(event: MouseEvent) => show(event.target)}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          show(event.target);
        }}
      >
        <img className={className ? `orbit-image-img ${className}` : 'orbit-image-img'} src={src} alt={alt} />
        <span className="orbit-image-cover">{cover}</span>
      </span>
      <ImagePreview open={open} onClose={() => setOpen(false)} items={[{ src, alt }]} origin={origin} />
    </>
  );
}
