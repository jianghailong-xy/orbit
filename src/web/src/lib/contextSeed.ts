export interface ContextSeedState {
  contextKey: string;
  dirty: boolean;
}

/** Decide whether an asynchronously refined default may seed one controlled value. */
export function decideContextSeed(
  current: ContextSeedState,
  contextKey: string,
  hasSeed: boolean,
): { state: ContextSeedState; apply: boolean } {
  if (current.contextKey !== contextKey) {
    return {
      state: { contextKey, dirty: false },
      apply: hasSeed,
    };
  }
  return { state: current, apply: hasSeed && !current.dirty };
}

export const dirtyContextSeed = (contextKey: string): ContextSeedState => ({
  contextKey,
  dirty: true,
});
