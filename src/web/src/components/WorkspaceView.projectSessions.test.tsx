// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import { ControlPlaneProvider } from '../lib/useControlPlane';
import { SessionSearch } from './SessionSearch';
import { projectSessionsQuery } from '../lib/queries';

// Exercise navigation, menus and both list scopes through the real WorkspaceView. Named API reads
// call api() within api.ts, so stub them separately from the query factories' api export.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getToken: () => 'token', getSessionEventPage: vi.fn(), getSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), getSessionMoveTargets: vi.fn(), moveSession: vi.fn(), completeSession: vi.fn(), restoreSession: vi.fn() };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const apiModule = await import('../api');
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');
const { MOBILE_QUERY } = await import('../lib/useMediaQuery');

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
  static streams: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.streams.push(this); }
  close() {}
}

let root: Root | null = null;
let client: QueryClient | null = null;
let container: HTMLDivElement | null = null;
let rows: Array<ReturnType<typeof row>> = [];
let remoteRows: Array<ReturnType<typeof row>> = [];
let projects: Array<ReturnType<typeof project>> = [];
let projectDetails: Record<string, unknown> | null = null;
let projectDetailsCalls: string[] = [];
let folders: Array<typeof FOLDER> = [];
let listCalls: string[] = [];
let location = '';
let routerNavigate: NavigateFunction;
let mobile = false;
let projectReadError = false;
let withControlPlane = false;
/** What the project's two promotion doors serve: the candidate on offer, and the merges made. */
let currentPromotion: Record<string, unknown> | null = null;
let merges: Array<Record<string, unknown>> = [];

