// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiSupportSpaces } from '@orbit/shared';
import type { SignInMethods } from '../lib/queries';

/**
 * Admin → Users → Update wiki documents… (contracts/wiki.contract.json `plan.jobs.rebuild.support`, owner's call
 * 2026-10-17): an administrator asks for the documents of an account's space again, for support. The dialog lists the
 * account's spaces with their version in force and how far its documents are written; only one with a plan in force and
 * no build on its way can be picked; the reason is required and sent with the request, which the server records. Over a
 * stand-in for the server's `/api`.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { AdminUsersPage, UPDATE_DOCUMENTS, UPDATE_WIKI_DOCS } = await import('./AdminUsersPage');

interface Row {
  id: string;
  email: string;
  name: string;
  role: 'ADMIN' | 'MEMBER';
  createdAt: string;
  signInMethods: SignInMethods;
  disabledAt: string | null;
}

const password = { password: true, google: null };
const users: Row[] = [
  { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', createdAt: '2026-01-05T12:00:00.000Z', signInMethods: password, disabledAt: null },
  { id: 'U2', email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: '2026-02-01T12:00:00.000Z', signInMethods: password, disabledAt: null },
];

let spaces: WikiSupportSpaces;
let refusal: string | null;
let created: boolean;
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
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
/** The dialog, while it is open. */
const dialog = () =>
  [...document.body.querySelectorAll<HTMLElement>('.orbit-overlay')].find((overlay) =>
    overlay.querySelector('.orbit-overlay-title')?.textContent?.startsWith('Update wiki documents'));
/** A space's choice in the dialog: its title and the line under it, and whether it can be picked. */
const choices = () =>
  [...(dialog()?.querySelectorAll<HTMLElement>('label.orbit-choice') ?? [])].map((choice) => ({
    title: choice.querySelector('.admin-signin-choice')?.textContent,
    state: choice.querySelector('.admin-signin-hint')?.textContent,
    disabled: choice.querySelector('[role="radio"]')?.hasAttribute('data-disabled') ?? false,
  }));
const radio = (title: string) =>
  [...(dialog()?.querySelectorAll<HTMLElement>('label.orbit-choice') ?? [])]
    .find((choice) => choice.querySelector('.admin-signin-choice')?.textContent === title)
    ?.querySelector<HTMLElement>('[role="radio"]');
const go = () => button(dialog()?.querySelector('.orbit-overlay-footer'), UPDATE_DOCUMENTS);
const builds = () => requests.filter((r) => r.path.endsWith('/plan/build'));

