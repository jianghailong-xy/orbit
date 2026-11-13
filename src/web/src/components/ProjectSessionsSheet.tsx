import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Drawer } from './ui/Drawer';

// Heights as fractions of the viewport (owner 2026-11-11, docs/mocks/project-sessions-column board 5):
// the sheet opens at medium height and drags up to full.
const MEDIUM = 0.62;
const FULL = 0.94;
// Released below this share of the medium height, a drag down closes the sheet.
const CLOSE_BELOW = 0.6;

/**
 * The project's sessions in a bottom sheet over the conversation, at phone width: a scrim, a grabber,
 * medium height first and draggable to full; ✕ (in the page head the caller draws), a scrim tap or a
 * drag down close it.
 */
export function ProjectSessionsSheet({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  /** The sheet's accessible name; the page head inside draws what is seen. */
  title: string;
  children: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const start = useRef<{ y: number; height: number } | null>(null);
  useEffect(() => {
    if (!open) { setFull(false); setDragHeight(null); start.current = null; }
  }, [open]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const sheet = e.currentTarget.closest('.orbit-drawer');
    if (!sheet) return;
    start.current = { y: e.clientY, height: sheet.getBoundingClientRect().height };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!start.current) return;
    const next = start.current.height - (e.clientY - start.current.y);
    setDragHeight(Math.max(0, Math.min(window.innerHeight * FULL, next)));
  };
  const onPointerEnd = (): void => {
    const height = dragHeight;
    start.current = null;
    setDragHeight(null);
    if (height === null) return;
    const vh = window.innerHeight;
    if (height < vh * MEDIUM * CLOSE_BELOW) { onClose(); return; }
    setFull(height > vh * (MEDIUM + FULL) / 2);
  };

  return (
    <Drawer open={open} onClose={onClose} title={title} placement="bottom" closable={false}
      className={`project-sessions-sheet${dragHeight !== null ? ' dragging' : ''}`}
      height={dragHeight ?? `${(full ? FULL : MEDIUM) * 100}%`}>
      <div className="project-sessions-sheet-grabber" aria-hidden
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <span />
      </div>
      {children}
    </Drawer>
  );
}
