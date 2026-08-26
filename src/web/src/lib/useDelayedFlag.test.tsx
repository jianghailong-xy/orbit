// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDelayedFlag } from './useDelayedFlag';

const DELAY_MS = 3_000;

function Probe({ active, scope }: { active: boolean; scope: string | null }) {
  const visible = useDelayedFlag(active, DELAY_MS, scope);
  return <span>{visible ? 'visible' : 'hidden'}</span>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(active: boolean, scope: string | null = 'session-a'): void {
  act(() => root.render(<Probe active={active} scope={scope} />));
}

describe('useDelayedFlag', () => {
  it('stays hidden until the state has lasted three seconds', () => {
    render(true);
    expect(container.textContent).toBe('hidden');

    act(() => vi.advanceTimersByTime(DELAY_MS - 1));
    expect(container.textContent).toBe('hidden');

    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toBe('visible');
  });

  it('never reveals a state that finishes within the delay', () => {
    render(true);
    act(() => vi.advanceTimersByTime(DELAY_MS - 1));
    render(false);
    act(() => vi.advanceTimersByTime(1));

    expect(container.textContent).toBe('hidden');
  });

  it('hides immediately when a revealed state finishes', () => {
    render(true);
    act(() => vi.advanceTimersByTime(DELAY_MS));
    expect(container.textContent).toBe('visible');

    render(false);
    expect(container.textContent).toBe('hidden');
  });

  it('starts a fresh delay when the session or turn scope changes', () => {
    render(true, 'session-a:turn-1');
    act(() => vi.advanceTimersByTime(DELAY_MS));
    expect(container.textContent).toBe('visible');

    render(true, 'session-a:turn-2');
    expect(container.textContent).toBe('hidden');
    act(() => vi.advanceTimersByTime(DELAY_MS));
    expect(container.textContent).toBe('visible');
  });
});
