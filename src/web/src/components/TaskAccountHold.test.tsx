// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskAccountHold } from '../lib/accountHealth';
import { RelaxedRunNote, TaskAccountHoldNote } from './TaskAccountHold';

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
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

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
});
