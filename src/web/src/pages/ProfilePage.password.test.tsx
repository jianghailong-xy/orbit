// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Profile → Sign-in methods → Password → Change, in a real document: the page itself has no password
 * field, the row's Change opens the dialog; each check, as the person types and on submit (Enter in a
 * field submits too), the confirmation following the new password, the request a valid form sends, the
 * dialog closing once the password has changed, a refusal said inside a dialog that stays open, and a
 * fresh form each time it opens.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { ApiError } = await import('../api');
const { ProfilePage } = await import('./ProfilePage');
const { CHANGE_PASSWORD_BUTTON } = await import('../components/SignInMethodsCard');

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

const dialog = () => document.body.querySelector<HTMLElement>('.change-password-dialog[data-open]');
const buttonIn = (within: ParentNode | null | undefined, label: string) =>
  [...(within?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.trim() === label);

async function click(element: Element | null | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

/** The Password row's Change, and the dialog it opens. */
async function openDialog(): Promise<void> {
  await click(buttonIn(container.querySelector('[data-method="password"]'), CHANGE_PASSWORD_BUTTON), 'Change');
  expect(dialog(), 'the Change password dialog').toBeTruthy();
}

async function fillIn(current: string, next: string, confirm = next): Promise<void> {
  await type('Current password', current);
  await type('New password', next);
  await type('Confirm new password', confirm);
}

const field = (label: string) => {
  const named = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
  expect(named, `the ${label} label`).toBeTruthy();
  return document.getElementById(named!.htmlFor) as HTMLInputElement;
};
/** The field's error messages: what its help says, not its standing hint. */
const messages = (label: string) =>
  (field(label).getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id.endsWith('_help'))
    .map((id) => document.getElementById(id)?.textContent);
const hint = (label: string) => document.getElementById(`${field(label).id}_extra`)?.textContent;
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
  document.body.innerHTML = '';
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Profile → Change password', () => {
  it('the page has no password field; the Password row\'s Change opens the dialog, focus in Current password', async () => {
    await open();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(dialog()).toBeNull();

    await openDialog();
    expect(document.activeElement).toBe(field('Current password'));
    expect(LABELS.map((label) => field(label).value)).toEqual(['', '', '']);
    expect(hint('New password')).toBe('At least 6 characters');
  });

  it('submitted empty, each field says what it needs and nothing is sent', async () => {
    await open();
    await openDialog();
    await submitFrom('Current password');
    expect(LABELS.map(messages)).toEqual([
      ['Enter your current password'],
      ['Enter a new password'],
      ['Confirm your new password'],
    ]);
    expect(LABELS.map((label) => field(label).getAttribute('aria-invalid'))).toEqual(['true', 'true', 'true']);
    expect(changes()).toEqual([]);
    expect(dialog()).toBeTruthy();
  });

  it('a short new password and a confirmation that differs are said as they are typed; the confirmation follows the new password', async () => {
    await open();
    await openDialog();
    await type('New password', 'abc');
    await type('Confirm new password', 'abcdef');
    expect(messages('New password')).toEqual(['At least 6 characters']);
    expect(hint('New password')).toBeUndefined();
    expect(messages('Confirm new password')).toEqual(['Passwords do not match']);

    await type('New password', 'abcdef');
    expect(messages('New password')).toEqual([]);
    expect(messages('Confirm new password')).toEqual([]);
    expect(field('Confirm new password').hasAttribute('aria-invalid')).toBe(false);
  });

  it('a valid form sends the current and the new password, the dialog closes, and the next one starts empty', async () => {
    await open();
    await openDialog();
    await fillIn('the-old-password', 'the-new-password');
    await submitFrom('Confirm new password');

    expect(changes()).toHaveLength(1);
    expect(changes()[0][1]).toEqual({
      method: 'POST',
      body: { currentPassword: 'the-old-password', newPassword: 'the-new-password' },
    });
    expect(toast.success).toHaveBeenCalledWith('Password changed');
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await openDialog();
    expect(LABELS.map((label) => field(label).value)).toEqual(['', '', '']);
    expect(LABELS.map(messages)).toEqual([[], [], []]);
  });

  it('refused, the reason is said inside the dialog, which stays open with what was typed', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/users/me') return ME;
      if (path === '/auth/change-password') throw new ApiError('current password is incorrect', 400);
      throw new Error(`unexpected ${path}`);
    });
    await open();
    await openDialog();
    await fillIn('not-it', 'the-new-password');
    await click(buttonIn(dialog(), 'Change password'), 'the dialog\'s Change password');

    expect(changes()).toHaveLength(1);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain('current password is incorrect');
    expect(LABELS.map((label) => field(label).value)).toEqual(['not-it', 'the-new-password', 'the-new-password']);
    expect(document.activeElement).toBe(field('Current password'));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('Cancel drops what was typed: opened again, the form is empty and nothing was sent', async () => {
    await open();
    await openDialog();
    await fillIn('the-old-password', 'the-new-password');
    await click(buttonIn(dialog(), 'Cancel'), 'Cancel');
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await openDialog();
    expect(LABELS.map((label) => field(label).value)).toEqual(['', '', '']);
    expect(changes()).toEqual([]);
  });
});
