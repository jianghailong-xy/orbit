// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInMethods } from '../lib/queries';

/**
 * Admin → Users and Google sign-in (docs/google-sign-in-design.md §5.3, §5.4, §5.6, §8.1): the list
 * says how each account signs in and when it was opened; a row with a Google account linked offers
 * Unlink Google, asked first, through the admin route; and Add user offers a Google-only account
 * while Google sign-in is on. Over a stand-in for the server's `/api` that keeps the accounts.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { AdminUsersPage, GOOGLE_SIGN_IN_ONLY, GOOGLE_SIGN_IN_ONLY_HINT, UNLINK_GOOGLE } = await import('./AdminUsersPage');

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
  signInMethods: SignInMethods;
}

let users: Row[];
let googleOn: boolean;
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

/** React only hears a value typed through the native setter, followed by the input event. */
async function type(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
const rowOf = (email: string) => userRows().find((row) => row.querySelector('td')?.textContent === email);
const headers = () => [...container!.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
/** The text of `email`'s cell under the column headed `title`. */
const cell = (email: string, title: string) => rowOf(email)?.querySelectorAll('td')[headers().indexOf(title)]?.textContent?.trim();
const confirmDialog = () => document.body.querySelector<HTMLElement>('.orbit-confirm[data-open]');
/** The open dialog named Add user, by the title it is labelled by. */
const addUserDialog = () =>
  [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (d) => document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent === 'Add user',
  );

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
  googleOn = true;
  requests = [];
  users = [
    { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', createdAt: '2026-01-05T12:00:00.000Z', signInMethods: { password: true, google: null } },
    { id: 'U2', email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: '2026-02-01T12:00:00.000Z', signInMethods: { password: true, google: { email: 'dev@gmail.com' } } },
    { id: 'U3', email: 'gina@gmail.com', name: 'Gina', role: 'MEMBER', createdAt: '2026-10-06T12:00:00.000Z', signInMethods: { password: false, google: { email: 'gina@gmail.com' } } },
    { id: 'U4', email: 'nora@example.test', name: 'Nora', role: 'MEMBER', createdAt: '2026-10-07T12:00:00.000Z', signInMethods: { password: false, google: null } },
  ];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: options.body });
    if (path === '/admin/users' && method === 'GET') return structuredClone(users);
    if (path === '/auth/methods') return { password: true, google: googleOn, googleSignup: false };
    const unlink = /^\/admin\/users\/(U\d)\/identities\/google$/.exec(path);
    if (unlink && method === 'DELETE') {
      const user = users.find((u) => u.id === unlink[1])!;
      user.signInMethods = { ...user.signInMethods, google: null };
      return { signInMethods: user.signInMethods };
    }
    if (path === '/admin/users' && method === 'POST') {
      const body = options.body as { email: string; passwordless?: boolean };
      users.push({ id: 'U5', email: body.email, name: body.email.split('@')[0], role: 'MEMBER', createdAt: '2026-10-07T13:00:00.000Z', signInMethods: { password: !body.passwordless, google: null } });
      return { id: 'U5', email: body.email, name: body.email.split('@')[0], reset: false };
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

describe('Admin → Users · Google sign-in', { timeout: 60_000 }, () => {
  it('the list says how each account signs in and when it was opened', async () => {
    await open();
    expect(headers()).toEqual(['Email', 'Name', 'Role', 'Status', 'Sign-in', 'Created', '']);
    expect(cell('admin@example.test', 'Sign-in')).toBe('Password');
    expect(cell('dev@example.test', 'Sign-in')).toBe('PasswordGoogle');
    expect(cell('gina@gmail.com', 'Sign-in')).toBe('Google');
    expect(cell('nora@example.test', 'Sign-in')).toBe('Google · pending');
    expect(rowOf('dev@example.test')?.querySelector('[title="dev@gmail.com"]')?.textContent).toBe('Google');
    expect(cell('admin@example.test', 'Created')).toBe('Jan 5, 2026');
    expect(cell('nora@example.test', 'Created')).toBe('Oct 7, 2026');
  });

  it('Unlink Google is offered only on rows with a Google account, asks first, then unlinks through the admin route', async () => {
    await open();
    expect(button(rowOf('admin@example.test'), UNLINK_GOOGLE)).toBeUndefined();
    expect(button(rowOf('nora@example.test'), UNLINK_GOOGLE)).toBeUndefined();

    // With a password: the account keeps a way in, and is told so.
    await click(button(rowOf('dev@example.test'), UNLINK_GOOGLE), 'Unlink Google on dev');
    expect(confirmDialog()?.querySelector('.orbit-overlay-title')?.textContent).toContain('Unlink Google from dev@example.test?');
    expect(confirmDialog()?.textContent).toContain('They can still sign in with their password');
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([]);

    // Without one: the administrator is told it is left with no way in until a password reset.
    await click(button(rowOf('gina@gmail.com'), UNLINK_GOOGLE), 'Unlink Google on gina');
    expect(confirmDialog()?.textContent).toContain('This account has no password');
    expect(confirmDialog()?.textContent).toContain('until you reset its password');
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), 'Unlink'), 'Unlink');

    expect(requests.filter((r) => r.method === 'DELETE')).toEqual([{ path: '/admin/users/U3/identities/google', method: 'DELETE', body: undefined }]);
    expect(toast.success).toHaveBeenCalledWith('Google unlinked', 'gina@gmail.com');
    await vi.waitFor(() => expect(cell('gina@gmail.com', 'Sign-in')).toBe('Google · pending'));
    expect(button(rowOf('gina@gmail.com'), UNLINK_GOOGLE)).toBeUndefined();
    expect(button(rowOf('dev@example.test'), UNLINK_GOOGLE)).toBeTruthy();
  });

  it('Add user offers Google sign-in only while Google sign-in is on, says which addresses it can work for, and creates the account without a password', async () => {
    await open();
    await click(button(container, 'Add user'), 'Add user');
    const dialog = addUserDialog();
    expect(dialog?.textContent).toContain('A one-time password is generated and shown once after creating.');
    await type(dialog?.querySelector<HTMLInputElement>('input[placeholder="Email"]'), 'new.person@gmail.com');
    const googleOnly = [...dialog!.querySelectorAll<HTMLElement>('label.orbit-choice')].find((label) => label.textContent === GOOGLE_SIGN_IN_ONLY);
    await click(googleOnly?.querySelector('[role="checkbox"]'), GOOGLE_SIGN_IN_ONLY);
    expect(googleOnly?.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    // The limit is stated where the administrator chooses it (§5.2): only Gmail or Workspace, and a
    // password for anyone else, because a passwordless account no Google account vouches for has no way in.
    expect(dialog?.textContent).toContain(GOOGLE_SIGN_IN_ONLY_HINT);
    expect(dialog?.textContent).toContain('must be a Gmail or Google Workspace address');
    expect(dialog?.textContent).toContain('give them a password instead');
    expect(dialog?.textContent).not.toContain('A one-time password is generated and shown once after creating.');

    await click(button(dialog, 'Create'), 'Create');
    expect(requests.filter((r) => r.path === '/admin/users' && r.method === 'POST').map((r) => r.body)).toEqual([
      { email: 'new.person@gmail.com', name: undefined, passwordless: true },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Created new.person@gmail.com');
    await vi.waitFor(() => expect(cell('new.person@gmail.com', 'Sign-in')).toBe('Google · pending'));
  });

  it('with Google sign-in off, Add user is as it was: no Google sign-in only, and a password is generated', async () => {
    googleOn = false;
    await open();
    await click(button(container, 'Add user'), 'Add user');
    const dialog = addUserDialog();
    expect(dialog?.textContent).not.toContain(GOOGLE_SIGN_IN_ONLY);
    expect(dialog?.querySelector('[role="checkbox"]')).toBeNull();
    expect(dialog?.textContent).toContain('A one-time password is generated and shown once after creating.');
  });
});
