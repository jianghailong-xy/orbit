// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { GithubIntegration } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingSlotDescription, queuedLabel, queuedTitle } from '../lib/runnerSlots';
import { encodeId } from '../lib/idCodec';
import {
  cloneEventOf,
  cloneFailureOf,
  cloneNow,
  cloneOf,
  githubRepositoryOf,
  hearClone,
  resetCloneHeard,
  sameWorkspace,
  useCloneHeard,
} from '../lib/workspaceClone';
import { RunNeverStartedCard, runNeverStarted } from './RunNeverStartedCard';

/**
 * A GitHub workspace's clone in the conversation (docs/github-workspace-design.md §6, §8; docs/mocks/github-workspace
 * board 01 P5): the first line while it clones, once it is done and when it failed, the queued session's words, and the
 * never-started card's two clone causes.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
vi.mock('../lib/githubIntegration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/githubIntegration')>()),
  connectGithub: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { connectGithub } = await import('../lib/githubIntegration');
const { CreatedWorkspaceLine } = await import('./CreatedWorkspaceLine');

const WORKSPACE = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a70';
const SESSION = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a71';
const RUNNER = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69';
const REPO_URL = 'https://github.com/orbit-labs/orbit-web.git';
const WORK_DIR = '/Users/austin/orbit-repos/orbit-web';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const posted: string[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function line(workspace: { cloneState: string | null; cloneError?: string | null }): Promise<HTMLDivElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CreatedWorkspaceLine
            sessionId={SESSION}
            workspace={{ id: WORKSPACE, name: 'orbit-web', workDir: WORK_DIR, repoUrl: REPO_URL, cloneError: null, ...workspace }}
            machine="orbit@austin"
            runnerId={RUNNER}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return host;
}

function said(element: Element | null | undefined): string {
  const pieces: string[] = [];
  const walk = document.createTreeWalker(element ?? document.createElement('div'), NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) pieces.push(walk.currentNode.textContent ?? '');
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}
const button = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => said(b) === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetCloneHeard();
  posted.length = 0;
  for (const fn of Object.values(toast)) fn.mockReset();
  vi.mocked(connectGithub).mockReset();
  vi.mocked(connectGithub).mockResolvedValue(undefined);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((async (path: string, options: { method?: string } = {}) => {
    if (options.method === 'POST') {
      posted.push(path);
      return { id: WORKSPACE, cloneState: 'PENDING' };
    }
    if (path === '/integrations/github') {
      return { available: true, connected: true, installUrl: 'https://github.com/apps/orbit-example/installations/new' } as Partial<GithubIntegration>;
    }
    throw new Error(`unstubbed ${path}`);
  }) as never);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  host?.remove();
  host = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the first line while the clone runs (P5 cloning)', () => {
  it('names the repository and the machine, with git’s percentage as a bar', async () => {
    hearClone(WORKSPACE, { state: 'CLONING', progress: 42 });
    const page = await line({ cloneState: 'CLONING' });
    expect(said(page.querySelector('.msc-created'))).toBe('Cloning orbit-labs/orbit-web on orbit@austin 42%');
    const bar = page.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(bar.querySelector<HTMLElement>('i')!.style.width).toBe('42%');
  });

  it('moves as the stream reports, without reading anything again', async () => {
    const page = await line({ cloneState: 'CLONING' });
    expect(said(page.querySelector('.msc-created'))).toBe('Cloning orbit-labs/orbit-web on orbit@austin');
    await act(async () => {
      hearClone(WORKSPACE, { state: 'CLONING', progress: 77 });
    });
    expect(said(page.querySelector('.msc-created'))).toBe('Cloning orbit-labs/orbit-web on orbit@austin 77%');
    expect(api).not.toHaveBeenCalled();
  });

  it('before the machine has started it, waits to clone', async () => {
    const page = await line({ cloneState: 'PENDING' });
    expect(said(page.querySelector('.msc-created'))).toBe('Waiting to clone orbit-labs/orbit-web on orbit@austin');
  });
});

describe('the first line once it is done (P5 done)', () => {
  it('is today’s Created workspace line with a link to the repository', async () => {
    const page = await line({ cloneState: 'READY' });
    expect(said(page.querySelector('.msc-created'))).toBe(
      `Created workspace orbit-web on orbit@austin · ${WORK_DIR} · orbit-labs/orbit-web · Rename · Settings`,
    );
    const link = page.querySelector<HTMLAnchorElement>('.msc-created-repo')!;
    expect(link.href).toBe('https://github.com/orbit-labs/orbit-web');
    expect(link.target).toBe('_blank');
  });

  it('a stored READY wins over an older percentage still heard', async () => {
    hearClone(WORKSPACE, { state: 'CLONING', progress: 99 });
    const page = await line({ cloneState: 'READY' });
    expect(said(page.querySelector('.msc-created'))).toContain('Created workspace orbit-web');
  });

  it('a workspace not from GitHub keeps today’s line, with no repository', async () => {
    const page = await line({ cloneState: null, ...({ repoUrl: null } as object) });
    expect(page.querySelector('.msc-created-repo')).toBeNull();
    expect(said(page.querySelector('.msc-created'))).toBe(`Created workspace orbit-web on orbit@austin · ${WORK_DIR} · Rename · Settings`);
  });
});

describe('the first line when the clone failed (P5 failed)', () => {
  it('folder taken: the reason, Retry and Settings', async () => {
    const page = await line({ cloneState: 'FAILED', cloneError: `${WORK_DIR} already exists on orbit@austin` });
    expect(said(page.querySelector('.msc-created'))).toBe(
      `Couldn’t clone orbit-labs/orbit-web: ${WORK_DIR} already exists on orbit@austin. Retry · Settings`,
    );
  });

  it('App removed: Install on GitHub, and Retry', async () => {
    const page = await line({
      cloneState: 'FAILED',
      cloneError:
        "GitHub refused to clone orbit-labs/orbit-web with this machine's credential, and Orbit could not get one: Orbit's GitHub App is no longer installed on orbit-labs/orbit-web. Install it again or pick another repository.",
    });
    expect(said(page.querySelector('.msc-created'))).toBe(
      'Orbit’s GitHub App is no longer installed on orbit-labs/orbit-web. Install on GitHub · Retry',
    );
    expect(page.querySelector<HTMLAnchorElement>('.msc-created a')!.href).toBe('https://github.com/apps/orbit-example/installations/new');
  });

  it('sign-in expired: Reconnect GitHub, back to this conversation, and Retry', async () => {
    const page = await line({
      cloneState: 'FAILED',
      cloneError:
        "GitHub refused to clone orbit-labs/orbit-web with this machine's credential, and Orbit could not get one: Connect GitHub in Settings → Integrations first.",
    });
    expect(said(page.querySelector('.msc-created'))).toBe('Your GitHub sign-in expired. Reconnect GitHub · Retry');
    await act(async () => button('Reconnect GitHub')!.click());
    expect(connectGithub).toHaveBeenCalledWith('/');
  });

  it('failed before its reason has been read: says so without an empty reason', async () => {
    const page = await line({ cloneState: 'FAILED', cloneError: null });
    expect(said(page.querySelector('.msc-created'))).toBe('Couldn’t clone orbit-labs/orbit-web. Retry · Settings');
  });

  it('git’s own words otherwise', async () => {
    const page = await line({ cloneState: 'FAILED', cloneError: 'git clone failed: fatal: unable to access' });
    expect(said(page.querySelector('.msc-created'))).toBe(
      'Couldn’t clone orbit-labs/orbit-web: git clone failed: fatal: unable to access. Retry · Settings',
    );
  });

  it('Retry asks the server to clone again, and the line waits to clone at once', async () => {
    const page = await line({ cloneState: 'FAILED', cloneError: `${WORK_DIR} already exists on orbit@austin` });
    await act(async () => button('Retry')!.click());
    await settle();
    expect(posted).toEqual([`/workspaces/${WORKSPACE}/clone/retry`]);
    expect(said(page.querySelector('.msc-created'))).toBe('Waiting to clone orbit-labs/orbit-web on orbit@austin');
  });
});

describe('the clone as the stream reports it', () => {
  it('reads a relay’s payload, and nothing else', () => {
    expect(cloneOf({ state: 'CLONING', progress: 41.6 })).toEqual({ state: 'CLONING', progress: 42 });
    expect(cloneOf({ state: 'READY', progress: null })).toEqual({ state: 'READY', progress: null });
    expect(cloneOf({ state: 'DONE' })).toBeNull();
    expect(cloneOf(null)).toBeNull();
  });

  it('a percentage alone is not a move of state; a state is', () => {
    expect(hearClone(WORKSPACE, { state: 'CLONING', progress: 10 })).toBe(true);
    expect(hearClone(WORKSPACE, { state: 'CLONING', progress: 20 })).toBe(false);
    expect(hearClone(WORKSPACE, { state: 'READY', progress: null })).toBe(true);
  });

  it('a stored READY is not walked back; otherwise the newer of the two wins', () => {
    expect(cloneNow('READY', { state: 'CLONING', progress: 50, at: 2_000 }, 1_000)).toEqual({ state: 'READY', progress: null });
    expect(cloneNow('CLONING', null)).toEqual({ state: 'CLONING', progress: null });
    expect(cloneNow('CLONING', { state: 'CLONING', progress: 30, at: 1_000 }, 2_000)).toEqual({ state: 'CLONING', progress: 30, at: 1_000 });
    // A Retry heard after the detail was read: the stream is ahead.
    expect(cloneNow('FAILED', { state: 'PENDING', progress: null, at: 2_000 }, 1_000)?.state).toBe('PENDING');
    // The failure this tab's stream missed, read in a detail after the Retry it heard (QA, 2026-11-16): the store is ahead.
    expect(cloneNow('FAILED', { state: 'PENDING', progress: null, at: 1_000 }, 2_000)).toEqual({ state: 'FAILED', progress: null });
  });

  it('reads the workspace off agent.changed as the server writes it (agentId), and nothing else', () => {
    expect(cloneEventOf('agent.changed', { agentId: 'abc', affectsTaskRows: false, clone: { state: 'CLONING', progress: 16 } } as never)).toEqual({
      workspaceId: 'abc',
      clone: { state: 'CLONING', progress: 16 },
    });
    expect(cloneEventOf('workspace.changed', { id: 'abc', clone: { state: 'READY', progress: null } })?.workspaceId).toBe('abc');
    expect(cloneEventOf('agent.changed', { agentId: 'abc', repoHealth: true } as never)).toBeNull();
    expect(cloneEventOf('session.updated', { id: 'abc', clone: { state: 'READY', progress: null } })).toBeNull();
  });

  it('a frame and a payload that spell the workspace differently still meet', async () => {
    expect(sameWorkspace(WORKSPACE, encodeId(WORKSPACE))).toBe(true);
    expect(sameWorkspace(WORKSPACE, null)).toBe(false);
    hearClone(WORKSPACE, { state: 'CLONING', progress: 61 });
    let seen: unknown = null;
    function Probe() {
      seen = useCloneHeard(encodeId(WORKSPACE));
      return null;
    }
    host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    expect(seen).toMatchObject({ state: 'CLONING', progress: 61 });
  });

  it('names the three failures v1 names, and nothing else', () => {
    expect(cloneFailureOf('/x already exists on m').kind).toBe('folderTaken');
    expect(cloneFailureOf("Orbit's GitHub App is no longer installed on a/b. Install it again").kind).toBe('appRemoved');
    expect(cloneFailureOf('Connect GitHub in Settings → Integrations first.').kind).toBe('signInExpired');
    expect(cloneFailureOf('git clone failed').kind).toBe('other');
    expect(githubRepositoryOf(REPO_URL)).toBe('orbit-labs/orbit-web');
    expect(githubRepositoryOf('git@github.com:a/b.git')).toBeNull();
  });
});

describe('a session its workspace’s clone holds', () => {
  it('the queued notice says it starts when the clone is done', () => {
    const gate = { queuedReason: 'WORKSPACE_CLONING' };
    expect(queuedTitle(gate)).toBe('Waiting for the clone');
    expect(queuedLabel(gate)).toBe('Waiting for the clone');
    expect(pendingSlotDescription(0, 16, gate)).toBe('Starts when the clone is done.');
  });

  it('a failed clone is named; its Retry is on the never-started card', () => {
    const gate = { queuedReason: 'WORKSPACE_CLONE_FAILED' };
    expect(queuedTitle(gate)).toBe('Clone failed');
    expect(pendingSlotDescription(0, 16, gate)).toBe(
      'This session starts once the repository is cloned.',
    );
  });

  it('RunNeverStarted: still cloning is no card, whatever an earlier run’s error said', () => {
    expect(
      runNeverStarted({
        session: { status: 'QUEUED', numTurns: 0, engineStartedAt: null, queuedReason: 'WORKSPACE_CLONING', error: 'Claude Code isn’t installed' },
        runtime: 'claude',
        runnerName: 'orbit@austin',
      }),
    ).toBeNull();
  });

  it('RunNeverStarted: a failed clone is the cause, with its Retry first', () => {
    const card = runNeverStarted({
      session: { status: 'QUEUED', numTurns: 0, engineStartedAt: null, queuedReason: 'WORKSPACE_CLONE_FAILED' },
      runtime: 'claude',
      runnerName: 'orbit@austin',
      clone: { repository: 'orbit-labs/orbit-web', error: `${WORK_DIR} already exists on orbit@austin` },
    })!;
    expect(card.cause).toBe('WORKSPACE_CLONE_FAILED');
    expect(card.why).toBe('orbit@austin couldn’t clone orbit-labs/orbit-web');
    expect(card.detail).toBe(`${WORK_DIR} already exists on orbit@austin`);
    expect(card.actions).toEqual(['retry-clone', 'open-runner']);
    const retry = vi.fn();
    const html = renderToStaticMarkup(<RunNeverStartedCard never={card} actions={{ retryClone: retry, openRunner: vi.fn() }} />);
    expect(html).toContain('data-action="retry-clone"');
    expect(html).toContain('Retry the clone');
    expect(html).toContain('This run starts once the clone is done.');
  });
});
