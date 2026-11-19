// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessageCard as Card } from '@orbit/shared';
import {
  SESSION_MESSAGE_CLAMP_FROM,
  SESSION_MESSAGE_SHOW_LESS,
  SESSION_MESSAGE_SHOW_MORE,
  SessionMessageCard,
} from './SessionMessageCard';
import { ExportCtx, REVEAL_EVENT } from './Transcript';

/**
 * A long message from another session shows its first lines and a "Show more", by its rendered height
 * rather than its length (design: docs/mocks/session-message-clamp/). jsdom lays nothing out, so each
 * case says how tall the body is: its line height and its scroll height.
 */

const CARD: Card = {
  fromSessionId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60',
  fromTitle: 'Task: B4 Link gateway',
  fromAgentName: 'orbit',
  fromTaskId: '01a0cca0-aeaa-7618-bd5a-caccc089108c',
};
const TEXT = '0.1.252 runner release plan\n\n- step one\n- step two';

let container: HTMLDivElement;
let root: Root;
let lines = 0;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () => ({ lineHeight: '20px' }) as unknown as CSSStyleDeclaration,
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => lines * 20 });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
});

function mount(exporting = false) {
  const card = <SessionMessageCard card={CARD} text={TEXT} seq={4} />;
  act(() =>
    root.render(
      <MemoryRouter>
        {exporting ? <ExportCtx.Provider value={{ images: new Map() }}>{card}</ExportCtx.Provider> : card}
      </MemoryRouter>,
    ),
  );
}

const more = () => container.querySelector<HTMLButtonElement>('.smc-more');
const body = () => container.querySelector('.smc-body')!;

describe('a long message from another session', () => {
  it('shows whole, with no toggle, up to the line count that folds it', () => {
    lines = SESSION_MESSAGE_CLAMP_FROM;
    mount();
    expect(more()).toBeNull();
    expect(body().classList.contains('is-clamped')).toBe(false);
  });

  it('folds past it, opens on Show more and folds again on Show less, the whole text there all along', () => {
    lines = 40;
    mount();
    expect(body().classList.contains('is-clamped')).toBe(true);
    expect(container.querySelector('.smc.is-clamped')).not.toBeNull();
    expect(body().textContent).toContain('step two');
    expect(more()!.textContent).toBe(SESSION_MESSAGE_SHOW_MORE);

    act(() => more()!.click());
    expect(body().classList.contains('is-clamped')).toBe(false);
    expect(more()!.textContent).toBe(SESSION_MESSAGE_SHOW_LESS);
    expect(more()!.getAttribute('aria-expanded')).toBe('true');

    act(() => more()!.click());
    expect(body().classList.contains('is-clamped')).toBe(true);
  });

  it('opens when a find lands in it', () => {
    lines = 40;
    mount();
    act(() => {
      container.querySelector('.smc')!.dispatchEvent(new Event(REVEAL_EVENT));
    });
    expect(body().classList.contains('is-clamped')).toBe(false);
  });

  it('is whole in an export, which has no way to open it', () => {
    lines = 40;
    mount(true);
    expect(more()).toBeNull();
    expect(body().classList.contains('is-clamped')).toBe(false);
  });
});
