import { useEffect, useRef, type ReactNode } from 'react';
import { Dialog } from './ui/Dialog';
import { refreshCardKeys } from './CardHotkey';
import { useIsMobile } from '../lib/useMediaQuery';
import './ReviewCard.css';

/** Show the full form on wide screens; keep narrow-screen drafts mounted behind their preview. */
export function ReviewCard({ title, summary, meta, open, onOpenChange, children, enabled = true, id }: {
  title: string;
  summary: string;
  meta?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  enabled?: boolean;
  id?: string;
}) {
  const narrow = useIsMobile();
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    refreshCardKeys();
    return refreshCardKeys;
  }, [open, enabled, narrow]);
  if (!enabled) return children;
  if (!narrow) return <div className="review-card" id={id}>{children}</div>;
  return (
    <div className="review-card" id={id}>
      <button ref={trigger} type="button" className="approval-card review-card-preview"
        aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpenChange(true)}>
        <span className="review-card-title">{title}</span>
        {meta && <span className="review-card-meta">{meta}</span>}
        <span className="review-card-summary">{summary}</span>
        <span className="review-card-open">Open to review <span aria-hidden="true">↗</span></span>
      </button>
      <Dialog open={open} onClose={() => onOpenChange(false)} title={title}
        className="review-card-dialog" width={720} keepMounted returnFocus={trigger}>
        <div className="review-card-content" data-review-open={open}>{children}</div>
      </Dialog>
    </div>
  );
}
