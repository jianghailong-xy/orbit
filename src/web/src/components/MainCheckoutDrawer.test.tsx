// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainCheckoutActionAnswer, MainCheckoutActionPost, MainCheckoutView } from '@orbit/shared';
import { getMainCheckout, postMainCheckoutAction } from '../api';
import type { MainCheckoutHost, MainCheckoutTarget } from '../lib/mainCheckout';
import { useMainCheckoutController, type MainCheckoutControllerOptions } from './MainCheckoutDrawer';

/**
 * Board 02: the session diff drawer, showing the main checkout. Files are all chosen by default, Commit waits for a
 * message, a busy session cannot take a Move, and a refusal because the checkout changed reads it again.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getMainCheckout: vi.fn(),
  postMainCheckoutAction: vi.fn(),
  cancelMainCheckoutAction: vi.fn(),
}));
vi.mock('../lib/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const getMock = vi.mocked(getMainCheckout);
const postMock = vi.mocked(postMainCheckoutAction);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let host: MainCheckoutHost | null = null;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  getMock.mockReset();
  postMock.mockReset();
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  host = null;
  document.body.innerHTML = '';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

const FILES = [
  { path: 'src/api/client.ts', status: 'M' as const, contentHash: 'h1', additions: 12, deletions: 3 },
  { path: 'src/api/retry.ts', status: 'A' as const, contentHash: 'h2', untracked: true, additions: 41, deletions: 0 },
  { path: 'src/api/retry.test.ts', status: 'A' as const, contentHash: 'h3', untracked: true, additions: 58, deletions: 0 },
];

function viewOf(over: Partial<MainCheckoutView['snapshot']> = {}, rest: Partial<MainCheckoutView> = {}): MainCheckoutView {
  return {
    snapshot: {
      root: '/root/orbit',
      branch: 'main',
      head: '62325fb00000000000000000000000000000000',
      state: 'dirty',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      files: FILES,
      fileCount: FILES.length,
      truncated: false,
      fingerprint: 'mc1:62325fb:a',
      checkedAt: new Date().toISOString(),
      ...over,
    },
    actionsSupported: true,
    managedBranch: null,
    inFlight: null,
    ...rest,
  };
}

/** Serves `current()` as the checkout, with a one-hunk patch for whichever file is asked for. */
function serve(current: () => MainCheckoutView) {
  getMock.mockImplementation(async (_ws, diffPaths = []) => ({
    ...current(),
    ...(diffPaths.length ? { diffs: diffPaths.map((p) => ({ path: p, binary: false, patch: '@@ -1 +1 @@\n-old\n+new\n' })) } : {}),
  }));
}

const TARGETS: MainCheckoutTarget[] = [
  { id: 'sess-2', title: 'Bump eslint to 9', branch: 'orbit/bump-eslint', busy: false },
  { id: 'sess-1', title: 'Fix retry backoff', branch: 'orbit/fix-retry-backoff', busy: false },
  { id: 'sess-3', title: 'Migrate settings table', branch: 'orbit/settings-v2', busy: true },
];

function Harness(props: MainCheckoutControllerOptions) {
  const c = useMainCheckoutController(props);
  host = c.host;
  return <>{c.drawer}</>;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openDrawer(over: Partial<MainCheckoutControllerOptions> = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Harness
          workspaceId="ws-1"
          sessionId="sess-1"
          sessionBranch="orbit/fix-retry-backoff"
          actionsSupported
          health={null}
          targets={TARGETS}
          {...over}
        />
      </QueryClientProvider>,
    );
  });
  await act(async () => host!.openReview());
  await waitFor(() => !!document.querySelector('.mck-choose-toggle'), 'the file list');
  await settle();
}

const byText = (sel: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.textContent?.trim() === text);
const commitButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('.mck-drawer-actions button')].find((b) => b.textContent?.startsWith('Commit'))!;
const checkbox = (path: string) => document.querySelector<HTMLElement>(`[aria-label="Commit ${path}"]`)!;

