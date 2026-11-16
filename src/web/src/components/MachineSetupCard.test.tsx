// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DirProbe } from '@orbit/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { PickedFolder } from '../lib/machineSetup';

/**
 * The setup card on a machine's new session page (rules 1–5 of
 * docs/mocks/first-workspace-in-conversation/04-rules, sentences from boards 01 and 02), over the
 * directory probe relay as the contract answers it.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  askDirProbe: vi.fn(),
  readDirProbe: vi.fn(),
}));
const { api, askDirProbe, readDirProbe } = await import('../api');
const { MachineSetupCard, RevealedOnArrival, setupCredentialOf } = await import('./MachineSetupCard');

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
const onEngine = vi.fn();
const onUseApiKey = vi.fn();
const onCreate = vi.fn();
let picked: PickedFolder | null = null;

function Page({
  runner,
  engine,
  provider,
  ready,
  fleet,
  start,
}: {
  runner: never;
  engine: string;
  provider?: { kind: 'login' | 'key' | 'pool'; label: string } | null;
  ready: boolean;
  fleet: never[] | null;
  start: PickedFolder | null;
}) {
  const [folder, setFolder] = useState<PickedFolder | null>(start);
  return (
    <MachineSetupCard
      runner={runner}
      fleet={fleet}
      engine={engine}
      credential={setupCredentialOf(runner, engine, provider)}
      folder={folder}
      ready={ready}
      onFolder={(next) => {
        picked = next;
        setFolder(next);
      }}
      onEngine={onEngine}
      onUseApiKey={onUseApiKey}
      onCreate={onCreate}
      creating={false}
      createError={null}
    />
  );
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open({
  runner = machine(),
  engine = 'claude',
  provider,
  ready = false,
  fleet = null,
  start = null,
}: {
  runner?: never;
  engine?: string;
  provider?: { kind: 'login' | 'key' | 'pool'; label: string } | null;
  ready?: boolean;
  fleet?: never[] | null;
  start?: PickedFolder | null;
} = {}): Promise<HTMLDivElement> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter>
          <Page runner={runner} engine={engine} provider={provider} ready={ready} fleet={fleet} start={start} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return host;
}

/** The same page, told about its machine again: what a refetch of the runner list does. */
async function machineReports(runner: never): Promise<void> {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <MemoryRouter>
          <Page runner={runner} engine="claude" ready={false} fleet={null} start={null} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** Until `assertion` holds: the relay's reads are 1.5 s apart. */
async function waitFor(assertion: () => void, within = 6_000): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    try {
      assertion();
      return;
    } catch (failure) {
      if (Date.now() > deadline) throw failure;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

/** What a reader sees of an element, its pieces apart: most of them are laid out by gaps, not spaces. */
function said(element: Element | null | undefined): string {
  const pieces: string[] = [];
  const walk = document.createTreeWalker(element ?? document.createElement('div'), NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) pieces.push(walk.currentNode.textContent ?? '');
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}
const folderStep = () => said(host!.querySelector('[data-step="folder"]'));
const folderLine = () => said(host!.querySelector('.msc-folder > :last-child'));
const button = (label: string) =>
  [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => said(b) === label);
const useFolder = () => button('Use this folder')!;
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
const nameField = () => host!.querySelector<HTMLInputElement>('.msc-input input')!;
/** A folder's name, typed and left long enough to be asked about where it would go. */
async function checkName(name: string): Promise<void> {
  await type(nameField(), name);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  picked = null;
  onEngine.mockReset();
  onUseApiKey.mockReset();
  onCreate.mockReset();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation((async (path: string) => {
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

describe('the card’s head and foot', () => {
  it('says what it asks for, and that nothing is made until Create workspace', async () => {
    const page = await open();
    expect(said(page.querySelector('.msc-title'))).toBe('Set up orbit@austin');
    expect(said(page.querySelector('.msc-sub'))).toBe(
      'Pick where it works and sign in a coding CLI, then create the workspace.',
    );
    expect(said(page.querySelector('.msc-foot'))).toBe(
      'Nothing is created until you create the workspace. You can rename it or change these later.',
    );
    expect(page.querySelector('.msc-foot.ready')).toBeNull();
    // Nothing to create yet: the button waits for both steps.
    const create = page.querySelector<HTMLButtonElement>('.msc-create button')!;
    expect(said(create)).toBe('Create workspace');
    expect(create.disabled).toBe(true);
  });

  it('names a machine by its display name', async () => {
    const page = await open({ runner: machine({ displayName: 'Austin box' }) });
    expect(said(page.querySelector('.msc-title'))).toBe('Set up Austin box');
  });

  it('both done: says what Create workspace will make, and makes it', async () => {
    const page = await open({
      runner: machine({ engines: engines('yes') }),
      ready: true,
      start: { kind: 'existing', path: REGISTER, note: 'git repository · main' },
    });
    expect(said(page.querySelector('.msc-foot.ready'))).toBe(
      'Ready. Orbit adds the workspace “app” for /home/orbit/code/app.',
    );
    const create = page.querySelector<HTMLButtonElement>('.msc-create button')!;
    expect(create.disabled).toBe(false);
    await act(async () => create.click());
    expect(onCreate).toHaveBeenCalledTimes(1);
    // Both steps are their done lines: no question is left on the card.
    expect(said(page.querySelector('[data-step="folder"]'))).toBe('Folder /home/orbit/code/app git repository · main Change');
    expect(said(page.querySelector('[data-step="engine"]'))).toBe('Claude Code signed in on orbit@austin');
    // Folder is drawn without a step number or tick; only the sign-in step has one.
    expect(page.querySelector('[data-step="folder"] .msc-num')).toBeNull();
    expect(page.querySelectorAll('.msc-num.done')).toHaveLength(1);
  });

  it('both done on a new folder: the workspace it names is the folder’s', async () => {
    const page = await open({
      runner: machine({ engines: engines('yes') }),
      ready: true,
      start: { kind: 'new', name: 'payments-api', path: '/home/orbit/orbit-repos/payments-api' },
    });
    expect(said(page.querySelector('.msc-foot.ready'))).toBe(
      'Ready. Orbit adds the workspace “payments-api” for /home/orbit/orbit-repos/payments-api.',
    );
    expect(said(page.querySelector('[data-step="folder"]'))).toBe(
      'Folder /home/orbit/orbit-repos/payments-api new folder · created as the session starts Change',
    );
  });
});

describe('the folder step: one name, in the machine’s home', () => {
  it('asks for one name in home, and nothing else', async () => {
    const page = await open();
    expect(said(page.querySelector('.msc-prefix'))).toBe('/home/orbit/');
    // The card's one question carries no step number.
    expect(page.querySelector('[data-step="folder"] .msc-num')).toBeNull();
    expect(page.querySelectorAll('input')).toHaveLength(1);
    expect(page.querySelector('[role="radio"]')).toBeNull();
    expect(folderStep()).not.toContain('Another folder');
    expect(folderStep()).not.toContain('Where you ran orbit register');
    expect(folderLine()).toBe('Uses this folder if it exists, otherwise creates it.');
    expect(useFolder().disabled).toBe(true);
    // Nothing is asked until there is a name.
    expect(askDirProbe).not.toHaveBeenCalled();
  });

  it('a name nothing has yet: made as the session starts', async () => {
    const page = await open();
    await checkName('payments-api');
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/payments-api']]);
    expect(folderLine()).toBe('New folder · created as the session starts.');
    expect(page.querySelector('.msc-verdict')).toBeNull();
    await press(useFolder());
    expect(picked).toEqual({ kind: 'new', name: 'payments-api', path: '/home/orbit/payments-api' });
  });

  it('is asked about on the machine once the typing stops, before it can be used', async () => {
    await open();
    await type(nameField(), 'payments-ap');
    await type(nameField(), 'payments-api');
    expect(said(host!.querySelector('.msc-verdict.wait'))).toBe('Checking on orbit@austin…');
    expect(useFolder().disabled).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    await settle();
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/payments-api']]);
    expect(useFolder().disabled).toBe(false);
  });

  it('a repository there already: used as it is, with its branch', async () => {
    const page = await open();
    await checkName('payments');
    expect(said(page.querySelector('.msc-verdict.ok'))).toBe('Found · git repository · main');
    await press(useFolder());
    expect(picked).toEqual({ kind: 'existing', path: '/home/orbit/payments', note: 'git repository · main' });
    // Its line says what is there, not that it is made as the session starts.
    expect(folderStep()).toBe('Folder /home/orbit/payments git repository · main Change');
  });

  it('a folder there that is no repository: used, and says it will be shared', async () => {
    const page = await open();
    await checkName('notes');
    expect(said(page.querySelector('.msc-verdict.warn'))).toBe(
      'Found · not a git repository — sessions will share it instead of isolating.',
    );
    await press(useFolder());
    expect(picked).toEqual({
      kind: 'existing',
      path: '/home/orbit/notes',
      note: 'not a git repository — sessions will share it instead of isolating.',
    });
  });

  it('a file there can’t be one, and it says why', async () => {
    const page = await open();
    await checkName('file.txt');
    expect(said(page.querySelector('.msc-verdict.bad'))).toBe(
      'There’s already a file with this name on orbit@austin. Pick another name.',
    );
    expect(useFolder().disabled).toBe(true);
  });

  it('no answer: says so, and can be asked again', async () => {
    const page = await open();
    vi.mocked(readDirProbe).mockImplementationOnce(async (_runner, path) => ({ path, status: 'idle', result: null }));
    await checkName('payments-api');
    expect(said(page.querySelector('.msc-verdict.bad'))).toBe('orbit@austin didn’t answer. Check again');
    expect(useFolder().disabled).toBe(true);
    await press(button('Check again')!);
    expect(useFolder().disabled).toBe(false);
  });

  it('an answer about a name typed a moment ago does not stand for the name typed now', async () => {
    const page = await open();
    await checkName('payments-api');
    expect(useFolder().disabled).toBe(false);
    await type(nameField(), 'payments');
    expect(useFolder().disabled).toBe(true);
    expect(said(page.querySelector('.msc-verdict.wait'))).toBe('Checking on orbit@austin…');
  });

  it('refuses what the server would, and says what it takes', async () => {
    const page = await open();
    for (const name of ['../up', 'with space', '..', '/home/orbit/notes']) {
      await type(nameField(), name);
      await settle();
      expect(useFolder().disabled, name).toBe(true);
      expect(said(page.querySelector('.msc-verdict.bad')), name).toBe(
        'Use letters, digits, dots, dashes and underscores, up to 64 characters.',
      );
    }
  });

  it('Enter in the field is the button beside it', async () => {
    await open();
    await checkName('app');
    await act(async () => {
      nameField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(picked).toMatchObject({ kind: 'new', name: 'app', path: '/home/orbit/app' });
  });

  it('on a runner that makes folders only in its Repos Folder, the name goes there', async () => {
    const page = await open({ runner: machine({ capabilities: ['dir-probe/v1', 'create-workdir/v1'] }) });
    expect(said(page.querySelector('.msc-prefix'))).toBe('/home/orbit/orbit-repos/');
    await checkName('payments');
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/orbit-repos/payments']]);
    await press(useFolder());
    expect(picked).toEqual({ kind: 'existing', path: '/home/orbit/orbit-repos/payments', note: 'git repository · main' });
  });

  it('a machine that can’t make a folder (contract §3.1): the field is closed and the card says it updates first', async () => {
    for (const runner of [machine({ capabilities: ['dir-probe/v1'] }), machine({ reposRoot: null })]) {
      const page = await open({ runner });
      expect(nameField().disabled).toBe(true);
      expect(said(page.querySelector('.msc-notice'))).toBe(
        'orbit@austin updates itself first: this version can’t check folders yet. You can sign in meanwhile.',
      );
      await act(async () => root!.unmount());
      root = null;
      host!.remove();
    }
  });

  it('Change goes back to the question', async () => {
    const page = await open({ start: { kind: 'existing', path: REGISTER, note: 'git repository · main' } });
    await press(button('Change')!);
    expect(picked).toBeNull();
    expect(page.querySelector('.msc-folder')).not.toBeNull();
  });
});

describe('rule 1: a machine that is offline', () => {
  const offline = (over: Record<string, unknown> = {}) => machine({ online: false, status: 'OFFLINE', ...over });

  it('says so, and neither step can be taken', async () => {
    const page = await open({ runner: offline() });
    expect(said(page.querySelector('.msc-notice'))).toBe(
      'orbit@austin is offline. It can’t check folders or sign in until it’s back.',
    );
    expect(useFolder().disabled).toBe(true);
    expect(nameField().disabled).toBe(true);
    expect(page.querySelector('.rsi')).toBeNull();
    expect(button('Use Codex instead')!.disabled).toBe(true);
    expect(said(page.querySelector('[data-step="engine"]'))).toContain('Sign in Claude Code on orbit@austin');
  });

  it('asks it nothing', async () => {
    await open({ runner: offline() });
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(readDirProbe).not.toHaveBeenCalled();
  });

  it('a folder already picked can’t be changed either', async () => {
    await open({
      runner: offline(),
      start: { kind: 'existing', path: REGISTER, note: 'git repository · main' },
    });
    expect(button('Change')!.disabled).toBe(true);
  });
});

describe('a machine approved a moment ago that has not connected yet', () => {
  // What the server reads for it until its first heartbeat (contract §2): offline, never heard from, nothing declared.
  const connecting = (over: Record<string, unknown> = {}) =>
    machine({ online: false, status: 'OFFLINE', lastHeartbeatAt: null, capabilities: [], engines: null, ...over });

  it('is waited for: not called offline, and not too old to check folders', async () => {
    const page = await open({ runner: connecting() });
    expect(said(page.querySelector('.msc-notice'))).toBe(
      'Waiting for orbit@austin to connect. It can check folders and sign in as soon as it does.',
    );
    expect(page.textContent).not.toContain('updates itself first');
    expect(page.textContent).not.toContain('is offline');
    expect(page.querySelectorAll('.msc-notice')).toHaveLength(1);
  });

  it('can’t be asked or signed in on yet', async () => {
    const page = await open({ runner: connecting() });
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(readDirProbe).not.toHaveBeenCalled();
    expect(useFolder().disabled).toBe(true);
    expect(page.querySelector('.rsi')).toBeNull();
  });

  it('connected, both steps open', async () => {
    const page = await open({ runner: connecting() });
    await machineReports(machine());
    expect(page.querySelector('.msc-notice')).toBeNull();
    expect(nameField().disabled).toBe(false);
    await checkName('app');
    expect(useFolder().disabled).toBe(false);
    expect(page.querySelector('.rsi')).not.toBeNull();
  });

  it('connected on a version from before dir-probe/v1: only then is it said to update itself', async () => {
    const page = await open({ runner: connecting() });
    await machineReports(machine({ capabilities: [], version: '0.1.239' }));
    expect(said(page.querySelector('.msc-notice'))).toBe(
      'orbit@austin updates itself first: this version can’t check folders yet. You can sign in meanwhile.',
    );
  });
});

describe('a runner from before dir-probe/v1', () => {
  const old = (over: Record<string, unknown> = {}) => machine({ capabilities: [], version: '0.1.239', ...over });

  it('is asked nothing, and the card says it updates itself first', async () => {
    const page = await open({ runner: old() });
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(readDirProbe).not.toHaveBeenCalled();
    expect(said(page.querySelector('.msc-notice'))).toBe(
      'orbit@austin updates itself first: this version can’t check folders yet. You can sign in meanwhile.',
    );
    expect(useFolder().disabled).toBe(true);
  });

  it('the sign-in is still open meanwhile', async () => {
    const page = await open({ runner: old() });
    expect(page.querySelector('.rsi')).not.toBeNull();
    expect(button('Sign in to Claude Code')).toBeTruthy();
  });

  it('whose updater is off says that instead of promising it, and points at its page', async () => {
    const page = await open({ runner: old({ selfUpdate: { state: 'disabledByEnv' } }) });
    expect(said(page.querySelector('.msc-notice'))).toBe(
      'orbit@austin can’t check folders on this version, and it can’t update itself. Open machine',
    );
    expect(page.querySelector('.msc-notice a')?.getAttribute('href')).toBe(`/settings/machines/${RUNNER_ID}`);
  });

  it('offline, the offline sentence is the one that says why', async () => {
    const page = await open({ runner: old({ online: false }) });
    expect(said(page.querySelector('.msc-notice'))).toContain('is offline');
    expect(page.querySelectorAll('.msc-notice')).toHaveLength(1);
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

describe('rule 5: the sign-in', () => {
  it('follows the composer’s engine, in the machine pages’ own card', async () => {
    const page = await open();
    expect(said(page.querySelector('[data-step="engine"] .msc-step-title'))).toBe('Sign in Claude Code on orbit@austin');
    expect(said(page.querySelector('[data-step="engine"] .msc-step-help'))).toBe(
      'Sessions run on the coding CLIs signed in on that machine, and spend its subscription.',
    );
    expect(page.querySelector('.rsi')).not.toBeNull();
    expect(button('Sign in to Claude Code')).toBeTruthy();
    expect(page.textContent).toContain('Signing in fixes this runner. A key is account-wide — switch to its model to use it.');
  });

  it('on another engine, that engine’s', async () => {
    const page = await open({ engine: 'codex' });
    expect(said(page.querySelector('[data-step="engine"] .msc-step-title'))).toBe('Sign in Codex on orbit@austin');
    expect(page.querySelector('.rsi')).not.toBeNull();
    expect(button('Use Claude Code instead')).toBeTruthy();
    expect(button('Use Codex instead')).toBeUndefined();
  });

  it('offers the other engines the machine has, not the ones it lacks', async () => {
    await open({
      runner: machine({
        engines: [
          { engine: 'claude', installed: true, auth: 'no' },
          { engine: 'codex', installed: true, auth: 'no' },
          { engine: 'kimi', installed: true, auth: 'no' },
          { engine: 'antigravity', installed: false, auth: 'no' },
        ],
      }),
    });
    await press(button('Use Kimi Code instead')!);
    expect(onEngine).toHaveBeenCalledWith('kimi');
    expect(button('Use Codex instead')).toBeTruthy();
    expect(button('Use Antigravity instead')).toBeUndefined();
  });

  it('Cursor CLI only where the web draws it at all', async () => {
    const cursor = machine({
      engines: [
        { engine: 'claude', installed: true, auth: 'no' },
        { engine: 'cursor', installed: true, auth: 'no' },
      ],
    });
    await open({ runner: cursor, fleet: [] });
    expect(host!.textContent).not.toContain('Cursor');
  });

  it('nothing else installed: no other engine to offer', async () => {
    const page = await open({ runner: machine({ engines: engines('no', null) }) });
    expect(page.querySelector('.msc-alt')).toBeNull();
  });

  it('Use an API key instead is the card’s to answer', async () => {
    await open();
    await press(button('Use an API key instead')!);
    expect(onUseApiKey).toHaveBeenCalledTimes(1);
  });

  it('signed in: done, and the engine is named', async () => {
    const page = await open({ runner: machine({ engines: engines('yes') }) });
    expect(said(page.querySelector('[data-step="engine"]'))).toBe('Claude Code signed in on orbit@austin');
    expect(page.querySelector('[data-step="engine"] .msc-num.done')).not.toBeNull();
    expect(page.querySelector('.rsi')).toBeNull();
    expect(page.querySelector('.msc-alt')).toBeNull();
  });

  it('a sign-in of unknown standing is no yes', async () => {
    const page = await open({
      runner: machine({ engines: [{ engine: 'claude', installed: true, auth: 'unknown' }] }),
    });
    expect(page.querySelector('.rsi')).not.toBeNull();
  });

  it('on a key: nothing to sign in, and Change goes back to the sign-in', async () => {
    const page = await open({ provider: { kind: 'key', label: 'Anthropic' } });
    expect(said(page.querySelector('[data-step="engine"]'))).toBe('Anthropic API key Change');
    expect(page.querySelector('[data-step="engine"] .msc-num.done')).not.toBeNull();
    await press(button('Change')!);
    expect(onEngine).toHaveBeenCalledWith('claude');
  });

  it('on an engine that only runs on keys, Change goes back to one the machine signs in', async () => {
    await open({
      engine: 'dsh',
      provider: { kind: 'key', label: 'DeepSeek' },
      runner: machine({ engines: engines('no', 'yes') }),
    });
    await press(button('Change')!);
    expect(onEngine).toHaveBeenCalledWith('codex');
  });

  it('on an account pool, says so', async () => {
    const page = await open({ provider: { kind: 'pool', label: 'Team pool' } });
    expect(said(page.querySelector('[data-step="engine"]'))).toBe('Team pool account pool Change');
  });

  it('an engine this machine doesn’t have is not offered a sign-in that can’t work', async () => {
    const page = await open({ engine: 'kimi' });
    expect(page.querySelector('.rsi')).toBeNull();
    expect(said(page.querySelector('.msc-not-installed'))).toBe('Kimi Code isn’t installed on orbit@austin. Open machine');
    expect(button('Use Claude Code instead')).toBeTruthy();
  });

  it('a machine that has reported nothing yet is not called bare of engines', async () => {
    const page = await open({ runner: machine({ engines: null }) });
    expect(page.querySelector('.msc-not-installed')).toBeNull();
    expect(page.querySelector('.rsi')).not.toBeNull();
  });
});
