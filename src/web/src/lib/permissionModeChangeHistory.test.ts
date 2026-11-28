import { describe, expect, it } from 'vitest';
import { modeChange } from '../test/permissionModeFixtures';
import { adoptDetailChanges, needsOlderModeChanges, type ModeChangeHistory } from './permissionModeChangeHistory';

const at = (s: number) => new Date(Date.parse('2026-11-27T05:00:00Z') + s * 1000).toISOString();
/** The change numbered `seq`, Auto and Plan in turn, one a second. */
const c = (seq: number) => modeChange('OWNER_PICK', seq % 2 ? 'plan' : 'auto', seq % 2 ? 'auto' : 'plan', at(seq), 'web', seq);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => c(from + i));
const seqs = (h: ModeChangeHistory) => h.changes.map((x) => x.seq);
const EMPTY: ModeChangeHistory = { sessionId: null, changes: [], hasMore: false };

describe('the mode changes a transcript holds', () => {
  it('takes in the detail, and keeps what it holds when a read adds nothing', () => {
    const held = adoptDetailChanges(EMPTY, 's', range(11, 60), true);
    expect(seqs(held)).toEqual(range(11, 60).map((x) => x.seq));
    expect(held.hasMore).toBe(true);
    expect(adoptDetailChanges(held, 's', range(11, 60), true)).toBe(held);
  });

  it('keeps a change that falls out of the newest fifty, and adds the new ones once', () => {
    const held: ModeChangeHistory = { sessionId: 's', changes: range(1, 60), hasMore: false };
    const next = adoptDetailChanges(held, 's', range(13, 62), true);
    expect(seqs(next)).toEqual(range(1, 62).map((x) => x.seq));
    expect(next.hasMore).toBe(false);
  });

  it('starts again from a detail that no longer reaches what it holds, so nothing in between is missed', () => {
    const held: ModeChangeHistory = { sessionId: 's', changes: range(1, 60), hasMore: false };
    const next = adoptDetailChanges(held, 's', range(71, 120), true);
    expect(seqs(next)).toEqual(range(71, 120).map((x) => x.seq));
    expect(next.hasMore).toBe(true);
  });

  it('holds another session’s changes apart, and a server that numbers none as it says', () => {
    const held = adoptDetailChanges(EMPTY, 's', range(1, 3), false);
    expect(adoptDetailChanges(held, 't', range(4, 5), false).changes.map((x) => x.seq)).toEqual([4, 5]);
    const unnumbered = [modeChange('CLAIM', 'auto', null, at(1))];
    const old = adoptDetailChanges(EMPTY, 's', unnumbered, undefined);
    expect(old.changes).toBe(unnumbered);
    expect(old.hasMore).toBe(false);
    expect(adoptDetailChanges(old, 's', unnumbered, undefined)).toBe(old);
    // No detail yet, or none read: nothing held, and the same nothing on the next render.
    const none = adoptDetailChanges(EMPTY, 's', undefined, undefined);
    expect(adoptDetailChanges(none, 's', undefined, undefined)).toBe(none);
    const empty = adoptDetailChanges(EMPTY, 's', [], false);
    expect(adoptDetailChanges(empty, 's', [], false)).toBe(empty);
  });

  it('reads older ones only as far back as the transcript is loaded, and all of them once it reaches the start', () => {
    const held: ModeChangeHistory = { sessionId: 's', changes: range(11, 60), hasMore: true };
    // The oldest held (0:11) is older than the oldest event: the window is covered.
    expect(needsOlderModeChanges(held, at(30), false)).toBe(false);
    // An event as old as it, or older, may have changes beside or before it.
    expect(needsOlderModeChanges(held, at(11), false)).toBe(true);
    expect(needsOlderModeChanges(held, at(5), false)).toBe(true);
    // At the start of the session, every change is the transcript's.
    expect(needsOlderModeChanges(held, at(30), true)).toBe(true);
    // Nothing loaded yet, or nothing older recorded: not yet, and not at all.
    expect(needsOlderModeChanges(held, undefined, true)).toBe(false);
    expect(needsOlderModeChanges({ ...held, hasMore: false }, at(5), true)).toBe(false);
  });
});
