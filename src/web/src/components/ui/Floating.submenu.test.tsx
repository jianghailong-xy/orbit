// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSubmenuPlacement } from './Floating';

/**
 * Where a level down goes beside its row. By default it flips to the row's other side when it does not fit on the
 * right, and never slides (the replaced submenu's `rightTop`). With `slide` (P5.3) what still hangs off the screen
 * after the flip comes back into it, over its own menu — the case is the composer's model menu on a 390px phone as
 * rc-trigger placed its Provider level: the row at x 108–300, the level 211.8px wide, drawn at x 0.
 */

type Placement = ReturnType<typeof useSubmenuPlacement>;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 390 });
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 0 });
});

async function placementFor(row: { left: number; width: number }, slide?: boolean): Promise<Placement> {
  let placement: Placement | undefined;
  const box = { left: row.left, right: row.left + row.width, width: row.width, top: 573, bottom: 605, height: 32 };
  function Probe() {
    const anchor = useRef({ getBoundingClientRect: () => box } as unknown as Element);
    placement = useSubmenuPlacement(anchor, slide);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Probe />));
  return placement!;
}

/** The level's left edge for a side offset Base UI applies on `side`. */
const leftEdge = (row: { left: number; width: number }, side: 'left' | 'right', offset: number, width: number) =>
  side === 'left' ? row.left - offset - width : row.left + row.width + offset;

const ROW = { left: 108, width: 192 };
const LEVEL = { width: 211.8, height: 168 };

describe('useSubmenuPlacement', () => {
  it('flips to the row’s left side when the right does not fit, and leaves what hangs off the screen there', async () => {
    const { sideOffset } = await placementFor(ROW);
    expect(sideOffset({ side: 'right', align: 'start', positioner: LEVEL })).toBe(1e6);
    const offset = sideOffset({ side: 'left', align: 'start', positioner: LEVEL });
    expect(leftEdge(ROW, 'left', offset, LEVEL.width)).toBe(-104);
  });

  it('with slide, brings the flipped level back onto the screen over its own menu', async () => {
    const { sideOffset } = await placementFor(ROW, true);
    expect(sideOffset({ side: 'right', align: 'start', positioner: LEVEL })).toBe(1e6);
    const offset = sideOffset({ side: 'left', align: 'start', positioner: LEVEL });
    expect(offset).toBeLessThan(0);
    expect(leftEdge(ROW, 'left', offset, LEVEL.width)).toBe(0);
  });

  it('with slide, leaves a level that fits where the flip puts it', async () => {
    const row = { left: 260, width: 120 };
    const { sideOffset } = await placementFor(row, true);
    const offset = sideOffset({ side: 'left', align: 'start', positioner: { width: 200, height: 100 } });
    expect(leftEdge(row, 'left', offset, 200)).toBe(60);
  });
});
