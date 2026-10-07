// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import type { CodexLogin } from '../lib/codexLogin';
import { encodeId } from '../lib/idCodec';
import type { ProviderPool } from '../lib/providerPools';
import type { SharedPool, SharedPoolKey, SharedPoolPerson } from '../lib/sharedPools';
import { InfrastructurePage } from './InfrastructurePage';
import { ProviderPoolPage } from './ProviderPoolPage';

/**
 * One Codex pool (scheme A, docs/mocks/account-pool-access/) on its own page and on /infrastructure, mounted
 * for real against a fake API, as its owner and as somebody they added read it: the owner's ChatGPT
 * accounts — "Everyone here" once the pool is shared, read the same way by everybody it runs the
 * sessions of (2026-10-03) — its API keys (also "Everyone here"), "Who can use it" with its two settings
 * and each person's row, what "Add account" asks first, what sharing and going back to "Just me" say
 * before they happen, and the pool's card on the Infrastructure page. The pool and its people are the boards'
 * own: jianghailong's Codex Pool, shared with Zhang Min and Lin Wei.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const JIANG = id(1);
const ZHANG = id(2);
const LIN = id(3);
const NAMES: Record<string, string> = { [JIANG]: 'jianghailong', [ZHANG]: 'Zhang Min', [LIN]: 'Lin Wei' };
const POOL_ID = id(800);
const AT = `/providers/shared-pools/${POOL_ID}`;
const PAGE = `/providers/pools/${POOL_ID}`;
const IN_AN_HOUR = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const IN_THREE_DAYS = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

const spend = (costUsd: number) => ({ inputTokens: 0, outputTokens: 0, costUsd });

/** One of jianghailong's ChatGPT accounts, as GET /providers/pools serves it to him. */
const account = (email: string, plan: string, fingerprint: string, fiveHour: number, weekly: number): CodexLogin => ({
  // Signed in by jianghailong, the pool's owner (migration 0371): the row's `userId` is who may sign it in
  // again, and the pages say whose account it is by this.
  userId: JIANG,
  state: 'ACTIVE',
  email,
  plan,
  fingerprint,
  lastError: null,
  expiresAt: IN_THREE_DAYS,
  linkedAt: '2026-09-28T10:00:00.000Z',
  usage: {
    provider: 'codex',
    primary: { utilization: fiveHour, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
    secondary: { utilization: weekly, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
  },
  usageUnavailable: null,
});
const ACCOUNTS = [
  account('jianghailong.rd@gmail.com', 'plus', '…016a', 6, 97),
  account('hl.work@gmail.com', 'pro', '…7QX4', 18, 40),
];

/** The pool as its owner's providers read it: his two ChatGPT accounts. */
const ownPool = (): ProviderPool => ({
  id: POOL_ID,
  slug: 'codex-pool',
  label: 'Codex Pool',
  engine: 'codex',
  login: ACCOUNTS[0],
  logins: ACCOUNTS,
  resetsAt: null,
  unavailable: null,
  members: [],
});

/** Who can use the pool, its ChatGPT accounts and its API keys (GET /providers/shared-pools[/:id]), as
 *  `viewer` reads them. `people` are the ones in it besides its owner; the keys are orbit-org-1 (his) and
 *  zm-proj (Zhang Min's); `logins` is what the pool holds of his accounts. */
function access(
  viewer: string,
  people: string[],
  keyLabels: string[] = ['orbit-org-1', 'zm-proj'],
  logins: CodexLogin[] = ACCOUNTS,
): SharedPool {
  const usage: Record<string, number> = { [JIANG]: 2, [ZHANG]: 5.5, [LIN]: 2.5 };
  const sessions: Record<string, number> = { [JIANG]: 23, [ZHANG]: 19, [LIN]: 6 };
  // The server marks the ONE credential the viewer's next session would run on: while the pool holds an
  // account that can run, no key is it.
  const keyNext = logins.length === 0;
  const keys: SharedPoolKey[] = [
    {
      id: id(11),
      label: 'orbit-org-1',
      fingerprint: 'sk-…AB12',
      state: 'ACTIVE',
      enabled: true,
      shareCap: 50,
      spentUntil: null,
      contributor: { userId: JIANG, name: NAMES[JIANG], you: viewer === JIANG },
      usage: { ...spend(14), othersCostUsd: 12.4 },
      running: false,
      next: keyNext && viewer === JIANG,
    },
    {
      id: id(12),
      label: 'zm-proj',
      fingerprint: 'sk-…7K2P',
      state: 'ACTIVE',
      enabled: true,
      shareCap: null,
      spentUntil: null,
      contributor: { userId: ZHANG, name: NAMES[ZHANG], you: viewer === ZHANG },
      usage: { ...spend(3.1), othersCostUsd: 3.1 },
      running: true,
      next: keyNext && viewer === ZHANG,
    },
  ].filter((key) => keyLabels.includes(key.label)) as SharedPoolKey[];
  const person = (userId: string): SharedPoolPerson => ({
    userId,
    name: NAMES[userId],
    role: userId === JIANG ? 'ADMIN' : 'MEMBER',
    creator: userId === JIANG,
    you: userId === viewer,
    keys: keys.filter((key) => key.contributor.userId === userId).length,
    sessions: people.length ? sessions[userId] : 0,
    usage: spend(people.length ? usage[userId] : 0),
  });
  return {
    id: POOL_ID,
    slug: 'codex-pool',
    label: 'Codex Pool',
    engine: 'codex',
    shared: false,
    // The pool's ChatGPT accounts, as everybody in it reads them (the server's own choice of which one the
    // viewer's next session runs on marked `next` — the one it sorts first, 97% of its week spent being
    // "near limit").
    logins: logins.map((login, index) => ({ ...login, next: index === 1 })),
    membersCanAdd: true,
    membersCanAddAccounts: true,
    ownKeyFirst: true,
    viewerRole: viewer === JIANG ? 'ADMIN' : 'MEMBER',
    window: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    people: [JIANG, ...people].map(person),
    keys,
  };
}

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

describe('a Codex pool, as its owner and as somebody they added read it', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let sent: Sent[] = [];
  /** What the server answers, as whoever is signed in. */
  let ownPools: ProviderPool[] = [];
  let sharedList: SharedPool[] = [];
  let ownAccess: SharedPool | null = null;

  /** jianghailong, with `people` added to his pool, `keys` in it and `accounts` of his signed in. */
  const asOwner = (people: string[], keys?: string[], accounts: CodexLogin[] = ACCOUNTS) => {
    ownPools = [{ ...ownPool(), login: accounts[0] ?? null, logins: accounts }];
    sharedList = [];
    ownAccess = access(JIANG, people, keys, accounts);
  };
  /** Zhang Min, whom he added along with Lin Wei. */
  const asZhang = () => {
    ownPools = [];
    sharedList = [access(ZHANG, [ZHANG, LIN])];
    ownAccess = null;
  };

  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
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
              <Routes>
                <Route path="/infrastructure" element={<InfrastructurePage />} />
                <Route path="/providers/pools/:id" element={<ProviderPoolPage />} />
              </Routes>
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await settle();
  };

  const text = (el: Element | null | undefined) => el?.textContent ?? null;
  const rowOf = (label: string) => {
    const row = Array.from(container.querySelectorAll<HTMLElement>('.pool-row')).find(
      (el) => el.querySelector('.pool-member-label')?.textContent === label,
    );
    if (!row) throw new Error(`no row for ${label}`);
    return row;
  };
  const personOf = (name: string) => {
    const row = Array.from(container.querySelectorAll<HTMLElement>('.pool-person')).find(
      (el) => el.querySelector('.pool-person-name span')?.textContent === name,
    );
    if (!row) throw new Error(`no person row for ${name}`);
    return row;
  };
  const who = () => container.querySelector<HTMLElement>('.who-card')!;
  const button = (words: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((el) => el.textContent?.trim() === words) ??
    null;
  const labelled = (label: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLElement>('[aria-label]')).filter((el) => el.getAttribute('aria-label') === label);
  const dialog = () => {
    const dialogs = document.body.querySelectorAll<HTMLElement>('.ant-modal');
    return dialogs[dialogs.length - 1] ?? null;
  };
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
  /** The setting "Who can use it" shows, and a press on the other one. */
  const setting = () => text(who().querySelector('.ant-segmented-item-selected'));
  const pick = async (words: string) =>
    click(
      Array.from(who().querySelectorAll('.ant-segmented-item'))
        .find((el) => el.textContent === words)
        ?.querySelector('input'),
    );

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sent = [];
    asOwner([ZHANG, LIN]);
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
        if (p === '/providers/pools') return ownPools;
        if (p === '/providers/shared-pools') return sharedList;
        if (p === AT && ownAccess) return ownAccess;
        return [];
      }
      sent.push({ method, path: p, body: init?.body });
      return ownAccess ?? {};
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

  it('draws the page of a pool that is its owner’s alone: Just me, its accounts, nothing about anybody else (01-D)', async () => {
    asOwner([], []);
    await mount(PAGE);
    expect(container.querySelector('.pool-page-title .pool-shared-chip')).toBeNull();
    expect(text(container.querySelector('.pool-sub'))).toBe(
      'Codex pool · Just me · 2 of 2 accounts available · each session starts on the account whose quota resets soonest, and stays on it until that one runs out.',
    );
    expect(button('Add account')).not.toBeNull();
    expect(text(container.querySelector('.pool-detail .re-runner'))).toBe('Accounts2');
    expect(text(container.querySelector('.pool-detail .pool-gauge-name'))).toBe('Next: jianghailong.rd@gmail.com');
    expect(text(container.querySelector('.pool-detail .pool-gauge-pct'))).toBe('Weekly 97%');
    // Nobody else uses it: nothing to say whose sessions each account runs.
    // Whose each account is, led by the person who signed it in — its owner's own, here (migration 0371).
    expect(text(rowOf('jianghailong.rd@gmail.com').querySelector('.pool-key-mask'))).toBe(
      'jianghailong · ChatGPT Plus · …016a',
    );
    expect(text(rowOf('hl.work@gmail.com').querySelector('.pool-key-mask'))).toBe('jianghailong · ChatGPT Pro · …7QX4');

    expect(text(who().querySelector('.re-runner'))).toBe('Who can use it');
    expect(setting()).toBe('Just me');
    expect(text(who().querySelector('.who-mode-h'))).toBe('Nobody else in Orbit sees this pool or its accounts.');
    expect(who().querySelectorAll('.pool-person')).toHaveLength(0);
    expect(who().querySelector('.pool-rule')).toBeNull();
    expect(who().querySelector('.who-foot')).toBeNull();
    expect(button('Add people')).toBeNull();
    expect(text(container.querySelector('.pool-danger-note'))).toBe(
      'Its ChatGPT sign-ins are deleted from the Orbit server with it.',
    );
  });

  it('draws its owner’s page once it is shared: whose sessions each account runs, and who can use it on what (02, owner)', async () => {
    await mount(PAGE);
    expect(text(container.querySelector('.pool-page-title .pool-shared-chip'))).toBe('SHARED');
    expect(text(container.querySelector('.pool-sub'))).toBe(
      'Codex pool · Me and 2 people · 4 of 4 accounts available · each session starts on your ChatGPT accounts; the API keys when none of them can run.',
    );
    expect(button('Add account')).not.toBeNull();
    expect(text(container.querySelector('.pool-detail .re-runner'))).toBe('Accounts4');
    expect(text(container.querySelector('.pool-detail .pool-gauge-name'))).toBe(
      'Next for you: jianghailong.rd@gmail.com',
    );
    expect(text(container.querySelector('.pool-detail .pool-gauge-pct'))).toBe('Weekly 97%');

    // Its accounts first, then its keys — everybody here runs on either since 2026-10-03.
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.pool-detail .pool-row'));
    expect(rows.map((row) => [text(row.querySelector('.re-name')), text(row.querySelector('.pool-key-mask'))])).toEqual([
      ['jianghailong.rd@gmail.comNEXT', 'jianghailong · ChatGPT Plus · …016a · Everyone here'],
      ['hl.work@gmail.com', 'jianghailong · ChatGPT Pro · …7QX4 · Everyone here'],
      ['orbit-org-1you', 'jianghailong · sk-…AB12 · Everyone here'],
      ['zm-proj', 'Zhang Min · sk-…7K2P · Everyone here'],
    ]);
    expect(text(rowOf('zm-proj').querySelector('.pool-status'))).toBe('Running now');
    expect(text(rowOf('zm-proj').querySelector('.pool-key-money .re-quota-head'))).toBe('Others$3.10');
    expect(text(rowOf('orbit-org-1').querySelector('.pool-key-money .re-quota-head'))).toBe('Others$12.40 of $50');
    // His own key he switches off and takes out; anybody's he takes out.
    expect(labelled('Disable orbit-org-1')).toHaveLength(1);
    expect(labelled('Remove orbit-org-1 from this pool')).toHaveLength(1);
    expect(labelled('Disable zm-proj')).toHaveLength(0);
    expect(labelled('Remove zm-proj from this pool')).toHaveLength(1);

    expect(text(who().querySelector('.re-runner'))).toBe('Who can use it3');
    expect(text(who().querySelector('.pool-head-note'))).toBe('Share of this month’s API key use');
    expect(button('Add people', who())).not.toBeNull();
    expect(setting()).toBe('Me and people I add');
    expect(text(who().querySelector('.who-mode-h'))).toBe(
      'They see Codex Pool on their Providers page and in the session picker.',
    );
    expect(
      ['jianghailong', 'Zhang Min', 'Lin Wei'].map((name) => [
        text(personOf(name).querySelector('.pool-person-name')),
        text(personOf(name).querySelector('.pool-person-meta')),
        text(personOf(name).querySelector('.pool-share-pct')),
      ]),
    ).toEqual([
      ['jianghailongyouOWNER', 'Runs on everything — your ChatGPT accounts first · 23 sessions', '20%'],
      ['Zhang Min', 'Runs on everything — your ChatGPT accounts first · 19 sessions', '55%'],
      ['Lin Wei', 'Runs on everything — your ChatGPT accounts first · 6 sessions', '25%'],
    ]);
    expect(labelled('Manage jianghailong')).toHaveLength(0);
    expect(labelled('Manage Zhang Min')).toHaveLength(1);
    expect(labelled('Manage Lin Wei')).toHaveLength(1);
    expect(text(who().querySelector('.pool-rule-t'))).toBe('They can add their own API keys');
    expect(text(who().querySelector('.pool-rule-h'))).toBe(
      'Off: only you put keys in. A key they add runs everyone’s sessions here, theirs first.',
    );
    expect(who().querySelector('button.ant-switch')?.getAttribute('aria-checked')).toBe('true');
    expect(text(who().querySelector('.who-foot'))).toBe(
      'Your ChatGPT accounts run everyone’s sessions here. The people you add start on them, and fall to the API keys when none can run. OpenAI’s terms treat account sharing as a violation — an account used that way can be suspended.',
    );
    expect(who().querySelector('.who-foot .anticon-warning')).not.toBeNull();
    expect(text(container.querySelector('.pool-danger-note'))).toBe(
      'Its ChatGPT sign-ins and API keys are deleted from the Orbit server, and nobody can run on it.',
    );

    // Taking somebody out is a press away, and asks first.
    await click(labelled('Manage Lin Wei')[0]);
    const items = Array.from(document.body.querySelectorAll('.ant-dropdown-menu-item')).map((el) => el.textContent);
    expect(items).toEqual(['Remove from pool']);
  });

  it('draws the same pool for somebody its owner added: his ChatGPT accounts as theirs to run on too, and its keys beside them (02, member)', async () => {
    asZhang();
    await mount(PAGE);
    expect(text(container.querySelector('.pool-page-title .pool-shared-chip'))).toBe('SHARED');
    expect(text(container.querySelector('.pool-sub'))).toBe(
      'Codex pool · jianghailong’s · 3 people · 4 of 4 accounts and keys you can run on available · each session starts on its ChatGPT accounts; the API keys when none of them can run.',
    );
    // The pool's own rule lets them sign a ChatGPT account of their own in (migration 0371), so the press
    // is the same one its owner has.
    expect(button('Add account')).not.toBeNull();
    expect(button('Add a key')).toBeNull();
    expect(text(container.querySelector('.pool-detail .re-runner'))).toBe('Accounts');
    // Their next session starts on one of his accounts (the one the server chose), not on a key.
    expect(text(container.querySelector('.pool-detail .pool-gauge-name'))).toBe('Next for you: hl.work@gmail.com');
    expect(text(container.querySelector('.pool-detail .pool-gauge-pct'))).toBe('Weekly 40%');

    // The accounts are theirs to read, as the owner reads them: email, plan, `…AB12` and quota — and whose
    // each one is. None is theirs, so neither offers a way to sign one in or out (migration 0371: that is
    // the person who signed it in's, with the pool's admins for taking it out).
    const rows = Array.from(container.querySelectorAll<HTMLElement>('.pool-detail .pool-row'));
    expect(rows.map((row) => [text(row.querySelector('.re-name')), text(row.querySelector('.pool-key-mask'))])).toEqual([
      ['jianghailong.rd@gmail.com', 'jianghailong · ChatGPT Plus · …016a'],
      ['hl.work@gmail.comNEXT', 'jianghailong · ChatGPT Pro · …7QX4'],
      ['zm-projyou', 'Zhang Min · sk-…7K2P'],
      ['orbit-org-1', 'jianghailong · sk-…AB12'],
    ]);
    expect(labelled('Sign out jianghailong.rd@gmail.com')).toHaveLength(0);
    expect(labelled('Sign out hl.work@gmail.com')).toHaveLength(0);
    expect(text(rowOf('jianghailong.rd@gmail.com').querySelector('.pool-login-quota'))).toContain('Weekly');
    // Their own key first, as their sessions take them; neither says whose sessions it runs.
    expect(labelled('Disable zm-proj')).toHaveLength(1);
    expect(labelled('Remove zm-proj from this pool')).toHaveLength(1);
    expect(labelled('Remove orbit-org-1 from this pool')).toHaveLength(0);

    expect(text(who().querySelector('.re-runner'))).toBe('Who can use it3');
    expect(text(who().querySelector('.pool-head-note'))).toBe('Set by jianghailong · share of this month’s API key use');
    expect(who().querySelector('.ant-segmented')).toBeNull();
    expect(who().querySelector('.pool-rule')).toBeNull();
    expect(who().querySelector('.who-foot')).toBeNull();
    expect(
      ['jianghailong', 'Zhang Min', 'Lin Wei'].map((name) => [
        text(personOf(name).querySelector('.pool-person-name')),
        text(personOf(name).querySelector('.pool-person-meta')),
      ]),
    ).toEqual([
      ['jianghailongOWNER', '1 key · 23 sessions'],
      ['Zhang Minyou', '1 key · 19 sessions'],
      ['Lin Wei', 'No key · 6 sessions'],
    ]);
    expect(container.querySelectorAll('[aria-label^="Manage "]')).toHaveLength(0);
    expect(button('Delete pool')).toBeNull();
    expect(button('Leave pool')).not.toBeNull();
    expect(text(container.querySelector('.pool-danger-note'))).toBe('Your keys leave with you.');
  });

  it('asks first what kind of account goes in, and goes on to that kind’s own dialog (03-1)', async () => {
    await mount(PAGE);
    await click(button('Add account'));
    expect(text(dialog()?.querySelector('.ant-modal-title'))).toBe('Add an account to Codex Pool');
    const kinds = Array.from(dialog()!.querySelectorAll<HTMLElement>('.add-kind'));
    expect(kinds.map((kind) => text(kind.querySelector('.ant-radio-label')))).toEqual([
      'Sign in with ChatGPTAnother ChatGPT account of yours. Everyone in the pool runs on it once you share the pool — until then, your sessions alone.',
      'Paste an OpenAI API keyAn organization or project key. Everyone who can use this pool runs on it, up to a monthly limit you set.',
    ]);
    expect(kinds.map((kind) => kind.querySelector<HTMLInputElement>('input')?.checked)).toEqual([true, false]);
    expect(button('Cancel', dialog()!)).not.toBeNull();
    await click(button('Continue', dialog()!));
    expect(text(dialog()?.querySelector('.ant-modal-title'))).toBe('Sign in with ChatGPT');
    expect(text(dialog()?.querySelector('.pa-lead'))).toBe(
      'Sign in with another ChatGPT account of yours to add it to Codex Pool. It runs on 2 accounts now.',
    );
    await click(button('Cancel', dialog()!));

    await click(button('Add account'));
    await click(dialog()!.querySelector('input[type="radio"][value="key"]'));
    await click(button('Continue', dialog()!));
    expect(text(dialog()?.querySelector('.ant-modal-title'))).toBe('Add a key to Codex Pool');
    // Nothing went to the server on the way.
    expect(sent).toEqual([]);
  });

  it('says before sharing what the people added get, then adds them (03-4)', async () => {
    asOwner([], ['orbit-org-1']);
    await mount(PAGE);
    await pick('Me and people I add');
    const modal = dialog()!;
    expect(text(modal.querySelector('.ant-modal-title'))).toBe('Share Codex Pool');
    expect(text(modal.querySelector('.np-field-l'))).toBe('Emails of their Orbit accounts');
    expect(Array.from(modal.querySelectorAll('.pa-facts li')).map((li) => li.textContent)).toEqual([
      'They see Codex Pool on their Providers page and in the session picker, and can start sessions on it.',
      'Their sessions start on your ChatGPT accounts, and fall to the pool’s API keys — orbit-org-1 — when none of them can run.',
      'They can sign in ChatGPT accounts of their own, which then run everyone’s sessions here too — theirs and yours — until they take them out again.',
      'Everyone sees each person’s share of this month’s API key use.',
    ]);
    expect(text(modal.querySelector('.ant-checkbox-wrapper'))).toBe('They can add their own API keys');
    expect(modal.querySelector<HTMLInputElement>('.ant-checkbox-input')?.checked).toBe(true);
    // Still what it was: who can use it is its people, and nobody is in it yet.
    expect(setting()).toBe('Just me');
    expect(button('Share', modal)?.disabled).toBe(true);

    await type(modal.querySelector<HTMLInputElement>('.pool-share-emails input'), 'zhang.min@orbitd.io,');
    await type(modal.querySelector<HTMLInputElement>('.pool-share-emails input'), 'lin.wei@orbitd.io');
    await click(modal.querySelector('.ant-checkbox-input'));
    await click(button('Share', modal));
    expect(sent).toEqual([
      { method: 'POST', path: `${AT}/people`, body: { email: 'zhang.min@orbitd.io' } },
      { method: 'POST', path: `${AT}/people`, body: { email: 'lin.wei@orbitd.io' } },
      { method: 'PATCH', path: AT, body: { membersCanAdd: false } },
    ]);
  });

  it('says before sharing a pool with no API key that they start on the accounts and wait when none can run (03-4, no key)', async () => {
    asOwner([], []);
    await mount(PAGE);
    await pick('Me and people I add');
    const modal = dialog()!;
    expect(text(modal.querySelector('.ant-modal-title'))).toBe('Share Codex Pool');
    expect(modal.querySelector('.pa-risk')).toBeNull();
    expect(Array.from(modal.querySelectorAll('.pa-facts li')).map((li) => li.textContent)).toEqual([
      'They see Codex Pool on their Providers page and in the session picker, and can start sessions on it.',
      'Their sessions start on your ChatGPT accounts, and wait when none of them can run — the pool has no API key to fall to yet.',
      'They can sign in ChatGPT accounts of their own, which then run everyone’s sessions here too — theirs and yours — until they take them out again.',
      'Everyone sees each person’s share of this month’s API key use.',
    ]);
    expect(Array.from(modal.querySelectorAll('.ant-modal-footer button')).map((el) => el.textContent)).toEqual([
      'Cancel',
      'Share',
    ]);
    await type(modal.querySelector<HTMLInputElement>('.pool-share-emails input'), 'zhang.min@orbitd.io');
    await click(button('Share', modal));
    expect(sent).toEqual([{ method: 'POST', path: `${AT}/people`, body: { email: 'zhang.min@orbitd.io' } }]);
  });

  it('warns and offers to add a key first only when the pool holds nothing they could run on (03-4, empty)', async () => {
    asOwner([], [], []);
    await mount(PAGE);
    await pick('Me and people I add');
    const modal = dialog()!;
    expect(text(modal.querySelector('.ant-modal-title'))).toBe('Share Codex Pool');
    expect(modal.querySelector('.pa-facts')).toBeNull();
    expect(modal.querySelector('.ant-checkbox-wrapper')).toBeNull();
    expect(text(modal.querySelector('.pa-risk'))).toBe(
      'Codex Pool has no API key yet. They’ll see it but can’t start a session until it has one, and no ChatGPT account is signed in either.',
    );
    expect(Array.from(modal.querySelectorAll('.ant-modal-footer button')).map((el) => el.textContent)).toEqual([
      'Cancel',
      'Share anyway',
      'Add an API key first',
    ]);
    await click(button('Add an API key first', modal));
    expect(text(dialog()?.querySelector('.ant-modal-title'))).toBe('Add a key to Codex Pool');
  });

  it('asks before making a shared pool just its owner’s: who loses it, which keys go with them, what stays (03-5)', async () => {
    await mount(PAGE);
    await pick('Just me');
    const confirm = document.body.querySelector<HTMLElement>('.ant-modal-confirm')!;
    expect(text(confirm.querySelector('.ant-modal-confirm-title'))).toBe('Make Codex Pool just yours?');
    expect(text(confirm.querySelector('.ant-modal-confirm-content'))).toBe(
      'Zhang Min and Lin Wei lose it at once, and their sessions on it stop. zm-proj leaves with Zhang Min, because a key goes with whoever added it. Your ChatGPT accounts and orbit-org-1 stay.',
    );
    expect(text(confirm.querySelector('.ant-modal-confirm-content b'))).toBe('zm-proj leaves with Zhang Min');
    expect(button('Cancel', confirm)).not.toBeNull();
    expect(button('Make it just mine', confirm)?.classList.contains('ant-btn-dangerous')).toBe(true);
    expect(sent).toEqual([]);
    await click(button('Make it just mine', confirm));
    expect(sent).toEqual([
      { method: 'DELETE', path: `${AT}/people/${ZHANG}`, body: undefined },
      { method: 'DELETE', path: `${AT}/people/${LIN}`, body: undefined },
    ]);
  });

  it('heads the pool’s card on the Infrastructure page by who reads it (03-6)', async () => {
    const head = () => container.querySelector<HTMLElement>('.pool-sec .pool-card .re-head')!;
    asOwner([], []);
    await mount('/infrastructure');
    expect(head().querySelector('.pool-shared-chip')).toBeNull();
    expect(text(head().querySelector('.re-summary'))).toBe('Just me · 2 of 2 accounts available');
    expect(head().querySelector('.pool-people')).toBeNull();
    expect(text(head().querySelector('.pool-gauge-pct'))).toBe('Weekly 97%');
    await act(async () => root.unmount());
    container.remove();

    asOwner([ZHANG, LIN]);
    await mount('/infrastructure');
    expect(text(head().querySelector('.pool-shared-chip'))).toBe('SHARED');
    expect(text(head().querySelector('.re-summary'))).toBe('4 of 4 accounts available');
    expect(Array.from(head().querySelectorAll('.pool-people .pool-av')).map((el) => el.textContent)).toEqual([
      'J',
      'Z',
      'L',
    ]);
    expect(text(head().querySelector('.pool-gauge-pct'))).toBe('Weekly 97%');
    await act(async () => root.unmount());
    container.remove();

    asZhang();
    await mount('/infrastructure');
    expect(text(head().querySelector('.pool-shared-chip'))).toBe('SHARED');
    expect(text(head().querySelector('.re-summary'))).toBe(
      'jianghailong’s · 4 accounts and keys you can run on',
    );
    expect(head().querySelector('.pool-people')).toBeNull();
    expect(head().querySelector('.pool-gauge')).toBeNull();
    expect(text(head().querySelector('.re-manage'))).toBe('Manage →');
  });
});
