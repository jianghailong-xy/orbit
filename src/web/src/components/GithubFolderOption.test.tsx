// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DirProbe, GithubIntegration, GithubRepository } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { newWorkspaceOf, type PickedFolder } from '../lib/machineSetup';

/**
 * From GitHub on a machine's setup card (docs/github-workspace-design.md §8, docs/mocks/github-workspace board 01
 * P1–P4, placed by board 04 A on main's one-field card: a row under the folder and its Name that swaps the folder
 * field for the picker), over the integration's routes and the directory probe relay as they answer.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  askDirProbe: vi.fn(),
  readDirProbe: vi.fn(),
}));
vi.mock('../lib/githubIntegration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/githubIntegration')>()),
  connectGithub: vi.fn(),
}));
const { api, askDirProbe, readDirProbe } = await import('../api');
const { connectGithub } = await import('../lib/githubIntegration');
const { MachineSetupCard } = await import('./MachineSetupCard');

const RUNNER_ID = encodeId('0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69');
const ROOT = '/Users/austin/orbit-repos';
const TAKEN = `${ROOT}/orbit-runner`;

const machine = (over: Record<string, unknown> = {}) =>
  ({
    id: RUNNER_ID,
    name: 'orbit@austin',
    displayName: null,
    online: true,
    status: 'ONLINE',
    activeSessions: 0,
    maxConcurrent: 16,
    reposRoot: ROOT,
    registerDir: null,
    capabilities: ['dir-probe/v1', 'create-workdir/v1', 'clone-workdir/v1'],
    engines: [{ engine: 'claude', installed: true, auth: 'yes', accounts: [] }],
    lastHeartbeatAt: '2026-11-16T09:00:00Z',
    ...over,
  }) as never;

const HOURS = 3_600_000;
const repo = (id: number, fullName: string, isPrivate: boolean, pushedAgoMs: number): GithubRepository => ({
  id,
  fullName,
  private: isPrivate,
  defaultBranch: 'main',
  installationId: 7,
  pushedAt: new Date(Date.now() - pushedAgoMs).toISOString(),
});
const REPOS: GithubRepository[] = [
  repo(11, 'orbit-labs/orbit-web', true, 2 * HOURS),
  repo(12, 'orbit-labs/orbit-runner', true, 26 * HOURS),
  repo(13, 'octo-dev/orbit-playground', false, 40 * 24 * HOURS),
  ...Array.from({ length: 7 }, (_, i) => repo(20 + i, `octo-dev/old-${i}`, false, (60 + i) * 24 * HOURS)),
];

const integration = (over: Partial<GithubIntegration> = {}): GithubIntegration => ({
  available: true,
  connected: true,
  login: 'octo-dev',
  connectedAt: '2026-11-11T00:00:00Z',
  needsReconnect: false,
  installations: [
    { id: 1, account: 'octo-dev', type: 'User', repositorySelection: 'selected', repositoryCount: 3 },
    { id: 2, account: 'orbit-labs', type: 'Organization', repositorySelection: 'all', repositoryCount: 11 },
  ],
  installUrl: 'https://github.com/apps/orbit-example/installations/new',
  workspaceCount: 0,
  ...over,
});

let view: GithubIntegration | null = integration();
const asked: string[] = [];

function runnerSays(path: string): DirProbe {
  return { path, exists: path === TAKEN, isDir: path === TAKEN, isGit: path === TAKEN, branch: null, isHome: false, freeBytes: null };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let client: QueryClient | null = null;
/** What Create workspace was pressed with. */
let created: { folder: PickedFolder; name: string } | null = null;

