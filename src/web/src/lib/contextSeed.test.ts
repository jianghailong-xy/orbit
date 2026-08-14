import { describe, expect, it } from 'vitest';
import { decideContextSeed, dirtyContextSeed, type ContextSeedState } from './contextSeed';

describe('context seed decisions', () => {
  const untouched: ContextSeedState = { contextKey: 'draft:workspace-a', dirty: false };

  it('allows an async seed refinement while the current context is untouched', () => {
    expect(decideContextSeed(untouched, 'draft:workspace-a', true).apply).toBe(true);
  });

  it('does not overwrite an explicit choice in the same context', () => {
    const dirty = dirtyContextSeed('draft:workspace-a');
    expect(decideContextSeed(dirty, 'draft:workspace-a', true).apply).toBe(false);
  });

  it('resets dirty when the Workspace or Session context changes', () => {
    const dirty = dirtyContextSeed('session:one');
    expect(decideContextSeed(dirty, 'session:two', true)).toEqual({
      state: { contextKey: 'session:two', dirty: false },
      apply: true,
    });
  });
});
