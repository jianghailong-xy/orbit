// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import type { CodexLogin, CodexLoginPoll } from '../lib/codexLogin';
import { encodeId } from '../lib/idCodec';
import { formatResetTime, type ProviderPool } from '../lib/providerPools';
import type { SharedPool } from '../lib/sharedPools';
import { ProviderPoolPage } from './ProviderPoolPage';
import { ProvidersPage } from './ProvidersPage';

/**
 * A Codex pool of one's own ChatGPT account (migration 0323) on /providers and on its own page, mounted
 * for real against a fake API: one row per account it holds — its email, plan and `…AB12`, where it
 * stands, each window's quota and when it resets, and NEXT on the account a session would run on — and
 * "Add account", which asks first what kind of account (03-1; ProviderPoolPage.whoCanUseIt.test.tsx), then
 * the device flow that puts another ChatGPT account in: the notice first, then the page to open and
 * the one-time code, polled until the person approved it, and each way it can end. Signed out by OpenAI,
 * an account is signed in again from its own row; its owner signs one out by its fingerprint and deletes
 * the pool. A new "Just me" Codex pool is one of these, and opens straight to signing in.
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
    // Signed in by the pool's owner — Lin, `id(1)` on its people (migration 0371).
    userId: id(1),
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

/** The pool as GET /providers/pools serves it: no members, and its ChatGPT accounts — none, one or
 *  several — beside them, oldest first. `login` is the first of them, the one its sessions run on. */
function codexPool(...logins: CodexLogin[]): ProviderPool {
  return {
    id: POOL_ID,
    slug: 'my-codex',
    label: 'My Codex',
    engine: 'codex',
    login: logins[0] ?? null,
    logins,
    resetsAt: null,
    unavailable:
      logins.length > 0
        ? null
        : 'the pool "My Codex" has no ChatGPT account signed in — sign one in on its page, or pick another provider',
    members: [],
  };
}

/** Who can use the pool, its ChatGPT accounts and its API keys, as GET /providers/shared-pools/:id serves
 *  them to its owner (migration 0358): its owner alone, no key, and the accounts the providers read
 *  carries (`pools` below) — the server sends the same accounts here since 2026-10-03. */
