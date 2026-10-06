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
 */
export function useWholePixelOffsets(anchor: RefObject<Element | null>, gap: number) {
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
    const [start, size, own] = side === 'top' || side === 'bottom'
      ? [rect.left, rect.width, positioner.width] : [rect.top, rect.height, positioner.height];
    // Base UI negates the offset of an end-aligned popup.
    if (align === 'end') return start + size - Math.ceil(start + size);
    const edge = align === 'start' ? start : start + size / 2 - own / 2;
    return Math.floor(edge) - edge;
  };
  return { sideOffset, alignOffset };
}

/**
 * A dropdown's placement as rc-trigger kept it. Aligned to one edge of its trigger, it moves to the
 * other edge when more of it shows there, never slides along the trigger, and narrows to the room on
 * the side it is aligned to. Base UI's own alignment flip always slides, so the flip is applied as an
 * alignment offset, decided once per opening from the list's natural width, and the room is handed to
 * the stylesheet as --orbit-dropdown-room.
 */
export function useDropdownPlacement(open: boolean, anchor: RefObject<Element | null>, gap: number, align: 'start' | 'center' | 'end') {
  const offsets = useWholePixelOffsets(anchor, gap);
  const positioner = useRef<HTMLDivElement>(null);
  const flipped = useRef<boolean | null>(null);
  useLayoutEffect(() => { if (!open) flipped.current = null; }, [open]);
  if (align === 'center') return { ...offsets, positioner, collisionPadding: 8 };
  const alignOffset = (data: OffsetData) => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect || (data.side !== 'top' && data.side !== 'bottom')) return offsets.alignOffset(data);
    const width = data.positioner.width;
    const right = document.documentElement.clientWidth;
    const startX = Math.floor(rect.left);
    const endX = Math.ceil(rect.right) - width;
    const [own, other] = data.align === 'start' ? [startX, endX] : [endX, startX];
    const visible = (x: number) => Math.min(right, x + width) - Math.max(0, x);
    flipped.current ??= (data.align === 'start' ? own + width > right : own < 0) && visible(other) > visible(own);
    const atStart = (data.align === 'start') !== flipped.current;
    positioner.current?.style.setProperty('--orbit-dropdown-room', `${atStart ? right - startX : Math.ceil(rect.right)}px`);
    const x = atStart ? startX : endX;
    return data.align === 'start' ? x - rect.left : rect.right - width - x;
  };
  return { ...offsets, alignOffset, positioner, collisionPadding: 0, collisionAvoidance: { side: 'flip', align: 'none' } as const };
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
