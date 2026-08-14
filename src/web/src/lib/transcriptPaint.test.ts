import { describe, expect, it } from 'vitest';
import { FIRST_PAINT_EVENTS, firstPaintSlice, transcriptPlaceholder } from './transcriptPaint';

// A session that has resolved, is live and idle, and whose transcript is already loaded.
const base = {
  hasSession: true,
  trashed: false,
  runState: 'AWAITING_INPUT' as string | null,
  live: true,
  eventCount: 12,
  seeding: false,
  streaming: false,
};

describe('transcriptPlaceholder', () => {
  it('says nothing once there are events to render', () => {
    expect(transcriptPlaceholder(base)).toBeNull();
    // Even mid-load: whatever is on screen beats a placeholder.
    expect(transcriptPlaceholder({ ...base, seeding: true })).toBeNull();
  });

  it('shows the skeleton while an unvisited session is being fetched', () => {
    expect(transcriptPlaceholder({ ...base, eventCount: 0, seeding: true })).toBe('skeleton');
  });

  it('shows the skeleton on a deep link, before any session row has resolved', () => {
    // The regression this guards: the fetch is ours and in flight either way, so gating the
    // skeleton on a resolved row would blank the pane for exactly the slowest case.
    expect(
      transcriptPlaceholder({ ...base, hasSession: false, eventCount: 0, seeding: true }),
    ).toBe('skeleton');
  });

  it('does not claim to be waiting on the workspace while it is really waiting on the fetch', () => {
    // Before: an empty pane + "Waiting for the workspace…" were the only two outcomes, and a live
    // session mid-load got the wrong one.
    const loading = { ...base, eventCount: 0, seeding: true };
    expect(transcriptPlaceholder(loading)).toBe('skeleton');
    expect(transcriptPlaceholder({ ...loading, seeding: false })).toBe('waiting');
  });

  it('lets the queued state outrank the skeleton — a slot wait is a status, not a load', () => {
    expect(
      transcriptPlaceholder({ ...base, runState: 'QUEUED', eventCount: 0, seeding: true }),
    ).toBe('queued');
  });

  it('keeps the skeleton for a trashed session, which has no queued/waiting state of its own', () => {
    const trashed = { ...base, trashed: true, eventCount: 0 };
    expect(transcriptPlaceholder({ ...trashed, seeding: true })).toBe('skeleton');
    expect(transcriptPlaceholder({ ...trashed, runState: 'QUEUED', seeding: true })).toBe('skeleton');
    expect(transcriptPlaceholder({ ...trashed, seeding: false })).toBeNull();
  });

  it('stays silent for an ended, empty session — there is nothing to wait for', () => {
    expect(transcriptPlaceholder({ ...base, live: false, eventCount: 0 })).toBeNull();
  });

  it('yields to a partial bubble that is already streaming', () => {
    expect(transcriptPlaceholder({ ...base, eventCount: 0, streaming: true })).toBeNull();
    expect(transcriptPlaceholder({ ...base, eventCount: 0, streaming: false })).toBe('waiting');
  });
});

describe('firstPaintSlice', () => {
  const page = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

  it('paints a short page whole, without scheduling a second render', () => {
    const events = page(FIRST_PAINT_EVENTS);
    const { now, deferred } = firstPaintSlice(events);
    expect(deferred).toBe(false);
    // Same reference, so React skips the re-render the deferred path would cause.
    expect(now).toBe(events);
  });

  it('paints the NEWEST slice of a full page and holds the rest back', () => {
    const { now, deferred } = firstPaintSlice(page(200), 50);
    expect(deferred).toBe(true);
    expect(now).toHaveLength(50);
    // The transcript opens at the latest message — the tail, not the head.
    expect(now[now.length - 1]).toBe(200);
    expect(now[0]).toBe(151);
  });

  it('holds nothing back from an empty page', () => {
    expect(firstPaintSlice([])).toEqual({ now: [], deferred: false });
  });
});
