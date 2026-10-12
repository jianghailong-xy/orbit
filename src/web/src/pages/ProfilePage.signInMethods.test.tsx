// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import type { Me, SignInMethods } from '../lib/queries';

/**
 * Profile → Sign-in methods (docs/google-sign-in-design.md §5.3, §5.4, §8.1): whether the account has
 * a password, and its Google account — Connect Google (a verifier kept in this tab, its challenge sent
 * with POST /auth/google/link, the browser sent to Google), the return to /settings/profile with a
 * ticket confirmed with that verifier, and Disconnect. An account without a password is not offered
 * Change password, nor a Disconnect that would lock it out. With Google sign-in off, an ordinary
 * account's profile is as it was.
 *
 * The real page under a router at the address Google sends the browser back to, over a stand-in for
 * the server's `/api` that records every request; `location` is a stand-in that records where the
 * page sends the browser, since jsdom navigates nowhere.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { ProfilePage } = await import('./ProfilePage');
const { CONNECT_GOOGLE, DISCONNECT_GOOGLE, GOOGLE_OFF, GOOGLE_ONLY_WAY_IN, SIGN_IN_METHODS_TITLE } = await import(
  '../components/SignInMethodsCard'
);
const { GOOGLE_LINK_VERIFIER_KEY } = await import('../lib/googleLink');

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=s';
const GOOGLE_EMAIL = 'ada@gmail.com';

/** What the stand-in server holds, and every request it was sent. `google` null: /auth/methods never answers. */
let server: { me: Me; google: boolean | null; confirm?: () => Promise<unknown> };
let requests: Array<{ path: string; method: string; body?: unknown }>;
let sentTo: string[];
let address: string;
let container: HTMLDivElement;
let root: Root | null = null;

const account = (signInMethods: SignInMethods): Me => ({
  id: 'U1',
  email: 'ada@example.com',
  name: 'Ada',
  createdAt: '2026-09-01T00:00:00.000Z',
  avatarUpdatedAt: null,
  signInMethods,
});

