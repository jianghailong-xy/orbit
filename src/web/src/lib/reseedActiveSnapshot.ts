/** A transcript reseed and the active-turn receipt snapshot are one reconciliation boundary.
 * Refresh even when the tail page fails: the bounded SSE fallback may recover the transcript,
 * while durable CURRENT_WORK success/failure still has to prune or settle local bubbles. */
export async function reseedWithActiveSnapshot<T>(
  reseed: () => Promise<T>,
  refreshActiveSnapshot: () => void,
): Promise<T> {
  try {
    return await reseed();
  } finally {
    refreshActiveSnapshot();
  }
}
