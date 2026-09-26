// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from '../api';
import { resolveCommitPrompt } from '../lib/commitFailure';
import { SessionOutputs } from './SessionOutputs';

// What runner-go sends for a commit that met an index.lock somebody still has open (worktree.go):
// git's words plus its own line in commitError, and its plain sentence in commitResultMessage.
const GIT_OUTPUT =
  "fatal: Unable to create '/root/orbit/.git/worktrees/01a0d723/index.lock': File exists.\n" +
  "the commit waited 2s for this checkout's index.lock and it was still held; it was not safe to remove: " +
  '/root/orbit/.git/worktrees/01a0d723/index.lock, which git (pid 48213) has open. Nothing was committed.';
const SUMMARY =
  "A git process (pid 48213) has held this worktree's index lock for 3 minutes. Retry once it finishes, or hand it to the session.";

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

/** A live session whose Commit failed, as GET /api/sessions/:id answers it. */
function failed(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: 'session-with-a-failed-commit',
    isolationStatus: 'worktree',
    branch: 'orbit/web-command-workspace-7960ce',
    changedFiles: [
      { path: 'src/web/src/components/TasksSidePanel.tsx', additions: 68, deletions: 1 },
      { path: 'src/web/src/components/TasksSidePanel.workspaceStep.test.tsx', additions: 307, deletions: 0 },
    ],
    worktreeDirty: true,
    commitStatus: 'error',
    commitError: GIT_OUTPUT,
    commitResultMessage: SUMMARY,
    ...over,
  } as unknown as SessionDetail;
}

async function mount(detail: SessionDetail, onResolveCommitInSession?: () => void): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AntApp>
            <SessionOutputs
              detail={detail}
              onCommit={() => undefined}
              onResolveCommitInSession={onResolveCommitInSession}
            />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

const text = (el: Element | null | undefined) => el?.textContent ?? null;
const button = (scope: HTMLElement, label: RegExp) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => label.test(b.textContent ?? ''));

describe('a failed commit on the worktree bar', () => {
  it('leads with what happened and why, with git\'s words folded away', async () => {
    const bar = await mount(failed(), () => undefined);

    expect(text(bar.querySelector('.wt-commit-fail-head'))).toBe("Couldn't commit — git is busy in this worktree");
    expect(text(bar.querySelector('.wt-commit-fail-why'))).toBe(SUMMARY);
    expect(bar.querySelector('.wt-commit-fail-git'), "git's words are open before anyone asked").toBeNull();
    expect(bar.textContent, "git's words leaked into the folded panel").not.toContain('File exists');
    expect(button(bar, /Retry commit/), 'Retry commit is still the row\'s action').toBeTruthy();
  });

  it('unfolds git\'s words byte for byte, and folds them again', async () => {
    const bar = await mount(failed());
    const toggle = button(bar, /Show git output/)!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await act(async () => toggle.click());
    expect(text(bar.querySelector('.wt-commit-fail-git'))).toBe(GIT_OUTPUT);
    expect(toggle.textContent).toBe('Hide git output ▾');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    await act(async () => toggle.click());
    expect(bar.querySelector('.wt-commit-fail-git')).toBeNull();
  });

  it('hands the failure to the session from "Resolve in session"', async () => {
    const resolve = vi.fn();
    const bar = await mount(failed(), resolve);

    await act(async () => button(bar, /Resolve in session/)!.click());
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('offers no "Resolve in session" when the page cannot resume the session', async () => {
    const bar = await mount(failed());
    expect(button(bar, /Resolve in session/)).toBeUndefined();
  });

  it('names a lock problem even when the runner was too old to explain it', async () => {
    const bar = await mount(failed({ commitResultMessage: null }));

    expect(text(bar.querySelector('.wt-commit-fail-head'))).toBe("Couldn't commit — git is busy in this worktree");
    expect(text(bar.querySelector('.wt-commit-fail-why'))).toBe(
      "Another git process holds this worktree's index lock. Retry once it finishes, or hand it to the session.",
    );
    expect(button(bar, /Show git output/), "git's words must stay one click away").toBeTruthy();
  });

  it('calls a failure that is not about the lock just what it is', async () => {
    const error = 'error: Your local changes to the following files would be overwritten by merge';
    const bar = await mount(failed({ commitError: error, commitResultMessage: null }));

    expect(text(bar.querySelector('.wt-commit-fail-head'))).toBe("Couldn't commit");
    expect(text(bar.querySelector('.wt-commit-fail-why'))).toBe(error);
    expect(button(bar, /git output/), 'a one-line error has nothing more to unfold').toBeUndefined();
  });
});

describe('what "Resolve in session" asks the session to do', () => {
  it('names the branch, carries what the bar said, and says not to push', () => {
    const prompt = resolveCommitPrompt('orbit/web-command-workspace-7960ce', SUMMARY);
    expect(prompt).toContain(`It said: "${SUMMARY}"`);
    expect(prompt).toContain('checked out on orbit/web-command-workspace-7960ce.');
    expect(prompt).toContain('index.lock that no process has open');
    expect(prompt.trim().endsWith('Do not push.')).toBe(true);
  });
});
