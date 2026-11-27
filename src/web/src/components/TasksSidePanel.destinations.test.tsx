// @vitest-environment jsdom
import { act } from 'react';
import { conversationProjectPage, setConversationProjectPage } from '../lib/conversationProjectPage';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { SidebarProject } from '../lib/projectAttention';
import { MOBILE_QUERY } from '../lib/useMediaQuery';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * Every sidebar row is a destination, as on the iPhone drawer: a section, a workspace's session list,
 * or a project's sessions page (the console with `?project=`). A row is lit while the screen belongs
 * to it, a click on the lit row goes nowhere, and any other click lands on its destination — the
 * owner's report: from a project's sessions page, the workspace's row must leave the page.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api, getSession } = await import('../api');

const A = encodeId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const B = encodeId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const RUNNER = encodeId('0000000f-0000-4000-8000-00000000000f');
const MEMBER = encodeId('0000000a-0000-4000-8000-00000000000a');
const PROJECT = encodeId('0196a000-0000-7000-8000-000000000002');
const KEY = encodeId('0196a000-0000-7000-8000-0000000000c1');
const POOL = encodeId('0196a000-0000-7000-8000-0000000000c2');

const WORKSPACES = [
  { id: A, name: 'alpha', createdAt: '2026-09-01T00:00:00.000Z', position: 0, runnerId: RUNNER },
  { id: B, name: 'bravo', createdAt: '2026-09-02T00:00:00.000Z', position: 1, runnerId: RUNNER },
];

const OPEN_PROJECTS: SidebarProject[] = [{
  id: PROJECT,
  title: 'DeepSeek Harness',
  status: 'OPEN',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  buckets: { running: 0 },
  attention: { ownerItems: [] },
  coordinatorActivity: null,
}];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let location = '';
let navigations = 0;

function RouterProbe() {
  const loc = useLocation();
  location = `${loc.pathname}${loc.search}`;
  return null;
}

// What /auth/capabilities answers: the Documents switch (ORBIT_DRIVE_ENABLED).
let capabilities: unknown = { managedRunners: { enabled: false }, documents: { enabled: true } };

function serve() {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/auth/capabilities') return capabilities;
    if (path === '/runners') return [{ id: RUNNER, name: 'wikova', online: true }];
    if (path === '/workspaces') return WORKSPACES;
    if (path === '/projects/sidebar') return OPEN_PROJECTS;
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
  vi.mocked(getSession).mockImplementation(((id: string) =>
    id === MEMBER ? Promise.resolve({ id: MEMBER, workspace: { id: B } }) : new Promise(() => {})) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string, onNavigate?: () => void): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel onNavigate={onNavigate} />
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const workspaceRow = (name: string) =>
  [...container!.querySelectorAll<HTMLElement>('.tp-workspace-name')]
    .find((label) => label.textContent === name)!.closest<HTMLElement>('.tp-item')!;
const projectRow = () => container!.querySelector<HTMLElement>('.tp-group .tp-project')!;
const litWorkspaces = () =>
  [...container!.querySelectorAll<HTMLElement>('.tp-workspace-name')]
    .filter((label) => label.closest('.tp-item')!.classList.contains('active'))
    .map((label) => label.textContent);
const topEntry = (label: string) =>
  [...container!.querySelectorAll<HTMLElement>('.tp-section .tp-item')]
    .find((item) => item.querySelector('.tp-label')?.textContent === label)!;

async function click(element: HTMLElement): Promise<void> {
  const before = location;
  await act(async () => element.click());
  await settle();
  if (location !== before) navigations += 1;
}

// A project's page open beside the conversation: the console's, not the conversation's address.
const openBeside = (): void => setConversationProjectPage({ project: PROJECT, completed: false });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
  navigations = 0;
  setConversationProjectPage(null);
  capabilities = { managedRunners: { enabled: false }, documents: { enabled: true } };
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
});

const phone = () => vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query === MOBILE_QUERY, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: () => false,
}));