function alone(): SharedPool {
  return {
    id: POOL_ID,
    slug: 'my-codex',
    label: 'My Codex',
    engine: 'codex',
    shared: false,
    // The pool's accounts, as the shared-pools read serves them — the same ones the providers read carries.
    logins: [{ ...account(), next: true }],
    membersCanAdd: true,
    membersCanAddAccounts: true,
    ownKeyFirst: true,
    viewerRole: 'ADMIN',
    window: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    people: [
      {
        userId: id(1),
        name: 'Lin',
        role: 'ADMIN',
        creator: true,
        you: true,
        keys: 0,
        sessions: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
    ],
    keys: [],
  };
}

/** The second account of a pool that holds two: Pro, both windows read, plenty of room. */
const hl = () =>
  account({
    email: 'hl.work@gmail.com',
    plan: 'pro',
    fingerprint: '…7QX4',
    linkedAt: '2026-10-01T09:00:00.000Z',
    usage: {
      provider: 'codex',
      primary: { utilization: 18, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
      secondary: { utilization: 40, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
    },
  });

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
            <Probe />
            <Routes>
              <Route path="/providers" element={<ProvidersPage />} />
              <Route path="/providers/pools/:id" element={<ProviderPoolPage />} />
            </Routes>
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
    Array.from(scope.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')).find(
      (el) => el.textContent?.trim() === words,
    ) ?? null;
  const labelled = (label: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLElement>('[aria-label]')).filter((el) => el.getAttribute('aria-label') === label);
  const dialog = () => {
    const dialogs = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
    return dialogs[dialogs.length - 1] ?? null;
  };
  const dialogText = () => dialog()?.querySelector('.orbit-overlay-body')?.textContent ?? '';
  /** A dialog's name and description — a confirmation's popup is a dialog named by its question. */
  const nameOf = (el: Element | null | undefined) =>
    el ? document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent : undefined;
  const descriptionOf = (el: Element) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent;
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

  /** "Add account", and the kind it asks for first: another ChatGPT account, which it starts on (03-1). */
  const addAccount = async () => {
    await click(button('Add account'));
    await click(button('Continue', dialog()!));
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
        if (p === `/providers/shared-pools/${POOL_ID}`) return alone();
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
      if (method === 'POST' && p === '/providers/pools') return codexPool();
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
    expect(head.querySelector('.re-summary')?.textContent).toBe('Just me · 1 of 1 account available');
    // One account to start on: it is named, not "next".
    expect(head.querySelector('.pool-gauge-name')?.textContent).toBe('lin@example.com');
    // Its tightest window, by name: the weekly one at 41%, ahead of the 5-hour one at 23%.
    expect(head.querySelector('.pool-gauge-pct')?.textContent).toBe('Weekly 41%');

    expect(row().querySelector('.re-name')?.textContent).toBe('lin@example.com');
    // Led by whoever signed it in — Lin, the pool's owner (migration 0371).
    expect(row().querySelector('.pool-key-mask')?.textContent).toBe('Lin · ChatGPT Plus · …AB12');
    expect(row().querySelector('.pool-status')?.textContent).toBe('Available');
    const windows = Array.from(row().querySelectorAll('.pool-login-window')).map((el) => el.textContent);
    expect(windows).toEqual([
      `5h limit23%resets ${formatResetTime(IN_AN_HOUR)}`,
      `Weekly limit41%resets ${formatResetTime(IN_THREE_DAYS)}`,
    ]);
    // Nothing to do to a working account from here but pause it (migration 0374): signing out is on
    // the pool's own page.
    expect([...row().querySelectorAll('.re-act button')].map((button) => button.textContent)).toEqual(['Pause…']);
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

  it('still says when it frees up once its weekly window is spent — not a reading of either window', async () => {
    pools = [
      codexPool(
        account({
          usage: {
            provider: 'codex',
            primary: { utilization: 6, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
            secondary: { utilization: 100, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
          },
        }),
      ),
    ];
    await mount('/providers');
    expect(row().querySelector('.pool-status')?.textContent).toBe(`Spent · resets ${formatResetTime(IN_THREE_DAYS)}`);
    expect(container.querySelector('.pool-gauge')?.textContent).toBe(
      `All spent · resets ${formatResetTime(IN_THREE_DAYS)}`,
    );
    expect(container.querySelector('.pool-gauge-pct')).toBeNull();
  });

  it('heads the card and its page with the window closest to its limit: Weekly 97% in orange, beside 5h at 6%', async () => {
    pools = [
      codexPool(
        account({
          usage: {
            provider: 'codex',
            primary: { utilization: 6, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
            secondary: { utilization: 97, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
          },
        }),
      ),
    ];
    await mount('/providers');
    const gauge = container.querySelector<HTMLElement>('.pool-sec .pool-card .re-head .pool-gauge')!;
    expect(gauge.querySelector('.pool-gauge-name')?.textContent).toBe('lin@example.com');
    expect(gauge.querySelector('.pool-gauge-pct')?.textContent).toBe('Weekly 97%');
    // Nearly spent: the reading turns orange with its bar.
    expect(gauge.querySelector('.pool-gauge-pct')?.classList.contains('near-limit')).toBe(true);
    expect(gauge.querySelector('.runner-util')?.classList.contains('full')).toBe(true);
    expect(gauge.querySelector<HTMLElement>('.runner-util-fill')?.style.width).toBe('97%');
    // The account's row still draws each of its windows.
    expect(Array.from(row().querySelectorAll('.pool-login-window')).map((el) => el.textContent)).toEqual([
      `5h limit6%resets ${formatResetTime(IN_AN_HOUR)}`,
      `Weekly limit97%resets ${formatResetTime(IN_THREE_DAYS)}`,
    ]);

    await act(async () => root.unmount());
    container.remove();
    await mount(AT);
    const head = container.querySelector<HTMLElement>('.pool-detail .re-head .pool-gauge')!;
    expect(head.querySelector('.pool-gauge-pct')?.textContent).toBe('Weekly 97%');
    expect(head.querySelector('.pool-gauge-pct')?.classList.contains('near-limit')).toBe(true);
  });

  it('reads the 5-hour window when that one is the tighter', async () => {
    pools = [
      codexPool(
        account({
          usage: {
            provider: 'codex',
            primary: { utilization: 64, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
            secondary: { utilization: 41, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
          },
        }),
      ),
    ];
    await mount('/providers');
    const gauge = container.querySelector<HTMLElement>('.pool-sec .pool-card .re-head .pool-gauge')!;
    expect(gauge.querySelector('.pool-gauge-pct')?.textContent).toBe('5h 64%');
    expect(gauge.querySelector('.pool-gauge-pct')?.classList.contains('near-limit')).toBe(false);
    expect(gauge.querySelector('.runner-util')?.classList.contains('full')).toBe(false);
    expect(gauge.querySelector<HTMLElement>('.runner-util-fill')?.style.width).toBe('64%');
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
    expect(nameOf(dialog())).toBe('Sign in with ChatGPT');
    expect(dialog()?.querySelector('.pa-lead')?.textContent).toBe(
      'OpenAI signed lin@example.com out. Sign in with it again to put it back in My Codex.',
    );
    await click(button('Get a code', dialog()!));
    expect(sent).toEqual([{ method: 'POST', path: LOGIN, body: undefined }]);
    expect(dialog()?.querySelector('.cx-hint')?.textContent).toBe(
      'Sign in there as lin@example.com, then enter this one-time code:',
    );
  });

  it('shows its page: what it is, the account and its windows, and the way out', async () => {
    await mount(AT);
    expect(container.querySelector('.pool-page-title h1')?.textContent).toBe('My Codex');
    expect(text()).toContain(
      'Codex pool · Just me · 1 of 1 account available · each session starts on the account whose quota resets soonest, and stays on it until that one runs out.',
    );
    // The way in is always there, however many accounts the pool holds.
    expect(button('Add account')).not.toBeNull();
    expect(container.querySelector('.pool-detail .re-runner')?.textContent).toBe('Accounts1');
    expect(container.querySelector('.pool-detail .pool-head-count')?.textContent).toBe('1');
    // Led by whoever signed it in — Lin, the pool's owner (migration 0371).
    expect(row().querySelector('.pool-key-mask')?.textContent).toBe('Lin · ChatGPT Plus · …AB12');
    expect(container.querySelector('.pool-danger-note')?.textContent).toBe(
      'Its ChatGPT sign-in is deleted from the Orbit server with it.',
    );

    // Signing it out is a quiet mark — grey until it is pointed at (index.css) — that asks first, and
    // says what it costs. The pool's only account: nothing keeps running without it.
    expect(labelled('Sign out lin@example.com')[0].classList.contains('pool-signout')).toBe(true);
    await click(labelled('Sign out lin@example.com')[0]);
    const confirm = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(nameOf(confirm)).toBe('Sign out lin@example.com?');
    expect(descriptionOf(confirm)).toBe(
      'Its sign-in is deleted from the Orbit server, and no session runs on this pool until you sign in again.',
    );
    await click(button('Sign out', confirm));
    expect(sent).toEqual([
      { method: 'DELETE', path: `${LOGIN}/account?fingerprint=${encodeURIComponent('…AB12')}`, body: undefined },
    ]);

    await click(button('Delete pool'));
    const del = Array.from(document.body.querySelectorAll<HTMLElement>('[role="dialog"]')).pop()!;
    expect(nameOf(del)).toBe('Delete My Codex?');
    await click(button('Delete', del));
    expect(sent[1]).toEqual({ method: 'DELETE', path: AT, body: undefined });
    expect(path).toBe('/providers');
  });

  it('puts an account in with the device flow: the notice, the code and its page, then the account', async () => {
    pools = [codexPool()];
    await mount(AT);
    expect(text()).toContain('No account yet — no session can start on this pool until you sign in with ChatGPT.');
    expect(container.querySelector('.pool-gauge')?.textContent).toBe('Not signed in');

    await addAccount();
    const consent = dialogText();
    expect(dialog()?.querySelector('.pa-lead')?.textContent).toBe(
      'Sign in with your own ChatGPT account to run My Codex on it.',
    );
    expect(Array.from(dialog()!.querySelectorAll('.pa-facts li')).map((li) => li.textContent)).toEqual([
      'Yours, and whoever you add. A pool that is just yours runs your sessions alone; add people and their sessions start on this account too.',
      'The sign-in stays on the Orbit server. It never goes to a runner — runners get a session token, not your login — and nobody sees its tokens.',
      'Sign out any time. Its usage, and when it resets, show on this pool’s page.',
    ]);
    expect(dialog()?.querySelector('.pa-risk')?.textContent).toBe(
      'Adding people shares your account. Their sessions run on it — OpenAI’s terms treat account sharing as a violation, and an account used that way can be suspended.',
    );
    // What the notice's press is about: the one-time code the next step shows (03-2's own button).
    expect(button('Cancel', dialog()!)).not.toBeNull();
    expect(button('Get a code', dialog()!)).not.toBeNull();
    // Nothing starts on the server before the person asks for it.
    expect(consent).not.toContain(CODE);
    expect(sent).toEqual([]);

    await click(button('Get a code', dialog()!));
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
    polls = [{ status: 'CONFIRMED', account: account(), logins: [account()] }];
    pools = [codexPool(account())];
    await until(() => dialogText().includes('is in My Codex'));
    expect(dialog()?.querySelector('.pa-done-t')?.textContent).toBe('lin@example.com is in My Codex');
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe(
      'My Codex has 1 account now. A session moves to this one when the account it’s on runs out.',
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
    pools = [codexPool()];
    await mount(AT);
    await addAccount();
    await click(button('Get a code', dialog()!));
    await click(button('Cancel', dialog()!));
    expect(sent).toEqual([
      { method: 'POST', path: LOGIN, body: undefined },
      { method: 'DELETE', path: LOGIN, body: undefined },
    ]);
  });

  it('gives up a sign-in whose code was still on its way when the dialog closed', async () => {
    pools = [codexPool()];
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
    await addAccount();
    await click(button('Get a code', dialog()!));
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
    pools = [codexPool()];
    polls = [{ status: 'EXPIRED', account: null }];
    await mount(AT);
    await addAccount();
    await click(button('Get a code', dialog()!));
    await until(() => dialogText().includes('The code expired'));
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe('It wasn’t approved in time. Get a new code to try again.');
    polls = [{ status: 'PENDING', verificationUrl: DEVICE_URL, userCode: CODE, expiresAt: CODE_EXPIRES, account: null }];
    await click(button('Get a new code', dialog()!));
    expect(sent.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(dialog()?.querySelector('.cx-code-text')?.textContent).toContain(CODE);
  });

  it('says why a sign-in did not finish, in the server’s words', async () => {
    pools = [codexPool()];
    polls = [{ status: 'FAILED', error: 'the codex CLI gave up (exit 1)', account: null }];
    await mount(AT);
    await addAccount();
    await click(button('Get a code', dialog()!));
    await until(() => dialogText().includes('The sign-in didn’t finish'));
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe('The codex CLI gave up (exit 1).');
    expect(button('Try again', dialog()!)).not.toBeNull();
  });

  it('refuses an account the pool already holds, naming it and saying what a second sign-in is worth', async () => {
    pools = [codexPool(account())];
    polls = [
      new ApiError('This ChatGPT account is already in "My Codex"', 409, 'POOL_CODEX_ACCOUNT_DUPLICATE', {
        email: 'lin@example.com',
      }),
    ];
    await mount(AT);
    await addAccount();
    await click(button('Get a code', dialog()!));
    await until(() => dialogText().includes('already in'));
    expect(dialog()?.querySelector('.pa-done-t')?.textContent).toBe('This ChatGPT account is already in My Codex');
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe(
      'lin@example.com is one of its accounts, and signing it in twice adds no quota. Sign in with a different account.',
    );
    // The way out of it is a fresh sign-in with a different account, or closing.
    expect(button('Close', dialog()!)).not.toBeNull();
    polls = [{ status: 'PENDING', verificationUrl: DEVICE_URL, userCode: CODE, expiresAt: CODE_EXPIRES, account: null }];
    await click(button('Get a new code', dialog()!));
    expect(sent.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(dialog()?.querySelector('.cx-code-text')?.textContent).toContain(CODE);
  });

  it('reads a refusal with no account named the same way, without the address', async () => {
    pools = [codexPool(account())];
    polls = [new ApiError('This ChatGPT account is already in "My Codex"', 409, 'POOL_CODEX_ACCOUNT_DUPLICATE')];
    await mount(AT);
    await addAccount();
    await click(button('Get a code', dialog()!));
    await until(() => dialogText().includes('already in'));
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe(
      'It’s one of its accounts, and signing it in twice adds no quota. Sign in with a different account.',
    );
  });

  it('holds several accounts: a row each, NEXT on the one a session would run on, and the head counts them', async () => {
    pools = [
      codexPool(
        account({
          usage: {
            provider: 'codex',
            primary: { utilization: 6, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
            secondary: { utilization: 97, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
          },
        }),
        hl(),
      ),
    ];
    await mount('/providers');
    const card = container.querySelector<HTMLElement>('.pool-sec .pool-card')!;
    const head = card.querySelector<HTMLElement>('.re-head')!;
    // The card says who can use it and how many of its accounts can run.
    expect(head.querySelector('.re-summary')?.textContent).toBe('Just me · 2 of 2 accounts available');
    // The head reads the account a session would start on, and its tightest window.
    expect(head.querySelector('.pool-gauge-name')?.textContent).toBe('Next: lin@example.com');
    expect(head.querySelector('.pool-gauge-pct')?.textContent).toBe('Weekly 97%');
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.pool-sec .pool-row-login'));
    expect(rows.map((el) => el.querySelector('.re-name')?.textContent)).toEqual([
      'lin@example.comNEXT',
      'hl.work@gmail.com',
    ]);
    expect(rows.map((el) => el.querySelector('.pool-key-mask')?.textContent)).toEqual([
      'Lin · ChatGPT Plus · …AB12',
      'Lin · ChatGPT Pro · …7QX4',
    ]);

    await act(async () => root.unmount());
    container.remove();
    await mount(AT);
    const detail = container.querySelector<HTMLElement>('.pool-detail')!;
    // The card's head: how many accounts it holds, and which one the next session starts on.
    expect(detail.querySelector('.re-runner')?.textContent).toBe('Accounts2');
    expect(detail.querySelector('.pool-head-count')?.textContent).toBe('2');
    expect(detail.querySelector('.pool-gauge-name')?.textContent).toBe('Next: lin@example.com');
    expect(detail.querySelector('.pool-gauge-pct')?.textContent).toBe('Weekly 97%');
    expect(text()).toContain(
      'Codex pool · Just me · 2 of 2 accounts available · each session starts on the account whose quota resets soonest, and stays on it until that one runs out.',
    );
    // Both rows are there, each with its own windows and its own sign-out mark.
    expect(container.querySelectorAll('.pool-detail .pool-row-login')).toHaveLength(2);
    expect(labelled('Sign out lin@example.com')).toHaveLength(1);
    expect(labelled('Sign out hl.work@gmail.com')).toHaveLength(1);
    expect(container.querySelector('.pool-danger-note')?.textContent).toBe(
      'Its ChatGPT sign-ins are deleted from the Orbit server with it.',
    );
  });

  it('signs one account out by its own fingerprint, and says the pool keeps running on the other', async () => {
    pools = [codexPool(account(), hl())];
    await mount(AT);
    await click(labelled('Sign out lin@example.com')[0]);
    const confirm = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(nameOf(confirm)).toBe('Sign out lin@example.com?');
    expect(descriptionOf(confirm)).toBe(
      'Its sign-in is deleted from the Orbit server, and no session runs on it until you sign in again — My Codex keeps running on its other account.',
    );
    await click(button('Sign out', confirm));
    expect(sent).toEqual([
      { method: 'DELETE', path: `${LOGIN}/account?fingerprint=${encodeURIComponent('…AB12')}`, body: undefined },
    ]);

    // Three of them: what stays is plural.
    await act(async () => root.unmount());
    container.remove();
    pools = [codexPool(account(), hl(), account({ email: 'third@example.com', fingerprint: '…CC34' }))];
    await mount(AT);
    await click(labelled('Sign out lin@example.com')[0]);
    const again = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(descriptionOf(again)).toBe(
      'Its sign-in is deleted from the Orbit server, and no session runs on it until you sign in again — My Codex keeps running on its other accounts.',
    );
  });

  it('adds a second account: the notice says what the pool runs on now, and the ending says how many it holds', async () => {
    pools = [codexPool(account())];
    await mount(AT);
    await addAccount();
    expect(dialog()?.querySelector('.pa-lead')?.textContent).toBe(
      'Sign in with another ChatGPT account of yours to add it to My Codex. It runs on 1 account now.',
    );
    expect(Array.from(dialog()!.querySelectorAll('.pa-facts li')).map((li) => li.textContent)).toEqual([
      'Everyone in the pool runs on it. Once My Codex is shared, the people you add run their sessions on this account too — and see it, with its usage, on the pool’s page.',
      'The sign-in stays on the Orbit server. It never goes to a runner. Runners get a session token, not your login.',
      'Sign out any time. My Codex keeps running on its other accounts.',
    ]);
    expect(dialog()?.querySelector('.pa-risk')?.textContent).toBe(
      'Only your own accounts. Signing in with someone else’s ChatGPT account is sharing it, and so is putting yours in a pool others run on: OpenAI’s terms treat both as a violation, and an account used that way can be suspended.',
    );

    await click(button('Get a code', dialog()!));
    polls = [{ status: 'CONFIRMED', account: hl(), logins: [account(), hl()] }];
    pools = [codexPool(account(), hl())];
    await until(() => dialogText().includes('is in My Codex'));
    expect(dialog()?.querySelector('.pa-done-t')?.textContent).toBe('hl.work@gmail.com is in My Codex');
    expect(dialog()?.querySelector('.pa-done-s')?.textContent).toBe(
      'My Codex has 2 accounts now. A session moves to this one when the account it’s on runs out.',
    );
    await click(button('Done', dialog()!));
    await until(() => container.querySelectorAll('.pool-row-login').length === 2);
    expect(labelled('Sign out hl.work@gmail.com')).toHaveLength(1);
  });

  it('makes a "Just me" Codex pool one of these, and opens it straight to signing in', async () => {
    pools = [];
    await mount('/providers');
    await click(button('New pool'));
    const modal = dialog()!;
    expect(modal.querySelector('[role="radiogroup"][aria-label="Engine"] [role="radio"][aria-checked="true"]')?.textContent?.trim()).toBe('Codex');
    expect(modal.querySelector<HTMLInputElement>('input[type="radio"][value="me"]')?.checked).toBe(true);
    expect(modal.textContent).toContain(
      'Sessions run on your own ChatGPT account — sign in with ChatGPT once the pool exists. Nobody else sees it.',
    );
    expect(modal.querySelector<HTMLInputElement>('label.np-field input')?.value).toBe('My Codex');
    await type(modal.querySelector<HTMLInputElement>('label.np-field input'), 'Codex');
    pools = [codexPool()];
    await click(button('Create pool', modal));
    expect(sent).toEqual([{ method: 'POST', path: '/providers/pools', body: { label: 'Codex', engine: 'codex' } }]);
    expect(path).toBe(AT);
    expect(state).toEqual({ signIn: true });
    await until(() => nameOf(dialog()) === 'Sign in with ChatGPT');
    expect(dialog()?.querySelector('.pa-lead')?.textContent).toBe(
      'Sign in with your own ChatGPT account to run My Codex on it.',
    );
  });
});
