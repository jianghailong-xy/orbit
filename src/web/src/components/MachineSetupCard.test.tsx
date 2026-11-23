// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MANAGED_RUNNER_COPY, managedRunnerDisplay, managedSetupState, type DirProbe, type ManagedRunnerStatus } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { PickedFolder } from '../lib/machineSetup';
import type { ManagedRunner } from '../lib/managedRunner';

/**
 * The card on a machine's new session page that makes its first workspace
 * (docs/mocks/new-folder-in-home/workspace-card-with-name): a folder name in the machine's home, checked over the
 * directory probe relay as the contract answers it, and the workspace's name, which follows the folder's until
 * it is edited. No sign-in is asked.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  askDirProbe: vi.fn(),
  readDirProbe: vi.fn(),
  askClaudeHistory: vi.fn(),
  getClaudeHistory: vi.fn(),
}));
const { api, askClaudeHistory, askDirProbe, getClaudeHistory, readDirProbe } = await import('../api');
const { MachineSetupCard, RevealedOnArrival } = await import('./MachineSetupCard');

const RUNNER_ID = encodeId('0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69');
const REGISTER = '/home/orbit/code/app';
const AT: Record<string, Partial<DirProbe>> = {
  [REGISTER]: { exists: true, isDir: true, isGit: true, branch: 'main' },
  '/home/orbit': { exists: true, isDir: true, isHome: true },
  '/home/orbit/notes': { exists: true, isDir: true },
  '/home/orbit/code/api': { exists: true, isDir: true, isGit: true, branch: 'develop' },
  '/home/orbit/file.txt': { exists: true },
  '/home/orbit/payments': { exists: true, isDir: true, isGit: true, branch: 'main' },
  // In an older runner's Repos Folder already: a folder a deleted workspace left.
  '/home/orbit/orbit-repos/payments': { exists: true, isDir: true, isGit: true, branch: 'main' },
};
/** What the runner answers about `path`, as DirProbe. `~` is its to expand. */
function runnerSays(path: string): DirProbe {
  const expanded = path.startsWith('~') ? `/home/orbit${path.slice(1)}` : path;
  return { path: expanded, exists: false, isDir: false, isGit: false, branch: null, isHome: false, freeBytes: null, ...AT[expanded] };
}

const engines = (claude: 'yes' | 'no' = 'no', codex: 'yes' | 'no' | null = 'no') => [
  { engine: 'claude', installed: true, auth: claude, accounts: [] },
  ...(codex ? [{ engine: 'codex', installed: true, auth: codex, accounts: [] }] : []),
];

const machine = (over: Record<string, unknown> = {}) =>
  ({
    id: RUNNER_ID,
    name: 'orbit@austin',
    displayName: null,
    online: true,
    status: 'ONLINE',
    activeSessions: 0,
    maxConcurrent: 16,
    reposRoot: '/home/orbit/orbit-repos',
    registerDir: REGISTER,
    capabilities: ['dir-probe/v1', 'create-workdir/v1', 'create-workdir/v2'],
    engines: engines(),
    lastHeartbeatAt: '2026-10-31T09:00:00Z',
    ...over,
  }) as never;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let client: QueryClient | null = null;
const onCreate = vi.fn();

function render(
  runner: never,
  {
    creating = false,
    createError = null as string | null,
    welcome = false,
    managed = null as ManagedRunner | null,
    headless = false,
  } = {},
) {
  return (
    <QueryClientProvider client={client!}>
      <MemoryRouter>
        <MachineSetupCard runner={runner} managed={managed} onCreate={onCreate} creating={creating} createError={createError} welcome={welcome} headless={headless} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(
  runner: never = machine(),
  options: { creating?: boolean; createError?: string | null; welcome?: boolean; managed?: ManagedRunner | null; headless?: boolean } = {},
): Promise<HTMLDivElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(render(runner, options)));
  await settle();
  return host;
}

/** The same card, told about its machine again, or how its Create went: what the page's next render does. */
async function rerender(runner: never, options: { creating?: boolean; createError?: string | null } = {}): Promise<void> {
  await act(async () => root!.render(render(runner, options)));
  await settle();
}

