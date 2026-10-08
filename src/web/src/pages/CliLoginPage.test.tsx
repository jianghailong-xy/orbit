// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type CliLoginRequest } from '../api';
import { ALL_SCOPES, NEVER_EXPIRES, NEVER_EXPIRES_WARNING, READ_SCOPES, fullDate } from '../lib/accessTokens';

/**
 * /cli-login?code= — the browser half of `orbit login` (docs/personal-access-token-design.md §7.3), in
 * a real document over what GET /access-tokens/device/:userCode answers: the token a terminal asks
 * for — its name, scopes, lifetime and the host asking — approved or denied, a name already taken,
 * a request already decided, and one that expired.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getCliLoginRequest: vi.fn(),
  approveCliLogin: vi.fn(),
  denyCliLogin: vi.fn(),
}));
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));
const { approveCliLogin, denyCliLogin, getCliLoginRequest } = await import('../api');
const { CliLoginDetails, CliLoginPage, lifetimeLine } = await import('./CliLoginPage');

const DAY = 24 * 3_600_000;
const CODE = 'WXYZ4-8K2QP';

const asked = (over: Partial<CliLoginRequest> = {}): CliLoginRequest => ({
  userCode: CODE,
  name: 'orbit CLI on devbox',
  scopes: [...READ_SCOPES],
  expiresInDays: 90,
  hostname: 'devbox',
  status: 'PENDING',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  nameInUse: false,
  ...over,
});

/** The row of a Descriptions table whose label is `label`, as text. */
function row(within: ParentNode, label: string): string {
  const cell = [...within.querySelectorAll('th')].find((th) => th.textContent?.trim() === label);
  expect(cell, `the ${label} row`).toBeTruthy();
  return cell!.parentElement!.textContent ?? '';
}

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
  window.history.replaceState(null, '', `/cli-login${search}`);
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => next.render(<CliLoginPage />));
  // Loading shows a status spinner until the request is read.
  await vi.waitFor(() => expect(container!.querySelector('[role="status"]')).toBeNull());
  await settle();
  return container;
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  for (const fn of [getCliLoginRequest, approveCliLogin, denyCliLogin]) vi.mocked(fn).mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
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

describe('what the approval page shows of the requested token', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');

  it('shows the name, the scopes in words and one by one, the lifetime with its date, the host and the code', () => {
    const html = document.createElement('div');
    html.innerHTML = renderToStaticMarkup(<CliLoginDetails request={asked()} now={now} />);
    expect(row(html, 'Token name')).toContain('orbit CLI on devbox');
    const scopes = row(html, 'Scopes');
    expect(scopes).toContain('Read-only · everything');
    for (const scope of READ_SCOPES) expect(scopes).toContain(scope);
    expect(scopes).not.toContain('tasks:write');
    expect(row(html, 'Expires')).toContain(`90 days, until about ${fullDate(new Date(now + 90 * DAY).toISOString())}`);
    expect(row(html, 'Requested from')).toContain('devbox');
    expect(row(html, 'Code')).toContain(CODE);
  });

  it('says what a pick of scopes can do resource by resource, and marks a token that never expires', () => {
    const html = document.createElement('div');
    html.innerHTML = renderToStaticMarkup(
      <CliLoginDetails request={asked({ scopes: ['tasks:read', 'tasks:write', 'wiki:read'], expiresInDays: null, hostname: null })} now={now} />,
    );
    expect(row(html, 'Scopes')).toContain('Tasks: read & write · Wiki: read');
    expect(row(html, 'Expires')).toContain(NEVER_EXPIRES);
    expect(row(html, 'Requested from')).toContain('Unknown host');
    expect(lifetimeLine(null, now)).toBe(NEVER_EXPIRES);
    expect(lifetimeLine(30, now)).toBe(`30 days, until about ${fullDate(new Date(now + 30 * DAY).toISOString())}`);
  });
});

