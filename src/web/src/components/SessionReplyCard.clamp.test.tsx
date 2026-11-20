// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionReplyCard as Card } from '@orbit/shared';
import { SESSION_MESSAGE_CLAMP_FROM, SESSION_MESSAGE_SHOW_LESS, SESSION_MESSAGE_SHOW_MORE } from './SessionMessageCard';
import { SessionReplyCard } from './SessionReplyCard';
import { ExportCtx, REVEAL_EVENT } from './Transcript';

/**
 * A long reply folds as a long message does (SessionMessageCard.clamp.test): its first lines and a
 * "Show more", by rendered height. jsdom lays nothing out, so each case says how tall the body is.
 */

const CARD: Card = {
  requestId: '34YfReq0000000000000000',
  outcome: 'REPLIED',
  fromSessionId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60',
  fromTitle: 'PostgreSQL memory review',
  requestPreview: 'one more read-only request',
  replyText: 'Read-only, orbit-postgres.\n\n- session +1298\n- workspace +357',
};

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
  const card = <SessionReplyCard card={CARD} />;
  act(() =>
    root.render(
      <MemoryRouter>
        {exporting ? <ExportCtx.Provider value={{ images: new Map() }}>{card}</ExportCtx.Provider> : card}
      </MemoryRouter>,
    ),
  );
}

const more = () => container.querySelector<HTMLButtonElement>('.smc-more');
const body = () => container.querySelector('.src-body')!;

describe('a long reply from another session', () => {
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
    expect(body().textContent).toContain('workspace +357');
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
      container.querySelector('.src')!.dispatchEvent(new Event(REVEAL_EVENT));
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
