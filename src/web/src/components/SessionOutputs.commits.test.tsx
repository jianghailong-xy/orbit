// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchCommit } from '@orbit/shared';
import { getSessionDiff, refreshSessionDiff, type SessionDetail } from '../api';
import { SessionOutputs } from './SessionOutputs';
import { hoverTooltip } from '../test/tooltipHover';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getSessionDiff: vi.fn(),
  getWorktreeFile: vi.fn(),
  refreshSessionDiff: vi.fn(async () => undefined),
}));

const ROWS = 'src/pages/RowList.tsx';
const HOOK = 'src/pages/useRows.ts';
const API = 'src/api/client.ts';

/** Two commits of the agent's, newest first, and the runner's end-of-session one on top. */
const COMMITS: BranchCommit[] = [
  {
    sha: 'c98e1d4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    subject: 'chore: update 1 file in src/pages',
    committedAt: '2026-11-19T10:30:00Z',
    savedBy: 'session-end',
    files: [{ path: ROWS, additions: 4, deletions: 1 }],
  },
  {
    sha: 'a41c9e2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    subject: 'feat(rows): paginate the row list',
    body: 'The list loaded every row at once and timed out past 2,000.',
    committedAt: '2026-11-19T10:20:00Z',
    files: [
      { path: ROWS, additions: 20, deletions: 3 },
      { path: HOOK, additions: 10, deletions: 2 },
    ],
  },
  {
    sha: '7d03b5fccccccccccccccccccccccccccccccccc',
    subject: 'refactor(api): one client for the row endpoints',
    committedAt: '2026-11-19T10:00:00Z',
    files: [{ path: API, additions: 5, deletions: 5 }],
  },
];

const detail = (over: Partial<SessionDetail> = {}) =>
  ({
    id: 'session-with-commits',
    isolationStatus: 'worktree',
    branch: 'orbit/paginate-rows-39bcbf',
    baseSha: 'e9f1c07ddddddddddddddddddddddddddddddddd',
    changedFiles: [
      { path: ROWS, additions: 24, deletions: 4, status: 'M' },
      { path: HOOK, additions: 10, deletions: 2, status: 'M' },
      { path: API, additions: 5, deletions: 5, status: 'M' },
    ],
    branchCommits: COMMITS,
    worktreeDirty: false,
    ...over,
  }) as unknown as SessionDetail;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.mocked(getSessionDiff).mockReset();
  vi.mocked(getSessionDiff).mockResolvedValue({
    patches: [{ path: HOOK, patch: '@@ -1 +1 @@\n-old\n+new' }, { path: ROWS, patch: '@@ -1 +1 @@\n-a\n+b' }],
  });
  vi.mocked(refreshSessionDiff).mockClear();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(d: SessionDetail, committed = true): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionOutputs detail={d} committed={committed} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Render the same tree again with new props, as the session page does when it asks the drawer to open. */
