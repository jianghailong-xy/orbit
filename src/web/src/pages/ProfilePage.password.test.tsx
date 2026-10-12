// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Profile → Change password in a real document: each check, as the person types and on submit (Enter
 * in a field submits too), the confirmation following the new password, the request a valid form
 * sends, and the form starting over once the password has changed.
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

let container: HTMLDivElement;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/settings/profile']}>
        <QueryClientProvider client={qc}>
          <ProfilePage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain(ME.email));
  await settle();
}

const field = (label: string) => {
  const named = [...container.querySelectorAll('label')].find((l) => l.textContent === label);
  expect(named, `the ${label} label`).toBeTruthy();
  return document.getElementById(named!.htmlFor) as HTMLInputElement;
};
const messages = (label: string) =>
  (field(label).getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent);
const LABELS = ['Current password', 'New password', 'Confirm new password'];

async function type(label: string, value: string): Promise<void> {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submitFrom(label: string): Promise<void> {
  // Enter in a text field submits its form, as a browser does: the form's own submit.
  await act(async () => {
    field(label).form!.requestSubmit();
  });
  await settle();
}

const changes = () => vi.mocked(api).mock.calls.filter(([path]) => path === '/auth/change-password');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  for (const fn of Object.values(toast)) fn.mockReset();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/users/me') return ME;
    if (path === '/auth/change-password') return { success: true, revokedAccessTokens: 0 };
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Profile → Change password', () => {
  it('submitted empty, each field says what it needs and nothing is sent', async () => {
    await open();
    await submitFrom('Current password');
    expect(LABELS.map(messages)).toEqual([
      ['Enter your current password'],
      ['Enter a new password'],
      ['Confirm your new password'],
    ]);
    expect(LABELS.map((label) => field(label).getAttribute('aria-invalid'))).toEqual(['true', 'true', 'true']);
    expect(changes()).toEqual([]);
  });

  it('a short new password and a confirmation that differs are said as they are typed; the confirmation follows the new password', async () => {
    await open();
    await type('New password', 'abc');
    await type('Confirm new password', 'abcdef');
    expect(messages('New password')).toEqual(['At least 6 characters']);
    expect(messages('Confirm new password')).toEqual(['Passwords do not match']);

    await type('New password', 'abcdef');
    expect(messages('New password')).toEqual([]);
    expect(messages('Confirm new password')).toEqual([]);
    expect(field('Confirm new password').hasAttribute('aria-invalid')).toBe(false);
  });

  it('a valid form sends the current and the new password, then starts over', async () => {
    await open();
    await type('Current password', 'the-old-password');
    await type('New password', 'the-new-password');
    await type('Confirm new password', 'the-new-password');
    await submitFrom('Confirm new password');

    expect(changes()).toHaveLength(1);
    expect(changes()[0][1]).toEqual({
      method: 'POST',
      body: { currentPassword: 'the-old-password', newPassword: 'the-new-password' },
    });
    expect(toast.success).toHaveBeenCalledWith('Password changed');
    expect(LABELS.map((label) => field(label).value)).toEqual(['', '', '']);
    expect(LABELS.map(messages)).toEqual([[], [], []]);
  });
});
