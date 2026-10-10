// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useWholePixelOffsets } from './Floating';

/**
 * Where a callout above or below its anchor puts its leading edge. With `pointAt` it points its arrow at the
 * anchor's centre as the replaced popover's `arrow.pointAtCenter` did; the cases are the Wiki's footnote cards
 * as rc-trigger placed them (a 464px card on a number 20px wide, one near the right edge flipped to its end, one
 * on a 14px number).
 */

type Offsets = ReturnType<typeof useWholePixelOffsets>;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A desktop's layout viewport: the slide without `pointAt` keeps a callout inside it.
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
});

async function offsetsFor(rect: { left: number; width: number }, pointAt?: 'start' | 'end'): Promise<Offsets> {
  let offsets: Offsets | undefined;
  const box = { left: rect.left, right: rect.left + rect.width, width: rect.width, top: 400, bottom: 413, height: 13 };
  function Probe() {
    const anchor = useRef({ getBoundingClientRect: () => box } as unknown as Element);
    offsets = useWholePixelOffsets(anchor, 12, 8, pointAt);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Probe />));
  return offsets!;
}

/** The popup's left edge after Base UI applies the offset to the edge it aligned (it negates an end-aligned one). */
function leftEdge(offsets: Offsets, rect: { left: number; width: number }, align: 'start' | 'end', width: number): number {
  const offset = offsets.alignOffset({ side: 'bottom', align, positioner: { width, height: 196 } });
  return align === 'end' ? rect.left + rect.width - width - offset : rect.left + offset;
}

describe('useWholePixelOffsets pointAt', () => {
  it('puts the start edge 20px before the anchor centre, rounded down', async () => {
    const marker = { left: 809, width: 20.38 };
    expect(leftEdge(await offsetsFor(marker, 'start'), marker, 'start', 464)).toBe(799);
    const narrow = { left: 759.67, width: 14.24 };
    expect(leftEdge(await offsetsFor(narrow, 'start'), narrow, 'start', 404)).toBe(746);
  });

  it('flipped to the end, ends 20px past the anchor’s start edge, rounded up', async () => {
    const marker = { left: 975.91, width: 14.25 };
    expect(leftEdge(await offsetsFor(marker, 'start'), marker, 'end', 464) + 464).toBe(996);
  });

  it('asked for the end, mirrors both', async () => {
    const marker = { left: 600.5, width: 20 };
    const offsets = await offsetsFor(marker, 'end');
    expect(leftEdge(offsets, marker, 'end', 300) + 300).toBe(631); // ceil(610.5 + 20)
    expect(leftEdge(offsets, marker, 'start', 300)).toBe(600); // floor(620.5 - 20)
  });

  it('without it, the start edge stays on the anchor’s', async () => {
    const marker = { left: 759.67, width: 14.24 };
    expect(leftEdge(await offsetsFor(marker), marker, 'start', 404)).toBe(759);
  });
});
