// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
const { MachineSetupCard, setupCredentialOf } = await import('./MachineSetupCard');

const RUNNER_ID = encodeId('0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69');
const REGISTER = '/home/orbit/code/app';
const AT: Record<string, Partial<DirProbe>> = {
  [REGISTER]: { exists: true, isDir: true, isGit: true, branch: 'main' },
  '/home/orbit': { exists: true, isDir: true, isHome: true },
  '/home/orbit/notes': { exists: true, isDir: true },
  '/home/orbit/code/api': { exists: true, isDir: true, isGit: true, branch: 'develop' },
  '/home/orbit/file.txt': { exists: true },
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
    capabilities: ['dir-probe/v1', 'create-workdir/v1'],
    engines: engines(),
    ...over,
  }) as never;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let client: QueryClient | null = null;
const onEngine = vi.fn();
const onUseApiKey = vi.fn();
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

/** What a reader sees of an element, its pieces apart: most of them are laid out by gaps, not spaces. */
function said(element: Element | null | undefined): string {
  const pieces: string[] = [];
  const walk = document.createTreeWalker(element ?? document.createElement('div'), NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) pieces.push(walk.currentNode.textContent ?? '');
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}
const options = () => [...host!.querySelectorAll('.msc-option')].map((option) => said(option));
const radio = (label: string) =>
  [...host!.querySelectorAll<HTMLElement>('.msc-option')].find((option) => said(option).startsWith(label));
const checked = () => said(host!.querySelector('.msc-option:has([data-checked])'));
const button = (label: string) =>
  [...host!.querySelectorAll<HTMLButtonElement>('button')].find((b) => said(b) === label);
const useFolder = () => button('Use this folder')!;
const press = async (element: HTMLElement) => {
  await act(async () => element.click());
  await settle();
};
const choose = async (label: string) => {
  await press(radio(label)!.querySelector<HTMLElement>('[role="radio"]')!);
};
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const nameField = () => host!.querySelector<HTMLInputElement>('.msc-input input')!;
const pathField = () => host!.querySelector<HTMLInputElement>('input.msc-path-input')!;
/** The path, typed and left long enough to be asked about. */
async function checkPath(path: string): Promise<void> {
  await type(pathField(), path);
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
  it('says what it asks for, and that nothing is made until a send', async () => {
    const page = await open();
    expect(said(page.querySelector('.msc-title'))).toBe('Set up orbit@austin');
    expect(said(page.querySelector('.msc-sub'))).toBe(
      'Pick where it works and sign in a coding CLI. Anything you send waits until both are done.',
    );
    expect(said(page.querySelector('.msc-foot'))).toBe(
      'Nothing is created until you send. You can rename the workspace or change these later.',
    );
    expect(page.querySelector('.msc-foot.ready')).toBeNull();
  });

  it('names a machine by its display name', async () => {
    const page = await open({ runner: machine({ displayName: 'Austin box' }) });
    expect(said(page.querySelector('.msc-title'))).toBe('Set up Austin box');
  });

  it('both done: says what the send will make', async () => {
    const page = await open({
      runner: machine({ engines: engines('yes') }),
      ready: true,
      start: { kind: 'existing', path: REGISTER, note: 'git repository · main' },
    });
    expect(said(page.querySelector('.msc-foot.ready'))).toBe(
      'Ready. Send a task — Orbit adds the workspace “app” for /home/orbit/code/app as it starts.',
    );
    // Both steps are their done lines: no question is left on the card.
    expect(said(page.querySelector('[data-step="folder"]'))).toBe('Folder /home/orbit/code/app git repository · main Change');
    expect(said(page.querySelector('[data-step="engine"]'))).toBe('Claude Code signed in on orbit@austin');
    expect(page.querySelectorAll('.msc-num.done')).toHaveLength(2);
  });

  it('both done on a new folder: the workspace it names is the folder’s', async () => {
    const page = await open({
      runner: machine({ engines: engines('yes') }),
      ready: true,
      start: { kind: 'new', name: 'payments-api', path: '/home/orbit/orbit-repos/payments-api' },
    });
    expect(said(page.querySelector('.msc-foot.ready'))).toBe(
      'Ready. Send a task — Orbit adds the workspace “payments-api” for /home/orbit/orbit-repos/payments-api as it starts.',
    );
    expect(said(page.querySelector('[data-step="folder"]'))).toBe(
      'Folder /home/orbit/orbit-repos/payments-api new folder · created as the session starts Change',
    );
  });
});