async function rerender(d: SessionDetail, openDiffSignal: number): Promise<void> {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <SessionOutputs detail={d} committed openDiffSignal={openDiffSignal} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function press(el: Element | null | undefined): Promise<void> {
  expect(el, 'the element to press').toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
}

/** The drawer's row for a file, by the name it shows (these paths' names are unique). */
const fileRow = (list: Element, path: string) =>
  [...list.querySelectorAll('.session-file-btn')]
    .find((b) => b.querySelector('.session-file-name')?.textContent === path.split('/').at(-1));

const bar = () => container!.querySelector('.wt-row-toggle')!;
const commitRow = (scope: ParentNode, subject: string) =>
  [...scope.querySelectorAll('.wt-commit-row')].find((r) => r.querySelector('.wt-commit-subject')?.textContent === subject);

describe('the worktree bar counted in commits', () => {
  it('leads with the commit count and the newest subject, not the file count', async () => {
    await mount(detail());
    const text = bar().textContent ?? '';
    expect(text).toContain('3 commits');
    expect(text).toContain('latest: chore: update 1 file in src/pages');
    expect(text).not.toContain('3 files');
    expect(text).toContain('+39');
  });

  it('says uncommitted beside the count while the worktree holds work no commit has', async () => {
    await mount(detail({ worktreeDirty: true }));
    expect(bar().textContent).toContain('+ uncommitted');
  });

  it('reads a branch with no commit yet as uncommitted files', async () => {
    await mount(detail({ branchCommits: [], worktreeDirty: true }));
    expect(bar().textContent).toContain('Uncommitted');
    expect(bar().textContent).toContain('3 files');
  });

  it('keeps the file count for a runner that reports no commits', async () => {
    await mount(detail({ branchCommits: null }));
    expect(bar().textContent).toContain('3 files');
    expect(bar().textContent).not.toContain('commits');
  });

  it('opens the commit list, labels the runner’s own commit, and offers All changes', async () => {
    await mount(detail());
    await press(bar());
    const panel = container!.querySelector('.wt-commits-panel')!;
    expect(panel).toBeTruthy();
    const rows = [...panel.querySelectorAll('.wt-commit-row .wt-commit-subject')].map((r) => r.textContent);
    expect(rows).toEqual(COMMITS.map((c) => c.subject));
    expect(commitRow(panel, COMMITS[0].subject)?.textContent).toContain('Auto-saved by Orbit');
    expect(commitRow(panel, COMMITS[1].subject)?.textContent).not.toContain('Auto-saved');
    expect(commitRow(panel, COMMITS[1].subject)?.textContent).toContain('a41c9e2');
    expect(panel.textContent).toContain('All changes');
    expect(panel.textContent).toContain('based on main @ e9f1c07');
    expect(refreshSessionDiff).not.toHaveBeenCalled();
  });

  it('reads a live session’s branch again when the list opens', async () => {
    await mount(detail({ worktreeDirty: true }), false);
    await press(bar());
    expect(refreshSessionDiff).toHaveBeenCalledWith('session-with-commits');
    expect(commitRow(container!, 'Uncommitted changes')).toBeTruthy();
  });

  it('opens a commit in the drawer: its message, then only its own files', async () => {
    await mount(detail());
    await press(bar());
    await press(commitRow(container!.querySelector('.wt-commits-panel')!, COMMITS[1].subject));
    const head = document.querySelector('.wt-commit-head')!;
    expect(head.textContent).toContain('feat(rows): paginate the row list');
    expect(head.textContent).toContain('timed out past 2,000');
    const list = document.querySelector('.wt-diff-list')!;
    expect(await hoverTooltip(fileRow(list, HOOK)!)).toBe(`View diff · ${HOOK}`);
    expect(fileRow(list, API)).toBeUndefined();
    // RowList.tsx is changed by the newer commit too: its diff is the file's whole change, and the head says so.
    expect(head.textContent).toContain('whole change');
  });

  it('switches the drawer to All changes, the whole branch', async () => {
    await mount(detail());
    await press(bar());
    await press(commitRow(container!.querySelector('.wt-commits-panel')!, COMMITS[2].subject));
    await press([...document.querySelectorAll('.wt-rail-tab')].find((t) => t.textContent?.startsWith('All changes')));
    expect(document.querySelector('.wt-commit-head')).toBeNull();
    const list = document.querySelector('.wt-diff-list')!;
    for (const path of [ROWS, HOOK, API]) {
      expect(fileRow(list, path), path).toBeTruthy();
    }
  });

  it('opens on All changes again after a commit was looked at and the drawer closed', async () => {
    const d = detail();
    await mount(d);
    await press(bar());
    await press(commitRow(container!.querySelector('.wt-commits-panel')!, COMMITS[1].subject));
    expect(document.querySelector('.wt-commit-head')).toBeTruthy();
    await press(document.querySelector('button[aria-label="Close"]'));
    // Opened from outside the bar (a changed-files link): no commit is named, so the whole branch.
    await rerender(d, 1);
    expect(document.querySelector('.wt-commit-head')).toBeNull();
    const tab = [...document.querySelectorAll('.wt-rail-tab')].find((t) => t.textContent?.startsWith('All changes'));
    expect(tab?.getAttribute('aria-selected')).toBe('true');
  });
});
