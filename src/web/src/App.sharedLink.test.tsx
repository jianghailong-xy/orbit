// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveSessionFilingState,
  deriveSessionLifecycleState,
  deriveSessionRunState,
  deriveSessionState,
} from '@orbit/shared';
import { App } from './App';
import { api, getRefreshToken, getToken, type SharedSession } from './api';
import { BootGate } from './components/BootGate';
import { ThemeProvider } from './lib/theme';

/**
 * A shared link (`/s/<token>`) opened in a browser that still holds a session the server no longer
 * takes. With a token stored, the theme reads the account (GET /users/me) on every page, public ones
 * included; here that read answers 401, so does the refresh it tries, and authedFetch lets the
 * session go. A share page is public, so its reader stays on the link and reads what it shares
 * instead of being sent to log in — as on the privacy policy, and unlike any page of the app itself.
 *
 * Mounted as main.tsx mounts it — the theme, BootGate around the App, under the real BrowserRouter on
 * jsdom's own history — so the routes, BootGate's bypass and the theme's read are the real ones.
 * jsdom implements no navigation, so `location` is swapped for a stand-in that records where the app
 * sends the browser.
 */

const TOKEN = 'k3Qx9vR2mT7wLpN8sYdF0aBcE1gHjKuZ';
const SHARE = `/api/shared/${TOKEN}`;

const TITLE = 'Keep a shared link open over a dead session';
/** The shared transcript's one message. */
const REPLY = 'The share page keeps its reader when the stored session has died.';

/** A finished session as GET /shared/:token answers for it: its header, its state as the share
 *  derives it (sessions.service.ts `getShared` → `withSessionState`), and a transcript one page long. */
function sharedSession(): SharedSession {
  const state = {
    status: 'SUCCEEDED',
    endReason: 'task_done',
    completedAt: '2026-10-25T17:20:00.000Z',
    archivedAt: '2026-10-25T17:20:00.000Z',
    deletedAt: null,
  };
  return {
    kind: 'SESSION',
    title: TITLE,
    workspaceName: 'orbit',
    status: state.status,
    runStatus: state.status,
    sessionState: deriveSessionState(state),
    runState: deriveSessionRunState(state),
    lifecycleState: deriveSessionLifecycleState(state),
    filingState: deriveSessionFilingState(state),
    createdAt: '2026-10-25T17:00:00.000Z',
    events: [{ seq: 1, type: 'assistant', payload: { text: REPLY }, turnId: 'turn-1', ts: '2026-10-25T17:10:00.000Z' }],
    hasMore: false,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let requests: string[] = [];
let sentTo: string[] = [];

/** Store a session the server no longer takes: its account read and its refresh both answer 401. */
function storeDeadSession(): void {
  localStorage.setItem('orbit_token', 'expired-access-token');
  localStorage.setItem('orbit_refresh', 'revoked-refresh-token');
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      const answer: [number, unknown] =
        url === SHARE || url.startsWith(`${SHARE}?`)
          ? [200, sharedSession()]
          : url === '/api/users/me' || url === '/api/auth/refresh'
            ? [401, { statusCode: 401, message: 'Unauthorized' }]
            : [404, { statusCode: 404, message: `Cannot GET ${url}` }];
      return new Response(JSON.stringify(answer[1]), {
        status: answer[0],
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  // The theme follows the system's, and jsdom ships no matchMedia.
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
  sentTo = [];
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        const value: unknown = Reflect.get(real, key, real);
        return typeof value === 'function' ? value.bind(real) : value;
      },
      set: (_, key, value) => {
        if (key !== 'href') return Reflect.set(real, key, value, real);
        sentTo.push(String(value));
        return true;
      },
    }),
  );
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

/** Load `path`, as a page load does: the address bar says it before the app first renders. */
async function visit(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <BrowserRouter>
            <BootGate>
              <App />
            </BootGate>
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  // Long enough for the account read, its refresh and the link's own read to answer and land.
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const addressBar = (): string => window.location.pathname + window.location.search;

describe('a shared link opened over a dead session', () => {
  it('stays on the link, lets the session go, and shows what the link shares', async () => {
    storeDeadSession();
    await visit(`/s/${TOKEN}`);

    // The theme's read of the account, and the refresh it tried: both refused.
    expect(requests.filter((url) => !url.startsWith(SHARE))).toEqual(['/api/users/me', '/api/auth/refresh']);
    expect(sentTo, 'sent to log in').toEqual([]);
    expect(addressBar()).toBe(`/s/${TOKEN}`);
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    // The link's own read, and what it answered drawn.
    expect(requests).toContain(`${SHARE}?limit=200&maxPayload=2048`);
    expect(container.querySelector('input[type="password"]'), 'a login form').toBeNull();
    expect(container.textContent).toContain(TITLE);
    expect(container.textContent).toContain(REPLY);
  });
});

describe('where a 401 that no refresh mends sends the browser', () => {
  it.each([
    { page: `/s/${TOKEN}`, sends: [] },
    { page: `/s/${TOKEN}/c/34m9yEdoU7H4J1nkU9Lwt`, sends: [] },
    { page: `/s/${TOKEN}/t/34m9yEdoU7H4J1nkU9Lwt`, sends: [] },
    { page: `/s/${TOKEN}/d/getting-started`, sends: [] },
    { page: '/privacy', sends: [] },
    { page: '/login', sends: [] },
    { page: '/', sends: ['/login'] },
    { page: '/tasks', sends: ['/login'] },
    { page: '/settings', sends: ['/login'] },
    { page: '/sessions/34m9yEdoU7H4J1nkU9Lwt', sends: ['/login'] },
  ])('from $page: $sends, with the session let go', async ({ page, sends }) => {
    window.history.replaceState(null, '', page);
    storeDeadSession();

    await expect(api('/users/me')).rejects.toMatchObject({ status: 401 });

    expect(requests).toEqual(['/api/users/me', '/api/auth/refresh']);
    expect(sentTo).toEqual(sends);
    expect(getToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });
});
