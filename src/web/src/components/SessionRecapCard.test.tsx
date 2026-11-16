// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRecapCard, recapWhen } from './SessionRecapCard';

/**
 * The conversation's Recap card on its own: when it says the recap was written, and that its one
 * control is the × that hides it.
 */

describe('recapWhen', () => {
  const clock = (at: Date) => at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  it('says a bare clock time for a recap written today', () => {
    const now = new Date(2026, 9, 22, 18, 0);
    const at = new Date(2026, 9, 22, 9, 41);
    expect(recapWhen(at.toISOString(), now)).toBe(clock(at));
  });

  it('dates a recap from another day, where a bare clock time would mislead', () => {
    const now = new Date(2026, 9, 22, 18, 0);
    const at = new Date(2026, 9, 17, 13, 44);
    const day = at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    expect(recapWhen(at.toISOString(), now)).toBe(`${day}, ${clock(at)}`);
  });

  it('says nothing for a recap with no stamp, or one that is not a time', () => {
    expect(recapWhen(null)).toBeNull();
    expect(recapWhen(undefined)).toBeNull();
    expect(recapWhen('not a time')).toBeNull();
  });
});

describe('SessionRecapCard', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onHide = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onHide.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function render(): Promise<void> {
    await act(async () => {
      root.render(<SessionRecapCard text="Fixed the login flow; tests pass." recapAt={null} onHide={onHide} />);
    });
  }

  it('draws the word, the whole recap, and no time when the recap carries none', async () => {
    await render();
    expect(container.querySelector('.chat-recap-word')?.textContent).toBe('Recap');
    expect(container.querySelector('.chat-recap-when')).toBeNull();
    expect(container.querySelector('.chat-recap-text')?.textContent).toBe('Fixed the login flow; tests pass.');
  });

  it('has one control, a × named for screen readers, that hands Hide to the conversation with no menu', async () => {
    await render();
    const buttons = container.querySelectorAll<HTMLButtonElement>('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-label')).toBe('Hide recap');
    await act(async () => {
      buttons[0].click();
    });
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});
