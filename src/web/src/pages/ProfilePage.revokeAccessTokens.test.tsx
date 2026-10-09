// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Profile → Change password and personal access tokens (docs/personal-access-token-design.md §11.3):
 * a password change leaves every token working unless "Also revoke all my access tokens" is ticked,
 * which is never ticked to begin with; ticked, the request asks for it and the page says how many
 * tokens it ended.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { ProfilePage } = await import('./ProfilePage');

const ME = { id: 'U1', email: 'owner@example.test', name: 'Owner', createdAt: '2026-01-01T00:00:00.000Z', avatarUpdatedAt: null };

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient;
let revoked = 0;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={['/settings/profile']}>
        <QueryClientProvider client={client}>
          <ProfilePage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(container!.textContent).toContain(ME.email));
  await settle();
}

/** The Change password card: a region named by its title. */
const form = () =>
  [...container!.querySelectorAll<HTMLElement>('section[aria-labelledby]')].find(
    (card) => document.getElementById(card.getAttribute('aria-labelledby')!)?.textContent === 'Change password',
  )!;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** The checkbox its label names. */
const checkbox = () =>
  [...form().querySelectorAll<HTMLElement>('[role="checkbox"]')].find(
    (box) => box.closest('label')?.textContent === 'Also revoke all my access tokens',
  );
const ticked = () => checkbox()?.getAttribute('aria-checked') === 'true';

async function changePassword(): Promise<void> {
  const [current, next, confirm] = [...form().querySelectorAll<HTMLInputElement>('input[type="password"]')];
  await type(current, 'the-old-password');
  await type(next, 'the-new-password');
  await type(confirm, 'the-new-password');
  const submit = [...form().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Change password');
  await click(submit);
  await vi.waitFor(() =>
    expect(vi.mocked(api).mock.calls.some(([path]) => path === '/auth/change-password')).toBe(true));
  await settle();
}

const sent = () => vi.mocked(api).mock.calls.find(([path]) => path === '/auth/change-password')?.[1];

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
  revoked = 0;
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options?: { body?: unknown }) => {
    if (path === '/users/me') return ME;
    if (path === '/auth/change-password') {
      const asked = (options?.body as { revokeAccessTokens?: boolean }).revokeAccessTokens === true;
      return { success: true, revokedAccessTokens: asked ? revoked : 0 };
    }
    throw new Error(`unexpected ${path}`);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['access-tokens'], { tokens: [] });
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

describe('Profile → Change password → Also revoke all my access tokens', { timeout: 60_000 }, () => {
  it('is offered unticked, says what ticking it does, and left alone the request revokes nothing', async () => {
    await open();
    expect(checkbox()).toBeTruthy();
    expect(ticked()).toBe(false);
    expect(form().textContent).toContain('Scripts and the orbit CLI using them stop working at once. Unticked, they keep working.');

    await changePassword();
    expect(sent()).toEqual({
      method: 'POST',
      body: { currentPassword: 'the-old-password', newPassword: 'the-new-password' },
    });
    expect(toast.success).toHaveBeenCalledWith('Password changed');
    expect(client.getQueryState(['access-tokens'])?.isInvalidated).toBe(false);
  });

  it('ticked, the request asks for it, the page says how many tokens it revoked, and the token list is read again', async () => {
    revoked = 3;
    await open();
    await click(checkbox());
    expect(ticked()).toBe(true);

    await changePassword();
    expect(sent()).toEqual({
      method: 'POST',
      body: { currentPassword: 'the-old-password', newPassword: 'the-new-password', revokeAccessTokens: true },
    });
    expect(toast.success).toHaveBeenCalledWith('Password changed', '3 access tokens revoked');
    expect(client.getQueryState(['access-tokens'])?.isInvalidated).toBe(true);
    // The form starts over, the box unticked again.
    expect(ticked()).toBe(false);
  });

  it('ticked with no token to revoke, it says only that the password changed', async () => {
    await open();
    await click(checkbox());
    await changePassword();
    expect((sent()!.body as { revokeAccessTokens?: boolean }).revokeAccessTokens).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('Password changed');
  });
});
