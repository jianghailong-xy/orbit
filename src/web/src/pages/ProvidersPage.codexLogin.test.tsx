// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import type { CodexLogin, CodexLoginPoll } from '../lib/codexLogin';
import { encodeId } from '../lib/idCodec';
import { formatResetTime, type ProviderPool } from '../lib/providerPools';
import { ProviderPoolPage } from './ProviderPoolPage';
import { ProvidersPage } from './ProvidersPage';

/**
 * A Codex pool of one's own ChatGPT account (migration 0323) on /providers and on its own page, mounted
 * for real against a fake API: the account's row — its email, plan and `…AB12`, where it stands, each
 * window's quota and when it resets — and "Sign in with ChatGPT", the device flow that puts it in: the
 * notice first, then the page to open and the one-time code, polled until the person approved it, and
 * each way it can end. Signed out by OpenAI, it is signed in again from its row; its owner signs it out
 * and deletes the pool. A new "Just me" Codex pool is one of these, and opens straight to signing in.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const POOL_ID = id(700);
const AT = `/providers/pools/${POOL_ID}`;
const LOGIN = `${AT}/codex-login`;
const DEVICE_URL = 'https://auth.openai.com/codex/device';
const CODE = 'QX7M-4TZPK';
const IN_AN_HOUR = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const IN_THREE_DAYS = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const CODE_EXPIRES = new Date(Date.now() + 15 * 60 * 1000).toISOString();

/** The account the board draws: Plus, both windows read, the next session's. */
function account(over: Partial<CodexLogin> = {}): CodexLogin {
  return {
    state: 'ACTIVE',
    email: 'lin@example.com',
    plan: 'plus',
    fingerprint: '…AB12',
    lastError: null,
    expiresAt: IN_THREE_DAYS,
    linkedAt: '2026-09-28T10:00:00.000Z',
    usage: {
      provider: 'codex',
      primary: { utilization: 23, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
      secondary: { utilization: 41, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
    },
    usageUnavailable: null,
    ...over,
  };
}

/** The pool as GET /providers/pools serves it: no members, and the account — or none — beside them. */
function codexPool(login: CodexLogin | null): ProviderPool {
  return {
    id: POOL_ID,
    slug: 'my-codex',
    label: 'My Codex',
    engine: 'codex',
    login,
    resetsAt: null,
    unavailable: login ? null : 'the pool "My Codex" has no ChatGPT account signed in — sign in on its page, or pick another provider',
    members: [],
  };
}

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

describe('a Codex pool of one’s own ChatGPT account', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let path = '';
  let state: unknown = null;
  let pools: ProviderPool[] = [];
  let sent: Sent[] = [];
  /** What each poll of the sign-in answers, in turn; the last one repeats. */
  let polls: (CodexLoginPoll | Error)[] = [];

  function Probe() {
    const location = useLocation();
    path = location.pathname;
    state = location.state;
    return null;
  }

  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  /** Wait — as the dialog's own poll does, every couple of seconds — until `done` holds. */
  const until = async (done: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!done()) {
      if (Date.now() > end) throw new Error(`timed out; the page says: ${document.body.textContent}`);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }
    await settle();
  };

  const mount = async (at: string) => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[at]}>
            <AntApp>
              <Probe />
              <Routes>
                <Route path="/providers" element={<ProvidersPage />} />
                <Route path="/providers/pools/:id" element={<ProviderPoolPage />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };

  const text = () => container.textContent ?? '';
  const row = () => {
    const found = container.querySelector<HTMLElement>('.pool-row-login');
    if (!found) throw new Error('no account row');
    return found;
  };
  const button = (words: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a.ant-btn')).find(
      (el) => el.textContent?.trim() === words,
    ) ?? null;
  const labelled = (label: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLElement>('[aria-label]')).filter((el) => el.getAttribute('aria-label') === label);
  const dialog = () => {
    const dialogs = document.body.querySelectorAll<HTMLElement>('.ant-modal');
    return dialogs[dialogs.length - 1] ?? null;
  };
  const dialogText = () => dialog()?.querySelector('.ant-modal-body')?.textContent ?? '';
  const click = async (el: Element | null | undefined) => {
    if (!el) throw new Error('nothing to click');
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settle();
  };
  const type = async (input: HTMLInputElement | null | undefined, value: string) => {
    if (!input) throw new Error('nothing to type into');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    path = '';
    state = null;
    pools = [codexPool(account())];
    sent = [];
    polls = [{ status: 'PENDING', verificationUrl: DEVICE_URL, userCode: CODE, expiresAt: CODE_EXPIRES, account: null }];
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
    apiMock.mockReset();
    apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        if (p === '/providers/pools') return pools;
        if (p === LOGIN) {
          const next = polls.length > 1 ? polls.shift()! : polls[0];
          if (next instanceof Error) throw next;
          return next;
        }
        return [];
      }
      sent.push({ method, path: p, body: init?.body });
      if (method === 'POST' && p === LOGIN) {
        return { status: 'PENDING', verificationUrl: DEVICE_URL, userCode: CODE, expiresAt: CODE_EXPIRES };
      }
      if (method === 'POST' && p === '/providers/pools') return codexPool(null);
      if (method === 'DELETE' && p === LOGIN) return { status: 'CANCELLED', account: null };
      if (method === 'DELETE' && p === `${LOGIN}/account`) return { removed: 1 };
      return {};
    }) as typeof api);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('heads its card with Codex and "Just me", and gives the account a row: its email, plan, status and each window', async () => {
    await mount('/providers');
    const card = container.querySelector<HTMLElement>('.pool-sec .pool-card')!;
    const head = card.querySelector<HTMLElement>('.re-head')!;
    expect(head.querySelector('.re-runner')?.textContent).toBe('My Codex');
    expect(head.querySelector('.re-summary')?.textContent).toBe('Just me');
    // One account to start on: it is named, not "next".
    expect(head.querySelector('.pool-gauge-name')?.textContent).toBe('lin@example.com');
    expect(head.querySelector('.pool-gauge-pct')?.textContent).toBe('23%');

    expect(row().querySelector('.re-name')?.textContent).toBe('lin@example.com');
    expect(row().querySelector('.pool-key-mask')?.textContent).toBe('ChatGPT Plus · …AB12');
    expect(row().querySelector('.pool-status')?.textContent).toBe('Available');
    const windows = Array.from(row().querySelectorAll('.pool-login-window')).map((el) => el.textContent);
    expect(windows).toEqual([
      `5h limit23%resets ${formatResetTime(IN_AN_HOUR)}`,
      `Weekly limit41%resets ${formatResetTime(IN_THREE_DAYS)}`,
    ]);
    // Nothing to do to a working account from here: signing out is on the pool's own page.
    expect(row().querySelector('.re-act')?.children).toHaveLength(0);
  });

  it('says so when no quota has been read yet — the account runs all the same', async () => {
    pools = [codexPool(account({ usage: null, usageUnavailable: 'no quota has been read for this account yet' }))];
    await mount('/providers');
    expect(row().querySelector('.pool-status')?.textContent).toBe('Available');
    expect(row().querySelector('.pool-login-quota')?.textContent).toBe('No quota reported');
  });

  it('waits out a spent window, and says until when', async () => {
    pools = [
      codexPool(
        account({
          usage: {
            provider: 'codex',
            primary: { utilization: 100, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
            secondary: { utilization: 64, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
          },
        }),
      ),
    ];
    await mount('/providers');
    expect(row().querySelector('.pool-status')?.textContent).toBe(`Spent · resets ${formatResetTime(IN_AN_HOUR)}`);
    expect(container.querySelector('.pool-gauge')?.textContent).toBe(`All spent · resets ${formatResetTime(IN_AN_HOUR)}`);
  });

  it('signs an account OpenAI signed out in again from its card, as that account', async () => {
    pools = [codexPool(account({ state: 'SIGNED_OUT', lastError: 'refresh_token_reused' }))];
    await mount('/providers');
    expect(row().querySelector('.pool-status')?.textContent).toBe('Signed out');
    expect(row().querySelector('.pool-why')?.textContent).toBe(
      'OpenAI signed this account out — sign in again to put it back in the pool.',
    );
    expect(container.querySelector('.pool-gauge')?.textContent).toBe('Signed out');

    await click(button('Sign in again', row()));
    expect(dialog()?.querySelector('.ant-modal-title')?.textContent).toBe('Sign in with ChatGPT');
    expect(dialog()?.querySelector('.pa-lead')?.textContent).toBe(
      'OpenAI signed lin@example.com out. Sign in with it again to put it back in My Codex.',
    );
    await click(button('Sign in with ChatGPT', dialog()!));
    expect(sent).toEqual([{ method: 'POST', path: LOGIN, body: undefined }]);
    expect(dialog()?.querySelector('.cx-hint')?.textContent).toBe(
      'Sign in there as lin@example.com, then enter this one-time code:',
    );
  });

  it('shows its page: what it is, the account and its windows, and the way out', async () => {
    await mount(AT);
    expect(container.querySelector('.pool-page-title h1')?.textContent).toBe('My Codex');
    expect(text()).toContain(
      'Codex pool · Just me · sessions run on your own ChatGPT account, and its sign-in stays on the Orbit server.',
    );
    // One account a pool: while it has one, there is nothing to sign in.
    expect(button('Sign in with ChatGPT')).toBeNull();
    expect(container.querySelector('.pool-detail .re-runner')?.textContent).toBe('Account');
    expect(row().querySelector('.pool-key-mask')?.textContent).toBe('ChatGPT Plus · …AB12');
    expect(container.querySelector('.pool-danger-note')?.textContent).toBe(
      'Its ChatGPT sign-in is deleted from the Orbit server with it.',
    );

    // Signing it out asks first, and says what it costs.
    await click(labelled('Sign out lin@example.com')[0]);
    const confirm = document.body.querySelector<HTMLElement>('.ant-popover:not(.ant-popover-hidden)')!;
    expect(confirm.querySelector('.ant-popconfirm-title')?.textContent).toBe('Sign out lin@example.com?');
    expect(confirm.querySelector('.ant-popconfirm-description')?.textContent).toBe(
      'Its sign-in is deleted from the Orbit server, and no session runs on this pool until you sign in again.',
    );
    await click(button('Sign out', confirm));
    expect(sent).toEqual([{ method: 'DELETE', path: `${LOGIN}/account`, body: undefined }]);

    await click(button('Delete pool'));
    const del = Array.from(document.body.querySelectorAll<HTMLElement>('.ant-popover:not(.ant-popover-hidden)')).pop()!;
    expect(del.querySelector('.ant-popconfirm-title')?.textContent).toBe('Delete My Codex?');
    await click(button('Delete', del));
    expect(sent[1]).toEqual({ method: 'DELETE', path: AT, body: undefined });
    expect(path).toBe('/providers');
  });

  it('puts an account in with the device flow: the notice, the code and its page, then the account', async () => {
    pools = [codexPool(null)];
    await mount(AT);
    expect(text()).toContain('No account yet — no session can start on this pool until you sign in with ChatGPT.');
    expect(container.querySelector('.pool-gauge')?.textContent).toBe('Not signed in');

    await click(button('Sign in with ChatGPT'));
    const consent = dialogText();
    expect(dialog()?.querySelector('.pa-lead')?.textContent).toBe(
      'Sign in with your own ChatGPT account to run My Codex on it.',
    );
    expect(Array.from(dialog()!.querySelectorAll('.pa-facts li')).map((li) => li.textContent)).toEqual([
      'Only you can use it. Sessions on My Codex are yours alone — nobody else in Orbit sees this pool or its account.',
      'The sign-in stays on the Orbit server. It never goes to a runner — runners get a session token, not your login — and nobody sees its tokens.',
      'Sign out any time. Its usage, and when it resets, show on this pool’s page.',
    ]);
    expect(dialog()?.querySelector('.pa-risk')?.textContent).toBe(
      'Don’t share your account. OpenAI’s terms don’t allow a ChatGPT account to be shared — an account used that way can be suspended.',
    );
    // Nothing starts on the server before the person asks for it.
    expect(consent).not.toContain(CODE);
    expect(sent).toEqual([]);

    await click(button('Sign in with ChatGPT', dialog()!));
    expect(sent).toEqual([{ method: 'POST', path: LOGIN, body: undefined }]);
    expect(button('Open the sign-in page', dialog()!)?.getAttribute('href')).toBe(DEVICE_URL);
    expect(dialog()?.querySelector('.cx-url')?.textContent).toBe(DEVICE_URL);
    expect(dialog()?.querySelector('.cx-hint')?.textContent).toBe('Sign in there, then enter this one-time code:');
    expect(dialog()?.querySelector('.cx-code-text')?.textContent).toContain(CODE);
    expect(dialog()?.querySelector('.cx-wait')?.textContent?.trim()).toBe('Waiting for you to approve it…');
    expect(dialog()?.querySelector('.cx-expiry')?.textContent).toBe(
      `The code works until ${formatResetTime(CODE_EXPIRES)}.`,
    );

    // Approved in the browser: the next poll comes back with the account, stored.
    polls = [{ status: 'CONFIRMED', account: account() }];
    pools = [codexPool(account())];
    await until(() => dialogText().includes('is in My Codex'));
    expect(dialog()?.querySelector('.pa-done-t')?.textContent).toBe('lin@example.com is in My Codex');
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe(
      'It’s ready for the next session. Only you can sign it out or sign it in again.',
    );
    expect(dialog()?.querySelector('.pa-acct-s')?.textContent).toBe(
      'ChatGPT Plus · …AB12 · its sign-in stays on the Orbit server',
    );
    await click(button('Done', dialog()!));
    await until(() => container.querySelector('.pool-row-login') !== null);
    expect(row().querySelector('.re-name')?.textContent).toBe('lin@example.com');
    // It was approved, so there was nothing left to give up.
    expect(sent.filter((call) => call.method === 'DELETE')).toEqual([]);
  });

  it('gives up the sign-in on the server when the dialog is cancelled before the code was approved', async () => {
    pools = [codexPool(null)];
    await mount(AT);
    await click(button('Sign in with ChatGPT'));
    await click(button('Sign in with ChatGPT', dialog()!));
    await click(button('Cancel', dialog()!));
    expect(sent).toEqual([
      { method: 'POST', path: LOGIN, body: undefined },
      { method: 'DELETE', path: LOGIN, body: undefined },
    ]);
  });

  it('gives up a sign-in whose code was still on its way when the dialog closed', async () => {
    pools = [codexPool(null)];
    await mount(AT);
    // The server takes its time printing the code: the start is still out when the person gives up.
    let answer: (value: unknown) => void = () => {};
    const base = apiMock.getMockImplementation()!;
    apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method === 'POST' && p === LOGIN) {
        sent.push({ method: 'POST', path: p, body: init?.body });
        return new Promise((resolve) => {
          answer = resolve;
        });
      }
      return base(p, init as never);
    }) as typeof api);
    await click(button('Sign in with ChatGPT'));
    await click(button('Sign in with ChatGPT', dialog()!));
    await click(button('Cancel', dialog()!));
    expect(sent).toEqual([{ method: 'POST', path: LOGIN, body: undefined }]);
    await act(async () => {
      answer({ status: 'PENDING', verificationUrl: DEVICE_URL, userCode: CODE, expiresAt: CODE_EXPIRES });
    });
    await settle();
    expect(sent).toEqual([
      { method: 'POST', path: LOGIN, body: undefined },
      { method: 'DELETE', path: LOGIN, body: undefined },
    ]);
  });

  it('offers a new code once the old one expired', async () => {
    pools = [codexPool(null)];
    polls = [{ status: 'EXPIRED', account: null }];
    await mount(AT);
    await click(button('Sign in with ChatGPT'));
    await click(button('Sign in with ChatGPT', dialog()!));
    await until(() => dialogText().includes('The code expired'));
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe('It wasn’t approved in time. Get a new code to try again.');
    polls = [{ status: 'PENDING', verificationUrl: DEVICE_URL, userCode: CODE, expiresAt: CODE_EXPIRES, account: null }];
    await click(button('Get a new code', dialog()!));
    expect(sent.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(dialog()?.querySelector('.cx-code-text')?.textContent).toContain(CODE);
  });

  it('says why a sign-in did not finish, in the server’s words', async () => {
    pools = [codexPool(null)];
    polls = [{ status: 'FAILED', error: 'the codex CLI gave up (exit 1)', account: null }];
    await mount(AT);
    await click(button('Sign in with ChatGPT'));
    await click(button('Sign in with ChatGPT', dialog()!));
    await until(() => dialogText().includes('The sign-in didn’t finish'));
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe('The codex CLI gave up (exit 1).');
    expect(button('Try again', dialog()!)).not.toBeNull();
  });

  it('refuses the same account twice, and another account in a pool that has one', async () => {
    pools = [codexPool(null)];
    polls = [new ApiError('This ChatGPT account is already in "My Codex"', 409, 'POOL_CODEX_ACCOUNT_DUPLICATE')];
    await mount(AT);
    await click(button('Sign in with ChatGPT'));
    await click(button('Sign in with ChatGPT', dialog()!));
    await until(() => dialogText().includes('already in'));
    expect(dialog()?.querySelector('.pa-done-t')?.textContent).toBe('This ChatGPT account is already in My Codex');
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe(
      'It’s the account this pool runs on — signing it in twice adds nothing.',
    );
    await click(button('Close', dialog()!));

    await act(async () => root.unmount());
    container.remove();
    pools = [codexPool(account({ state: 'SIGNED_OUT' }))];
    polls = [new ApiError('"My Codex" already runs on lin@example.com — sign it out first', 409, 'POOL_CODEX_ACCOUNT_TAKEN')];
    await mount(AT);
    await click(button('Sign in again', row()));
    await click(button('Sign in with ChatGPT', dialog()!));
    await until(() => dialogText().includes('runs on another account'));
    expect(dialog()?.querySelector('.pa-done-t')?.textContent).toBe('My Codex runs on another account');
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe(
      'Sign in as lin@example.com instead — or sign it out first to switch accounts.',
    );
  });

  it('makes a "Just me" Codex pool one of these, and opens it straight to signing in', async () => {
    pools = [];
    await mount('/providers');
    await click(button('New pool'));
    const modal = dialog()!;
    expect(modal.querySelector('.ant-segmented-item-selected')?.textContent?.trim()).toBe('Codex');
    expect(modal.querySelector<HTMLInputElement>('input[type="radio"][value="me"]')?.checked).toBe(true);
    expect(modal.textContent).toContain(
      'Sessions run on your own ChatGPT account — sign in with ChatGPT once the pool exists. Nobody else sees it.',
    );
    expect(modal.querySelector<HTMLInputElement>('label.np-field input')?.value).toBe('My Codex');
    await type(modal.querySelector<HTMLInputElement>('label.np-field input'), 'Codex');
    pools = [codexPool(null)];
    await click(button('Create pool', modal));
    expect(sent).toEqual([{ method: 'POST', path: '/providers/pools', body: { label: 'Codex', engine: 'codex' } }]);
    expect(path).toBe(AT);
    expect(state).toEqual({ signIn: true });
    await until(() => dialog()?.querySelector('.ant-modal-title')?.textContent === 'Sign in with ChatGPT');
    expect(dialog()?.querySelector('.pa-lead')?.textContent).toBe(
      'Sign in with your own ChatGPT account to run My Codex on it.',
    );
  });
});
