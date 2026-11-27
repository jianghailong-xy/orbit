// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * Documents (the Orbit Files drive) is a deployment switch, read from /auth/capabilities. Off, none of the drive's
 * routes mount — a visit lands on the not-found page — and nothing asks /api/drive. On, or with the member absent
 * (a server from before the switch), the pages are there as before.
 */

vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
const { api } = await import('./api');
const apiMock = vi.mocked(api);

vi.mock('./lib/useControlPlane', async (original) => ({
  ...(await original<typeof import('./lib/useControlPlane')>()),
  ControlPlaneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => <Outlet />,
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock('./pages/DrivePage', () => ({ DrivePage: () => <p>files page</p> }));
vi.mock('./pages/drive/StoragePage', () => ({ StorageSettingsPage: () => <p>files storage</p> }));
vi.mock('./pages/drive/StorageFilesPage', () => ({ StorageFilesPage: () => <p>files storage rows</p> }));
vi.mock('./pages/NotFoundPage', () => ({ NotFoundPage: () => <p>not found page</p> }));

let container: HTMLDivElement;
let root: Root | null = null;

function serve(capabilities: unknown) {
  apiMock.mockImplementation((async (path: string) => (path === '/auth/capabilities' ? capabilities : [])) as typeof api);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  apiMock.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function visit(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const driveCalls = () => apiMock.mock.calls.filter(([path]) => /^\/(drive|documents)/.test(String(path)));
const OFF = { managedRunners: { enabled: false }, documents: { enabled: false } };

describe('Drive switch on the routes', () => {
  it.each(['/drive', '/drive/trash', '/drive/storage', '/drive/storage/projects/abc', '/settings/storage', '/files'])(
    'off: %s is the not-found page and asks nothing of /drive',
    async (path) => {
      serve(OFF);
      await visit(path);
      expect(container.textContent).toContain('not found page');
      expect(container.textContent).not.toContain('files');
      expect(driveCalls()).toEqual([]);
    },
  );

  it('on: /documents and Storage mount', async () => {
    serve({ managedRunners: { enabled: false }, documents: { enabled: true } });
    await visit('/drive');
    expect(container.textContent).toContain('files page');
    await act(async () => window.history.pushState(null, '', '/drive/storage'));
  });

  it('absent member (a server from before the switch): on', async () => {
    serve({ managedRunners: { enabled: false } });
    await visit('/drive/storage');
    expect(container.textContent).toContain('files storage');
  });

  it('a capability that cannot be read counts as on', async () => {
    apiMock.mockImplementation((async (path: string) => {
      if (path === '/auth/capabilities') throw new Error('down');
      return [];
    }) as typeof api);
    await visit('/drive');
    // The capability read retries once before it gives up.
    await vi.waitFor(() => expect(container.textContent).toContain('files page'), { timeout: 5000 });
  });
});