function LocationProbe() {
  const l = useLocation();
  routerNavigate = useNavigate();
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
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try { await vi.waitFor(assertion, { timeout: 20_000, interval: 20 }); }
  finally { env.IS_REACT_ACT_ENVIRONMENT = true; }
  await act(async () => {});
};
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
async function mount(ready: () => void = () => expect(projectRows()).toHaveLength(1), path = `/sessions/${LOOSE.id}`): Promise<void> {
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  const view = <Routes>
    <Route path="/projects/:id" element={<div>Project destination</div>} />
    <Route path="*" element={<WorkspaceView runner={RUNNER} />} />
  </Routes>;
  root = nextRoot;
  client = nextClient;
  container = nextContainer;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[path]}>
          <AntApp>
            {withControlPlane ? <ControlPlaneProvider>{view}</ControlPlaneProvider> : view}
            <SessionSearch />
            <LocationProbe />
          </AntApp>
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
const menuItem = (label: string): HTMLElement | undefined =>
  // Submenus use their own portal, outside the dropdown's root element.
  [...document.querySelectorAll<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].find(
    (el) => el.closest<HTMLElement>('.ant-dropdown')?.style.pointerEvents !== 'none' && el.textContent?.trim().startsWith(label),
  );
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
  projectDetails = null;
  projectDetailsCalls = [];
  folders = [];
  listCalls = [];
  location = '';
  mobile = false;
  projectReadError = false;
  withControlPlane = false;
  currentPromotion = null;
  merges = [];
  FakeEventSource.streams = [];
  vi.mocked(apiModule.pinSession).mockReset().mockResolvedValue({});
  vi.mocked(apiModule.unpinSession).mockReset().mockResolvedValue({});
  vi.mocked(apiModule.getSessionMoveTargets).mockReset().mockResolvedValue({ workspaceId: WORKSPACE_ID, folderId: null, folders: [{ id: FOLDER.id, name: FOLDER.name, sessionCount: 0 }], reason: null, needsEnd: false, branch: null, changedFiles: 0, unmergedFiles: 0, mergeTarget: null, targets: [] });
  vi.mocked(apiModule.moveSession).mockReset().mockResolvedValue({ id: COORDINATOR.id, workspaceId: WORKSPACE_ID, folderId: FOLDER.id });
  vi.mocked(apiModule.completeSession).mockReset().mockImplementation(async (id) => {
    rows = rows.map((session) => session.id === id ? { ...session, lifecycleState: 'COMPLETED' } : session);
    return {};
  });
  vi.mocked(apiModule.restoreSession).mockReset().mockImplementation(async (id) => {
    rows = rows.map((session) => session.id === id ? { ...session, lifecycleState: 'OPEN' } : session);
    return {};
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.mocked(apiModule.getSessionEventPage).mockReset();
  vi.mocked(apiModule.getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
  vi.mocked(apiModule.getSession).mockReset();
  vi.mocked(apiModule.getSession).mockImplementation(async (id) => ([...rows, ...remoteRows].find((r) => r.id === id) ?? LOOSE) as never);
  vi.mocked(apiModule.api).mockReset();
  vi.mocked(apiModule.api).mockImplementation(((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', preferences: {} });
    if (path === '/workspaces') return reply([{ ...WORKSPACE, runnerId: RUNNER_ID, lastProvider: 'claude', createdAt: '2026-01-01T00:00:00Z' }]);
    if (path === '/session-folders') return reply(folders);
    if (path === '/session-tags') return reply([TAG]);
    if (path === '/projects/sidebar') return reply(projects);
    if (path === `/projects/${PROJECT_ID}`) {
      projectDetailsCalls.push(path);
      return reply(projectDetails);
    }
    if (path === `/projects/${PROJECT_ID}/promotions/current`) return reply(currentPromotion);
    if (path === `/projects/${PROJECT_ID}/promotions/merged`) return reply(merges);
    if (path.startsWith('/sessions/search?')) return reply({
      q: '', contentSearched: false, total: rows.length,
      hits: rows.map((r) => ({ ...r, matchField: 'title', snippet: null })),
    });
    if (path.startsWith('/sessions?')) {
      listCalls.push(path);
      const params = new URLSearchParams(path.split('?')[1]);
      if (params.has('projectId') && projectReadError) return Promise.reject(new Error('project list unavailable'));
      const lifecycle = params.get('view') === 'completed' ? 'COMPLETED' : params.get('view') === 'trash' ? 'TRASH' : 'OPEN';
      const inScope = params.has('workspaceId') ? rows : [...rows, ...remoteRows];
      return reply(inScope.filter((r) => r.lifecycleState === lifecycle &&
        (!params.has('projectId') || r.projectMembership?.projectId === params.get('projectId')))
        .sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt)));
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
    matches: mobile ? query === MOBILE_QUERY : query === '(hover: hover)', media: query, onchange: null,
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

const sessionRows = (): HTMLElement[] => [...mounted().querySelectorAll<HTMLElement>('.session-row:not(.session-project-row)')];
const memberRow = (title: string): HTMLElement | undefined => sessionRows().find((entry) => entry.querySelector('.session-title')?.textContent === title);
const page = (): HTMLElement | null => mounted().querySelector('.session-project-page');
const projectQueryCalls = (): URLSearchParams[] => listCalls.map((path) => new URLSearchParams(path.split('?')[1])).filter((params) => params.has('projectId'));
const remote = (n: number, title: string, extra: Record<string, unknown> = {}) => row(n, title, {
  workspaceId: OTHER_WORKSPACE_ID,
  workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' },
  projectMembership: membership('TASK'),
  ...extra,
});

async function openSessions(): Promise<void> {
  await click(projectRow(), 'the project entry');
  await until(() => expect(page()).not.toBeNull());
}

async function hoverProjectMenu(): Promise<void> {
  const kebab = projectRow().querySelector('[aria-label="Project actions"]');
  expect(kebab).not.toBeNull();
  await act(async () => kebab!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })));
  await click(kebab, 'the hover-revealed project menu');
  await until(() => expect(menuItem('Sessions')).toBeTruthy());
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  if (client) {
    await client.cancelQueries();
    client.clear();
  }
  client = null;
  container?.remove();
  container = null;
}

async function back(): Promise<void> {
  await act(async () => routerNavigate(-1));
  await settle();
}

async function swipe(entry: HTMLElement, dx: number, source: Element = entry): Promise<void> {
  Object.defineProperty(entry, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 400 }) });
  for (const [type, x] of [['touchstart', 200], ['touchmove', 200 + Math.sign(dx) * 10], ['touchmove', 200 + dx], ['touchend', 200 + dx]] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 30 }] });
    await act(async () => source.dispatchEvent(event));
  }
}

