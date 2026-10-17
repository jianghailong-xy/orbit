// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectBranchCandidates } from '@orbit/shared';
import {
  RUN_LAST_CHOSEN,
  RUN_MAIN_BRANCH,
  RUN_MAIN_BRANCH_HINT,
  RUN_TYPE_A_BRANCH,
  runBranchesIn,
  runUseBranch,
} from '../lib/projectStart';
import { MainBranchSelect } from './MainBranchSelect';

/**
 * The Main branch menu the start card and How it runs share (board ③④⑦): the branches the runner
 * reported for the coordination workspace under whose they are, a typed name offered as itself, the
 * owner's last choice for the repository tagged, and what the choice decides under them.
 */

const PAYMENTS: ProjectBranchCandidates = {
  names: ['develop', 'master', 'release/2.4'],
  workspaceName: 'payments-api',
  reportedAt: '2026-10-09T03:00:00.000Z',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const picked: string[] = [];

beforeEach(() => {
  picked.length = 0;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** The menu as a page holds it: the value is the page's, and a pick is told back. */
function Held({ initial, ...props }: {
  initial: string;
  branches: ProjectBranchCandidates | null;
  remembered?: string | null;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MainBranchSelect
      {...props}
      value={value}
      onChange={(name) => {
        picked.push(name);
        setValue(name);
      }}
    />
  );
}

async function mount(props: Parameters<typeof Held>[0]): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const tree = createRoot(container);
  root = tree;
  await act(async () => {
    tree.render(<Held {...props} />);
  });
  return container;
}

async function settle(): Promise<void> {
  for (let n = 0; n < 5; n += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** A mouse press as a browser delivers it — pointer and mouse down and up, then the click — which
 *  a list option needs before it takes a click as a choice rather than a keyboard activation. The
 *  mouse is the primary pointer, as it always is: a press that is not would read to the list as a
 *  drag onto the option, which it takes on the mouseup as well as on the click. */
async function press(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    element!.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
    element!.dispatchEvent(new MouseEvent('mousedown', init));
    element!.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse', isPrimary: true }));
    element!.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    element!.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
}

/** Types into the menu's search the way the browser does: the native setter, then the event. */
async function type(text: string): Promise<void> {
  const input = field();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const field = (): HTMLInputElement => container!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const shown = (): string => container!.querySelector('.orbit-combobox-value')?.textContent ?? '';
const popup = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.orbit-select-popup');
const options = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const optionWords = (): string[] => options().map((option) => option.textContent ?? '');

async function open(): Promise<void> {
  await press(field(), 'the Main branch field');
  await vi.waitFor(() => expect(popup()).not.toBeNull());
}

describe('the Main branch menu', () => {
  it('shows the main branch by name, and is named Main branch', async () => {
    await mount({ initial: 'master', branches: PAYMENTS });
    expect(field().getAttribute('aria-label')).toBe(RUN_MAIN_BRANCH);
    expect(shown()).toBe('master');
    // Spelled in monospace, as branch names are.
    expect(container!.querySelector('.orbit-combobox-value .main-branch-option')?.textContent).toBe('master');
  });

  it('lists the branches the runner reported under whose they are, and says what the choice decides', async () => {
    await mount({ initial: 'master', branches: PAYMENTS });
    await open();
    expect(popup()!.querySelector('.main-branch-menu-head')?.textContent).toBe(runBranchesIn('payments-api'));
    expect(runBranchesIn('payments-api')).toBe('Branches in payments-api');
    expect(optionWords()).toEqual(['develop', 'master', 'release/2.4']);
    expect(popup()!.querySelector('.main-branch-menu-foot')?.textContent).toBe(RUN_MAIN_BRANCH_HINT);
    expect(RUN_MAIN_BRANCH_HINT).toBe('Tasks start from it, and the project’s work ends up on it.');
    // The branch on the card is the one marked chosen.
    expect(options().find((option) => option.getAttribute('aria-selected') === 'true')?.textContent).toBe('master');
  });

  it('keeps the main branch on the list even when the runner never reported it', async () => {
    await mount({ initial: 'trunk', branches: PAYMENTS });
    await open();
    expect(optionWords()).toEqual(['develop', 'master', 'release/2.4', 'trunk']);
  });

  it('picks a reported branch', async () => {
    await mount({ initial: 'master', branches: PAYMENTS });
    await open();
    await press(options().find((option) => option.textContent === 'develop'), 'develop');
    expect(picked).toEqual(['develop']);
    expect(shown()).toBe('develop');
  });

  it('offers a typed name the runner never reported as itself, and takes it', async () => {
    await mount({ initial: 'master', branches: PAYMENTS });
    await open();
    await type('release/3.0');
    expect(optionWords()).toEqual([runUseBranch('release/3.0')]);
    expect(runUseBranch('release/3.0')).toBe('Use “release/3.0”');
    // The head stays: the list is still the workspace's, with nothing of it matching.
    expect(popup()!.querySelector('.main-branch-menu-head')?.textContent).toBe('Branches in payments-api');
    await press(options()[0], 'Use “release/3.0”');
    expect(picked).toEqual(['release/3.0']);
    expect(shown()).toBe('release/3.0');
  });

  it('narrows the list as a name is typed, and offers a name that is a reported branch only as that branch', async () => {
    await mount({ initial: 'master', branches: PAYMENTS });
    await open();
    await type('rel');
    expect(optionWords()).toEqual(['release/2.4', runUseBranch('rel')]);
    await type('develop');
    expect(optionWords()).toEqual(['develop']);
  });

  it('offers nothing to use for a name git would refuse', async () => {
    await mount({ initial: 'master', branches: PAYMENTS });
    await open();
    for (const name of ['two words', 'a..b', 'x~1', 'what?', 'end/', '-flag', 'held.lock', 'back\\slash']) {
      await type(name);
      expect(optionWords(), name).not.toContain(runUseBranch(name));
    }
  });

  it('takes only a typed name when the runner reported no branches', async () => {
    await mount({ initial: 'main', branches: null });
    await open();
    expect(popup()!.querySelector('.main-branch-menu-head')?.textContent).toBe(RUN_TYPE_A_BRANCH);
    expect(RUN_TYPE_A_BRANCH).toBe('Type a branch name');
    expect(optionWords()).toEqual(['main']);
    await type('master');
    expect(optionWords()).toEqual([runUseBranch('master')]);
    await press(options()[0], 'Use “master”');
    expect(picked).toEqual(['master']);
  });

  it('tags the branch last chosen for the repository, and lists it even when it was not reported', async () => {
    await mount({ initial: 'master', branches: PAYMENTS, remembered: 'master' });
    await open();
    const tagged = options().filter((option) => option.querySelector('.main-branch-tag'));
    expect(tagged.map((option) => option.querySelector('.main-branch-option')?.textContent)).toEqual(['master']);
    expect(tagged[0]!.querySelector('.main-branch-tag')?.textContent).toBe(RUN_LAST_CHOSEN);
    expect(RUN_LAST_CHOSEN).toBe('last chosen');
    expect(optionWords()).toEqual(['develop', 'masterlast chosen', 'release/2.4']);
  });

  it('lists the last choice even when the runner did not report it', async () => {
    await mount({ initial: 'develop', branches: PAYMENTS, remembered: 'trunk' });
    await open();
    expect(optionWords()).toEqual(['develop', 'master', 'release/2.4', 'trunklast chosen']);
  });

  it('is read-only when disabled', async () => {
    await mount({ initial: 'master', branches: PAYMENTS, disabled: true });
    expect(field().disabled).toBe(true);
    expect(container!.querySelector('.orbit-select')?.hasAttribute('data-disabled')).toBe(true);
    await press(field(), 'the Main branch field');
    expect(popup()).toBeNull();
    expect(picked).toEqual([]);
  });
});
