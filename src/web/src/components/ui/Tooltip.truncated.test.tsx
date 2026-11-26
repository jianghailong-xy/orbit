// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCutOff, Tooltip } from './Tooltip';
import { hoverTooltip } from '../../test/tooltipHover';

/**
 * The tip of a label that may not fit opens only while the label, or something in it, is cut off: a title that fits
 * repeats nothing (docs/mocks/web-tooltips-c, Q1). jsdom lays nothing out, so each case gives the boxes their sizes.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
});

function size(element: Element, box: { client: [number, number]; scroll: [number, number] }) {
  for (const [key, value] of [
    ['clientWidth', box.client[0]], ['clientHeight', box.client[1]], ['scrollWidth', box.scroll[0]], ['scrollHeight', box.scroll[1]],
  ] as const) Object.defineProperty(element, key, { configurable: true, value });
}

const LONG = 'Migrate the billing webhooks to the new event bus and backfill November';

async function mount(): Promise<HTMLElement> {
  await act(async () => root!.render(
    <Tooltip content={LONG} truncatedOnly><span className="row"><span className="title">{LONG}</span></span></Tooltip>,
  ));
  return container!.querySelector<HTMLElement>('.row')!;
}

describe('a tip that opens only on a cut-off label', () => {
  it('opens when the label itself is cut off, wide, after the text delay', async () => {
    const row = await mount();
    size(row, { client: [200, 20], scroll: [480, 20] });
    expect(await hoverTooltip(row, 300)).toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toBe(LONG);
    expect(tip?.classList.contains('orbit-tooltip-wide')).toBe(true);
  });

  it('opens when a child is the one cut off (the ellipsis sits inside the row)', async () => {
    const row = await mount();
    size(row, { client: [240, 20], scroll: [240, 20] });
    size(row.querySelector('.title')!, { client: [180, 20], scroll: [480, 20] });
    expect(await hoverTooltip(row)).toBe(LONG);
  });

  it('opens on a label clamped to two lines', async () => {
    const row = await mount();
    size(row, { client: [240, 38], scroll: [240, 76] });
    expect(await hoverTooltip(row)).toBe(LONG);
  });

  it('stays shut on a label that fits', async () => {
    const row = await mount();
    size(row, { client: [480, 20], scroll: [480, 20] });
    expect(await hoverTooltip(row)).toBeNull();
  });

  it('reads an element with no box (inline, hidden) as not cut off', () => {
    const span = document.createElement('span');
    expect(isCutOff(span)).toBe(false);
    expect(isCutOff(null)).toBe(false);
  });
});
