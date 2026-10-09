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
 *
 * `pointAt` is the edge a callout was asked to align to above or below its anchor, when it should point
 * its arrow at the anchor's centre as the replaced popover's `arrow.pointAtCenter` did. That edge then
 * sits 20px (the arrow's 12px inset and half its 16px width) before or after the anchor's centre, and
 * nothing slides. Flipped to the other edge, rc-trigger measured from the anchor's near corner instead:
 * the new edge sits 20px past the anchor's edge on the side the callout was aligned to.
 */
export function useWholePixelOffsets(anchor: RefObject<Element | null>, gap: number, padding?: number, pointAt?: 'start' | 'end') {
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
    if (pointAt && vertical && align !== 'center') {
      const at = align === pointAt ? start + size / 2 : align === 'end' ? start : start + size;
      edge = align === 'end' ? Math.ceil(at + 20) - own : Math.floor(at - 20);
    } else if (padding !== undefined && vertical) {
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

/**
 * A submenu placed as rc-trigger placed the replaced one (rc-menu's `rightTop`). It starts at its item's right
 * edge, rounded down. If it would cross the layout viewport's right edge and ending at the item's left edge
 * shows at least as much of it, it ends there instead, its left edge rounded down; it is never slid into view
 * or moved below its item. Laid out from its left edge, it narrows to the room up to the layout viewport's edge
 * (--orbit-submenu-room), its labels wrapping.
 *
 * Base UI's flip decides by the visual viewport less its collision padding, then tries the other axis, so the
 * side rc-trigger did not take is offered to it out of reach and the flip lands on the one rc-trigger took.
 * The vertical alignment is still Base UI's flip and shift.
 */
export function useSubmenuPlacement(anchor: RefObject<Element | null>) {
  const positioner = useRef<HTMLDivElement>(null);
  const sideOffset = ({ side, positioner: { width } }: OffsetData) => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return 0;
    const right = document.documentElement.clientWidth;
    const shown = (x: number) => Math.max(0, Math.min(right, x + width) - Math.max(0, x));
    const flipped = rect.right + width > right && shown(rect.left - width) >= shown(rect.right);
    if (flipped !== (side === 'left')) return 1e6; // out of reach
    const x = flipped ? Math.floor(rect.left - width) : Math.floor(rect.right);
    positioner.current?.style.setProperty('--orbit-submenu-room', `${right - x}px`);
    return flipped ? rect.left - width - x : x - rect.right;
  };
  return { positioner, sideOffset, collisionAvoidance: { fallbackAxisSide: 'none' } as const };
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
  // Base UI measures a popup it has not placed yet while that popup is position: fixed, and applies the
  // result in the method asked for. Portaled into an overlay, an absolute popup is laid out against the
  // overlay's box, so the first placement, measured in page coordinates, puts it off by the overlay's
  // offset until the next measurement. Fixed, it is placed in page coordinates from the first one, as the
  // replaced popups were (in body), and is not held to the overlay's width. Portaled to body, absolute
  // already is page coordinates, and moves with the page natively as the replaced ones did.
  const positionMethod: 'absolute' | 'fixed' = layer.inOverlay ? 'fixed' : 'absolute';
  return { open: shown, setOpen, container, zIndex: layer.zIndex, positionMethod };
}
