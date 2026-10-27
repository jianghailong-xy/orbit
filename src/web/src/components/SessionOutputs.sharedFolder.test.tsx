// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail } from '../api';
import { InitializeGitSteps, SessionOutputs } from './SessionOutputs';

/**
 * The notice above the composer for a session the runner could not give a worktree
 * (`isolationStatus: 'shared-nogit'`): it edits its workspace's folder directly. It has to say that
 * in words a reader recognizes — which folder, that it is not a git repository, what that costs —
 * say what Initialize git… will do, and close.
 */

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

/** A session running directly in its workspace's folder, as GET /api/sessions/:id answers it. */
const shared = (id = 'session-in-a-plain-folder') =>
  ({ id, isolationStatus: 'shared-nogit', branch: 'orbit/weekly-summary-3f9a1c', changedFiles: null }) as unknown as SessionDetail;

type Props = Parameters<typeof SessionOutputs>[0];

async function mount(props: Props): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SessionOutputs {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return container;
}

const notice = (scope: HTMLElement) => scope.querySelector<HTMLElement>('.wt-bar-nogit');
const headline = (scope: HTMLElement) => notice(scope)?.querySelector('.wt-warn')?.textContent ?? null;
const detailLine = (scope: HTMLElement) => notice(scope)?.querySelector('.wt-notice-detail')?.textContent ?? null;
const buttonNamed = (scope: HTMLElement, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  );

describe('a folder that is not a git repository', () => {
  it('names the folder, says it is not a git repository, and what working in it directly costs', async () => {
    const view = await mount({
      detail: shared(),
      sharedFolder: { path: '/Users/alex/notes', isGit: false },
      onEnableIsolation: () => undefined,
      onKeepShared: () => undefined,
    });

    expect(headline(view)).toBe('⚠ /Users/alex/notes isn’t a git repository');
    expect(notice(view)!.querySelector('.wt-warn code')?.textContent).toBe('/Users/alex/notes');
    expect(detailLine(view)).toBe(
      'Sessions here edit the folder directly: no branch or diff to review, and sessions running at the same time can overwrite each other’s changes.',
    );
    expect(view.textContent).not.toContain('Shared workDir');
  });

  it('offers Initialize git… and a ✕ that keeps it as a plain folder, each handed to the parent', async () => {
    const initialize = vi.fn();
    const keep = vi.fn();
    const view = await mount({
      detail: shared(),
      sharedFolder: { path: '/Users/alex/notes', isGit: false },
      onEnableIsolation: initialize,
      onKeepShared: keep,
    });

    await act(async () => buttonNamed(view, 'Initialize git…')!.click());
    expect(initialize).toHaveBeenCalledTimes(1);

    const close = buttonNamed(view, 'Keep it as a plain folder');
    expect(close?.textContent).toBe('✕');
    await act(async () => close!.click());
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it('reads a folder nobody has probed yet as not a repository, without naming it', async () => {
    const view = await mount({ detail: shared(), sharedFolder: null, onEnableIsolation: () => undefined });

    expect(headline(view)).toBe('⚠ This folder isn’t a git repository');
    expect(buttonNamed(view, 'Initialize git…')).toBeTruthy();
  });

  it('keeps its words but offers nothing to press when there is no workspace to act on', async () => {
    const view = await mount({ detail: shared(), sharedFolder: { path: '/Users/alex/notes', isGit: false } });

    expect(headline(view)).toBe('⚠ /Users/alex/notes isn’t a git repository');
    expect(notice(view)!.querySelectorAll('button')).toHaveLength(0);
  });

  it('is gone once the workspace has answered it: isolation off, or git setup queued', async () => {
    const view = await mount({
      detail: shared(),
      sharedFolder: { path: '/Users/alex/notes', isGit: false, settled: true },
      onEnableIsolation: () => undefined,
      onKeepShared: () => undefined,
    });

    expect(notice(view)).toBeNull();
  });
});

describe('a repository git could not branch for this session', () => {
  it('says so, offers no Initialize git…, and ✕ hides it for this session only', async () => {
    const keep = vi.fn();
    const props: Props = {
      detail: shared('first-session'),
      sharedFolder: { path: '/Users/alex/new-app', isGit: true },
      onEnableIsolation: () => undefined,
      onKeepShared: keep,
    };
    const view = await mount(props);

    expect(headline(view)).toBe('⚠ No branch for this session: it edits /Users/alex/new-app directly');
    expect(detailLine(view)).toBe(
      'The folder is a git repository, but git couldn’t add a worktree for this session. A repository with no commits has nothing to branch from.',
    );
    expect(buttonNamed(view, 'Initialize git…')).toBeUndefined();

    await act(async () => buttonNamed(view, 'Hide for this session')!.click());
    expect(notice(view)).toBeNull();
    // Nothing about the workspace changes: closing it is this session's business alone.
    expect(keep).not.toHaveBeenCalled();

    await mount({ ...props, detail: shared('second-session') });
    expect(headline(view)).toBe('⚠ No branch for this session: it edits /Users/alex/new-app directly');
  });
});

describe('what Initialize git… will do', () => {
  it('names the folder and the workspace and lists the runner’s steps', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root!.render(<InitializeGitSteps path="/Users/alex/notes" workspace="notes" />));

    const lines = [...container.querySelectorAll('code.wt-wedge-root, p, li')].map((el) => el.textContent);
    expect(lines).toEqual([
      '/Users/alex/notes',
      'When the next session starts in “notes”, Orbit will:',
      'run git init',
      'add a .gitignore for dependencies, build output and .env files, unless the folder has one',
      'commit the existing files as “orbit: baseline”. Nothing is pushed anywhere.',
      'Each new session then works on its own branch, with a diff you review and merge. This session keeps editing the folder directly.',
    ]);

    await act(async () => root!.render(<InitializeGitSteps />));
    expect(container.querySelector('code.wt-wedge-root')).toBeNull();
    expect(container.querySelector('p')?.textContent).toBe('When the next session starts in this workspace, Orbit will:');
  });
});
