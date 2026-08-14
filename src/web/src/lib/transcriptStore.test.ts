import { describe, expect, it } from 'vitest';
import { uuidToBase62 } from '@orbit/shared';
import {
  MAX_STORED_EVENTS,
  eventsToPersist,
  rangeOf,
  sessionsToEvict,
  storageKey,
  trimForStorage,
  type StoredEvent,
} from './transcriptStore';

const ev = (seq: number): StoredEvent => ({ seq, type: 'assistant', payload: { text: `#${seq}` } });
const page = (from: number, to: number): StoredEvent[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));

describe('eventsToPersist', () => {
  it('writes everything the first time a session is stored', () => {
    expect(eventsToPersist(page(1, 5), null).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('writes only what the SSE appended above the stored range', () => {
    expect(eventsToPersist(page(1, 8), { min: 1, max: 5 }).map((e) => e.seq)).toEqual([6, 7, 8]);
  });

  it('writes what "load earlier" prepended below the stored range', () => {
    // The regression this exists for: a high-water mark alone would treat these as already
    // written and silently drop every page the user scrolled back through.
    expect(eventsToPersist(page(1, 8), { min: 5, max: 8 }).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('writes both ends when the window grew in both directions at once', () => {
    expect(eventsToPersist(page(1, 10), { min: 4, max: 6 }).map((e) => e.seq)).toEqual([
      1, 2, 3, 7, 8, 9, 10,
    ]);
  });

  it('writes nothing when the window has not moved', () => {
    expect(eventsToPersist(page(3, 7), { min: 3, max: 7 })).toEqual([]);
  });
});

describe('rangeOf', () => {
  it('spans the lowest and highest seq regardless of array order', () => {
    expect(rangeOf([ev(9), ev(2), ev(5)])).toEqual({ min: 2, max: 9 });
  });

  it('is null for an empty window, so the next write persists everything', () => {
    expect(rangeOf([])).toBeNull();
  });
});

describe('trimForStorage', () => {
  it('leaves a window that fits alone, boundary flags untouched', () => {
    const snapshot = { events: page(1, 10), oldestSeq: 1, hasMoreOlder: false };
    expect(trimForStorage(snapshot, 50)).toEqual(snapshot);
  });

  it('keeps the NEWEST events when over the cap', () => {
    const { events } = trimForStorage({ events: page(1, 100), oldestSeq: 1, hasMoreOlder: false }, 10);
    expect(events.map((e) => e.seq)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it('moves the pagination boundary onto what it actually kept', () => {
    // Without this a reload would believe it held the start of the conversation, so "load earlier"
    // would never fetch the events the trim dropped — a hole the user could not scroll past.
    const trimmed = trimForStorage({ events: page(1, 100), oldestSeq: 1, hasMoreOlder: false }, 10);
    expect(trimmed.oldestSeq).toBe(91);
    expect(trimmed.hasMoreOlder).toBe(true);
  });

  it('sorts by seq, so an out-of-order window still trims the right end', () => {
    const snapshot = { events: [ev(3), ev(1), ev(2)], oldestSeq: 1, hasMoreOlder: false };
    expect(trimForStorage(snapshot, 2).events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('defaults to the documented per-session cap', () => {
    const trimmed = trimForStorage({
      events: page(1, MAX_STORED_EVENTS + 25),
      oldestSeq: 1,
      hasMoreOlder: false,
    });
    expect(trimmed.events).toHaveLength(MAX_STORED_EVENTS);
    expect(trimmed.hasMoreOlder).toBe(true);
  });
});

describe('sessionsToEvict', () => {
  const rows = [
    { sessionId: 'oldest', lastOpenedAt: 100 },
    { sessionId: 'middle', lastOpenedAt: 200 },
    { sessionId: 'newest', lastOpenedAt: 300 },
  ];

  it('evicts nothing while under the cap', () => {
    expect(sessionsToEvict(rows, 3)).toEqual([]);
    expect(sessionsToEvict(rows, 10)).toEqual([]);
  });

  it('evicts least-recently-opened first, only down to the cap', () => {
    expect(sessionsToEvict(rows, 2)).toEqual(['oldest']);
    expect(sessionsToEvict(rows, 1)).toEqual(['oldest', 'middle']);
  });

  it('does not mutate the caller’s array', () => {
    const input = [...rows];
    sessionsToEvict(input, 1);
    expect(input.map((r) => r.sessionId)).toEqual(['oldest', 'middle', 'newest']);
  });
});

describe('storageKey', () => {
  const uuid = '019fcbf3-0fa8-7f83-9302-46b25389cb16';

  // The whole point: the wire spelling is moving to base62, and a cache keyed by whatever
  // spelling was current when a row was written would orphan every transcript stored before the
  // switch — a silent "slower since the update" with no failing request to find.
  it('keys both spellings of one session to the same row', () => {
    expect(storageKey(uuidToBase62(uuid))).toBe(uuid);
    expect(storageKey(uuid)).toBe(uuid);
  });

  it('normalizes a capitalized UUID, which IndexedDB would otherwise key separately', () => {
    expect(storageKey(uuid.toUpperCase())).toBe(uuid);
  });

  // A miss is survivable; a throw on the boot path is not.
  it('passes an unrecognizable id straight through instead of throwing', () => {
    expect(storageKey('not an id')).toBe('not an id');
    expect(storageKey('')).toBe('');
  });
});
