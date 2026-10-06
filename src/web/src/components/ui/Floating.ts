import { useState } from 'react';
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

export function useFloating({ open, onOpenChange }: FloatingProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const shown = open ?? localOpen;
  const setOpen = (next: boolean) => {
    if (open === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const layer = useOverlayChild(shown, () => setOpen(false));
  return { open: shown, setOpen, container: layer.getContainer, zIndex: layer.zIndex };
}
