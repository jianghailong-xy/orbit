// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirProbe } from '@orbit/shared';
import { encodeId } from '../lib/idCodec';
import { clearToasts } from '../lib/toastStore';
import { ToastViewport } from './ToastViewport';

/**
 * A machine with no workspace in the real console (WorkspaceConsole → WorkspaceView), its first session
 * through the setup card: rules 1 and 5–8 of docs/mocks/first-workspace-in-conversation/04-rules. What is
 * sent is read off the mocked POST /sessions, so "one request makes all three" means what it says. Under
 * the real BrowserRouter, because the console reads the browser's own address to tell a page it is on
 * from one it has already left.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    askDirProbe: vi.fn(),
    createInteractiveSession: vi.fn(),
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSessionRetryMessage: vi.fn(),
    listQueuedTurns: vi.fn(),
    readDirProbe: vi.fn(),
    uploadAttachment: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const {
  api,
  ApiError,
  askDirProbe,
  createInteractiveSession,
  getSession,
  getSessionEventPage,
  getSessionRetryMessage,
  listQueuedTurns,
  readDirProbe,
  uploadAttachment,
} = await import('../api');
const apiMock = vi.mocked(api);
const createMock = vi.mocked(createInteractiveSession);
const { WorkspaceConsole } = await import('./WorkspaceConsole');

const AUSTIN = encodeId('0195c0de-0000-7000-8000-0000000000a1');
const HPC = encodeId('0195c0de-0000-7000-8000-0000000000a2');
const WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000b1');
const MADE_WORKSPACE = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const SESSION = encodeId('0195c0de-0000-7000-8000-0000000000c1');

const REGISTER = '/home/orbit/code/app';
const FOUND: DirProbe = {
  path: REGISTER,
  exists: true,
  isDir: true,
  isGit: true,
  branch: 'main',
  isHome: false,
  freeBytes: 1024,
};

const health = (engine: string, auth: 'yes' | 'no') => ({ engine, installed: true, auth, accounts: [] });

interface Machine {
  id: string;
  name: string;
  online: boolean;
  engines: unknown[] | null;
  capabilities: string[];
  registerDir: string | null;
  reposRoot: string | null;
  lastHeartbeatAt: string | null;
}
const austin = (over: Partial<Machine> = {}): Machine => ({
  id: AUSTIN,
  name: 'orbit@austin',
  online: true,
  engines: [health('claude', 'no'), health('codex', 'no')],
  capabilities: ['dir-probe/v1', 'create-workdir/v1'],
  registerDir: REGISTER,
  reposRoot: '/home/orbit/orbit-repos',
  lastHeartbeatAt: '2026-10-31T09:00:00Z',
  ...over,
});

/** What the account's Completed list holds: one session by default, none for a new account. */
let history: unknown[] = [];
let runners: Machine[];
let workspaces: unknown[];
let providers: unknown[];
let detail: Record<string, unknown>;
let events: unknown[];
let eventsHaveMore: boolean;
let patched: { path: string; body: unknown }[];
/** What POST /workspaces was asked to make, and the refusal it answers with when one is set. */
let made: unknown[];
let refuseMake: Error | null;
/** What the view scrolled: a scroller it pinned to a tail, and what it brought into view. */
let pinned: HTMLElement[];
let revealed: HTMLElement[];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
let where = '';

