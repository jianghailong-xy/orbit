// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import { ToastViewport } from './ToastViewport';
import { clearToasts } from '../lib/toastStore';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // The readers below close over the module-local client, so replacing the exported `api` alone
  // would leave the real `getSession` fetching nothing in jsdom (WorkspaceView.commitResultMessage
  // documents the same trap).
  return {
    ...actual,
    api: vi.fn(),
    getSession: vi.fn(),
    getSessionEventPage: vi.fn(),
    listApprovals: vi.fn(),
    // The two writes this test is about: PATCH /workspaces/:id, from Initialize git… and from ✕.
    enableWorkspaceIsolation: vi.fn(),
    setWorkspaceWorktree: vi.fn(),
  };
});

const { api, getSession, getSessionEventPage, listApprovals, enableWorkspaceIsolation, setWorkspaceWorktree } =
  await import('../api');
const apiMock = vi.mocked(api);
const { encodeId } = await import('../lib/idCodec');
const { WorkspaceView } = await import('./WorkspaceView');

/**
 * The shared-folder notice end to end: the real WorkspaceView is mounted on a session the runner
 * could not give a worktree, its buttons are pressed, and what reaches the server — and what the
 * reader then sees — is checked. ✕ keeps the folder as it is by turning the workspace's isolation
 * off, with an Undo; Initialize git… says what it will do before it turns git setup on.
 */

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000021';
const SESSION_ID = '0195c0de-0000-7000-8000-000000000091';
const WORKSPACE_ID = '0195c0de-0000-7000-8000-000000000092';
const SESSION_PUBLIC = encodeId(SESSION_ID);
const WORKSPACE_PUBLIC = encodeId(WORKSPACE_ID);
const FOLDER = '/Users/alex/notes';
const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** The workspace row as the stubbed server holds it; PATCHes write into it. */
let workspace: Record<string, unknown> = {};
let patches: unknown[] = [];
let failPatch: string | null = null;

const sessionRow = () => ({
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  projectId: null,
  title: 'weekly summary from meeting notes',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  sessionState: 'AWAITING_INPUT',
  engineTurnActive: false,
  provider: 'claude',
  createdAt: '2026-10-27T03:00:00Z',
  updatedAt: '2026-10-27T03:10:00Z',
});

/** The runner reports what it did with this session's branch: it ran it in the folder itself. */
const sessionDetail = () => ({
  ...sessionRow(),
  workspace: { id: WORKSPACE_PUBLIC, provider: 'claude' },
  isolationStatus: 'shared-nogit',
  branch: 'orbit/weekly-summary-3f9a1c',
  changedFiles: null,
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  // Waited out with the act environment off, then closed with one act — see
  // WorkspaceView.commitResultMessage.test.tsx for why both halves are needed.
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await act(async () => {});
};

const notice = () => mounted().querySelector<HTMLElement>('.wt-bar-nogit');
const pressIn = async (scope: ParentNode, name: string) => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === name || b.getAttribute('aria-label') === name,
  );
  expect(button, `a button named ${name}`).toBeTruthy();
  await act(async () => button!.click());
};
const toastHead = () => document.body.querySelector('.toast-viewport .toast-head')?.textContent ?? null;
const toastDetail = () =>
  document.body.querySelector('.toast-viewport .toast-detail, .toast-viewport .toast-reason')?.textContent ?? null;
const dialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  workspace = {
    id: WORKSPACE_PUBLIC,
    name: 'notes',
    runnerId: RUNNER_ID,
    createdAt: '2026-01-01T00:00:00Z',
    lastProvider: 'claude',
    workDir: FOLDER,
    workDirExists: true,
    workDirIsGit: false,
    enableWorktree: true,
    autoInitGit: false,
  };
  patches = [];
  failPatch = null;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(getSession).mockReset();
  vi.mocked(getSession).mockImplementation(async () => sessionDetail() as never);
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({ events: [], hasMore: false }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  // What PATCH /workspaces/:id does on the stubbed server: record the body, then apply it or refuse.
  const patch = async (id: string, body: Record<string, unknown>) => {
    expect(id).toBe(WORKSPACE_PUBLIC);
    patches.push(body);
    if (failPatch) throw new Error(failPatch);
    workspace = { ...workspace, ...body };
    return workspace as never;
  };
  vi.mocked(enableWorkspaceIsolation).mockReset();
  vi.mocked(enableWorkspaceIsolation).mockImplementation((id: string) => patch(id, { autoInitGit: true }));
  vi.mocked(setWorkspaceWorktree).mockReset();
  vi.mocked(setWorkspaceWorktree).mockImplementation((id: string, on: boolean) => patch(id, { enableWorktree: on }));
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') return reply([workspace]);
    if (path.startsWith('/sessions/')) {
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ patches: [] });
      return reply([]);
    }
    if (path.startsWith('/sessions')) return reply([sessionRow()]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_ID, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const mountedNode = container;
  root = null;
  client = null;
  container = null;
  try {
    await act(async () => clearToasts());
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    try {
      if (mountedClient) {
        await mountedClient.cancelQueries();
        mountedClient.clear();
      }
    } finally {
      mountedNode?.remove();
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      vi.unstubAllGlobals();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  }
});

async function mountWorkspace(): Promise<void> {
  const nextClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
          <WorkspaceView runner={RUNNER} />
          <ToastViewport />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(notice()?.querySelector('.wt-warn')?.textContent).toBe(`⚠ ${FOLDER} isn’t a git repository`);
  });
}

describe('the shared-folder notice in a session', () => {
  it('✕ keeps the folder as it is: isolation goes off, the notice goes, and Undo brings both back', async () => {
    await mountWorkspace();

    await pressIn(notice()!, 'Keep it as a plain folder');
    await waitForUi(() => {
      expect(toastHead()).toBe('Worktree isolation is off for “notes”');
    });
    expect(patches).toEqual([{ enableWorktree: false }]);
    expect(toastDetail()).toBe(
      'Its sessions keep editing the folder directly, without this notice. Turn it back on in the workspace’s settings.',
    );
    await waitForUi(() => {
      expect(notice()).toBeNull();
    });

    await pressIn(document.body.querySelector('.toast-viewport')!, 'Turn worktree isolation back on');
    await waitForUi(() => {
      expect(patches).toEqual([{ enableWorktree: false }, { enableWorktree: true }]);
      expect(notice()).toBeTruthy();
    });
  });

  it('a ✕ the server refuses says so and leaves the notice where it was', async () => {
    failPatch = 'workspace is read-only right now';
    await mountWorkspace();

    await pressIn(notice()!, 'Keep it as a plain folder');
    await waitForUi(() => {
      expect(toastHead()).toBe("Couldn't turn off worktree isolation");
    });
    expect(toastDetail()).toBe('workspace is read-only right now');
    expect(notice()).toBeTruthy();
  });

  it('Initialize git… says what it will do, and only the confirmation turns git setup on', async () => {
    await mountWorkspace();

    await pressIn(notice()!, 'Initialize git…');
    await waitForUi(() => {
      expect(dialog()).toBeTruthy();
    });
    const text = dialog()!.textContent ?? '';
    expect(text).toContain('Initialize git in this folder?');
    expect(text).toContain(FOLDER);
    expect(text).toContain('When the next session starts in “notes”, Orbit will:');
    expect(text).toContain('run git init');
    expect(text).toContain('commit the existing files as “orbit: baseline”. Nothing is pushed anywhere.');
    expect(text).toContain('This session keeps editing the folder directly.');
    expect(patches).toEqual([]);

    await pressIn(dialog()!, 'Initialize git');
    await waitForUi(() => {
      expect(toastHead()).toBe('Git will be set up when the next session starts');
    });
    expect(patches).toEqual([{ autoInitGit: true }]);
    // A success pill carries its second line as the subtitle.
    expect(document.body.querySelector('.toast-viewport .toast-sub')?.textContent).toBe(FOLDER);
    await waitForUi(() => {
      expect(notice()).toBeNull();
    });
  });
});
