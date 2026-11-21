// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

/**
 * Storage moved into Files (docs/mocks/orbit-files, board choice a): /settings/storage, and the address of one of its
 * rows' files, lead to Files → Storage, with the address bar left at the new address.
 */

vi.mock('./api', async (original) => ({ ...(await original<typeof import('./api')>()), api: vi.fn() }));
const { api } = await import('./api');
const apiMock = vi.mocked(api);

// Settings' window without its live updates.
vi.mock('./lib/useControlPlane', async (original) => ({
  ...(await original<typeof import('./lib/useControlPlane')>()),
  ControlPlaneProvider: ({ children }: { children: ReactNode }) => children,
}));
// The routed page alone: the real shell would need every query it polls answered first.
vi.mock('./components/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => <Outlet />,
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock('./pages/files/StoragePage', () => ({ StorageSettingsPage: () => <p>files storage</p> }));
vi.mock('./pages/files/StorageFilesPage', () => ({ StorageFilesPage: () => <p>files storage rows</p> }));

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token'); // signed in
  apiMock.mockImplementation((async () => []) as typeof api);
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

const addressBar = (): string => window.location.pathname + window.location.search + window.location.hash;

describe('the Storage addresses', () => {
  it('/settings/storage leads to Files → Storage', async () => {
    await visit('/settings/storage');
    expect(addressBar()).toBe('/files/storage');
    expect(container.textContent).toContain('files storage');
  });

  it('/settings/storage/projects/:id leads to the same rows under Files', async () => {
    await visit('/settings/storage/projects/abc');
    expect(addressBar()).toBe('/files/storage/projects/abc');
    expect(container.textContent).toContain('files storage rows');
  });
});
