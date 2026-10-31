// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';

/**
 * Board rule 9: an online machine with no workspace has a "Set up <machine>" row, after every
 * workspace, that opens its new session page. An offline one is not listed: Machines & models already
 * counts it as needing you. The Workspaces head stands over such a row even with no workspace yet.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api } = await import('../api');
const { TasksSidePanel } = await import('./TasksSidePanel');

const AUSTIN = encodeId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const HPC = encodeId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const DOWN = encodeId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const WORKSPACE = encodeId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const PROJECT = encodeId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

const runner = (id: string, name: string, online = true, displayName: string | null = null) => ({
  id,
  name,
  displayName,
  online,
});
const orbit = { id: WORKSPACE, name: 'orbit', createdAt: '2026-09-01T00:00:00.000Z', position: 0, runnerId: HPC };

interface Reads {
  runners: unknown[];
  workspaces: unknown[] | Promise<unknown[]>;
  projects?: unknown[];
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let pathname = '';
let onNavigate: ReturnType<typeof vi.fn>;

function Where() {
  pathname = useLocation().pathname;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string, reads: Reads): Promise<void> {
  vi.mocked(api).mockImplementation((async (url: string) => {
    if (url === '/runners') return reads.runners;
    if (url === '/workspaces') return reads.workspaces;
    if (url === '/projects/sidebar') return reads.projects ?? [];
    if (url === '/sessions/counts') return [];
    if (url === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER' };
    if (url === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${url}`);
  }) as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel onNavigate={onNavigate} />
          <Where />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const rows = () =>
  [...container!.querySelectorAll('.tp-group .tp-item')].map((row) => row.querySelector('.tp-workspace-name')?.textContent);
const setUpRow = () => container!.querySelector<HTMLElement>('.tp-setup');
const head = () =>
  [...container!.querySelectorAll('.tp-group-head')].find((h) => h.querySelector('.tp-group-name')?.textContent === 'Workspaces');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onNavigate = vi.fn();
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
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  vi.mocked(api).mockReset();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('the sidebar’s Set up rows', () => {
  it('an online machine with no workspace comes after every workspace', async () => {
    await visit(`/workspaces/${WORKSPACE}`, { runners: [runner(HPC, 'hpc'), runner(AUSTIN, 'orbit@austin')], workspaces: [orbit] });
    expect(rows()).toEqual(['orbit', 'Set up orbit@austin']);
  });

  it('by the machine’s display name', async () => {
    await visit('/', { runners: [runner(AUSTIN, 'orbit@austin', true, 'Austin box')], workspaces: [] });
    expect(rows()).toEqual(['Set up Austin box']);
  });

  it('an offline machine is not listed', async () => {
    await visit(`/workspaces/${WORKSPACE}`, {
      runners: [runner(HPC, 'hpc'), runner(DOWN, 'gone', false)],
      workspaces: [orbit],
    });
    expect(rows()).toEqual(['orbit']);
    expect(setUpRow()).toBeNull();
  });

  it('a machine with a workspace has no row of its own', async () => {
    await visit(`/workspaces/${WORKSPACE}`, { runners: [runner(HPC, 'hpc')], workspaces: [orbit] });
    expect(setUpRow()).toBeNull();
  });

  it('opens its new session page, and closes the drawer it was in', async () => {
    await visit('/', { runners: [runner(AUSTIN, 'orbit@austin')], workspaces: [] });
    await act(async () => setUpRow()!.click());
    await settle();
    expect(pathname).toBe(`/runners/${AUSTIN}/new`);
    expect(onNavigate).toHaveBeenCalled();
  });

  it('is lit on that page, and no other row is', async () => {
    await visit(`/runners/${AUSTIN}/new`, {
      runners: [runner(HPC, 'hpc'), runner(AUSTIN, 'orbit@austin')],
      workspaces: [orbit],
    });
    expect(setUpRow()!.className).toContain('active');
    expect(container!.querySelectorAll('.tp-group .tp-item.active')).toHaveLength(1);
  });

  it('not lit on the machine’s own page', async () => {
    await visit(`/runners/${AUSTIN}`, { runners: [runner(AUSTIN, 'orbit@austin')], workspaces: [] });
    expect(setUpRow()!.className).not.toContain('active');
  });

  it('does not stand in for the workspace list before that list has answered', async () => {
    await visit('/', { runners: [runner(AUSTIN, 'orbit@austin')], workspaces: new Promise(() => {}) });
    expect(setUpRow()).toBeNull();
  });

  it('folds with the group', async () => {
    await visit('/', { runners: [runner(AUSTIN, 'orbit@austin')], workspaces: [] });
    await act(async () => (head() as HTMLElement).click());
    await settle();
    expect(setUpRow()).toBeNull();
  });
});

describe('the Workspaces head', () => {
  it('stands over a Set up row with no workspace yet, with nothing to count or arrange', async () => {
    await visit('/', { runners: [runner(AUSTIN, 'orbit@austin')], workspaces: [] });
    expect(head()).toBeTruthy();
    expect(head()!.querySelector('.tp-count')).toBeNull();
    expect(head()!.querySelector('.tp-group-action')).toBeNull();
  });

  it('counts workspaces only', async () => {
    await visit(`/workspaces/${WORKSPACE}`, { runners: [runner(HPC, 'hpc'), runner(AUSTIN, 'orbit@austin')], workspaces: [orbit] });
    expect(head()!.querySelector('.tp-count')?.textContent).toBe('1');
    expect(head()!.querySelector('.tp-group-action')?.textContent).toBe('Edit');
  });

  it('is not there with neither: a machine that is offline is no reason for it', async () => {
    await visit('/', { runners: [runner(DOWN, 'gone', false)], workspaces: [] });
    expect(head()).toBeUndefined();
  });

  it('Set up rows divide from the projects below as workspace rows do', async () => {
    await visit('/', {
      runners: [runner(AUSTIN, 'orbit@austin')],
      workspaces: [],
      projects: [
        {
          id: PROJECT,
          title: 'Launch',
          status: 'OPEN',
          createdAt: '2026-08-01T00:00:00.000Z',
          lastActivityAt: '2026-10-01T00:00:00.000Z',
          buckets: { running: 0 },
          attention: { ownerItems: [] },
          coordinatorActivity: null,
        },
      ],
    });
    // One under the top items, and one between the Set up rows and the projects.
    expect(container!.querySelectorAll('.tp-divider').length).toBe(2);
  });
});