function LocationProbe() {
  const { pathname, search } = useLocation();
  address = pathname + search;
  return null;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(at = '/settings/profile'): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[at]}>
          <Routes>
            <Route
              path="/settings/profile"
              element={
                <>
                  <ProfilePage />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** Every card on the page, in order: a region named by its title. */
const cards = () => [...container.querySelectorAll<HTMLElement>('section[aria-labelledby]')];
const titleOf = (section: HTMLElement) => document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent;
const card = () => cards().find((section) => titleOf(section) === SIGN_IN_METHODS_TITLE);
const row = (method: 'password' | 'google') => card()?.querySelector<HTMLElement>(`[data-method="${method}"]`);
const buttonIn = (within: ParentNode | null | undefined, label: string) =>
  [...(within?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === label);
const cardTitles = () => cards().map(titleOf);
const confirmDialog = () => document.body.querySelector<HTMLElement>('.orbit-confirm[data-open]');
const sent = (path: string, method: string) => requests.filter((r) => r.path === path && r.method === method);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  sessionStorage.clear();
  requests = [];
  sentTo = [];
  address = '';
  toast.success.mockClear();
  toast.error.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        if (key === 'assign') return (url: string) => sentTo.push(url);
        const value: unknown = Reflect.get(real, key, real);
        return typeof value === 'function' ? value.bind(real) : value;
      },
    }),
  );
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: options.body });
    if (path === '/users/me' && method === 'GET') return structuredClone(server.me);
    if (path === '/auth/methods') {
      if (server.google === null) return new Promise(() => {});
      return { password: true, google: server.google, googleSignup: false };
    }
    if (path === '/auth/google/link' && method === 'POST') return { authorizationUrl: AUTHORIZATION_URL };
    if (path === '/auth/google/link/confirm' && method === 'POST') {
      if (server.confirm) return server.confirm();
      server.me.signInMethods = { password: server.me.signInMethods!.password, google: { email: GOOGLE_EMAIL } };
      return { signInMethods: server.me.signInMethods };
    }
    if (path === '/auth/google/link' && method === 'DELETE') {
      server.me.signInMethods = { password: server.me.signInMethods!.password, google: null };
      return { signInMethods: server.me.signInMethods };
    }
    throw new Error(`the stand-in server has no ${method} ${path}`);
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Profile · Sign-in methods', () => {
  it('Connect Google keeps a verifier in this tab, opens the link with its S256 challenge, and sends the browser to Google', async () => {
    server = { me: account({ password: true, google: null }), google: true };
    await open();

    expect(row('password')?.textContent).toContain('Set');
    expect(row('google')?.textContent).toContain('Not connected');
    await click(buttonIn(row('google'), CONNECT_GOOGLE), 'Connect Google');

    const verifier = sessionStorage.getItem(GOOGLE_LINK_VERIFIER_KEY);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [link] = sent('/auth/google/link', 'POST');
    expect(link?.body).toEqual({ codeChallenge: createHash('sha256').update(verifier!).digest('base64url') });
    expect(sentTo).toEqual([AUTHORIZATION_URL]);
    expect(sent('/auth/google/link/confirm', 'POST')).toEqual([]);
  });

  it('back from Google with a ticket: the address is cleaned, the ticket is confirmed once with this tab\'s verifier, and the card shows the Google account', async () => {
    server = { me: account({ password: true, google: null }), google: true };
    sessionStorage.setItem(GOOGLE_LINK_VERIFIER_KEY, 'v'.repeat(43));
    await open('/settings/profile?google_link_ticket=T-123&tab=keep');

    expect(sent('/auth/google/link/confirm', 'POST')).toEqual([
      { path: '/auth/google/link/confirm', method: 'POST', body: { ticket: 'T-123', codeVerifier: 'v'.repeat(43) } },
    ]);
    expect(address).toBe('/settings/profile?tab=keep');
    expect(sessionStorage.getItem(GOOGLE_LINK_VERIFIER_KEY)).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('Google connected', GOOGLE_EMAIL);
    expect(row('google')?.textContent).toContain(`Connected as ${GOOGLE_EMAIL}`);
    expect(buttonIn(row('google'), DISCONNECT_GOOGLE)?.disabled).toBe(false);
    expect(buttonIn(row('google'), CONNECT_GOOGLE)).toBeUndefined();
  });

  it('back with a ticket but no verifier in this tab: nothing is confirmed, and the person is told to connect again', async () => {
    server = { me: account({ password: true, google: null }), google: true };
    await open('/settings/profile?google_link_ticket=T-123');

    expect(sent('/auth/google/link/confirm', 'POST')).toEqual([]);
    expect(address).toBe('/settings/profile');
    expect(toast.error).toHaveBeenCalledWith("Couldn't connect Google", expect.stringMatching(/connect Google again/));
    expect(row('google')?.textContent).toContain('Not connected');
  });

  it('back with google_error: the reason is said, the verifier dropped, and the address cleaned', async () => {
    server = { me: account({ password: true, google: null }), google: true };
    sessionStorage.setItem(GOOGLE_LINK_VERIFIER_KEY, 'v'.repeat(43));
    await open('/settings/profile?google_error=GOOGLE_CANCELLED');

    expect(toast.error).toHaveBeenCalledWith("Couldn't connect Google", 'You cancelled at Google — nothing was connected.');
    expect(sessionStorage.getItem(GOOGLE_LINK_VERIFIER_KEY)).toBeNull();
    expect(address).toBe('/settings/profile');
    expect(sent('/auth/google/link/confirm', 'POST')).toEqual([]);
  });

  it("a refused confirmation says the server's reason and connects nothing", async () => {
    const reason = 'This Google account is already linked to another Orbit account — disconnect it there first, or ask an administrator';
    server = {
      me: account({ password: true, google: null }),
      google: true,
      confirm: () => Promise.reject(new ApiError(reason, 409, 'GOOGLE_ALREADY_LINKED')),
    };
    sessionStorage.setItem(GOOGLE_LINK_VERIFIER_KEY, 'v'.repeat(43));
    await open('/settings/profile?google_link_ticket=T-123');

    expect(toast.error).toHaveBeenCalledWith("Couldn't connect Google", reason);
    expect(row('google')?.textContent).toContain('Not connected');
    expect(buttonIn(row('google'), CONNECT_GOOGLE)).toBeTruthy();
  });

  it('Disconnect asks first, then unlinks with DELETE /auth/google/link, and the card offers Connect Google again', async () => {
    server = { me: account({ password: true, google: { email: GOOGLE_EMAIL } }), google: true };
    await open();
    expect(row('google')?.textContent).toContain(`Connected as ${GOOGLE_EMAIL}`);

    await click(buttonIn(row('google'), DISCONNECT_GOOGLE), 'Disconnect');
    expect(confirmDialog()?.querySelector('.orbit-overlay-title')?.textContent).toContain('Disconnect Google?');
    expect(confirmDialog()?.textContent).toContain(GOOGLE_EMAIL);
    expect(sent('/auth/google/link', 'DELETE')).toEqual([]);
    await click(buttonIn(confirmDialog()?.querySelector('.orbit-overlay-footer'), DISCONNECT_GOOGLE), 'the dialog\'s Disconnect');

    expect(sent('/auth/google/link', 'DELETE')).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith('Google disconnected');
    expect(row('google')?.textContent).toContain('Not connected');
    expect(buttonIn(row('google'), CONNECT_GOOGLE)).toBeTruthy();
    expect(row('password')?.textContent).toContain('Set');
  });

  it('an account without a password: no Change password, Password not set, and Disconnect is off with the reason', async () => {
    server = { me: account({ password: false, google: { email: GOOGLE_EMAIL } }), google: true };
    await open();

    expect(cardTitles()).toEqual(['Basic information', SIGN_IN_METHODS_TITLE]);
    expect(row('password')?.textContent).toContain('Not set');
    expect(row('password')?.textContent).toContain('you sign in with Google');
    expect(buttonIn(row('google'), DISCONNECT_GOOGLE)?.disabled).toBe(true);
    expect(row('google')?.textContent).toContain(GOOGLE_ONLY_WAY_IN);
  });

  it('with a password, Change password is where it was', async () => {
    server = { me: account({ password: true, google: null }), google: true };
    await open();
    expect(cardTitles()).toEqual(['Basic information', SIGN_IN_METHODS_TITLE, 'Change password']);
  });

  it('until the server says whether Google sign-in is on, a linked account is shown its link, offered nothing, and not told it is off', async () => {
    server = { me: account({ password: true, google: { email: GOOGLE_EMAIL } }), google: null };
    await open();
    expect(row('google')?.textContent).toContain(`Connected as ${GOOGLE_EMAIL}`);
    expect(row('google')?.textContent).not.toContain(GOOGLE_OFF);
    expect(card()?.querySelectorAll('button')).toHaveLength(0);
  });

  it('Google sign-in off: an ordinary account sees the profile as it was; a linked one sees its link and no button', async () => {
    server = { me: account({ password: true, google: null }), google: false };
    await open();
    expect(card()).toBeUndefined();
    expect(cardTitles()).toEqual(['Basic information', 'Change password']);
    const first = root;
    root = null;
    await act(async () => first?.unmount());

    server = { me: account({ password: true, google: { email: GOOGLE_EMAIL } }), google: false };
    await open();
    expect(row('google')?.textContent).toContain(`Connected as ${GOOGLE_EMAIL}`);
    expect(row('google')?.textContent).toContain(GOOGLE_OFF);
    expect(card()?.querySelectorAll('button')).toHaveLength(0);
  });
});