async function unmount(): Promise<void> {
  await act(async () => root!.unmount());
  root = null;
  host!.remove();
}

/** What a reader sees of an element, its pieces apart: most of them are laid out by gaps, not spaces. */
function said(element: Element | null | undefined): string {
  const pieces: string[] = [];
  const walk = document.createTreeWalker(element ?? document.createElement('div'), NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) pieces.push(walk.currentNode.textContent ?? '');
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}
const field = (which: 'folder' | 'name') => host!.querySelector<HTMLInputElement>(`[data-field="${which}"] input`)!;
const line = (which: 'folder' | 'name') => said(host!.querySelector(`[data-field="${which}"] .msc-line`));
const createButton = () =>
  [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => said(b) === 'Create workspace')!;
const press = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** A folder's name, typed and left long enough to be asked about where it would go. */
async function checkFolder(name: string): Promise<void> {
  await type(field('folder'), name);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onCreate.mockReset();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((async (path: string) => {
    throw new Error(`unstubbed ${path}`);
  }) as never);
  vi.mocked(askDirProbe).mockReset();
  vi.mocked(askDirProbe).mockImplementation(async (_runner, path) => ({ path, status: 'pending' }));
  vi.mocked(readDirProbe).mockReset();
  vi.mocked(readDirProbe).mockImplementation(async (_runner, path) => ({ path, status: 'done', result: runnerSays(path) }));
  // No folder holds Claude Code history unless a test says so.
  vi.mocked(askClaudeHistory).mockReset();
  vi.mocked(askClaudeHistory).mockRejectedValue(new Error('no history here'));
  vi.mocked(getClaudeHistory).mockReset();
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

describe('the card: a new workspace, from a folder and a name', () => {
  it('says what it makes, and asks a folder and a name and nothing else', async () => {
    const page = await open();
    expect(said(page.querySelector('.msc-title'))).toBe('New workspace on orbit@austin');
    expect(said(page.querySelector('.msc-sub'))).toBe(
      'Pick the folder on orbit@austin this workspace works in. Its sessions can read and change everything in it.',
    );
    expect(page.querySelectorAll('input')).toHaveLength(2);
    expect(said(page.querySelector('.msc-prefix'))).toBe('/home/orbit/');
    expect(field('name').placeholder).toBe('Same as the folder');
    expect(line('folder')).toBe('Uses this folder if it exists, otherwise creates it.');
    expect(line('name')).toBe('Same as the folder unless you change it. Shown in the sidebar.');
    expect(createButton().disabled).toBe(true);
    // No sign-in, no steps, no second button.
    expect(page.textContent).not.toContain('Sign in');
    expect(page.querySelector('.msc-num, .rsi, .msc-step')).toBeNull();
    expect(page.querySelectorAll('button')).toHaveLength(1);
    // Nothing is asked until there is a name.
    expect(askDirProbe).not.toHaveBeenCalled();
  });

  it('names a machine by its display name', async () => {
    const page = await open(machine({ displayName: 'Austin box' }));
    expect(said(page.querySelector('.msc-title'))).toBe('New workspace on Austin box');
  });

  it('a new account’s first machine is greeted instead', async () => {
    const page = await open(machine(), { welcome: true });
    expect(said(page.querySelector('.msc-title'))).not.toContain('New workspace on');
    expect(page.querySelectorAll('input')).toHaveLength(2);
  });
});

describe('the folder: one name, in the machine’s home', () => {
  it('a name nothing has yet: made with the workspace, which is named after it', async () => {
    const page = await open();
    await checkFolder('payments-api');
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/payments-api']]);
    expect(line('folder')).toBe('New folder · created with the workspace.');
    expect(page.querySelector('[data-field="folder"] .msc-verdict')).toBeNull();
    expect(field('name').value).toBe('payments-api');
    await press(createButton());
    expect(onCreate.mock.calls).toEqual([
      [{ kind: 'new', name: 'payments-api', path: '/home/orbit/payments-api' }, 'payments-api', null],
    ]);
  });

  it('is asked about on the machine once the typing stops, before it can be used', async () => {
    await open();
    await type(field('folder'), 'payments-ap');
    await type(field('folder'), 'payments-api');
    expect(line('folder')).toBe('Checking on orbit@austin…');
    expect(createButton().disabled).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    await settle();
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/payments-api']]);
    expect(createButton().disabled).toBe(false);
  });

  it('a repository there already: used as it is, with its branch', async () => {
    const page = await open();
    await checkFolder('payments');
    expect(said(page.querySelector('[data-field="folder"] .msc-verdict.ok'))).toBe('Found · git repository · main');
    await press(createButton());
    expect(onCreate.mock.calls).toEqual([
      [{ kind: 'existing', path: '/home/orbit/payments', note: 'git repository · main' }, 'payments', null],
    ]);
  });

  it('a folder there that is no repository: used, and says it will be shared', async () => {
    const page = await open();
    await checkFolder('notes');
    expect(said(page.querySelector('[data-field="folder"] .msc-verdict.warn'))).toBe(
      'Found · not a git repository — sessions will share it instead of isolating.',
    );
    expect(createButton().disabled).toBe(false);
  });

  it('a file there can’t be one, and it says why', async () => {
    await open();
    await checkFolder('file.txt');
    expect(line('folder')).toBe('There’s already a file with this name on orbit@austin. Pick another name.');
    expect(createButton().disabled).toBe(true);
  });

  it('no answer: says so, and can be asked again', async () => {
    await open();
    vi.mocked(readDirProbe).mockImplementationOnce(async (_runner, path) => ({ path, status: 'idle', result: null }));
    await checkFolder('payments-api');
    expect(line('folder')).toBe('orbit@austin didn’t answer. Check again');
    expect(createButton().disabled).toBe(true);
    const again = [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => said(b) === 'Check again')!;
    await press(again);
    expect(createButton().disabled).toBe(false);
  });

  it('a check that failed says why, not that a new folder is made', async () => {
    await open();
    vi.mocked(readDirProbe).mockImplementation(async (_runner, path) => ({
      path,
      status: 'done',
      result: { ...runnerSays(path), error: 'permission denied' },
    }));
    await checkFolder('payments-api');
    expect(line('folder')).toBe('Couldn’t check on orbit@austin: permission denied');
    expect(createButton().disabled).toBe(true);
  });

  it('an answer about a name typed a moment ago does not stand for the name typed now', async () => {
    await open();
    await checkFolder('payments-api');
    expect(createButton().disabled).toBe(false);
    await type(field('folder'), 'payments');
    expect(createButton().disabled).toBe(true);
    expect(line('folder')).toBe('Checking on orbit@austin…');
  });

  it('refuses what the server would, and says what it takes', async () => {
    await open();
    for (const name of ['../up', 'with space', '..', 'code/api']) {
      await type(field('folder'), name);
      await settle();
      expect(createButton().disabled, name).toBe(true);
      expect(line('folder'), name).toBe('Use letters, digits, dots, dashes and underscores, up to 64 characters.');
    }
  });

  it('on a runner that makes folders only in its Repos Folder, the name goes there', async () => {
    const page = await open(machine({ capabilities: ['dir-probe/v1', 'create-workdir/v1'] }));
    expect(said(page.querySelector('.msc-prefix'))).toBe('/home/orbit/orbit-repos/');
    await checkFolder('payments');
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/orbit-repos/payments']]);
  });
});

describe('a full path (docs/mocks/new-workspace-form, decision 2 A)', () => {
  const HISTORY = {
    conversations: 2,
    transcripts: [
      { id: 't1', title: 'Fix the flaky spec', lastActiveAt: '2026-11-10T08:00:00.000Z', messages: 12, bytes: 2048 },
      { id: 't2', title: 'Plan', lastActiveAt: '2026-11-09T08:00:00.000Z', messages: 4, bytes: 1024 },
    ],
    windowDays: 30,
    bytes: 3072,
  };

  it('is asked about as typed, drops the home prefix, and is used as it stands', async () => {
    const page = await open();
    await checkFolder('/home/orbit/code/api');
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/code/api']]);
    expect(page.querySelector('[data-field="folder"] .msc-prefix')).toBeNull();
    expect(said(page.querySelector('[data-field="folder"] .msc-verdict.ok'))).toBe('Found · git repository · develop');
    expect(field('name').value).toBe('api');
    await press(createButton());
    expect(onCreate.mock.calls).toEqual([
      [{ kind: 'existing', path: '/home/orbit/code/api', note: 'git repository · develop' }, 'api', null],
    ]);
  });

  it('takes ~ as the machine’s home, and never makes a folder outside it', async () => {
    await open();
    await checkFolder('~/nowhere');
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '~/nowhere']]);
    expect(line('folder')).toBe('No such directory on orbit@austin.');
    expect(createButton().disabled).toBe(true);
  });

  it('a managed runner that isn’t up takes it only once it can check it', async () => {
    const managed = managedIn('sleeping');
    expect(managedSetupState(RUNNER_ID, managed.status)).toBe('asleep');
    await open(machine({ online: false, status: 'OFFLINE' }), { managed });
    await checkFolder('/srv/app');
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(line('folder')).toBe('orbit@austin checks a full path once it’s up.');
    expect(createButton().disabled).toBe(true);
  });

  it('a folder there with Claude Code history offers it, and Create carries what is picked', async () => {
    vi.mocked(askClaudeHistory).mockReset();
    vi.mocked(askClaudeHistory).mockResolvedValue(undefined as never);
    vi.mocked(getClaudeHistory).mockResolvedValue({ status: 'done', result: HISTORY } as never);
    const page = await open();
    await checkFolder('/home/orbit/code/api');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 3200)));
    await settle();
    expect(vi.mocked(askClaudeHistory)).toHaveBeenCalledWith(RUNNER_ID, '/home/orbit/code/api');
    const choices = [...page.querySelectorAll<HTMLElement>('[data-field="history"] [role="radio"]')];
    expect(choices).toHaveLength(3);
    await press(choices[1]);
    await press(createButton());
    expect(onCreate.mock.calls).toEqual([
      [{ kind: 'existing', path: '/home/orbit/code/api', note: 'git repository · develop' }, 'api', { history: HISTORY, mode: 'latest' }],
    ]);
  }, 15_000);

  it('a new folder never asks about history', async () => {
    await open();
    await checkFolder('payments-api');
    expect(askClaudeHistory).not.toHaveBeenCalled();
  });
});

