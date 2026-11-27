// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu';

/**
 * An icon-only menu trigger's tip is the app's Tooltip, not the browser's `title` (the session header's ⋯): it opens on
 * focus and hover, keeps the trigger's own accessible name, and is gone while the menu is open, so it never covers it.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(ms = 0): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
  }
}

const items: MenuItem[] = [{ key: 'rename', label: 'Rename…', onSelect: () => {} }];
const trigger = () => container!.querySelector<HTMLButtonElement>('button.more')!;
const tip = () => document.body.querySelector('[role="tooltip"]');
const menu = () => document.querySelector('[role="menu"]');

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(
    <Menu tooltip="More actions" items={items} trigger={<button type="button" className="more" aria-label="More actions">⋯</button>} />,
  ));
  await settle();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

describe('a menu trigger with a tooltip', () => {
  it('shows the app tooltip on focus, with no native title, and keeps its own name', async () => {
    expect(trigger().hasAttribute('title')).toBe(false);
    expect(trigger().getAttribute('aria-label')).toBe('More actions');
    await act(async () => { trigger().focus(); });
    await settle(60);
    expect(tip()?.textContent).toBe('More actions');
    expect(tip()?.closest('.orbit-floating-positioner')?.getAttribute('data-side')).toBe('bottom');
  });

  it('hides the tooltip while the menu is open, and still opens the menu', async () => {
    await act(async () => { trigger().focus(); });
    await settle(60);
    expect(tip()).not.toBeNull();
    await act(async () => { trigger().click(); });
    await settle(60);
    expect(menu()).not.toBeNull();
    expect(tip()).toBeNull();
  });
});
