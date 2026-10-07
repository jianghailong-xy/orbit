// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { Menu, type MenuItem } from './Menu';
import { Select } from './Select';

/**
 * Keys that arrive after a popup opened and before focus has moved into it.
 *
 * Base UI moves focus into an opened popup on the next animation frame; until then a key reaches whatever
 * still has focus (a menu trigger, a submenu trigger, a dialog's opener). Here no frame runs until the test
 * says so, as keys queued behind a busy main thread arrive (the probes in
 * docs/evidence/base-ui-migration/p2-keyboard-window-2). Each sequence is played twice: with the frames
 * run after every key (focus already in the popup: the reference) and with none run (the window), and the
 * two must end alike. Menu.test.tsx covers the root menu's arrows and Enter the same way.
 *
 * jsdom has no default actions, so `press` performs the browser's: Enter activates a focused button, Space
 * one that took the keydown, Tab moves focus along the document's tab order (wrapping as the probes'
 * browsers do), each unless the keydown was prevented.
 */

let frames = new Map<number, FrameRequestCallback>();
// Never reset: Base UI keeps the id of its last focus frame between tests and cancels it on the next.
let nextFrame = 1;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function runFrames(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 10 && frames.size > 0; round += 1) {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame(performance.now());
    }
  });
}

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]';
function tabbable(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter((element) => element.tabIndex >= 0
    && !(element as HTMLButtonElement).disabled && !element.closest('[hidden],[inert]'));
}
function moveFocus(backward: boolean): void {
  const list = tabbable();
  const active = document.activeElement as HTMLElement | null;
  let index = active ? list.indexOf(active) : -1;
  if (index === -1 && active && active !== document.body) {
    // Focus is on something outside the order: continue from its place in the document.
    const after = list.findIndex((element) => active.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    index = backward ? (after === -1 ? list.length : after) : (after === -1 ? list.length : after) - 1;
  }
  const next = list[(index + (backward ? -1 : 1) + list.length) % list.length];
  next?.focus();
}

type Key = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'Enter' | 'Space' | 'Tab' | 'Shift+Tab' | 'Escape';
async function press(name: Key): Promise<void> {
  await act(async () => {
    const shiftKey = name === 'Shift+Tab';
    const key = name === 'Space' ? ' ' : shiftKey ? 'Tab' : name;
    const init = { key, code: name === 'Space' ? 'Space' : key, bubbles: true, cancelable: true, shiftKey };
    const target = (document.activeElement ?? document.body) as HTMLElement;
    const keydown = new KeyboardEvent('keydown', init);
    target.dispatchEvent(keydown);
    // As in the browser, the default action uses the element focused once the keydown handlers have run.
    const focused = (document.activeElement ?? document.body) as HTMLElement;
    if (!keydown.defaultPrevented) {
      if (key === 'Enter' && focused instanceof HTMLButtonElement && !focused.disabled) focused.click();
      if (key === 'Tab') moveFocus(shiftKey);
    }
    const pressed = key === ' ' && !keydown.defaultPrevented && focused instanceof HTMLButtonElement ? focused : null;
    const keyup = new KeyboardEvent('keyup', init);
    (document.activeElement ?? document.body).dispatchEvent(keyup);
    if (pressed && !keyup.defaultPrevented && document.activeElement === pressed) pressed.click();
  });
}

const ran: string[] = [];
async function render(node: React.ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => next.render(node));
}
const byText = (role: string, text: string) => [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)]
  .find((element) => element.textContent?.trim() === text) ?? null;
const button = (name: string) => [...document.querySelectorAll<HTMLElement>('button')]
  .find((element) => (element.getAttribute('aria-label') ?? element.textContent)?.trim() === name) ?? null;
const focus = () => {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return 'body';
  const role = active.getAttribute('role') ?? active.tagName.toLowerCase();
  return role === 'dialog' || role === 'alertdialog' ? role : `${role}:${(active.getAttribute('aria-label') ?? active.textContent ?? '').trim()}`;
};
const shown = (role: string) => document.querySelectorAll(`[role="${role}"]`).length;
// Base UI keeps a select's list mounted after it closes; its trigger says whether it is open.
const expanded = () => document.querySelector('[role="combobox"]')?.getAttribute('aria-expanded');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  ran.length = 0;
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.set(nextFrame, frame);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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

/** Plays `keys` from `start`, the reference with frames after each key or the window with none until the end. */
async function play(keys: Key[], window: boolean, assertWindow: () => void) {
  const [opener, ...rest] = keys;
  await press(opener);
  if (window) assertWindow();
  else await runFrames();
  for (const key of rest) {
    await press(key);
    if (!window) await runFrames();
  }
  const before = { ran: [...ran], focus: focus() };
  await runFrames();
  return { ...before, after: { ran: [...ran], focus: focus() } };
}