describe('rule 2: the folder orbit register ran in', () => {
  it('there, and a git repository: listed first and chosen, and asked about on the machine', async () => {
    await open();
    expect(askDirProbe).toHaveBeenCalledWith(RUNNER_ID, REGISTER);
    expect(options()).toEqual([
      '/home/orbit/code/app Found · git repository · main Where you ran orbit register',
      'A new folder Starts empty. Ask for a clone or a new project in your first message.',
      'Another folder on orbit@austin',
    ]);
    expect(checked()).toContain('/home/orbit/code/app');
    expect(host!.querySelector('.msc-verdict.ok')).not.toBeNull();
  });

  it('Use this folder sends the folder the machine named, with what it found', async () => {
    await open();
    await press(useFolder());
    expect(picked).toEqual({ kind: 'existing', path: REGISTER, note: 'git repository · main' });
  });

  it('there but no repository: listed, and a new folder is what is chosen', async () => {
    await open({ runner: machine({ registerDir: '/home/orbit/notes' }) });
    expect(options()[0]).toBe(
      '/home/orbit/notes Found · not a git repository — sessions will share it instead of isolating. Where you ran orbit register',
    );
    expect(checked()).toContain('A new folder');
  });

  it('the home directory, however it was spelled: not listed (the installer’s usual case)', async () => {
    await open({ runner: machine({ registerDir: '/home/orbit' }) });
    expect(options().join()).not.toContain('Where you ran orbit register');
    expect(checked()).toContain('A new folder');
  });

  it('~ and / need no asking', async () => {
    for (const registerDir of ['~', '/']) {
      await open({ runner: machine({ registerDir }) });
      expect(askDirProbe).not.toHaveBeenCalled();
      expect(options().join()).not.toContain('Where you ran orbit register');
      await act(async () => root!.unmount());
      root = null;
      host!.remove();
    }
  });

  it('gone since: not listed', async () => {
    await open({ runner: machine({ registerDir: '/home/orbit/gone' }) });
    expect(options().join()).not.toContain('Where you ran orbit register');
  });

  it('never registered from a folder: nothing to ask, a new folder is chosen', async () => {
    await open({ runner: machine({ registerDir: null }) });
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(checked()).toContain('A new folder');
  });

  it('a name being typed is not undone by the answer arriving late', async () => {
    let answer: (value: Awaited<ReturnType<typeof readDirProbe>>) => void = () => {};
    vi.mocked(readDirProbe).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await open();
    expect(checked()).toContain('A new folder');
    await type(nameField(), 'payments-api');
    await act(async () => answer({ path: REGISTER, status: 'done', result: runnerSays(REGISTER) }));
    await settle();
    expect(checked()).toContain('A new folder');
    expect(nameField().value).toBe('payments-api');
    // The suggestion still arrived, for whoever wants it.
    expect(options()[0]).toContain('/home/orbit/code/app');
  });
});

