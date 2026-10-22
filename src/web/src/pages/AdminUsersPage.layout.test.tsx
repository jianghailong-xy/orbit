// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInMethods } from '../lib/queries';
import { PHONE_QUERY } from '../lib/useMediaQuery';

/**
 * Admin → Users, one row an account (docs/mocks/admin-users-redesign, direction A): who it is — a mark for
 * you and for an administrator —, when it last used Orbit, a search over names and emails, the one action
 * most often wanted in sight and every other in the row's menu, the ones that lock an account out or
 * remove it last and asked first. On a phone the row keeps only its menu, which then starts with that action.
 * Over a stand-in for the server's `/api` that keeps the accounts.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  fetchUserAvatarDataUrl: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api, fetchUserAvatarDataUrl } = await import('../api');
const { AdminUsersPage, DELETE_USER, DISABLE_USER, ENABLE_USER, RESET_PASSWORD, UPDATE_WIKI_DOCS, VIEW_AS } = await import('./AdminUsersPage');

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
  signInMethods: SignInMethods;
  disabledAt: string | null;
  lastActive: { at: string; via: string } | null;
  avatarUpdatedAt?: string | null;
}

const HOUR = 3_600_000;
let users: Row[];
let requests: Array<{ path: string; method: string; body?: unknown }>;
let refusals: Record<string, string>;
let phone: boolean;
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

/** React only hears a value typed through the native setter, followed by the input event. */
async function type(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  expect(input, 'the search field is on screen').toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
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
const emails = () => userRows().map((row) => row.querySelector('.admin-users-email')?.textContent);
const rowOf = (email: string) => userRows().find((row) => row.querySelector('.admin-users-email')?.textContent === email);
const headers = () => [...container!.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
const cellOf = (email: string, title: string) => rowOf(email)?.querySelectorAll('td')[headers().indexOf(title)];
const confirmDialog = () => document.body.querySelector<HTMLElement>('.orbit-confirm[data-open]');
const avatarOf = (email: string) => rowOf(email)?.querySelector('.orbit-avatar');
/** The photo the stand-in server holds for an account: its version, as a data URL. */
const photoOf = (id: string) => `data:image/png;base64,${btoa(`${id} ${users.find((u) => u.id === id)?.avatarUpdatedAt}`)}`;
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
async function openMenu(email: string): Promise<void> {
  await click(rowOf(email)?.querySelector(`button[aria-label="More actions for ${email}"]`), `${email}'s menu`);
}
/** What `email`'s menu offers, in order; it is closed again. */
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
  phone = false;
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: phone && query === PHONE_QUERY,
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
  refusals = {};
  const password = { password: true, google: null };
  const now = Date.now();
  users = [
    { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', createdAt: '2026-01-05T12:00:00.000Z', signInMethods: password, disabledAt: null, lastActive: { at: new Date(now - 3 * HOUR).toISOString(), via: 'web' } },
    { id: 'U2', email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: '2026-02-01T12:00:00.000Z', signInMethods: { password: true, google: { email: 'dev@gmail.com' } }, disabledAt: null, lastActive: { at: '2026-01-02T08:00:00.000Z', via: 'token' } },
    { id: 'U3', email: 'gone@example.test', name: 'Gone', role: 'MEMBER', createdAt: '2026-03-01T12:00:00.000Z', signInMethods: password, disabledAt: '2026-10-07T09:30:00.000Z', lastActive: null },
    { id: 'U4', email: 'ops@example.test', name: '', role: 'ADMIN', createdAt: '2026-04-01T12:00:00.000Z', signInMethods: password, disabledAt: null, lastActive: { at: new Date(now - 26 * HOUR).toISOString(), via: 'ios' } },
  ];
  vi.mocked(fetchUserAvatarDataUrl).mockReset();
  vi.mocked(fetchUserAvatarDataUrl).mockImplementation(async (id: string) => photoOf(id));
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: options.body });
    if (path === '/admin/users' && method === 'GET') return structuredClone(users);
    if (path === '/auth/methods') return { password: true, google: false, googleSignup: false };
    // The administrator signed in: U1.
    if (path === '/users/me') return { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN' };
    if (path === '/admin/users' && method === 'POST') {
      const { email } = options.body as { email: string };
      return { email, reset: true, generatedPassword: 'one-time-PW-42' };
    }
    const deleting = /^\/admin\/users\/(U\d)$/.exec(path);
    if (deleting && method === 'DELETE') {
      if (refusals[deleting[1]]) throw new Error(refusals[deleting[1]]);
      users = users.filter((u) => u.id !== deleting[1]);
      return { id: deleting[1], deleted: true };
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

describe('Admin → Users · one row an account', { timeout: 60_000 }, () => {
  it('says how many accounts there are, who each is, and when each last used Orbit', async () => {
    await open();
    expect(container!.querySelector('.admin-users-sub')?.textContent).toBe('4 accounts · 2 administrators · 1 disabled');
    expect(headers()).toEqual(['User', 'Sign-in', 'Status', 'Last active', 'Created', '']);
    // Your own account and an administrator are marked; an account without a name goes by its address.
    expect(rowOf('admin@example.test')?.querySelector('.admin-users-name')?.textContent).toBe('AdminYouAdmin');
    expect(rowOf('ops@example.test')?.querySelector('.admin-users-name')?.textContent).toBe('opsAdmin');
    expect(rowOf('dev@example.test')?.querySelector('.admin-users-name')?.textContent).toBe('Dev');
    // Lately as how long ago, a month back as the date, and an account that never has.
    expect(cellOf('admin@example.test', 'Last active')?.textContent).toBe('3h ago');
    expect(cellOf('admin@example.test', 'Last active')?.querySelector('[title]')?.getAttribute('title')).toMatch(/ · Web$/);
    expect(cellOf('ops@example.test', 'Last active')?.textContent).toBe('1d 2h ago');
    expect(cellOf('ops@example.test', 'Last active')?.querySelector('[title]')?.getAttribute('title')).toMatch(/ · iOS app$/);
    expect(cellOf('dev@example.test', 'Last active')?.textContent).toBe('Jan 2, 2026');
    expect(cellOf('dev@example.test', 'Last active')?.querySelector('[title]')?.getAttribute('title')).toMatch(/^Jan 2, 2026, .* · Access token$/);
    expect(cellOf('gone@example.test', 'Last active')?.textContent).toBe('Never');
    expect(rowOf('gone@example.test')?.className).toBe('admin-users-off');
  });

  it('draws the photo of an account that has one, by its version, and the initial of one that has none', async () => {
    users[1].avatarUpdatedAt = '2026-10-16T08:30:00.000Z';
    await open();
    await vi.waitFor(() => expect(avatarOf('dev@example.test')?.querySelector('img')?.getAttribute('src')).toBe(photoOf('U2')));
    expect(avatarOf('dev@example.test')?.textContent).toBe('');
    expect(avatarOf('admin@example.test')?.querySelector('img')).toBeNull();
    expect(avatarOf('admin@example.test')?.textContent).toBe('A');
    expect(avatarOf('ops@example.test')?.textContent).toBe('O');
    // Only an account with a photo has one fetched.
    expect(vi.mocked(fetchUserAvatarDataUrl).mock.calls).toEqual([['U2']]);

    // The list read again with the photo as it was: it is not fetched again.
    await fromMenu('gone@example.test', DELETE_USER);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), DELETE_USER), 'Delete in the dialog');
    await vi.waitFor(() => expect(emails()).not.toContain('gone@example.test'));
    expect(vi.mocked(fetchUserAvatarDataUrl).mock.calls).toEqual([['U2']]);

    // A new photo is a new version: fetched, and drawn in the old one's place.
    const before = photoOf('U2');
    users[1].avatarUpdatedAt = '2026-10-17T09:00:00.000Z';
    await fromMenu('ops@example.test', DELETE_USER);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), DELETE_USER), 'Delete in the dialog');
    await vi.waitFor(() => expect(avatarOf('dev@example.test')?.querySelector('img')?.getAttribute('src')).toBe(photoOf('U2')));
    expect(photoOf('U2')).not.toBe(before);
    expect(vi.mocked(fetchUserAvatarDataUrl).mock.calls).toEqual([['U2'], ['U2']]);
  });

  it('searches names and emails as they are typed, and says when nothing matches', async () => {
    await open();
    const search = container!.querySelector<HTMLInputElement>('input[aria-label="Search users"]');
    await type(search, 'DEV');
    expect(emails()).toEqual(['dev@example.test']);
    await type(search, 'ops@');
    expect(emails()).toEqual(['ops@example.test']);
    await type(search, 'gon');
    expect(emails()).toEqual(['gone@example.test']);
    await type(search, 'nobody');
    expect(emails()).toEqual([]);
    expect(container!.querySelector('.admin-users-none')?.textContent).toBe('No users match “nobody”');
    await type(search, '');
    expect(emails()).toEqual(['admin@example.test', 'dev@example.test', 'gone@example.test', 'ops@example.test']);
  });

  it('keeps one action in sight — View as, or Enable — and every other in the menu, locking out and removing last', async () => {
    await open();
    expect(button(rowOf('dev@example.test'), VIEW_AS)).toBeTruthy();
    expect(button(rowOf('gone@example.test'), ENABLE_USER)).toBeTruthy();
    for (const email of ['admin@example.test', 'ops@example.test']) {
      expect(button(rowOf(email), VIEW_AS), email).toBeUndefined();
      expect(button(rowOf(email), ENABLE_USER), email).toBeUndefined();
    }
    expect(await menuOf('dev@example.test')).toEqual([RESET_PASSWORD, 'Access tokens', UPDATE_WIKI_DOCS, 'Unlink Google', 'Make admin', DISABLE_USER, DELETE_USER]);
    expect(await menuOf('gone@example.test')).toEqual([RESET_PASSWORD, 'Access tokens', UPDATE_WIKI_DOCS, 'Make admin', DELETE_USER]);
    expect(await menuOf('ops@example.test')).toEqual([RESET_PASSWORD, 'Access tokens', UPDATE_WIKI_DOCS, 'Make member', DISABLE_USER, DELETE_USER]);
    // Your own account cannot be disabled or deleted, so its menu does not offer either.
    expect(await menuOf('admin@example.test')).toEqual([RESET_PASSWORD, 'Access tokens', UPDATE_WIKI_DOCS, 'Make member']);
  });

  it('resets a password once asked, then shows the one-time password', async () => {
    await open();
    await fromMenu('dev@example.test', RESET_PASSWORD);
    expect(confirmDialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe("Reset dev@example.test's password?");
    expect(confirmDialog()?.textContent).toContain('Their current password stops working.');
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);

    await fromMenu('dev@example.test', RESET_PASSWORD);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), RESET_PASSWORD), 'Reset password in the dialog');
    expect(requests.filter((r) => r.method === 'POST')).toEqual([{ path: '/admin/users', method: 'POST', body: { email: 'dev@example.test', force: true } }]);
    await vi.waitFor(() => expect(confirmDialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('Password reset for dev@example.test'));
    expect(confirmDialog()?.querySelector('code')?.textContent).toBe('one-time-PW-42');
  });

  it('deletes an account once asked; a refusal is said in the question and nothing changes', async () => {
    refusals.U2 = 'user still owns runners, workspaces, or tasks — remove those first';
    await open();
    await fromMenu('dev@example.test', DELETE_USER);
    expect(confirmDialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe('Delete dev@example.test?');
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), DELETE_USER), 'Delete in the dialog');
    expect(confirmDialog()?.querySelector('[role="alert"]')?.textContent).toBe(refusals.U2);
    expect(toast.success).not.toHaveBeenCalled();
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    expect(emails()).toContain('dev@example.test');

    await fromMenu('gone@example.test', DELETE_USER);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), DELETE_USER), 'Delete in the dialog');
    expect(requests.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual(['/admin/users/U2', '/admin/users/U3']);
    expect(toast.success).toHaveBeenCalledWith('User deleted');
    await vi.waitFor(() => expect(emails()).not.toContain('gone@example.test'));
  });

  it('on a phone keeps only the menu in the row, which starts with that action', async () => {
    phone = true;
    await open();
    expect(button(rowOf('dev@example.test'), VIEW_AS)).toBeUndefined();
    expect(button(rowOf('gone@example.test'), ENABLE_USER)).toBeUndefined();
    expect((await menuOf('dev@example.test')).slice(0, 2)).toEqual([VIEW_AS, RESET_PASSWORD]);
    expect((await menuOf('gone@example.test')).slice(0, 2)).toEqual([ENABLE_USER, RESET_PASSWORD]);
    expect((await menuOf('ops@example.test'))[0]).toBe(RESET_PASSWORD);

    await fromMenu('dev@example.test', VIEW_AS);
    const viewing = [...document.body.querySelectorAll('.orbit-overlay-title')].find((title) => title.textContent === 'View Orbit as dev@example.test?');
    expect(viewing, 'the View as dialog').toBeTruthy();
  });
});
