/**
 * How long a check took, to the second.
 *
 * Not `formatSpan`: that one rounds to whole minutes, which is right for "this has been waiting
 * 2h 10m" and wrong here — a check's duration is a measurement of a command, and "6m" for 6m 12s
 * reads as a rounded-off estimate of something that was timed exactly.
 *
 * Here rather than in the card that first needed it, because the second one that shows a check's
 * verdict is an exception item's fact block: the same duration has to read the same way on both.
 */
export function checkDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}
