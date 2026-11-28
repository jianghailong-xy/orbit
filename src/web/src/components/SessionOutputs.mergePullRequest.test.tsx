// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { LandingPullRequestView } from '@orbit/shared';
import type { SessionDetail } from '../api';
import { SessionOutputs } from './SessionOutputs';

// docs/design/protected-branch-landing.md §4.6, §11.2: GitHub refused the push to main, so the runner opened a
// pull request and the merge waits on it. The bar names the pull request, not a failure or a fresh Merge button.

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

const pr: LandingPullRequestView = {
  number: 214,
  url: 'https://github.com/o/r/pull/214',
  state: 'OPEN',
  condition: null,
  checks: { passed: 2, required: 6, failed: [] },
  mergeMethod: null,
  mergedSha: null,
  refusal: { via: 'PULL_REQUEST', message: 'Changes must be made through a pull request.' },
};

async function mount(over: Partial<SessionDetail>): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const detail = {
    id: 'session-with-a-pull-request',
    isolationStatus: 'worktree',
    branch: 'orbit/session-4d0665',
    changedFiles: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
    worktreeDirty: false,
    mergeStatus: 'pull_request',
    mergeTarget: 'main',
    ...over,
  } as unknown as SessionDetail;
  await act(async () => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SessionOutputs detail={detail} onMergeToMain={() => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

describe('a merge waiting on its pull request', () => {
  it('links to the pull request with its state instead of offering Merge or a failure', async () => {
    const bar = await mount({ mergePullRequest: pr });
    const link = bar.querySelector<HTMLAnchorElement>('a.wt-merge-pr');
    expect(link?.href).toBe('https://github.com/o/r/pull/214');
    expect(link?.textContent).toBe('Pull request open #214 · 2 of 6 ↗');
    expect(bar.querySelector('.wt-merge-btn')).toBeNull();
    expect(bar.querySelector('.wt-bar-fail')).toBeNull();
  });

  it('says a pull request is open before the server has read it', async () => {
    const bar = await mount({ mergePullRequest: null });
    expect(bar.querySelector('.wt-merge-pr')?.textContent).toBe('Pull request open');
    expect(bar.querySelector('.wt-merge-btn')).toBeNull();
  });
});
