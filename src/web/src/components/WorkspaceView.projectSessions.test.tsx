// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  return { ...actual, api: vi.fn(), getToken: () => 'token', getSessionEventPage: vi.fn(), getSession: vi.fn(), pinSession: vi.fn(), unpinSession: vi.fn(), getSessionMoveTargets: vi.fn(), moveSession: vi.fn(), completeSession: vi.fn(), completeProjectSessions: vi.fn(), restoreSession: vi.fn() };
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
/** The unified projection a current server carries on the project document: every listed criterion
 *  met its work, each with the landing reason given (`null` is "on main"), and the counts that
 *  partition them. The default is the tally the owner read back — six criteria, five on main, one
 *  with no code to land. */
const derivedDone = (landingReasons: (string | null)[] = [null, null, null, null, null, 'CODELESS']) => {
  const criteria = landingReasons.map((landingReason, index) => ({
    definitionId: `c${index + 1}`, satisfied: true, landing: 'LANDED' as const, landingReason,
  }));
  const byReason = { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0 };
  for (const reason of landingReasons) if (reason) byReason[reason as keyof typeof byReason] += 1;
  const total = landingReasons.length;
  return {
    status: 'DONE' as const, done: true, withheld: [], confirmation: 'CONFIRMED' as const,
    counts: { criteria: total, met: total, landed: total, onMain: total - landingReasons.filter(Boolean).length, byReason },
    criteria,
  };
};

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
/** The coordinator's request to start, as the open-items door serves it, and how often it was read. */
let startRequest: Record<string, unknown> | null = null;
/** The exceptions the open-items door serves as the coordinator's — a blocked candidate's holder. */
let withCoordinatorItems: Array<Record<string, unknown>> = [];
let openItemsCalls = 0;
/** The project's integration line, with whatever is landing on it. */
let integrationView: Record<string, unknown> | null = null;

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
/** What the session list shows: the workspace's list, or the project's page where it is in the list's place (a phone). */
const list = (): HTMLElement => mounted().querySelector<HTMLElement>('.session-col:not(.session-project-column)') ?? mounted();
const titles = (): string[] => [...list().querySelectorAll('.session-row .session-title')].map((el) => el.textContent ?? '');
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
          {withControlPlane ? <ControlPlaneProvider>{view}</ControlPlaneProvider> : view}
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
/** Whether a menu or item is on an open menu: a closing or closed menu takes no pointer (the session list's
 *  dropdowns stay in the page as they leave) or is gone. */
const onOpenMenu = (el: Element): boolean => {
  for (let node: HTMLElement | null = el as HTMLElement; node; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none' || node.style.pointerEvents === 'none') return false;
  }
  return true;
};
/** The open menus' plain items, top to bottom (a row that opens a submenu is not one). Submenus use their own
 *  portal, outside their parent menu's element. */
const menuItems = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]:not([aria-haspopup])')].filter(onOpenMenu);
const menuItem = (label: string): HTMLElement | undefined =>
  menuItems().find((el) => el.textContent?.trim().startsWith(label));
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
  startRequest = null;
  withCoordinatorItems = [];
  openItemsCalls = 0;
  integrationView = null;
  FakeEventSource.streams = [];
  vi.mocked(apiModule.pinSession).mockReset().mockResolvedValue({});
  vi.mocked(apiModule.unpinSession).mockReset().mockResolvedValue({});
  vi.mocked(apiModule.getSessionMoveTargets).mockReset().mockResolvedValue({ workspaceId: WORKSPACE_ID, folderId: null, folders: [{ id: FOLDER.id, name: FOLDER.name, sessionCount: 0 }], reason: null, needsEnd: false, branch: null, changedFiles: 0, unmergedFiles: 0, mergeTarget: null, targets: [] });
  vi.mocked(apiModule.moveSession).mockReset().mockResolvedValue({ id: COORDINATOR.id, workspaceId: WORKSPACE_ID, folderId: FOLDER.id });
  vi.mocked(apiModule.completeSession).mockReset().mockImplementation(async (id) => {
    rows = rows.map((session) => session.id === id ? { ...session, lifecycleState: 'COMPLETED' } : session);
    return {};
  });
  vi.mocked(apiModule.completeProjectSessions).mockReset().mockImplementation(async (projectId) => {
    const moved = rows.filter((session) => session.projectMembership?.projectId === projectId && session.lifecycleState === 'OPEN');
    rows = rows.map((session) => moved.includes(session) ? { ...session, lifecycleState: 'COMPLETED' } : session);
    return { completed: moved.length };
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
    // No cross-project request is waiting on this project: the crossing card reads this door.
    if (path === `/projects/${PROJECT_ID}/handoffs`) return reply([]);
    if (path === `/projects/${PROJECT_ID}/open-items`) {
      openItemsCalls += 1;
      return reply({ needsYou: [], withCoordinator: withCoordinatorItems, startRequest });
    }
    if (path === `/projects/${PROJECT_ID}/integration`) return reply(integrationView ?? []);
    if (path === `/projects/${PROJECT_ID}/acceptance/confirmation`) return reply(null);
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

/** The page's rows wherever it is drawn, else the list's. */
const sessionRows = (): HTMLElement[] => [...(page() ?? list()).querySelectorAll<HTMLElement>('.session-row:not(.session-project-row)')];
/** The page's row titles, in the column beside the conversation or in the list's place. */
const pageTitles = (): string[] => [...(page()?.querySelectorAll('.session-row .session-title') ?? [])].map((el) => el.textContent ?? '');
const memberRow = (title: string): HTMLElement | undefined => sessionRows().find((entry) => entry.querySelector('.session-title')?.textContent === title);
// The project's sessions page: the list's place at phone width, the column beside the conversation wider.
const page = (): HTMLElement | null => mounted().querySelector('.session-project-page, .session-project-column');
const projectQueryCalls = (): URLSearchParams[] => listCalls.map((path) => new URLSearchParams(path.split('?')[1])).filter((params) => params.has('projectId'));
const remote = (n: number, title: string, extra: Record<string, unknown> = {}) => row(n, title, {
  workspaceId: OTHER_WORKSPACE_ID,
  workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' },
  projectMembership: membership('TASK'),
  ...extra,
});

// A phone's project row opens the coordinator (board 5), so there the page comes from the row's Sessions item.
async function openSessions(): Promise<void> {
  if (mobile) {
    await hoverProjectMenu();
    await click(menuItem('Sessions'), 'the project menu’s Sessions');
  } else await click(projectRow(), 'the project entry');
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
    expect(menuItem('Open Session')?.getAttribute('aria-disabled')).toBe('true');
    await click(menuItem('Open Session'), 'the disabled Open Session');
    expect(location).toBe(`/sessions/${LOOSE.id}`);
    await click(projectRow(), 'the project entry without a coordinator');
    // No coordinator to open: the column opens the project's latest member beside itself.
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    await until(() => expect(page()?.textContent).toContain('Build the package'));
    expect(titles()).toContain(LOOSE.title);
    expect(projectRows()).toHaveLength(1);
  });

  it('draws the progress tag as part of the entry, with the session-count hint', async () => {
    await mount();
    const progress = projectRow().querySelector('.session-project-progress');
    expect(progress?.getAttribute('title')).toBe('2 sessions · 1 running');
    expect(progress?.closest('button')).toBeNull();
    await click(progress, 'the project progress tag');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`));
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
    const labels = menuItems().map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Open Session', 'Sessions', 'Open Project', 'Pin', 'Move…']);
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(onOpenMenu);
    expect(menus).toHaveLength(1);
    expect(menus[0].children[3]?.getAttribute('role')).toBe('separator');
    expect(menus[0].querySelectorAll('[role="separator"]')).toHaveLength(1);
    const entryText = projectRow().textContent ?? '';
    for (const forbidden of ['Complete', 'Share', 'Delete', 'Confirm done', 'Chat about this', 'Approve', 'Reject', 'Start project']) {
      expect(labels).not.toContain(forbidden);
      expect(entryText).not.toContain(forbidden);
    }
    await click(menuItem('Sessions'), 'Sessions');
    await until(() => expect(location).toContain(`?project=${PROJECT_ID}`));
  });

  it.each(['DONE', 'CANCELLED'] as const)('leads a %s project\'s menu with Complete, which moves its sessions to Completed', async (status) => {
    const finished = { ...membership('COORDINATOR'), projectStatus: status };
    rows = [LOOSE, { ...COORDINATOR, projectMembership: finished }, { ...TASK, projectMembership: { ...finished, role: 'TASK' } }];
    projects = [project({ status })];
    await mount();
    await hoverProjectMenu();
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(['Complete', 'Open Session', 'Sessions', 'Open Project', 'Pin', 'Move…']);
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(onOpenMenu);
    expect(menus[0].children[1]?.getAttribute('role')).toBe('separator');
    expect(menus[0].querySelectorAll('[role="separator"]')).toHaveLength(2);
    await click(menuItem('Complete'), 'Complete');
    await until(() => expect(apiModule.completeProjectSessions).toHaveBeenCalledWith(PROJECT_ID));
    expect(apiModule.completeSession).not.toHaveBeenCalled();
    await until(() => expect(projectRows()).toHaveLength(0));
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    await hoverProjectMenu();
    expect(menuItem('Complete')).toBeUndefined();
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
    expect(menuItems().map((item) => item.textContent?.trim())).toEqual(['Open Session', 'Sessions', 'Open Project', 'Unpin', 'Move…']);
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
    // A phone's project row opens its coordinator directly (owner 2026-11-11, board 5).
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}`));
    expect(page()).toBeNull();
  });
});

