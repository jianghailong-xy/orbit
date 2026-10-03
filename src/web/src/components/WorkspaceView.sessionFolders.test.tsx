// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMoveTargets } from '@orbit/shared';
import type { Runner } from './TasksSidePanel';
import { ToastViewport } from './ToastViewport';
import { clearToasts } from '../lib/toastStore';

/**
 * Session folders and Move on the web (docs/session-folders-move-design.md §3–§5, §7), through the
 * real WorkspaceView: the folder rows over the list, a folder's page, New Folder… / Rename… /
 * Delete Folder…, the row's Move… into a folder, and End and Move to another workspace.
 */

// These call api() from inside api.ts, where mocking the export cannot reach them, so each one the
// page uses is stubbed by name.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    getSession: vi.fn(),
    createSessionFolder: vi.fn(),
    renameSessionFolder: vi.fn(),
    deleteSessionFolder: vi.fn(),
    moveSession: vi.fn(),
    getSessionMoveTargets: vi.fn(),
    endSession: vi.fn(),
    createInteractiveSession: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const apiModule = await import('../api');
const apiMock = vi.mocked(apiModule.api);
const { ApiError } = apiModule;
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const uuid = (n: number) => `0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
const pid = (n: number) => encodeId(uuid(n));

const RUNNER_ID = uuid(901);
const WORKSPACE_ID = pid(902);
const OTHER_WORKSPACE_ID = pid(903);
const HPC_WORKSPACE_ID = pid(904);
const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;
const WORKSPACE = { id: WORKSPACE_ID, name: 'orbit' };

const RELEASE = { id: pid(911), workspaceId: WORKSPACE_ID, name: 'Release' };
const WIKI = { id: pid(912), workspaceId: WORKSPACE_ID, name: 'Wiki' };
const ELSEWHERE = { id: pid(913), workspaceId: OTHER_WORKSPACE_ID, name: 'Elsewhere' };

const row = (n: number, title: string, extra: Record<string, unknown> = {}) => ({
  id: pid(n),
  workspaceId: WORKSPACE_ID,
  workspace: WORKSPACE,
  runnerId: RUNNER_ID,
  assignedRunnerId: RUNNER_ID,
  title,
  status: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  lifecycleState: 'OPEN',
  provider: 'claude',
  createdAt: '2026-10-01T09:00:00Z',
  folderId: null,
  ...extra,
});
const LOOSE = row(921, 'Loose one', { lastTurnAt: '2026-10-03T08:00:00Z' });
const NOTES = row(922, 'Release notes', { folderId: RELEASE.id, pendingApprovals: 1, lastTurnAt: '2026-10-03T07:00:00Z' });
const BUILD = row(923, 'Tag the build', {
  folderId: RELEASE.id,
  status: 'RUNNING',
  runState: 'RUNNING',
  lastTurnAt: '2026-10-03T06:00:00Z',
});
const CURSOR = row(924, 'Wiki cursor', { folderId: WIKI.id, lastTurnAt: '2026-10-02T06:00:00Z' });

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
let folders: Array<{ id: string; workspaceId: string; name: string }> = [];
let rows: Array<ReturnType<typeof row>> = [];
let listCalls: string[] = [];
let ended = false;
let location = '';

function LocationProbe() {
  const l = useLocation();
  location = `${l.pathname}${l.search}`;
  return null;
}

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const until = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  });
};

async function mount(path: string, ready: () => void): Promise<void> {
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[path]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
            <LocationProbe />
          </AntApp>
          <ToastViewport />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await until(ready);
  await settle();
}

const mountOnLoose = () =>
  mount(`/sessions/${LOOSE.id}`, () => expect(folderNames()).toEqual(['Release', 'Wiki']));

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

async function type(input: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(input: Element, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  await settle();
}

const folderRows = (): HTMLElement[] => [...mounted().querySelectorAll<HTMLElement>('.session-folder-row:not(.editing)')];
const folderNames = (): string[] => folderRows().map((r) => r.querySelector('.session-folder-name')?.textContent ?? '');
const folderRow = (name: string): HTMLElement => {
  const found = folderRows().find((r) => r.querySelector('.session-folder-name')?.textContent === name);
  if (!found) throw new Error(`no folder row ${name}`);
  return found;
};
const sessionTitles = (): string[] =>
  [...mounted().querySelectorAll('.session-row .session-title')].map((el) => el.textContent ?? '');
const listRow = (title: string): HTMLElement => {
  const found = [...mounted().querySelectorAll<HTMLElement>('.session-row')].find(
    (el) => el.querySelector('.session-title')?.textContent === title,
  );
  if (!found) throw new Error(`no list row titled ${title}`);
  return found;
};
const openMenu = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu');
const menuItem = (label: string): HTMLElement | undefined =>
  [...(openMenu()?.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item') ?? [])].find((el) =>
    (el.textContent ?? '').trim().startsWith(label),
  );
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('.move-dialog');
const option = (label: string): HTMLButtonElement | undefined =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>('.move-dialog-option') ?? [])].find((el) =>
    (el.querySelector('.move-dialog-name')?.textContent ?? '').startsWith(label),
  );

const TARGETS: SessionMoveTargets = {
  workspaceId: WORKSPACE_ID,
  folderId: null,
  folders: [
    { id: RELEASE.id, name: 'Release', sessionCount: 2 },
    { id: WIKI.id, name: 'Wiki', sessionCount: 1 },
  ],
  reason: null,
  needsEnd: true,
  branch: 'orbit/review-import-3fa21c',
  changedFiles: 3,
  unmergedFiles: 3,
  mergeTarget: 'main',
  targets: [
    {
      workspaceId: OTHER_WORKSPACE_ID,
      name: 'wikova-develop',
      provider: 'codex',
      runnerId: RUNNER_ID,
      runnerName: 'wikova',
      runnerOnline: true,
      workDir: '/srv/wikova-develop',
      reason: null,
      conversation: 'continues',
      folders: [{ id: pid(931), name: 'Bugs', sessionCount: 12 }],
    },
    {
      workspaceId: HPC_WORKSPACE_ID,
      name: 'HPC',
      provider: 'claude',
      runnerId: uuid(905),
      runnerName: 'HPC',
      runnerOnline: true,
      workDir: null,
      reason: 'Update HPC to move sessions here',
      conversation: 'rebuilt',
      folders: [],
    },
  ],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  folders = [RELEASE, WIKI, ELSEWHERE];
  rows = [LOOSE, NOTES, BUILD, CURSOR];
  listCalls = [];
  ended = false;
  location = '';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(apiModule.getSessionEventPage).mockReset();
  vi.mocked(apiModule.getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(apiModule.getSession).mockReset();
  vi.mocked(apiModule.getSession).mockImplementation(async (id: string) => {
    const found = rows.find((r) => r.id === id) ?? LOOSE;
    return (ended ? { ...found, runState: 'ENDED', status: 'ENDED' } : found) as never;
  });
  vi.mocked(apiModule.createSessionFolder).mockReset();
  vi.mocked(apiModule.createSessionFolder).mockImplementation(async ({ workspaceId, name }) => {
    const made = { id: pid(940 + folders.length), workspaceId, name };
    folders = [...folders, made];
    return made;
  });
  vi.mocked(apiModule.renameSessionFolder).mockReset();
  vi.mocked(apiModule.renameSessionFolder).mockImplementation(async (id, name) => {
    folders = folders.map((f) => (f.id === id ? { ...f, name } : f));
    return folders.find((f) => f.id === id)!;
  });
  vi.mocked(apiModule.deleteSessionFolder).mockReset();
  vi.mocked(apiModule.deleteSessionFolder).mockImplementation(async (id) => {
    folders = folders.filter((f) => f.id !== id);
    rows = rows.map((r) => (r.folderId === id ? { ...r, folderId: null } : r));
    return { ok: true };
  });
  vi.mocked(apiModule.moveSession).mockReset();
  vi.mocked(apiModule.moveSession).mockImplementation(async (id, body) => {
    rows = rows.map((r) => (r.id === id ? { ...r, folderId: body.folderId } : r));
    return { id, workspaceId: body.workspaceId ?? WORKSPACE_ID, folderId: body.folderId };
  });
  vi.mocked(apiModule.getSessionMoveTargets).mockReset();
  vi.mocked(apiModule.getSessionMoveTargets).mockResolvedValue(TARGETS);
  vi.mocked(apiModule.endSession).mockReset();
  vi.mocked(apiModule.endSession).mockImplementation(async () => {
    ended = true;
  });
  vi.mocked(apiModule.createInteractiveSession).mockReset();
  vi.mocked(apiModule.createInteractiveSession).mockResolvedValue({ id: pid(950) });
  apiMock.mockReset();
  apiMock.mockImplementation(((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_ID, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path === '/session-folders') return reply(folders.map((f) => ({ ...f })));
    if (path.startsWith('/sessions?')) {
      listCalls.push(path);
      return reply(path.includes('view=open') || !path.includes('view=') ? rows : []);
    }
    if (path.startsWith('/sessions/')) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply([]);
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof apiModule.api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)',
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const node = container;
  root = null;
  client = null;
  container = null;
  try {
    await act(async () => clearToasts());
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    if (mountedClient) {
      await mountedClient.cancelQueries();
      mountedClient.clear();
    }
    node?.remove();
    document.body.innerHTML = '';
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

describe('folders in the session list', { timeout: 60_000 }, () => {
  it('draws the workspace’s folders above the list, reporting for the sessions filed in them', async () => {
    await mountOnLoose();

    // Only this workspace's folders, by name; the sessions filed in them are left out of the list.
    expect(folderNames()).toEqual(['Release', 'Wiki']);
    expect(sessionTitles()).toEqual(['Loose one']);
    const release = folderRow('Release');
    expect(release.querySelector('.session-folder-count')?.textContent).toBe('2');
    expect(release.querySelector('.session-folder-needs')?.textContent).toBe('1');
    expect(release.querySelector('.session-folder-activity:not(.jobs)'), 'a running session lights the folder').not.toBeNull();
    const wiki = folderRow('Wiki');
    expect(wiki.querySelector('.session-folder-count')?.textContent).toBe('1');
    expect(wiki.querySelector('.session-folder-needs')).toBeNull();
    expect(wiki.querySelector('.session-folder-activity')).toBeNull();
    // A workspace with folders reads its whole list: a folder's count and page need every session.
    expect(listCalls.some((p) => !p.includes('limit='))).toBe(true);
  });

  it('pages the list as before in a workspace without folders', async () => {
    folders = [ELSEWHERE];
    await mount(`/sessions/${LOOSE.id}`, () => expect(sessionTitles()).toHaveLength(4));
    expect(folderRows()).toHaveLength(0);
    expect(listCalls.every((p) => p.includes('limit=40'))).toBe(true);
  });

  it('opens a folder’s page in place, and its back button returns to the list', async () => {
    await mountOnLoose();

    await click(folderRow('Release'), 'the Release folder row');
    await until(() => expect(mounted().querySelector('.session-folder-title')?.textContent).toBe('Release'));
    expect(mounted().querySelector('.session-folder-workspace')?.textContent).toBe('orbit');
    expect(sessionTitles()).toEqual(['Release notes', 'Tag the build']);
    expect(folderRows()).toHaveLength(0);
    // The conversation on the right stays; the page rides along in the address.
    expect(location).toBe(`/sessions/${LOOSE.id}?folder=${RELEASE.id}`);

    await click(mounted().querySelector('.session-folder-back'), 'the back button');
    await until(() => expect(folderNames()).toEqual(['Release', 'Wiki']));
    expect(location).toBe(`/sessions/${LOOSE.id}`);
    expect(sessionTitles()).toEqual(['Loose one']);
  });

  it('opens a session from a folder’s page without leaving the page', async () => {
    await mountOnLoose();
    await click(folderRow('Wiki'), 'the Wiki folder row');
    await until(() => expect(sessionTitles()).toEqual(['Wiki cursor']));

    await click(listRow('Wiki cursor'), 'the Wiki cursor row');
    await until(() => expect(location).toBe(`/sessions/${CURSOR.id}?folder=${WIKI.id}`));
    expect(mounted().querySelector('.session-folder-title')?.textContent).toBe('Wiki');
  });

  it('starts a session composed on a folder’s page in that folder', async () => {
    await mount(`/workspaces/${WORKSPACE_ID}/new?folder=${RELEASE.id}`, () =>
      expect(mounted().querySelector('.session-folder-title')?.textContent).toBe('Release'),
    );
    const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
    await type(box, 'Draft the release notes');
    await click(mounted().querySelector('button[aria-label="Send"]'), 'Send');
    await until(() => expect(apiModule.createInteractiveSession).toHaveBeenCalled());
    expect(vi.mocked(apiModule.createInteractiveSession).mock.calls[0][0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      folderId: RELEASE.id,
    });
  });
});

describe('managing folders', { timeout: 60_000 }, () => {
  it('names a new folder in place from New Folder… in the list’s menu', async () => {
    await mountOnLoose();

    await click(mounted().querySelector('.session-scope-menu'), 'the Open ▾ menu');
    await until(() => expect(menuItem('New Folder…')).toBeTruthy());
    await click(menuItem('New Folder…'), 'New Folder…');
    const field = mounted().querySelector<HTMLInputElement>('.session-folder-row.editing input')!;
    expect(field, 'the name field is open').toBeTruthy();
    await type(field, '  Design review ');
    await press(field, 'Enter');

    expect(apiModule.createSessionFolder).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, name: 'Design review' });
    await until(() => expect(folderNames()).toEqual(['Design review', 'Release', 'Wiki']));
    expect(mounted().querySelector('.session-folder-row.editing')).toBeNull();
  });

  it('says a name the workspace already has under the field, and Esc closes it', async () => {
    vi.mocked(apiModule.createSessionFolder).mockRejectedValue(
      new ApiError('a folder with that name already exists in this workspace', 409),
    );
    await mountOnLoose();
    await click(mounted().querySelector('.session-scope-menu'), 'the Open ▾ menu');
    await until(() => expect(menuItem('New Folder…')).toBeTruthy());
    await click(menuItem('New Folder…'), 'New Folder…');
    const field = mounted().querySelector<HTMLInputElement>('.session-folder-row.editing input')!;
    await type(field, 'Release');
    await press(field, 'Enter');

    await until(() =>
      expect(mounted().querySelector('.session-folder-row.editing .session-folder-error')?.textContent).toBe(
        'There’s already a folder named “Release” in orbit. Choose another name.',
      ),
    );
    await press(field, 'Escape');
    expect(mounted().querySelector('.session-folder-row.editing')).toBeNull();
    expect(apiModule.createSessionFolder).toHaveBeenCalledTimes(1);
  });

  it('renames a folder from its row’s ⋯', async () => {
    await mountOnLoose();
    await click(folderRow('Release').querySelector('.session-folder-more'), 'the Release ⋯');
    await until(() => expect(menuItem('Rename…')).toBeTruthy());
    await click(menuItem('Rename…'), 'Rename…');

    const field = mounted().querySelector<HTMLInputElement>('.session-folder-row.editing input')!;
    expect(field.value).toBe('Release');
    await type(field, 'Release 1.0');
    await press(field, 'Enter');

    expect(apiModule.renameSessionFolder).toHaveBeenCalledWith(RELEASE.id, 'Release 1.0');
    expect(apiModule.renameSessionFolder).toHaveBeenCalledTimes(1);
    await until(() => expect(folderNames()).toEqual(['Release 1.0', 'Wiki']));
  });

  it('deletes only the folder after asking, in the iOS words', async () => {
    await mountOnLoose();
    await click(folderRow('Release').querySelector('.session-folder-more'), 'the Release ⋯');
    await until(() => expect(menuItem('Delete Folder…')).toBeTruthy());
    await click(menuItem('Delete Folder…'), 'Delete Folder…');

    await until(() => expect(document.querySelector('.ant-modal-confirm')).not.toBeNull());
    const confirm = document.querySelector<HTMLElement>('.ant-modal-confirm')!;
    expect(confirm.querySelector('.ant-modal-confirm-title')?.textContent).toBe('Delete “Release”?');
    expect(confirm.querySelector('.ant-modal-confirm-content')?.textContent).toBe(
      'Its sessions move back to the list. No session is deleted.',
    );
    await click(confirm.querySelector('.ant-modal-confirm-btns .ant-btn-dangerous'), 'Delete');

    expect(apiModule.deleteSessionFolder).toHaveBeenCalledWith(RELEASE.id);
    await until(() => expect(folderNames()).toEqual(['Wiki']));
    expect(sessionTitles()).toEqual(expect.arrayContaining(['Loose one', 'Release notes', 'Tag the build']));
  });
});

describe('Move', { timeout: 60_000 }, () => {
  it('files a row in a folder at once from its More actions menu', async () => {
    await mountOnLoose();
    await click(listRow('Loose one').querySelector('button[aria-label="More actions"]'), 'the row’s More actions');
    await until(() => expect(menuItem('Move…')).toBeTruthy());
    await click(menuItem('Move…'), 'the row’s Move…');
    await until(() => expect(option('Wiki')).toBeTruthy());

    expect(dialog()!.querySelector('.move-dialog-sub')?.textContent).toBe('Loose one');
    expect(dialog()!.querySelector('.move-dialog-group')?.textContent).toBe('Folder in orbit');
    expect(option('No Folder')!.getAttribute('aria-pressed')).toBe('true');
    await until(() => expect(option('Release')!.querySelector('.move-dialog-count')?.textContent).toBe('2'));

    await click(option('Wiki'), 'the Wiki folder');
    expect(apiModule.moveSession).toHaveBeenCalledWith(LOOSE.id, { folderId: WIKI.id });
    await until(() => expect(document.body.textContent).toContain('Moved to “Wiki”'));
    await until(() => expect(folderRow('Wiki').querySelector('.session-folder-count')?.textContent).toBe('2'));
  });

  it('moves the open session to another workspace with End and Move, after saying what stays behind', async () => {
    await mountOnLoose();
    await click(mounted().querySelector('.workspace-header button[title="More actions"]'), 'the header ⋯');
    await until(() => expect(menuItem('Move…')).toBeTruthy());
    await click(menuItem('Move…'), 'Move…');
    await until(() => expect(option('wikova-develop')).toBeTruthy());

    // The server's answer, as it is: an open row, and a greyed one with its reason.
    expect(option('wikova-develop')!.querySelector('small')?.textContent).toBe('Codex · wikova');
    expect(option('HPC')!.disabled).toBe(true);
    expect(option('HPC')!.querySelector('small')?.textContent).toBe('Update HPC to move sessions here');

    await click(option('wikova-develop'), 'wikova-develop');
    expect(dialog()!.querySelector('.move-dialog-group')?.textContent).toBe('Folder in wikova-develop');
    expect(dialog()!.querySelector('.move-dialog-foot')?.textContent).toBe(
      'Same runner (wikova). The conversation carries over as it is. The agent works in /srv/wikova-develop from your next message.',
    );
    await click(option('Bugs'), 'the Bugs folder');

    await until(() => expect(document.querySelector('.ant-modal-confirm')).not.toBeNull());
    const confirm = document.querySelector<HTMLElement>('.ant-modal-confirm')!;
    expect(confirm.querySelector('.ant-modal-confirm-title')?.textContent).toBe('Move to wikova-develop?');
    expect([...confirm.querySelectorAll('.move-confirm-body p')].map((p) => p.textContent)).toEqual([
      'The conversation moves with it. Your next message continues it in wikova-develop.',
      '3 changed files aren’t merged into main yet. They stay on branch orbit/review-import-3fa21c in orbit.',
      'The session ends first.',
    ]);
    const ok = confirm.querySelector<HTMLElement>('.ant-modal-confirm-btns .ant-btn-primary')!;
    expect(ok.textContent).toBe('End and Move');
    await click(ok, 'End and Move');

    await until(() => expect(apiModule.moveSession).toHaveBeenCalled());
    expect(apiModule.endSession).toHaveBeenCalledWith(LOOSE.id);
    expect(apiModule.moveSession).toHaveBeenCalledWith(LOOSE.id, {
      folderId: pid(931),
      workspaceId: OTHER_WORKSPACE_ID,
    });
    expect(vi.mocked(apiModule.endSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(apiModule.moveSession).mock.invocationCallOrder[0],
    );
    await until(() => expect(document.body.textContent).toContain('Moved to wikova-develop'));
  });
});