describe('project entry navigation and actions', { timeout: 60_000 }, () => {
  it.each([false, true])('opens the sessions page from the entry, and the coordinator from Open Session when nobody waits or the coordinator waits (waiting=%s)', async (waiting) => {
    rows = [LOOSE, { ...COORDINATOR, ...(waiting ? { pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' } : {}) }, { ...TASK, ...(waiting ? { pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' } : {}) }];
    await mount();
    await click(projectRow(), 'the project entry');
    await until(() => expect(page()).not.toBeNull());
    expect(new URLSearchParams(location.split('?')[1]).get('project')).toBe(PROJECT_ID);
    await back();
    await until(() => expect(page()).toBeNull());
    await hoverProjectMenu();
    await click(menuItem('Open Session'), 'Open Session for the coordinator');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}`));
  });

  it('opens the oldest waiting member named on the second line', async () => {
    const newer = { ...TASK, id: pid(821), title: 'Newer question', pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION', ownerItems: [{ since: '2026-10-04T09:00:00Z' }] };
    const older = { ...TASK, status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION', ownerItems: [{ since: '2026-10-03T09:00:00Z' }] };
    rows = [LOOSE, COORDINATOR, newer, older];
    await mount();
    expect(preview()?.textContent).toContain('Build the package');
    await act(async () => projectRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    await until(() => expect(menuItem('Open Session')).toBeTruthy());
    await click(menuItem('Open Session'), 'Open Session for the waiting member');
    await until(() => expect(location).toBe(`/sessions/${TASK.id}`));
    expect(projectRow().classList.contains('active')).toBe(true);
  });

  it('opens the project sessions page when there is no coordinator', async () => {
    rows = [LOOSE, TASK];
    projects = [project({ coordinatorActivity: null })];
    await mount();
    await hoverProjectMenu();
    expect(menuItem('Open Session')?.classList.contains('ant-dropdown-menu-item-disabled')).toBe(true);
    await click(menuItem('Open Session'), 'the disabled Open Session');
    expect(location).toBe(`/sessions/${LOOSE.id}`);
    await click(projectRow(), 'the project entry without a coordinator');
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}?project=${PROJECT_ID}`));
    await until(() => expect(page()?.textContent).toContain('Build the package'));
  });

  it('draws the progress tag as part of the entry, with the session-count hint', async () => {
    await mount();
    const progress = projectRow().querySelector('.session-project-progress');
    expect(progress?.getAttribute('title')).toBe('2 sessions · 1 running');
    expect(progress?.closest('button')).toBeNull();
    await click(progress, 'the project progress tag');
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}?project=${PROJECT_ID}`));
    expect(page()).not.toBeNull();
  });

  it('highlights a project when an already-opened session is any of its members', async () => {
    await mount(undefined, `/sessions/${TASK.id}`);
    expect(projectRow().classList.contains('active')).toBe(true);
  });

  it.each(['hover', 'context'] as const)('has exactly the project actions in its %s menu', async (trigger) => {
    await mount();
    if (trigger === 'hover') await hoverProjectMenu();
    else {
      await act(async () => projectRow().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
      await until(() => expect(menuItem('Sessions')).toBeTruthy());
    }
    const labels = [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Open Session', 'Sessions', 'Open Project', 'Pin', 'Move…']);
    const items = document.querySelector('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu')?.children;
    expect(items?.[3].classList.contains('ant-dropdown-menu-item-divider')).toBe(true);
    expect(document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item-divider')).toHaveLength(1);
    const entryText = projectRow().textContent ?? '';
    for (const forbidden of ['Complete', 'Share', 'Delete', 'Confirm done', 'Chat about this', 'Approve', 'Reject', 'Start project']) {
      expect(labels).not.toContain(forbidden);
      expect(entryText).not.toContain(forbidden);
    }
    await click(menuItem('Sessions'), 'Sessions');
    await until(() => expect(location).toContain(`?project=${PROJECT_ID}`));
  });

  it('pins and moves the coordinator from the project menu', async () => {
    folders = [FOLDER];
    await mount();
    await hoverProjectMenu();
    await click(menuItem('Pin'), 'Pin');
    await until(() => expect(apiModule.pinSession).toHaveBeenCalledWith(COORDINATOR.id));
    await hoverProjectMenu();
    await click(menuItem('Move…'), 'Move…');
    await until(() => expect(document.querySelector('.move-dialog-sub')?.textContent).toBe(COORDINATOR.title));
    expect(apiModule.getSessionMoveTargets).toHaveBeenCalledWith(COORDINATOR.id);
    const folder = [...document.querySelectorAll<HTMLElement>('.move-dialog-option')].find((option) => option.textContent?.includes(FOLDER.name));
    await click(folder, FOLDER.name);
    await until(() => expect(apiModule.moveSession).toHaveBeenCalledWith(COORDINATOR.id, { folderId: FOLDER.id }));
  });

  it('offers Unpin for a pinned coordinator', async () => {
    rows = [LOOSE, { ...COORDINATOR, pinnedAt: '2026-10-01T09:00:00Z' }, TASK];
    await mount();
    await hoverProjectMenu();
    expect([...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].map((item) => item.textContent?.trim())).toEqual(['Open Session', 'Sessions', 'Open Project', 'Unpin', 'Move…']);
    await click(menuItem('Unpin'), 'Unpin');
    await until(() => expect(apiModule.unpinSession).toHaveBeenCalledWith(COORDINATOR.id));
  });

  it('opens the project itself from the project entry menu', async () => {
    await mount();
    await hoverProjectMenu();
    await click(menuItem('Open Project'), 'Open Project');
    await until(() => expect(location).toBe(`/projects/${PROJECT_ID}`));
  });

  it('exposes only Pin on a right swipe and Move on a left swipe on a phone', async () => {
    mobile = true;
    await mount();
    let entry = projectRow();
    const labels = (side: string) => [...entry.querySelectorAll(`.session-swipe-actions.${side} button`)].map((button) => button.getAttribute('aria-label'));
    expect(labels('leading')).toEqual(['Pin']);
    expect(labels('trailing')).toEqual(['Move']);
    await swipe(entry, 90);
    expect(entry.querySelector<HTMLElement>('.session-swipe')?.style.transform).toMatch(/translateX\([1-9]\d*px\)/);
    await click(entry.querySelector('.session-swipe-action.pin'), 'the swipe Pin');
    await until(() => expect(apiModule.pinSession).toHaveBeenCalledWith(COORDINATOR.id));
    entry = projectRow();
    await swipe(entry, -90);
    expect(entry.querySelector<HTMLElement>('.session-swipe')?.style.transform).toMatch(/translateX\(-[1-9]\d*px\)/);
    await click(entry.querySelector('.session-swipe-action.move'), 'the swipe Move');
    await until(() => expect(apiModule.getSessionMoveTargets).toHaveBeenCalledWith(COORDINATOR.id));
  });

  it('consumes the synthesized progress click after a phone swipe and closes an open swipe before navigating', async () => {
    mobile = true;
    await mount();
    const entry = projectRow();
    const progress = entry.querySelector('.session-project-progress')!;
    await swipe(entry, 90, progress);
    await click(progress, 'the synthesized click after swiping the progress tag');
    expect(location).toBe(`/sessions/${LOOSE.id}`);
    expect(page()).toBeNull();
    await click(progress, 'the tap that closes the open swipe');
    expect(location).toBe(`/sessions/${LOOSE.id}`);
    expect(entry.querySelector<HTMLElement>('.session-swipe')?.style.transform).toBe('');
    await click(progress, 'the progress tag after the swipe closes');
    await until(() => expect(page()).not.toBeNull());
  });
});

describe('project sessions page', { timeout: 60_000 }, () => {
  it('reads one DONE project detail for its title and progress when the Open sidebar has no summary', async () => {
    projects = [];
    projectDetails = { id: PROJECT_ID, title: 'Delivered Alpha', status: 'DONE', tasksByStatus: { DONE: 4, FAILED: 1, CANCELLED: 2 } };
    rows = [LOOSE, ...[COORDINATOR, TASK].map((session) => ({
      ...session, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED',
      projectMembership: { ...session.projectMembership!, projectStatus: 'DONE' },
    }))];
    await mount(() => expect(titles()).toEqual([LOOSE.title]));
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    expect(projectRow().querySelector('.session-project-progress')?.textContent).toBe('DONE');
    await openSessions();
    await until(() => expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Delivered Alpha'));
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
    expect(page()?.querySelector('.session-project-page-progress')?.textContent).toContain('4/5 done · 0 running');
    expect(page()?.querySelector('.session-project-progress-bar .done')?.getAttribute('style')).toContain('80%');
    expect(projectDetailsCalls).toEqual([`/projects/${PROJECT_ID}`]);
    expect(listCalls.some((path) => {
      const params = new URLSearchParams(path.split('?')[1]);
      return !params.has('workspaceId') && !params.has('projectId') && !params.has('limit');
    })).toBe(false);
  });

  it('lists Open and Completed members across workspaces, excludes Trash and counts running members', async () => {
    remoteRows = [
      remote(825, 'Resolve remote issue', { lastTurnAt: '2026-10-04T10:00:00Z' }),
      remote(826, 'Completed remote work', { lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED', lastTurnAt: '2026-10-04T09:00:00Z' }),
      remote(827, 'Trashed remote work', { lifecycleState: 'TRASH', lastTurnAt: '2026-10-04T11:00:00Z' }),
    ];
    projects = [project({ buckets: { running: 99 } })];
    await mount();
    await openSessions();
    const header = page()?.querySelector('.session-project-page-header');
    expect(header?.textContent).toContain('Project Alpha');
    expect(header?.textContent).toContain('Project · 4 sessions');
    expect(page()?.textContent).toContain('2/5 done · 1 running');
    expect(page()?.querySelector('.session-new')).toBeNull();
    expect(page()?.querySelector('[aria-label="New session"]')).toBeNull();
    expect(sessionRows().map((entry) => entry.querySelector('.session-title')?.textContent)).toEqual(['Plan the release', 'Resolve remote issue', 'Completed remote work', 'Build the package']);
    const coordinatorSection = page()?.querySelector('.session-project-coordinator');
    expect(coordinatorSection?.textContent).toContain('Coordinator');
    expect(coordinatorSection?.querySelector('.session-title')?.textContent).toBe('Plan the release');
    expect(sessionRows()[0].querySelector('.coordinator-badge')).not.toBeNull();
    expect(projectQueryCalls().some((params) => params.get('projectId') === PROJECT_ID && params.get('view') === 'open')).toBe(true);
    expect(projectQueryCalls().some((params) => params.get('projectId') === PROJECT_ID && params.get('view') === 'completed')).toBe(true);
    expect(projectQueryCalls().some((params) => params.get('view') === 'trash')).toBe(false);
    await click(memberRow('Resolve remote issue'), 'the remote member');
    await until(() => expect(location).toBe(`/sessions/${pid(825)}?project=${PROJECT_ID}`));
    expect(titles()).toEqual(['Plan the release', 'Resolve remote issue', 'Completed remote work', 'Build the package']);
  });

  it.each(['open', 'completed'] as const)('gives mixed member rows their own lifecycle actions from the %s page', async (view) => {
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    const address = `/sessions/${LOOSE.id}?project=${PROJECT_ID}${view === 'completed' ? '&view=completed' : ''}`;
    await mount(() => expect(titles()).toEqual([COORDINATOR.title, TASK.title]), address);
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the Completed member menu');
    await until(() => expect(menuItem('Move to Open')).toBeTruthy());
    expect(menuItem('Complete')).toBeUndefined();
    await click(memberRow(COORDINATOR.title)?.querySelector('[aria-label="More actions"]'), 'the Open coordinator menu');
    await until(() => {
      expect(menuItem('Complete')).toBeTruthy();
      expect(menuItem('Move to Open')).toBeUndefined();
    });
  });

  it('counts each member once when Open and Completed responses overlap during a lifecycle change', async () => {
    await mount();
    await openSessions();
    await act(async () => client!.setQueryData(projectSessionsQuery({ projectId: PROJECT_ID, view: 'completed' }).queryKey,
      [{ ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }]));
    expect(titles()).toEqual([COORDINATOR.title, TASK.title]);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
  });

  it.each(['open', 'completed'] as const)('uses each member’s lifecycle for phone swipe buttons and full swipes from the %s page', async (view) => {
    mobile = true;
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    const address = `/sessions/${LOOSE.id}?project=${PROJECT_ID}${view === 'completed' ? '&view=completed' : ''}`;
    await mount(() => expect(titles()).toEqual([COORDINATOR.title, TASK.title]), address);
    const leadingLabels = (title: string) => [...memberRow(title)!.querySelectorAll('.session-swipe-actions.leading button')].map((button) => button.getAttribute('aria-label'));
    expect(leadingLabels(COORDINATOR.title)).toEqual(['Complete', 'Pin']);
    expect(leadingLabels(TASK.title)).toEqual(['Move to Open', 'Pin']);
    await swipe(memberRow(TASK.title)!, 300);
    await until(() => expect(apiModule.restoreSession).toHaveBeenCalledWith(TASK.id));
    expect(apiModule.completeSession).not.toHaveBeenCalled();
    await until(() => expect(leadingLabels(TASK.title)).toEqual(['Complete', 'Pin']));
    await swipe(memberRow(TASK.title)!, 300);
    await until(() => expect(apiModule.completeSession).toHaveBeenCalledWith(TASK.id));
    await until(() => expect(leadingLabels(TASK.title)).toEqual(['Move to Open', 'Pin']));
    expect(titles()).toEqual([COORDINATOR.title, TASK.title]);
  });

  it('uses the selected member’s fresher lifecycle for both phone buttons and the full swipe action', async () => {
    mobile = true;
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    vi.mocked(apiModule.getSession).mockResolvedValue({ ...TASK, lifecycleState: 'OPEN', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT' } as never);
    await mount(() => expect(titles()).toEqual([COORDINATOR.title, TASK.title]), `/sessions/${TASK.id}?project=${PROJECT_ID}&view=completed`);
    await until(() => expect([...memberRow(TASK.title)!.querySelectorAll('.session-swipe-actions.leading button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Complete', 'Pin']));
    await swipe(memberRow(TASK.title)!, 300);
    await until(() => expect(apiModule.completeSession).toHaveBeenCalledWith(TASK.id));
    expect(apiModule.restoreSession).not.toHaveBeenCalled();
  });

  it('hides the project page search button while keeping the global keyboard palette', async () => {
    await mount();
    expect(mounted().querySelector('.session-search')).not.toBeNull();
    await openSessions();
    expect(page()?.querySelector('.session-search')).toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })));
    await until(() => expect(document.querySelector('.ssearch-input')).not.toBeNull());
    await until(() => expect(document.querySelectorAll('.ssearch-row')).toHaveLength(3));
  });

  it('preserves the page in member links, browser Back and a fresh mount of the address', async () => {
    await mount();
    await openSessions();
    const pageAddress = location;
    await click(memberRow(TASK.title), TASK.title);
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    const memberAddress = location;
    await back();
    await until(() => expect(location).toBe(pageAddress));
    expect(page()).not.toBeNull();
    await back();
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}`));
    expect(page()).toBeNull();
    await unmount();
    await mount(() => expect(page()).not.toBeNull(), memberAddress);
    await until(() => expect(sessionRows()).toHaveLength(2));
    expect(location).toBe(memberAddress);
    expect(memberRow(TASK.title)?.classList.contains('active')).toBe(true);
  });

  it('lists all members from Completed, keeps its address in navigation and restores it on refresh', async () => {
    rows = [LOOSE, { ...COORDINATOR, lifecycleState: 'COMPLETED' }, { ...TASK, lifecycleState: 'COMPLETED' }];
    remoteRows = [remote(826, 'Completed remote work', { lifecycleState: 'COMPLETED' }), remote(827, 'Open remote work')];
    await mount(() => expect(titles()).toEqual(['Loose conversation']));
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    await openSessions();
    expect(location).toBe(`/workspaces/${WORKSPACE_ID}?project=${PROJECT_ID}&view=completed`);
    expect(titles()).toEqual(expect.arrayContaining(['Plan the release', 'Build the package', 'Completed remote work']));
    expect(titles()).toContain('Open remote work');
    await click(memberRow(TASK.title), TASK.title);
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}&view=completed`));
    const address = location;
    await unmount();
    await mount(() => expect(page()).not.toBeNull(), address);
    await until(() => expect(titles()).toHaveLength(4));
    expect(titles()).toContain('Open remote work');
    expect(new Set(projectQueryCalls().map((params) => params.get('view')))).toEqual(new Set(['open', 'completed']));
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the completed member menu after refresh');
    await until(() => expect(menuItem('Move to Open')).toBeTruthy());
    expect(menuItem('Complete')).toBeUndefined();
  });

  it('has the page menu, and its back button returns to the workspace list', async () => {
    await mount();
    await openSessions();
    await click(page()?.querySelector('.session-project-page-header .session-kebab'), 'the project page menu');
    await until(() => expect(menuItem('Open Project')).toBeTruthy());
    const labels = [...document.querySelectorAll('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item')].map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Open Project', 'Open Coordinator']);
    await click(menuItem('Open Coordinator'), 'Open Coordinator');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`));
    await click(page()?.querySelector('.session-folder-back'), 'the project page back');
    await until(() => expect(page()).toBeNull());
    expect(location).not.toContain('project=');
  });

  it('opens the project from the page progress arrow', async () => {
    await mount();
    await openSessions();
    await click(page()?.querySelector('.session-project-page-progress [aria-label="Open Project"]'), 'the progress arrow');
    await until(() => expect(location).toBe(`/projects/${PROJECT_ID}`));
  });

  it('returns to the originating folder with the page back button', async () => {
    folders = [FOLDER];
    rows = [LOOSE, { ...COORDINATOR, folderId: FOLDER.id }, TASK];
    const folderAddress = `/sessions/${LOOSE.id}?folder=${FOLDER.id}`;
    await mount(undefined, folderAddress);
    await openSessions();
    await click(page()?.querySelector('.session-folder-back'), 'the project page back');
    await until(() => expect(location).toBe(folderAddress));
    expect(page()).toBeNull();
    expect(mounted().querySelector('.session-folder-title')?.textContent).toBe(FOLDER.name);
    expect(projectRows()).toHaveLength(1);
  });

  it('renders an empty scoped project without falling back to the workspace list', async () => {
    rows = [LOOSE];
    await mount(() => expect(page()?.textContent).toContain('No sessions in this project.'), `/sessions/${LOOSE.id}?project=${PROJECT_ID}`);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 0 sessions');
    expect(titles()).toEqual([]);
    expect(location).toContain(`?project=${PROJECT_ID}`);
  });

  it('renders project read failures as an error on the same page', async () => {
    projectReadError = true;
    await mount(() => expect(page()?.textContent).toContain('Couldn’t load project sessions.'), `/sessions/${LOOSE.id}?project=${PROJECT_ID}`);
    expect(titles()).toEqual([]);
    expect(location).toContain(`?project=${PROJECT_ID}`);
  });

  it('keeps a completed member in the project page and changes its row actions immediately', async () => {
    await mount();
    await openSessions();
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the member menu');
    await until(() => expect(menuItem('Complete')).toBeTruthy());
    await click(menuItem('Complete'), 'Complete');
    await until(() => expect(apiModule.completeSession).toHaveBeenCalledWith(TASK.id));
    await until(() => expect(titles()).toEqual([COORDINATOR.title, TASK.title]));
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the completed member menu');
    await until(() => expect(menuItem('Move to Open')).toBeTruthy());
    expect(menuItem('Complete')).toBeUndefined();
    expect(location).toContain(`?project=${PROJECT_ID}`);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
  });

  it('keeps a restored member and changes its actions while retaining the Completed page address', async () => {
    rows = [LOOSE, { ...COORDINATOR, lifecycleState: 'COMPLETED' }, { ...TASK, lifecycleState: 'COMPLETED' }];
    const address = `/sessions/${LOOSE.id}?project=${PROJECT_ID}&view=completed`;
    await mount(() => expect(titles()).toHaveLength(2), address);
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the completed member menu');
    await until(() => expect(menuItem('Move to Open')).toBeTruthy());
    await click(menuItem('Move to Open'), 'Move to Open');
    await until(() => expect(apiModule.restoreSession).toHaveBeenCalledWith(TASK.id));
    await until(() => expect(titles()).toEqual([COORDINATOR.title, TASK.title]));
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the restored member menu');
    await until(() => expect(menuItem('Complete')).toBeTruthy());
    expect(menuItem('Move to Open')).toBeUndefined();
    expect(location).toBe(address);
    expect(new Set(projectQueryCalls().map((params) => params.get('view')))).toEqual(new Set(['open', 'completed']));
  });

  it.each(['open', 'completed'] as const)('lists and opens the opposite-view coordinator from the %s page menu', async (view) => {
    const completed = view === 'completed';
    rows = [LOOSE, { ...TASK, lifecycleState: completed ? 'COMPLETED' : 'OPEN' }];
    remoteRows = [{ ...COORDINATOR, lifecycleState: completed ? 'OPEN' : 'COMPLETED', workspaceId: OTHER_WORKSPACE_ID, workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' } }];
    const search = `?project=${PROJECT_ID}${completed ? '&view=completed' : ''}`;
    await mount(() => expect(titles()).toEqual([COORDINATOR.title, TASK.title]), `/sessions/${LOOSE.id}${search}`);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
    expect(page()?.querySelector('.session-project-coordinator .session-title')?.textContent).toBe(COORDINATOR.title);
    await click(page()?.querySelector('.session-project-page-header .session-kebab'), 'the page menu');
    await until(() => expect(menuItem('Open Coordinator')?.classList.contains('ant-dropdown-menu-item-disabled')).toBe(false));
    await click(menuItem('Open Coordinator'), 'Open Coordinator');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}${search}`));
    expect(titles()).toEqual([COORDINATOR.title, TASK.title]);
    expect(projectQueryCalls().every((params) => params.get('projectId') === PROJECT_ID)).toBe(true);
  });
});

describe('project-specific supplemental reads', { timeout: 60_000 }, () => {
  it('does not request extra members when the local coordinator and waiting target are available', async () => {
    rows = [LOOSE, COORDINATOR, { ...TASK, pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' }];
    await mount();
    expect(projectQueryCalls()).toEqual([]);
    expect(listCalls.some((path) => {
      const params = new URLSearchParams(path.split('?')[1]);
      return params.get('view') === 'completed' && !params.has('workspaceId') && !params.has('projectId');
    })).toBe(false);
  });

  it('only supplements projects in the current list that lack a coordinator or waiting member', async () => {
    rows = [LOOSE, TASK];
    remoteRows = [{ ...COORDINATOR, workspaceId: OTHER_WORKSPACE_ID, workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' } }, remote(828, 'Remote waiting question', { pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' })];
    await mount();
    await until(() => expect(preview()?.textContent).toContain('Remote waiting question'));
    expect(projectQueryCalls().length).toBeGreaterThan(0);
    expect(projectQueryCalls().every((params) => params.get('projectId') === PROJECT_ID)).toBe(true);
    expect(listCalls.every((path) => {
      const params = new URLSearchParams(path.split('?')[1]);
      return params.has('workspaceId') || params.has('projectId') || params.get('limit') !== null;
    })).toBe(true);
  });

  it('never reads an unpaginated cross-workspace Completed list in either view', async () => {
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED' }];
    await mount();
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    expect(projectQueryCalls().length).toBeGreaterThan(0);
    expect(projectQueryCalls().every((params) => params.get('projectId') === PROJECT_ID)).toBe(true);
    expect(listCalls.some((path) => {
      const params = new URLSearchParams(path.split('?')[1]);
      return params.get('view') === 'completed' && !params.has('workspaceId') && !params.has('projectId') && !params.has('limit');
    })).toBe(false);
  });

  it.each(['entry', 'page'])('keeps the %s query stable on unrelated events and debounces project-member updates', async (surface) => {
    withControlPlane = true;
    rows = [LOOSE, TASK];
    remoteRows = [{ ...COORDINATOR, workspaceId: OTHER_WORKSPACE_ID, workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' } }, remote(829, 'Remote waiting question', { pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' })];
    await mount();
    await until(() => expect(preview()?.textContent).toContain('Remote waiting question'));
    if (surface === 'page') await openSessions();
    const stream = FakeEventSource.streams.find((candidate) => candidate.url.startsWith('/api/events?'));
    expect(stream).toBeTruthy();
    await act(async () => stream!.onopen?.());
    await settle();
    const countBefore = projectQueryCalls().length;
    const publish = (projectId: string, sessionId: string) => stream!.onmessage?.({ data: JSON.stringify({
      type: 'session.updated', sessionId,
      data: { id: sessionId, projectMembership: { projectId, role: 'TASK' } },
    }) });
    await act(async () => {
      publish(pid(830), LOOSE.id);
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await settle();
    expect(projectQueryCalls()).toHaveLength(countBefore);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) publish(PROJECT_ID, TASK.id);
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await settle();
    expect(projectQueryCalls()).toHaveLength(countBefore + (surface === 'page' ? 2 : 1));
    expect(projectQueryCalls().every((params) => params.get('projectId') === PROJECT_ID)).toBe(true);
  });
});

/**
 * The merge into main lives on this page (owner decision 2026-10-06): its card under the progress
 * strip while a candidate asks, merges or is blocked, and every merge already made as a row on the
 * page's timeline, at its own instant.
 */
describe('the merge into main on the project sessions page', { timeout: 60_000 }, () => {
  const candidate = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    promotionId: 'promo-1', state, sourceKind: 'PROJECT_BRANCH', sourceRef: 'refs/heads/project/alpha',
    sourceSha: '5e5bfca23aa1', upstreamRef: 'refs/heads/main', commitsAhead: 5, filesChanged: 10,
    tasks: [{ taskId: 't1', title: 'Fix the runner gate' }, { taskId: 't2', title: 'Turn the session log off' }],
    taskIds: ['t1', 't2'],
    checks: [{ name: 'MERGE_CHECK', command: 'npm test', expectedExitCode: 0, exitCode: 0, timedOut: false, durationMs: 60_000 }],
    conflicts: [], upstreamShaChecked: 'abc1234', landsTreeSha: 'def5678', landsAs: 'MERGE_COMMIT',
    askedAt: '2026-10-04T08:30:00Z', upstream: { syncedAt: null, conflicts: false }, recheckedAt: null,
    recheck: null, merged: null, decidedAt: null, ...extra,
  });
  const card = (): HTMLElement | null => page()?.querySelector<HTMLElement>('.session-project-merge') ?? null;

  it('draws the asking candidate under the progress strip, and presses its own door from there', async () => {
    currentPromotion = candidate('READY');
    await mount();
    await openSessions();
    await until(() => expect(card()?.getAttribute('data-shape')).toBe('asking'));
    const progress = page()!.querySelector('.session-project-page-progress')!;
    expect(progress.compareDocumentPosition(card()!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the merge card is not under the progress strip').toBeTruthy();
    const text = card()!.textContent ?? '';
    for (const part of ['Merge into main?', 'Needs you', 'project/alpha · 5 commits ahead of main', '2 tasks · 10 files',
      'Fix the runner gate', 'Turn the session log off', '✓ Checks passed · no conflicts', 'Details ›']) {
      expect(text).toContain(part);
    }
    // The page's card claims no chord: the keys stay with the card the reader opened.
    expect(card()!.querySelector('.approval-kbd')).toBeNull();

    const merge = [...card()!.querySelectorAll('button')].find((button) => button.textContent === 'Merge to main');
    await click(merge, 'Merge to main');
    await until(() => expect(vi.mocked(apiModule.api)).toHaveBeenCalledWith(
      `/projects/${encodeURIComponent(PROJECT_ID)}/promotions/promo-1/confirm`,
      { method: 'POST', body: { sourceSha: '5e5bfca23aa1' } },
    ));
  });

  it('says a blocked candidate is the coordinator’s, and offers the way to it', async () => {
    currentPromotion = candidate('BLOCKED', { conflicts: ['src/a.go', 'src/b.go'], decidedAt: '2026-10-04T08:40:00Z' });
    await mount();
    await openSessions();
    await until(() => expect(card()?.getAttribute('data-shape')).toBe('blocked'));
    const text = card()!.textContent ?? '';
    expect(text).toContain('Can’t merge into main yet');
    expect(text).toContain('2 files conflict with main: src/a.go, src/b.go');
    expect(text).toContain('Coordinator is resolving it');
    expect(card()!.querySelector('a')?.getAttribute('href')).toBe(`/sessions/${encodeURIComponent(COORDINATOR.id)}`);
  });

  it('draws nothing about main while nothing is on offer', async () => {
    await mount();
    await openSessions();
    await settle();
    expect(card()).toBeNull();
    expect(page()!.querySelector('.session-project-merge-row')).toBeNull();
  });

  it('draws each merge already made on the timeline at its own instant, and opens its receipt', async () => {
    merges = [candidate('MERGED', {
      promotionId: 'promo-0',
      merged: { sha: '8d5a868e90df', byUserId: 'user-1', at: '2026-10-04T09:00:00Z', automatic: false, revert: null },
    })];
    await mount();
    await openSessions();
    const mergeRow = (): HTMLElement | null => page()?.querySelector<HTMLElement>('.session-project-merge-row') ?? null;
    await until(() => expect(mergeRow()).not.toBeNull());
    expect(mergeRow()!.textContent).toContain('Merged into main');
    expect(mergeRow()!.textContent).toContain('8d5a868 · 2 tasks · by you');
    // Newer than the task's last turn, so it leads it, in the same section.
    const task = memberRow('Build the package')!;
    expect(mergeRow()!.compareDocumentPosition(task) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mergeRow()!.closest('section')).toBe(task.closest('section'));
    expect(card(), 'a merge already made drew the card').toBeNull();

    await click(mergeRow(), 'the merge row');
    await until(() => expect(document.querySelector('.review-card-dialog .project-promotion-receipt')).not.toBeNull());
    const receipt = document.querySelector('.review-card-dialog .project-promotion-receipt')!;
    expect(receipt.textContent).toContain('8d5a868');
    expect(receipt.textContent).toContain('Fix the runner gate');
  });
});
