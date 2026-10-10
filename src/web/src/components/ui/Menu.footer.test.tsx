// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu';

/**
 * Two parts of the Menu a page styles or types into: an item's own class (the account menu's profile row), and
 * the footer under the items (the merge-target menu's branch search), whose keys are its own — Base UI's
 * typeahead would otherwise take every letter typed there as a jump to the item it starts — while Escape still
 * closes the menu.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const picked: string[] = [];

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const branches: MenuItem[] = ['main', 'develop', 'release/1.0'].map((name) => ({
  key: name,
  label: name,
  onSelect: () => picked.push(name),
}));

function Search({ items }: { items: MenuItem[] }) {
  const [query, setQuery] = useState('');
  return (
    <Menu trigger={<button type="button">Choose a branch</button>} items={items} side="top" align="end"
      footer={<input aria-label="Search branches" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />} />
  );
}

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => root!.render(node));
  await settle();
}

/** Opens the menu with its button. jsdom's click has no pointer behind it, so Base UI opens it as from the keyboard,
 *  on its first item; a test that types in the footer puts focus there first, as a press on the field would. */
async function open(): Promise<void> {
  await act(async () => container!.querySelector('button')!.click());
  await settle();
}

/** One key pressed where focus is; returns whether something took it from its target (preventDefault). */
async function press(key: string): Promise<boolean> {
  let taken = false;
  await act(async () => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (document.activeElement ?? document.body).dispatchEvent(event);
    taken = event.defaultPrevented;
  });
  await settle();
  return taken;
}

const trigger = () => container!.querySelector('button')!;
const search = () => document.querySelector<HTMLInputElement>('[role="menu"] .orbit-menu-footer input');
const highlighted = () => document.querySelector('[role="menu"] [data-highlighted]')?.textContent ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  picked.length = 0;
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

describe('Menu item class', () => {
  it('lands on the item itself, a submenu trigger included', async () => {
    await render(<Menu trigger={<button type="button">Account</button>} items={[
      { key: 'profile', label: 'Profile', className: 'tp-account-profile' },
      { key: 'appearance', label: 'Appearance', className: 'appearance-row', children: [{ key: 'dark', label: 'Dark' }] },
      { key: 'settings', label: 'Settings' },
    ]} />);
    await open();
    const rows = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    expect(rows.map((row) => row.textContent)).toEqual(['Profile', 'Appearance', 'Settings']);
    expect(rows[0].className).toBe('orbit-menu-item tp-account-profile');
    expect(rows[1].classList.contains('appearance-row')).toBe(true);
    expect(rows[1].classList.contains('orbit-menu-item')).toBe(true);
    expect(rows[2].className).toBe('orbit-menu-item');
  });
});

describe('Menu footer', () => {
  it('sits under the items, which scroll in their own box', async () => {
    await render(<Search items={branches} />);
    await open();
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.classList.contains('orbit-menu-footed')).toBe(true);
    expect([...menu.children].map((child) => child.className)).toEqual(['orbit-menu-list', 'orbit-menu-footer']);
    expect([...menu.querySelectorAll('.orbit-menu-list [role="menuitem"]')].map((row) => row.textContent))
      .toEqual(['main', 'develop', 'release/1.0']);
  });

  it('keeps the letters and arrows typed in it, where the items would have taken them', async () => {
    await render(<Search items={branches} />);
    await open();
    const before = highlighted();
    await act(async () => search()!.focus());
    for (const key of ['d', 'r', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
      expect(await press(key), key).toBe(false);
      expect(highlighted(), key).toBe(before);
      expect(document.activeElement, key).toBe(search());
    }
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(picked).toEqual([]);
  });

  it('without it, the same letter is the items\' typeahead (the reference)', async () => {
    await render(<Search items={branches} />);
    await open();
    expect(await press('d')).toBe(true);
    expect(highlighted()).toBe('develop');
  });

  it('opened from the keyboard, starts on the first item as every menu does', async () => {
    await render(<Search items={branches} />);
    trigger().focus();
    await act(async () => {
      trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    await settle();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(highlighted()).toBe('main');
    expect(document.activeElement?.textContent).toBe('main');
    expect(search()).not.toBeNull();
  });

  it('lets Escape close the menu, focus going back to its button', async () => {
    await render(<Search items={branches} />);
    await open();
    await act(async () => search()!.focus());
    await press('Escape');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('draws no item box when there are no items, only the footer', async () => {
    await render(<Search items={[]} />);
    await open();
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.querySelector('.orbit-menu-list')).toBeNull();
    expect(menu.querySelector('.orbit-menu-footer input')).not.toBeNull();
  });

  it('leaves a menu without one as it was', async () => {
    await render(<Menu trigger={<button type="button">Choose</button>} items={branches} />);
    await open();
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.classList.contains('orbit-menu-footed')).toBe(false);
    expect(menu.querySelector('.orbit-menu-list, .orbit-menu-footer')).toBeNull();
    expect([...menu.children].map((child) => child.getAttribute('role'))).toEqual(['menuitem', 'menuitem', 'menuitem']);
  });
});
