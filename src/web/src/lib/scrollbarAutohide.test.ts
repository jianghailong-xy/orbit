// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installScrollbarAutohide, SCROLLBAR_SHOWN_MS } from './scrollbarAutohide';

/**
 * When a list's scrollbar is up. index.css paints the thumb of an `.autohide-scrollbar` list only
 * while it carries `data-scrolling`, so this pins when that mark comes and goes.
 */

let list: HTMLDivElement;

/** What the browser fires at a scroller — at it alone, since scroll events don't bubble. */
const scroll = (el: Element): void => {
  el.dispatchEvent(new Event('scroll'));
};

beforeAll(() => {
  installScrollbarAutohide();
});

beforeEach(() => {
  vi.useFakeTimers();
  list = document.createElement('div');
  list.className = 'session-col-list autohide-scrollbar';
  document.body.append(list);
});

afterEach(() => {
  list.remove();
  vi.useRealTimers();
});

describe('installScrollbarAutohide', () => {
  it('shows the scrollbar while the list scrolls, and hides it once the list is still', () => {
    expect(list.hasAttribute('data-scrolling'), 'hidden until the list moves').toBe(false);

    scroll(list);
    expect(list.hasAttribute('data-scrolling')).toBe(true);

    vi.advanceTimersByTime(SCROLLBAR_SHOWN_MS - 1);
    expect(list.hasAttribute('data-scrolling')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(list.hasAttribute('data-scrolling')).toBe(false);
  });

  it('keeps it up for as long as the scrolling goes on', () => {
    scroll(list);
    vi.advanceTimersByTime(SCROLLBAR_SHOWN_MS - 100);
    scroll(list);
    vi.advanceTimersByTime(SCROLLBAR_SHOWN_MS - 100);
    expect(list.hasAttribute('data-scrolling'), 'the second scroll restarts the wait').toBe(true);

    vi.advanceTimersByTime(100);
    expect(list.hasAttribute('data-scrolling')).toBe(false);
  });

  it('times each list on its own', () => {
    const other = document.createElement('div');
    other.className = 'tp-scroll autohide-scrollbar';
    document.body.append(other);
    try {
      scroll(list);
      vi.advanceTimersByTime(SCROLLBAR_SHOWN_MS / 2);
      scroll(other);
      vi.advanceTimersByTime(SCROLLBAR_SHOWN_MS / 2);
      expect(list.hasAttribute('data-scrolling')).toBe(false);
      expect(other.hasAttribute('data-scrolling'), "the first list's timer is not this one's").toBe(
        true,
      );
    } finally {
      other.remove();
    }
  });

  it('leaves a scroller that has not opted in alone', () => {
    const transcript = document.createElement('div');
    transcript.className = 'workspace-sessions';
    document.body.append(transcript);
    try {
      scroll(transcript);
      expect(transcript.hasAttribute('data-scrolling')).toBe(false);
    } finally {
      transcript.remove();
    }
  });
});
