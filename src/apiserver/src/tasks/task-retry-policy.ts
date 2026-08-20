// One retry policy, shared by the legacy task sweep and Project authorization. Keeping the
// numbers here prevents the Coordinator from growing a second retry ladder that only happens to
// have the same values today.
export const AUTO_RUN_RETRY_BACKOFF_MS = [
  2 * 60_000,
  8 * 60_000,
  30 * 60_000,
  120 * 60_000,
] as const;

export const MAX_AUTO_RUN_FAILURES = AUTO_RUN_RETRY_BACKOFF_MS.length + 1;

export const QUOTA_BLIND_RETRY_BACKOFF_MS = 15 * 60_000;

export function retryBackoffUntil(
  failureCount: number,
  lastFailureAt: Date | null,
): Date | null {
  if (failureCount <= 0 || !lastFailureAt || failureCount >= MAX_AUTO_RUN_FAILURES) return null;
  return new Date(
    lastFailureAt.getTime()
      + AUTO_RUN_RETRY_BACKOFF_MS[Math.min(failureCount - 1, AUTO_RUN_RETRY_BACKOFF_MS.length - 1)],
  );
}
