// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionListRow, type SessionRowController, type SessionRowSwipe } from './SessionListRow';

// A row of the windowed session list (docs/session-list-scale-design.md §4): it redraws only when one of its own
// props changed, and builds its menu only when the menu opens.

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const rows: SessionRowController = {
  touch: false,
  onMenuOpenChange: vi.fn(),
  closeMenu: vi.fn(),
  closePressMenu: vi.fn(),
  takeClick: () => true,
  touchStart: vi.fn(),
  touchMove: vi.fn(),
  touchEnd: vi.fn(),
  touchCancel: vi.fn(),
  // Asked for on every draw of the row: the count of its draws.
  kebabRef: vi.fn(() => () => {}),
  kebab: () => null,
  startDrag: vi.fn(),
  endDrag: vi.fn(),
};
const subject = { id: 'S1' };
const swipe: SessionRowSwipe = { leading: [], trailing: [], fullSwipe: false };
const onOpen = vi.fn();

const content = <span className="session-title">Row one</span>;
const draws = (): number => vi.mocked(rows.kebabRef).mock.calls.length;

function Row({ menu, menuOpen = false, active = false }: { menu: () => []; menuOpen?: boolean; active?: boolean }) {
  return (
    <SessionListRow rows={rows} id="S1" subject={subject} title="Row one" active={active} draggable={false}
      swipe={swipe} menu={menu} menuOpen={menuOpen} pressAt={null} swipeAt={null} dragging={false} onOpen={onOpen}>
      {content}
    </SessionListRow>
  );
}

describe('SessionListRow', () => {
  it('draws again only when a prop of its own changed', async () => {
    const menu = vi.fn(() => [] as []);
    vi.mocked(rows.kebabRef).mockClear();
    await act(async () => root.render(<Row menu={menu} />));
    expect(draws()).toBe(1);
    await act(async () => root.render(<Row menu={menu} />));
    expect(draws()).toBe(1);
    await act(async () => root.render(<Row menu={menu} active />));
    expect(draws()).toBe(2);
    expect(host.querySelector('.session-row')!.classList.contains('active')).toBe(true);
  });

  it('builds its menu when the menu opens, not on every draw', async () => {
    const menu = vi.fn(() => [] as []);
    await act(async () => root.render(<Row menu={menu} />));
    await act(async () => root.render(<Row menu={menu} active />));
    expect(menu).not.toHaveBeenCalled();
    await act(async () => root.render(<Row menu={menu} active menuOpen />));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.session-row')!.classList.contains('menu-open')).toBe(true);
  });
});
