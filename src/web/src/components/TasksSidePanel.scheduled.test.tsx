// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIST_ROWS } from '../test/scheduleFixtures';
import { TasksSidePanel } from './TasksSidePanel';

/**
 * Scheduled in the left navigation (docs/mocks/scheduled-tasks/web/01-board.png ①): after Tasks, with the count of
 * what needs the owner — the failing and the held schedules — and nowhere else in the sidebar.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  fetchAvatarDataUrl: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api, getSession } = await import('../api');

const WORKSPACE = { id: 'ws-apiserver', name: 'apiserver', runnerId: null, createdAt: '2025-11-01T00:00:00.000Z' };

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let pathname = '';

function RouterProbe() {
  pathname = useLocation().pathname;
  return null;
}

function serve(schedules = LIST_ROWS) {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/schedules') return { schedules };
    if (path === '/projects/sidebar') return [];
    if (path === '/runners') return [];
    if (path === '/workspaces') return [WORKSPACE];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role: 'USER', avatarUpdatedAt: null };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <TasksSidePanel />
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}

const entry = () => [...container!.querySelectorAll<HTMLElement>('.tp-section .tp-item')]
  .find((item) => item.querySelector('.tp-label')?.textContent === 'Scheduled')!;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.mocked(api).mockReset();
  vi.mocked(getSession).mockReset();
});

describe('the sidebar’s Scheduled entry', () => {
  it('sits right after Tasks, with the failing and held count', async () => {
    serve();
    await visit('/projects');
    const labels = [...container!.querySelectorAll('.tp-section .tp-item .tp-label')].map((l) => l.textContent);
    expect(labels.indexOf('Scheduled')).toBe(labels.indexOf('Tasks') + 1);
    expect(entry().querySelector('[data-scheduled-count]')!.textContent).toBe('2');
  });

  it('shows no count when nothing needs the owner', async () => {
    serve(LIST_ROWS.filter((s) => s.state !== 'HELD' && s.consecutiveFailures === 0));
    await visit('/projects');
    expect(entry().querySelector('[data-scheduled-count]')).toBeNull();
  });

  it('opens the Scheduled page and is lit there', async () => {
    serve();
    await visit('/projects');
    await act(async () => { entry().click(); });
    expect(pathname).toBe('/scheduled');
    expect(entry().classList).toContain('active');
  });

  it('leaves a scheduled run’s session to its workspace’s row, as any session', async () => {
    serve();
    vi.mocked(getSession).mockResolvedValue({
      id: 'sess-run', title: 'Codex stable check', runSource: 'SCHEDULE', scheduleRunId: 'run-1', workspace: { id: WORKSPACE.id, name: WORKSPACE.name },
    } as never);
    await visit('/sessions/sess-run');
    expect(entry().classList).not.toContain('active');
    expect(container!.querySelector('.tp-group-workspaces .tp-item.active')!.textContent).toContain('apiserver');
  });

  it('leaves an ordinary session to its workspace’s row', async () => {
    serve();
    vi.mocked(getSession).mockResolvedValue({
      id: 'sess-plain', title: 'Fix login', runSource: 'MANUAL', workspace: { id: WORKSPACE.id, name: WORKSPACE.name },
    } as never);
    await visit('/sessions/sess-plain');
    expect(entry().classList).not.toContain('active');
    expect(container!.querySelector('.tp-group-workspaces .tp-item.active')!.textContent).toContain('apiserver');
  });

  it('adds nothing to a workspace’s rows', async () => {
    serve();
    await visit('/projects');
    const workspaceRows = [...container!.querySelectorAll('.tp-group-workspaces .tp-item')].map((r) => r.textContent ?? '');
    expect(workspaceRows.length).toBeGreaterThan(0);
    expect(workspaceRows.some((text) => /Scheduled|Nightly|Codex stable/.test(text))).toBe(false);
  });
});
