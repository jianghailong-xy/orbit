// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import type { SidebarProject } from '../lib/projectAttention';
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

const WORKSPACES = [
  { id: A, name: 'alpha', createdAt: '2026-09-01T00:00:00.000Z', position: 0, runnerId: RUNNER },
  { id: B, name: 'bravo', createdAt: '2026-09-02T00:00:00.000Z', position: 1, runnerId: RUNNER },
];

const OPEN_PROJECTS: SidebarProject[] = [{
  id: PROJECT,
  title: 'DeepSeek Harness',
  status: 'OPEN',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActivityAt: '2026-10-05T00:00:00.000Z',
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

function serve() {
  vi.mocked(api).mockImplementation((async (path: string) => {
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

describe('the sidebar’s rows as destinations', () => {
  it('opens a project’s sessions page over the workspace showing, and lights the project instead of it', async () => {
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

  it('keeps the project lit on a member’s conversation opened from its page', async () => {
    serve();
    await visit(`/sessions/${MEMBER}?project=${PROJECT}`);
    expect(projectRow().classList.contains('active')).toBe(true);
    expect(litWorkspaces()).toEqual([]);
  });

  it('leaves a project’s sessions page for the workspace’s list when that workspace is clicked', async () => {
    serve();
    await visit(`/workspaces/${B}?project=${PROJECT}`);
    await click(workspaceRow('bravo'));
    expect(location).toBe(`/workspaces/${B}`);
    expect(litWorkspaces()).toEqual(['bravo']);
    expect(projectRow().classList.contains('active')).toBe(false);
  });

  it.each([
    ['a workspace', `/workspaces/${B}`, () => workspaceRow('bravo')],
    ['a project’s sessions page', `/workspaces/${B}?project=${PROJECT}`, projectRow],
    ['a section', '/tasks', () => topEntry('Tasks')],
  ])('goes nowhere when the lit row of %s is clicked, and still says it was clicked', async (_, path, row) => {
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
