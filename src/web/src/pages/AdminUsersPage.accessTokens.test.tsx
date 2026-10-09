// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessToken } from '../api';
import { READ_SCOPES } from '../lib/accessTokens';

/**
 * Admin → Users → a user's access tokens (docs/personal-access-token-design.md §11.4): an
 * administrator sees the tokens a user has issued — never a token itself — and revokes one through
 * the admin route, after which it lists as revoked by an administrator.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  listUserAccessTokens: vi.fn(),
  revokeUserAccessToken: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api, listUserAccessTokens, revokeUserAccessToken } = await import('../api');
const { AdminUsersPage } = await import('./AdminUsersPage');

const USERS = [
  { id: 'U1', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'U2', email: 'dev@example.test', name: 'Dev', role: 'MEMBER', createdAt: '2026-02-01T00:00:00.000Z' },
];
const token = (id: string, name: string, over: Partial<AccessToken> = {}): AccessToken => ({
  id,
  name,
  tokenHint: id.slice(-4).padStart(4, '0'),
  scopes: [...READ_SCOPES],
  workspaceIds: ['W9'],
  workspaces: [{ id: 'W9', name: 'dev-box' }],
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  createdVia: 'WEB',
  lastUsedAt: null,
  lastUsedIp: null,
  lastUsedUserAgent: null,
  revokedAt: null,
  revokedReason: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  state: 'ACTIVE',
  ...over,
});

let theirs: AccessToken[] = [];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
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

const button = (within: ParentNode, label: string) =>
  [...within.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label);
/** A dialog's accessible name: the title it is labelled by. */
const nameOf = (d: Element) => document.getElementById(d.getAttribute('aria-labelledby') ?? '')?.textContent;
const dialog = () =>
  [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => nameOf(d)?.startsWith('Access tokens'));
/** The token table's rows in the dialog (its body's rows, less the one that says it is empty). */
const tokenTableRows = () =>
  [...dialog()!.querySelectorAll<HTMLTableRowElement>('tbody tr')].filter((row) => row.cells.length > 1);
const tokenRows = () => tokenTableRows().map((row) => [...row.cells].map((cell) => cell.textContent?.trim() ?? ''));
/** An open popover or dialog by its accessible name (the title it is labelled by). */
const named = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => nameOf(d) === name);

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
  theirs = [token('T1001', 'deploy bot'), token('T2002', 'old laptop', { state: 'REVOKED', revokedReason: 'USER', revokedAt: '2026-09-20T00:00:00.000Z' })];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/admin/users') return USERS;
    throw new Error(`unexpected ${path}`);
  });
  vi.mocked(listUserAccessTokens).mockReset();
  vi.mocked(listUserAccessTokens).mockImplementation(async (userId) => ({
    tokens: userId === 'U2' ? structuredClone(theirs) : [],
  }));
  vi.mocked(revokeUserAccessToken).mockReset();
  vi.mocked(revokeUserAccessToken).mockImplementation(async (_userId, tokenId) => {
    theirs = theirs.map((t) =>
      t.id === tokenId ? { ...t, state: 'REVOKED', revokedReason: 'ADMIN', revokedAt: new Date().toISOString() } : t);
    return { id: tokenId, revokedAt: new Date().toISOString(), revokedReason: 'ADMIN' };
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

describe('Admin → Users → access tokens', { timeout: 60_000 }, () => {
  it("lists a user's tokens and revokes one through the admin route, which then lists as revoked by an administrator", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    const next = createRoot(container);
    root = next;
    await act(async () => {
      next.render(
        <MemoryRouter initialEntries={['/admin']}>
          <QueryClientProvider client={client}>
            <AdminUsersPage />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await vi.waitFor(() => expect(container!.textContent).toContain('dev@example.test'));
    await settle();

    const dev = [...container.querySelectorAll<HTMLElement>('tbody tr')].find((row) => row.textContent?.includes('dev@example.test'))!;
    await click(button(dev, 'Access tokens'), 'Access tokens');
    await vi.waitFor(() => expect(dialog() && tokenTableRows().length).toBeTruthy());
    expect(listUserAccessTokens).toHaveBeenCalledWith('U2');
    expect(nameOf(dialog()!)).toBe('Access tokens — dev@example.test');
    // The user's own workspaces, by name, which only the server could tell an administrator.
    expect(tokenRows().map((row) => [row[0], row[2], row[6]])).toEqual([
      ['deploy botorbit_pat_…1001', 'dev-box', 'Revoke'],
      ['old laptoporbit_pat_…2002', 'dev-box', ''],
    ]);

    const deploy = tokenTableRows()[0];
    await click(button(deploy, 'Revoke'), 'Revoke');
    const asked = named('Revoke “deploy bot”?');
    expect(asked).toBeTruthy();
    // Asked inside the users dialog, not beside it.
    expect(dialog()!.contains(asked!)).toBe(true);
    await click(button(asked!, 'Revoke'), 'Revoke (confirm)');

    expect(revokeUserAccessToken).toHaveBeenCalledWith('U2', 'T1001');
    expect(toast.success).toHaveBeenCalledWith('Token revoked', 'dev@example.test’s “deploy bot” stopped working.');
    await vi.waitFor(() => expect(tokenRows()[0][3]).toMatch(/^Revoked by an administrator /));
    expect(tokenRows()[0][6]).toBe('');
  });
});