async function openDialog(email: string): Promise<void> {
  await click(rowOf(email)?.querySelector(`button[aria-label="More actions for ${email}"]`), `${email}'s menu`);
  await click(menuItems().find((item) => item.textContent?.trim() === UPDATE_WIKI_DOCS), `${UPDATE_WIKI_DOCS} in ${email}'s menu`);
  await vi.waitFor(() => expect(dialog()?.querySelector('.orbit-overlay-title')?.textContent).toBe(`Update wiki documents — ${email}`));
  await settle();
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
  spaces = {
    userId: 'U2',
    serverExecutes: true,
    spaces: [
      { id: 'S1', title: 'cbai docs', confirmedVersion: 1, docs: { written: 0, total: 34 }, building: false },
      { id: 'S2', title: 'notes', confirmedVersion: null, docs: null, building: false },
      { id: 'S3', title: 'orbit', confirmedVersion: 4, docs: { written: 12, total: 30 }, building: true },
    ],
  };
  refusal = null;
  created = true;
  requests = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: options.body });
    if (path === '/admin/users' && method === 'GET') return structuredClone(users);
    if (path === '/auth/methods') return { password: true, google: false, googleSignup: false };
    if (path === '/users/me') return { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN' };
    if (path === '/admin/wiki/users/U2/spaces' && method === 'GET') return structuredClone(spaces);
    const build = /^\/admin\/wiki\/spaces\/(S\d)\/plan\/build$/.exec(path);
    if (build && method === 'POST') {
      if (refusal) throw new Error(refusal);
      return { created, ownerId: 'U2', job: { id: 'J1', spaceId: build[1], kind: 'build', trigger: 'support', state: 'running' } };
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

describe('Admin → Users · Update wiki documents…', { timeout: 60_000 }, () => {
  it('lists the account’s spaces by how far their documents are, and picks only one with a plan in force and no build on its way', async () => {
    await open();
    await openDialog('dev@example.test');
    expect(requests.filter((r) => r.path.startsWith('/admin/wiki/'))).toEqual([{ path: '/admin/wiki/users/U2/spaces', method: 'GET', body: undefined }]);
    expect(dialog()?.textContent).toContain('Asking is recorded with your reason.');
    expect(choices()).toEqual([
      { title: 'cbai docs', state: 'v1 in force · 0 of 34 documents written', disabled: false },
      { title: 'notes', state: 'No plan in force: nothing to write yet', disabled: true },
      { title: 'orbit', state: 'v4 in force · 12 of 30 documents written · being written now', disabled: true },
    ]);
    expect(go()?.disabled, 'nothing picked').toBe(true);
  });

  it('asks for the picked space’s documents with the reason, and says what the server answered', async () => {
    await open();
    await openDialog('dev@example.test');
    await click(radio('cbai docs'), 'the cbai docs space');
    expect(go()?.disabled, 'no reason, no request').toBe(true);
    await type(dialog()?.querySelector('textarea'), '   ');
    expect(go()?.disabled, 'a blank reason is no reason').toBe(true);
    await type(dialog()?.querySelector('textarea'), '  support: 0 of 34 documents since the build failed  ');
    expect(go()?.disabled).toBe(false);
    await click(go(), UPDATE_DOCUMENTS);
    expect(builds()).toEqual([
      { path: '/admin/wiki/spaces/S1/plan/build', method: 'POST', body: { reason: 'support: 0 of 34 documents since the build failed' } },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Updating the documents of cbai docs');
    await vi.waitFor(() => expect(dialog()).toBeUndefined());

    // A build already on its way answers the request: the dialog says so.
    created = false;
    await openDialog('dev@example.test');
    await click(radio('cbai docs'), 'the cbai docs space');
    await type(dialog()?.querySelector('textarea'), 'again');
    await click(go(), UPDATE_DOCUMENTS);
    expect(toast.success).toHaveBeenLastCalledWith('The documents of cbai docs are already being written');
  });

  it('keeps the dialog open with the server’s words when it refuses', async () => {
    // The plan in force went away meanwhile: the server's own refusal (WIKI_PLAN_UNCONFIRMED).
    refusal = 'this space has no plan its owner confirmed, so no document is written from one: the owner confirms a draft of the plan in the Wiki first.';
    await open();
    await openDialog('dev@example.test');
    await click(radio('cbai docs'), 'the cbai docs space');
    await type(dialog()?.querySelector('textarea'), 'support');
    await click(go(), UPDATE_DOCUMENTS);
    expect(toast.error).toHaveBeenCalledWith("Couldn't update the documents", refusal);
    expect(dialog(), 'the dialog stays').toBeTruthy();
  });

  it('picks nothing while the read does not say the server executes the account’s wiki', async () => {
    spaces = { ...spaces, serverExecutes: false };
    await open();
    await openDialog('dev@example.test');
    expect(dialog()?.querySelector('[role="note"]'), 'no sentence about runners').toBeNull();
    expect(choices().map((choice) => choice.disabled)).toEqual([true, true, true]);
    await type(dialog()?.querySelector('textarea'), 'support');
    expect(go()?.disabled).toBe(true);
  });

  it('says so when the account has no space, and Cancel asks for nothing', async () => {
    spaces = { userId: 'U2', serverExecutes: true, spaces: [] };
    await open();
    await openDialog('dev@example.test');
    expect(dialog()?.textContent).toContain('This account has no wiki spaces.');
    await click(button(dialog()?.querySelector('.orbit-overlay-footer'), 'Cancel'), 'Cancel');
    await vi.waitFor(() => expect(dialog()).toBeUndefined());
    expect(builds()).toEqual([]);
  });
});
