// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type DeviceEnrollment } from '../api';
import { meQuery } from '../lib/queries';

/**
 * /enroll?code= — the browser half of `orbit register`, in a real document over what
 * GET /runners/device/:userCode answers: the machine a terminal asks to add, approved or denied, a
 * runner of the same name already there, a request already decided, and one that ran out.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getDeviceEnrollment: vi.fn(),
  approveDeviceEnrollment: vi.fn(),
  denyDeviceEnrollment: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { approveDeviceEnrollment, denyDeviceEnrollment, getDeviceEnrollment } = await import('../api');
const { EnrollPage, EnrollmentDetails, countdown } = await import('./EnrollPage');

const CODE = 'B7RXA-EFTR7';
const RUNNER_ID = '0199f0a8-3c2e-7b51-9a6e-1f2d3c4b5a69';

const enrollment = (over: Partial<DeviceEnrollment> = {}): DeviceEnrollment => ({
  userCode: CODE,
  name: 'devbox',
  hostname: 'vmi3337007',
  labels: [],
  maxConcurrent: 16,
  status: 'PENDING',
  nameConflict: false,
  existingLastSeenAt: null,
  runnerId: null,
  createdAt: new Date(Date.now() - 19_000).toISOString(),
  expiresAt: new Date(Date.now() + 581_000).toISOString(),
  ...over,
});

/** The row of the facts list whose label is `label`, as text; undefined when there is none. */
const row = (within: ParentNode, label: string): string | undefined =>
  [...within.querySelectorAll('.enroll-facts > div')].find((r) => r.querySelector('dt')?.textContent === label)
    ?.querySelector('dd')?.textContent ?? undefined;

const details = (info: DeviceEnrollment, extra: { account?: string; expiresIn?: number | null } = {}) => {
  const html = document.createElement('div');
  html.innerHTML = renderToStaticMarkup(<EnrollmentDetails info={info} {...extra} />);
  return html;
};