function Where() {
  const location = useLocation();
  where = `${location.pathname}${location.search}${location.hash}`;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  runners = [austin()];
  workspaces = [];
  providers = [];
  detail = {};
  events = [];
  eventsHaveMore = false;
  patched = [];
  made = [];
  refuseMake = null;
  where = '';
  vi.mocked(askDirProbe).mockReset();
  vi.mocked(askDirProbe).mockImplementation(async (_runner, path) => ({ path, status: 'pending' }));
  vi.mocked(readDirProbe).mockReset();
  vi.mocked(readDirProbe).mockImplementation(async (_runner, path) => ({ path, status: 'done', result: { ...FOUND, path } }));
  createMock.mockReset();
  createMock.mockImplementation(async () => {
    // The server has made the workspace by the time it answers.
    workspaces = [{ id: MADE_WORKSPACE, name: 'app', runnerId: AUSTIN, createdAt: '2026-10-31T00:00:00Z', position: null }];
    return { id: SESSION, workspaceId: MADE_WORKSPACE };
  });
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation((async () => ({
    id: SESSION,
    title: 'Fix the flaky login test',
    status: 'RUNNING',
    runStatus: 'RUNNING',
    runState: 'RUNNING',
    lifecycleState: 'OPEN',
    provider: 'claude',
    engine: 'claude',
    assignedRunnerId: AUSTIN,
    workspace: { id: MADE_WORKSPACE, name: 'app', workDir: REGISTER },
    ...detail,
  })) as never);
  vi.mocked(getSessionEventPage).mockImplementation((async () => ({ events, hasMore: eventsHaveMore })) as never);
  vi.mocked(getSessionRetryMessage).mockResolvedValue({ text: '' } as never);
  vi.mocked(listQueuedTurns).mockImplementation(async () => []);
  vi.mocked(uploadAttachment).mockReset();
  vi.mocked(uploadAttachment).mockImplementation(async () => ({ id: 'att-1' }) as never);
  apiMock.mockReset();
  history = [{ id: 'earlier' }];
  apiMock.mockImplementation(((path: string, options?: { method?: string; body?: unknown }) => {
    if (options?.method === 'PATCH') {
      patched.push({ path, body: options.body });
      return Promise.resolve({});
    }
    if (options?.method === 'POST' && path === '/workspaces') {
      if (refuseMake) return Promise.reject(refuseMake);
      made.push(options.body);
      workspaces = [{ id: MADE_WORKSPACE, name: 'app', runnerId: AUSTIN, createdAt: '2026-10-31T00:00:00Z', position: null }];
      return Promise.resolve({ id: MADE_WORKSPACE });
    }
    if (options?.method === 'POST') return Promise.reject(new Error(`unstubbed POST ${path}`));
    if (path === '/auth/capabilities') return Promise.resolve({});
    if (path === '/users/me') {
      return Promise.resolve({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/runners') return Promise.resolve(runners);
    if (path === '/workspaces') return Promise.resolve(workspaces);
    if (path === '/providers') return Promise.resolve(providers);
    if (['/providers/pools', '/providers/shared-pools', '/session-tags', '/session-folders'].includes(path)) return Promise.resolve([]);
    // An account that has had a session already: the setup card, not a new account's welcome card.
    if (path === '/sessions?view=completed&limit=1') return Promise.resolve(history);
    if (path.startsWith('/sessions?')) return Promise.resolve([]);
    if (path.endsWith('/login')) return Promise.resolve({ status: null, engine: null, url: null, userCode: null, message: null });
    if (path.startsWith(`/sessions/${SESSION}`)) {
      if (path.includes('/diff')) return Promise.resolve({ files: [] });
      if (path.includes('/created-tasks')) return Promise.resolve({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return Promise.resolve([]);
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return Promise.resolve({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return Promise.resolve({ items: [], nextCursor: null });
    return Promise.reject(new Error(`unstubbed endpoint: ${path}`));
  }) as typeof api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  pinned = [];
  revealed = [];
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} addEventListener() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement) {
      pinned.push(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    // Chromium's answers with a promise, and an effect must not hand that to React.
    value(this: HTMLElement) {
      revealed.push(this);
      return Promise.resolve();
    },
  });
});

async function closePage(): Promise<void> {
  const mountedRoot = root;
  const mountedClient = client;
  const mountedNode = container;
  root = null;
  client = null;
  container = null;
  if (mountedRoot) await act(async () => mountedRoot.unmount());
  if (mountedClient) {
    await mountedClient.cancelQueries();
    mountedClient.clear();
  }
  mountedNode?.remove();
}

afterEach(async () => {
  try {
    await closePage();
  } finally {
    act(() => clearToasts());
    window.history.replaceState(null, '', '/');
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Short act slices, each closing its scope: the router's navigations are transitions, and an act
 *  still open holds those back. */
async function waitForUi(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      assertion();
      return;
    } catch (failure) {
      if (Date.now() > deadline) throw failure;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const mounted = () => {
  if (!container) throw new Error('not mounted');
  return container;
};
const composer = () => mounted().querySelector<HTMLTextAreaElement>('.workspace-composer textarea')!;
const sendButton = () => mounted().querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
const card = () => mounted().querySelector<HTMLElement>('.msc');
const createButton = () => card()!.querySelector<HTMLButtonElement>('.msc-create button')!;
const button = (label: string) =>
  [...mounted().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
function said(element: Element | null | undefined): string {
  const pieces: string[] = [];
  const walk = document.createTreeWalker(element ?? document.createElement('div'), NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) pieces.push(walk.currentNode.textContent ?? '');
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

async function open(entry: string): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  window.history.replaceState(null, '', entry);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client!}>
        <BrowserRouter>
          <Where />
          <ToastViewport />
          <Routes>
            <Route element={<WorkspaceConsole />}>
              <Route path="workspaces/:id/*" />
              <Route path="runners/:id/new" />
              <Route path="sessions/:id" />
            </Route>
            <Route path="*" element={null} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>,
    );
  });
}

/** Austin's new session page, with the machine's answer about its register directory in. */
async function openMachine(id = AUSTIN): Promise<void> {
  await open(`/runners/${id}/new`);
  await waitForUi(() => expect(card()).toBeTruthy());
  await waitForUi(() => expect(mounted().textContent).toContain('Where you ran orbit register'));
}

async function type(text: string): Promise<void> {
  const area = composer();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send(text: string): Promise<void> {
  await type(text);
  await waitForUi(() => expect(sendButton().disabled).toBe(false));
  await act(async () => sendButton().click());
  await settle();
}

/** Create workspace, and the page it moves on to: the new workspace's draft, with its composer. */
async function create(): Promise<void> {
  await waitForUi(() => expect(createButton().disabled).toBe(false));
  await act(async () => createButton().click());
  await waitForUi(() => expect(where).toBe(`/workspaces/${MADE_WORKSPACE}/new`));
  await waitForUi(() => expect(composer()).toBeTruthy());
}

const useFolder = async () => {
  await act(async () => button('Use this folder')!.click());
  await settle();
};
/** The machine's next report: its engines as they are now, read back the way a refetch would. */
async function machineReports(machine: Machine): Promise<void> {
  runners = [machine];
  await act(async () => {
    await client!.invalidateQueries({ queryKey: ['runners'] });
  });
  await settle();
}
const signedIn = () => austin({ engines: [health('claude', 'yes'), health('codex', 'no')] });

describe('rule 1: the page itself', () => {
  it('is the setup card, in the engine hero’s place, addressed to the machine', async () => {
    await openMachine();
    expect(mounted().querySelector('.np-hero')).toBeNull();
    expect(said(card()!.querySelector('.msc-title'))).toBe('Set up orbit@austin');
    // The card alone: no session column beside it, no session title above it, no composer under it
    // (owner 2026-11-16). The card's own button makes the workspace.
    expect(mounted().querySelector('.session-col')).toBeNull();
    expect(mounted().querySelector('.session-resizer')).toBeNull();
    expect(mounted().querySelector('.workspace-header')).toBeNull();
    expect(mounted().querySelector('.workspace-composer')).toBeNull();
    expect(said(createButton())).toBe('Create workspace');
    expect(createButton().disabled).toBe(true);
  });

  it('is read from its top: the conversation’s tail pin stays away from it, however short the pane', async () => {
    await openMachine();
    const pane = card()!.closest<HTMLElement>('.workspace-sessions')!;
    expect(pinned).not.toContain(pane);
    await useFolder();
    expect(pinned).not.toContain(pane);
  });

  it('offline: the card says why, and creates nothing', async () => {
    runners = [austin({ online: false })];
    await open(`/runners/${AUSTIN}/new`);
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(said(card()!.querySelector('.msc-notice'))).toContain('orbit@austin is offline');
    expect(createButton().disabled).toBe(true);
  });

  it('approved a moment ago and not connected yet: the card waits for it', async () => {
    runners = [austin({ online: false, lastHeartbeatAt: null, capabilities: [], engines: null })];
    await open(`/runners/${AUSTIN}/new`);
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(said(card()!.querySelector('.msc-notice'))).toBe(
      'Waiting for orbit@austin to connect. It can check folders and sign in as soon as it does.',
    );
    expect(mounted().textContent).not.toContain('updates itself first');
    expect(createButton().disabled).toBe(true);
  });

  it('connected, the page sees it within seconds by itself, and the folder step opens', async () => {
    runners = [austin({ online: false, lastHeartbeatAt: null, capabilities: [], engines: null })];
    await open(`/runners/${AUSTIN}/new`);
    await waitForUi(() => expect(card()?.querySelector('.msc-notice')).toBeTruthy());
    // Its first heartbeat: nothing invalidates the list here, the page's own reads have to find it.
    runners = [austin()];
    const beat = Date.now();
    await waitForUi(() => expect(card()!.querySelector('.msc-notice')).toBeNull());
    await waitForUi(() => expect(button('Use this folder')!.disabled).toBe(false));
    expect(Date.now() - beat).toBeLessThan(5_000);
    expect(mounted().textContent).toContain('Where you ran orbit register');
  });

  it('a machine with a workspace has no card: its page goes on to that workspace’s draft', async () => {
    runners = [austin()];
    workspaces = [{ id: WORKSPACE, name: 'orbit', runnerId: AUSTIN, createdAt: '2026-01-01T00:00:00Z', position: 0 }];
    await open(`/runners/${AUSTIN}/new`);
    await waitForUi(() => expect(where).toBe(`/workspaces/${WORKSPACE}/new`));
    await waitForUi(() => expect(mounted().querySelector('.np-hero')).toBeTruthy());
    expect(card()).toBeNull();
    expect(composer().placeholder).toBe('Send this workspace a task…');
    expect(mounted().querySelector('.session-col')).toBeTruthy();
  });

  it('an older /workspaces/<runner> link lands on the same page', async () => {
    await open(`/workspaces/${AUSTIN}`);
    await waitForUi(() => expect(where).toBe(`/runners/${AUSTIN}/new`));
    await waitForUi(() => expect(card()).toBeTruthy());
  });

  it('a machine that is gone from the account has no page', async () => {
    await open(`/runners/${HPC}/new`);
    await waitForUi(() => expect(where).toBe('/'));
  });

  it('starts on an engine that can run: a signed-in Codex, not a sign-in for Claude Code', async () => {
    runners = [austin({ engines: [health('claude', 'no'), health('codex', 'yes')] })];
    await openMachine();
    expect(said(card()!.querySelector('[data-step="engine"]'))).toBe('Codex signed in on orbit@austin');
  });
});

describe('Create workspace, once both steps are done', () => {
  it('waits for the second step when only the first is done', async () => {
    await openMachine();
    await useFolder();
    expect(createButton().disabled).toBe(true);
  });

  it('waits for the first step when only the second is done', async () => {
    runners = [signedIn()];
    await openMachine();
    expect(createButton().disabled).toBe(true);
  });

  it('an existing folder by its path, and the page moves on to the workspace’s draft', async () => {
    runners = [signedIn()];
    await openMachine();
    await useFolder();
    expect(said(card()!.querySelector('.msc-foot.ready'))).toBe('Ready. Orbit adds the workspace “app” for /home/orbit/code/app.');

    await create();
    expect(made).toEqual([{ name: 'app', runnerId: AUSTIN, workDir: REGISTER }]);
    // Nothing was sent: the workspace is made alone, and its first session is the owner's next send.
    expect(createMock).not.toHaveBeenCalled();
    expect(mounted().querySelector('.session-col')).toBeTruthy();
    expect(composer().placeholder).toBe('Send this workspace a task…');
    // The setup is over: its folder is not kept for the machine's page.
    expect(sessionStorage.getItem(`orbit.machineSetup.${AUSTIN}`)).toBeNull();
  });

  it('a new folder by its name', async () => {
    runners = [{ ...signedIn(), registerDir: '/home/orbit' }];
    // Home is where it was registered; nothing is in the Repos Folder yet.
    vi.mocked(readDirProbe).mockImplementation(async (_runner, path) => ({
      path,
      status: 'done',
      result: path.startsWith('/home/orbit/orbit-repos/')
        ? { ...FOUND, path, exists: false, isDir: false, isGit: false, branch: null }
        : { ...FOUND, path, isGit: false, branch: null, isHome: true },
    }));
    await open(`/runners/${AUSTIN}/new`);
    await waitForUi(() => expect(card()?.querySelector('.msc-input input')).toBeTruthy());
    const name = card()!.querySelector<HTMLInputElement>('.msc-input input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'payments-api');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Asked about where it would go before it can be used.
    await waitForUi(() => expect(button('Use this folder')!.disabled).toBe(false));
    expect(askDirProbe).toHaveBeenCalledWith(AUSTIN, '/home/orbit/orbit-repos/payments-api');
    await useFolder();
    await create();
    expect(made).toEqual([{ name: 'payments-api', runnerId: AUSTIN, newFolder: 'payments-api' }]);
  });

  it('a refusal stays on the card, saying why', async () => {
    refuseMake = new ApiError('This runner is too old to make a new folder', 409, 'NEW_FOLDER_UNSUPPORTED');
    runners = [signedIn()];
    await openMachine();
    await useFolder();
    await act(async () => createButton().click());
    await waitForUi(() =>
      expect(said(card()!.querySelector('.msc-create-error'))).toBe(
        'Couldn’t create the workspace: This runner is too old to make a new folder',
      ),
    );
    expect(where).toBe(`/runners/${AUSTIN}/new`);
    expect(createButton().disabled).toBe(false);
  });

  it('the folder picked outlives the page, and is this machine’s alone', async () => {
    runners = [austin(), austin({ id: HPC, name: 'orbit@hpc' })];
    await openMachine();
    await useFolder();
    await closePage();
    await open(`/runners/${AUSTIN}/new`);
    await waitForUi(() => expect(card()).toBeTruthy());
    expect(said(card()!.querySelector('[data-step="folder"]'))).toBe('Folder /home/orbit/code/app git repository · main Change');
    await closePage();
    await openMachine(HPC);
    expect(card()!.querySelector('[data-step="folder"] .msc-done-line')).toBeNull();
  });

  it('the engine the card was moved to is the one the first session runs on', async () => {
    await openMachine();
    await act(async () => button('Use Codex instead')!.click());
    await settle();
    expect(said(card()!.querySelector('[data-step="engine"] .msc-step-title'))).toBe('Sign in Codex on orbit@austin');
    await useFolder();
    await machineReports(austin({ engines: [health('claude', 'no'), health('codex', 'yes')] }));
    await create();
    await send('Fix it');
    expect(createMock.mock.calls[0][0]).toMatchObject({ workspaceId: MADE_WORKSPACE, engine: 'codex', provider: 'codex' });
  });
});

describe('rule 5: Use an API key', () => {
  const key = {
    slug: 'anthropic-key',
    label: 'Anthropic',
    runtime: 'claude',
    presetSlug: 'anthropic',
    engines: ['claude'],
    models: [{ value: 'claude-opus-5', label: 'Claude Opus 5' }],
    defaultModel: 'claude-opus-5',
  };

  it('with a key the machine can run: that key answers the step, and the session is on it', async () => {
    providers = [key];
    await openMachine();
    await waitForUi(() => expect(button('Use an API key instead')).toBeTruthy());
    await act(async () => button('Use an API key instead')!.click());
    await settle();
    expect(said(card()!.querySelector('[data-step="engine"]'))).toBe('Anthropic API key Change');

    await useFolder();
    await create();
    await send('Fix it');
    expect(createMock.mock.calls[0][0]).toMatchObject({ engine: 'claude', provider: 'anthropic-key' });
  });

  it('Change goes back to signing in', async () => {
    providers = [key];
    await openMachine();
    await waitForUi(() => expect(button('Use an API key instead')).toBeTruthy());
    await act(async () => button('Use an API key instead')!.click());
    await settle();
    await act(async () => card()!.querySelector<HTMLButtonElement>('[data-step="engine"] .msc-change')!.click());
    await settle();
    expect(said(card()!.querySelector('[data-step="engine"] .msc-step-title'))).toBe('Sign in Claude Code on orbit@austin');
  });

  it('with none yet: to where one is connected, and what was answered is kept for the way back', async () => {
    await openMachine();
    await useFolder();
    await act(async () => button('Use an API key instead')!.click());
    await settle();
    expect(where).toBe('/settings/providers');
  });
});

describe('rule 8: the line that opens the conversation', () => {
  const made = { createdWorkspace: true };
  const line = () => mounted().querySelector<HTMLElement>('.msc-created');

  it('says what was made, on which machine, where, and the two ways to change it', async () => {
    detail = made;
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(line()).toBeTruthy());
    expect(said(line())).toBe('Created workspace app on orbit@austin · /home/orbit/code/app · Rename · Settings');
    expect(line()!.querySelector('b')?.textContent).toBe('app');
    expect(line()!.querySelector('code')?.textContent).toBe(REGISTER);
  });

  it('stands above the first message', async () => {
    detail = made;
    events = [{ seq: 1, type: 'user', payload: { text: 'Fix it' }, turnId: 't1', ts: '2026-10-31T00:00:00Z' }];
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(mounted().querySelector('.chat-user')).toBeTruthy());
    await waitForUi(() => expect(line()).toBeTruthy());
    const follows = line()!.compareDocumentPosition(mounted().querySelector('.chat-user')!);
    expect(follows & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not on any other conversation', async () => {
    detail = { createdWorkspace: false };
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(composer()).toBeTruthy());
    await settle();
    expect(line()).toBeNull();
  });

  it('is first: not above a window of the transcript that starts later', async () => {
    detail = made;
    eventsHaveMore = true;
    events = [{ seq: 90, type: 'user', payload: { text: 'Much later' }, turnId: 't9', ts: '2026-10-31T00:00:00Z' }];
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(mounted().querySelector('.chat-user')).toBeTruthy());
    await settle();
    expect(line()).toBeNull();
  });

  it('Rename renames the workspace, here', async () => {
    detail = made;
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(line()).toBeTruthy());
    await act(async () => button('Rename')!.click());
    const field = line()!.querySelector<HTMLInputElement>('input')!;
    expect(field.value).toBe('app');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'payments');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await waitForUi(() => expect(patched).toEqual([{ path: `/workspaces/${MADE_WORKSPACE}`, body: { name: 'payments' } }]));
    await waitForUi(() => expect(line()!.querySelector('b')?.textContent).toBe('payments'));
  });

  it('Escape keeps the name, and an unchanged one writes nothing', async () => {
    detail = made;
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(line()).toBeTruthy());
    await act(async () => button('Rename')!.click());
    await act(async () => {
      line()!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(line()!.querySelector('input')).toBeNull();
    await act(async () => button('Rename')!.click());
    await act(async () => {
      line()!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
    expect(patched).toEqual([]);
  });

  it('Settings opens the workspace’s Settings page', async () => {
    detail = made;
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(line()).toBeTruthy());
    await act(async () => button('Settings')!.click());
    await waitForUi(() => expect(where).toBe(`/settings/workspaces/${encodeId(MADE_WORKSPACE)}`));
  });

  it('a workspace deleted since is still what was made, with nothing left to change', async () => {
    detail = { ...made, workspace: { id: MADE_WORKSPACE, name: 'app', workDir: REGISTER, deletedAt: '2026-10-31T00:00:00Z' } };
    await open(`/sessions/${SESSION}`);
    await waitForUi(() => expect(line()).toBeTruthy());
    expect(said(line())).toBe('Created workspace app on orbit@austin · /home/orbit/code/app');
    expect(button('Rename')).toBeUndefined();
  });
});

/**
 * A new account's first machine (docs/mocks/new-user-onboarding): the setup card greets it, and offers
 * first messages that fill the composer. Only while the account has never had a session.
 */
describe('a new account', () => {
  it('is greeted by the setup card, with no composer for first messages to fill', async () => {
    history = [];
    await open(`/runners/${AUSTIN}/new`);
    await waitForUi(() => expect(said(card()?.querySelector('.msc-title'))).toBe('Welcome to Orbit, Reader'));
    expect(card()!.querySelector('[data-step="folder"]')).toBeTruthy();
    expect(card()!.querySelector('[data-step="engine"]')).toBeTruthy();
    expect(card()!.querySelector('.welcome-example')).toBeNull();
    expect(mounted().querySelector('.workspace-composer')).toBeNull();
  });

  it('an account that has had a session gets the setup card as before', async () => {
    await openMachine();
    expect(said(card()!.querySelector('.msc-title'))).toBe('Set up orbit@austin');
    expect(card()!.querySelector('.welcome-example')).toBeNull();
  });
});
