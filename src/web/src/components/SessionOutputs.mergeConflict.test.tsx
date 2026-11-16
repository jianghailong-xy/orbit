// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionDetail } from '../api';
import { SessionOutputs } from './SessionOutputs';

// docs/mocks/merge-conflict-strip/01-board.html: the conflict panel under the worktree bar.

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

function conflicted(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: 'session-with-a-conflict',
    isolationStatus: 'worktree',
    branch: 'orbit/session-4d0665',
    changedFiles: [{ path: 'src/a.ts', additions: 3, deletions: 1 }],
    worktreeDirty: false,
    mergeStatus: 'conflict',
    mergeTarget: 'main',
    ...over,
  } as unknown as SessionDetail;
}

async function mount(detail: SessionDetail, onResolveInSession?: (target: string) => void): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionOutputs detail={detail} onMergeToMain={() => undefined} onResolveInSession={onResolveInSession} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

describe('a merge conflict on the worktree bar', () => {
  it('heads the inset panel with the target, then the by-hand recipe as two steps', async () => {
    const bar = await mount(conflicted(), () => undefined);
    const panel = bar.querySelector('.wt-merge.wt-merge-conflict');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('.wt-merge-head')?.textContent).toBe('Merge conflict with main');
    expect(panel!.querySelector('.wt-merge-why')?.textContent).toBe(
      'The merge was aborted and nothing changed. Use Resolve in session, or resolve it by hand:',
    );
    const steps = [...panel!.querySelectorAll('.wt-merge-steps li')].map((li) => [
      li.querySelector('.wt-merge-where')?.textContent,
      li.querySelector('.wt-merge-cmd')?.firstChild?.textContent,
    ]);
    expect(steps).toEqual([
      ['In the session’s worktree', 'git rebase main'],
      ['Then in the repo', 'git merge --ff-only orbit/session-4d0665'],
    ]);
  });

  it('does not point at Resolve in session when the bar has no such button', async () => {
    const bar = await mount(conflicted({ mergeTarget: 'develop' }));
    expect(bar.querySelector('.wt-merge-head')?.textContent).toBe('Merge conflict with develop');
    expect(bar.querySelector('.wt-merge-why')?.textContent).toBe(
      'The merge was aborted and nothing changed. Resolve it by hand:',
    );
  });

  it('leaves a precondition failure in the plain strip', async () => {
    const bar = await mount(conflicted({ mergeStatus: 'error', mergeError: 'main has uncommitted changes' }));
    expect(bar.querySelector('.wt-merge-conflict')).toBeNull();
    expect(bar.querySelector('.wt-merge-err')?.textContent).toBe('main has uncommitted changes');
  });
});
