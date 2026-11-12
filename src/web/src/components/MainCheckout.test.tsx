// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MainCheckoutActionResult,
  MainCheckoutChangedNotice,
  MainCheckoutResultNotice,
} from '@orbit/shared';
import { mainCheckoutResultLine } from '@orbit/shared';
import type { SessionDetail } from '../api';
import { MainCheckoutCtx, type MainCheckoutHost } from '../lib/mainCheckout';
import { MainCheckoutBar, MainCheckoutCard, MainCheckoutResultRow } from './MainCheckout';
import { SessionOutputs } from './SessionOutputs';
import { Transcript } from './Transcript';

/**
 * Board 01 B (card, bar), 02 (Shared bar) and 03 (result lines) of docs/mocks/main-checkout-git, drawn from the
 * notice payloads the apiserver writes (contract §7) and the heartbeat counts the bar reads (§4).
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  localStorage.clear();
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

async function mount(node: ReactNode, host: MainCheckoutHost | null): Promise<HTMLElement> {
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

function makeHost(over: Partial<MainCheckoutHost> = {}): MainCheckoutHost {
  return {
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    sessionTitle: 'Fix retry backoff',
    sessionBranch: 'orbit/fix-retry-backoff',
    actionsSupported: true,
    health: null,
    targets: [],
    inFlight: null,
    openReview: vi.fn(),
    move: vi.fn(),
    rescue: vi.fn(),
    push: vi.fn(),
    cancel: vi.fn(),
    askAgent: vi.fn(),
    openNewSession: vi.fn(),
    cleanUp: vi.fn(),
    viewChanges: vi.fn(),
    ...over,
  };
}

const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name,
  );

async function click(el: HTMLElement | undefined | null) {
  expect(el).toBeTruthy();
  await act(async () => {
    el!.click();
  });
}

async function menuItem(name: string): Promise<HTMLElement> {
  for (let i = 0; i < 200; i += 1) {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes(name),
    );
    if (found) return found;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`no menu item ${name}`);
}

const NOTICE: MainCheckoutChangedNotice = {
  noticeKind: 'main-checkout-changed',
  notice:
    "3 files changed in the main checkout during this turn /root/orbit on main, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them.",
  root: '/root/orbit',
  branch: 'main',
  files: [
    { path: 'src/api/client.ts', status: 'M', additions: 12, deletions: 3 },
    { path: 'src/api/retry.ts', status: 'A', additions: 41, deletions: 0 },
    { path: 'src/api/retry.test.ts', status: 'A', additions: 58, deletions: 0 },
  ],
  fileCount: 3,
  truncated: false,
  fingerprint: 'mc1:62325fb:abc',
};

describe('the main checkout card (board 01 B)', () => {
  it('says what appeared, where, and that Orbit cannot tell who wrote it, with each file and its +/−', async () => {
    const view = await mount(<MainCheckoutCard notice={NOTICE} />, makeHost());
    const text = view.textContent ?? '';
    expect(text).toContain('3 files changed in the main checkout during this turn');
    expect(text).toContain("/root/orbit on main, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them.");
    const rows = [...view.querySelectorAll('.mck-file')].map((r) => r.textContent);
    expect(rows).toEqual(['Msrc/api/client.ts+12−3', 'Asrc/api/retry.ts+41', 'Asrc/api/retry.test.ts+58']);
  });

  it('folds past 8 files into "and N more", and says when the runner stopped counting', async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `f${String(i).padStart(3, '0')}.ts`, status: 'M' as const, additions: 1 }));
    const view = await mount(
      <MainCheckoutCard notice={{ ...NOTICE, files, fileCount: 200, truncated: true }} />,
      makeHost(),
    );
    expect(view.textContent).toContain('At least 200 files changed in the main checkout during this turn');
    expect(view.querySelectorAll('.mck-file')).toHaveLength(8);
    expect(view.textContent).toContain('and 192 more');
    expect(view.textContent).toContain('Orbit stopped counting at 200 files.');
  });

  it('offers Move to this worktree first, then Review and commit to main…, with the Move hint', async () => {
    const host = makeHost();
    const view = await mount(<MainCheckoutCard notice={NOTICE} />, host);
    const buttons = [...view.querySelectorAll('.mck-card-buttons > button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Move to this worktree', 'Review and commit to main…', '⋯']);
    expect(view.querySelector('.mck-card-hint')?.textContent).toBe(
      'Copies them onto orbit/fix-retry-backoff, then clears them from the main checkout. A recovery branch is saved first.',
    );
    await click(button(view, 'Move to this worktree'));
    expect(host.move).toHaveBeenCalledWith({
      root: '/root/orbit',
      fingerprint: 'mc1:62325fb:abc',
      files: ['src/api/client.ts', 'src/api/retry.ts', 'src/api/retry.test.ts'],
      targetSessionId: 'sess-1',
    });
    await click(button(view, 'Review and commit to main…'));
    expect(host.openReview).toHaveBeenCalledWith();
    await click(view.querySelector<HTMLElement>('.mck-file'));
    expect(host.openReview).toHaveBeenCalledWith('src/api/client.ts');
  });

  it('⋯ saves to a rescue branch, puts a prompt in the composer without sending, or leaves it as is', async () => {
    const host = makeHost();
    const view = await mount(<MainCheckoutCard notice={NOTICE} />, host);
    await click(button(view, 'More actions'));
    const rescue = await menuItem('Save to a rescue branch and clean');
    expect(rescue.textContent).toContain('Keeps everything on orbit/rescue-…, then returns the main checkout to its last commit.');
    await click(rescue);
    expect(host.rescue).toHaveBeenCalledWith({ root: '/root/orbit', fingerprint: 'mc1:62325fb:abc' });

    await click(button(view, 'More actions'));
    const ask = await menuItem('Ask the agent about it');
    expect(ask.textContent).toContain('Puts a prompt in the composer; nothing changes until you send it.');
    await click(ask);
    expect(host.askAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.askAgent!).mock.calls[0][0]).toContain('src/api/client.ts, src/api/retry.ts and src/api/retry.test.ts');
    expect(host.move).not.toHaveBeenCalled();

    await click(button(view, 'More actions'));
    await click(await menuItem('Leave as is'));
    expect(view.querySelector('.mck-card-actions')).toBeNull();
    // The files stay: leaving it is a decision about the buttons, not the record.
    expect(view.querySelectorAll('.mck-file')).toHaveLength(3);
  });

  it('draws the text and no buttons when the runner lacks main-checkout-git/v1', async () => {
    const host = makeHost({ actionsSupported: false });
    const view = await mount(<MainCheckoutCard notice={NOTICE} />, host);
    expect(view.textContent).toContain('3 files changed in the main checkout during this turn');
    expect(view.querySelector('.mck-card-actions')).toBeNull();
    expect(view.querySelector<HTMLButtonElement>('.mck-file')?.disabled).toBe(true);
  });

  it('is what the transcript draws for a main-checkout-changed system event', async () => {
    const view = await mount(
      <Transcript events={[{ seq: 1, type: 'system', payload: NOTICE as unknown as Record<string, unknown> }]} />,
      makeHost(),
    );
    expect(view.querySelector('.mck-card')).not.toBeNull();
    expect(view.querySelector('.chat-notice')).toBeNull();
  });
});

const HEALTH = { root: '/root/orbit', state: 'dirty', branch: 'main', paths: [], fileCount: 3, ahead: 0, upstream: 'origin/main' };

describe('the main checkout bar (board 01⑤ / 02④)', () => {
  it('says the checkout has uncommitted files, with Review', async () => {
    const host = makeHost({ health: HEALTH });
    const view = await mount(<MainCheckoutBar />, host);
    expect(view.querySelector('.mck-bar')?.textContent).toBe('Main checkoutmain3 uncommitted filesReview');
    await click(button(view, 'Review'));
    expect(host.openReview).toHaveBeenCalled();
  });

  it('says a clean checkout with unpushed commits, with Push to origin/main', async () => {
    const host = makeHost({ health: { ...HEALTH, state: 'clean', fileCount: 0, ahead: 1 } });
    const view = await mount(<MainCheckoutBar />, host);
    expect(view.querySelector('.mck-bar')?.textContent).toBe('Main checkoutmainClean · 1 commit not pushedPush to origin/main');
    await click(button(view, 'Push to origin/main'));
    expect(host.push).toHaveBeenCalled();
  });

  it('is not drawn while the checkout is clean and pushed', async () => {
    const view = await mount(<MainCheckoutBar />, makeHost({ health: { ...HEALTH, state: 'clean', fileCount: 0 } }));
    expect(view.querySelector('.mck-bar')).toBeNull();
  });

  it('keeps its words and drops its buttons without the capability', async () => {
    const view = await mount(<MainCheckoutBar />, makeHost({ health: HEALTH, actionsSupported: false }));
    expect(view.querySelector('.mck-bar')?.textContent).toBe('Main checkoutmain3 uncommitted files');
    expect(view.querySelectorAll('.mck-bar button')).toHaveLength(0);
  });

  it('sits above the worktree bar of a worktree session', async () => {
    const detail = {
      id: 'sess-1',
      isolationStatus: 'worktree',
      branch: 'orbit/fix-retry-backoff',
      changedFiles: [{ path: 'a.ts', additions: 1, deletions: 0, status: 'M' }],
    } as unknown as SessionDetail;
    const view = await mount(<SessionOutputs detail={detail} />, makeHost({ health: HEALTH }));
    const bars = [...view.querySelectorAll('.wt-bar')];
    expect(bars[0].classList.contains('mck-bar')).toBe(true);
    expect(bars[1].textContent).toContain('fix-retry-backoff');
  });

  it('is a Shared session’s Git bar too, with Review and commit…', async () => {
    const detail = { id: 'sess-2', isolationStatus: 'shared', branch: null, changedFiles: null } as unknown as SessionDetail;
    const host = makeHost({ sessionBranch: undefined, health: HEALTH });
    const view = await mount(<SessionOutputs detail={detail} />, host);
    expect(view.querySelector('.mck-bar')?.textContent).toBe('Main checkoutmain3 uncommitted filesReview and commit…');
    await click(button(view, 'Review and commit…'));
    expect(host.openReview).toHaveBeenCalled();
  });
});

const BASE: Pick<MainCheckoutActionResult, 'root' | 'finishedAt'> = { root: '/root/orbit', finishedAt: '2026-11-12T00:00:00Z' };

function resultNotice(result: MainCheckoutActionResult): MainCheckoutResultNotice {
  return {
    noticeKind: 'main-checkout-action-result',
    notice: mainCheckoutResultLine(result, { sessionId: 'sess-1', isolated: true }).text,
    result,
  };
}

async function row(result: MainCheckoutActionResult, host = makeHost()) {
  const view = await mount(<MainCheckoutResultRow notice={resultNotice(result)} />, host);
  return { view, host, line: view.querySelector('.mck-result')!, link: view.querySelector<HTMLButtonElement>('.mck-link') };
}

describe('result lines (board 03)', () => {
  it('Moved: bold lead, the rescue branch as code, View changes opens this session’s diff', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r1', kind: 'move', status: 'done', fileCount: 3, remaining: 0, rescueBranch: 'orbit/rescue-5f2c1a9',
      targetSessionId: 'sess-1',
    });
    expect(line.textContent).toBe(
      'Moved 3 files into this worktree. The main checkout is clean again. A copy of what it held is on orbit/rescue-5f2c1a9. View changes',
    );
    expect(line.querySelector('strong')?.textContent).toBe('Moved 3 files into this worktree.');
    expect(line.querySelector('code')?.textContent).toBe('orbit/rescue-5f2c1a9');
    expect(line.classList.contains('mck-result-ok')).toBe(true);
    await click(link);
    expect(host.viewChanges).toHaveBeenCalled();
  });

  it('Committed: Push to origin/main pushes', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r2', kind: 'commit', status: 'done', fileCount: 3, branch: 'main', head: '8d41e0c00000',
      subject: 'Add retry backoff', upstream: 'origin/main',
    });
    expect(line.textContent).toContain('Committed 3 files to main in the main checkout as 8d41e0c “Add retry backoff”. Not pushed yet.');
    expect(link?.textContent).toBe('Push to origin/main');
    await click(link);
    expect(host.push).toHaveBeenCalled();
  });

  it('Pushed: no link', async () => {
    const { line, link } = await row({
      ...BASE, requestId: 'r3', kind: 'push', status: 'done', branch: 'main', upstream: 'origin/main',
      remoteBefore: '62325fb0000', remoteAfter: '8d41e0c0000',
    });
    expect(line.textContent).toBe('Pushed main to origin (62325fb..8d41e0c).');
    expect(link).toBeNull();
  });

  it('Saved: the rescue branch and the commit it returned to; Open in a new session opens a draft about it', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r4', kind: 'rescue', status: 'done', fileCount: 3, rescueBranch: 'orbit/rescue-5f2c1a9', head: '62325fb000',
    });
    expect(line.textContent).toBe(
      'Saved 3 files to orbit/rescue-5f2c1a9 and returned the main checkout to 62325fb. Ignored files were left alone. Open in a new session',
    );
    expect(link?.textContent).toBe('Open in a new session');
    await click(link);
    expect(host.openNewSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.openNewSession!).mock.calls[0][0]).toContain('saved to orbit/rescue-5f2c1a9');
  });

  it('Nothing moved (stale): Review again reopens the drawer', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r5', kind: 'move', status: 'refused', code: 'FINGERPRINT_STALE', paths: ['src/api/retry.ts'],
    });
    expect(line.textContent).toBe('Nothing moved: the main checkout changed since you looked (src/api/retry.ts). Review again');
    expect(line.classList.contains('mck-result-refused')).toBe(true);
    await click(link);
    expect(host.openReview).toHaveBeenCalled();
  });

  it('Nothing moved (conflict): ask the agent to combine them fills the composer', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r6', kind: 'move', status: 'refused', code: 'MOVE_CONFLICT', branch: 'main', paths: ['src/api/client.ts'],
    });
    expect(line.textContent).toBe(
      'Nothing moved: src/api/client.ts is also changed in this worktree, in the same lines. Commit it to main or save it to a rescue branch instead, or ask the agent to combine them.',
    );
    // The sentence's own words are the link, as on the board, not a second copy after it.
    expect(link?.textContent).toBe('ask the agent to combine them');
    expect(link?.nextSibling?.textContent).toBe('.');
    await click(link);
    expect(vi.mocked(host.askAgent!).mock.calls[0][0]).toContain('src/api/client.ts');
  });

  it('Push rejected: Ask the agent to rebase and push fills the composer', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r7', kind: 'push', status: 'refused', code: 'PUSH_REJECTED', branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2,
    });
    expect(line.textContent).toContain("Push rejected: origin/main has 2 commits the main checkout doesn't.");
    await click(link);
    expect(vi.mocked(host.askAgent!).mock.calls[0][0]).toContain('Never force-push');
  });

  it('Push failed: git’s reason, no link', async () => {
    const { line, link } = await row({
      ...BASE, requestId: 'r8', kind: 'push', status: 'refused', code: 'PUSH_AUTH_FAILED', branch: 'main', gitMessage: 'Permission denied (publickey)',
    });
    expect(line.textContent).toContain('Push failed: the runner\'s git couldn\'t authenticate to origin (“Permission denied (publickey)”).');
    expect(link).toBeNull();
  });

  it('Can’t commit (rebase): Clean up checkout', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r9', kind: 'commit', status: 'refused', code: 'CHECKOUT_BLOCKED', state: 'rebase',
    });
    expect(line.textContent).toBe("Can't commit right now: the main checkout is in the middle of a rebase. Clean up checkout");
    await click(link);
    expect(host.cleanUp).toHaveBeenCalled();
  });

  it('Waiting for the runner: Cancel cancels that request', async () => {
    const { line, link, host } = await row({
      ...BASE, requestId: 'r10', kind: 'commit', status: 'waiting', code: 'RUNNER_OFFLINE', runnerName: 'orbit-hpc', minutes: 3,
    });
    expect(line.textContent).toContain("Waiting for the runner — orbit-hpc hasn't checked in for 3 min.");
    expect(line.classList.contains('mck-result-waiting')).toBe(true);
    await click(link);
    expect(host.cancel).toHaveBeenCalledWith('r10');
  });

  it('is what the transcript draws for a main-checkout-action-result system event', async () => {
    const notice = resultNotice({ ...BASE, requestId: 'r11', kind: 'push', status: 'refused', code: 'NOTHING_TO_PUSH', branch: 'main', upstream: 'origin/main' });
    const view = await mount(
      <Transcript events={[{ seq: 1, type: 'system', payload: notice as unknown as Record<string, unknown> }]} />,
      makeHost(),
    );
    expect(view.querySelector('.mck-result')?.textContent).toBe('Nothing to push: main is already on origin/main.');
  });
});

describe("Merge's ffClash refusal (board 03, relation to Merge)", () => {
  const detail = {
    id: 'sess-1',
    isolationStatus: 'worktree',
    branch: 'orbit/fix-retry-backoff',
    changedFiles: [{ path: 'src/api/client.ts', additions: 1, deletions: 0, status: 'M' }],
    worktreeDirty: false,
    mergeStatus: 'error',
    mergeError:
      "this branch and this machine's main checkout both change src/api/client.ts — that edit is uncommitted in main, so the merge would overwrite it. Commit or set it aside, then retry.",
  } as unknown as SessionDetail;

  it('links to the main checkout review', async () => {
    const host = makeHost();
    const view = await mount(<SessionOutputs detail={detail} onMergeToMain={() => undefined} />, host);
    await click(button(view, 'Review main checkout'));
    expect(host.openReview).toHaveBeenCalled();
  });

  it('has no link without the capability', async () => {
    const view = await mount(<SessionOutputs detail={detail} onMergeToMain={() => undefined} />, makeHost({ actionsSupported: false }));
    expect(button(view, 'Review main checkout')).toBeUndefined();
  });
});

