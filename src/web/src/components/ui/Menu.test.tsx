// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu';

/**
 * Keys that reach the Menu trigger after the menu has opened but before focus has moved into it.
 *
 * Base UI moves focus into an opened menu on the next animation frame. Here no frame runs until the
 * test says so, so every key after the one that opens the menu lands on the trigger, as keys queued
 * behind a busy main thread do (the burst probe in docs/evidence/base-ui-migration/p2-keyboard-window).
 * The reference is the same keys with the frames run after each one: focus already in the menu.
 */

type Key = 'ArrowDown' | 'ArrowUp' | 'Enter';

const ran: string[] = [];
// The fixture's attachment menu: a separator, and a disabled item that arrow keys skip.
const items: MenuItem[] = [
  { key: 'file', label: 'File', onSelect: () => ran.push('File') },
  { key: 'image', label: 'Image', onSelect: () => ran.push('Image') },
  { key: 'separator', type: 'separator' },
  { key: 'shell', label: 'Shell', onSelect: () => ran.push('Shell') },
  { key: 'skill', label: 'Skill', disabled: true, onSelect: () => ran.push('Skill') },
  { key: 'command', label: 'Command', onSelect: () => ran.push('Command') },
];

let frames = new Map<number, FrameRequestCallback>();
// Never reset: Base UI keeps the id of its last focus frame between tests, and cancels it on the next.
let nextFrame = 1;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Runs the held animation frames, and the frames they ask for, as the next paints would. */
async function runFrames(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 10 && frames.size > 0; round += 1) {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame(performance.now());
    }
  });
}

/** One key press on whatever has focus, as a browser delivers it: keydown, then for Enter on a button
 *  the click it activates unless the keydown was prevented (jsdom has no such default action), then keyup. */
async function press(key: Key): Promise<void> {
  await act(async () => {
    const target = document.activeElement ?? document.body;
    const keydown = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true });
    target.dispatchEvent(keydown);
    if (key === 'Enter' && !keydown.defaultPrevented && target instanceof HTMLButtonElement) {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    }
    target.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true }));
  });
}

const trigger = () => container!.querySelector('button')!;
const highlighted = () => document.querySelector('[role="menu"] [data-highlighted]')?.textContent ?? null;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  ran.length = 0;
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.set(nextFrame, frame);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => next.render(<Menu trigger={<button type="button">Add attachment</button>} items={items} />));
  trigger().focus();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  // Base UI's frame scheduler is shared: let it finish, so no held frame runs in the next test.
  await runFrames();
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

// Keys, the item the opening key highlights, and the item the sequence runs with focus in the menu.
const SEQUENCES: [keys: Key[], opensOn: string, runs: string][] = [
  [['ArrowDown', 'ArrowDown', 'Enter'], 'File', 'Image'],
  [['ArrowDown', 'Enter'], 'File', 'File'],
  [['ArrowDown', 'ArrowUp', 'Enter'], 'File', 'Command'],
  [['Enter', 'ArrowDown', 'Enter'], 'File', 'Image'],
  [['Enter', 'ArrowUp', 'Enter'], 'File', 'Command'],
  [['Enter', 'Enter'], 'File', 'File'],
  [['ArrowUp', 'Enter'], 'Command', 'Command'],
  [['ArrowUp', 'ArrowUp', 'Enter'], 'Command', 'Shell'],
  [['ArrowUp', 'ArrowDown', 'Enter'], 'Command', 'File'],
];

describe('Menu keys pressed before focus enters the open menu', () => {
  it.each(SEQUENCES)('%j with focus in the menu (the reference)', async ([opener, ...rest], opensOn, runs) => {
    await press(opener);
    await runFrames();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(highlighted()).toBe(opensOn);
    expect(document.activeElement?.textContent).toBe(opensOn);
    for (const key of rest) {
      await press(key);
      await runFrames();
    }
    expect(ran).toEqual([runs]);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it.each(SEQUENCES)('%j before focus enters the menu runs what the reference runs', async ([opener, ...rest], opensOn, runs) => {
    await press(opener);
    // The window: the menu is open on its first highlight, and focus is still on the trigger.
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(highlighted()).toBe(opensOn);
    expect(document.activeElement).toBe(trigger());
    for (const key of rest) await press(key);
    expect(ran).toEqual([runs]);
    await runFrames();
    expect(ran).toEqual([runs]);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Menu that leaves the arrow keys to the page', () => {
  it('lets ↑ and ↓ on its closed trigger reach the page, and keeps them once it is open', async () => {
    const reached: string[] = [];
    const onKey = (event: KeyboardEvent) => {
      if (event.key.startsWith('Arrow')) reached.push(event.key);
    };
    window.addEventListener('keydown', onKey);
    try {
      await act(async () => root!.render(<Menu trigger={<button type="button">Add attachment</button>} items={items} openOnArrowKeys={false} />));
      trigger().focus();
      await press('ArrowDown');
      await press('ArrowUp');
      await runFrames();
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
      expect(reached).toEqual(['ArrowDown', 'ArrowUp']);

      // Enter still opens it, and the open menu's arrows are its own.
      await press('Enter');
      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      expect(highlighted()).toBe('File');
      await press('ArrowDown');
      await runFrames();
      expect(highlighted()).toBe('Image');
      expect(reached).toEqual(['ArrowDown', 'ArrowUp']);
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('opens on the arrows by default', async () => {
    await press('ArrowDown');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(highlighted()).toBe('File');
  });
});