function Page({ runner }: { runner: never }) {
  return (
    <MachineSetupCard
      runner={runner}
      onCreate={(folder, name) => {
        created = { folder, name };
      }}
      creating={false}
      createError={null}
    />
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
const wait = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await settle();
};

async function open({ runner = machine() } = {}): Promise<HTMLDivElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter>
          <Page runner={runner} />
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
const githubRow = () => host!.querySelector<HTMLButtonElement>('.msc-github-row');
/** The step on From GitHub: the picker, under its title. */
const step = () => host!.querySelector<HTMLElement>('.msc-github');
const button = (label: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => said(b) === label);
const press = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
const chooseGithub = async () => press(githubRow()!);
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const repoRows = () => [...host!.querySelectorAll('.ghp-item')].map((row) => said(row));
/** Main's folder field: one folder name in the machine's home. */
const nameField = () => host!.querySelector<HTMLInputElement>('.msc-input input[aria-label="Folder"]')!;
/** The workspace's Name, beside Create workspace. */
const workspaceName = () =>
  [...host!.querySelectorAll<HTMLInputElement>('[data-field="name"] input')].find((input) => input.getAttribute('aria-label') === 'Name')!;
const folderField = () =>
  [...host!.querySelectorAll<HTMLInputElement>('.msc-input input')].find((input) => input.getAttribute('aria-label') === 'name')!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  created = null;
  view = integration();
  asked.length = 0;
  sessionStorage.clear();
  vi.mocked(connectGithub).mockReset();
  vi.mocked(connectGithub).mockResolvedValue(undefined);
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((async (path: string) => {
    asked.push(path);
    if (path === '/integrations/github') {
      if (!view) throw new Error('404');
      return view;
    }
    if (path.startsWith('/integrations/github/repos/')) return { defaultBranch: 'main', branches: ['main', 'release', 'fix/login'] };
    if (path.startsWith('/integrations/github/repos')) {
      const q = new URLSearchParams(path.split('?')[1] ?? '').get('q') ?? '';
      return { repositories: REPOS.filter((r) => r.fullName.includes(q)), nextCursor: null };
    }
    if (path.endsWith('/login')) return { status: null, engine: null, url: null, userCode: null, message: null };
    throw new Error(`unstubbed ${path}`);
  }) as never);
  vi.mocked(askDirProbe).mockReset();
  vi.mocked(askDirProbe).mockImplementation(async (_runner, path) => ({ path, status: 'pending' }));
  vi.mocked(readDirProbe).mockReset();
  vi.mocked(readDirProbe).mockImplementation(async (_runner, path) => ({ path, status: 'done', result: runnerSays(path) }));
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  client?.clear();
  host?.remove();
  host = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the option', () => {
  it('is not offered where the deployment has no GitHub App: the card is today’s', async () => {
    view = integration({ available: false, connected: false, login: null, installations: [], installUrl: null });
    await open();
    expect(githubRow()).toBeNull();
    expect(host!.querySelector('.msc-or')).toBeNull();
    expect(nameField()).toBeTruthy();
  });

  it('nor where the integration can’t be read', async () => {
    view = null;
    await open();
    expect(githubRow()).toBeNull();
  });

  it('is a row under the folder and its Name, behind an “or”, saying what it is', async () => {
    await open();
    expect(said(host!.querySelector('.msc-or'))).toBe('or');
    expect(said(githubRow())).toBe(
      'From GitHub NEW Clone a repository you can reach on GitHub. Orbit signs in for the clone and when it lands your work — nothing is saved on the machine.',
    );
    // The folder and the Name with Create workspace come first: the row follows them.
    const order = [...host!.querySelectorAll('[data-field], .msc-github-row')].map(
      (e) => e.getAttribute('data-field') ?? e.className.split(' ')[0],
    );
    expect(order).toEqual(['folder', 'name', 'github', 'msc-github-row']);
  });

  it('swaps the step to the picker, and Type a folder name instead swaps it back', async () => {
    await open();
    await chooseGithub();
    expect(step()).toBeTruthy();
    expect(said(step()!.querySelector('.msc-github-title'))).toBe('From GitHub NEW');
    expect(host!.querySelector('.msc-github-row')).toBeNull();
    await press(button('Type a folder name instead')!);
    expect(step()).toBeNull();
    expect(nameField()).toBeTruthy();
    expect(githubRow()).toBeTruthy();
  });

  it('is offline’s only lock: a machine that can’t make folders may still be asked to clone', async () => {
    await open({ runner: machine({ capabilities: ['dir-probe/v1', 'clone-workdir/v1'] }) });
    expect(nameField().disabled).toBe(true);
    expect(githubRow()!.disabled).toBe(false);
    await act(async () => root!.unmount());
    root = null;
    host!.remove();
    await open({ runner: machine({ online: false, status: 'OFFLINE' }) });
    expect(githubRow()!.disabled).toBe(true);
  });
});

