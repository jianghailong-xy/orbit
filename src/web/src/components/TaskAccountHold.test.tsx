// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskAccountHold } from '../lib/accountHealth';
import { accountHoldLineText, RelaxedRunNote, TaskAccountHoldLine, TaskAccountHoldNote } from './TaskAccountHold';
import { hoverTooltip } from '../test/tooltipHover';

const hold: TaskAccountHold = {
  kind: 'ACCOUNT_NEEDS_ACTION',
  reason: 'Waiting for an account: Cursor said "Add a payment method to continue". Next try at 21:19.',
  until: '2026-11-22T21:19:00.000Z',
  accounts: [{ provider: 'cursor', engine: 'cursor', line: 'Cursor said "Add a payment method to continue"', until: '2026-11-22T21:19:00.000Z' }],
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The day of the next try, in whatever zone this runs in: the row gives a bare clock time only for today.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(hold.until).setHours(0, 0, 0, 0));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('a task held for an account', () => {
  it('says Held, the provider\'s words, the next try and links to the account row', () => {
    act(() => root.render(<MemoryRouter><TaskAccountHoldNote hold={hold} /></MemoryRouter>));
    const note = host.querySelector('[data-testid="task-account-hold"]')!;
    expect(note.textContent).toContain('Held');
    expect(note.textContent).toContain('Cursor said "Add a payment method to continue"');
    expect(note.textContent).toContain('Next try at 21:19');
    expect(note.querySelector('a')!.getAttribute('href')).toBe('/settings/machines');
    expect(note.querySelectorAll('a')).toHaveLength(1);
  });

  it('a pinned task also links the setting that would let it run elsewhere', () => {
    act(() => root.render(<MemoryRouter><TaskAccountHoldNote hold={{ ...hold, setting: 'orbit-settings:relaxBlockedPins' }} /></MemoryRouter>));
    expect([...host.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/settings/machines', '/settings/providers/routing#relaxBlockedPins']);
  });

  it('a relaxed run reads as the server\'s sentence', () => {
    const sentence = "Pinned to cursor, which can't run now (Cursor said \"Add a payment method\"); runs on codex instead, on the same engine, at tier M";
    act(() => root.render(<RelaxedRunNote sentence={sentence} />));
    expect(host.querySelector('[data-testid="relaxed-run"]')!.textContent).toBe(sentence);
  });

  it('on a row it is one quiet line: the words, the next try and Open account, the whole sentence as its name', async () => {
    act(() => root.render(<MemoryRouter><TaskAccountHoldLine hold={hold} /></MemoryRouter>));
    const line = host.querySelector('[data-testid="task-account-hold-line"]')!;
    const text = accountHoldLineText(hold);
    expect(text).toMatch(/^Held · Cursor said "Add a payment method to continue" · Next try \d\d:\d\d$/);
    // jsdom lays nothing out: give the label a cut-off box so its tip opens.
    Object.defineProperty(line.querySelector('.task-hold-line-text')!, 'scrollWidth', { value: 500, configurable: true });
    Object.defineProperty(line.querySelector('.task-hold-line-text')!, 'clientWidth', { value: 200, configurable: true });
    // The tip waits on a real timer; only the date is faked here.
    expect(await hoverTooltip(line)).toBe(`${text} · Open account`);
    expect(line.querySelector('.task-hold-line-text')!.getAttribute('aria-label')).toBe(`${text} · Open account`);
    expect(line.querySelector('a')!.getAttribute('href')).toBe('/settings/machines');
    expect(line.querySelector('.badge, [class*="Badge"]')).toBeNull();
  });
});