// Owner decisions of 2026-11-11 (docs/mocks/project-sessions-column, board 2): wider than a phone, a
// project's row keeps the workspace's list and opens the coordinator, with the project's sessions in a
// column at the conversation's right edge.
/** The conversation title bar's Project sessions button, left of its ⋮ menu. */
const projectSessionsButton = (): HTMLButtonElement | null =>
  mounted().querySelector<HTMLButtonElement>('.workspace-header button[aria-label="Project sessions"]');

describe('the project sessions column beside the conversation', { timeout: 60_000 }, () => {
  const column = (): HTMLElement | null => mounted().querySelector<HTMLElement>('aside.session-project-column');
  const columnTitles = (): string[] => [...(column()?.querySelectorAll('.session-row .session-title') ?? [])].map((el) => el.textContent ?? '');

  it.each(['click', 'Enter'] as const)('opens the coordinator from a project row (%s), keeps the list, and shows the column to the right', async (how) => {
    await mount();
    if (how === 'click') await click(projectRow(), 'the project row');
    else {
      await act(async () => projectRow().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await settle();
    }
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`));
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    // The list is the workspace's still: its head, New session, its rows and the project's row, selected.
    const listCol = mounted().querySelector('aside.session-col:not(.session-project-column)')!;
    expect(listCol.classList.contains('session-project-page')).toBe(false);
    expect(listCol.querySelector('.session-scope-menu')).not.toBeNull();
    expect(listCol.querySelector('.session-new')).not.toBeNull();
    expect(titles()).toContain(LOOSE.title);
    expect(projectRows()).toHaveLength(1);
    expect(projectRow().classList.contains('active')).toBe(true);
    // Order across the split: list | conversation | column.
    const split = mounted().querySelector('.workspace-split')!;
    const panes = [...split.children].filter((el) => !el.classList.contains('session-resizer'));
    expect(panes.indexOf(listCol)).toBeLessThan(panes.indexOf(split.querySelector('.workspace-view')!));
    expect(panes.indexOf(split.querySelector('.workspace-view')!)).toBeLessThan(panes.indexOf(column()!));
    // Today's page, moved: its header, the progress card, the Coordinator section with its row selected.
    expect(column()!.querySelector('.session-project-page-header')?.textContent).toContain('Project Alpha');
    expect(column()!.querySelector('.session-project-page-progress')?.textContent).toBe('2/5 done · 1 running');
    const coordinatorRow = column()!.querySelector('.session-project-coordinator .session-row')!;
    expect(coordinatorRow.querySelector('.session-title')?.textContent).toBe(COORDINATOR.title);
    expect(coordinatorRow.classList.contains('active')).toBe(true);
    expect(column()!.querySelectorAll('.session-row.active')).toHaveLength(1);
  });

  it('folds with its ✕, which keeps ?project= on the address so the title bar’s button brings it back', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(column()).not.toBeNull());
    const close = column()!.querySelector('.session-project-page-header .session-folder-back')!;
    expect(close.getAttribute('aria-label')).toBe('Hide project sessions');
    await click(close, 'the column ✕');
    await until(() => expect(column()).toBeNull());
    expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`);
    expect(projectSessionsButton()?.getAttribute('aria-pressed')).toBe('false');
    expect(projectRows()).toHaveLength(1);
  });

  it('opens a member from the column with the column kept, and its row selected there', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    const member = [...column()!.querySelectorAll('.session-row')].find((el) => el.querySelector('.session-title')?.textContent === TASK.title);
    await click(member, 'the member row in the column');
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    expect(column()).not.toBeNull();
    const active = column()!.querySelector('.session-row.active .session-title');
    expect(active?.textContent).toBe(TASK.title);
    expect(projectRow().classList.contains('active')).toBe(true);
  });

  // Board 3: the column follows the selection. A member of its project keeps it; another project's row
  // switches it; a session in no project closes it.
  const listColumn = (): HTMLElement => mounted().querySelector<HTMLElement>('aside.session-col:not(.session-project-column)')!;
  const listSnapshot = (): string => [...listColumn().querySelectorAll('.session-row .session-title')]
    .map((el) => el.textContent).join('|');
  const press = async (key: 'ArrowDown' | 'ArrowUp'): Promise<void> => {
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
    await settle();
  };

  it('opens a member clicked in the column beside the same column, with the list as it was', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    const listBefore = listSnapshot();
    const columnBefore = column()!.innerHTML.replace(/ active/g, '');
    await click([...column()!.querySelectorAll('.session-row')].find((el) => el.querySelector('.session-title')?.textContent === TASK.title),
      'the member row in the column');
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    await until(() => expect(mounted().querySelector('.workspace-view .session-title, .workspace-view h1, .workspace-view')?.textContent).toContain(TASK.title));
    await settle();
    expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`);
    // The list: same rows, the project's row still the selected one.
    expect(listSnapshot()).toBe(listBefore);
    expect(projectRows()).toHaveLength(1);
    expect(projectRow().classList.contains('active')).toBe(true);
    // The column: the same rows, with only the selection moved to the member.
    expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]);
    expect([...column()!.querySelectorAll('.session-row.active .session-title')].map((el) => el.textContent)).toEqual([TASK.title]);
    expect(column()!.innerHTML.replace(/ active/g, '')).toBe(columnBefore);
  });

  it('switches the column to another project and opens its coordinator when that project’s row is clicked', async () => {
    const OTHER_PROJECT_ID = pid(830);
    const otherMembership = (role: string) => ({ projectId: OTHER_PROJECT_ID, projectTitle: 'Project Beta', projectStatus: 'OPEN', role });
    const otherCoordinator = row(831, 'Coordinate the migration', { projectMembership: otherMembership('COORDINATOR'),
      projectId: OTHER_PROJECT_ID, projectTitle: 'Project Beta', lastTurnAt: '2026-10-02T08:00:00Z' });
    const otherTask = row(832, 'Copy the index', { projectMembership: otherMembership('TASK'), lastTurnAt: '2026-10-02T07:00:00Z' });
    rows = [LOOSE, COORDINATOR, TASK, otherCoordinator, otherTask];
    projects = [project(), project({ id: OTHER_PROJECT_ID, title: 'Project Beta', lastActivityAt: '2026-10-02T08:00:00Z',
      coordinatorActivity: { working: false, lastTurnAt: otherCoordinator.lastTurnAt } })];
    await mount(() => expect(projectRows()).toHaveLength(2));
    const rowOf = (title: string) => projectRows().find((el) => el.textContent?.includes(title));
    await click(rowOf('Project Alpha'), 'Project Alpha’s row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    // Open a member first, so the switch is from a member's conversation too.
    await click([...column()!.querySelectorAll('.session-row')].find((el) => el.querySelector('.session-title')?.textContent === TASK.title),
      'the member row in the column');
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    await click(rowOf('Project Beta'), 'Project Beta’s row');
    await until(() => expect(location).toBe(`/sessions/${otherCoordinator.id}?project=${OTHER_PROJECT_ID}`));
    await until(() => expect(columnTitles()).toEqual([otherCoordinator.title, otherTask.title]));
    expect(column()!.querySelector('.session-project-page-header')?.textContent).toContain('Project Beta');
    expect([...column()!.querySelectorAll('.session-row.active .session-title')].map((el) => el.textContent)).toEqual([otherCoordinator.title]);
    expect(rowOf('Project Beta')!.classList.contains('active')).toBe(true);
    expect(rowOf('Project Alpha')!.classList.contains('active')).toBe(false);
    expect(projectRows()).toHaveLength(2);
    expect(titles()).toContain(LOOSE.title);
  });

  it('closes the column when a session in no project is clicked in the list', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await click(await (async () => { await until(() => expect(columnTitles()).toContain(TASK.title)); return [...column()!.querySelectorAll('.session-row')]
      .find((el) => el.querySelector('.session-title')?.textContent === TASK.title); })(), 'the member row in the column');
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    await click([...listColumn().querySelectorAll('.session-row:not(.session-project-row)')]
      .find((el) => el.querySelector('.session-title')?.textContent === LOOSE.title), 'the loose session in the list');
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}`));
    expect(column()).toBeNull();
    expect(projectRow().classList.contains('active')).toBe(false);
  });

  it('closes the column when the arrow keys step to a session in no project, and opens none stepping back', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    // The list is the project's row (newest) then the loose session.
    await press('ArrowDown');
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}`));
    expect(column()).toBeNull();
    // With no column open, stepping onto the project's row opens its coordinator alone, as before.
    await press('ArrowUp');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}`));
    expect(column()).toBeNull();
  });

  it('closes the column on any other navigation to a session in no project, and keeps it for a member', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    // A member reached some other way than the column keeps it.
    await act(async () => routerNavigate(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    await settle();
    expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`);
    expect(column()).not.toBeNull();
    // A session in no project under the same address closes it, rather than being sent to the coordinator.
    await act(async () => routerNavigate(`/sessions/${LOOSE.id}?project=${PROJECT_ID}`));
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}`));
    await until(() => expect(column()).toBeNull());
  });

  // Owner 2026-11-13: a member of another project selected from the list switches the column to that
  // project, as that project's own row does. Beta's coordinator runs in another workspace, so its member
  // here is a row of its own, marked with Beta, just below Alpha's row.
  const BETA_ID = pid(840);
  const betaMembership = (role: string) => ({ projectId: BETA_ID, projectTitle: 'Project Beta', projectStatus: 'OPEN', role });
  const betaCoordinator = remote(841, 'Coordinate Beta', { projectMembership: betaMembership('COORDINATOR'),
    projectId: BETA_ID, projectTitle: 'Project Beta', lastTurnAt: '2026-10-02T08:00:00Z' });
  const betaMember = row(842, 'Index the archive', { projectMembership: betaMembership('TASK'), lastTurnAt: '2026-10-03T09:00:00Z' });
  const withBeta = (): void => {
    rows = [LOOSE, COORDINATOR, TASK, betaMember];
    remoteRows = [betaCoordinator];
    projects = [project(), project({ id: BETA_ID, title: 'Project Beta', lastActivityAt: betaMember.lastTurnAt,
      coordinatorActivity: { working: false, lastTurnAt: betaCoordinator.lastTurnAt } })];
  };
  const listRow = (title: string): HTMLElement | undefined => [...listColumn().querySelectorAll<HTMLElement>('.session-row:not(.session-project-row)')]
    .find((el) => el.querySelector('.session-title')?.textContent === title);
  const activeColumnTitles = (): string[] => [...column()!.querySelectorAll('.session-row.active .session-title')].map((el) => el.textContent ?? '');
  const expectBetaColumn = async (): Promise<void> => {
    await until(() => expect(location).toBe(`/sessions/${betaMember.id}?project=${BETA_ID}`));
    await until(() => expect(columnTitles()).toEqual([betaCoordinator.title, betaMember.title]));
    expect(column()!.querySelector('.session-project-page-header')?.textContent).toContain('Project Beta');
    expect(activeColumnTitles()).toEqual([betaMember.title]);
    // The conversation pane is the member's.
    await until(() => expect(vi.mocked(apiModule.getSession).mock.calls.some(([id]) => id === betaMember.id)).toBe(true));
    await until(() => expect(mounted().querySelector('.workspace-view')?.textContent).toContain(betaMember.title));
    await settle();
    expect(location).toBe(`/sessions/${betaMember.id}?project=${BETA_ID}`);
    expect(projectRow().classList.contains('active')).toBe(false);
  };

  it('switches the column to another project when that project’s member is clicked in the list', async () => {
    withBeta();
    await mount(() => expect(listRow(betaMember.title)).toBeTruthy());
    await click(projectRow(), 'Project Alpha’s row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    await click(listRow(betaMember.title), 'Beta’s member in the list');
    await expectBetaColumn();
  });

  it('switches the column to another project when the arrow keys step onto that project’s member', async () => {
    withBeta();
    await mount(() => expect(listRow(betaMember.title)).toBeTruthy());
    await click(projectRow(), 'Project Alpha’s row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    // The list is Alpha's row, Beta's member, then the loose session.
    await press('ArrowDown');
    await expectBetaColumn();
    // On to a session in no project, the column closes.
    await press('ArrowDown');
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}`));
    expect(column()).toBeNull();
  });

  it('switches the column to another project’s member reached some other way, and still closes it for a session in no project', async () => {
    withBeta();
    await mount(() => expect(listRow(betaMember.title)).toBeTruthy());
    await click(projectRow(), 'Project Alpha’s row');
    await until(() => expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]));
    // A member of Alpha keeps Alpha's column.
    await act(async () => routerNavigate(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    await settle();
    expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}`);
    expect(columnTitles()).toEqual([COORDINATOR.title, TASK.title]);
    // A member of Beta under Alpha's address switches the column to Beta.
    await act(async () => routerNavigate(`/sessions/${betaMember.id}?project=${PROJECT_ID}`));
    await expectBetaColumn();
    // A session in no project closes it.
    await click(listRow(LOOSE.title), 'the loose session in the list');
    await until(() => expect(location).toBe(`/sessions/${LOOSE.id}`));
    expect(column()).toBeNull();
  });

  it('keeps the phone’s page in the list’s place, with no column', async () => {
    mobile = true;
    await mount();
    await openSessions();
    expect(column()).toBeNull();
    expect(mounted().querySelector('aside.session-col.session-project-page')).not.toBeNull();
    expect(location).toBe(`/sessions/${LOOSE.id}?project=${PROJECT_ID}`);
  });
});