describe('P1: not connected', () => {
  beforeEach(() => {
    view = integration({ connected: false, login: null, connectedAt: null, installations: [] });
  });

  it('says what it is and offers Connect GitHub', async () => {
    await open();
    await chooseGithub();
    const option = step()!;
    expect(said(option)).toContain(
      'Clone a repository you can reach on GitHub. Orbit signs in for the clone and when it lands your work — nothing is saved on the machine.',
    );
    expect(said(option)).toContain('Connect GitHub Opens GitHub, then comes back here.');
    // Nothing to pick until GitHub is connected, so nothing to create yet.
    expect(button('Create workspace')!.disabled).toBe(true);
  });

  it('Connect leaves for GitHub, coming back to this page, and the card comes back on From GitHub', async () => {
    await open();
    await chooseGithub();
    await press(button('Connect GitHub')!);
    expect(connectGithub).toHaveBeenCalledWith('/');
    await act(async () => root!.unmount());
    root = null;
    host!.remove();
    // GitHub sends the browser back: the same page, opened again.
    view = integration();
    await open();
    expect(step()).toBeTruthy();
    expect(said(step())).toContain('Signed in to GitHub as @octo-dev · 14 repositories');
  });

  it('a connection GitHub no longer takes asks to reconnect', async () => {
    view = integration({ needsReconnect: true });
    await open();
    await chooseGithub();
    expect(said(step())).toContain('@octo-dev needs to sign in again.');
    expect(button('Reconnect GitHub')).toBeTruthy();
  });
});

describe('P2: connected, picking a repository', () => {
  it('names the account, and lists the most recently pushed first, eight before anything is typed', async () => {
    await open();
    await chooseGithub();
    expect(said(host!.querySelector('.ghp-acct'))).toBe('Signed in to GitHub as @octo-dev · 14 repositories · Change');
    const rows = repoRows();
    expect(rows).toHaveLength(8);
    expect(rows[0]).toBe('orbit-labs/ orbit-web pushed 2 hours ago');
    expect(rows[1]).toBe('orbit-labs/ orbit-runner pushed yesterday');
    expect(rows[2]).toMatch(/^octo-dev\/ orbit-playground pushed [A-Z][a-z]{2} \d{1,2}/);
  });

  it('marks a private repository with a lock', async () => {
    await open();
    await chooseGithub();
    const marks = [...host!.querySelectorAll('.ghp-item .ghp-mark')].map((m) => m.querySelector('[aria-label="Private"]') !== null);
    expect(marks.slice(0, 3)).toEqual([true, true, false]);
  });

  it('a search is the server’s, and every match is listed', async () => {
    await open();
    await chooseGithub();
    await type(host!.querySelector<HTMLInputElement>('.ghp-search input')!, 'runner');
    await wait(400);
    expect(asked).toContain('/integrations/github/repos?q=runner');
    expect(repoRows()).toEqual(['orbit-labs/ orbit-runner pushed yesterday']);
  });

  it('offers to add repositories on GitHub when one isn’t listed', async () => {
    await open();
    await chooseGithub();
    const add = host!.querySelector<HTMLAnchorElement>('.ghp-foot a')!;
    expect(said(host!.querySelector('.ghp-foot'))).toBe('Not listed? Add repositories on GitHub');
    expect(add.href).toBe('https://github.com/apps/orbit-example/installations/new');
    expect(add.target).toBe('_blank');
  });
});

