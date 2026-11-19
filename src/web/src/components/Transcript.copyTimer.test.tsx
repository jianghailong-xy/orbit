// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunEvent, Transcript } from './Transcript';

/**
 * Each copy button says "Copied" for 1.6 s, then resets. The reset timer must not outlive the
 * transcript: one that fires after the component (or a test's jsdom) is gone calls setState on
 * nothing, which Vitest reported as `ReferenceError: window is not defined` from dispatchSetState.
 */

const TS = new Date(2026, 10, 17, 12, 0).toISOString();
const EVENTS: RunEvent[] = [
  { seq: 1, type: 'user', payload: { text: 'show me' }, ts: TS },
  { seq: 2, type: 'assistant', payload: { text: 'Here:\n\n```sh\nls -la\n```' }, ts: TS },
  { seq: 3, type: 'turn_end', payload: { subtype: 'success' }, ts: TS },
];

describe('the "Copied" reset timers', () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => {}) } });
    consoleError = vi.spyOn(console, 'error');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
    container.remove();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  // The user bubble's copy, the reply's copy at the end of the turn, and the code block's.
  const copyButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.chat-copy, .md-copy')];

  it('are all cancelled when the transcript unmounts right after a copy', async () => {
    act(() => root.render(<Transcript events={EVENTS} />));
    const buttons = copyButtons();
    expect(buttons).toHaveLength(3);
    for (const button of buttons) await act(async () => button.click());
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Copied', 'Copied', 'Copied']);

    act(() => root.unmount());
    mounted = false;
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => vi.advanceTimersByTime(2000));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('still lasts 1.6 s, counted from the latest copy', async () => {
    act(() => root.render(<Transcript events={EVENTS} />));
    const button = container.querySelector<HTMLButtonElement>('.chat-turn-foot .chat-copy')!;

    await act(async () => button.click());
    await act(async () => vi.advanceTimersByTime(1000));
    await act(async () => button.click());
    await act(async () => vi.advanceTimersByTime(1000));
    expect(button.getAttribute('aria-label')).toBe('Copied');

    await act(async () => vi.advanceTimersByTime(600));
    expect(button.getAttribute('aria-label')).toBe('Copy reply');
  });
});