describe('what the approval page shows of the machine', () => {
  it('shows the chosen runner name apart from the machine hostname', () => {
    const html = details(enrollment());
    expect(row(html, 'Machine')).toBe('devbox');
    expect(row(html, 'Hostname')).toBe('vmi3337007');
    expect(html.textContent).not.toContain('Workspaces');
  });

  it('does not repeat the hostname when it is also the runner name, and leaves out labels it has none of', () => {
    const html = details(enrollment({ name: 'vmi3337007' }));
    expect(row(html, 'Machine')).toBe('vmi3337007');
    expect(row(html, 'Hostname')).toBeUndefined();
    expect(row(html, 'Labels')).toBeUndefined();
    expect(html.textContent).not.toContain('—');
  });

  it('shows the labels it was registered with, the account it joins, and the time left', () => {
    const html = details(enrollment({ labels: ['gpu', 'linux'] }), { account: 'alex@example.com', expiresIn: 581_000 });
    expect(row(html, 'Labels')).toBe('gpulinux');
    expect(row(html, 'Account')).toBe('alex@example.com');
    expect(row(html, 'Expires')).toBe('in 9:41');
    expect(html.querySelector('.enroll-fact-warning')).toBeNull();
  });

  it('marks the last minute', () => {
    const html = details(enrollment(), { expiresIn: 42_000 });
    expect(row(html, 'Expires')).toBe('in 0:42');
    expect(html.querySelector('.enroll-fact-warning')?.textContent).toBe('in 0:42');
    expect(countdown(600_000)).toBe('10:00');
    expect(countdown(-5)).toBe('0:00');
  });
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function open(search: string): Promise<HTMLElement> {
  window.history.replaceState(null, '', `/enroll${search}`);
  container = document.createElement('div');
  document.body.appendChild(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(meQuery().queryKey, { id: 'u1', email: 'alex@example.com', name: 'Alex', createdAt: '', preferences: {} });
  const next = createRoot(container);
  root = next;
  await act(async () =>
    next.render(
      <QueryClientProvider client={qc}>
        <EnrollPage />
      </QueryClientProvider>,
    ),
  );
  // Loading shows a status spinner until the request is read.
  await vi.waitFor(() => expect(container!.querySelector('[role="status"]')).toBeNull());
  await settle();
  return container;
}

async function close(): Promise<void> {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  container = null;
}

const button = (within: ParentNode, label: string) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);

async function click(element: HTMLElement | undefined, what: string): Promise<void> {
  expect(element, `${what} is on screen`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
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
  for (const fn of [getDeviceEnrollment, approveDeviceEnrollment, denyDeviceEnrollment]) vi.mocked(fn).mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
});

afterEach(async () => {
  await close();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('/enroll', { timeout: 30_000 }, () => {
  it('reads the request the code names: the code to compare, the machine, the account it joins and the time left', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment());
    const page = await open(`?code=${CODE}`);

    expect(getDeviceEnrollment).toHaveBeenCalledWith(CODE);
    expect(page.querySelector('h1')?.textContent).toBe('Approve this machine?');
    expect(page.textContent).toContain('Approve only if that was you, just now.');
    expect(page.querySelector('.enroll-code')?.textContent).toBe(CODE);
    expect(page.textContent).toContain('It should match the code in your terminal.');
    expect(row(page, 'Machine')).toBe('devbox');
    expect(row(page, 'Account')).toBe('alex@example.comSwitch');
    expect(row(page, 'Expires')).toMatch(/^in 9:4\d$/);
    expect(button(page, 'Approve')!.disabled).toBe(false);
    expect(button(page, 'Deny')!.disabled).toBe(false);
  });

  it('approving says the machine is registered and opens its page', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment());
    vi.mocked(approveDeviceEnrollment).mockResolvedValue({ ok: true, name: 'devbox', replaced: false, runnerId: RUNNER_ID });
    const page = await open(`?code=${CODE}`);

    await click(button(page, 'Approve'), 'Approve');
    expect(approveDeviceEnrollment).toHaveBeenCalledWith(CODE);
    expect(denyDeviceEnrollment).not.toHaveBeenCalled();
    expect(page.querySelector('h1')?.textContent).toBe('Machine registered');
    expect(page.textContent).toContain('devbox is on your account. Go back to the terminal');
    expect(page.textContent).toContain('Next: sign in its coding CLIs');
    const open_ = [...page.querySelectorAll('a')].find((a) => a.textContent === 'Open machine');
    expect(open_?.getAttribute('href')).toMatch(/^\/runners\/[0-9A-Za-z]+$/);
    expect(open_?.getAttribute('href')).not.toContain(RUNNER_ID);
    expect(button(page, 'Approve')).toBeUndefined();
  });

  it('denying says nothing was added and the terminal stops', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment());
    vi.mocked(denyDeviceEnrollment).mockResolvedValue({ ok: true, name: 'devbox' });
    const page = await open(`?code=${CODE}`);

    await click(button(page, 'Deny'), 'Deny');
    expect(denyDeviceEnrollment).toHaveBeenCalledWith(CODE);
    expect(approveDeviceEnrollment).not.toHaveBeenCalled();
    expect(page.querySelector('h1')?.textContent).toBe('Request denied');
    expect(page.textContent).toContain('Nothing was added to your account.');
    expect(button(page, 'Deny')).toBeUndefined();
  });

  it('a runner of the same name: says when it was last online, what re-registering does, and asks in red', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(
      enrollment({ nameConflict: true, existingLastSeenAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
    );
    const page = await open(`?code=${CODE}`);
    expect(page.querySelector('h1')?.textContent).toBe('Re-register this machine?');
    const alert = page.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).toContain('"devbox" is already on your account');
    expect(alert).toContain('Last online 3d ago.');
    expect(alert).toContain('the old one stops working');
    expect(alert).toContain('orbit register --name <new-name>');
    expect(button(page, 'Re-register')!.className).toContain('enroll-submit-danger');
    expect(button(page, 'Deny')).toBeTruthy();
  });

  it('a request already decided opens on its decision', async () => {
    for (const [status, says] of [['APPROVED', 'Machine registered'], ['DENIED', 'Request denied']] as const) {
      vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment({ status, runnerId: status === 'APPROVED' ? RUNNER_ID : null }));
      const page = await open(`?code=${CODE}`);
      expect(page.querySelector('h1')?.textContent, status).toBe(says);
      expect(button(page, 'Approve'), status).toBeUndefined();
      await close();
    }
  });

  it('an approval the server refuses is said in a toast, and the request stays to decide', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment());
    vi.mocked(approveDeviceEnrollment).mockRejectedValue(
      new ApiError('This registration request was denied — run `orbit register` again', 409, 'DEVICE_ENROLLMENT_DECIDED'),
    );
    const page = await open(`?code=${CODE}`);
    await click(button(page, 'Approve'), 'Approve');
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't register this machine",
      'This registration request was denied — run `orbit register` again',
    );
    expect(page.querySelector('h1')?.textContent).toBe('Approve this machine?');
  });

  it('a request gone while the page sat open turns into the expired page instead of a toast', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment());
    vi.mocked(approveDeviceEnrollment).mockRejectedValue(new ApiError('enrollment request not found or expired', 404));
    const page = await open(`?code=${CODE}`);
    await click(button(page, 'Approve'), 'Approve');
    expect(toast.error).not.toHaveBeenCalled();
    expect(page.querySelector('h1')?.textContent).toBe('This link has expired');
  });

  it('the countdown running out turns the request into the expired page', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment({ expiresAt: new Date(Date.now() + 2_000).toISOString() }));
    const page = await open(`?code=${CODE}`);
    expect(page.querySelector('h1')?.textContent).toBe('Approve this machine?');
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(page.querySelector('h1')?.textContent).toBe('This link has expired');
    expect(button(page, 'Approve')).toBeUndefined();
  });

  it('an expired or unknown request, and a link with no code, say how to get a new one', async () => {
    vi.mocked(getDeviceEnrollment).mockRejectedValue(new ApiError('enrollment request not found or expired', 404));
    const expired = await open(`?code=${CODE}`);
    expect(expired.querySelector('h1')?.textContent).toBe('This link has expired');
    expect(expired.textContent).toContain('A register link works once, for 10 minutes.');
    expect(expired.textContent).not.toContain('enrollment request not found');
    expect(button(expired, 'Approve')).toBeUndefined();
    await close();

    vi.mocked(getDeviceEnrollment).mockClear();
    const missing = await open('');
    expect(getDeviceEnrollment).not.toHaveBeenCalled();
    expect(missing.querySelector('h1')?.textContent).toBe('This link is missing its code');
    expect(missing.textContent).toContain('Open the link that orbit register printed in your terminal.');
  });
});
