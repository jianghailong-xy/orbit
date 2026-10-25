// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from './Select';

/**
 * Keys that reach the Select trigger after the list has opened but before focus has moved into it.
 *
 * Base UI moves focus into an opened list on the next animation frame. Here no frame runs until the
 * test says so, so every key after the one that opens the list lands on the trigger, as keys queued
 * behind a busy main thread do (the burst probe in docs/evidence/base-ui-migration/p2-select-keys).
 * The reference is the same keys with the frames run after each one: focus already in the list.
 */

type Key = 'ArrowDown' | 'ArrowUp' | 'Enter';

// The share dialog's Expires choices, the last one disabled as in the choices fixture: arrow keys reach
// it (Base UI's Select passes no disabled indices) and Enter cannot pick it, so the list stays open.
const options: SelectOption[] = [
  { value: 'never', label: 'Never' },
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days', disabled: true },
];

// The same choices with the first one disabled: a list opened with no value starts on the next.
const firstDisabled: SelectOption[] = options.map((option, index) => index === 0 ? { ...option, disabled: true } : option);

const picked: (string | null)[] = [];

function Expires({ from, choices = options }: { from: string | null; choices?: SelectOption[] }) {
  const [value, setValue] = useState(from);
  return <Select aria-label="Expires" options={choices} value={value} onValueChange={(next) => { picked.push(next); setValue(next); }} />;
}

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

const trigger = () => container!.querySelector<HTMLElement>('[role="combobox"]')!;
const highlighted = () => document.querySelector('[role="listbox"] [data-highlighted]')?.textContent ?? null;

/** Renders the Select on the value `from`, with focus on its trigger. */
async function mount(from: string | null, choices?: SelectOption[]): Promise<void> {
  const next = createRoot(container!);
  root = next;
  await act(async () => next.render(<Expires from={from} choices={choices} />));
  trigger().focus();
}

/** A mouse press on the trigger, and the frame in which Base UI opens the list for its mousedown. Focus is moved
 *  into the list in the frame after that one, which is left to the test. */
