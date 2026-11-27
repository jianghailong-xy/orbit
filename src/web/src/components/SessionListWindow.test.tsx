// @vitest-environment jsdom
import { act, createRef, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionListWindow, type SessionListWindowHandle } from './SessionListWindow';

// The session column's window (docs/session-list-scale-design.md §4): of 1,500 items only the ones in and near
// the viewport are mounted. jsdom has no layout, so the column's height is given here and every item measures at
// the window's estimate (64px).

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `row:${i}`, title: `Row ${i}` }));

function Column({ count, height, hidden = false, keep = [0], handle, onScrolled }: {
  count: number; height: number; hidden?: boolean; keep?: number[]; handle?: React.Ref<SessionListWindowHandle>;
  onScrolled?: (last: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      className="session-col-list"
      ref={(node) => {
        ref.current = node;
        if (!node) return;
        Object.defineProperty(node, 'clientHeight', { configurable: true, value: height });
        Object.defineProperty(node, 'scrollHeight', {
          configurable: true,
          get: () => parseFloat(node.querySelector<HTMLElement>('.session-list-window')?.style.height || '0'),
        });
        // jsdom keeps no scroll offset of its own.
        if (!Object.getOwnPropertyDescriptor(node, 'scrollTop')) {
          let top = 0;
          Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = value; } });
        }
      }}
    >
      <SessionListWindow
        handle={handle ?? createRef()}
        scrollRef={ref}
        items={items(count)}
        hidden={hidden}
        keepMounted={keep}
        onScrolled={onScrolled}
        renderItem={(item) => <div className="row">{item.title}</div>}
      />
    </div>
  );
}

const mountedIndexes = (): number[] =>
  [...host.querySelectorAll<HTMLElement>('.session-list-item')].map((el) => Number(el.dataset.index));
const list = (): HTMLDivElement => host.querySelector('.session-col-list')!;

describe('SessionListWindow', () => {
  it('mounts about two screens of 1,500 items, and the column is as tall as all of them', async () => {
    await act(async () => root.render(<Column count={1500} height={640} />));
    const shown = mountedIndexes();
    // Ten rows fill 640px; half a screen's worth each way at the most.
    expect(shown.length).toBeGreaterThanOrEqual(10);
    expect(shown.length).toBeLessThanOrEqual(2 * 10 + 2);
    expect(shown[0]).toBe(0);
    expect(host.querySelector<HTMLElement>('.session-list-window')!.style.height).toBe(`${1500 * 64}px`);
  });

  it('follows the scroll, and keeps the items it is asked to keep mounted', async () => {
    await act(async () => root.render(<Column count={1500} height={640} keep={[0, 3]} />));
    await act(async () => {
      list().scrollTop = 64 * 700;
      list().dispatchEvent(new Event('scroll'));
    });
    const shown = mountedIndexes();
    expect(shown).toContain(700);
    expect(shown).toContain(709);
    expect(shown).toContain(0);
    expect(shown).toContain(3);
    expect(shown).not.toContain(4);
    expect(shown.length).toBeLessThanOrEqual(2 * 10 + 2 + 2);
    // Each item sits at its offset in the column.
    expect(host.querySelector<HTMLElement>('[data-index="700"]')!.style.transform).toBe(`translateY(${700 * 64}px)`);
  });

  it('says which item a scroll brought to the end of the view, and scrolls an item into view by its index', async () => {
    const handle = createRef<SessionListWindowHandle>();
    const onScrolled = vi.fn();
    await act(async () => root.render(<Column count={1500} height={640} handle={handle} onScrolled={onScrolled} />));
    expect(onScrolled).not.toHaveBeenCalled();
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      list().scrollTop = options.top ?? 0;
      list().dispatchEvent(new Event('scroll'));
    });
    list().scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    await act(async () => {
      handle.current!.scrollToIndex(300);
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(scrollTo).toHaveBeenCalled();
    // `auto`: by as little as it takes, so the item ends the viewport.
    expect(scrollTo.mock.calls.at(-1)![0].top).toBe(301 * 64 - 640);
    expect(mountedIndexes()).toContain(300);
    // The last item in view is the one scrolled to (the window counts one starting at its edge too).
    const last = onScrolled.mock.calls.at(-1)![0];
    expect(last).toBeGreaterThanOrEqual(300);
    expect(last).toBeLessThanOrEqual(302);
  });

  it('draws about a window of rows while the column is hidden, not every item for its height of 0', async () => {
    await act(async () => root.render(<Column count={1500} height={0} hidden />));
    const shown = mountedIndexes();
    expect(shown[0]).toBe(0);
    expect(shown.length).toBeLessThanOrEqual(Math.ceil(window.innerHeight / 64) * 2 + 2);
    expect(host.querySelector<HTMLElement>('.session-list-window')!.style.height).toBe(`${1500 * 64}px`);
  });

  it('draws every item where the column has no height to window by', async () => {
    await act(async () => root.render(<Column count={40} height={0} />));
    expect(mountedIndexes()).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });
});
