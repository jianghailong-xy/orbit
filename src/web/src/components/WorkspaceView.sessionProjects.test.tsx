// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import { SessionSearch } from './SessionSearch';

// Exercise the real list, its view/tag menu and the shell's search palette. Named API reads call
// api() within api.ts, so stub them separately from the query factories' api export.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), getSession: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const apiModule = await import('../api');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const uuid = (n: number) => `0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`;
const pid = (n: number) => encodeId(uuid(n));
const RUNNER_ID = uuid(801);
const WORKSPACE_ID = pid(802);
const PROJECT_ID = pid(803);
const OTHER_WORKSPACE_ID = pid(807);
const WORKSPACE = { id: WORKSPACE_ID, name: 'orbit' };
const TAG = { id: pid(804), name: 'Release', color: '#3b82f6' };
const FOLDER = { id: pid(805), workspaceId: WORKSPACE_ID, name: 'Project work' };
const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 0,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const membership = (role: string) => ({
  projectId: PROJECT_ID,
  projectTitle: 'Project Alpha',
  projectStatus: 'OPEN',
  role,
});
interface FixtureSession {
  id: string;
  title: string;
  lifecycleState: string;
  createdAt: string;
  lastTurnAt: string;
  folderId: string | null;
  projectMembership?: ReturnType<typeof membership>;
  [key: string]: unknown;
}
const row = (n: number, title: string, extra: Record<string, unknown> = {}): FixtureSession => ({
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
  lastTurnAt: '2026-10-03T08:00:00Z',
  folderId: null,
  ...extra,
});
const LOOSE = row(811, 'Loose conversation', { lastAssistantText: 'A regular session preview' });
const COORDINATOR = row(812, 'Plan the release', {
  projectMembership: membership('COORDINATOR'),
  projectId: PROJECT_ID,
  projectTitle: 'Project Alpha',
  lastAssistantText: 'The release plan is ready',
  tags: [TAG],
});
const TASK = row(813, 'Build the package', {
  projectMembership: membership('TASK'),
  status: 'RUNNING',
  runState: 'RUNNING',
  lastToolUse: 'Bash',
  lastTurnAt: '2026-10-04T08:00:00Z',
  tags: [TAG],
});
const project = (extra: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  title: 'Project Alpha',
  status: 'OPEN',
  createdAt: '2026-10-01T09:00:00Z',
  lastActivityAt: '2026-10-04T08:00:00Z',
  buckets: { running: 1 },
  taskCounts: { done: 2, failed: 1, total: 5 },
  attention: { ownerItems: [], startRequest: null, coordinatorItems: null },
  coordinatorActivity: { working: false, lastTurnAt: COORDINATOR.lastTurnAt },
  ...extra,
});

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

let root: Root | null = null;
let client: QueryClient | null = null;
let container: HTMLDivElement | null = null;
let rows: Array<ReturnType<typeof row>> = [];
let remoteRows: Array<ReturnType<typeof row>> = [];
let projects: Array<ReturnType<typeof project>> = [];
let folders: Array<typeof FOLDER> = [];
let listCalls: string[] = [];
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
const projectRows = (): HTMLElement[] => [...mounted().querySelectorAll<HTMLElement>('.session-project-row')];
const titles = (): string[] => [...mounted().querySelectorAll('.session-row .session-title')].map((el) => el.textContent ?? '');
const projectRow = (): HTMLElement => {
  const found = projectRows()[0];
  if (!found) throw new Error('no project row');
  return found;
};
const preview = (): HTMLElement | null => projectRow().querySelector('.session-preview');
const until = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 20_000, interval: 20 });
  });
};
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function mount(ready: () => void = () => expect(projectRows()).toHaveLength(1)): Promise<void> {
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  root = nextRoot;
  client = nextClient;
  container = nextContainer;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[`/sessions/${LOOSE.id}`]}>
          <WorkspaceView runner={RUNNER} />
          <SessionSearch />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await until(ready);
  await settle();
}
async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => element!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await settle();
}
/** The menus' plain items, open or on their way out (a row that opens a submenu is not one). Submenus use their
 *  own portal, outside their parent menu's element. */
