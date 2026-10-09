// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tooltip } from './Tooltip';

/**
 * A press on a tip's trigger. By default it only closes an open tip (Base UI's closeOnClick); with
 * `toggleOnClick` it opens a closed one and closes an open one, as the replaced tip's click trigger did —
 * how a touch reader reaches a Wiki mark's explanation and the links in it.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount(toggleOnClick: boolean): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <Tooltip content={<span>Says why</span>} toggleOnClick={toggleOnClick}>
        <span className="mark" tabIndex={0}>
          A marked sentence
        </span>
      </Tooltip>,
    );
  });
  await settle();
}

/** A mouse press as a browser delivers it: pointer and mouse down and up, then the click. */
async function press(element: Element): Promise<void> {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    element.dispatchEvent(new MouseEvent('mousedown', init));
    element.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    element.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
}

const mark = () => container!.querySelector<HTMLElement>('.mark')!;
const tip = () => document.body.querySelector('[role="tooltip"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
});

describe('Tooltip toggleOnClick', () => {
  it('opens on a press, closes on the next, and names the tip as the trigger’s description while open', async () => {
    await mount(true);
    expect(tip()).toBeNull();
    await press(mark());
    expect(tip()?.textContent).toBe('Says why');
    expect(mark().getAttribute('aria-describedby')).toBe(tip()!.id);
    await press(mark());
    expect(tip()).toBeNull();
  });

  it('closes on Escape like any tip', async () => {
    await mount(true);
    await press(mark());
    expect(tip()).not.toBeNull();
    await act(async () => {
      mark().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(tip()).toBeNull();
  });

  it('without it, a press opens nothing', async () => {
    await mount(false);
    await press(mark());
    expect(tip()).toBeNull();
  });
});
