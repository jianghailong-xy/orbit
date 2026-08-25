/**
 * Shares one promise between callers asking for the same read while that read is still running.
 *
 * This is deliberately not a cache: settlement (success or failure) removes the entry before the
 * result reaches callers, so the next request always starts a fresh read. Keep one instance per
 * operation; that makes the generic cast on an existing key safe without coupling unrelated result
 * types in a single map.
 */
export class SingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const shared = start().finally(() => {
      // The identity check makes cleanup safe even if this implementation later gains an explicit
      // invalidation/replacement path: an older completion must not remove a newer run's promise.
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
    });
    this.inFlight.set(key, shared);
    return shared;
  }
}