describe('the Drive row and the Drive switch', () => {
  const labels = () => [...container!.querySelectorAll('.tp-section .tp-item .tp-label')].map((el) => el.textContent);
  const driveCalls = () => vi.mocked(api).mock.calls.filter(([path]) => /^\/(drive|documents)/.test(String(path)));

  it('is there when Drive is on', async () => {
    serve();
    await visit('/tasks');
    expect(labels()).toContain('Drive');
  });

  it('is there when the server omits the member', async () => {
    capabilities = { managedRunners: { enabled: false } };
    serve();
    await visit('/tasks');
    expect(labels()).toContain('Drive');
  });

  it('is gone, and nothing asks /drive, when Drive is off', async () => {
    capabilities = { managedRunners: { enabled: false }, documents: { enabled: false } };
    serve();
    await visit('/tasks');
    expect(labels()).not.toContain('Drive');
    expect(labels()).toContain('Tasks');
    expect(driveCalls()).toEqual([]);
  });
});

describe('the sidebar’s rows as destinations', () => {
  it('opens a project’s sessions page over the workspace showing on a phone, and lights the project instead of it', async () => {
    phone();
    serve();
    await visit(`/workspaces/${B}`);
    expect(litWorkspaces()).toEqual(['bravo']);

    await click(projectRow());
    expect(location).toBe(`/workspaces/${B}?project=${PROJECT}`);
    expect(projectRow().classList.contains('active')).toBe(true);
    expect(litWorkspaces()).toEqual([]);
  });

  it('opens it over the first workspace when none is showing', async () => {
    serve();
    await visit('/tasks');
    await click(projectRow());
    expect(location).toBe(`/workspaces/${A}?project=${PROJECT}`);
  });

  // As the iPad's sidebar has it: beside an open conversation only the list column changes.
  it('opens a project beside the conversation showing on a wide screen, so the conversation stays', async () => {
    serve();
    await visit(`/sessions/${MEMBER}`);
    await click(projectRow());
    expect(location).toBe(`/sessions/${MEMBER}`);
    expect(conversationProjectPage()?.project).toBe(PROJECT);
  });

  // Owner's report (2026-11-16): from a session shared with you, a project's row did nothing — the guest view
  // draws no project column, so `?project=` beside it changed nothing on screen.
  it('opens the project’s page from a session shared with you, which has no column to open beside', async () => {
    serve();
    const GUEST = encodeId('0000000b-0000-4000-8000-00000000000b');
    vi.mocked(getSession).mockImplementation(((id: string) =>
      id === GUEST ? Promise.reject(new Error('not found')) : new Promise(() => {})) as never);
    await visit(`/sessions/${GUEST}`);
    await click(projectRow());
    expect(location).toBe(`/workspaces/${A}?project=${PROJECT}`);
  });

  it('opens it too from a shared session whose address already carries the project', async () => {
    serve();
    const GUEST = encodeId('0000000b-0000-4000-8000-00000000000b');
    vi.mocked(getSession).mockImplementation(((id: string) =>
      id === GUEST ? Promise.reject(new Error('not found')) : new Promise(() => {})) as never);
    openBeside();
    await visit(`/sessions/${GUEST}`);
    await click(projectRow());
    expect(location).toBe(`/workspaces/${A}?project=${PROJECT}`);
  });

  // Wider than a phone the project's page is a column beside the conversation, and the list beside the
  // sidebar stays the workspace's, so the workspace's row stays lit — on a refresh too (owner 2026-11-14).
  it('keeps the workspace lit, not the project, while a wide screen shows the project’s column', async () => {
    serve();
    await visit(`/sessions/${MEMBER}`);
    await click(projectRow());
    expect(location).toBe(`/sessions/${MEMBER}`);
    expect(conversationProjectPage()?.project).toBe(PROJECT);
    expect(projectRow().classList.contains('active')).toBe(false);
    expect(litWorkspaces()).toEqual(['bravo']);
  });

  it('lights the workspace, not the project, when a wide screen loads with the project’s column open', async () => {
    serve();
    openBeside();
    await visit(`/sessions/${MEMBER}`);
    expect(projectRow().classList.contains('active')).toBe(false);
    expect(litWorkspaces()).toEqual(['bravo']);
  });

  it('goes nowhere when a wide screen’s project row is clicked while its column is open', async () => {
    serve();
    const onNavigate = vi.fn();
    openBeside();
    await visit(`/sessions/${MEMBER}`, onNavigate);
    await click(projectRow());
    expect(location).toBe(`/sessions/${MEMBER}`);
    expect(navigations).toBe(0);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('opens the project’s page on a phone, which shows one pane, even from a conversation', async () => {
    phone();
    serve();
    await visit(`/sessions/${MEMBER}`);
    await click(projectRow());
    expect(location).toBe(`/workspaces/${B}?project=${PROJECT}`);
  });

  it('keeps the project lit on a phone on a member’s conversation opened from its page', async () => {
    phone();
    serve();
    openBeside();
    await visit(`/sessions/${MEMBER}`);
    expect(projectRow().classList.contains('active')).toBe(true);
    expect(litWorkspaces()).toEqual([]);
  });

  it('leaves a project’s sessions page on a phone for the workspace’s list when that workspace is clicked', async () => {
    phone();
    serve();
    await visit(`/workspaces/${B}?project=${PROJECT}`);
    await click(workspaceRow('bravo'));
    expect(location).toBe(`/workspaces/${B}`);
    expect(litWorkspaces()).toEqual(['bravo']);
    expect(projectRow().classList.contains('active')).toBe(false);
  });

  it.each([
    ['a workspace', `/workspaces/${B}`, () => workspaceRow('bravo'), false],
    ['a project’s sessions page on a phone', `/workspaces/${B}?project=${PROJECT}`, projectRow, true],
    ['a section', '/tasks', () => topEntry('Tasks'), false],
  ])('goes nowhere when the lit row of %s is clicked, and still says it was clicked', async (_, path, row, onPhone) => {
    if (onPhone) phone();
    serve();
    const onNavigate = vi.fn();
    await visit(path, onNavigate);
    expect(row().classList.contains('active')).toBe(true);
    await click(row());
    expect(location).toBe(path);
    expect(navigations).toBe(0);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('Machines & models, which has no sidebar row (docs/mocks/machines-and-models, 02)', () => {
  const litTopEntries = () =>
    [...container!.querySelectorAll<HTMLElement>('.tp-section .tp-item.active .tp-label')].map((label) => label.textContent);
  const litRailEntries = () =>
    [...container!.querySelectorAll<HTMLElement>('.tp-rail-item.active')].map((item) => item.getAttribute('aria-label'));

  it('is none of the fixed rows, which are the work, as on the iPhone drawer', async () => {
    serve();
    await visit('/tasks');
    const labels = [...container!.querySelectorAll('.tp-section .tp-label')].map((label) => label.textContent);
    expect(labels).toEqual(['Projects', 'Tasks', 'Scheduled', 'Wiki', 'Drive']);
  });

  it.each([
    '/infrastructure',
    '/infrastructure?runner=x&engine=codex',
    '/runners',
    `/runners/${RUNNER}`,
    '/runners/register',
    '/providers',
    '/providers/new',
    '/providers/new/anthropic',
    `/providers/${KEY}`,
    `/providers/pools/${POOL}`,
  ])('lights no row, in either form, on %s — as Settings lights none', async (path) => {
    serve();
    await visit(path);
    expect(litTopEntries()).toEqual([]);
    expect(litRailEntries()).toEqual([]);
  });
});

// Documents (docs/mocks/drive/02-web, frame 1): the row directly under the Wiki, with no count and no shortcut.
describe('Files, the row under the Wiki', () => {
  const litTopEntries = () =>
    [...container!.querySelectorAll<HTMLElement>('.tp-section .tp-item.active .tp-label')].map((label) => label.textContent);
  const litRailEntries = () =>
    [...container!.querySelectorAll<HTMLElement>('.tp-rail-item.active')].map((item) => item.getAttribute('aria-label'));

  it('sits directly under the Wiki, with neither a count nor a shortcut', async () => {
    serve();
    await visit('/tasks');
    const labels = [...container!.querySelectorAll('.tp-section .tp-label')].map((label) => label.textContent);
    expect(labels.indexOf('Drive')).toBe(labels.indexOf('Wiki') + 1);
    expect(topEntry('Drive').querySelector('.tp-count')).toBeNull();
    expect(topEntry('Drive').querySelector('.sidebar-nav-icon-files')).not.toBeNull();
  });

  it('opens the Files page', async () => {
    serve();
    await visit('/tasks');
    await click(topEntry('Drive'));
    expect(location).toBe('/drive');
    expect(litTopEntries()).toEqual(['Drive']);
  });

  it.each(['/drive', '/drive?folder=x&file=y', '/drive/trash'])('lights Files, in either form, on %s', async (path) => {
    serve();
    await visit(path);
    expect(litTopEntries()).toEqual(['Drive']);
    expect(litRailEntries()).toEqual(['Drive']);
  });
});
