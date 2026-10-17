// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';

/**
 * First-run setup in a real document: each field's checks as the person types and on submit — a
 * missing field, an address that is not one, a short password, a confirmation that differs and
 * follows the password it confirms — then the first account created with what was typed, the session
 * kept and the browser sent to the runner guide; a refusal said and the form kept; and once a user
 * exists, the way to sign in instead.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { api } = await import('../api');
const { SetupPage } = await import('./SetupPage');

let container: HTMLDivElement;
let root: Root | null = null;
let needsSetup: boolean;
let sentTo: string[];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/setup']}>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/login" element={<div className="signed-out">the login page</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The control a label names. */
const field = (label: string) => {
  const named = [...container.querySelectorAll('label')].find((l) => l.textContent === label);
  expect(named, `the ${label} label`).toBeTruthy();
  return document.getElementById(named!.htmlFor) as HTMLInputElement;
};
/** What describes a field: its messages, as the person reads them. */
const messages = (label: string) =>
  (field(label).getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent);
const invalid = (label: string) => field(label).getAttribute('aria-invalid') === 'true';

async function type(label: string, value: string): Promise<void> {
  const input = field(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Create account & sign in');
  expect(button).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const bootstraps = () => vi.mocked(api).mock.calls.filter(([path]) => path === '/auth/bootstrap');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  localStorage.clear();
  needsSetup = true;
  sentTo = [];
  for (const fn of Object.values(toast)) fn.mockReset();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/auth/setup-status') return { needsSetup };
    if (path === '/auth/bootstrap') return { accessToken: 'header.eyJzdWIiOiJVMSJ9.sig', refreshToken: 'refresh' };
    throw new Error(`unexpected ${path}`);
  });
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        const value: unknown = Reflect.get(real, key, real);
        return typeof value === 'function' ? value.bind(real) : value;
      },
      set: (_, key, value) => {
        if (key === 'href') sentTo.push(value as string);
        return true;
      },
    }),
  );
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container.remove();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('First-run setup', () => {
  it('an empty submit names every missing field, marks it invalid and sends nothing', async () => {
    await open();
    await submit();

    expect(messages('Email')).toEqual(['Please enter Email']);
    expect(messages('Password')).toEqual(['Please enter Password']);
    expect(messages('Confirm password')).toEqual(['Please enter Confirm password']);
    expect([invalid('Email'), invalid('Password'), invalid('Confirm password')]).toEqual([true, true, true]);
    // The name is optional: it defaults to the email name.
    expect(invalid('Name')).toBe(false);
    expect(messages('Name')).toEqual([]);
    expect(bootstraps()).toEqual([]);
  });

  it('checks each field as it is typed: an address, six characters, the same password twice', async () => {
    await open();
    await type('Email', 'not-an-email');
    await type('Password', 'abc');
    await type('Confirm password', 'abd');
    expect(messages('Email')).toEqual(['Email is not a valid email']);
    expect(messages('Password')).toEqual(['Password must be at least 6 characters']);
    expect(messages('Confirm password')).toEqual(['passwords do not match']);

    await type('Email', 'owner@example.test');
    await type('Password', 'secret1');
    await type('Confirm password', 'secret1');
    expect([invalid('Email'), invalid('Password'), invalid('Confirm password')]).toEqual([false, false, false]);
  });

  it('the confirmation follows the password it confirms, once it has been typed', async () => {
    await open();
    // Untouched, the confirmation is not checked when the password changes.
    await type('Password', 'secret1');
    expect(invalid('Confirm password')).toBe(false);

    await type('Confirm password', 'secret1');
    expect(invalid('Confirm password')).toBe(false);
    await type('Password', 'secret12');
    expect(messages('Confirm password')).toEqual(['passwords do not match']);
    await type('Password', 'secret1');
    expect(invalid('Confirm password')).toBe(false);
  });

  it('creates the first account with what was typed, keeps the session and opens the runner guide', async () => {
    await open();
    await type('Email', 'owner@example.test');
    await type('Password', 'secret1');
    await type('Confirm password', 'secret1');
    await submit();

    expect(bootstraps()).toHaveLength(1);
    // No name typed: none is sent, and the server names the account after the email.
    expect(bootstraps()[0][1]).toEqual({ method: 'POST', body: { email: 'owner@example.test', password: 'secret1' } });
    expect(localStorage.getItem('orbit_token')).toBe('header.eyJzdWIiOiJVMSJ9.sig');
    expect(sentTo).toEqual(['/runners/register']);

    await type('Name', 'First Admin');
    await submit();
    expect(bootstraps()[1][1]).toEqual({
      method: 'POST',
      body: { email: 'owner@example.test', name: 'First Admin', password: 'secret1' },
    });
  });

  // docs/managed-runner-design.md: bootstrap records a managed runner for the first account when
  // the server offers them, so setup lands where its workspace opens; otherwise, as always, the guide.
  it.each([
    ['switched on', { managedRunners: { enabled: true, contractVersion: 1 } }, '/'],
    ['switched off', { managedRunners: { enabled: false, contractVersion: 1 } }, '/runners/register'],
    ['a contract this client does not know', { managedRunners: { enabled: true, contractVersion: 2 } }, '/runners/register'],
    ['no managedRunners member', {}, '/runners/register'],
  ])('with managed runners %s, the new account lands on %#', async (_label, capabilities, landing) => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/auth/setup-status') return { needsSetup };
      if (path === '/auth/bootstrap') return { accessToken: 'header.eyJzdWIiOiJVMSJ9.sig', refreshToken: 'refresh' };
      if (path === '/auth/capabilities') return capabilities;
      throw new Error(`unexpected ${path}`);
    });
    await open();
    await type('Email', 'owner@example.test');
    await type('Password', 'secret1');
    await type('Confirm password', 'secret1');
    await submit();
    expect(sentTo).toEqual([landing]);
  });

  it('a refused setup says why and keeps the form', async () => {
    await open();
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/auth/setup-status') return { needsSetup: true };
      throw new ApiError('setup was already completed', 409);
    });
    await type('Email', 'owner@example.test');
    await type('Password', 'secret1');
    await type('Confirm password', 'secret1');
    await submit();

    expect(toast.error).toHaveBeenCalledWith("Couldn't create the account", 'setup was already completed');
    expect(sentTo).toEqual([]);
    expect(field('Email').value).toBe('owner@example.test');
  });

  it('once a user exists, it sends the visitor to sign in', async () => {
    needsSetup = false;
    await open();
    expect(container.querySelector('.signed-out')?.textContent).toBe('the login page');
  });
});
