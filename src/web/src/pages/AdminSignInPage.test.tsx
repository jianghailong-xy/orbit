// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';

/**
 * Admin → Sign-in (docs/google-sign-in-design.md §7.1): the Google OAuth client and the sign-up
 * policy, saved with PUT /admin/sign-in/google and read back with GET. The secret is written, never
 * read: the field is always empty and only says whether one is saved, and a save that leaves it
 * empty keeps the saved one. Choosing open sign-up says that any Google account can open an account
 * here; the redirect URI to register is shown with a Copy button. Over a stand-in for the server that
 * keeps the setting the way SignInProvidersService does.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { AdminSignInPage, INCOMPLETE_WARNING, OPEN_SIGNUP_WARNING } = await import('./AdminSignInPage');

const REDIRECT_URI = 'https://orbit.example.com/api/auth/google/callback';
const SECRET = 'GOCSPX-never-shown-again';

/** The `sign_in_provider` row the stand-in keeps: the secret as stored, which no answer carries. */
let stored: { enabled: boolean; clientId: string; secret: string; signupPolicy: 'EXISTING_ACCOUNTS' | 'OPEN' } | null;
let readable: boolean;
let puts: unknown[];
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const settings = () => ({
  enabled: stored?.enabled ?? false,
  clientId: stored?.clientId ?? '',
  hasSecret: (stored?.secret ?? '') !== '',
  signupPolicy: stored?.signupPolicy ?? 'EXISTING_ACCOUNTS',
  redirectUri: REDIRECT_URI,
});

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

async function type(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The page as a fresh visit draws it: a new query client, so everything it shows is read from the server. */
async function open(): Promise<void> {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/admin/sign-in']}>
        <QueryClientProvider client={client}>
          <AdminSignInPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const field = (label: string) => {
  const forId = [...container!.querySelectorAll('label')].find((l) => l.textContent === label)?.htmlFor;
  return forId ? container!.querySelector<HTMLInputElement>(`[id="${forId}"]`) : null;
};
const switchControl = () => container!.querySelector<HTMLElement>('[role="switch"]');
const radio = (label: string) =>
  [...container!.querySelectorAll<HTMLElement>('label.orbit-choice')].find((l) => l.textContent?.startsWith(label))?.querySelector<HTMLElement>('[role="radio"]');
const status = () => container!.querySelector('.orbit-card-head .orbit-badge, .orbit-card-head span:last-child')?.textContent;
const button = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(toast)) fn.mockReset();
  stored = null;
  readable = true;
  puts = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    if (path === '/admin/sign-in/google' && method === 'GET') {
      if (!readable) throw new ApiError('admin only', 403);
      return settings();
    }
    if (path === '/admin/sign-in/google' && method === 'PUT') {
      const body = options.body as { enabled: boolean; clientId: string; clientSecret?: string; signupPolicy: 'EXISTING_ACCOUNTS' | 'OPEN' };
      puts.push(structuredClone(body));
      stored = {
        enabled: body.enabled,
        clientId: body.clientId,
        secret: body.clientSecret ?? stored?.secret ?? '',
        signupPolicy: body.signupPolicy,
      };
      return settings();
    }
    if (path === '/auth/methods') return { password: true, google: false, googleSignup: false };
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

describe('Admin → Sign-in', { timeout: 60_000 }, () => {
  it('reads the saved setting: Off, no client yet, a secret field that says none is saved, existing accounts only, and the redirect URI to register', async () => {
    await open();
    expect(status()).toBe('Off');
    expect(switchControl()?.getAttribute('aria-checked')).toBe('false');
    expect(field('Client ID')?.value).toBe('');
    expect(field('Client secret')?.type).toBe('password');
    expect(field('Client secret')?.value).toBe('');
    expect(field('Client secret')?.placeholder).toBe('Paste the client secret');
    expect(radio('Existing accounts only')?.getAttribute('aria-checked')).toBe('true');
    expect(container!.textContent).not.toContain(OPEN_SIGNUP_WARNING);
    expect(container!.querySelector('.admin-signin-redirect code')?.textContent).toBe(REDIRECT_URI);
    expect(button('Save')?.disabled).toBe(true);
  });

  it('saves the whole setting in one PUT, the secret only when typed, and reads back what the server holds — the secret never', async () => {
    await open();
    await click(switchControl(), 'the switch');
    expect(container!.textContent).toContain(INCOMPLETE_WARNING);
    await type(field('Client ID'), '  1234-abc.apps.googleusercontent.com ');
    await type(field('Client secret'), SECRET);
    await click(radio('Anyone with a Google account'), 'open sign-up');
    expect(container!.querySelector('[role="note"]')?.textContent).toBe(OPEN_SIGNUP_WARNING);
    expect(container!.textContent).not.toContain(INCOMPLETE_WARNING);

    await click(button('Save'), 'Save');
    expect(puts).toEqual([
      { enabled: true, clientId: '1234-abc.apps.googleusercontent.com', signupPolicy: 'OPEN', clientSecret: SECRET },
    ]);
    expect(toast.success).toHaveBeenCalledWith('Sign-in settings saved');
    // What the server answered is what the page shows: on, and a secret saved but not shown.
    expect(status()).toBe('On');
    expect(field('Client secret')?.value).toBe('');
    expect(field('Client secret')?.placeholder).toBe('Saved — enter a new one to replace it');
    expect(container!.textContent).toContain('A secret is saved. It is never shown again; leave this empty to keep it.');
    expect(container!.innerHTML).not.toContain(SECRET);
    expect(button('Save')?.disabled).toBe(true);

    // A visit afterwards reads the same back.
    await open();
    expect(status()).toBe('On');
    expect(switchControl()?.getAttribute('aria-checked')).toBe('true');
    expect(field('Client ID')?.value).toBe('1234-abc.apps.googleusercontent.com');
    expect(radio('Anyone with a Google account')?.getAttribute('aria-checked')).toBe('true');
    expect(container!.querySelector('[role="note"]')?.textContent).toBe(OPEN_SIGNUP_WARNING);
    expect(container!.innerHTML).not.toContain(SECRET);

    // A save without a secret keeps the saved one.
    await type(field('Client ID'), '5678-def.apps.googleusercontent.com');
    await click(radio('Existing accounts only'), 'existing accounts only');
    await click(button('Save'), 'Save');
    expect(puts[1]).toEqual({ enabled: true, clientId: '5678-def.apps.googleusercontent.com', signupPolicy: 'EXISTING_ACCOUNTS' });
    expect(stored?.secret).toBe(SECRET);
    expect(status()).toBe('On');
    expect(container!.textContent).not.toContain(OPEN_SIGNUP_WARNING);
  });

  it('Copy puts the redirect URI on the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await open();
    await click(button('Copy'), 'Copy');
    expect(writeText).toHaveBeenCalledWith(REDIRECT_URI);
    expect(toast.success).toHaveBeenCalledWith('Redirect URI copied');
  });

  it('someone the server refuses sees why, and no form', async () => {
    readable = false;
    await open();
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('admin only');
    expect(container!.querySelector('form')).toBeNull();
  });
});
