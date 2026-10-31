// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type DeviceEnrollment } from '../api';
import { encodeId } from '../lib/idCodec';
import { meQuery } from '../lib/queries';
import * as runnerCopy from '../lib/runnerCopy';

/**
 * /enroll?code= — the browser half of `orbit register`, in a real document over what
 * GET /runners/device/:userCode answers: the machine a terminal asks to add and where it asked from, approved or denied, a
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
  requesterIp: null,
  sameNetwork: false,
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

/** The facts list's labels, top to bottom. */
const labels = (within: ParentNode): string[] =>
  [...within.querySelectorAll('.enroll-facts > div > dt')].map((dt) => dt.textContent ?? '');

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

  it('says where the request came from, directly above the account, and when that is this browser\'s network', () => {
    const html = details(enrollment({ requesterIp: '203.0.113.24', sameNetwork: true }), {
      account: 'alex@example.com',
      expiresIn: 581_000,
    });
    expect(labels(html)).toEqual(['Machine', 'Hostname', 'From', 'Account', 'Expires']);
    expect(row(html, 'From')).toBe('203.0.113.24 · same network as this browser');
    expect(html.querySelector('.enroll-fact-ok')?.textContent).toBe(' · same network as this browser');
  });

  it('shows the address alone when the request came from another one, an IPv6 address as the server spells it', () => {
    for (const requesterIp of ['198.51.100.7', '2001:db8:abcd::24']) {
      const html = details(enrollment({ requesterIp, sameNetwork: false }), { account: 'alex@example.com' });
      expect(labels(html), requesterIp).toEqual(['Machine', 'Hostname', 'From', 'Account']);
      expect(row(html, 'From'), requesterIp).toBe(requesterIp);
      expect(html.querySelector('.enroll-fact-ok'), requesterIp).toBeNull();
    }
  });

  it('leaves the row out when the server recorded no address', () => {
    const html = details(enrollment({ requesterIp: null }), { account: 'alex@example.com' });
    expect(row(html, 'From')).toBeUndefined();
    expect(labels(html)).toEqual(['Machine', 'Hostname', 'Account']);
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
  it('reads the request the code names: the code to compare, the machine, where it came from, the account it joins and the time left', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment({ requesterIp: '203.0.113.24', sameNetwork: true }));
    const page = await open(`?code=${CODE}`);

    expect(getDeviceEnrollment).toHaveBeenCalledWith(CODE);
    expect(page.querySelector('h1')?.textContent).toBe('Approve this machine?');
    expect(page.textContent).toContain('Approve only if that was you, just now.');
    expect(page.querySelector('.enroll-code')?.textContent).toBe(CODE);
    expect(page.textContent).toContain('It should match the code in your terminal.');
    expect(labels(page)).toEqual(['Machine', 'Hostname', 'From', 'Account', 'Expires']);
    expect(row(page, 'Machine')).toBe('devbox');
    expect(row(page, 'From')).toBe('203.0.113.24 · same network as this browser');
    expect(row(page, 'Account')).toBe('alex@example.comSwitch');
    expect(row(page, 'Expires')).toMatch(/^in 9:4\d$/);
    expect(button(page, 'Approve')!.disabled).toBe(false);
    expect(button(page, 'Deny')!.disabled).toBe(false);
  });

  it('approving says the machine is registered, and the next step is a session on it', async () => {
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment());
    vi.mocked(approveDeviceEnrollment).mockResolvedValue({ ok: true, name: 'devbox', replaced: false, runnerId: RUNNER_ID });
    const page = await open(`?code=${CODE}`);

    await click(button(page, 'Approve'), 'Approve');
    expect(approveDeviceEnrollment).toHaveBeenCalledWith(CODE);
    expect(denyDeviceEnrollment).not.toHaveBeenCalled();
    expect(page.querySelector('h1')?.textContent).toBe('Machine registered');
    expect(page.textContent).toContain('devbox is on your account. Go back to the terminal');
    // The next step is the one Add a runner and an empty machine's page name: a session on this
    // machine, whose card asks for the folder and the sign-in (board rule 12).
    const said = (element: Element | null) => element?.textContent?.replace(/\s+/g, ' ').trim();
    expect(said(page.querySelector('.enroll-next-title'))).toBe('Next: start your first session');
    expect(said(page.querySelector('.enroll-next-body'))).toBe(
      'Say what you want done. Orbit asks for the two things only you can decide — the folder it works in, and a ' +
        'coding CLI to sign in — on the same screen.',
    );
    expect(page.textContent).not.toContain('Next: sign in a coding CLI and add a workspace');
    const link = (name: string) => [...page.querySelectorAll('a')].find((a) => a.textContent === name);
    expect(link('Start a session')?.getAttribute('href')).toBe(`/runners/${encodeId(RUNNER_ID)}/new`);
    expect(link('Start a session')?.className).toContain('enroll-submit-link');
    expect(link('Open machine instead')?.getAttribute('href')).toBe(`/runners/${encodeId(RUNNER_ID)}`);
    expect(link('Open machine instead')?.getAttribute('href')).not.toContain(RUNNER_ID);
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

  // The native Add Runner dialogs approve and deny by code with this page's words, which they hold one to
  // one with runnerCopy.ts (OrbitKit's RunnerPageCopy, Android's RunnerCopy): this holds runnerCopy.ts to
  // what the page says.
  it('says what runnerCopy.ts gives the native Add Runner dialogs, word for word', async () => {
    const said = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, ' ').trim();
    vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment());
    const pending = await open(`?code=${CODE}`);
    expect(button(pending, runnerCopy.RUNNER_APPROVE)).toBeTruthy();
    expect(button(pending, runnerCopy.RUNNER_DENY)).toBeTruthy();
    await close();

    for (const [status, title, detail] of [
      ['APPROVED', runnerCopy.RUNNER_DEVICE_APPROVED, runnerCopy.runnerDeviceApprovedDetail('devbox')],
      ['DENIED', runnerCopy.RUNNER_DEVICE_DENIED, runnerCopy.RUNNER_DEVICE_DENIED_DETAIL],
    ] as const) {
      vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment({ status, runnerId: status === 'APPROVED' ? RUNNER_ID : null }));
      const page = await open(`?code=${CODE}`);
      expect(said(page.querySelector('h1')), status).toBe(title);
      expect(said(page.querySelector('.login-subtitle')), status).toBe(detail);
      await close();
    }

    for (const lastSeen of [new Date(Date.now() - 3 * 86_400_000).toISOString(), null]) {
      vi.mocked(getDeviceEnrollment).mockResolvedValue(enrollment({ nameConflict: true, existingLastSeenAt: lastSeen }));
      const page = await open(`?code=${CODE}`);
      expect(said(page.querySelector('.orbit-alert-title'))).toBe(runnerCopy.runnerDeviceNameTaken('devbox'));
      expect(said(page.querySelector('.orbit-alert-description'))).toBe(
        lastSeen
          ? `${runnerCopy.runnerDeviceLastOnline('3d ago')} ${runnerCopy.RUNNER_DEVICE_NAME_TAKEN_DETAIL}`
          : runnerCopy.RUNNER_DEVICE_NAME_TAKEN_DETAIL,
      );
      expect(button(page, runnerCopy.RUNNER_REREGISTER)).toBeTruthy();
      expect(button(page, runnerCopy.RUNNER_DENY)).toBeTruthy();
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
