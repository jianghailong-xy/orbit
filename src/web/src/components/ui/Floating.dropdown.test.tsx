// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDropdownPlacement } from './Floating';

/**
 * An end-aligned list's fractional left edge (P5.3). The case is the session list's scope menu at 1280px: its trigger
 * ends at x 580, the list is 143.796875px wide in layout, and Floating UI reads it from the computed style as 143.797.
 * The replaced dropdown's left edge was 436.203125, so the Filter by Tag row ended at 576 and its level down started
 * there; a fraction taken from 143.797 lands 1/64px short of that and the level down a pixel left.
 */

type Placement = ReturnType<typeof useDropdownPlacement>;
let roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1280 });
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 0 });
});

async function placementFor(align: 'start' | 'end', listWidth: number): Promise<{ placement: Placement; positioner: HTMLDivElement }> {
  let placement: Placement | undefined;
  const trigger = { left: 506, right: 580, width: 74, top: 30, bottom: 52, height: 22 };
  function Probe() {
    const anchor = useRef({ getBoundingClientRect: () => trigger } as unknown as Element);
    placement = useDropdownPlacement(true, anchor, 4, align);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Probe />));
  const positioner = document.createElement('div');
  positioner.getBoundingClientRect = () => ({ width: listWidth, height: 218 }) as DOMRect;
  placement!.positioner.current = positioner;
  return { placement: placement!, positioner };
}

const subpixel = (positioner: HTMLDivElement) => positioner.style.getPropertyValue('--orbit-dropdown-subpixel');

describe('useDropdownPlacement', () => {
  it('gives an end-aligned list the fractional left edge of its own box, not of the computed style’s width', async () => {
    const { placement, positioner } = await placementFor('end', 143.796875);
    placement.alignOffset({ side: 'bottom', align: 'end', positioner: { width: 143.797, height: 218 } });
    expect(subpixel(positioner)).toBe('0.203125px');
  });

  it('keeps a start-aligned list on its whole-pixel edge', async () => {
    const { placement, positioner } = await placementFor('start', 143.796875);
    placement.alignOffset({ side: 'bottom', align: 'start', positioner: { width: 143.797, height: 218 } });
    expect(subpixel(positioner)).toBe('0px');
  });

  it('falls back to the measured width where the box has none yet', async () => {
    const { placement, positioner } = await placementFor('end', 0);
    placement.alignOffset({ side: 'bottom', align: 'end', positioner: { width: 143.75, height: 218 } });
    expect(subpixel(positioner)).toBe('0.25px');
  });
});
