// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { BootGate } from './components/BootGate';
import { encodeId } from './lib/idCodec';

/**
 * An address no route answers used to draw nothing signed in, and to send a signed-out visitor to log
 * in for a page that isn't there. It now says so, either way, with a link home. What must not move:
 * every address of the app still sends a signed-out visitor to log in and back, a dead share link
 * still says it is one, and a deployment with no users yet still sends every path to first-run setup.
 *
 * Mounted as main.tsx mounts it, BootGate around the App under the real BrowserRouter, so what is
 * checked is the address bar and what is drawn at it. The shell and the console are reduced to what
 * routes them; their own requests are not what this is about.
 */

vi.mock('./components/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => <div data-testid="shell"><Outlet /></div>,
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock('./components/WorkspaceConsole', () => ({ WorkspaceConsole: () => <p>the console</p> }));

const ID = encodeId('0195c0de-0000-7000-8000-00000000a51d');
const WORKSPACE = { id: encodeId('0195c0de-0000-7000-8000-00000000a51e'), name: 'orbit', runnerId: ID, createdAt: '2026-01-01T00:00:00Z' };
const DEAD_SHARE = 'k3Qx9vR2mT7wLpN8sYdF0aBcE1gHjKuZ';

/** Every address of the app, as a signed-out visitor might have kept one. */
const APP_ADDRESSES = [
  '/tasks', `/tasks/${ID}`, `/lists/${ID}`,
  '/settings', '/settings/profile', '/settings/account', '/settings/shared-links', '/settings/access-tokens', '/settings/terminals',
  '/admin', '/admin/sign-in', '/admin/providers',
  '/infrastructure', '/providers', '/providers/new', '/providers/new/deepseek', `/providers/${ID}`, `/providers/pools/${ID}`,
  '/following',
  '/projects', `/projects/${ID}`, `/projects/${ID}/tasks/${ID}`, `/projects/${ID}/landings`,
  '/wiki', '/wiki/review', '/wiki/s', '/wiki/s/review', '/wiki/s/activity', '/wiki/s/t/x', '/wiki/s/t/x/y', '/wiki/s/d/x',
  '/wiki/s/plan', '/wiki/s/plan/d/x', '/wiki/s/plan/d/x/y', '/wiki/s/browse', '/wiki/s/az', '/wiki/s/e/x', '/wiki/s/settings',
  '/wiki/s/run/x',
  '/runners', '/runners/register', `/runners/${ID}`, `/runners/${ID}/new`,
  `/workspaces/${ID}`, `/workspaces/${ID}/new`, `/agents/${ID}`, `/agents/${ID}/new`, `/sessions/${ID}`,
  `/workspaces/${ID}/sessions/${ID}`, `/agents/${ID}/sessions/${ID}`,
  '/enroll', '/cli-login',
];
const UNKNOWN_ADDRESSES = ['/no-such-page', '/no/such/page', `/projects/${ID}/nope`, '/settings/nope', `/runners/${ID}/nope`, '/s'];

let container: HTMLDivElement;
let root: Root | null = null;
let needsSetup = false;

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function unmount(): Promise<void> {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => mounted.unmount());
  container.remove();
}

