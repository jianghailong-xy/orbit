// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';

/**
 * Admin → Email (docs/welcome-email-design.md §3.1): the Resend key, From, Reply-To and the welcome
 * toggle, saved with PUT /admin/email and read back with GET. The key is written, never read: the field
 * is always empty and says whether one is saved, and a save that leaves it empty keeps it. Off says what
 * is missing; a key PROVIDER_SECRET_KEY can no longer decrypt is a warning asking for it again. Send
 * test email shows what Resend answered; the last seven days show how many were sent and which failed.
 * Over a stand-in for the server that keeps the setting the way EmailSettingsService does.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { AdminEmailPage, KEY_UNREADABLE_WARNING } = await import('./AdminEmailPage');

const KEY = 're_never_shown_again';

let stored: { enabled: boolean; key: string; fromAddress: string; replyTo: string; welcomeEnabled: boolean };
let keyUnreadable: boolean;
let readable: boolean;
let testAnswer: unknown;
let failures: Array<{ email: string; at: string; error: string }>;
let requests: Array<{ path: string; method: string; body?: unknown }>;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

const settings = () => {
  const missing = [
    ...(stored.enabled ? [] : ['SWITCH']),
    ...(stored.key ? (keyUnreadable ? ['API_KEY_UNREADABLE'] : []) : ['API_KEY']),
    ...(stored.fromAddress ? [] : ['FROM']),
  ];
  return {
    enabled: stored.enabled,
    hasApiKey: stored.key !== '',
    apiKeyUnreadable: keyUnreadable,
    fromAddress: stored.fromAddress,
    replyTo: stored.replyTo,
    replyToDefault: 'admin@example.com',
    welcomeEnabled: stored.welcomeEnabled,
    on: missing.length === 0,
    missing,
    lastWeek: { sent: 12, failed: failures.length, failures },
  };
};

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
      <MemoryRouter initialEntries={['/admin/email']}>
        <QueryClientProvider client={client}>
          <AdminEmailPage />
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
const switches = () => [...container!.querySelectorAll<HTMLElement>('[role="switch"]')];
const status = () => container!.querySelector('.orbit-card-head .orbit-badge, .orbit-card-head span:last-child')?.textContent;
const button = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const puts = () => requests.filter((r) => r.method === 'PUT').map((r) => r.body);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(toast)) fn.mockReset();
  stored = { enabled: false, key: '', fromAddress: '', replyTo: '', welcomeEnabled: true };
  keyUnreadable = false;
  readable = true;
  failures = [];
  testAnswer = { ok: true, to: 'admin@example.com', resendId: '4ef9a417-c33c' };
  requests = [];
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ path, method, body: structuredClone(options.body) });
    if (path === '/admin/email' && method === 'GET') {
      if (!readable) throw new ApiError('admin only', 403);
      return settings();
    }
    if (path === '/admin/email' && method === 'PUT') {
      const body = options.body as { enabled: boolean; apiKey?: string; fromAddress: string; replyTo: string; welcomeEnabled: boolean };
      stored = { enabled: body.enabled, key: body.apiKey ?? stored.key, fromAddress: body.fromAddress, replyTo: body.replyTo, welcomeEnabled: body.welcomeEnabled };
      if (body.apiKey) keyUnreadable = false;
      return settings();
    }
    if (path === '/admin/email/test' && method === 'POST') return testAnswer;
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Admin → Email', { timeout: 60_000 }, () => {
  it('reads an empty setting: Off, saying what is missing; the welcome toggle on; Reply-To falls back to the first administrator', async () => {
    await open();
    expect(container!.querySelector('h1')?.textContent).toBe('Email');
    expect(status()).toBe('Off');
    expect(container!.textContent).toContain('Add a Resend API key and a From address to send email.');
    const [channel, welcome] = switches();
    expect(channel.getAttribute('aria-checked')).toBe('false');
    expect(welcome.getAttribute('aria-checked')).toBe('true');
    expect(field('Resend API key')?.type).toBe('password');
    expect(field('Resend API key')?.value).toBe('');
    expect(field('From')?.placeholder).toBe('Orbit <orbit@example.com>');
    expect(field('Reply-To')?.placeholder).toBe('admin@example.com');
    expect(container!.textContent).toContain("Empty: the first administrator's address.");
    expect(container!.querySelector<HTMLAnchorElement>('a[href="https://resend.com/api-keys"]')?.textContent).toBe('Create a key in Resend');
    expect(button('Save')?.disabled).toBe(true);
    expect(button('Send test email')?.disabled).toBe(true);
    expect(container!.textContent).toContain('Last 7 days · Sent 12 · Failed 0');
  });

  it('saves the whole setting in one PUT, the key only when typed, and never shows the key again', async () => {
    await open();
    await click(switches()[0], 'the channel switch');
    await type(field('Resend API key'), ` ${KEY} `);
    await type(field('From'), ' Orbit <orbit@example.com> ');
    await click(button('Save'), 'Save');
    expect(puts()).toEqual([{ enabled: true, fromAddress: 'Orbit <orbit@example.com>', replyTo: '', welcomeEnabled: true, apiKey: KEY }]);
    expect(toast.success).toHaveBeenCalledWith('Email settings saved');
    expect(status()).toBe('On');
    expect(field('Resend API key')?.value).toBe('');
    expect(field('Resend API key')?.placeholder).toBe('Saved — enter a new one to replace it');
    expect(container!.innerHTML).not.toContain(KEY);

    // A save without a key keeps the saved one; the welcome toggle is its own.
    await click(switches()[1], 'the welcome switch');
    await type(field('Reply-To'), 'help@example.com');
    await click(button('Save'), 'Save');
    expect(puts()[1]).toEqual({ enabled: true, fromAddress: 'Orbit <orbit@example.com>', replyTo: 'help@example.com', welcomeEnabled: false });
    expect(stored.key).toBe(KEY);
  });

  it('Send test email shows what Resend answered: the id, or the status and its message', async () => {
    stored = { enabled: true, key: KEY, fromAddress: 'Orbit <orbit@example.com>', replyTo: '', welcomeEnabled: true };
    await open();
    expect(button('Send test email')?.disabled).toBe(false);
    await click(button('Send test email'), 'Send test email');
    expect(container!.querySelector('[role="status"]')?.textContent).toBe('Test email sent to admin@example.com — Resend id 4ef9a417-c33c');

    testAnswer = { ok: false, to: 'admin@example.com', status: 403, error: 'The example.com domain is not verified. Please, add and verify your domain.' };
    await click(button('Send test email'), 'Send test email');
    const answer = container!.querySelector('[role="status"]');
    expect(answer?.textContent).toBe("Couldn't send the test email: Resend answered 403 — The example.com domain is not verified. Please, add and verify your domain.");
    expect(answer?.className).toContain('admin-email-result-error');

    // With unsaved changes the test waits for a save: it sends with what is saved.
    await type(field('From'), 'Other <other@example.com>');
    expect(button('Send test email')?.disabled).toBe(true);
  });

  it('a key PROVIDER_SECRET_KEY can no longer decrypt is a warning asking for it again', async () => {
    stored = { enabled: true, key: KEY, fromAddress: 'Orbit <orbit@example.com>', replyTo: '', welcomeEnabled: true };
    keyUnreadable = true;
    await open();
    expect(status()).toBe('Off');
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(KEY_UNREADABLE_WARNING);
    expect(field('Resend API key')?.placeholder).toBe('Not readable — paste the API key again');
    await type(field('Resend API key'), KEY);
    await click(button('Save'), 'Save');
    expect(status()).toBe('On');
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it('the last seven days: Show failures lists the address, the time and the error', async () => {
    failures = [{ email: 'jordan@example.org', at: '2026-11-11T04:21:00.000Z', error: '422 Invalid `to` field.' }];
    await open();
    expect(container!.textContent).toContain('Last 7 days · Sent 12 · Failed 1');
    expect(container!.querySelector('.admin-email-failures')).toBeNull();
    await click(button('Show failures'), 'Show failures');
    const item = container!.querySelector('.admin-email-failures li')?.textContent ?? '';
    expect(item).toMatch(/^jordan@example\.org · Nov 11, 2026, \d{1,2}:21 [AP]M · 422 Invalid `to` field\.$/);
  });

  it('someone the server refuses sees why, and no form', async () => {
    readable = false;
    await open();
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain('admin only');
    expect(container!.querySelector('form')).toBeNull();
  });
});
