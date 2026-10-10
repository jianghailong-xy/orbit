// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu';

/**
 * Two things the session workspace's menus need (P5.3). A trigger that is not a `<button>` — the session list's
 * scope label and a folder's ⋯ are spans the page draws — is made a button by the menu (`nativeButton={false}`): the
 * button role, a Tab stop, Enter and Space. And an item can carry the native tip the replaced item's `title` gave it,
 * on an item that can run and on one that cannot (a session row's Complete that is unavailable says why).
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const ran: string[] = [];
const errors: unknown[][] = [];

async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const items: MenuItem[] = [
  { key: 'complete', label: 'Complete', disabled: true, title: 'Complete unavailable right now' },
  { key: 'pin', label: 'Pin', title: 'Keep it at the top', onSelect: () => ran.push('Pin') },
  { key: 'rename', label: 'Rename…', onSelect: () => ran.push('Rename') },
];

async function render(): Promise<HTMLElement> {
  await act(async () => root!.render(
    <Menu nativeButton={false} items={items} trigger={<span className="session-scope-menu" title="Switch view">Open</span>} />,
  ));
  await settle();
  return container!.querySelector<HTMLElement>('.session-scope-menu')!;
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  ran.length = 0;
  errors.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a menu on a trigger that is not a button', () => {
  it('makes the span a button: its role, a Tab stop, and the popup it opens', async () => {
    const trigger = await render();
    expect(trigger.tagName).toBe('SPAN');
    expect(trigger.getAttribute('role')).toBe('button');
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // Base UI's warning for a non-button rendered as a native button is not raised.
    expect(errors.flat().join(' ')).not.toMatch(/nativeButton/);
  });

  it('opens on a click, on Enter and on Space', async () => {
    for (const open of ['click', 'Enter', ' '] as const) {
      const trigger = await render();
      await act(async () => {
        trigger.focus();
        if (open === 'click') trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        else {
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: open, bubbles: true, cancelable: true }));
          trigger.dispatchEvent(new KeyboardEvent('keyup', { key: open, bubbles: true, cancelable: true }));
        }
      });
      await settle();
      expect(menu(), `opened by ${JSON.stringify(open)}`).not.toBeNull();
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      await act(async () => root!.render(<></>));
      await settle();
    }
  });
});

describe('an item’s native tip', () => {
  it('is on the item that runs and on the one that cannot', async () => {
    const trigger = await render();
    await act(async () => trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    await settle();
    expect(item('Complete')?.getAttribute('title')).toBe('Complete unavailable right now');
    expect(item('Complete')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('Pin')?.getAttribute('title')).toBe('Keep it at the top');
    expect(item('Rename…')?.hasAttribute('title')).toBe(false);
    await act(async () => item('Pin')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(ran).toEqual(['Pin']);
  });
});