describe('/cli-login', { timeout: 30_000 }, () => {
  it('reads the request the code names, and approving it says to return to the terminal', async () => {
    vi.mocked(getCliLoginRequest).mockResolvedValue(asked());
    vi.mocked(approveCliLogin).mockResolvedValue({ status: 'APPROVED', name: 'orbit CLI on devbox' });
    const page = await open(`?code=${CODE}`);

    expect(getCliLoginRequest).toHaveBeenCalledWith(CODE);
    expect(page.textContent).toContain('Approve orbit login');
    expect(page.textContent).toContain('Approve it only if you just ran orbit login');
    expect(row(page, 'Token name')).toContain('orbit CLI on devbox');
    expect(row(page, 'Requested from')).toContain('devbox');
    expect(row(page, 'Code')).toContain(CODE);
    expect(page.textContent).not.toContain(NEVER_EXPIRES_WARNING);
    expect(button(page, 'Approve')!.disabled).toBe(false);

    await click(button(page, 'Approve'), 'Approve');
    expect(approveCliLogin).toHaveBeenCalledWith(CODE);
    expect(denyCliLogin).not.toHaveBeenCalled();
    expect(page.textContent).toContain('Login approved');
    expect(page.textContent).toContain('Return to your terminal — orbit login collects the token "orbit CLI on devbox"');
    expect(button(page, 'Approve')).toBeUndefined();
  });

  it('denying tells the person no token was issued', async () => {
    vi.mocked(getCliLoginRequest).mockResolvedValue(asked());
    vi.mocked(denyCliLogin).mockResolvedValue({ status: 'DENIED', name: 'orbit CLI on devbox' });
    const page = await open(`?code=${CODE}`);

    await click(button(page, 'Deny'), 'Deny');
    expect(denyCliLogin).toHaveBeenCalledWith(CODE);
    expect(approveCliLogin).not.toHaveBeenCalled();
    expect(page.textContent).toContain('Login denied');
    expect(page.textContent).toContain('No token was issued');
  });

  it('warns where the token would never expire', async () => {
    vi.mocked(getCliLoginRequest).mockResolvedValue(asked({ scopes: [...ALL_SCOPES], expiresInDays: null }));
    const page = await open(`?code=${CODE}`);
    expect(row(page, 'Scopes')).toContain('Read & write · everything');
    expect(row(page, 'Expires')).toContain(NEVER_EXPIRES);
    expect(page.textContent).toContain(NEVER_EXPIRES_WARNING);
  });

  it('a name one of the person\'s tokens already has: says so, and Approve is off while Deny is not', async () => {
    vi.mocked(getCliLoginRequest).mockResolvedValue(asked({ nameInUse: true }));
    const page = await open(`?code=${CODE}`);
    expect(page.textContent).toContain('You already have an access token named "orbit CLI on devbox".');
    expect(page.textContent).toContain('Revoke it under Settings → Access tokens, or run orbit login --name with another name.');
    expect(button(page, 'Approve')!.disabled).toBe(true);
    expect(button(page, 'Deny')!.disabled).toBe(false);
  });

  it('an approval the server refuses is said in a toast, and the request stays to decide', async () => {
    vi.mocked(getCliLoginRequest).mockResolvedValue(asked());
    vi.mocked(approveCliLogin).mockRejectedValue(
      new ApiError('You already have 50 access tokens — revoke one before issuing another', 409, 'PAT_LIMIT_REACHED'),
    );
    const page = await open(`?code=${CODE}`);
    await click(button(page, 'Approve'), 'Approve');
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't approve this login",
      'You already have 50 access tokens — revoke one before issuing another',
    );
    expect(page.textContent).not.toContain('Login approved');
    expect(button(page, 'Approve')).toBeTruthy();
  });

  it('a request already decided opens on its decision: approved — collected or not — or denied', async () => {
    for (const [status, says] of [['APPROVED', 'Login approved'], ['DELIVERED', 'Login approved'], ['DENIED', 'Login denied']] as const) {
      vi.mocked(getCliLoginRequest).mockResolvedValue(asked({ status }));
      const page = await open(`?code=${CODE}`);
      expect(page.textContent, status).toContain(says);
      expect(button(page, 'Approve'), status).toBeUndefined();
      await act(async () => root!.unmount());
      root = null;
      container!.remove();
      container = null;
    }
  });

  it('an expired or unknown request, and a link with no code, say they cannot be approved', async () => {
    vi.mocked(getCliLoginRequest).mockRejectedValue(
      new ApiError('login request not found or expired — run `orbit login` again', 404),
    );
    const expired = await open(`?code=${CODE}`);
    expect(expired.textContent).toContain('Cannot approve this login');
    expect(expired.textContent).toContain('login request not found or expired — run `orbit login` again');
    expect(button(expired, 'Approve')).toBeUndefined();
    await act(async () => root!.unmount());
    root = null;
    container!.remove();
    container = null;

    vi.mocked(getCliLoginRequest).mockClear();
    const missing = await open('');
    expect(getCliLoginRequest).not.toHaveBeenCalled();
    expect(missing.textContent).toContain('Missing login code. Open the link orbit login printed in your terminal.');
  });
});
