import { describe, expect, it } from 'vitest';
import { CURSOR_KEY_CHECK_OUTCOMES, CURSOR_KEY_CHECK_STATES } from './dto';

// What a Cursor API key check somebody asks for comes to (project P2 follow-up): on connect, or again for a
// saved key. The acceptance script (scripts/test-cursor-key-check.mjs) runs every case below by name.

describe('P2 follow-up a Cursor key check in the shared contract', () => {
  it('P2 follow-up a check comes to what Cursor said on a runner, or to NO_RUNNER when no runner could ask', () => {
    expect(CURSOR_KEY_CHECK_STATES).toEqual(['VALID', 'INVALID', 'UNREACHABLE']);
    // The states a key keeps as its last check, then the one outcome that is no check at all.
    expect(CURSOR_KEY_CHECK_OUTCOMES).toEqual([...CURSOR_KEY_CHECK_STATES, 'NO_RUNNER']);
    expect(new Set(CURSOR_KEY_CHECK_OUTCOMES).size).toBe(CURSOR_KEY_CHECK_OUTCOMES.length);
  });
});
