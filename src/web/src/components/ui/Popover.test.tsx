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