// The choices fixture's session menu: items around a submenu, one of them dangerous.
const pick = (key: string) => () => ran.push(key);
const PARENT = ['default', 'group', 'delete'];
const sessionItems: MenuItem[] = [
  { key: 'default', label: 'Default model', onSelect: pick('default') },
  { key: 'provider', label: 'Provider', children: [{ key: 'codex', label: 'Codex', onSelect: pick('codex') }, { key: 'claude', label: 'Claude', onSelect: pick('claude') }] },
  { key: 'separator', type: 'separator' },
  { key: 'group', label: 'Group by tag', onSelect: pick('group') },
  { key: 'delete', label: 'Delete', danger: true, onSelect: pick('delete') },
];

describe('a submenu opened from the keyboard', () => {
  // Keys from Provider with the parent menu open, and what the reference ends with: the item it runs and
  // where focus is (the root trigger after a run, Provider after the submenu closes).
  const SEQUENCES: [keys: Key[], runs: string[], focusAfter: string][] = [
    [['ArrowRight', 'Enter'], ['codex'], 'button:Session actions'],
    [['ArrowRight', 'ArrowDown', 'Enter'], ['claude'], 'button:Session actions'],
    [['ArrowRight', 'ArrowUp', 'Enter'], ['claude'], 'button:Session actions'],
    [['ArrowRight', 'Home', 'Enter'], ['codex'], 'button:Session actions'],
    [['ArrowRight', 'End', 'Enter'], ['claude'], 'button:Session actions'],
    [['ArrowRight', 'Space'], ['codex'], 'button:Session actions'],
    [['ArrowRight', 'ArrowLeft'], [], 'menuitem:Provider'],
    [['Enter', 'Enter'], ['codex'], 'button:Session actions'],
    [['Enter', 'ArrowDown', 'Enter'], ['claude'], 'button:Session actions'],
  ];
  async function openOnProvider() {
    await render(<><button type="button">Before</button>
      <Menu trigger={<button type="button">Session actions</button>} items={sessionItems} />
      <button type="button">After</button></>);
    button('Session actions')!.focus();
    await press('Enter');
    await runFrames();
    await press('ArrowDown');
    await runFrames();
    expect(focus()).toBe('menuitem:Provider');
  }
  it.each(SEQUENCES)('%j with focus in the submenu (the reference)', async (keys, runs, focusAfter) => {
    await openOnProvider();
    const result = await play(keys, false, () => {});
    expect(result.ran).toEqual(runs);
    expect(result.after).toEqual({ ran: runs, focus: focusAfter });
  });
  it.each(SEQUENCES)('%j before focus enters the submenu runs no parent item and ends as the reference', async (keys, runs, focusAfter) => {
    await openOnProvider();
    const result = await play(keys, true, () => {
      // The window: the submenu is open on its first item and focus is still on its trigger.
      expect(shown('menu')).toBe(2);
      expect(document.querySelectorAll('[role="menu"]')[1].querySelector('[data-highlighted]')?.textContent).toBe('Codex');
      expect(focus()).toBe('menuitem:Provider');
    });
    expect(result.ran.filter((key) => PARENT.includes(key))).toEqual([]);
    expect(result.ran).toEqual(runs);
    expect(result.after).toEqual({ ran: runs, focus: focusAfter });
  });
});

// The fixture's attachment menu, between two other buttons.
const attachmentItems: MenuItem[] = [
  { key: 'file', label: 'File', onSelect: pick('file') },
  { key: 'image', label: 'Image', onSelect: pick('image') },
  { key: 'separator', type: 'separator' },
  { key: 'shell', label: 'Shell', onSelect: pick('shell') },
];

describe('Tab and Shift+Tab after a menu opened from the keyboard', () => {
  // The menu convention (coordinator, 2026-10-07): with focus in the menu, Tab leaves it and closes it and
  // Shift+Tab closes it back onto its trigger; a following Enter acts where focus went.
  const SEQUENCES: [keys: Key[], runs: string[], focusAfter: string][] = [
    [['Enter', 'Tab'], [], 'button:After'],
    [['Enter', 'Tab', 'Enter'], ['after'], 'button:After'],
    [['Enter', 'Shift+Tab'], [], 'button:Add attachment'],
    [['ArrowDown', 'Tab'], [], 'button:After'],
  ];
  async function open() {
    await render(<><button type="button">Before</button>
      <Menu trigger={<button type="button">Add attachment</button>} items={attachmentItems} />
      <button type="button" onClick={pick('after')}>After</button></>);
    button('Add attachment')!.focus();
  }
  it.each(SEQUENCES)('%j with focus in the menu (the reference)', async (keys, runs, focusAfter) => {
    await open();
    const result = await play(keys, false, () => {});
    expect(result.after).toEqual({ ran: runs, focus: focusAfter });
    expect(shown('menu')).toBe(0);
  });
  it.each(SEQUENCES)('%j before focus enters the menu ends as the reference', async (keys, runs, focusAfter) => {
    await open();
    const result = await play(keys, true, () => {
      expect(shown('menu')).toBe(1);
      expect(focus()).toBe('button:Add attachment');
    });
    expect(result).toEqual({ ran: runs, focus: focusAfter, after: { ran: runs, focus: focusAfter } });
    expect(shown('menu')).toBe(0);
  });
});