describe('P3: a repository picked', () => {
  async function pickWeb(): Promise<void> {
    await open();
    await chooseGithub();
    await press(host!.querySelector<HTMLButtonElement>('.ghp-item')!);
    await wait(450);
  }

  it('shows its default branch, and the folder under the Repos Folder named after it, checked on the machine', async () => {
    await pickWeb();
    expect(said(host!.querySelector('.ghp-picked'))).toBe('orbit-labs/orbit-web main Change');
    expect(folderField().value).toBe('orbit-web');
    expect(said(step()!.querySelector('.msc-prefix'))).toBe(`${ROOT}/`);
    expect(vi.mocked(askDirProbe).mock.calls.map(([, path]) => path)).toContain(`${ROOT}/orbit-web`);
    expect(said(step())).toContain('Cloned before the session starts. Work lands back on GitHub. Other branch');
  });

  it('on a runner that clones into its home (clone-workdir/v2), the folder goes there, as the server puts it', async () => {
    await open({ runner: machine({ capabilities: ['dir-probe/v1', 'create-workdir/v1', 'clone-workdir/v1', 'clone-workdir/v2'] }) });
    await chooseGithub();
    await press(host!.querySelector<HTMLButtonElement>('.ghp-item')!);
    await wait(450);
    expect(said(step()!.querySelector('.msc-prefix'))).toBe('/Users/austin/');
    expect(vi.mocked(askDirProbe).mock.calls.map(([, path]) => path)).toContain('/Users/austin/orbit-web');
  });

  it('the Name follows the repository’s folder until it is edited', async () => {
    await pickWeb();
    expect(workspaceName().value).toBe('orbit-web');
    await type(folderField(), 'web');
    await wait(450);
    expect(workspaceName().value).toBe('web');
    await type(workspaceName(), 'Orbit web');
    await type(folderField(), 'orbit-web');
    await wait(450);
    expect(workspaceName().value).toBe('Orbit web');
  });

  it('Create workspace makes it with the clone, sent as newWorkspace.github', async () => {
    await pickWeb();
    await press(button('Create workspace')!);
    expect(created?.name).toBe('orbit-web');
    expect(created?.folder).toEqual({
      kind: 'github',
      repoId: 11,
      repository: 'orbit-labs/orbit-web',
      private: true,
      defaultBranch: 'main',
      ref: null,
      name: 'orbit-web',
      path: `${ROOT}/orbit-web`,
    });
    expect(newWorkspaceOf(created!.folder)).toEqual({ github: { repoId: 11, folder: 'orbit-web' } });
  });

  it('a folder already there can’t be cloned into: it says so, and Create workspace is off', async () => {
    await pickWeb();
    await type(folderField(), 'orbit-runner');
    await wait(450);
    expect(said(step())).toContain('This folder already exists on orbit@austin. Pick another name.');
    expect(button('Create workspace')!.disabled).toBe(true);
  });

  it('Other branch opens a branch field, and the branch typed is sent', async () => {
    await pickWeb();
    await press(button('Other branch')!);
    await settle();
    expect(asked).toContain('/integrations/github/repos/11/branches');
    const field = host!.querySelector<HTMLInputElement>('.ghp-branch-input input')!;
    expect([...host!.querySelectorAll('datalist option')].map((o) => (o as HTMLOptionElement).value)).toEqual([
      'main',
      'release',
      'fix/login',
    ]);
    await type(field, 'release');
    await settle();
    await press(button('Create workspace')!);
    expect(newWorkspaceOf(created!.folder)).toEqual({ github: { repoId: 11, folder: 'orbit-web', ref: 'release' } });
  });

  it('Change goes back to the list', async () => {
    await pickWeb();
    await press([...host!.querySelectorAll<HTMLButtonElement>('.ghp-picked button')][0]!);
    expect(repoRows()).toHaveLength(8);
  });
});

describe('P4: picked, and ready', () => {
  it('the folder reads repository → folder, cloned before the session starts', async () => {
    await open();
    await chooseGithub();
    await press(host!.querySelector<HTMLButtonElement>('.ghp-item')!);
    await wait(450);
    expect(said(step()!.querySelector('.msc-done-line'))).toBe(
      'orbit-labs/orbit-web → ~/orbit-repos/orbit-web cloned before the session starts',
    );
    expect(button('Create workspace')!.disabled).toBe(false);
  });

  it('Type a folder name instead drops the repository: the Name follows the typed folder again', async () => {
    await open();
    await chooseGithub();
    await press(host!.querySelector<HTMLButtonElement>('.ghp-item')!);
    await wait(450);
    await press(button('Type a folder name instead')!);
    expect(workspaceName().value).toBe('');
    expect(button('Create workspace')!.disabled).toBe(true);
  });
});

describe('a machine that can’t clone yet', () => {
  it('says it updates itself first, and offers nothing to pick', async () => {
    await open({ runner: machine({ capabilities: ['dir-probe/v1', 'create-workdir/v1'] }) });
    await chooseGithub();
    expect(said(step())).toContain('orbit@austin updates itself first: this version can’t clone yet.');
    expect(host!.querySelector('.ghp-search')).toBeNull();
  });

  it('one whose updater is off says it can’t', async () => {
    await open({ runner: machine({ capabilities: ['dir-probe/v1'], selfUpdate: { state: 'disabledByEnv' } }) });
    await chooseGithub();
    expect(said(step())).toContain('orbit@austin can’t clone on this version, and it can’t update itself.');
  });
});