describe('the title bar’s Project sessions button', { timeout: 60_000 }, () => {
  const column = (): HTMLElement | null => mounted().querySelector<HTMLElement>('aside.session-project-column');
  const button = (): HTMLButtonElement => {
    const found = projectSessionsButton();
    if (!found) throw new Error('no Project sessions button');
    return found;
  };
  const pressEscape = async (): Promise<void> => {
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await settle();
  };

  it('sits left of ⋮ on the coordinator’s and a member’s conversation, with the glyph and the session count, and on no other', async () => {
    await mount();
    expect(projectSessionsButton()).toBeNull();
    await click(projectRow(), 'the project row');
    await until(() => expect(column()).not.toBeNull());
    await until(() => expect(button().textContent).toBe('2'));
    expect(button().getAttribute('title')).toBe('Project sessions');
    expect(button().classList.contains('orbit-button')).toBe(true);
    expect(button().querySelector('.orbit-button-icon svg, .orbit-button-icon .anticon, .orbit-button-icon img, .orbit-button-icon *')).not.toBeNull();
    // Immediately left of the ⋮ More actions button.
    expect(button().nextElementSibling?.getAttribute('title')).toBe('More actions');
    // The column header counts the same sessions.
    expect(column()!.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
    // A member of the project carries it too.
    await act(async () => routerNavigate(`/sessions/${TASK.id}?project=${PROJECT_ID}`));
    await until(() => expect(mounted().querySelector('.workspace-header .workspace-name')?.textContent).toBe(TASK.title));
    expect(button().textContent).toBe('2');
    expect(button().nextElementSibling?.getAttribute('title')).toBe('More actions');
    // A session in no project has none.
    await act(async () => routerNavigate(`/sessions/${LOOSE.id}`));
    await until(() => expect(mounted().querySelector('.workspace-header .workspace-name')?.textContent).toBe(LOOSE.title));
    expect(projectSessionsButton()).toBeNull();
  });

  it('is pressed while the column is open, and a click folds the column and the next unfolds it', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(column()).not.toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('true');
    await click(button(), 'the Project sessions button');
    await until(() => expect(column()).toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`);
    await click(button(), 'the Project sessions button');
    await until(() => expect(column()).not.toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it('folds the column on Esc, but not while focus is in a field', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(column()).not.toBeNull());
    const composer = mounted().querySelector<HTMLTextAreaElement>('textarea');
    expect(composer, 'the composer').toBeTruthy();
    await act(async () => composer!.focus());
    await pressEscape();
    expect(column()).not.toBeNull();
    await act(async () => composer!.blur());
    await pressEscape();
    await until(() => expect(column()).toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`);
  });

  it('opens the column of a project conversation whose column is closed, counting its sessions', async () => {
    await mount(() => expect(mounted().querySelector('.workspace-header .workspace-name')?.textContent).toBe(COORDINATOR.title),
      `/sessions/${COORDINATOR.id}`);
    await until(() => expect(button().textContent).toBe('2'));
    expect(column()).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    await click(button(), 'the Project sessions button');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`));
    await until(() => expect(column()).not.toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('true');
  });

  it('remembers a hand fold in this browser until the button is pressed again', async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    });
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(column()).not.toBeNull());
    await click(column()!.querySelector('.session-project-page-header .session-folder-back'), 'the column ✕');
    await until(() => expect(column()).toBeNull());
    expect(stored.get('orbit.projectColumnFolded')).toBe('1');
    // A fresh page (a reload) keeps it folded, the address still naming the project.
    await act(async () => root!.unmount());
    container!.remove();
    await mount(() => expect(projectSessionsButton()?.textContent).toBe('2'), `/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`);
    expect(column()).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    await click(button(), 'the Project sessions button');
    await until(() => expect(column()).not.toBeNull());
    expect(stored.get('orbit.projectColumnFolded')).toBe('0');
  });
});

// Owner decisions of 2026-11-11 (docs/mocks/project-sessions-column, board 5): at phone width a project row
// opens the coordinator's conversation itself, and the title bar's button brings the project's sessions up
// in a bottom sheet over it.
describe('the phone’s project sessions sheet', { timeout: 60_000 }, () => {
  const sheet = (): HTMLElement | null => document.querySelector<HTMLElement>('.project-sessions-sheet');
  const sheetTitles = (): string[] => [...(sheet()?.querySelectorAll('.session-row .session-title') ?? [])].map((el) => el.textContent ?? '');
  const conversationName = (): string | null | undefined => mounted().querySelector('.workspace-header .workspace-name')?.textContent;
  const button = (): HTMLButtonElement => {
    const found = projectSessionsButton();
    if (!found) throw new Error('no Project sessions button');
    return found;
  };
  const openCoordinator = async (): Promise<void> => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(conversationName()).toBe(COORDINATOR.title));
  };
  const openSheet = async (): Promise<void> => {
    await openCoordinator();
    await until(() => expect(button().textContent).toBe('2'));
    await click(button(), 'the Project sessions button');
    await until(() => expect(sheetTitles()).toEqual([COORDINATOR.title, TASK.title]));
  };
  /** A drag of the grabber from y=`from` to y=`to`, with the sheet `height` px tall in an 852px-tall viewport. */
  const drag = async (from: number, to: number, height: number): Promise<void> => {
    vi.stubGlobal('innerHeight', 852);
    const drawer = sheet()!;
    Object.defineProperty(drawer, 'getBoundingClientRect', { configurable: true, value: () => ({ height }) });
    const grabber = drawer.querySelector('.project-sessions-sheet-grabber')!;
    const pointer = (type: string, clientY: number) => new MouseEvent(type, { bubbles: true, clientY });
    await act(async () => grabber.dispatchEvent(pointer('pointerdown', from)));
    await act(async () => grabber.dispatchEvent(pointer('pointermove', to)));
    await act(async () => grabber.dispatchEvent(pointer('pointerup', to)));
    await settle();
  };

  beforeEach(() => { mobile = true; });

  it('opens the coordinator’s conversation from a project row, with no project sessions page', async () => {
    await openCoordinator();
    expect(location).toBe(`/sessions/${COORDINATOR.id}`);
    expect(page()).toBeNull();
    expect(mounted().querySelector('.workspace-split')?.classList.contains('show-conversation')).toBe(true);
    // The title bar carries the button, left of ⋮, unpressed, with no sheet up yet.
    await until(() => expect(button().textContent).toBe('2'));
    expect(button().nextElementSibling?.getAttribute('title')).toBe('More actions');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(sheet()).toBeNull();
  });

  it('opens the project’s sessions in a bottom sheet at medium height from the title bar’s button', async () => {
    await openSheet();
    expect(location).toBe(`/sessions/${COORDINATOR.id}`);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(sheet()!.dataset.placement).toBe('bottom');
    expect(sheet()!.style.height).toBe('62%');
    expect(sheet()!.querySelector('.project-sessions-sheet-grabber')).not.toBeNull();
    expect(document.querySelector('.orbit-overlay-backdrop')).not.toBeNull();
    // Today's page, as the column has it: the head with ✕, the progress card, Coordinator selected.
    const head = sheet()!.querySelector('.session-project-page-header')!;
    expect(head.textContent).toContain('Project Alpha');
    expect(head.textContent).toContain('Project · 2 sessions');
    expect(head.querySelector('.session-folder-back')?.getAttribute('aria-label')).toBe('Hide project sessions');
    expect(sheet()!.querySelector('.session-project-page-progress')?.textContent).toBe('2/5 done · 1 running');
    expect(sheet()!.querySelector('.session-project-coordinator .session-row.active .session-title')?.textContent).toBe(COORDINATOR.title);
    // The list behind keeps the workspace's rows: no page took its place.
    expect(page()).toBeNull();
    expect(titles()).toContain(LOOSE.title);
  });

  it('closes the sheet and opens a member tapped in it, and Back returns to the session list', async () => {
    await openSheet();
    const member = [...sheet()!.querySelectorAll('.session-row')].find((el) => el.querySelector('.session-title')?.textContent === TASK.title);
    await click(member, 'the member row in the sheet');
    await until(() => expect(location).toBe(`/sessions/${TASK.id}`));
    await until(() => expect(sheet()).toBeNull());
    await until(() => expect(conversationName()).toBe(TASK.title));
    // The member's title bar carries the same button, unpressed.
    expect(button().getAttribute('aria-pressed')).toBe('false');
    await click(mounted().querySelector('.workspace-back-mobile'), 'the conversation’s Back');
    await until(() => expect(location.startsWith('/sessions/')).toBe(false));
    expect(mounted().querySelector('.workspace-split')?.classList.contains('show-conversation')).toBe(false);
    expect(page()).toBeNull();
    expect(projectRows()).toHaveLength(1);
  });

  it('closes on its ✕ and on Esc, leaving the conversation as it was', async () => {
    await openSheet();
    await click(sheet()!.querySelector('.session-project-page-header .session-folder-back'), 'the sheet’s ✕');
    await until(() => expect(sheet()).toBeNull());
    expect(location).toBe(`/sessions/${COORDINATOR.id}`);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    await click(button(), 'the Project sessions button');
    await until(() => expect(sheet()).not.toBeNull());
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await until(() => expect(sheet()).toBeNull());
    expect(location).toBe(`/sessions/${COORDINATOR.id}`);
  });

  it('drags up to full height, back to medium, and closes on a drag down', async () => {
    await openSheet();
    await drag(330, 30, 528);
    await until(() => expect(sheet()!.style.height).toBe('94%'));
    await drag(50, 300, 800);
    await until(() => expect(sheet()!.style.height).toBe('62%'));
    await drag(330, 700, 528);
    await until(() => expect(sheet()).toBeNull());
    expect(location).toBe(`/sessions/${COORDINATOR.id}`);
  });
});

describe('the project column in a window too narrow for it', { timeout: 60_000 }, () => {
  // The list and the column are 320px each by default, with a 1px divider before each: the column fits
  // beside a conversation of 480px from a split of 1122px.
  const NARROW = 1121;
  const WIDE = 1122;
  const column = (): HTMLElement | null => mounted().querySelector<HTMLElement>('aside.session-project-column');
  const button = (): HTMLButtonElement => {
    const found = projectSessionsButton();
    if (!found) throw new Error('no Project sessions button');
    return found;
  };
  let observed: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = [];
  let width = NARROW;
  beforeEach(() => {
    observed = [];
    width = NARROW;
    vi.stubGlobal('ResizeObserver', class {
      private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: new Set() };
        observed.push(this.entry);
      }
      observe(el: Element) { this.entry.targets.add(el); }
      unobserve(el: Element) { this.entry.targets.delete(el); }
      disconnect() { this.entry.targets.clear(); }
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('workspace-split') ? width : 0; },
    });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  });
  const resizeTo = async (next: number): Promise<void> => {
    width = next;
    const split = mounted().querySelector('.workspace-split')!;
    await act(async () => {
      for (const { callback, targets } of observed) {
        if (targets.has(split)) callback([], {} as ResizeObserver);
      }
    });
    await settle();
  };

  it('starts folded where the conversation would go under 480px, with the button plain, and unfolds as the window widens', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`));
    await until(() => expect(button().textContent).toBe('2'));
    expect(column()).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    // The list keeps the project's row selected, and the coordinator is open.
    expect(projectRow().classList.contains('active')).toBe(true);
    await resizeTo(WIDE);
    await until(() => expect(column()).not.toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(column()!.classList.contains('session-project-column-over')).toBe(false);
    // Narrow again, it folds by itself again.
    await resizeTo(NARROW);
    await until(() => expect(column()).toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('unfolds over the conversation on the button while too narrow, and folds again on ✕', async () => {
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(button().textContent).toBe('2'));
    expect(column()).toBeNull();
    await click(button(), 'the Project sessions button');
    await until(() => expect(column()).not.toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(column()!.classList.contains('session-project-column-over')).toBe(true);
    await click(column()!.querySelector('.session-project-page-header .session-folder-back'), 'the column ✕');
    await until(() => expect(column()).toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps a hand fold through widening until the button is pressed again', async () => {
    width = WIDE;
    await mount();
    await click(projectRow(), 'the project row');
    await until(() => expect(column()).not.toBeNull());
    await click(button(), 'the Project sessions button');
    await until(() => expect(column()).toBeNull());
    await resizeTo(NARROW);
    await resizeTo(WIDE + 400);
    expect(column()).toBeNull();
    expect(button().getAttribute('aria-pressed')).toBe('false');
    await click(button(), 'the Project sessions button');
    await until(() => expect(column()).not.toBeNull());
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(column()!.classList.contains('session-project-column-over')).toBe(false);
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
    // No projection to tally (`derivedDone`): the progress card stays where a current server's read
    // would have drawn the project's ending.
    expect(page()?.querySelector('.project-why-not-done')).toBeNull();
    expect(projectDetailsCalls).toEqual([`/projects/${PROJECT_ID}`]);
    expect(listCalls.some((path) => {
      const params = new URLSearchParams(path.split('?')[1]);
      return !params.has('workspaceId') && !params.has('projectId') && !params.has('limit');
    })).toBe(false);
  });

  it('draws the project’s ending where the progress card was, once the read carries the projection', async () => {
    projects = [];
    projectDetails = {
      id: PROJECT_ID, title: 'Delivered Alpha', status: 'DONE', doneBy: 'DERIVED',
      tasksByStatus: { DONE: 4, FAILED: 1, CANCELLED: 2 }, derivedDone: derivedDone(),
    };
    rows = [LOOSE, ...[COORDINATOR, TASK].map((session) => ({
      ...session, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED',
      projectMembership: { ...session.projectMembership!, projectStatus: 'DONE' },
    }))];
    await mount(() => expect(titles()).toEqual([LOOSE.title]));
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    await openSessions();
    await until(() => expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Delivered Alpha'));
    const ending = page()?.querySelector('.project-why-not-done.is-settled');
    expect(ending?.querySelector('.project-settlement-heading')?.textContent).toBe('This project is done');
    expect(ending?.querySelector('.criteria-provenance')?.textContent).toBe('recorded by Orbit');
    expect(ending?.querySelector('.project-done-tally')?.textContent).toBe('6 criteria · 5 on main · 1 no code to land');
    // The card it stands in for — one that would say nothing but "4/5 done · 0 running" — is gone.
    expect(page()?.querySelector('.session-project-page-card')).toBeNull();
  });

  it('keeps the progress card when the projection carries no unified counts', async () => {
    projects = [];
    projectDetails = {
      id: PROJECT_ID, title: 'Delivered Alpha', status: 'DONE', doneBy: 'DERIVED',
      tasksByStatus: { DONE: 4, FAILED: 1, CANCELLED: 2 },
      // An older server's projection: the criteria with no counts behind them draws none of these
      // cards (the conversation's own rule).
      derivedDone: { criteria: derivedDone().criteria },
    };
    rows = [LOOSE, ...[COORDINATOR, TASK].map((session) => ({
      ...session, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED',
      projectMembership: { ...session.projectMembership!, projectStatus: 'DONE' },
    }))];
    await mount(() => expect(titles()).toEqual([LOOSE.title]));
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    await openSessions();
    await until(() => expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Delivered Alpha'));
    expect(page()?.querySelector('.session-project-page-progress')?.textContent).toContain('4/5 done · 0 running');
    expect(page()?.querySelector('.project-why-not-done')).toBeNull();
  });

  it('spells the badge of the ending the way the recorder wrote it', async () => {
    projects = [];
    projectDetails = {
      id: PROJECT_ID, title: 'Delivered Alpha', status: 'DONE', doneBy: 'OWNER',
      tasksByStatus: { DONE: 5 }, derivedDone: derivedDone([null, 'CODELESS']),
    };
    rows = [LOOSE, ...[COORDINATOR, TASK].map((session) => ({
      ...session, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED',
      projectMembership: { ...session.projectMembership!, projectStatus: 'DONE' },
    }))];
    await mount(() => expect(titles()).toEqual([LOOSE.title]));
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    await openSessions();
    await until(() => expect(page()?.querySelector('.project-why-not-done.is-settled')).not.toBeNull());
    const ending = page()!.querySelector('.project-why-not-done.is-settled')!;
    expect(ending.querySelector('.criteria-provenance')?.textContent).toBe('recorded by you');
    expect(ending.querySelector('.project-done-tally')?.textContent).toBe('2 criteria · 1 on main · 1 no code to land');
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
    expect(pageTitles()).toEqual(['Plan the release', 'Resolve remote issue', 'Completed remote work', 'Build the package']);
  });

  it.each(['open', 'completed'] as const)('gives mixed member rows their own lifecycle actions from the %s page', async (view) => {
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    const address = `/sessions/${LOOSE.id}?project=${PROJECT_ID}${view === 'completed' ? '&view=completed' : ''}`;
    await mount(() => expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]), address);
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
    expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
  });

  it.each(['open', 'completed'] as const)('uses each member’s lifecycle for phone swipe buttons and full swipes from the %s page', async (view) => {
    mobile = true;
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    const address = `/sessions/${LOOSE.id}?project=${PROJECT_ID}${view === 'completed' ? '&view=completed' : ''}`;
    await mount(() => expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]), address);
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
    expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]);
  });

  it('uses the selected member’s fresher lifecycle for both phone buttons and the full swipe action', async () => {
    mobile = true;
    rows = [LOOSE, COORDINATOR, { ...TASK, lifecycleState: 'COMPLETED', status: 'SUCCEEDED', runState: 'SUCCEEDED' }];
    vi.mocked(apiModule.getSession).mockResolvedValue({ ...TASK, lifecycleState: 'OPEN', status: 'AWAITING_INPUT', runState: 'AWAITING_INPUT' } as never);
    await mount(() => expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]), `/sessions/${TASK.id}?project=${PROJECT_ID}&view=completed`);
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
    mobile = true; // the page in the list's place, as a phone still has it
    rows = [LOOSE, { ...COORDINATOR, lifecycleState: 'COMPLETED' }, { ...TASK, lifecycleState: 'COMPLETED' }];
    remoteRows = [remote(826, 'Completed remote work', { lifecycleState: 'COMPLETED' }), remote(827, 'Open remote work')];
    await mount(() => expect(titles()).toEqual(['Loose conversation']));
    await chooseView('Completed');
    await until(() => expect(projectRows()).toHaveLength(1));
    await openSessions();
    expect(location).toBe(`/workspaces/${WORKSPACE_ID}?project=${PROJECT_ID}&view=completed`);
    expect(pageTitles()).toEqual(expect.arrayContaining(['Plan the release', 'Build the package', 'Completed remote work']));
    expect(pageTitles()).toContain('Open remote work');
    await click(memberRow(TASK.title), TASK.title);
    await until(() => expect(location).toBe(`/sessions/${TASK.id}?project=${PROJECT_ID}&view=completed`));
    const address = location;
    await unmount();
    await mount(() => expect(page()).not.toBeNull(), address);
    await until(() => expect(pageTitles()).toHaveLength(4));
    expect(pageTitles()).toContain('Open remote work');
    expect(new Set(projectQueryCalls().map((params) => params.get('view')))).toEqual(new Set(['open', 'completed']));
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the completed member menu after refresh');
    await until(() => expect(menuItem('Move to Open')).toBeTruthy());
    expect(menuItem('Complete')).toBeUndefined();
  });

  // As iOS's toolbar has it (docs/mocks/project-sessions-page-web): one action, the project's page.
  it('has one action in its header, and its back button returns to the workspace list', async () => {
    mobile = true; // the page in the list's place, as a phone still has it
    await mount();
    await openSessions();
    const header = page()!.querySelector('.session-project-page-header')!;
    expect(header.querySelectorAll('button.session-kebab')).toHaveLength(1);
    expect(header.querySelector('.session-project-page-open')?.getAttribute('aria-label')).toBe('Open Project');
    await click(page()?.querySelector('.session-folder-back'), 'the project page back');
    await until(() => expect(page()).toBeNull());
    expect(location).not.toContain('project=');
  });

  it('opens the project from its header, and its progress card is first in the list with no link of its own', async () => {
    await mount();
    await openSessions();
    const list = page()!.querySelector('.workspace-sessions')!;
    const card = list.querySelector('.session-project-page-card')!;
    expect(list.firstElementChild, 'the card scrolls with the list, first in it').toBe(card);
    expect(card.querySelector('.session-project-page-progress')?.textContent).toBe('2/5 done · 1 running');
    expect(card.querySelector('a')).toBeNull();
    await click(page()?.querySelector('.session-project-page-open'), 'the header’s Open Project');
    await until(() => expect(location).toBe(`/projects/${PROJECT_ID}`));
  });

  it('says a project nobody has started is not started, and offers the owner’s own start while nobody asked', async () => {
    projects = [project({ startedAt: null, taskCounts: { done: 0, failed: 0, total: 5 } })];
    await mount();
    await openSessions();
    const start = (): HTMLElement | null => page()!.querySelector<HTMLElement>('.session-project-page-card .session-project-start');
    await until(() => expect(start()).not.toBeNull());
    expect(page()!.querySelector('.session-project-page-progress')?.textContent).toBe('Not started · 5 tasks');
    expect(start()!.textContent).toContain('The coordinator hasn’t asked yet');
    const press = start()!.querySelector<HTMLButtonElement>('.session-project-start-press')!;
    expect(press.textContent).toBe('Start…');
    expect(press.classList.contains('is-primary')).toBe(false);
    await click(press, 'Start…');
    await until(() => expect(document.querySelector('.start-card-dialog')).not.toBeNull());
  });

  it('offers the coordinator’s request to start with what it suggests, and opens it to be answered here', async () => {
    projects = [project({ startedAt: null, attention: { ownerItems: [], coordinatorItems: null, startRequest: { waitingSince: '2026-10-04T08:00:00Z' } } })];
    startRequest = {
      itemId: 'start-1', kind: 'START_REQUEST', title: 'Start this project?', detailLine: '', waitingSince: '2026-10-04T08:00:00Z',
      assignee: 'OWNER', assigneeReason: 'OWNER_ONLY',
      startRequest: {
        settings: { line: 'PROJECT_BRANCH', automatic: true, maxConcurrentTasks: 2, mergeCheckCommand: null },
        why: 'P2 and P3 can run side by side.', criteriaDigest: 'sha256:abc', planDigest: 'plan', repository: null, warnings: [],
      },
    };
    await mount();
    await openSessions();
    const start = (): HTMLElement | null => page()!.querySelector<HTMLElement>('.session-project-start');
    await until(() => expect(start()?.textContent).toContain('Ready to start'));
    expect(start()!.textContent).toContain('asked ');
    expect(start()!.querySelector('.session-project-start-suggestion')?.textContent).toBe('Project branch · Automatic on · 2 at a time');
    const press = start()!.querySelector<HTMLButtonElement>('.session-project-start-press')!;
    expect(press.textContent).toBe('Review and start');
    expect(press.classList.contains('is-primary')).toBe(true);
    // Counted nowhere: no badge on the card for a start request.
    expect(page()!.querySelector('.session-project-page-card .session-project-merge-badge')).toBeNull();
    await click(press, 'Review and start');
    await until(() => expect(document.querySelector('.start-card-dialog')).not.toBeNull());
  });

  it('says the suggestion goes directly into the main branch the start card opens with', async () => {
    projects = [project({ startedAt: null, attention: { ownerItems: [], coordinatorItems: null, startRequest: { waitingSince: '2026-10-04T08:00:00Z' } } })];
    const asking = (settings: Record<string, unknown>) => ({
      itemId: 'start-1', kind: 'START_REQUEST', title: 'Start this project?', detailLine: '', waitingSince: '2026-10-04T08:00:00Z',
      assignee: 'OWNER', assigneeReason: 'OWNER_ONLY',
      startRequest: {
        settings: { line: 'MAIN', automatic: false, maxConcurrentTasks: 1, mergeCheckCommand: null, ...settings },
        why: 'One task.', criteriaDigest: 'sha256:abc', planDigest: 'plan', repository: null, warnings: [],
      },
    });
    const suggestion = (): string | null | undefined =>
      page()?.querySelector<HTMLElement>('.session-project-start-suggestion')?.textContent;
    startRequest = asking({ upstreamRef: 'refs/heads/master' });
    await mount();
    await openSessions();
    await until(() => expect(suggestion()).toBe('Directly into master · Automatic off · 1 at a time'));
    await unmount();
    // The owner's last choice for the repository outranks a suggestion that names none, as on the card.
    startRequest = asking({});
    integrationView = {
      line: null, lineAbsentReason: 'NOT_DECIDED', ref: null, upstreamRef: 'main', upstreamChosenAt: null,
      lastMainBranch: { branch: 'develop', repository: 'acme/payments-api', chosenAt: '2026-10-03T08:00:00Z' },
      integratingCount: 0, queuedCount: 0, inFlight: null,
    };
    await mount();
    await openSessions();
    await until(() => expect(suggestion()).toBe('Directly into develop · Automatic off · 1 at a time'));
  });

  it('draws no start for a project already started, though it reads the open items for the Not yet note', async () => {
    projects = [project({ startedAt: '2026-10-02T00:00:00Z' })];
    await mount();
    await openSessions();
    await settle();
    expect(page()!.querySelector('.session-project-start')).toBeNull();
    // Read since 6455363cf for the owner's latest Not yet answer, which a started project shows too;
    // the start row is still decided by `startedAt` alone.
    expect(openItemsCalls).toBeGreaterThan(0);
    expect(page()!.querySelector('.session-project-page-progress')?.textContent).toBe('2/5 done · 1 running');
  });

  it('carries a task landing on the project branch in a card of its own, and lists every job in flight from it', async () => {
    const now = new Date().toISOString();
    const listed = (over: Record<string, unknown>) => ({
      kind: 'LAND_TASK', state: 'RUNNING', phase: 'CHECK', taskId: TASK.id, taskTitle: 'Build the package', generation: 1,
      startedAt: now, queuedAt: now, heartbeatAt: now, runnerName: RUNNER.name, retriedBy: null, timedOut: false,
      limitSeconds: 4200, retryable: false, ...over,
    });
    integrationView = {
      line: 'PROJECT_BRANCH', ref: 'project/alpha', integratingCount: 1, queuedCount: 1,
      inFlight: { kind: 'LAND_TASK', state: 'RUNNING', phase: 'CHECK', startedAt: now, heartbeatAt: now, taskTitle: 'Build the package' },
      inFlightJobs: [
        listed({ jobId: 'job-build' }),
        listed({ jobId: 'job-merge', kind: 'LAND_PROMOTION', state: 'QUEUED', phase: null, taskId: null, taskTitle: null,
          heartbeatAt: null, runnerName: null, limitSeconds: null }),
      ],
    };
    await mount();
    await openSessions();
    const landing = (): HTMLElement | null => page()!.querySelector<HTMLElement>('.session-project-landing');
    await until(() => expect(landing()?.textContent).toContain('2 jobs'));
    expect(landing()!.textContent).toContain('Landing');
    expect(landing()!.querySelector('.spl-press')!.getAttribute('aria-haspopup')).toBe('dialog');
    // Out of the progress card, which carried it as a last row until 2026-10-11
    // (docs/mocks/project-landing-card), and ahead of the merge card in the same list.
    const blocks = [...page()!.querySelectorAll('.session-project-page-card, .session-project-landing, .session-project-merge')];
    expect(blocks.map((block) => block.className.split(' ')[0]))
      .toEqual(['session-project-page-card', 'session-project-landing']);
    const before = location;
    await click(landing()!.querySelector('.spl-press')!, 'the landing card');
    const list = (): HTMLElement | null => document.querySelector<HTMLElement>('.landing-jobs-dialog');
    await until(() => expect(list()?.querySelector('.orbit-overlay-title')?.textContent).toBe('2 jobs in flight'));
    expect([...list()!.querySelectorAll('.landing-jobs-row')].map((entry) => entry.getAttribute('data-job')))
      .toEqual(['job-build', 'job-merge']);
    expect(list()!.textContent).toContain('Build the package');
    expect(list()!.textContent).toContain('Merge to main');
    // The list opens over this page rather than leaving it, and outside the card, which still holds
    // no link of its own.
    expect(location).toBe(before);
    expect(page()!.querySelector('.session-project-page-card a')).toBeNull();
  });

  it('opens the project from the landing line of a server that does not list its jobs', async () => {
    const now = new Date().toISOString();
    integrationView = {
      line: 'PROJECT_BRANCH', ref: 'project/alpha', integratingCount: 1, queuedCount: 0,
      inFlight: { kind: 'LAND_TASK', state: 'RUNNING', phase: 'CHECK', startedAt: now, heartbeatAt: now, taskTitle: 'Build the package' },
    };
    await mount();
    await openSessions();
    const landing = (): HTMLElement | null => page()!.querySelector<HTMLElement>('.session-project-landing');
    await until(() => expect(landing()?.textContent).toContain('Build the package'));
    expect(landing()!.textContent).toContain('Landing');
    // Nothing to open: the card is read, and its press is the project page's.
    expect(landing()!.querySelector('.spl-press')!.tagName).toBe('BUTTON');
    expect(landing()!.querySelector('.spl-press')!.getAttribute('aria-haspopup')).toBeNull();
    await click(landing()!.querySelector('.spl-press')!, 'the landing card');
    await until(() => expect(location).toBe(`/projects/${PROJECT_ID}`));
    expect(document.querySelector('.landing-jobs-dialog')).toBeNull();
  });

  it('offers Move on a phone’s swipe only for the coordinator, as its menu does', async () => {
    mobile = true;
    await mount();
    await openSessions();
    const trailing = (title: string) => [...memberRow(title)!.querySelectorAll('.session-swipe-actions.trailing button')]
      .map((button) => button.getAttribute('aria-label'));
    expect(trailing(COORDINATOR.title)).toEqual(['Share', 'Move', 'Delete']);
    expect(trailing(TASK.title)).toEqual(['Share', 'Delete']);
  });

  it('opens a phone row’s menu on a held press, and its release does not open the row', async () => {
    mobile = true;
    await mount();
    await openSessions();
    const task = memberRow(TASK.title)!;
    Object.defineProperty(task, 'getBoundingClientRect', { configurable: true, value: () => ({ width: 400, left: 0, top: 100 }) });
    const down = new Event('touchstart', { bubbles: true, cancelable: true });
    Object.defineProperty(down, 'touches', { value: [{ clientX: 120, clientY: 130 }] });
    const before = location;
    await act(async () => task.dispatchEvent(down));
    await until(() => expect(menuItem('Pin')).toBeTruthy());
    const up = new Event('touchend', { bubbles: true, cancelable: true });
    Object.defineProperty(up, 'touches', { value: [] });
    await act(async () => task.dispatchEvent(up));
    expect(up.defaultPrevented, 'the release must not send the click that opens the row').toBe(true);
    expect(location).toBe(before);
    expect(menuItem('Move')).toBeUndefined();
    await click(menuItem('Pin'), 'Pin');
    await until(() => expect(apiModule.pinSession).toHaveBeenCalledWith(TASK.id));
  });

  it('returns to the originating folder with the page back button', async () => {
    mobile = true; // the page in the list's place, as a phone still has it
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
    mobile = true; // the page in the list's place, as a phone still has it
    rows = [LOOSE];
    await mount(() => expect(page()?.querySelector('.session-project-empty')?.textContent).toBe('No sessions'), `/sessions/${LOOSE.id}?project=${PROJECT_ID}`);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 0 sessions');
    expect(titles()).toEqual([]);
    expect(location).toContain(`?project=${PROJECT_ID}`);
  });

  it('renders project read failures on the same page, with the reason and a retry', async () => {
    mobile = true; // the page in the list's place, as a phone still has it
    projectReadError = true;
    const empty = (): HTMLElement | null => page()?.querySelector<HTMLElement>('.session-project-empty') ?? null;
    await mount(() => expect(empty()?.textContent).toContain('Couldn’t load sessions'), `/sessions/${LOOSE.id}?project=${PROJECT_ID}`);
    expect(empty()!.textContent).toContain('project list unavailable');
    expect(titles()).toEqual([]);
    expect(location).toContain(`?project=${PROJECT_ID}`);
    projectReadError = false;
    await click([...empty()!.querySelectorAll('button')].find((button) => button.textContent === 'Retry'), 'Retry');
    await until(() => expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]));
  });

  it('keeps a completed member in the project page and changes its row actions immediately', async () => {
    await mount();
    await openSessions();
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the member menu');
    await until(() => expect(menuItem('Complete')).toBeTruthy());
    await click(menuItem('Complete'), 'Complete');
    await until(() => expect(apiModule.completeSession).toHaveBeenCalledWith(TASK.id));
    await until(() => expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]));
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the completed member menu');
    await until(() => expect(menuItem('Move to Open')).toBeTruthy());
    expect(menuItem('Complete')).toBeUndefined();
    expect(location).toContain(`?project=${PROJECT_ID}`);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
  });

  it('keeps a restored member and changes its actions while retaining the Completed page address', async () => {
    mobile = true; // the page in the list's place, as a phone still has it
    rows = [LOOSE, { ...COORDINATOR, lifecycleState: 'COMPLETED' }, { ...TASK, lifecycleState: 'COMPLETED' }];
    const address = `/sessions/${LOOSE.id}?project=${PROJECT_ID}&view=completed`;
    await mount(() => expect(pageTitles()).toHaveLength(2), address);
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the completed member menu');
    await until(() => expect(menuItem('Move to Open')).toBeTruthy());
    await click(menuItem('Move to Open'), 'Move to Open');
    await until(() => expect(apiModule.restoreSession).toHaveBeenCalledWith(TASK.id));
    await until(() => expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]));
    await click(memberRow(TASK.title)?.querySelector('[aria-label="More actions"]'), 'the restored member menu');
    await until(() => expect(menuItem('Complete')).toBeTruthy());
    expect(menuItem('Move to Open')).toBeUndefined();
    expect(location).toBe(address);
    expect(new Set(projectQueryCalls().map((params) => params.get('view')))).toEqual(new Set(['open', 'completed']));
  });

  it.each(['open', 'completed'] as const)('lists and opens the opposite-view coordinator from its row on the %s page', async (view) => {
    mobile = true; // the page in the list's place, as a phone still has it
    const completed = view === 'completed';
    rows = [LOOSE, { ...TASK, lifecycleState: completed ? 'COMPLETED' : 'OPEN' }];
    remoteRows = [{ ...COORDINATOR, lifecycleState: completed ? 'OPEN' : 'COMPLETED', workspaceId: OTHER_WORKSPACE_ID, workspace: { id: OTHER_WORKSPACE_ID, name: 'other workspace' } }];
    const search = `?project=${PROJECT_ID}${completed ? '&view=completed' : ''}`;
    await mount(() => expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]), `/sessions/${LOOSE.id}${search}`);
    expect(page()?.querySelector('.session-project-page-header')?.textContent).toContain('Project · 2 sessions');
    expect(page()?.querySelector('.session-project-coordinator .session-title')?.textContent).toBe(COORDINATOR.title);
    await click(page()?.querySelector('.session-project-coordinator .session-row'), 'the coordinator row');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}${search}`));
    expect(pageTitles()).toEqual([COORDINATOR.title, TASK.title]);
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

  // In the coordinator's workspace, the one place its project has a row (owner 11-07): the member waiting
  // in another workspace is read through the project.
  it('only supplements projects in the current list that lack a coordinator or waiting member', async () => {
    rows = [LOOSE, COORDINATOR, TASK];
    remoteRows = [remote(828, 'Remote waiting question', { pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' })];
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
    rows = [LOOSE, COORDINATOR, TASK];
    remoteRows = [remote(829, 'Remote waiting question', { pendingApprovals: 1, waitingKind: 'OWNER_CONFIRMATION' })];
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
    // Past the stream's coalescing window (a second) each time.
    await act(async () => {
      publish(pid(830), LOOSE.id);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    await settle();
    expect(projectQueryCalls()).toHaveLength(countBefore);
    await act(async () => {
      for (let i = 0; i < 5; i += 1) publish(PROJECT_ID, TASK.id);
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    });
    await settle();
    // The page's two reads, and with the list still the workspace's beside it, the entry's one.
    expect(projectQueryCalls()).toHaveLength(countBefore + (surface === 'page' ? 3 : 1));
    expect(projectQueryCalls().every((params) => params.get('projectId') === PROJECT_ID)).toBe(true);
  });
});

/**
 * The merge into main lives on this page (owner decision 2026-10-06): its card under the progress
 * strip while a candidate asks, merges or is blocked. Every merge already made is a row of the
 * project's Landings window (owner 2026-10-27), no longer of the page's timeline.
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

  it('draws the asking candidate under the progress card, and presses its own door from there', async () => {
    currentPromotion = candidate('READY');
    projectDetails = { id: PROJECT_ID, title: 'Project Alpha', acceptanceCriteriaItems: [
      { ordinal: 1, satisfied: true }, { ordinal: 2, satisfied: false }, { ordinal: 3, satisfied: false },
    ] };
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
    expect(card()!.closest('.workspace-sessions'), 'the card scrolls with the list').not.toBeNull();
    expect(card()!.querySelector('.session-project-merge-tile svg')).not.toBeNull();
    expect(card()!.querySelector('.session-project-merge-rule')).not.toBeNull();
    await until(() => expect(card()!.querySelector('.session-project-merge-criteria')?.textContent)
      .toBe('1 of 3 met on this branch — merging does not close the project'));
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
    // The exception its check opened, which the coordinator holds.
    withCoordinatorItems = [{
      itemId: 'item-conflict', kind: 'INTEGRATION_CONFLICT', title: 'Merge conflict', detailLine: '',
      assignee: 'COORDINATOR', assigneeReason: 'DEFAULT', waitingSince: '2026-10-04T08:40:00Z',
      escalateAt: null, escalatedAt: null, taskId: null, sessionId: null, promotionId: 'promo-1',
      fuseEpisodeId: null, actions: [], delivery: { state: 'DELIVERED', sessionId: COORDINATOR.id, at: '2026-10-04T08:40:00Z' },
    }];
    await mount();
    await openSessions();
    await until(() => expect(card()?.getAttribute('data-shape')).toBe('blocked'));
    const text = card()!.textContent ?? '';
    expect(text).toContain('Can’t merge into main yet');
    expect(text).toContain('2 files conflict with main: src/a.go, src/b.go');
    expect(text).toContain('Coordinator is resolving it');
    // The way to it keeps this page in the column, as the coordinator's row does.
    await click([...card()!.querySelectorAll('button')].find((button) => button.textContent === 'Open coordinator ›'), 'Open coordinator');
    await until(() => expect(location).toBe(`/sessions/${COORDINATOR.id}?project=${PROJECT_ID}`));
    expect(page()).not.toBeNull();
  });

  /** 2026-10-09: the coordinator had closed the exception (the work was already on main), and the
   *  card still said "Coordinator is resolving it". Read with nothing holding it, it names nobody. */
  it('names nobody once the project’s items are read and none holds the blocked candidate', async () => {
    currentPromotion = candidate('BLOCKED', { conflicts: ['src/a.go'], decidedAt: '2026-10-04T08:40:00Z' });
    await mount();
    await openSessions();
    await until(() => expect(card()?.getAttribute('data-shape')).toBe('blocked'));
    await until(() => expect(openItemsCalls).toBeGreaterThan(0));
    await until(() => expect(card()!.textContent ?? '').not.toContain('Coordinator is resolving it'));
    expect(card()!.querySelector('.promotion-spin')).toBeNull();
    const text = card()!.textContent ?? '';
    expect(text).toContain('Can’t merge into main yet');
    expect(text).toContain('Open coordinator ›');
  });

  it('lists the jobs in flight from the merge check’s landing row', async () => {
    const now = new Date().toISOString();
    integrationView = {
      line: 'PROJECT_BRANCH', ref: 'project/alpha', integratingCount: 1, queuedCount: 0,
      inFlight: { kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK', startedAt: now, heartbeatAt: now, taskTitle: null },
      inFlightJobs: [{
        jobId: 'job-check', kind: 'CHECK_PROMOTION', state: 'RUNNING', phase: 'CHECK', taskId: null, taskTitle: null,
        generation: 1, startedAt: now, queuedAt: now, heartbeatAt: now, runnerName: RUNNER.name, retriedBy: null,
        timedOut: false, limitSeconds: 4200, retryable: false,
      }],
    };
    await mount();
    await openSessions();
    await until(() => expect(card()?.getAttribute('data-shape')).toBe('checking'));
    // The job is the merge card's, so no landing card of its own is drawn.
    expect(page()!.querySelector('.session-project-landing')).toBeNull();
    // The row is the merged line's anatomy (owner decision 2026-10-11): the head, the whole row
    // the press that opens the jobs, and no chevron — the merged line is pressed the same way.
    expect(card()!.querySelector('.landing-head.is-running')).not.toBeNull();
    expect(card()!.textContent ?? '').toContain('checking');
    expect(card()!.querySelector('.landing-head-right')?.textContent).toMatch(/^\d+m \d+s$/);
    const press = card()!.querySelector<HTMLButtonElement>('button.landing-head-press');
    expect(press?.textContent).toContain('Merge check');
    await click(press, 'the merge check’s landing row');
    await until(() => expect(document.querySelector('.landing-jobs-dialog .orbit-overlay-title')?.textContent)
      .toBe('1 job in flight'));
    expect(document.querySelector('.landing-jobs-row[data-job="job-check"]')?.textContent).toContain('checking');
  });

  it('draws nothing about main while nothing is on offer', async () => {
    await mount();
    await openSessions();
    await settle();
    expect(card()).toBeNull();
    expect(page()!.querySelector('.session-project-merge-row')).toBeNull();
  });

  it('draws no merge already made on the timeline: it is a row of the Landings window', async () => {
    merges = [candidate('MERGED', {
      promotionId: 'promo-0',
      merged: { sha: '8d5a868e90df', byUserId: 'user-1', at: '2026-10-04T09:00:00Z', automatic: false, revert: null },
    })];
    await mount();
    await openSessions();
    // A merge into main is a landing the project has had: the Landings row is there, and it is the
    // only row on the page that is not a session.
    await until(() => expect(page()!.querySelector('.session-project-landings')).not.toBeNull());
    expect([...mounted().querySelectorAll('.session-project-merge-row')]
      .every((entry) => entry.closest('.session-project-landings') != null)).toBe(true);
    expect(mounted().querySelector('.session-col-list')?.textContent).not.toContain('8d5a868 · 2 tasks · by you');
    expect(card(), 'a merge already made drew the card').toBeNull();
  });
});

/**
 * The Landings row (owner 2026-10-27, docs/mocks/landings-one-window 01 b; contract §2.9 LS6,
 * revision 28): one row under the coordinator, above the page's own timeline, saying the most urgent
 * landing's mark and the day's counts — counted by none of the page's numbers — that opens the
 * project's Landings window.
 */
describe('the project sessions page — the Landings row', () => {
  const LANDING = (n: number, title: string, landing: Record<string, unknown>, over: Record<string, unknown> = {}) => row(n, title, {
    projectMembership: membership('TASK'),
    sessionKind: 'LANDING',
    startup: null,
    landing,
    ...over,
  });
  const awaiting = (subject: 'TASK' | 'PROMOTION' = 'TASK') => ({
    subject, state: 'AWAITING_DECISION', settledAs: null, settledAt: null,
  });
  const inFlight = () => ({ subject: 'TASK', state: 'IN_FLIGHT', settledAs: null, settledAt: null });
  const settled = (settledAs: string, minutesAgo: number, subject: 'TASK' | 'PROMOTION' = 'TASK') => ({
    subject, state: 'SETTLED', settledAs,
    settledAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  const section = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.session-project-landings');
  const landingsRow = (): HTMLElement | null => section()?.querySelector<HTMLElement>('.session-project-landing-row') ?? null;
  /** Minutes back to an instant earlier today, so a "today" count holds at any hour the suite runs. */
  const earlierToday = (minutes: number): number => {
    const now = new Date();
    const sinceMidnight = now.getHours() * 60 + now.getMinutes();
    return Math.min(minutes, Math.max(0, sinceMidnight - 1));
  };

  it('is one row under the coordinator and above the page’s timeline', async () => {
    rows = [LOOSE, COORDINATOR, TASK, LANDING(820, 'Land · Build the package', awaiting(), {
      createdAt: new Date(Date.now() - 18 * 60_000).toISOString(),
    })];
    await mount();
    await openSessions();

    const heads = [...page()!.querySelectorAll<HTMLElement>('.session-col-list .session-section-head')]
      .map((head) => head.textContent);
    expect(heads[0]).toBe('Coordinator');
    expect(heads[1]).toBe('Landings');
    expect(section()!.querySelectorAll('.session-project-landing-row')).toHaveLength(1);
    expect(landingsRow()!.querySelector('.session-project-merge-row-title')?.textContent).toBe('Landings');
    // Something waits for a decision: the red ✕, and how long the longest wait has been.
    expect(landingsRow()!.querySelector('.session-project-landing-mark')?.className).toContain('is-fail');
    expect(landingsRow()!.querySelector('.session-project-landing-mark')?.textContent).toBe('✕');
    expect(landingsRow()!.querySelector('.session-time')?.textContent).toBe('18m');
    expect(landingsRow()!.querySelector('.session-project-merge-row-detail')?.textContent).toBe('1 waiting for a decision');
    // The landing is no conversation: it is not among the session rows.
    expect(sessionRows().map((entry) => entry.querySelector('.session-title')?.textContent))
      .not.toContain('Land · Build the package');
  });

  it('keeps a LANDING row out of the page’s count, its running number and its timeline', async () => {
    rows = [LOOSE, COORDINATOR, TASK, LANDING(820, 'Land · Build the package', awaiting(), {
      status: 'RUNNING', runState: 'RUNNING',
    })];
    await mount();
    await openSessions();

    // The project's TWO conversations, whatever its landings are doing — the landing itself would
    // make it three, and its RUNNING row a second running one.
    expect(mounted().querySelector('.session-folder-workspace')?.textContent).toBe('Project · 2 sessions');
    expect(page()!.querySelector('.session-project-page-progress')?.textContent).toContain('1 running');
    // And it is not in the time sections either: only the conversations are.
    expect(sessionRows().map((entry) => entry.querySelector('.session-title')?.textContent))
      .toEqual(expect.arrayContaining([COORDINATOR.title, TASK.title]));
  });

  it('counts what waits, what moves, and what landed and merged into main today', async () => {
    rows = [
      LOOSE, COORDINATOR, TASK,
      LANDING(821, 'Land · checks failed', awaiting()),
      LANDING(822, 'Land · still landing', inFlight()),
      LANDING(823, 'Land · landed today', settled('LANDED', earlierToday(60))),
      LANDING(824, 'Land · also landed today', settled('ALREADY_LANDED', earlierToday(90))),
      LANDING(825, 'Land · nothing today', settled('NOTHING_TO_LAND', earlierToday(30))),
      LANDING(826, 'Land · landed long ago', settled('LANDED', 3 * 24 * 60)),
      LANDING(827, 'Merge project → main · #8', settled('MERGED', earlierToday(20), 'PROMOTION')),
    ];
    await mount();
    await openSessions();
    expect(landingsRow()!.querySelector('.session-project-merge-row-detail')?.textContent)
      .toBe('1 waiting for a decision · 1 in flight · 2 landed · 1 merged into main today');
    expect(landingsRow()!.querySelector('.session-project-landing-mark')?.className).toContain('is-fail');
  });

  it('wears the ring while something is in flight and nothing waits, and ✓ once all settled', async () => {
    rows = [LOOSE, COORDINATOR, TASK, LANDING(822, 'Land · still landing', inFlight())];
    await mount();
    await openSessions();
    expect(landingsRow()!.querySelector('.session-project-landing-mark')?.className).toContain('is-running');
    expect(landingsRow()!.querySelector('.session-project-landing-mark svg[data-glyph="spinner"]')).not.toBeNull();
    expect(landingsRow()!.querySelector('.session-project-merge-row-detail')?.textContent).toBe('1 in flight');
    await unmount();

    rows = [LOOSE, COORDINATOR, TASK, LANDING(826, 'Land · landed long ago', settled('LANDED', 3 * 24 * 60))];
    await mount();
    await openSessions();
    expect(landingsRow()!.querySelector('.session-project-landing-mark')?.textContent).toBe('✓');
    expect(landingsRow()!.querySelector('.session-time')?.textContent).toBe('3d');
    expect(landingsRow()!.querySelector('.session-project-merge-row-detail')?.textContent).toBe('Nothing landed today');
  });

  it('draws no row for a project that has never had a landing', async () => {
    await mount();
    await openSessions();
    expect(section()).toBeNull();
    expect(mounted().textContent).not.toContain('Nothing landed today');
  });

  it('opens the project’s Landings window from the whole row', async () => {
    const landing = LANDING(820, 'Land · Build the package', awaiting());
    rows = [LOOSE, COORDINATOR, TASK, landing];
    await mount();
    await openSessions();
    await click(landingsRow(), 'the Landings row');
    expect(location).toBe(`/projects/${PROJECT_ID}/landings?project=${PROJECT_ID}`);
    await until(() => expect(mounted().querySelector('.landings-window')).not.toBeNull());
    expect(mounted().querySelector('.landings-window .landing-page-title')?.textContent).toBe('Landings');
    // The list stays on the project's sessions page beside it.
    expect(page()).not.toBeNull();
    await until(() => expect(mounted().querySelector(`[data-landing-entry="${landing.id}"]`)).not.toBeNull());
    expect(mounted().querySelector('.landings-window-now')?.textContent).toContain('Build the package');
  });

  it('opens a landing session’s own address on its window, focused on that landing', async () => {
    const landing = LANDING(828, 'Land · landed long ago', settled('LANDED', 3 * 24 * 60), { lifecycleState: 'COMPLETED' });
    rows = [LOOSE, COORDINATOR, TASK, landing];
    vi.mocked(apiModule.getSession).mockImplementation(async (id) => (id === landing.id
      ? {
        id, title: landing.title, sessionKind: 'LANDING', projectMembership: membership('TASK'),
        landing: {
          sessionId: id, projectId: PROJECT_ID, subject: 'TASK', taskId: 't-828', promotionId: null, episode: 1,
          openedAt: landing.createdAt, settledAt: (landing.landing as { settledAt: string }).settledAt,
          settledAs: 'LANDED', phase: null, round: null, checks: [], liveness: null, blockingReason: null,
          currentAttempt: null, todos: [], generations: [], timeline: { sections: [], facts: [], truncated: false },
        },
      }
      : ([...rows, ...remoteRows].find((r) => r.id === id) ?? LOOSE)) as never);
    await mount(() => expect(mounted().querySelector('.landings-window')).not.toBeNull(),
      `/sessions/${landing.id}?project=${PROJECT_ID}`);
    const entry = (): HTMLElement | null => mounted().querySelector<HTMLElement>(`[data-landing-entry="${landing.id}"]`);
    await until(() => expect(entry()?.className).toContain('is-outlined'));
    expect(entry()!.className).toContain('is-open');
    expect(entry()!.querySelector('.landings-window-reply')?.getAttribute('aria-expanded')).toBe('true');
    expect(entry()!.querySelector('.landings-window-reply strong')?.textContent).toBe('landed long ago');
    // No conversation is drawn for it: no header, no composer.
    expect(mounted().querySelector('.workspace-header')).toBeNull();
    expect(mounted().querySelector('textarea')).toBeNull();
  });
});

/**
 * The derived landing label at the bottom of a source work session (owner 2026-10-19, board v4
 * 06 e): the newest generation of the landing work this conversation fed, in the integration
 * line's words — blue while it moves, green once it landed, red where it stopped — opening the
 * landing session. A conversation that fed none draws none.
 */
describe('the source work session’s landing label', () => {
  const LANDING = pid(830);
  const source = (sourceLanding: Record<string, unknown> | null) => [
    LOOSE,
    { ...COORDINATOR, sourceLanding },
    TASK,
  ];
  const chip = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.session-source-landing-chip');
  const at = (landing: Record<string, unknown> | null) => ({
    landingSessionId: LANDING, subject: 'TASK', state: 'RUNNING', phase: 'CHECK', settledAs: null,
    targetRef: 'refs/heads/project/alpha', ...landing,
  });

  async function openSource(landing: Record<string, unknown> | null): Promise<void> {
    rows = source(landing);
    await mount(() => expect(chip() ?? mounted().querySelector('.workspace-header')).not.toBeNull(),
      `/sessions/${COORDINATOR.id}`);
  }

  it('says it is landing while it moves, and opens the landing session', async () => {
    await openSource(at({}));
    expect(chip()?.textContent).toBe('Landing · checking ›');
    // Read on a bare conversation route, so there is no list context to keep; from a project's
    // sessions page the `?project=` rides along (LandingLink).
    expect(chip()?.getAttribute('href')).toBe(`/sessions/${LANDING}`);
    expect(chip()?.className).toContain('is-run');
    // The pill wears the ring the board draws on it (06 e); the words say the same thing.
    expect(chip()?.querySelector('svg[data-glyph="spinner"]')).not.toBeNull();
  });

  it('says where it landed, and what stopped it', async () => {
    await openSource(at({ settledAs: 'LANDED' }));
    expect(chip()?.textContent).toBe('On project/alpha ✓ ›');
    expect(chip()?.className).toContain('is-landed');
    // A landed label is not "in hand": no ring.
    expect(chip()?.querySelector('svg[data-glyph="spinner"]')).toBeNull();
  });

  it('says checks failed in the failed ink, and draws nothing for no landing at all', async () => {
    await openSource(at({ state: 'CHECK_FAILED' }));
    expect(chip()?.textContent).toBe('Landing · checks failed ›');
    expect(chip()?.className).toContain('is-failed');
  });

  it('draws none on a conversation that fed no landing work', async () => {
    await openSource(null);
    expect(chip()).toBeNull();
  });
});
