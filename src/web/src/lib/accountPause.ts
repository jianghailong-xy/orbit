import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export const accountIsPaused = (until: string | null | undefined, now = Date.now()): boolean =>
  !!until && Date.parse(until) > now;

/** Include the date across midnight, even when the pause is less than a day away. */
export function pauseResumeTime(until: string, now = Date.now()): string {
  const date = new Date(until);
  const today = new Date(now);
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}

export function pauseRemaining(until: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(until) - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''} left` : `${minutes}m left`;
}

/** Keep an open row current, and re-read server selection when a pause expires. */
export function usePauseClock(until: string | null | undefined): number {
  const [now, setNow] = useState(Date.now);
  const qc = useQueryClient();
  useEffect(() => {
    if (!accountIsPaused(until)) { setNow(Date.now()); return; }
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (accountIsPaused(until, current)) {
        timer = setTimeout(tick, Math.min(30_000, Date.parse(until!) - current));
      } else {
        void qc.invalidateQueries({ queryKey: ['runners'] });
        void qc.invalidateQueries({ queryKey: ['providers'] });
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [until, qc]);
  return now;
}
