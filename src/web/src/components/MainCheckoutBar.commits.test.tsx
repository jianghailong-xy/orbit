// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainCheckoutCtx, type MainCheckoutHost } from '../lib/mainCheckout';
import { MainCheckoutBar } from './MainCheckout';

/** Board 01 A–E of docs/mocks/main-checkout-unpushed-commits: the bar opens the commits it has not pushed. */

const h = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getMainCheckout: vi.fn(async (_ws: string, diffPaths: readonly string[] = [], _s?: AbortSignal, commit?: string) => ({
      snapshot: h.snapshot,
      diffs: diffPaths.map((path) => ({ path, binary: false, patch: `@@ -1 +1 @@\n-old\n+new of ${commit ?? 'head'}\n` })),
    })),
  };
});

import { getMainCheckout } from '../api';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getMainCheckout).mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(node: ReactNode, host: MainCheckoutHost): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MainCheckoutCtx.Provider value={host}>{node}</MainCheckoutCtx.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const COMMITS = [
  {
    sha: SHA_A,
    subject: 'fix(web): Settings nav takes the sidebar width',
    body: 'Both navs now use the stored width.',
    committedAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    files: [
      { path: 'src/index.css', additions: 18, deletions: 6 },
      { path: 'src/Settings.tsx', additions: 6, deletions: 3 },
    ],
  },
  {
    sha: SHA_B,
    subject: 'fix(web): centre the account menu',
    committedAt: new Date(Date.now() - 41 * 60_000).toISOString(),
    files: [{ path: 'src/Menu.tsx', additions: 6, deletions: 4 }],
  },
];

const snapshot = (over: Record<string, unknown> = {}) => ({
  root: '/root/orbit',
  branch: 'develop',
  upstream: 'origin/develop',
  state: 'clean',
  ahead: 2,
  files: [],
  fileCount: 0,
  truncated: false,
  fingerprint: 'mc1:x',
  checkedAt: new Date().toISOString(),
  commits: COMMITS,
  ...over,
});

function host(over: { files?: number } = {}): MainCheckoutHost {
  const files = over.files ?? 0;
  return {
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    actionsSupported: true,
    health: { root: '/root/orbit', state: files ? 'dirty' : 'clean', branch: 'develop', fileCount: files, ahead: 2, upstream: 'origin/develop' },
    targets: [],
    inFlight: null,
    openReview: vi.fn(),
    move: vi.fn(),
    rescue: vi.fn(),
    push: vi.fn(),
    cancel: vi.fn(),
  };
}

const toggleRow = (v: HTMLElement) => v.querySelector('.wt-row-toggle');
const rowNamed = (v: ParentNode, text: string) =>
  [...v.querySelectorAll('.wt-commit-row')].find((r) => r.textContent?.includes(text));

describe('the main checkout bar opens its unpushed commits', () => {
  it('a clean bar with commits ahead toggles the list, newest first, with where and when it was measured', async () => {
    h.snapshot = snapshot();
    const view = await mount(<MainCheckoutBar />, host());
    await settle();
    const row = toggleRow(view)!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(view.querySelector('.wt-commit-row')).toBeNull();
    await click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const rows = [...view.querySelectorAll('.wt-commit-row')];
    expect(rows.map((r) => r.querySelector('.wt-commit-subject')?.textContent)).toEqual([
      COMMITS[0].subject,
      COMMITS[1].subject,
    ]);
    expect(view.querySelector('.wt-commits-panel')?.textContent).toContain('On develop, not on origin/develop.');
    expect(view.querySelector('.wt-commits-panel')?.textContent).toContain('Checked 0s ago');
    await click(row);
    expect(view.querySelector('.wt-commit-row')).toBeNull();
  });

  it('with uncommitted files too, the pending row leads and opens Review; Push does not toggle the row', async () => {
    h.snapshot = snapshot({
      state: 'dirty',
      fileCount: 3,
      files: [
        { path: 'a.ts', status: 'M', additions: 30, deletions: 1 },
        { path: 'b.ts', status: 'M', additions: 11, deletions: 1 },
      ],
    });
    const mc = host({ files: 3 });
    const view = await mount(<MainCheckoutBar />, mc);
    await settle();
    await click([...view.querySelectorAll('.mck-bar-btn')].find((b) => b.textContent?.startsWith('Push')));
    expect(mc.push).toHaveBeenCalled();
    expect(toggleRow(view)!.getAttribute('aria-expanded')).toBe('false');
    await click(toggleRow(view));
    const rows = [...view.querySelectorAll('.wt-commit-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Uncommitted changes');
    expect(rows[0].textContent).toContain('3 files · not committed yet · opens Review');
    await click(rows[0]);
    expect(mc.openReview).toHaveBeenCalledTimes(1);
  });

  it('a commit opens the drawer with only the unpushed commits and asks the runner for that commit’s own patch', async () => {
    h.snapshot = snapshot();
    const view = await mount(<MainCheckoutBar />, host());
    await settle();
    await click(toggleRow(view));
    await click(rowNamed(view, COMMITS[1].subject));
    const drawer = document.body.querySelector('.wt-diff-drawer')!;
    expect(drawer.querySelector('.wt-rail-title')?.textContent).toBe('Not pushed · 2');
    expect(drawer.textContent).not.toContain('All changes');
    expect(drawer.querySelector('.wt-commit-head-subject')?.textContent).toBe(COMMITS[1].subject);
    const calls = vi.mocked(getMainCheckout).mock.calls.filter((c) => c[3]);
    expect(calls.at(-1)).toEqual(['ws-1', ['src/Menu.tsx'], expect.anything(), SHA_B]);
    expect(drawer.textContent).toContain(`new of ${SHA_B}`);
  });

  it('a snapshot without commits leaves today’s bar: no caret, no toggle', async () => {
    h.snapshot = snapshot({ commits: undefined });
    const view = await mount(<MainCheckoutBar />, host());
    await settle();
    expect(toggleRow(view)).toBeNull();
    expect(view.querySelector('.wt-commits-caret')).toBeNull();
    expect(view.querySelector('.mck-bar')?.textContent).toBe('Main checkoutdevelopClean · 2 commits not pushedPush to origin/develop');
  });
});
