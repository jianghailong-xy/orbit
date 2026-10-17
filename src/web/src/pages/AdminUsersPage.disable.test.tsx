// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInMethods } from '../lib/queries';

/**
 * Admin → Users and disabled accounts (docs/google-sign-in-design.md §5.5): the list says which
 * accounts are disabled; Disable is offered in the menu of every account but the administrator's own,
 * asks first and says what stops working; a refusal (the last administrator) is shown in that dialog;
 * Enable, in sight on a disabled account's row, lets it back in at once. Over a stand-in for the
 * server's `/api` that keeps the accounts.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { AdminUsersPage, DISABLE_USER, ENABLE_USER } = await import('./AdminUsersPage');

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
  signInMethods: SignInMethods;
  disabledAt: string | null;
}

/** What the stand-in refuses a PATCH …/disabled for, by account id: the server's message. */
let refusals: Record<string, string>;
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
const patches = () => requests.filter((r) => r.method === 'PATCH');

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
  refusals = {};
  requests = [];
  const password = { password: true, google: null };
  users = [
    { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', createdAt: '2026-01-05T12:00:00.000Z', signInMethods: password, disabledAt: null },
    { id: 'U2', email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: '2026-02-01T12:00:00.000Z', signInMethods: password, disabledAt: null },
    { id: 'U3', email: 'gina@gmail.com', name: 'Gina', role: 'MEMBER', createdAt: '2026-10-06T12:00:00.000Z', signInMethods: { password: false, google: { email: 'gina@gmail.com' } }, disabledAt: '2026-10-07T09:30:00.000Z' },
    { id: 'U4', email: 'ops@example.test', name: 'Ops', role: 'ADMIN', createdAt: '2026-03-01T12:00:00.000Z', signInMethods: password, disabledAt: null },
  ];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: options.body });
    if (path === '/admin/users' && method === 'GET') return structuredClone(users);
    if (path === '/auth/methods') return { password: true, google: false, googleSignup: false };
    // The administrator signed in: U1.
    if (path === '/users/me') return { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN' };
    const disabled = /^\/admin\/users\/(U\d)\/disabled$/.exec(path);
    if (disabled && method === 'PATCH') {
      if (refusals[disabled[1]]) throw new Error(refusals[disabled[1]]);
      const user = users.find((u) => u.id === disabled[1])!;
      user.disabledAt = (options.body as { disabled: boolean }).disabled ? '2026-10-07T14:00:00.000Z' : null;
      const { signInMethods: _, ...answer } = user;
      return answer;
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

describe('Admin → Users · disabling accounts', { timeout: 60_000 }, () => {
  it('Status says which accounts are disabled; Disable is offered on every other account but your own, Enable on a disabled one', async () => {
    await open();
    expect(headers()).toEqual(['User', 'Sign-in', 'Status', 'Last active', 'Created', '']);
    expect(status('admin@example.test')).toBe('Active');
    expect(status('dev@example.test')).toBe('Active');
    expect(status('gina@gmail.com')).toBe('Disabled');
    expect(cellOf('gina@gmail.com', 'Status')?.querySelector('[title]')?.getAttribute('title')).toBe('Disabled on Oct 7, 2026');

    // Your own account: neither, as the server refuses to disable it.
    expect(await menuOf('admin@example.test')).not.toContain(DISABLE_USER);
    expect(button(rowOf('admin@example.test'), ENABLE_USER)).toBeUndefined();
    for (const email of ['dev@example.test', 'ops@example.test']) {
      expect(await menuOf(email), email).toContain(DISABLE_USER);
      expect(button(rowOf(email), ENABLE_USER), email).toBeUndefined();
    }
    expect(button(rowOf('gina@gmail.com'), ENABLE_USER)).toBeTruthy();
    expect(await menuOf('gina@gmail.com')).not.toContain(DISABLE_USER);
  });

  it('Disable asks first and says what stops working, then disables through the admin route', async () => {
    await open();
    await fromMenu('dev@example.test', DISABLE_USER);
    expect(confirmDialog()?.querySelector('.orbit-overlay-title')?.textContent).toContain('Disable dev@example.test?');
    expect(confirmDialog()?.textContent).toContain('They are signed out everywhere and cannot sign in.');
    expect(confirmDialog()?.textContent).toContain('Their access tokens, runners and service tokens stop working until you enable the account again.');
    expect(confirmDialog()?.textContent).toContain('Nothing they own is deleted.');
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    expect(patches()).toEqual([]);
    expect(status('dev@example.test')).toBe('Active');

    await fromMenu('dev@example.test', DISABLE_USER);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), DISABLE_USER), 'Disable in the dialog');
    expect(patches()).toEqual([{ path: '/admin/users/U2/disabled', method: 'PATCH', body: { disabled: true } }]);
    expect(toast.success).toHaveBeenCalledWith('Account disabled', 'dev@example.test');
    expect(confirmDialog()).toBeNull();
    await vi.waitFor(() => expect(status('dev@example.test')).toBe('Disabled'));
    expect(button(rowOf('dev@example.test'), ENABLE_USER)).toBeTruthy();
    expect(await menuOf('dev@example.test')).not.toContain(DISABLE_USER);
  });

  it('a refused Disable, the last administrator, is said in the dialog, and nothing changes', async () => {
    refusals.U4 = 'cannot disable the last admin';
    await open();
    await fromMenu('ops@example.test', DISABLE_USER);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), DISABLE_USER), 'Disable in the dialog');
    expect(patches()).toEqual([{ path: '/admin/users/U4/disabled', method: 'PATCH', body: { disabled: true } }]);
    expect(confirmDialog()?.querySelector('[role="alert"]')?.textContent).toBe('cannot disable the last admin');
    expect(toast.success).not.toHaveBeenCalled();
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    expect(confirmDialog()).toBeNull();
    expect(status('ops@example.test')).toBe('Active');
    expect(await menuOf('ops@example.test')).toContain(DISABLE_USER);
  });

  it('Enable lets a disabled account back in at once, without asking', async () => {
    await open();
    await click(button(rowOf('gina@gmail.com'), ENABLE_USER), 'Enable on gina');
    expect(confirmDialog()).toBeNull();
    expect(patches()).toEqual([{ path: '/admin/users/U3/disabled', method: 'PATCH', body: { disabled: false } }]);
    expect(toast.success).toHaveBeenCalledWith('Account enabled', 'gina@gmail.com');
    await vi.waitFor(() => expect(status('gina@gmail.com')).toBe('Active'));
    expect(await menuOf('gina@gmail.com')).toContain(DISABLE_USER);
    expect(button(rowOf('gina@gmail.com'), ENABLE_USER)).toBeUndefined();
  });

  it('a failed Enable is said in a toast, and the account stays disabled', async () => {
    refusals.U3 = 'user not found';
    await open();
    await click(button(rowOf('gina@gmail.com'), ENABLE_USER), 'Enable on gina');
    expect(toast.error).toHaveBeenCalledWith("Couldn't enable the account", 'user not found');
    expect(toast.success).not.toHaveBeenCalled();
    expect(status('gina@gmail.com')).toBe('Disabled');
  });
});
