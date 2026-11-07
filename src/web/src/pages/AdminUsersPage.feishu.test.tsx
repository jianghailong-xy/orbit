// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignInMethods } from '../lib/queries';

/**
 * Admin → Users and an account's Feishu app (docs/feishu-bot-design.md §4.1): every row's menu offers Remove Feishu
 * app, which asks first, then calls DELETE /api/admin/users/:id/feishu and says what the route answered — the app
 * removed, or none to remove. Over a stand-in for the server's `/api` that keeps which accounts have an app.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { AdminUsersPage, FEISHU_APP_REMOVED, NO_FEISHU_APP, REMOVE_FEISHU_APP } = await import('./AdminUsersPage');

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
  signInMethods: SignInMethods;
  disabledAt: string | null;
}

/** The accounts with a Feishu app, by id: the stand-in removes it as FeishuAppService.removeByAdmin does. */
let withApp: Set<string>;
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
const deletes = () => requests.filter((r) => r.method === 'DELETE');

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
  withApp = new Set(['U2']);
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
    const feishu = /^\/admin\/users\/(U\d)\/feishu$/.exec(path);
    if (feishu && method === 'DELETE') return { removed: withApp.delete(feishu[1]) };
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

describe('Admin → Users · removing an account\'s Feishu app', { timeout: 60_000 }, () => {
  it('every account\'s menu offers Remove Feishu app, which asks first and removes nothing when cancelled', async () => {
    await open();
    for (const email of ['admin@example.test', 'dev@example.test', 'gina@gmail.com', 'ops@example.test']) {
      expect(await menuOf(email), email).toContain(REMOVE_FEISHU_APP);
    }
    await fromMenu('dev@example.test', REMOVE_FEISHU_APP);
    expect(confirmDialog()?.querySelector('.orbit-overlay-title')?.textContent).toContain('Remove the Feishu app of dev@example.test?');
    expect(confirmDialog()?.textContent).toContain('forgets its App ID, App Secret and owner');
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    expect(deletes()).toEqual([]);
    expect(withApp.has('U2')).toBe(true);
  });

  it('confirmed, it calls DELETE /admin/users/:id/feishu and says the app was removed', async () => {
    await open();
    await fromMenu('dev@example.test', REMOVE_FEISHU_APP);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), REMOVE_FEISHU_APP), 'Remove Feishu app in the dialog');
    expect(deletes()).toEqual([{ path: '/admin/users/U2/feishu', method: 'DELETE', body: undefined }]);
    expect(toast.success).toHaveBeenCalledWith('Feishu app removed.', 'dev@example.test');
    expect(FEISHU_APP_REMOVED).toBe('Feishu app removed.');
    expect(toast.info).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
    expect(withApp.has('U2')).toBe(false);
  });

  it('on an account without an app, the route answers removed: false, and the page says there was none', async () => {
    await open();
    await fromMenu('ops@example.test', REMOVE_FEISHU_APP);
    await click(button(confirmDialog()?.querySelector('.orbit-overlay-footer'), REMOVE_FEISHU_APP), 'Remove Feishu app in the dialog');
    expect(deletes()).toEqual([{ path: '/admin/users/U4/feishu', method: 'DELETE', body: undefined }]);
    expect(toast.info).toHaveBeenCalledWith('This account has no Feishu app.', 'ops@example.test');
    expect(NO_FEISHU_APP).toBe('This account has no Feishu app.');
    expect(toast.success).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
  });
});
