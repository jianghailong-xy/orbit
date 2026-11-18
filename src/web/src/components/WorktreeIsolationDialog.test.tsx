// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorktreeIsolationDialog,
  worktreeIsolationDialogFor,
  type WorktreeIsolationDialogKind,
} from './WorktreeIsolationDialog';

/**
 * Board 04: flipping worktree isolation never blocks and never touches the checkout; it only says first what the
 * switch means when the main checkout is dirty, stuck or unseen (on), or sessions still hold unmerged worktrees (off).
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

const DIRTY = { root: '/root/orbit', state: 'dirty', branch: 'main', head: '62325fb0000', fileCount: 3 };

describe('which dialog the switch asks (board 04 rules)', () => {
  it('switches a clean checkout either way without asking', () => {
    const clean = { ...DIRTY, state: 'clean', fileCount: 0 };
    expect(worktreeIsolationDialogFor(true, clean, 0, '/root/orbit')).toBeNull();
    expect(worktreeIsolationDialogFor(false, clean, 0, '/root/orbit')).toBeNull();
  });

  it('turning on over a dirty checkout: dialog A', () => {
    expect(worktreeIsolationDialogFor(true, DIRTY, 0, '/root/orbit')).toEqual({
      kind: 'on-dirty', root: '/root/orbit', fileCount: 3, branch: 'main', head: '62325fb0000',
    });
  });

  it('turning on over a stuck checkout: dialog A with the stuck sentence', () => {
    expect(worktreeIsolationDialogFor(true, { ...DIRTY, state: 'rebase' }, 0, '/root/orbit')).toEqual({
      kind: 'on-stuck', root: '/root/orbit', state: 'rebase',
    });
  });

  it('turning on with nothing reported: says Orbit cannot see it, and still switches', () => {
    expect(worktreeIsolationDialogFor(true, null, 0, '/root/orbit')).toEqual({ kind: 'on-unseen' });
  });

  it('turning off with unmerged worktrees: dialog B', () => {
    expect(worktreeIsolationDialogFor(false, DIRTY, 2, '/root/orbit')).toEqual({ kind: 'off', root: '/root/orbit', unmerged: 2 });
  });
});

async function show(
  dialog: WorktreeIsolationDialogKind,
  handlers: Partial<Parameters<typeof WorktreeIsolationDialog>[0]> = {},
) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props = { onCancel: vi.fn(), onConfirm: vi.fn(), ...handlers };
  await act(async () => root!.render(<WorktreeIsolationDialog dialog={dialog} {...props} />));
  const surface = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const buttons = [...surface.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent?.trim()).filter(Boolean);
  return { surface, buttons, props };
}

const press = async (surface: HTMLElement, name: string) => {
  const b = [...surface.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === name)!;
  await act(async () => b.click());
};

describe('the dialogs (board 04 A / B)', () => {
  it('A: names the dirty checkout, what new sessions will not see, and offers Review files', async () => {
    const onReview = vi.fn();
    const { surface, buttons, props } = await show(
      { kind: 'on-dirty', root: '/root/orbit', fileCount: 3, branch: 'main', head: '62325fb0000' },
      { onReview },
    );
    expect(surface.textContent).toContain('Turn on worktree isolation?');
    expect(surface.textContent).toContain(
      "The main checkout /root/orbit has 3 uncommitted files. New sessions start from the last commit on main (62325fb), so they won't see those files.",
    );
    expect(surface.textContent).toContain(
      'Nothing in the checkout is changed. Sessions already running keep working in the main checkout until they end.',
    );
    expect(buttons.slice(-3)).toEqual(['Review files', 'Cancel', 'Turn on']);
    await press(surface, 'Review files');
    expect(onReview).toHaveBeenCalled();
    await press(surface, 'Turn on');
    expect(props.onConfirm).toHaveBeenCalled();
  });

  it('A without the capability: no Review files', async () => {
    const { buttons } = await show({ kind: 'on-dirty', root: '/root/orbit', fileCount: 3, branch: 'main', head: '62325fb0000' });
    expect(buttons).not.toContain('Review files');
    expect(buttons.slice(-2)).toEqual(['Cancel', 'Turn on']);
  });

  it('A, stuck: says merges stay blocked and offers Clean up checkout', async () => {
    const onCleanUp = vi.fn();
    const { surface, buttons } = await show({ kind: 'on-stuck', root: '/root/orbit', state: 'rebase' }, { onCleanUp });
    expect(surface.textContent).toContain(
      "The main checkout /root/orbit is stuck in a rebase — new sessions can be created, but merges stay blocked until it's cleaned up.",
    );
    expect(buttons.slice(-3)).toEqual(['Clean up checkout', 'Cancel', 'Turn on']);
    await press(surface, 'Clean up checkout');
    expect(onCleanUp).toHaveBeenCalled();
  });

  it('A, unseen: says so, and does not guess', async () => {
    const { surface } = await show({ kind: 'on-unseen' });
    expect(surface.textContent).toContain("Orbit can't see this checkout right now.");
    expect(surface.textContent).not.toContain('uncommitted');
  });

  it('B: the unmerged worktrees stay', async () => {
    const { surface, buttons, props } = await show({ kind: 'off', root: '/root/orbit', unmerged: 2 });
    expect(surface.textContent).toContain('Turn off worktree isolation?');
    expect(surface.textContent).toContain(
      'New sessions will work directly in /root/orbit. The 2 sessions with unmerged worktrees keep them — merge or discard them from each session as before.',
    );
    expect(buttons.slice(-2)).toEqual(['Cancel', 'Turn off']);
    await press(surface, 'Cancel');
    expect(props.onCancel).toHaveBeenCalled();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });
});
