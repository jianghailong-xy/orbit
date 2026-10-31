// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu, type MenuItem } from './Menu';

/**
 * A level of a menu its page opens itself: the session card's Use another provider opens the
 * composer's model menu on its Provider level (board 02 C of docs/mocks/claude-region-check). The
 * level's `open` is the page's, and every change the menu makes to it is the page's to take.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = root = null;
  document.body.innerHTML = '';
});

function Page({ onLevel }: { onLevel: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState(false);
  const items: MenuItem[] = [
    {
      key: 'provider',
      label: 'Provider',
      open: level,
      onOpenChange: (next) => {
        setLevel(next);
        onLevel(next);
      },
      children: [
        { key: 'deepseek', label: 'DeepSeek', onSelect: () => {} },
        { key: 'anthropic', label: 'Personal Max — Region not supported', onSelect: () => {} },
      ],
    },
    { key: 'model', label: 'Opus 5.5', onSelect: () => {} },
  ];
  return (
    <>
      <button
        type="button"
        data-testid="open-level"
        onClick={() => {
          setOpen(true);
          setLevel(true);
        }}
      >
        Use another provider
      </button>
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setLevel(false);
        }}
        items={items}
        trigger={<button type="button">Model</button>}
      />
    </>
  );
}

describe('a menu level its page opens', () => {
  it('opens on the page’s word, with the menu above it', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onLevel = vi.fn();
    await act(async () => root!.render(<Page onLevel={onLevel} />));
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);

    await act(async () => container!.querySelector<HTMLButtonElement>('[data-testid="open-level"]')!.click());
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelectorAll('[role="menu"]')).toHaveLength(2), { timeout: 5_000, interval: 20 });
    });
    const level = [...document.querySelectorAll('[role="menu"]')].find((menu) => menu.textContent?.includes('DeepSeek'));
    expect(level?.textContent).toContain('Personal Max — Region not supported');
    vi.unstubAllGlobals();
  });

  it('leaves a level nobody controls to open on its own, as before', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const items: MenuItem[] = [
      { key: 'provider', label: 'Provider', children: [{ key: 'deepseek', label: 'DeepSeek', onSelect: () => {} }] },
    ];
    await act(async () => root!.render(<Menu open items={items} trigger={<button type="button">Model</button>} />));
    // The menu is open; its level is not, until something opens it.
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('DeepSeek');
    vi.unstubAllGlobals();
  });
});
