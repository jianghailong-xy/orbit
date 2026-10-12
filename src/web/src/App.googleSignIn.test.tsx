// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { BootGate } from './components/BootGate';

/**
 * `orbit register`'s approval page, opened signed out, through Google and back
 * (docs/google-sign-in-design.md §8.1): /enroll?code= sends the visitor to log in with itself as
 * `next`; the login page leaves for Google keeping that `next` in the tab; Google's answer comes
 * back to /login with a ticket; the exchange signs in and the page goes on to /enroll?code=, code
 * and all.
 *
 * Mounted as main.tsx mounts it — BootGate around the App, under the real BrowserRouter on jsdom's
 * own history — so the routes and BootGate's bypass list are the real ones: /login needs no new
 * route, and no splash holds it. jsdom implements no navigation, so `location` is swapped for a
 * stand-in that records where the page sends the browser, and each page load — Google's return,
 * the signed-in reload — is replayed by mounting the app again at that address, in the same tab.
 */

// The approval page itself reads the request its code names; only which page it is, and the code
// it was opened with, matter here.
vi.mock('./pages/EnrollPage', () => ({
  EnrollPage: () => <p>{`Approve runner ${new URLSearchParams(window.location.search).get('code')}`}</p>,
}));

const APPROVAL = '/enroll?code=WXYZ4-8K2QP';
const SESSION = { accessToken: 'access-token', refreshToken: 'refresh-token', user: { id: 'u1' } };

let container: HTMLDivElement;
let root: Root | null = null;
let requests: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); // signed out
  sessionStorage.clear();
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({
        url,
        method: init.method ?? 'GET',
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const body =
        url === '/api/auth/methods'
          ? { password: true, google: true, googleSignup: false }
          : url === '/api/auth/google/exchange'
            ? SESSION
            : null;
      return body === null
        ? new Response(JSON.stringify({ statusCode: 404, message: `Cannot GET ${url}` }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

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

async function settle(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await settle(1);
  expect(done(), what).toBe(true);
}

const addressBar = (): string => window.location.pathname + window.location.search;

function recordNavigation(): { assigned: string[]; href: string[] } {
  const real = window.location;
  const sent = { assigned: [] as string[], href: [] as string[] };
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        if (key === 'assign') return (url: string | URL) => sent.assigned.push(String(url));
        const value: unknown = Reflect.get(real, key, real);
        return typeof value === 'function' ? value.bind(real) : value;
      },
      set: (_, key, value) => {
        if (key !== 'href') return Reflect.set(real, key, value, real);
        sent.href.push(String(value));
        return true;
      },
    }),
  );
  return sent;
}

describe('a signed-out visitor approving a runner, with Google', () => {
  it('signs in with Google and comes back to /enroll?code=, code and all', async () => {
    // Opened signed out: sent to log in, with the approval page as next.
    await visit(APPROVAL);
    expect(addressBar()).toBe(`/login?next=${encodeURIComponent(APPROVAL)}`);

    // Leaves for Google with the approval page kept in this tab.
    const sent = recordNavigation();
    const google = [...container.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === 'Continue with Google',
    );
    expect(google, 'the Continue with Google button').toBeTruthy();
    await act(async () => google!.click());
    await until(() => sent.assigned.length > 0, 'the browser sent on to Google');
    const start = new URL(sent.assigned[0], window.location.origin);
    expect(start.pathname).toBe('/api/auth/google/start');
    expect(start.searchParams.get('client')).toBe('web');
    const challenge = start.searchParams.get('code_challenge');
    expect(JSON.parse(sessionStorage.getItem('orbit_google_sign_in')!)).toMatchObject({ next: APPROVAL });

    // Google sends the browser back to the login page with a ticket — a new page load, same tab.
    await visit('/login?google_ticket=TICKET');
    await until(() => sent.href.length > 0, 'the signed-in page sent on');
    const exchange = requests.find((request) => request.url === '/api/auth/google/exchange');
    const { codeVerifier } = exchange!.body as { ticket: string; codeVerifier: string };
    expect(exchange!.body).toEqual({ ticket: 'TICKET', codeVerifier });
    // The verifier shown is the one the challenge sent to /start was made from.
    expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(challenge);
    expect(localStorage.getItem('orbit_token')).toBe(SESSION.accessToken);
    expect(sent.href).toEqual([APPROVAL]);

    // The reload that sends it on, replayed: signed in, the approval page itself, code and all.
    await visit(sent.href[0]);
    expect(addressBar()).toBe(APPROVAL);
    expect(container.textContent).toBe('Approve runner WXYZ4-8K2QP');

    // /login and /enroll are BootGate's bypass routes: nothing held the pages behind the splash's
    // setup check, and the whole trip asked the server for nothing else.
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/auth/methods',
      'GET /api/auth/methods',
      'POST /api/auth/google/exchange',
    ]);
  });
});
