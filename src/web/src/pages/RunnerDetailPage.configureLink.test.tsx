// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * Where a sidebar Workspace row's Configure lands (docs/mocks/workspace-delete-web ⑧):
 * /runners/:id?workspace=<id> opens that workspace's editor on its row, brings the row into view, and
 * drops the parameter, so a reload or Back does not open the editor again.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// Public ids, the spelling the web holds every id in (= uuidToBase62 of a v7 uuid).
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const ORBIT = '33zx0JhRhJo8rd25d3qAN';
const SITE = '33zx0JhRhJo8rd25d3qAP';

const RUNNER: Runner = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
};
const workspace = (id: string, name: string, runnerId = RUNNER_ID) => ({
  id,
  name,
  runnerId,
  workDir: `/root/${name}`,
  enableWorktree: true,
  lastProvider: 'claude',
  createdAt: '2026-09-23T08:00:00.000Z',
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let location = '';
let scrolledTo: Element[] = [];

function RouterProbe() {
  const loc = useLocation();
  location = `${loc.pathname}${loc.search}`;
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  // jsdom has no scrolling; record where the page asked to go.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this);
  };
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  scrolledTo = [];
  document.body.innerHTML = '';
});

async function mount(path: string, workspaces = [workspace(ORBIT, 'orbit'), workspace(SITE, 'site')]) {
  apiMock.mockImplementation(async (url: string) => {
    if (url === '/runners') return [RUNNER];
    if (url === '/workspaces') return workspaces;
    if (url === '/sessions/counts') return [];
    if (url.includes('permission-rules')) return [];
    if (url.includes('imported')) return { count: 0 };
    return [];
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/runners/:id" element={<RunnerDetailPage />} />
          </Routes>
          <RouterProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

const editing = () =>
  [...document.body.querySelectorAll('.rd-workspace-editing .rd-workspace-name')].map((el) => el.textContent?.trim());

describe('a runner’s page opened on one of its workspaces', () => {
  it('opens that workspace’s editor, brings its row into view, and drops the parameter', async () => {
    await mount(`/runners/${RUNNER_ID}?workspace=${SITE}`);
    expect(editing()).toEqual(['site']);
    expect(document.body.querySelector('.rd-workspace-form')).not.toBeNull();
    expect(scrolledTo).toEqual([document.body.querySelector(`[data-workspace-id="${SITE}"]`)]);
    expect(location).toBe(`/runners/${RUNNER_ID}`);
  });

  it('opens nothing for a workspace that is not on this machine', async () => {
    const elsewhere = '33zx0JhRhJo8rd25d3qAQ';
    await mount(`/runners/${RUNNER_ID}?workspace=${elsewhere}`, [
      workspace(ORBIT, 'orbit'),
      workspace(elsewhere, 'mac', '33zx0JhRhJo8rd25d3qAR'),
    ]);
    expect(editing()).toEqual([]);
    expect(document.body.querySelector('.rd-workspace-form')).toBeNull();
    expect(scrolledTo).toEqual([]);
  });

  it('opens nothing without the parameter', async () => {
    await mount(`/runners/${RUNNER_ID}`);
    expect(editing()).toEqual([]);
    expect(scrolledTo).toEqual([]);
  });
});
