// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainCheckoutCtx, type MainCheckoutHost } from '../lib/mainCheckout';
import { MainCheckoutBar } from './MainCheckout';

/** Board 01 A–E of docs/mocks/main-checkout-unpushed-commits: the bar opens the commits it has not pushed. */

// The runner's own answers: runner-go TestWriteMainCheckoutWebFixtures reads a real repository (develop, 21 commits
// ahead of its upstream, 3 files uncommitted) and the control plane's validSnapshotAnswer keeps them (the apiserver's
// main-checkout.snapshot-answer.spec.ts holds the same file). Nothing here is written by hand but the clean variant.
const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../shared/src/main-checkout-unpushed.fixture.json'), 'utf8'),
) as { plain: { snapshot: any }; commit: { diffs: Array<{ path: string; patch: string }> } };
const REAL = fixture.plain.snapshot;
const COMMITS = REAL.commits as Array<{ sha: string; subject: string; files: Array<{ path: string }> }>;
const NEWEST = COMMITS[0];

const h = vi.hoisted(() => ({ snapshot: null as unknown }));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    getMainCheckout: vi.fn(async (_ws: string, diffPaths: readonly string[] = [], _s?: AbortSignal, commit?: string) => ({
      snapshot: h.snapshot,
      // The runner's answer to a commit read is that commit's patch of the path asked for.
      diffs: commit ? fixture.commit.diffs.filter((d) => diffPaths.includes(d.path)) : [],
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

const snapshot = (over: Record<string, unknown> = {}) => ({ ...REAL, ...over });
const CLEAN = { state: 'clean', files: [], fileCount: 0 };

function host(over: { files?: number } = {}): MainCheckoutHost {
  const files = over.files ?? 0;
  return {
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    actionsSupported: true,
    health: {
      root: REAL.root, state: files ? 'dirty' : 'clean', branch: 'develop', fileCount: files, ahead: REAL.ahead,
      upstream: 'origin/develop', head: REAL.head,
    },
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

describe('the main checkout bar opens its unpushed commits (real runner answers)', () => {
  it('a clean bar with commits ahead toggles the list: 20 of 21, newest first, "and 1 more", where and when', async () => {
    h.snapshot = snapshot(CLEAN);
    const view = await mount(<MainCheckoutBar />, host());
    await settle();
    const row = toggleRow(view)!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(view.querySelector('.wt-commit-row')).toBeNull();
    await click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    const rows = [...view.querySelectorAll('.wt-commit-row')];
    expect(rows.map((r) => r.querySelector('.wt-commit-subject')?.textContent)).toEqual(COMMITS.map((c) => c.subject));
    expect(rows).toHaveLength(20);
    const panel = view.querySelector('.wt-commits-panel')!.textContent;
    expect(panel).toContain('and 1 more not listed');
    expect(panel).toContain('git log origin/develop..develop');
    expect(panel).toContain('On develop, not on origin/develop.');
    expect(panel).toMatch(/Checked (\d+s ago|\d+ min ago|at )/);
    await click(row);
    expect(view.querySelector('.wt-commit-row')).toBeNull();
  });

  it('with uncommitted files too, the pending row leads and opens Review; Push does not toggle the row', async () => {
    h.snapshot = snapshot();
    const mc = host({ files: 3 });
    const view = await mount(<MainCheckoutBar />, mc);
    await settle();
    await click([...view.querySelectorAll('.mck-bar-btn')].find((b) => b.textContent?.startsWith('Push')));
    expect(mc.push).toHaveBeenCalled();
    expect(toggleRow(view)!.getAttribute('aria-expanded')).toBe('false');
    await click(toggleRow(view));
    const rows = [...view.querySelectorAll('.wt-commit-row')];
    expect(rows).toHaveLength(21);
    expect(rows[0].textContent).toContain('Uncommitted changes');
    expect(rows[0].textContent).toContain('3 files · not committed yet · opens Review');
    expect(rows[1].textContent).toContain(NEWEST.subject);
    await click(rows[0]);
    expect(mc.openReview).toHaveBeenCalledTimes(1);
  });

  it('a commit opens the drawer with only the unpushed commits and asks the runner for that commit’s own patch', async () => {
    h.snapshot = snapshot(CLEAN);
    const view = await mount(<MainCheckoutBar />, host());
    await settle();
    await click(toggleRow(view));
    await click(rowNamed(view, NEWEST.subject));
    const drawer = document.body.querySelector('.wt-diff-drawer')!;
    expect(drawer.querySelector('.wt-rail-title')?.textContent).toBe('Not pushed · 20');
    expect(drawer.textContent).not.toContain('All changes');
    expect(drawer.querySelectorAll('.wt-rail-commits .wt-commit-row')).toHaveLength(20);
    expect(drawer.querySelector('.wt-commit-head-subject')?.textContent).toBe(NEWEST.subject);
    const first = NEWEST.files[0].path;
    const calls = vi.mocked(getMainCheckout).mock.calls.filter((c) => c[3]);
    expect(calls.at(-1)).toEqual(['ws-1', [first], expect.anything(), NEWEST.sha]);
    expect(drawer.textContent).toContain('/* v21 */');
  });

  it('a snapshot without commits leaves today’s bar: no caret, no toggle', async () => {
    h.snapshot = snapshot({ ...CLEAN, commits: undefined, commitsTruncated: undefined });
    const view = await mount(<MainCheckoutBar />, host());
    await settle();
    expect(toggleRow(view)).toBeNull();
    expect(view.querySelector('.wt-commits-caret')).toBeNull();
    expect(view.querySelector('.mck-bar')?.textContent).toBe('Main checkoutdevelopClean · 21 commits not pushedPush to origin/develop');
  });
});
