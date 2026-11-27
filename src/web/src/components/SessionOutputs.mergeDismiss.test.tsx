// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionDetail } from '../api';
import { SessionOutputs } from './SessionOutputs';

// docs/mocks/merge-error-dismiss/01-board.html: a ✕ closes a failed merge's strip.

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

async function mount(detail: SessionDetail, onDismissMergeFailure?: () => void): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionOutputs detail={detail} onMergeToMain={() => undefined} onDismissMergeFailure={onDismissMergeFailure} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

describe("closing a failed merge's strip", () => {
  for (const [name, over] of [
    ['a refused push', { mergeStatus: 'error', mergeError: 'could not push main to origin: GH006' }],
    ['a conflict', {}],
  ] as const) {
    it(`puts a ✕ on ${name} that asks the parent to dismiss it`, async () => {
      let dismissed = 0;
      const bar = await mount(conflicted(over), () => { dismissed += 1; });
      const close = bar.querySelector<HTMLButtonElement>('.wt-merge.wt-merge-closable > .wt-merge-dismiss');
      expect(close?.getAttribute('aria-label')).toBe('Dismiss');
      await act(async () => close!.click());
      expect(dismissed).toBe(1);
    });
  }

  it('has no ✕ when the parent cannot dismiss', async () => {
    const bar = await mount(conflicted());
    expect(bar.querySelector('.wt-merge-dismiss')).toBeNull();
    expect(bar.querySelector('.wt-merge-closable')).toBeNull();
  });

  it('leaves a failed commit card without one', async () => {
    const bar = await mount(conflicted({ mergeStatus: null, commitStatus: 'error', commitError: 'index.lock' }), () => undefined);
    expect(bar.querySelector('.wt-merge-dismiss')).toBeNull();
  });
});
