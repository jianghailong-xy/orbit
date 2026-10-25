// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { BootGate } from './components/BootGate';
import { ThemeProvider } from './lib/theme';

/**
 * The privacy policy at /privacy, the page Google's consent screen links to: it opens for anyone,
 * signed out or in, says what the owner wrote and nothing else, and the login page links to it.
 *
 * Mounted as main.tsx mounts it — the theme (which reads a signed-in account), BootGate around the
 * App, under the real BrowserRouter on jsdom's own history — so the routes and BootGate's bypass list
 * are the real ones. The server here says the deployment still needs its first-run setup, the one
 * answer that sends a signed-out visitor on any other page to /setup, and every request the app makes
 * is recorded. jsdom implements no navigation, so `location` is swapped for a stand-in that records
 * where the app sends the browser.
 */

/** The policy as task 34m9C57GuL4J9Won60lPO gives it, character for character. */
const POLICY = `Privacy Policy

Last updated: October 25, 2026

Orbit is a service for running and managing AI coding agents. This policy explains what personal data we collect, why we collect it, and the choices you have.

What we collect
- Account details: your email address and, if you sign in with Google, the name, email address and profile picture Google shares with us. If you sign in with a password, we store only a password hash.
- Your content: workspaces, sessions, tasks, messages and files you create or upload.
- Technical data: IP address, browser and device type, and the logs we need to run and secure the service.
- Session data: access and refresh tokens. Refresh tokens are stored hashed; credentials for external model providers are stored encrypted.

How we use it
To provide the service, sign you in, keep your workspaces private to your account, send service notices, prevent abuse, and fix problems.

Sharing
We do not sell personal data. We share data only with providers needed to run the service: the AI model engines you connect, and Google when you choose to sign in with Google. Google sign-in requests only your basic profile and email address; we never receive your Google password.

Cookies and local storage
We use cookies and local storage to keep you signed in and to remember interface settings. We do not use advertising cookies.

Retention and deletion
We keep your data while your account is active. You can delete content in the product. Deleting your account removes its data, except records we must keep by law and backups kept for a limited period.

Your choices
You can ask for a copy of your data, correct it, or delete your account by writing to privacy@orbitd.io. If you signed in with Google, you can also revoke Orbit's access from your Google Account page.

Changes
We may update this policy. The date above is the latest revision; material changes will be announced on this page.

Contact
privacy@orbitd.io`;

/** One heading, paragraph or bullet per line, in order: the policy's own lines, blank ones aside. */
const LINES = POLICY.split('\n').filter((line) => line !== '');

let container: HTMLDivElement;
let root: Root | null = null;
let requests: string[] = [];
let sentTo: string[] = [];
/** Whether the stored session still signs in: no, and the account read and the refresh answer 401. */
let sessionAlive = true;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); // signed out
  requests = [];
  sessionAlive = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      const answer: [number, unknown] =
        url === '/api/auth/setup-status'
          ? [200, { needsSetup: true }]
          : url === '/api/auth/methods'
            ? [200, { password: true, google: false, googleSignup: false }]
            : url === '/api/users/me' && sessionAlive
              ? [200, { id: 'u1', email: 'ada@example.com', name: 'Ada', createdAt: '', preferences: {} }]
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
  await unmount();
  vi.unstubAllGlobals();
  localStorage.clear();
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
  // Long enough for a setup check or an account read to answer and what follows it to land.
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const addressBar = (): string => window.location.pathname + window.location.search;

/** The policy as drawn: each of the article's blocks, a bullet as `- ` and its text. */
function blocks(): string[] {
  const article = container.querySelector('article');
  expect(article, 'the policy').not.toBeNull();
  return [...article!.children].flatMap((block) =>
    block.tagName === 'UL' ? [...block.children].map((item) => `- ${item.textContent}`) : [block.textContent ?? ''],
  );
}

describe('the privacy policy at /privacy', () => {
  it('opens signed out, at its own address, without asking the server anything first', async () => {
    await visit('/privacy');

    expect(addressBar()).toBe('/privacy');
    expect(container.querySelector('h1')?.textContent).toBe('Privacy Policy');
    expect(container.querySelector('input[type="password"]'), 'a login form').toBeNull();
    expect(requests).toEqual([]);
    expect(sentTo).toEqual([]);
    expect(document.title).toBe('Privacy Policy — Orbit');
  });

  it('says what the task gives, word for word, and nothing besides', async () => {
    await visit('/privacy');

    expect(blocks()).toEqual(LINES);
    expect(container.textContent).toBe(LINES.map((line) => line.replace(/^- /, '')).join(''));
    // The address it gives, twice, as one a click writes to.
    expect([...container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['privacy@orbitd.io', 'mailto:privacy@orbitd.io'],
      ['privacy@orbitd.io', 'mailto:privacy@orbitd.io'],
    ]);
  });

  it('opens the same page signed in, with nothing of the app read for it', async () => {
    localStorage.setItem('orbit_token', 'access-token');
    await visit('/privacy');

    expect(addressBar()).toBe('/privacy');
    expect(blocks()).toEqual(LINES);
    // The theme's read of the account, as on every page; no first screen is warmed behind a splash.
    expect(requests).toEqual(['/api/users/me']);
    expect(sentTo).toEqual([]);
  });

  it('stays open when the stored session turns out dead, and lets the session go', async () => {
    sessionAlive = false;
    localStorage.setItem('orbit_token', 'expired-access-token');
    localStorage.setItem('orbit_refresh', 'revoked-refresh-token');
    await visit('/privacy');

    expect(requests).toEqual(['/api/users/me', '/api/auth/refresh']);
    expect(sentTo, 'sent to log in').toEqual([]);
    expect(addressBar()).toBe('/privacy');
    expect(blocks()).toEqual(LINES);
    expect(localStorage.getItem('orbit_token')).toBeNull();
  });
});

describe('the login page', () => {
  it('links the policy at its foot, and the link opens it', async () => {
    await visit('/login');
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Privacy');
    expect(link, 'the Privacy link').toBeTruthy();
    expect(link!.getAttribute('href')).toBe('/privacy');
    expect(link!.closest('footer'), 'the page footer').not.toBeNull();

    // jsdom follows no link, so the page load the click starts is replayed.
    await visit(link!.getAttribute('href')!);
    expect(addressBar()).toBe('/privacy');
    expect(blocks()).toEqual(LINES);
  });
});
