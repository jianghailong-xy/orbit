// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInMethods } from '../lib/queries';

/**
 * Admin → Users → View as: an administrator views Orbit as another user, read-only, to debug what they
 * see. Offered on every account but the administrator's own, another administrator's and a disabled
 * one; asks for the reason the server records; starts the look with the token the server answers and
 * loads the app again as that user. Over a stand-in for the server's `/api`.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  startImpersonation: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api, startImpersonation } = await import('../api');
const { AdminUsersPage, START_VIEWING, VIEW_AS } = await import('./AdminUsersPage');

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
  signInMethods: SignInMethods;
  disabledAt: string | null;
}

/** What the stand-in refuses a look at, by account id: the server's message. */
let refusals: Record<string, string>;
let requests: Array<{ path: string; method: string; body?: unknown }>;
/** Where the app was sent: jsdom navigates nowhere, so `location.href = …` is recorded instead. */
let sentTo: string[];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const password = { password: true, google: null };
const users: Row[] = [
  { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', createdAt: '2026-01-05T12:00:00.000Z', signInMethods: password, disabledAt: null },
  { id: 'U2', email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: '2026-02-01T12:00:00.000Z', signInMethods: password, disabledAt: null },
  { id: 'U3', email: 'gone@example.test', name: 'Gone', role: 'MEMBER', createdAt: '2026-03-01T12:00:00.000Z', signInMethods: password, disabledAt: '2026-10-07T09:30:00.000Z' },
  { id: 'U4', email: 'ops@example.test', name: 'Ops', role: 'ADMIN', createdAt: '2026-04-01T12:00:00.000Z', signInMethods: password, disabledAt: null },
];

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** React only hears a value typed through the native setter, followed by the input event. */
async function type(field: HTMLTextAreaElement | null | undefined, value: string): Promise<void> {
  expect(field, 'the reason field is on screen').toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function open(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/admin']}>
        <QueryClientProvider client={client}>
          <AdminUsersPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(userRows().length).toBe(users.length));
  await settle();
}

const button = (within: ParentNode | null | undefined, label: string) =>
  [...(within?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === label);
const userRows = () =>
  [...container!.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter((row) => row.cells.length > 1);
const rowOf = (email: string) => userRows().find((row) => row.querySelector('.admin-users-email')?.textContent === email);
/** The View as dialog, while it is open. */
const dialog = () =>
  [...document.body.querySelectorAll<HTMLElement>('.orbit-overlay')].find((overlay) =>
    overlay.querySelector('.orbit-overlay-title')?.textContent?.startsWith('View Orbit as'));
const looks = () => requests.filter((r) => r.path.endsWith('/impersonate'));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
  for (const fn of Object.values(toast)) fn.mockReset();
  vi.mocked(startImpersonation).mockReset();
  refusals = {};
  requests = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: options.body });
    if (path === '/admin/users' && method === 'GET') return structuredClone(users);
    if (path === '/auth/methods') return { password: true, google: false, googleSignup: false };
    // The administrator signed in: U1.
    if (path === '/users/me') return { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN' };
    const look = /^\/admin\/users\/(U\d)\/impersonate$/.exec(path);
    if (look && method === 'POST') {
      if (refusals[look[1]]) throw new Error(refusals[look[1]]);
      return { accessToken: `look-at-${look[1]}`, expiresAt: '2026-10-15T12:30:00.000Z', user: { id: look[1] } };
    }
    throw new Error(`the stand-in server has no ${method} ${path}`);
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Admin → Users · View as', { timeout: 60_000 }, () => {
  it('is offered on a member’s account, never on your own, another administrator’s or a disabled one', async () => {
    await open();
    expect(button(rowOf('dev@example.test'), VIEW_AS)).toBeTruthy();
    for (const email of ['admin@example.test', 'ops@example.test', 'gone@example.test']) {
      expect(button(rowOf(email), VIEW_AS), email).toBeUndefined();
    }
  });

  it('asks why, then starts the look with the token the server answers and loads the app again as them', async () => {
    await open();
    await click(button(rowOf('dev@example.test'), VIEW_AS), 'View as on dev');
    expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('View Orbit as dev@example.test?');
    expect(dialog()?.textContent).toContain('read-only, for 30 minutes: nothing can be changed');
    const start = () => button(dialog()?.querySelector('.orbit-overlay-footer'), START_VIEWING);
    expect(start()?.disabled, 'no reason, no look').toBe(true);

    await type(dialog()?.querySelector('textarea'), '   ');
    expect(start()?.disabled, 'a blank reason is no reason').toBe(true);
    await type(dialog()?.querySelector('textarea'), '  support request 42: tasks list is empty  ');
    expect(start()?.disabled).toBe(false);
    await click(start(), 'Start viewing');

    expect(looks()).toEqual([
      { path: '/admin/users/U2/impersonate', method: 'POST', body: { reason: 'support request 42: tasks list is empty' } },
    ]);
    expect(startImpersonation).toHaveBeenCalledWith('look-at-U2');
    expect(sentTo).toEqual(['/']);
  });

  it('Cancel starts nothing, and the next look asks for its own reason', async () => {
    await open();
    await click(button(rowOf('dev@example.test'), VIEW_AS), 'View as on dev');
    await type(dialog()?.querySelector('textarea'), 'checking');
    await click(button(dialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    expect(looks()).toEqual([]);
    expect(startImpersonation).not.toHaveBeenCalled();

    await click(button(rowOf('dev@example.test'), VIEW_AS), 'View as on dev, again');
    expect(dialog()?.querySelector('textarea')?.value).toBe('');
  });

  it('a refusal is said in a toast, and nothing is started', async () => {
    refusals.U2 = 'this account is disabled';
    await open();
    await click(button(rowOf('dev@example.test'), VIEW_AS), 'View as on dev');
    await type(dialog()?.querySelector('textarea'), 'support');
    await click(button(dialog()?.querySelector('.orbit-overlay-footer'), START_VIEWING), 'Start viewing');

    expect(toast.error).toHaveBeenCalledWith("Couldn't view Orbit as dev@example.test", 'this account is disabled');
    expect(startImpersonation).not.toHaveBeenCalled();
    expect(sentTo).toEqual([]);
  });
});