/** Load `path`, as a page load does: the address bar says it before the app first renders. */
async function visit(path: string): Promise<void> {
  await unmount();
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <BootGate>
            <App />
          </BootGate>
        </BrowserRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const addressBar = (): string => window.location.pathname + window.location.search;
const notFound = (): boolean => container.textContent?.includes('Page not found') === true;
const homeLink = (): HTMLAnchorElement | null =>
  [...container.querySelectorAll('a')].find((link) => link.textContent === 'Go home') ?? null;
const signIn = (): void => localStorage.setItem('orbit_token', 'access-token');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  needsSetup = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const answer: [number, unknown] = url === '/api/auth/setup-status'
        ? [200, { needsSetup }]
        : url === '/api/workspaces'
          ? [200, [WORKSPACE]]
          : url === '/api/runners'
            ? [200, [{ id: ID, name: 'wikova', online: true }]]
            : url.startsWith('/api/sessions')
              ? [200, []]
              : url === '/api/providers'
                ? [200, []]
                : url === '/api/users/me'
                  ? [200, { id: 'user-1', email: 'reader@example.com', name: 'Reader', preferences: {} }]
                  : [404, { statusCode: 404, message: `Cannot GET ${url}` }];
      return new Response(JSON.stringify(answer[1]), { status: answer[0], headers: { 'content-type': 'application/json' } });
    }),
  );
  // The login form's fields read prefers-reduced-motion, and jsdom ships no matchMedia.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('an address no route answers', { timeout: 60_000 }, () => {
  it.each(UNKNOWN_ADDRESSES)('signed out, %s says so and links home, and stays where it is', async (path) => {
    await visit(path);
    expect(addressBar()).toBe(path);
    expect(notFound()).toBe(true);
    expect(homeLink()?.getAttribute('href')).toBe('/');
    expect(container.querySelector('[data-testid="shell"]')).toBeNull();
  });

  it.each(UNKNOWN_ADDRESSES)('signed in, %s says so inside the shell and links home', async (path) => {
    signIn();
    await visit(path);
    expect(addressBar()).toBe(path);
    expect(notFound()).toBe(true);
    expect(homeLink()?.getAttribute('href')).toBe('/');
    expect(container.querySelector('[data-testid="shell"]')).not.toBeNull();
  });

  it('signed in, the link goes home inside the app, to the first workspace', async () => {
    signIn();
    await visit('/no-such-page');
    await act(async () => {
      homeLink()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
    expect(addressBar()).toBe(`/workspaces/${WORKSPACE.id}`);
    expect(notFound()).toBe(false);
    expect(container.textContent).toContain('the console');
  });

  it('signed out, the link goes home too, which is the login page', async () => {
    await visit('/no-such-page');
    await act(async () => {
      homeLink()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
    await settle();
    expect(addressBar()).toBe('/login');
    expect(notFound()).toBe(false);
  });

  it('a deployment with no users yet still sends it to first-run setup', async () => {
    needsSetup = true;
    await visit('/no-such-page');
    expect(addressBar()).toBe('/setup');
    expect(notFound()).toBe(false);
  });
});

describe('what the page must not take over', { timeout: 60_000 }, () => {
  it('signed out, every address of the app still goes to log in and comes back', async () => {
    for (const path of APP_ADDRESSES) {
      await visit(path);
      expect(addressBar(), path).toBe(`/login?next=${encodeURIComponent(path)}`);
      expect(notFound(), path).toBe(false);
    }
  });

  it('signed out, the bare root still goes to the plain login page', async () => {
    await visit('/');
    expect(addressBar()).toBe('/login');
    expect(notFound()).toBe(false);
  });

  it('the guest page’s first address goes to the one address a session has, then to log in (board 11, D8)', async () => {
    await visit(`/g/${ID}`);
    expect(addressBar()).toBe(`/login?next=${encodeURIComponent(`/sessions/${ID}`)}`);
    signIn();
    await visit(`/g/${ID}`);
    expect(addressBar()).toBe(`/sessions/${ID}`);
    expect(container.textContent).toContain('the console');
  });

  it('signed out, an address’s query still rides along', async () => {
    await visit('/tasks?scope=all');
    expect(addressBar()).toBe(`/login?next=${encodeURIComponent('/tasks?scope=all')}`);
  });

  it.each([false, true])('a dead share link still says it is one (signed in: %s)', async (authed) => {
    if (authed) signIn();
    for (const path of [`/s/${DEAD_SHARE}`, `/s/${DEAD_SHARE}/c/${ID}`, `/s/${DEAD_SHARE}/t/${ID}`, `/s/${DEAD_SHARE}/d/x`]) {
      await visit(path);
      expect(addressBar(), path).toBe(path);
      expect(container.textContent, path).toContain('This shared link isn’t available');
      expect(notFound(), path).toBe(false);
    }
  });

  it('signed in, an address of the app is not called missing', async () => {
    signIn();
    for (const path of ['/', `/workspaces/${WORKSPACE.id}`, `/projects/${ID}/landings`, `/sessions/${ID}`]) {
      await visit(path);
      expect(notFound(), path).toBe(false);
      expect(container.textContent, path).toContain('the console');
    }
  });

  // The console's addresses are answered by a layout route whose children name no element of their
  // own (`element={null}` in App.tsx), because the layout draws the view from the address. React
  // Router's development build — the one the dev server and these tests run — warns about a
  // matched leaf with no element, so the routes say it deliberately. This pins the silence; the
  // test above pins that they still draw the console.
  it.each([
    `/workspaces/${WORKSPACE.id}`,
    `/workspaces/${WORKSPACE.id}/new`,
    `/agents/${ID}`,
    `/sessions/${ID}`,
    `/runners/${ID}/new`,
    `/projects/${ID}/landings`,
  ])('signed in, %s draws the console without a leaf-route warning', async (path) => {
    signIn();
    const warn = vi.spyOn(console, 'warn');
    await visit(path);
    const warnings = warn.mock.calls.map((args) => args.map(String).join(' '));
    warn.mockRestore();
    expect(warnings.filter((line) => line.includes('Matched leaf route'))).toEqual([]);
  });
});
