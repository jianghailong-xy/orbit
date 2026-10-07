import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { useOverlayChild } from './Overlay';

/** Shared implementation details; business code imports the concrete component. */
export interface FloatingProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  popupClassName?: string;
  popupStyle?: CSSProperties;
  returnFocus?: RefObject<HTMLElement | null>;
}

export function calloutArrowStyle({ side, align }: { side: string; align: string }): CSSProperties {
  if (align === 'center') return {};
  return side === 'top' || side === 'bottom'
    ? { left: align === 'start' ? 12 : 'auto', right: align === 'end' ? 12 : 'auto' }
    : { top: align === 'start' ? 12 : 'auto', bottom: align === 'end' ? 12 : 'auto' };
}

interface OffsetData {
  side: string;
  align: 'start' | 'center' | 'end';
  positioner: { width: number; height: number };
}

/**
 * Offsets that put a popup where rc-trigger, which placed the replaced popups, did. It rounds every
 * inset down to a whole pixel: a popup held by its top or left edge starts at floor(anchor edge +
 * gap), one held by its bottom or right edge (shown above or to the left, or aligned to the anchor's
 * end) ends at the matching ceil. Floating UI rounds to the nearest pixel, so half of all fractional
 * anchors put the popup a pixel away.
 *
 * A callout (given its collision `padding`) also slides back inside the viewport as rc-trigger slid
 * it, rounded down after the slide, and its arrow points where rc-trigger pointed it: from the
 * unrounded position to the middle of the part of the anchor the callout covers. Floating UI centres
 * the arrow from the rounded position and the callout's whole-pixel width; the difference is handed
 * to the stylesheet as --orbit-arrow-nudge on the positioner (`positionerRef`).
 */
export function useWholePixelOffsets(anchor: RefObject<Element | null>, gap: number, padding?: number) {
  const positionerRef = useRef<HTMLDivElement>(null);
  const sideOffset = ({ side }: OffsetData) => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return gap;
    if (side === 'bottom') return Math.floor(rect.bottom + gap) - rect.bottom;
    if (side === 'top') return rect.top - Math.ceil(rect.top - gap);
    if (side === 'right') return Math.floor(rect.right + gap) - rect.right;
    return rect.left - Math.ceil(rect.left - gap);
  };
  const alignOffset = ({ side, align, positioner }: OffsetData) => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return 0;
    const vertical = side === 'top' || side === 'bottom';
    const [start, size, own] = vertical ? [rect.left, rect.width, positioner.width] : [rect.top, rect.height, positioner.height];
    // Where Base UI puts the popup's leading edge before this offset, and where rc-trigger did.
    const base = align === 'start' ? start : align === 'end' ? start + size - own : start + size / 2 - own / 2;
    let edge = align === 'end' ? Math.ceil(start + size) - own : Math.floor(base);
    if (padding !== undefined && vertical) {
      const slid = Math.max(padding, Math.min(base, document.documentElement.clientWidth - padding - own));
      if (slid !== base) edge = Math.floor(slid);
      const covered = (Math.max(slid, rect.left) + Math.min(slid + own, rect.right)) / 2;
      positionerRef.current?.style.setProperty('--orbit-arrow-nudge',
        `${edge - slid + covered - (rect.left + rect.width / 2) - (Math.round(own) - own) / 2}px`);
    }
    // Base UI negates the offset of an end-aligned popup.
    return align === 'end' ? base - edge : edge - base;
  };
  return { sideOffset, alignOffset, positionerRef };
}

/**
 * A dropdown's placement as rc-trigger kept it. Aligned to one edge of its trigger, it moves to the
 * other edge when more of it shows there, never slides along the trigger, and narrows to the room on
 * the side it is aligned to. Base UI's own alignment flip always slides, so the flip is applied as an
 * alignment offset. As rc-trigger measured the list unconstrained before aligning it, the list keeps
 * its natural width until it first overflows (--orbit-dropdown-room: none); that overflow decides the
 * edge for the rest of the opening, and from then on the room is handed to the stylesheet.
 */
export function useDropdownPlacement(open: boolean, anchor: RefObject<Element | null>, gap: number, align: 'start' | 'center' | 'end') {
  const { sideOffset, alignOffset: wholePixel } = useWholePixelOffsets(anchor, gap);
  const positioner = useRef<HTMLDivElement>(null);
  const edge = useRef<'start' | 'end' | null>(null);
  useLayoutEffect(() => { if (!open) edge.current = null; }, [open]);
  if (align === 'center') return { sideOffset, alignOffset: wholePixel, positioner, collisionPadding: 8 };
  const alignOffset = (data: OffsetData) => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect || (data.side !== 'top' && data.side !== 'bottom')) return wholePixel(data);
    const width = data.positioner.width;
    const right = document.documentElement.clientWidth;
    const startX = Math.floor(rect.left);
    const endX = Math.ceil(rect.right) - width;
    // Decided on the alignment asked for: Floating UI also tries the other one as a fallback placement.
    const [own, other] = align === 'start' ? [startX, endX] : [endX, startX];
    const visible = (x: number) => Math.min(right, x + width) - Math.max(0, x);
    if (edge.current === null && (align === 'start' ? own + width > right : own < 0)) {
      edge.current = visible(other) > visible(own) ? (align === 'start' ? 'end' : 'start') : align;
    }
    const atStart = (edge.current ?? align) === 'start';
    positioner.current?.style.setProperty('--orbit-dropdown-room',
      edge.current === null ? 'none' : `${atStart ? right - startX : Math.ceil(rect.right)}px`);
    const x = atStart ? startX : endX;
    // Held by its right inset, an end-aligned list keeps the fractional left edge of its width there;
    // Base UI rounds the position, so the remainder is handed back as a relative offset, which moves
    // the list in layout without resizing the positioner it is measured by.
    positioner.current?.style.setProperty('--orbit-dropdown-subpixel', `${x - Math.round(x)}px`);
    // Whichever alignment is being placed, the offset lands its edge on x.
    return data.align === 'end' ? rect.right - width - x : x - rect.left;
  };
  return { sideOffset, alignOffset, positioner, collisionPadding: 0, collisionAvoidance: { side: 'flip', align: 'none' } as const };
}

/** The anchor's exact width while open; Base UI's own --anchor-width is snapped to device pixels. */
export function useAnchorWidth(open: boolean, anchor: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const node = anchor.current;
    if (!open || !node) return;
    const measure = () => setWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, anchor]);
  return width;
}

export function useFloating({ open, onOpenChange }: FloatingProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const shown = open ?? localOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const layer = useOverlayChild(shown, () => setOpen(false));
  // A static (server) render has no document; the popup is closed there and its portal renders nothing.
  const container = () => (typeof document === 'undefined' ? undefined : layer.getContainer());
  return { open: shown, setOpen, container, zIndex: layer.zIndex };
}