function Expires() {
  const [value, setValue] = useState<string | null>('never');
  return <><button type="button">Before</button>
    <Select aria-label="Expires" options={[{ value: 'never', label: 'Never' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days', disabled: true }]}
      value={value} onValueChange={(next) => { setValue(next); ran.push(`value ${next}`); }} clearable />
    <button type="button">After</button></>;
}

describe('Tab and Shift+Tab after a select opened from the keyboard', () => {
  // With focus in the list, Tab closes it and moves on past the select; Shift+Tab closes it back onto the select.
  const SEQUENCES: [keys: Key[], focusAfter: string][] = [
    [['ArrowDown', 'Tab'], 'button:After'],
    [['Enter', 'Tab'], 'button:After'],
    [['ArrowDown', 'Shift+Tab'], 'combobox:Expires'],
  ];
  async function open() {
    await render(<Expires />);
    document.querySelector<HTMLElement>('[role="combobox"]')!.focus();
  }
  it.each(SEQUENCES)('%j with focus in the list (the reference)', async (keys, focusAfter) => {
    await open();
    const result = await play(keys, false, () => {});
    expect(result.after).toEqual({ ran: [], focus: focusAfter });
    expect(expanded()).toBe('false');
  });
  it.each(SEQUENCES)('%j before focus enters the list ends as the reference', async (keys, focusAfter) => {
    await open();
    const result = await play(keys, true, () => {
      expect(expanded()).toBe('true');
      expect(focus()).toBe('combobox:Expires');
    });
    expect(result).toEqual({ ran: [], focus: focusAfter, after: { ran: [], focus: focusAfter } });
    expect(expanded()).toBe('false');
  });
});

function DialogPage({ confirm }: { confirm: boolean }) {
  const [open, setOpen] = useState(false);
  const close = (what: string) => () => { ran.push(what); setOpen(false); };
  return <>
    <button type="button" onClick={() => setOpen(true)}>Open</button>
    <button type="button" onClick={pick('next')}>Next</button>
    {confirm
      ? <ConfirmDialog open={open} onClose={(confirmed) => { ran.push(confirmed ? 'confirmed' : 'cancelled'); setOpen(false); }}
        title="Delete runner?" confirmText="Delete" danger onConfirm={() => {}} />
      : <Dialog open={open} onClose={close('closed')} title="Edit workspace"
        footer={<><button type="button" onClick={close('cancel')}>Cancel</button><button type="button" onClick={close('save')}>Save</button></>}>
        <input aria-label="Name" />
      </Dialog>}
  </>;
}

describe('keys after a dialog opened from the keyboard', () => {
  // [keys, what ran, focus at the end]: Dialog focuses itself, ConfirmDialog its Cancel button; both return
  // focus to the opener when they close.
  const DIALOG: [keys: Key[], runs: string[], focusAfter: string][] = [
    [['Enter', 'Enter'], [], 'dialog'],
    [['Enter', 'Tab'], [], 'button:Close'],
    [['Enter', 'Tab', 'Enter'], ['closed'], 'button:Open'],
    [['Enter', 'Shift+Tab'], [], 'button:Save'],
    [['Enter', 'Escape'], ['closed'], 'button:Open'],
  ];
  const CONFIRM: [keys: Key[], runs: string[], focusAfter: string][] = [
    [['Enter', 'Enter'], ['cancelled'], 'button:Open'],
    [['Enter', 'Space'], ['cancelled'], 'button:Open'],
    [['Enter', 'Tab'], [], 'button:Delete'],
    [['Enter', 'Tab', 'Enter'], ['confirmed'], 'button:Open'],
    [['Enter', 'Escape'], ['cancelled'], 'button:Open'],
  ];
  for (const [kind, sequences] of [['Dialog', DIALOG], ['ConfirmDialog', CONFIRM]] as const) {
    it.each(sequences)(`${kind} %j with focus in the dialog (the reference)`, async (keys, runs, focusAfter) => {
      await render(<DialogPage confirm={kind === 'ConfirmDialog'} />);
      button('Open')!.focus();
      const result = await play(keys, false, () => {});
      expect(result.after).toEqual({ ran: runs, focus: focusAfter });
    });
    it.each(sequences)(`${kind} %j before the next frame ends as the reference`, async (keys, runs, focusAfter) => {
      await render(<DialogPage confirm={kind === 'ConfirmDialog'} />);
      button('Open')!.focus();
      const result = await play(keys, true, () => expect(shown(kind === 'Dialog' ? 'dialog' : 'alertdialog')).toBe(1));
      expect(result.ran).toEqual(runs);
      expect(result.after).toEqual({ ran: runs, focus: focusAfter });
    });
  }
});