async function pointerOpen(): Promise<void> {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    trigger().dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    trigger().dispatchEvent(new MouseEvent('mousedown', init));
    trigger().dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    trigger().dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    trigger().dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await act(async () => {
    const due = [...frames.values()];
    frames.clear();
    for (const frame of due) frame(performance.now());
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  picked.length = 0;
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.set(nextFrame, frame);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
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

// Keys, the value they start on, the option the opening key highlights, the values the sequence picks
// with focus in the list (none when Enter picks the current value: the list only closes), and the option
// still highlighted in a list left open (null when it closes). From 1 day, in the middle, an arrow's step
// differs from a jump to either end. From no value the opening highlight is not the value, so the Enter
// right after the opening key picks something, where an Enter that only closed the list would not.
const SEQUENCES: [keys: Key[], from: string | null, opensOn: string, picks: string[], leftOn: string | null][] = [
  [['ArrowDown', 'ArrowDown', 'Enter'], '1', '1 day', ['7'], null],
  [['ArrowDown', 'ArrowUp', 'Enter'], '1', '1 day', ['never'], null],
  [['ArrowDown', 'ArrowUp', 'ArrowUp', 'Enter'], '1', '1 day', ['never'], null],
  [['ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter'], '1', '1 day', [], '30 days'],
  [['ArrowDown', 'Enter'], '1', '1 day', [], null],
  [['ArrowUp', 'ArrowUp', 'Enter'], '1', '1 day', ['never'], null],
  [['ArrowUp', 'ArrowDown', 'Enter'], '1', '1 day', ['7'], null],
  [['Enter', 'ArrowDown', 'Enter'], '1', '1 day', ['7'], null],
  [['Enter', 'ArrowUp', 'Enter'], '1', '1 day', ['never'], null],
  [['Enter', 'Enter'], '1', '1 day', [], null],
  [['ArrowDown', 'Enter'], null, 'Never', ['never'], null],
  [['ArrowUp', 'Enter'], null, '7 days', ['7'], null],
  [['Enter', 'Enter'], null, 'Never', ['never'], null],
];

/** After the sequence: closed, or still open on the option `leftOn`. */
function expectEnd(leftOn: string | null) {
  expect(trigger().getAttribute('aria-expanded')).toBe(leftOn === null ? 'false' : 'true');
  if (leftOn !== null) expect(highlighted()).toBe(leftOn);
}

describe('Select keys pressed before focus enters the open list', () => {
  it.each(SEQUENCES)('%j from %j with focus in the list (the reference)', async ([opener, ...rest], from, opensOn, picks, leftOn) => {
    await mount(from);
    await press(opener);
    await runFrames();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(highlighted()).toBe(opensOn);
    expect(document.activeElement?.textContent).toBe(opensOn);
    for (const key of rest) {
      await press(key);
      await runFrames();
    }
    expect(picked).toEqual(picks);
    expectEnd(leftOn);
  });

  it.each(SEQUENCES)('%j from %j before focus enters the list picks what the reference picks', async ([opener, ...rest], from, opensOn, picks, leftOn) => {
    await mount(from);
    await press(opener);
    // The window: the list is open on its first highlight, and focus is still on the trigger.
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(highlighted()).toBe(opensOn);
    expect(document.activeElement).toBe(trigger());
    for (const key of rest) await press(key);
    expect(picked).toEqual(picks);
    await runFrames();
    expect(picked).toEqual(picks);
    expectEnd(leftOn);
  });
});

/**
 * A list opened without a key. Base UI highlights an option on opening only for the key that opened the list
 * or for the value; with no option holding the value, the replaced select still opened on its first enabled
 * option (rc-select's defaultActiveFirstOption), and Enter picked it.
 */

const CHOICES = { 'all options': options, 'the first option disabled': firstDisabled };

// Keys after a pointer opens the list, the value they start on, the choices, the option the list opens on, and
// the values the keys pick (none when Enter picks the current value: the list only closes).
const POINTER_SEQUENCES: [keys: Key[], from: string | null, choices: keyof typeof CHOICES, opensOn: string, picks: string[]][] = [
  [['Enter'], null, 'all options', 'Never', ['never']],
  [['ArrowDown', 'Enter'], null, 'all options', 'Never', ['1']],
  [['Enter'], null, 'the first option disabled', '1 day', ['1']],
  [['ArrowDown', 'Enter'], null, 'the first option disabled', '1 day', ['7']],
  // A value no option holds opens as no value does.
  [['Enter'], 'gone', 'all options', 'Never', ['never']],
  [['Enter'], '7', 'all options', '7 days', []],
];

describe('Select opened by the pointer', () => {
  it.each(POINTER_SEQUENCES)('%j from %j with %s opens on its option and picks with focus in the list', async (keys, from, choices, opensOn, picks) => {
    await mount(from, CHOICES[choices]);
    await pointerOpen();
    await runFrames();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(highlighted()).toBe(opensOn);
    expect(document.activeElement?.textContent).toBe(opensOn);
    for (const key of keys) {
      await press(key);
      await runFrames();
    }
    expect(picked).toEqual(picks);
    expectEnd(null);
  });

  it.each(POINTER_SEQUENCES)('%j from %j with %s before focus enters the list picks what the reference picks', async (keys, from, choices, _opensOn, picks) => {
    await mount(from, CHOICES[choices]);
    await pointerOpen();
    // The window: the list is open and focus is still on the trigger.
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(trigger());
    for (const key of keys) await press(key);
    expect(picked).toEqual(picks);
    await runFrames();
    expect(picked).toEqual(picks);
    expectEnd(null);
  });

  it('opens on the first option only as it opens: the list taking focus back later leaves the highlight to Base UI', async () => {
    await mount(null);
    await pointerOpen();
    await runFrames();
    expect(highlighted()).toBe('Never');
    const list = document.querySelector<HTMLElement>('.orbit-select-popup')!;
    const option = [...list.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent === '7 days')!;
    await act(async () => {
      list.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', movementX: 1 }));
      option.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 1 }));
    });
    await runFrames();
    expect(highlighted()).toBe('7 days');
    // The pointer leaves the options: Base UI clears the highlight and focuses the list again.
    await act(async () => {
      option.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
    });
    await runFrames();
    expect(document.activeElement).toBe(list);
    expect(highlighted()).not.toBe('Never');
  });
});
