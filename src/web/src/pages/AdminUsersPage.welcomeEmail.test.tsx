// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInMethods } from '../lib/queries';

/**
 * Admin → Users and the welcome email (docs/welcome-email-design.md §3.5): a row whose welcome email
 * FAILED gets one grey line under its status, `Welcome email failed`, whose tip is Resend's error and
 * the last attempt; a sent, waiting or skipped one adds nothing. The ⋯ menu offers Send welcome email
 * for a FAILED or SKIPPED one — never a SENT one, nor an account with none — disabled, saying why, while
 * this deployment's email is off. Over a stand-in for the server's `/api` that keeps the accounts.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { AdminUsersPage, EMAIL_NOT_CONFIGURED, SEND_WELCOME_EMAIL, WELCOME_EMAIL_FAILED } = await import('./AdminUsersPage');

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
  signInMethods: SignInMethods;
  disabledAt: string | null;
  welcomeEmail: { status: string; lastError: string | null; lastAttemptAt: string | null; updatedAt: string } | null;
}

/** Whether this deployment's outgoing email is on (GET /admin/email `on`). */
let emailOn: boolean;
let users: Row[];
let requests: Array<{ path: string; method: string; body?: unknown }>;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

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
/** The users table's rows (its body's rows, less the one that says it is empty). */
const userRows = () =>
  [...container!.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter((row) => row.cells.length > 1);
const rowOf = (email: string) => userRows().find((row) => row.querySelector('.admin-users-email')?.textContent === email);
const headers = () => [...container!.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
/** `email`'s cell under the column headed `title`. */
const cellOf = (email: string, title: string) => rowOf(email)?.querySelectorAll('td')[headers().indexOf(title)];
const status = (email: string) => cellOf(email, 'Status')?.textContent?.trim();
const confirmDialog = () => document.body.querySelector<HTMLElement>('.orbit-confirm[data-open]');
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
/** Opens `email`'s menu of every other action (from the keyboard, as jsdom's click has no pointer behind it). */
async function openMenu(email: string): Promise<void> {
  await click(rowOf(email)?.querySelector(`button[aria-label="More actions for ${email}"]`), `${email}'s menu`);
}
/** What `email`'s menu offers; it is closed again. */
async function menuOf(email: string): Promise<string[]> {
  await openMenu(email);
  const offered = menuItems().map((item) => item.textContent?.trim() ?? '');
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
  return offered;
}
async function fromMenu(email: string, label: string): Promise<void> {
  await openMenu(email);
  await click(menuItems().find((item) => item.textContent?.trim() === label), `${label} in ${email}'s menu`);
}

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
  for (const fn of Object.values(toast)) fn.mockReset();
  requests = [];
  emailOn = true;
  const google = { password: false, google: { email: 'x@gmail.com' } };
  const failed = { status: 'FAILED', lastError: '403 The example.com domain is not verified', lastAttemptAt: '2026-11-11T04:21:00.000Z', updatedAt: '2026-11-11T04:21:00.000Z' };
  users = [
    { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', createdAt: '2026-01-05T12:00:00.000Z', signInMethods: { password: true, google: null }, disabledAt: null, welcomeEmail: null },
    { id: 'U2', email: 'maya@example.com', name: 'Maya Chen', role: 'MEMBER', createdAt: '2026-11-11T02:00:00.000Z', signInMethods: google, disabledAt: null, welcomeEmail: { ...failed, status: 'SENT', lastError: null } },
    { id: 'U3', email: 'jordan@example.org', name: 'Jordan Lee', role: 'MEMBER', createdAt: '2026-11-11T04:00:00.000Z', signInMethods: google, disabledAt: null, welcomeEmail: failed },
    { id: 'U4', email: 'sam@example.org', name: 'Sam Park', role: 'MEMBER', createdAt: '2026-11-11T04:10:00.000Z', signInMethods: google, disabledAt: null, welcomeEmail: { ...failed, status: 'SKIPPED', lastError: null, lastAttemptAt: null } },
    { id: 'U5', email: 'pat@example.org', name: 'Pat Pending', role: 'MEMBER', createdAt: '2026-11-11T04:11:00.000Z', signInMethods: google, disabledAt: null, welcomeEmail: { ...failed, status: 'PENDING', lastError: null, lastAttemptAt: null } },
  ];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: options.body });
    if (path === '/admin/users' && method === 'GET') return structuredClone(users);
    if (path === '/admin/email' && method === 'GET') return { on: emailOn };
    if (path === '/auth/methods') return { password: true, google: true, googleSignup: true };
    if (path === '/users/me') return { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN' };
    const resend = /^\/admin\/users\/(U\d)\/welcome-email$/.exec(path);
    if (resend && method === 'POST') {
      const user = users.find((u) => u.id === resend[1])!;
      user.welcomeEmail = { ...user.welcomeEmail!, status: 'PENDING', lastError: null };
      return { status: 'PENDING' };
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

describe('Admin → Users · the welcome email', { timeout: 60_000 }, () => {
  it('only a FAILED welcome email adds a line under the status, with the error and the last attempt on hover', async () => {
    await open();
    expect(status('maya@example.com')).toBe('Active');
    expect(status('sam@example.org')).toBe('Active');
    expect(status('pat@example.org')).toBe('Active');
    expect(status('admin@example.test')).toBe('Active');
    const line = cellOf('jordan@example.org', 'Status')?.querySelector('.admin-users-welcome-failed');
    expect(line?.textContent).toBe(WELCOME_EMAIL_FAILED);
    expect(line?.getAttribute('title')).toMatch(/^403 The example\.com domain is not verified\nLast attempt Nov 11, 2026, \d{1,2}:21 [AP]M$/);
    expect(container!.querySelectorAll('.admin-users-welcome-failed')).toHaveLength(1);
  });

  it('Send welcome email: offered for FAILED and SKIPPED only, and it puts the email back to waiting', async () => {
    await open();
    expect(await menuOf('jordan@example.org')).toContain(SEND_WELCOME_EMAIL);
    expect(await menuOf('sam@example.org')).toContain(SEND_WELCOME_EMAIL);
    for (const email of ['maya@example.com', 'pat@example.org', 'admin@example.test']) {
      expect(await menuOf(email)).not.toContain(SEND_WELCOME_EMAIL);
    }
    // Where the board puts it: after Unlink Google, before Make admin.
    const items = await menuOf('jordan@example.org');
    expect(items.indexOf(SEND_WELCOME_EMAIL)).toBe(items.indexOf('Unlink Google') + 1);
    expect(items[items.indexOf(SEND_WELCOME_EMAIL) + 1]).toBe('Make admin');

    await fromMenu('jordan@example.org', SEND_WELCOME_EMAIL);
    expect(requests.filter((r) => r.method === 'POST')).toEqual([{ path: '/admin/users/U3/welcome-email', method: 'POST', body: undefined }]);
    expect(toast.success).toHaveBeenCalledWith('Welcome email queued', 'jordan@example.org');
    await vi.waitFor(() => expect(container!.querySelectorAll('.admin-users-welcome-failed')).toHaveLength(0));
  });

  it('while email is off, the item is disabled and says why', async () => {
    emailOn = false;
    await open();
    await openMenu('jordan@example.org');
    const item = menuItems().find((i) => i.textContent?.startsWith(SEND_WELCOME_EMAIL))!;
    expect(item.textContent).toBe(`${SEND_WELCOME_EMAIL}${EMAIL_NOT_CONFIGURED}`);
    expect(item.getAttribute('aria-disabled') ?? item.getAttribute('data-disabled')).not.toBeNull();
    await click(item, 'the disabled item');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);
  });
});