const menuItem = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]:not([aria-haspopup])')].find(
    (el) => el.textContent?.trim().startsWith(label),
  );
/** A row that opens a submenu. */
const submenuRows = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"][aria-haspopup]')];
async function chooseView(label: string): Promise<void> {
  await click(mounted().querySelector('.session-scope-menu'), 'the view menu');
  await until(() => expect(menuItem(label)).toBeTruthy());
  await click(menuItem(label), label);
  if (['Open', 'Completed', 'Trash'].includes(label)) {
    await until(() => expect(mounted().querySelector('.session-scope-menu')?.textContent).toBe(label));
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rows = [LOOSE, COORDINATOR, TASK];
  remoteRows = [];
  projects = [project()];
  folders = [];
  listCalls = [];
  location = '';
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(apiModule.getSessionEventPage).mockReset();
  vi.mocked(apiModule.getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(apiModule.getSession).mockReset();
  vi.mocked(apiModule.getSession).mockImplementation(async (id) => (rows.find((r) => r.id === id) ?? LOOSE) as never);
  vi.mocked(apiModule.api).mockReset();
  vi.mocked(apiModule.api).mockImplementation(((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', preferences: {} });
    if (path === '/workspaces') return reply([{ ...WORKSPACE, runnerId: RUNNER_ID, lastProvider: 'claude', createdAt: '2026-01-01T00:00:00Z' }]);
    if (path === '/session-folders') return reply(folders);
    if (path === '/session-tags') return reply([TAG]);
    if (path === '/projects/sidebar') return reply(projects);
    if (path.startsWith('/sessions/search?')) return reply({
      q: '', contentSearched: false, total: rows.length,
      hits: rows.map((r) => ({ ...r, matchField: 'title', snippet: null })),
    });
    if (path.startsWith('/sessions?')) {
      listCalls.push(path);
      const params = new URLSearchParams(path.split('?')[1]);
      const lifecycle = params.get('view') === 'completed' ? 'COMPLETED' : params.get('view') === 'trash' ? 'TRASH' : 'OPEN';
      const inScope = params.has('workspaceId') ? rows : [...rows, ...remoteRows];
      return reply(inScope.filter((r) => r.lifecycleState === lifecycle &&
        (!params.has('projectId') || r.projectMembership?.projectId === params.get('projectId'))));
    }
    if (path.startsWith('/sessions/')) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply([]);
    }
    if (path.startsWith('/tasks/evidence-decisions/pending')) return reply({ decidingSessionId: null, count: 0, pending: [], waitingOnYou: [] });
    if (path.endsWith('/acceptance/criteria-decisions/pending')) return reply({
      projectId: PROJECT_ID, readAt: new Date().toISOString(), count: 0,
      oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [],
    });
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof apiModule.api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(hover: hover)', media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
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

describe('project entry typography', () => {
  const fromRepo = (...candidates: string[]): string => {
    const found = candidates.map((each) => resolve(process.cwd(), each)).find(existsSync);
    if (!found) throw new Error(`none of ${candidates.join(', ')} exists from ${process.cwd()}`);
    return readFileSync(found, 'utf8');
  };

  it('uses the same title weight as ordinary session rows (owner 10-04)', () => {
    const css = fromRepo('src/index.css', 'src/web/src/index.css').replace(/\/\*[\s\S]*?\*\//gu, '');
    const overrides = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].filter(([, selector, body]) =>
      /\.session-project-row\s+\.session-title\b/u.test(selector) && /\bfont-weight\s*:/u.test(body));
    expect(overrides, '项目条目标题与会话行同一字重（owner 10-04）').toHaveLength(0);
  });
});

describe('project entries in the session list', { timeout: 60_000 }, () => {
  it('merges Open members into one two-line session row with a project icon and progress', async () => {
    await mount();
    expect(titles()).toEqual(expect.arrayContaining(['Project Alpha', 'Loose conversation']));
    expect(titles()).toHaveLength(2);
    const entry = projectRow();
    const ordinary = mounted().querySelector<HTMLElement>('.session-row:not(.session-project-row)')!;
    for (const rendered of [entry, ordinary]) {
      expect(rendered.classList.contains('session-row')).toBe(true);
      expect(rendered.querySelectorAll('.session-main > .session-title-row')).toHaveLength(1);
      expect(rendered.querySelectorAll('.session-main > .session-sub')).toHaveLength(1);
    }
    expect(entry.querySelector('.session-project-icon svg')).not.toBeNull();
    const progress = entry.querySelector('.session-project-progress');
    expect(progress?.textContent).toContain('2/5');
    expect(progress?.getAttribute('title')).toBe('2 sessions · 1 running');
    expect(entry.querySelector('.session-sub')?.firstElementChild).toBe(progress);
    expect(entry.querySelector('.coordinator-badge')).toBeNull();
    expect(entry.querySelector('.session-folder-needs')).toBeNull();
    expect(entry.querySelector('button[aria-label="Project actions"]')).not.toBeNull();
    const actions = [...entry.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent);
    for (const answer of ['Confirm done', 'Chat about this', 'Approve', 'Reject', 'Start project']) {
      expect(actions).not.toContain(answer);
    }
    // Grouping reads the complete list even in a workspace with no manual folders.
    expect(listCalls.some((p) => p.includes(`workspaceId=${WORKSPACE_ID}`) && !p.includes('limit='))).toBe(true);
  });

  it('merges Completed members and uses the Open coordinator without showing its session row', async () => {
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    await mount();
    await chooseView('Completed');
    await until(() => expect(titles()).toEqual(['Project Alpha']));
    expect(projectRows()).toHaveLength(1);
    expect(preview()?.textContent).toBe('The release plan is ready');
    expect(projectRow().querySelector('.session-project-status')).toBeNull();
  });

  it('reads a Completed coordinator in another workspace for a local Completed project entry', async () => {
    rows = [LOOSE, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    remoteRows = [{
      ...COORDINATOR,
      workspaceId: OTHER_WORKSPACE_ID,
      workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' },
      lifecycleState: 'COMPLETED', status: 'ENDED', runState: 'ENDED',
      lastAssistantText: 'Completed coordinator summary',
    }];
    await mount(() => expect(titles()).toEqual(['Loose conversation']));
    await chooseView('Completed');
    await until(() => expect(preview()?.textContent).toBe('Completed coordinator summary'));
    expect(titles()).toEqual(['Project Alpha']);
    expect(projectRow().querySelector('.session-project-status')).toBeNull();
    expect(listCalls.some((p) => p.includes('view=completed') && p.includes(`projectId=${PROJECT_ID}`))).toBe(true);
    expect(listCalls.some((p) => p.includes('view=completed') && !p.includes('workspaceId=') && !p.includes('projectId='))).toBe(false);
  });

  it('keeps legacy server sessions flat when projectMembership is absent', async () => {
    rows = rows.map(({ projectMembership: _membership, ...s }) => s);
    await mount(() => expect(titles()).toHaveLength(3));
    expect(projectRows()).toHaveLength(0);
    expect(titles()).toEqual(expect.arrayContaining(['Plan the release', 'Build the package', 'Loose conversation']));
  });

  it('shows project status alone when the sidebar has no summary for the project', async () => {
    projects = [];
    rows = rows.map((s) => s.projectMembership ? { ...s, projectMembership: { ...s.projectMembership, projectStatus: 'DONE' } } : s);
    await mount();
    expect(projectRow().querySelector('.session-project-progress')?.textContent).toBe('DONE');
    expect(projectRow().querySelector('.session-project-progress-bar')).toBeNull();
  });

  it('opens the project sessions page when the project entry is clicked', async () => {
    await mount();
    await click(projectRow(), 'the project entry');
    await until(() => expect(mounted().querySelector('.session-project-page')).not.toBeNull());
    expect(new URLSearchParams(location.split('?')[1]).get('project')).toBeTruthy();
  });

  it('files all project members under the coordinator folder, including members filed elsewhere', async () => {
    const elsewhere = { ...FOLDER, id: pid(806), name: 'Other work' };
    folders = [FOLDER, elsewhere];
    rows = [LOOSE, { ...COORDINATOR, folderId: FOLDER.id }, { ...TASK, folderId: elsewhere.id }];
    await mount(() => expect(mounted().querySelectorAll('.session-folder-row')).toHaveLength(2));
    expect(mounted().querySelector('.session-search')).not.toBeNull();
    expect(projectRows()).toHaveLength(0);
    const folder = [...mounted().querySelectorAll<HTMLElement>('.session-folder-row')].find((el) => el.textContent?.includes(FOLDER.name))!;
    expect(folder.querySelector('.session-folder-count')?.textContent).toBe('2');
    await click(folder, 'the coordinator folder');
    await until(() => expect(titles()).toEqual(['Project Alpha']));
    expect(projectRows()).toHaveLength(1);
    expect(mounted().querySelector('.session-search')).not.toBeNull();
  });

  it('keeps Trash sessions flat', async () => {
    rows = [LOOSE, { ...COORDINATOR, lifecycleState: 'TRASH' }, { ...TASK, lifecycleState: 'TRASH' }];
    await mount(() => expect(titles()).toEqual(['Loose conversation']));
    await chooseView('Trash');
    await until(() => expect(titles()).toHaveLength(2));
    expect(projectRows()).toHaveLength(0);
    expect(titles()).toEqual(expect.arrayContaining(['Plan the release', 'Build the package']));
  });

  it('keeps Group by Tag sessions flat', async () => {
    await mount();
    await chooseView('Group by Tag');
    await until(() => expect(titles()).toHaveLength(3));
    expect(projectRows()).toHaveLength(0);
    expect(titles()).toContain('Build the package');
  });

  it('keeps Filter by Tag sessions flat', async () => {
    await mount();
    await click(mounted().querySelector('.session-scope-menu'), 'the view menu');
    await until(() => expect(submenuRows()).not.toHaveLength(0));
    const filter = submenuRows().find((el) => el.textContent?.startsWith('Filter by Tag'));
    expect(filter, 'Filter by Tag is on screen').toBeTruthy();
    await act(async () => {
      filter!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    await until(() => expect(menuItem('Release')).toBeTruthy());
    await click(menuItem('Release'), 'the Release tag');
    await until(() => expect(projectRows()).toHaveLength(0));
    expect(titles()).toEqual(expect.arrayContaining(['Plan the release', 'Build the package']));
    expect(listCalls.some((p) => p.includes(`tagId=${TAG.id}`))).toBe(true);
  });

  it('keeps search results flat so each member can be opened directly', async () => {
    await mount();
    await click(mounted().querySelector('.session-search'), 'Search sessions');
    await until(() => expect(document.querySelectorAll('.ssearch-row')).toHaveLength(3));
    const hits = [...document.querySelectorAll('.ssearch-title')].map((el) => el.textContent);
    expect(hits).toEqual(['Loose conversation', 'Plan the release', 'Build the package']);
    expect(document.querySelector('.ssearch-list .session-project-row')).toBeNull();
  });
});

describe('project entry status and second line', { timeout: 60_000 }, () => {
  it('puts the coordinator’s waiting words before member waits and active work', async () => {
    rows = [LOOSE, { ...COORDINATOR, pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' }, { ...TASK, pendingApprovals: 1 }];
    await mount();
    expect(preview()?.textContent).toBe('Waiting for your confirmation');
    expect(preview()?.classList.contains('tone-approval')).toBe(true);
    expect(projectRow().querySelector('.session-project-status')?.getAttribute('data-state')).toBe('needs-you');
  });

  it('names the oldest waiting member after its waiting words', async () => {
    const newer = { ...TASK, id: pid(814), title: 'Newer question', pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION', ownerItems: [{ since: '2026-10-04T09:00:00Z' }] };
    const older = { ...TASK, pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION', ownerItems: [{ since: '2026-10-03T09:00:00Z' }] };
    rows = [LOOSE, COORDINATOR, newer, older];
    await mount();
    expect(preview()?.textContent).toBe('Waiting for your confirmation · Build the package');
    expect(preview()?.getAttribute('title')).toBe('Waiting for your confirmation · Build the package');
    expect(preview()?.classList.contains('tone-approval')).toBe(true);
  });

  it('names a member waiting in another workspace while keeping the running spinner local', async () => {
    rows = [LOOSE, TASK];
    const elsewhere = { workspaceId: OTHER_WORKSPACE_ID, workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' } };
    remoteRows = [
      { ...COORDINATOR, ...elsewhere },
      {
        ...TASK, ...elsewhere, id: pid(815), title: 'Resolve issue elsewhere',
        status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT',
        pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION',
        ownerItems: [{ since: '2026-10-03T09:00:00Z' }],
      },
    ];
    await mount();
    await until(() => expect(preview()?.textContent).toBe('Waiting for your confirmation · Resolve issue elsewhere'));
    expect(titles()).toEqual(expect.arrayContaining(['Loose conversation', 'Project Alpha']));
    expect(titles()).toHaveLength(2);
    expect(preview()?.classList.contains('tone-approval')).toBe(true);
    expect(projectRow().querySelector('.session-project-icon .anticon-loading')).not.toBeNull();
    expect(projectRow().querySelector('.session-project-icon .sidebar-nav-icon')).toBeNull();
    expect(projectRow().querySelector('.session-project-status')).toBeNull();
    expect(projectRow().querySelector('.session-project-progress')?.getAttribute('title')).toBe('3 sessions · 1 running');
  });

  it('shows the coordinator’s exception handling words with an age and no Coordinator prefix', async () => {
    const now = Date.now();
    projects = [project({ attention: { ownerItems: [], startRequest: null, coordinatorItems: {
      count: 1, leadKind: 'INTEGRATION_CONFLICT',
      oldestWaitingSince: new Date(now - 18 * 60_000).toISOString(),
      nextEscalationAt: new Date(now + 60_000).toISOString(),
    } } })];
    await mount();
    expect(preview()?.textContent).toBe('Resolving a merge conflict · 18m');
    expect(preview()?.classList.contains('tone-running')).toBe(true);
  });

  it('uses the coordinator’s ordinary running line and the session’s blue spinner', async () => {
    rows = [LOOSE, { ...COORDINATOR, status: 'RUNNING', runState: 'RUNNING', lastToolUse: 'Bash' }, TASK];
    await mount();
    expect(preview()?.textContent).toBe('Running Bash…');
    expect(preview()?.classList.contains('tone-running')).toBe(true);
    expect(projectRow().querySelector('.session-project-icon .anticon-loading')).not.toBeNull();
    expect(projectRow().querySelector('.session-project-icon .sidebar-nav-icon')).toBeNull();
    expect(projectRow().querySelector('.session-project-status')).toBeNull();
  });

  it('says No coordinator when none is available', async () => {
    rows = [LOOSE, TASK];
    projects = [project({ coordinatorActivity: null })];
    await mount();
    expect(preview()?.textContent).toBe('No coordinator');
    expect(preview()?.classList.contains('tone-running')).toBe(false);
    expect(preview()?.classList.contains('tone-approval')).toBe(false);
  });

  it('breathes only for active background jobs after all member turns have parked', async () => {
    rows = [LOOSE, COORDINATOR, { ...TASK, status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', runningBgCount: 1, runningBgJobCount: 1 }];
    await mount();
    expect(projectRow().querySelector('.session-project-status')?.getAttribute('data-state')).toBe('jobs');
  });
});