describe('rule 3: a new folder', () => {
  it('goes under the machine’s Repos Folder, and needs a name', async () => {
    const page = await open({ runner: machine({ registerDir: null }) });
    expect(said(page.querySelector('.msc-prefix'))).toBe('/home/orbit/orbit-repos/');
    expect(useFolder().disabled).toBe(true);

    await type(nameField(), 'payments-api');
    await settle();
    expect(useFolder().disabled).toBe(false);
    await press(useFolder());
    expect(picked).toEqual({ kind: 'new', name: 'payments-api', path: '/home/orbit/orbit-repos/payments-api' });
  });

  it('refuses what the server would, and says what it takes', async () => {
    const page = await open({ runner: machine({ registerDir: null }) });
    for (const name of ['../up', 'with space', '..']) {
      await type(nameField(), name);
      await settle();
      expect(useFolder().disabled, name).toBe(true);
      expect(said(page.querySelector('.msc-verdict.bad')), name).toBe(
        'Use letters, digits, dots, dashes and underscores, up to 64 characters.',
      );
    }
  });

  it('Enter in the field is the button beside it', async () => {
    await open({ runner: machine({ registerDir: null }) });
    await type(nameField(), 'app');
    await act(async () => {
      nameField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(picked).toMatchObject({ kind: 'new', name: 'app' });
  });

  it('is not offered by a machine that can’t make one (contract §3.1)', async () => {
    for (const runner of [
      machine({ capabilities: ['dir-probe/v1'] }),
      machine({ reposRoot: null }),
    ]) {
      await open({ runner });
      expect(options().join()).not.toContain('A new folder');
      await act(async () => root!.unmount());
      root = null;
      host!.remove();
    }
  });
});

describe('rule 4: another folder', () => {
  const openOther = async () => {
    const page = await open();
    await choose('Another folder');
    return page;
  };

  it('is checked on the machine as it is typed, and only once the typing stops', async () => {
    const page = await openOther();
    vi.mocked(askDirProbe).mockClear();
    await type(pathField(), '/home/orbit/co');
    await type(pathField(), '/home/orbit/notes');
    expect(said(page.querySelector('.msc-verdict.wait'))).toBe('Checking on orbit@austin…');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    await settle();
    expect(vi.mocked(askDirProbe).mock.calls).toEqual([[RUNNER_ID, '/home/orbit/notes']]);
  });

  it('a path that isn’t there can’t be used', async () => {
    const page = await openOther();
    await checkPath('/home/orbit/code/ap');
    expect(said(page.querySelector('.msc-verdict.bad'))).toBe('No such directory on orbit@austin.');
    expect(useFolder().disabled).toBe(true);
  });

  it('nor a file', async () => {
    const page = await openOther();
    await checkPath('/home/orbit/file.txt');
    expect(said(page.querySelector('.msc-verdict.bad'))).toBe('That isn’t a directory on orbit@austin.');
    expect(useFolder().disabled).toBe(true);
  });

  it('one that is no repository can, and says it will be shared', async () => {
    const page = await openOther();
    await checkPath('/home/orbit/notes');
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

  it('a repository shows its branch', async () => {
    const page = await openOther();
    await checkPath('/home/orbit/code/api');
    expect(said(page.querySelector('.msc-verdict.ok:not(:has(*))'))).toBeTruthy();
    expect(page.textContent).toContain('Found · git repository · develop');
    expect(useFolder().disabled).toBe(false);
  });

  it('a typed ~ is the runner’s to expand, and what is kept is what it resolved', async () => {
    await openOther();
    await checkPath('~/notes');
    expect(askDirProbe).toHaveBeenCalledWith(RUNNER_ID, '~/notes');
    await press(useFolder());
    expect(picked).toMatchObject({ kind: 'existing', path: '/home/orbit/notes' });
  });

  it('an answer about what was typed a moment ago does not stand for what is typed now', async () => {
    const page = await openOther();
    await checkPath('/home/orbit/notes');
    expect(useFolder().disabled).toBe(false);
    await type(pathField(), '/home/orbit/notes2');
    expect(useFolder().disabled).toBe(true);
    expect(said(page.querySelector('.msc-verdict.wait'))).toBe('Checking on orbit@austin…');
  });

  it('no answer (another question took the slot): says so, and can be asked again', async () => {
    const page = await openOther();
    vi.mocked(readDirProbe).mockImplementationOnce(async (_runner, path) => ({ path, status: 'idle', result: null }));
    await checkPath('/home/orbit/notes');
    expect(said(page.querySelector('.msc-verdict.bad'))).toBe('orbit@austin didn’t answer. Check again');
    expect(useFolder().disabled).toBe(true);

    await press(button('Check again')!);
    expect(said(page.querySelector('.msc-verdict.warn'))).toContain('not a git repository');
    expect(useFolder().disabled).toBe(false);
  });

  it('Change goes back to the question', async () => {
    const page = await open({ start: { kind: 'existing', path: REGISTER, note: 'git repository · main' } });
    await press(button('Change')!);
    expect(picked).toBeNull();
    expect(page.querySelector('.msc-options')).not.toBeNull();
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
    for (const radioButton of page.querySelectorAll('[role="radio"]')) {
      expect(radioButton.getAttribute('aria-disabled')).toBe('true');
    }
    expect(page.querySelector('.rsi')).toBeNull();
    expect(button('Use Codex instead')!.disabled).toBe(true);
    expect(said(page.querySelector('[data-step="engine"]'))).toContain('Sign in Claude Code on orbit@austin');
  });

  it('asks it nothing, and shows what it last answered', async () => {
    await open({ runner: offline() });
    expect(askDirProbe).not.toHaveBeenCalled();
    expect(readDirProbe).toHaveBeenCalledWith(RUNNER_ID, REGISTER, expect.anything());
    expect(options()[0]).toContain('Found · git repository · main');
  });

  it('with nothing stored there is nothing to show: no suggestion', async () => {
    vi.mocked(readDirProbe).mockImplementation(async (_runner, path) => ({ path, status: 'idle', result: null }));
    await open({ runner: offline() });
    expect(options().join()).not.toContain('Where you ran orbit register');
  });

  it('a folder already picked can’t be changed either', async () => {
    await open({
      runner: offline(),
      start: { kind: 'existing', path: REGISTER, note: 'git repository · main' },
    });
    expect(button('Change')!.disabled).toBe(true);
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
    expect(page.querySelector('.msc-notice a')?.getAttribute('href')).toBe(`/runners/${RUNNER_ID}`);
  });

  it('offline, the offline sentence is the one that says why', async () => {
    const page = await open({ runner: old({ online: false }) });
    expect(said(page.querySelector('.msc-notice'))).toContain('is offline');
    expect(page.querySelectorAll('.msc-notice')).toHaveLength(1);
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