describe('in Settings (decision 1 A): the same card, headless', () => {
  it('draws no head, and its hint says a full path is taken', async () => {
    const page = await open(machine(), { headless: true });
    expect(page.querySelector('.msc-head')).toBeNull();
    expect(line('folder')).toBe('A name in /home/orbit, or a full path. Uses the folder if it exists, otherwise creates it.');
  });
});

describe('the name: the folder’s until it is edited', () => {
  it('follows the folder as it is typed', async () => {
    await open();
    await type(field('folder'), 'orb');
    expect(field('name').value).toBe('orb');
    await type(field('folder'), 'orbit');
    expect(field('name').value).toBe('orbit');
  });

  it('once edited it stays, whatever the folder becomes, and is what is made', async () => {
    await open();
    await checkFolder('payments');
    await type(field('name'), 'Payments backend');
    expect(line('name')).toBe('Shown in the sidebar. You can rename it later.');
    await checkFolder('notes');
    expect(field('name').value).toBe('Payments backend');
    await press(createButton());
    expect(onCreate.mock.calls[0][1]).toBe('Payments backend');
  });

  it('is sent trimmed', async () => {
    await open();
    await checkFolder('payments');
    await type(field('name'), '  支付 后端  ');
    await press(createButton());
    expect(onCreate.mock.calls[0][1]).toBe('支付 后端');
  });

  it('emptied, nothing can be made, and it is not filled back in', async () => {
    const page = await open();
    await checkFolder('payments');
    await type(field('name'), '');
    expect(line('name')).toBe('Give the workspace a name.');
    expect(page.querySelector('[data-field="name"] .msc-verdict.bad')).not.toBeNull();
    expect(createButton().disabled).toBe(true);
    await checkFolder('notes');
    expect(field('name').value).toBe('');
    expect(createButton().disabled).toBe(true);
  });

  it('Enter in either field is Create workspace', async () => {
    await open();
    await checkFolder('app');
    await act(async () => {
      field('folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await act(async () => {
      field('name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[0]).toEqual([{ kind: 'new', name: 'app', path: '/home/orbit/app' }, 'app', null]);
  });
});

describe('Create workspace', () => {
  it('while it is made: both fields and the button wait', async () => {
    await open();
    await checkFolder('app');
    await rerender(machine(), { creating: true });
    expect(field('folder').disabled).toBe(true);
    expect(field('name').disabled).toBe(true);
    expect(createButton().disabled).toBe(true);
    expect(field('folder').value).toBe('app');
  });

  it('refused: says why under the folder, and keeps what was typed', async () => {
    await open();
    await checkFolder('app');
    await type(field('name'), 'My app');
    await rerender(machine(), { createError: 'This runner is too old to make a new folder' });
    expect(line('folder')).toBe('Couldn’t create the workspace: This runner is too old to make a new folder');
    expect(field('folder').value).toBe('app');
    expect(field('name').value).toBe('My app');
    expect(createButton().disabled).toBe(false);
  });
});

describe('a machine that is offline, connecting, or too old', () => {
  it('offline: says so, asks nothing, and nothing can be made', async () => {
    const page = await open(machine({ online: false, status: 'OFFLINE' }));
    expect(said(page.querySelector('.msc-notice'))).toBe('orbit@austin is offline. It can’t check folders until it’s back.');
    expect(field('folder').disabled).toBe(true);
    expect(field('name').disabled).toBe(true);
    expect(createButton().disabled).toBe(true);
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(readDirProbe).not.toHaveBeenCalled();
  });

  it('approved a moment ago and not connected yet: waited for, not called offline or too old', async () => {
    const connecting = machine({ online: false, status: 'OFFLINE', lastHeartbeatAt: null, capabilities: [], engines: null });
    const page = await open(connecting);
    expect(said(page.querySelector('.msc-notice'))).toBe(
      'Waiting for orbit@austin to connect. It can check folders as soon as it does.',
    );
    expect(page.querySelectorAll('.msc-notice')).toHaveLength(1);
    expect(field('folder').disabled).toBe(true);
    // Connected: the fields open.
    await rerender(machine());
    expect(page.querySelector('.msc-notice')).toBeNull();
    expect(field('folder').disabled).toBe(false);
  });

  it('from before dir-probe/v1, or one that can’t make a folder: it updates itself first', async () => {
    for (const runner of [
      machine({ capabilities: [], version: '0.1.239' }),
      machine({ capabilities: ['dir-probe/v1'] }),
      machine({ reposRoot: null }),
    ]) {
      const page = await open(runner);
      expect(said(page.querySelector('.msc-notice'))).toBe(
        'orbit@austin updates itself first: this version can’t check folders yet.',
      );
      expect(field('folder').disabled).toBe(true);
      expect(createButton().disabled).toBe(true);
      await unmount();
    }
  });

  it('whose updater is off says that instead of promising it, and points at its page', async () => {
    const page = await open(machine({ capabilities: [], selfUpdate: { state: 'disabledByEnv' } }));
    expect(said(page.querySelector('.msc-notice'))).toBe(
      'orbit@austin can’t check folders on this version, and it can’t update itself. Open machine',
    );
    expect(page.querySelector('.msc-notice a')?.getAttribute('href')).toBe(`/settings/machines/${RUNNER_ID}`);
  });
});

describe('what lands under the card', () => {
  it('is brought into view as it arrives, and again as a picture in it loads', async () => {
    const revealed: Element[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value(this: HTMLElement) {
        revealed.push(this);
      },
    });
    try {
      client = new QueryClient();
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          <RevealedOnArrival className="msc-held">
            <img alt="screenshot" />
            <div className="msc-held-state">Waiting</div>
          </RevealedOnArrival>,
        );
      });
      const arrived = host.querySelector('.msc-held')!;
      expect(arrived.className).toBe('msc-revealed msc-held');
      expect(revealed).toEqual([arrived]);
      // The picture loading pushes the line under it back down: it is brought up again.
      await act(async () => host!.querySelector('img')!.dispatchEvent(new Event('load')));
      expect(revealed).toEqual([arrived, arrived]);
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('stops clear of the pane’s 20px fade, not in it', () => {
    const css = ['src/components/MachineSetupCard.css', 'src/web/src/components/MachineSetupCard.css']
      .map((file) => join(process.cwd(), file))
      .map((file) => {
        try {
          return readFileSync(file, 'utf8');
        } catch {
          return '';
        }
      })
      .find(Boolean)!;
    const rule = /\.msc-revealed \{([^}]*)\}/.exec(css)?.[1] ?? '';
    const margin = Number(/scroll-margin-bottom: (\d+)px/.exec(rule)?.[1] ?? 0);
    expect(margin).toBeGreaterThanOrEqual(20);
  });
});

/** The account's managed runner while it is not up (docs/managed-runner-no-default-workspace.md): it cannot check a
 *  folder, so the card takes the name unchecked and makes the workspace all the same. */
const managedFixture = JSON.parse(readFileSync(join(process.cwd(), '../shared/src/managed-runner-states.fixture.json'), 'utf8')) as {
  states: { name: string; status: ManagedRunnerStatus; setupState: string | null }[];
};
const managedIn = (name: string): ManagedRunner => {
  const status = { ...managedFixture.states.find((s) => s.name === name)!.status, runnerId: RUNNER_ID } as ManagedRunnerStatus;
  return { status, display: managedRunnerDisplay(status)! } as ManagedRunner;
};

describe('the managed runner before it is up', () => {
  for (const [name, root] of [
    // Never reported: the image's home.
    ['preparing: starting', '/home/orbit/'],
    // Asleep after it had reported its home.
    ['sleeping', '/home/orbit/'],
  ] as const) {
    it(`${name}: says why, takes an unchecked new folder, and makes the workspace`, async () => {
      const managed = managedIn(name);
      const state = managedSetupState(RUNNER_ID, managed.status)!;
      const runner = name === 'sleeping'
        ? machine({ online: false, status: 'OFFLINE', reposRoot: '/home/orbit/orbit-repos' })
        : machine({ online: false, status: 'OFFLINE', reposRoot: null, capabilities: [], engines: null, lastHeartbeatAt: null });
      const page = await open(runner, { managed });
      expect(said(page.querySelector('.msc-notice'))).toBe(MANAGED_RUNNER_COPY.setup.notice[state]);
      expect(field('folder').disabled).toBe(false);
      expect(said(page.querySelector('.msc-prefix'))).toBe(root);
      await checkFolder('my-project');
      expect(line('folder')).toBe(MANAGED_RUNNER_COPY.setup.folderUnchecked[state]);
      expect(askDirProbe).not.toHaveBeenCalled();
      expect(field('name').value).toBe('my-project');
      await press(createButton());
      expect(onCreate).toHaveBeenCalledWith({ kind: 'new', name: 'my-project', path: `${root}my-project` }, 'my-project', null);
    });
  }

  it('asleep since an image that declared create-workdir/v1 only: offers its home, where it makes it on waking', async () => {
    const managed = managedIn('sleeping');
    const runner = machine({ online: false, status: 'OFFLINE', reposRoot: '/home/orbit/orbit-repos', capabilities: ['dir-probe/v1', 'create-workdir/v1'] });
    const page = await open(runner, { managed });
    expect(said(page.querySelector('.msc-prefix'))).toBe('/home/orbit/');
  });

  it('preparing: starting, with a Repos Folder stored from an earlier image, still offers where the server makes it', async () => {
    const managed = managedIn('preparing: starting');
    const runner = machine({ online: false, status: 'OFFLINE', reposRoot: '/var/lib/orbit/home/orbit-repos', capabilities: [], engines: null });
    const page = await open(runner, { managed });
    expect(said(page.querySelector('.msc-prefix'))).toBe('/home/orbit/');
  });

  it('reads any other runner as before: offline, with nothing to type', async () => {
    const managed = managedIn('sleeping');
    const other = machine({ id: encodeId('0199f0a8-3c2e-7b51-9a6e-000000000000'), online: false, status: 'OFFLINE' });
    const page = await open(other, { managed });
    expect(said(page.querySelector('.msc-notice'))).not.toBe(MANAGED_RUNNER_COPY.setup.notice.asleep);
    expect(field('folder').disabled).toBe(true);
  });
});
