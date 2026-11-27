// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Popover } from './Popover';

/**
 * A popover without its arrow, as the replaced popover's `arrow={false}` drew the New Session engine list: the
 * panel alone, 4px from its trigger (its placement is measured against the replaced one in the P5.1 browser
 * comparison). Every other popover keeps its arrow.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function render(arrow?: boolean): Promise<void> {
  await act(async () => root!.render(
    <Popover open title={null} side="bottom" arrow={arrow} popupClassName="np-pop" trigger={<button type="button">Engine</button>}>
      <div className="np-list">Claude</div>
    </Popover>,
  ));
  await settle();
}

const popup = () => document.querySelector<HTMLElement>('.orbit-popover.np-pop');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  await settle();
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Popover arrow', () => {
  it('is drawn by default', async () => {
    await render();
    expect(popup()?.querySelector('.orbit-floating-arrow')).not.toBeNull();
    expect(popup()?.querySelector('.np-list')?.textContent).toBe('Claude');
  });

  it('is left out with arrow={false}, the content unchanged', async () => {
    await render(false);
    expect(popup()).not.toBeNull();
    expect(popup()!.querySelector('.orbit-floating-arrow')).toBeNull();
    expect(popup()!.querySelector('.orbit-popover-title')).toBeNull();
    expect(popup()!.querySelector('.np-list')?.textContent).toBe('Claude');
  });
});

describe('Popover on a trigger that is not a button', () => {
  it('makes the span a button that a click, Enter and Space open (P5.3: the composer’s context gauge)', async () => {
    for (const open of ['click', 'Enter', ' '] as const) {
      await act(async () => root!.render(
        <Popover title="Context" nativeButton={false} trigger={<span className="composer-usage" aria-label="Context window 42%">42%</span>}>
          <div className="cu-pop">Context window</div>
        </Popover>,
      ));
      await settle();
      const trigger = container!.querySelector<HTMLElement>('.composer-usage')!;
      expect(trigger.getAttribute('role')).toBe('button');
      expect(trigger.tabIndex).toBe(0);
      await act(async () => {
        trigger.focus();
        if (open === 'click') trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        else {
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: open, bubbles: true, cancelable: true }));
          trigger.dispatchEvent(new KeyboardEvent('keyup', { key: open, bubbles: true, cancelable: true }));
        }
      });
      await settle();
      expect(document.querySelector('.orbit-popover .cu-pop'), `opened by ${JSON.stringify(open)}`).not.toBeNull();
      await act(async () => root!.render(<></>));
      await settle();
    }
  });
});


describe('Popover closing', () => {
  async function openByMouse(): Promise<HTMLButtonElement> {
    await act(async () => root!.render(
      <div>
        <Popover title="Runner full" trigger={<button type="button" className="reason">runner full</button>}>
          <div className="pop-body">Both slots are taken.</div>
        </Popover>
        <div className="elsewhere">elsewhere</div>
      </div>,
    ));
    await settle();
    const trigger = container!.querySelector<HTMLButtonElement>('.reason')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(document.querySelector('.orbit-popover .pop-body')).not.toBeNull();
    return trigger;
  }

  it('leaves the trigger unfocused when a press outside closes it, so no focus ring is left behind', async () => {
    const trigger = await openByMouse();
    const elsewhere = container!.querySelector<HTMLElement>('.elsewhere')!;
    await act(async () => {
      elsewhere.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
      elsewhere.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      elsewhere.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }));
      elsewhere.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      elsewhere.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(document.querySelector('.orbit-popover .pop-body')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
  });

  it('still hands focus back to the trigger when Escape closes it', async () => {
    const trigger = await openByMouse();
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle();
    expect(document.querySelector('.orbit-popover .pop-body')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
