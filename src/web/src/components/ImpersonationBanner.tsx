import { useEffect, useState } from 'react';
import { impersonation, onImpersonationChange, stopImpersonation } from '../api';
import { Button } from './ui/Button';

export const EXIT_VIEW_AS = 'Exit';

/** End the look, back on the page it was started from: the administrator's Users page. */
function exit() {
  stopImpersonation();
  location.href = '/admin';
}

/** `m:ss` of what a look has left. */
function remaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Over every page while an administrator views Orbit as another user (Admin → Users → View as):
 * whose Orbit this is, that nothing can be changed, how long the look has left, and the way out. The
 * look ends by itself when its time runs out. A look started or ended in another tab loads this one
 * again, so no tab goes on showing one user's data under the other's token.
 */
export function ImpersonationBanner() {
  const look = impersonation();
  const expiresAt = look?.expiresAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => onImpersonationChange(() => location.reload()), []);
  useEffect(() => {
    if (expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const left = expiresAt === undefined ? 0 : expiresAt * 1000 - now;
  useEffect(() => {
    if (expiresAt !== undefined && left <= 0) exit();
  }, [expiresAt, left]);
  if (!look) return null;
  return (
    <div className="impersonation-banner" role="region" aria-label="Viewing Orbit as another user">
      {/* Short of room, the words before the email go first, then the email's end: never what the look
          allows or how long it has left. */}
      <span className="impersonation-banner-text">
        <span className="impersonation-banner-prefix">Viewing as </span>
        <strong className="impersonation-banner-who">{look.email}</strong>
        <span className="impersonation-banner-left"> · read-only · {remaining(left)} left</span>
      </span>
      <Button size="small" onClick={exit}>
        {EXIT_VIEW_AS}
      </Button>
    </div>
  );
}