async function type(text: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Commit message"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the main checkout review drawer (board 02)', () => {
  it('names the checkout in its head and chooses every file by default', async () => {
    serve(() => viewOf());
    await openDrawer();
    const head = document.querySelector('.mck-drawer-head')?.textContent ?? '';
    expect(head).toContain('Main checkout');
    expect(head).toContain('/root/orbit');
    expect(head).toContain('main · 62325fb');
    expect(head).toContain('3 uncommitted');
    expect(head).toMatch(/Checked \d+s ago/);
    expect(document.querySelector('.mck-choose-toggle')?.textContent).toBe('Choose files to commit · 3 of 3');
    expect(FILES.every((f) => checkbox(f.path).getAttribute('aria-checked') === 'true')).toBe(true);
    expect(document.querySelector('.mck-drawer-note')?.textContent).toBe(
      'Not shown: files your .gitignore ignores. Untracked files are included.',
    );
    // The first file's patch is on show.
    await waitFor(() => !!document.querySelector('.wt-diff-pane')?.textContent?.includes('new'), 'the patch');
  });

  it('holds Commit until there is a message, counts the files chosen, and commits only those', async () => {
    serve(() => viewOf());
    postMock.mockResolvedValue({ requestId: 'x', status: 'pending' });
    await openDrawer();
    expect(commitButton().textContent).toBe('Commit 3 files to main');
    expect(commitButton().disabled).toBe(true);

    await act(async () => checkbox('src/api/retry.test.ts').click());
    expect(document.querySelector('.mck-choose-toggle')?.textContent).toBe('Choose files to commit · 2 of 3');
    expect(commitButton().textContent).toBe('Commit 2 files to main');
    expect(commitButton().disabled).toBe(true);

    await type('   ');
    expect(commitButton().disabled).toBe(true);
    await type('Add retry backoff');
    expect(commitButton().disabled).toBe(false);

    postMock.mockResolvedValueOnce({
      requestId: 'x',
      status: 'finished',
      result: {
        requestId: 'x', kind: 'commit', root: '/root/orbit', status: 'done', branch: 'main', fileCount: 2,
        head: '8d41e0c0', subject: 'Add retry backoff', finishedAt: new Date().toISOString(),
      },
    } satisfies MainCheckoutActionAnswer);
    await act(async () => commitButton().click());
    await settle();
    const body = postMock.mock.calls[0][1] as MainCheckoutActionPost;
    expect(body).toMatchObject({
      kind: 'commit',
      root: '/root/orbit',
      fingerprint: 'mc1:62325fb:a',
      files: ['src/api/client.ts', 'src/api/retry.ts'],
      message: 'Add retry backoff',
      initiatedFromSessionId: 'sess-1',
    });
    expect(typeof body.requestId).toBe('string');
    // Done: the drawer closes; the result line is written into the conversation.
    await waitFor(() => !document.querySelector('.mck-choose-toggle'), 'the drawer to close');
  });

  it('lists the session it was opened from first, and a session running a turn can’t be chosen', async () => {
    serve(() => viewOf());
    postMock.mockResolvedValue({ requestId: 'x', status: 'pending' });
    await openDrawer();
    const trigger = byText('.mck-drawer-actions button', 'Move to a worktree ▾')!;
    await act(async () => trigger.click());
    await waitFor(() => document.querySelectorAll('[role="menuitem"]').length === 3, 'the targets');
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      'Fix retry backoff orbit/fix-retry-backoffThe session you opened this from',
      'Bump eslint to 9 orbit/bump-eslint',
      'Migrate settings table orbit/settings-v2Working now — available when this turn ends',
    ]);
    expect(items[2].getAttribute('aria-disabled')).toBe('true');
    expect(items[0].getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => items[1].click());
    await settle();
    expect(postMock.mock.calls[0][1]).toMatchObject({
      kind: 'move',
      targetSessionId: 'sess-2',
      files: FILES.map((f) => f.path),
    });
  });

  it('warns before Commit when the branch is a project’s landing target', async () => {
    serve(() => viewOf({}, { managedBranch: { projectId: 'p1', projectTitle: 'Orbit', role: 'landing-target' } }));
    await openDrawer();
    const foot = document.querySelector('.mck-drawer-foot')!;
    expect(foot.querySelector('.mck-managed')?.textContent).toBe("This skips project Orbit's landing check.");
    // Before the Commit button, and it informs rather than blocks.
    expect(foot.querySelector('.mck-managed')!.compareDocumentPosition(commitButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reads the checkout again when an action finds it changed since it was reviewed', async () => {
    let current = viewOf();
    serve(() => current);
    postMock.mockImplementation(async (_ws, body) => {
      // Someone changed the checkout while the drawer was open.
      current = viewOf({
        fingerprint: 'mc1:62325fb:b',
        files: [...FILES, { path: 'src/api/types.ts', status: 'M', contentHash: 'h4', additions: 2, deletions: 1 }],
        fileCount: 4,
      });
      return {
        requestId: body.requestId,
        status: 'finished',
        result: {
          requestId: body.requestId, kind: 'commit', root: '/root/orbit', status: 'refused', code: 'FINGERPRINT_STALE',
          paths: ['src/api/types.ts'], finishedAt: new Date().toISOString(),
        },
      };
    });
    await openDrawer();
    const readsBefore = getMock.mock.calls.filter(([, d]) => !d || d.length === 0).length;
    await type('Add retry backoff');
    await act(async () => commitButton().click());
    await waitFor(
      () => document.querySelector('.mck-choose-toggle')?.textContent === 'Choose files to commit · 4 of 4',
      'the refreshed file list',
    );
    expect(getMock.mock.calls.filter(([, d]) => !d || d.length === 0).length).toBeGreaterThan(readsBefore);
    expect(document.querySelector('.mck-drawer-foot .mck-result')?.textContent).toContain(
      'Nothing committed: the main checkout changed since you looked (src/api/types.ts).',
    );
    // The drawer stayed open with the message kept, so a second look and a press is all it takes.
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Commit message"]')?.value).toBe('Add retry backoff');
  });

  it('has no Commit, Move or Save without the capability', async () => {
    serve(() => viewOf({}, { actionsSupported: false }));
    await openDrawer({ actionsSupported: false });
    expect(document.querySelector('.mck-drawer-foot')).toBeNull();
  });
});
