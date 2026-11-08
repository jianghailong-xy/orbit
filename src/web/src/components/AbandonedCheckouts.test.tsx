// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AbandonedCheckout } from '../api';

// The list and the two exits, against a control plane stubbed at the api seam: what the runner
// reported, what opening a row fetches, and what each button asks the server to do.
const api = vi.hoisted(() => ({
  getAbandonedCheckouts: vi.fn(),
  getAbandonedCheckoutDiff: vi.fn(),
  commitSession: vi.fn(async () => ({ ok: true })),
  discardSessionCheckout: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../api', () => api);
vi.mock('../lib/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

import { AbandonedCheckouts } from './AbandonedCheckouts';

const ENTRY: AbandonedCheckout = {
  sessionId: '019ed8aa-e82e-7b01-9a1f-75af5720abaa',
  sessionPublicId: 'abc123public',
  title: 'Refactor the checkout sweeper',
  branch: 'orbit/checkout-sweeper-1a2b3c',
  status: 'SUCCEEDED',
  files: [
    { path: 'src/runner-go/worktree.go', additions: 42, deletions: 7, status: 'M' },
    { path: 'docs/worktrees.md', additions: 3, deletions: 0, status: 'A' },
  ],
  hasPatches: true,
  observedAt: '2026-11-05T17:00:00.000Z',
  commitStatus: null,
  commitError: null,
  commitResultMessage: null,
};

const PATCHES = [
  {
    path: 'src/runner-go/worktree.go',
    patch: 'diff --git a/src/runner-go/worktree.go b/src/runner-go/worktree.go\n+// kept\n',
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  api.getAbandonedCheckouts.mockResolvedValue({ checkouts: [ENTRY] });
  api.getAbandonedCheckoutDiff.mockResolvedValue({ sessionId: ENTRY.sessionId, files: ENTRY.files, patches: PATCHES });
  api.commitSession.mockClear();
  api.discardSessionCheckout.mockClear();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** Wait outside the act environment, as RTL's asyncWrapper does: React queues renders scheduled
 *  inside an in-flight act callback and flushes none of them until it settles, so a query that
 *  answers inside the window could never draw what the window exists to see. */
async function waitForUi(assertion: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
}

async function mount({ canDiscard = true }: { canDiscard?: boolean } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AbandonedCheckouts runnerId="runner-1" canDiscard={canDiscard} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    if (!container!.querySelector('.ac-toggle')) throw new Error('the list has not rendered yet');
  });
  return container;
}

const button = (scope: HTMLElement, label: RegExp) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''));

describe('the abandoned checkouts list', () => {
  it('lists a finished session’s checkout with its branch and change counts', async () => {
    const el = await mount();

    expect(el.textContent).toContain('Uncommitted checkouts');
    expect(el.textContent).toContain('Refactor the checkout sweeper');
    expect(el.textContent).toContain('orbit/checkout-sweeper-1a2b3c');
    expect(el.textContent).toContain('+45');
    expect(el.textContent).toContain('2 files');
    expect(button(el, /^Commit to branch$/)).toBeTruthy();
    expect(button(el, /^Discard$/)).toBeTruthy();
  });

  it('shows the diff when a row is opened', async () => {
    const el = await mount();
    const toggle = el.querySelector<HTMLButtonElement>('.ac-toggle')!;
    await act(async () => {
      toggle.click();
    });
    await waitForUi(() => {
      if (!el.querySelector('.ac-file-patch')) throw new Error('the diff has not rendered yet');
    });

    expect(api.getAbandonedCheckoutDiff).toHaveBeenCalledWith('runner-1', ENTRY.sessionId);
    expect(el.querySelector('.ac-file-path')?.textContent).toBe('src/runner-go/worktree.go');
    expect(el.querySelector('.ac-file-patch')?.textContent).toContain('+// kept');
  });

  it('commits the checkout to its branch through the session it belongs to', async () => {
    const el = await mount();
    await act(async () => {
      button(el, /^Commit to branch$/)!.click();
    });

    expect(api.commitSession).toHaveBeenCalledWith('abc123public');
  });

  it('offers no Discard on a runner too old to know one', async () => {
    const el = await mount({ canDiscard: false });

    expect(button(el, /^Commit to branch$/)).toBeTruthy();
    expect(button(el, /^Discard$/)).toBeUndefined();
  });

  it('asks before discarding, and discards through the session it belongs to', async () => {
    const el = await mount();
    await act(async () => {
      button(el, /^Discard$/)!.click();
    });

    // Nothing is asked of the server until the confirmation is answered.
    expect(api.discardSessionCheckout).not.toHaveBeenCalled();
    const confirmButton = [
      ...document.querySelectorAll<HTMLButtonElement>('.orbit-overlay-footer button'),
    ].find((b) => /^Discard$/.test(b.textContent ?? ''));
    expect(confirmButton).toBeTruthy();
    await act(async () => {
      confirmButton!.click();
    });

    expect(api.discardSessionCheckout).toHaveBeenCalledWith('abc123public');
  });
});
