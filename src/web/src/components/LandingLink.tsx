import type { JSX, ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { encodeId } from '../lib/idCodec';
import { LANDING_NO_PAGE, LANDING_OPEN } from './ProjectPanoramaHeader';

/**
 * "Open landing ›" — the explicit way into the landing session a piece of work belongs to (contract
 * §2.9 LS6, owner 2026-10-19: 方案 A). The presses main already had are untouched: a Landing card and
 * a Work overview card still open the jobs in flight, and a job's row still opens its task. This is
 * the one thing said in words, drawn beside them, and a real `<a href>` so ⌘/middle-click works.
 *
 * It keeps the list it was read on: opened from a project's sessions page, the same `?project=` (and
 * the folder, when there is one) rides along, so the page behind the landing is still the project
 * rather than the whole workspace.
 */
export function LandingLink({
  sessionId,
  className,
  children,
  onClick,
  title,
}: {
  sessionId: string;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
  title?: string;
}): JSX.Element {
  const location = useLocation();
  const current = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  for (const key of ['project', 'folder', 'view']) {
    const value = current.get(key);
    if (value) keep.set(key, value);
  }
  const query = keep.toString();
  return (
    <Link className={className} to={`/sessions/${encodeURIComponent(encodeId(sessionId))}${query ? `?${query}` : ''}`}
      onClick={onClick} title={title}>
      {children ?? <>{`${LANDING_OPEN} ›`}</>}
    </Link>
  );
}

/**
 * The same slot on a server that names no landing session: the fact, greyed, and nothing to press
 * (owner 2026-10-19). Drawn where the link would have been so the reader learns why the way in is
 * missing rather than hunting for it.
 */
export function LandingNoPage({ className }: { className?: string }): JSX.Element {
  return <span className={className ?? 'landing-nopage'}>{LANDING_NO_PAGE}</span>;
}
