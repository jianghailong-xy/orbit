// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useResizingAnchor } from './Floating';

/**
 * What a multiple select hands Base UI as its list's anchor: its field, until a commit finds the field's box
 * changed while the list is open (chips wrapping onto another row or back); then a new anchor for that box,
 * built as Base UI wraps an element, in that same commit.
 */

let roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
});

function mount() {
  const field = document.createElement('div');
  const box = { width: 188, height: 22 };
  field.getBoundingClientRect = () => ({ x: 24, y: 662, left: 24, top: 662, right: 24 + box.width, bottom: 662 + box.height, ...box }) as DOMRect;
  const seen: unknown[] = [];
  let anchorRef: unknown;
  function Probe({ open }: { open: boolean }) {
    const anchor = useRef<Element | null>(field);
    anchorRef = anchor;
    seen.push(useResizingAnchor(open, anchor));
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  const render = (open: boolean) => act(async () => root.render(<Probe open={open} />));
  return { field, box, seen, render, anchorRef: () => anchorRef };
}

it('hands over the field itself until its box changes while the list is open', async () => {
  const { box, seen, render, anchorRef } = mount();
  await render(false);
  await render(true);
  await render(true);
  box.height = 22; // re-rendered, same box
  await render(true);
  expect(new Set(seen)).toEqual(new Set([anchorRef()]));
});

it('hands over a new anchor for the field in the commit that resizes it, and again on the next resize', async () => {
  const { field, box, seen, render, anchorRef } = mount();
  await render(true);
  box.height = 42; // the third chip wraps onto a second row
  await render(true);
  const grown = seen.at(-1) as { getBoundingClientRect: () => DOMRect; contextElement: Element };
  expect(grown).not.toBe(anchorRef());
  expect(grown.contextElement).toBe(field);
  expect(grown.getBoundingClientRect().height).toBe(42);
  await render(true);
  expect(seen.at(-1)).toBe(grown);
  box.height = 22; // and back
  await render(true);
  expect(seen.at(-1)).not.toBe(grown);
  expect((seen.at(-1) as { contextElement: Element }).contextElement).toBe(field);
});

it('measures afresh on each opening: a resize while closed is not one', async () => {
  const { box, seen, render } = mount();
  await render(true);
  await render(false);
  box.height = 42;
  await render(false);
  await render(true);
  expect(new Set(seen).size).toBe(1);
});
