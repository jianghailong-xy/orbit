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
import { ProviderPoolPage } from './ProviderPoolPage';

/**
 * A Codex pool shared with people before it has an API key (docs/mocks/account-pool-access/02, the
 * boundary state), on its page, mounted for real against a fake API. Its owner's ChatGPT accounts only
 * ever run the owner's own sessions, so until a key goes in nobody they added can start a session on it:
 * "Who can use it" says so at its foot, by name, and offers Add an API key — which opens Add a key. The
 * pool and its people are the boards' own: jianghailong's Codex Pool, shared with Zhang Min and Lin Wei.
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

/** jianghailong's ChatGPT account, as GET /providers/pools serves it to him. */
const ACCOUNT: CodexLogin = {
  state: 'ACTIVE',
  email: 'jianghailong.rd@gmail.com',
  plan: 'plus',
  fingerprint: '…016a',
  lastError: null,
  expiresAt: IN_THREE_DAYS,
  linkedAt: '2026-09-28T10:00:00.000Z',
  usage: {
    provider: 'codex',
    primary: { utilization: 6, resetsAt: IN_AN_HOUR, windowDurationMins: 300 },
    secondary: { utilization: 97, resetsAt: IN_THREE_DAYS, windowDurationMins: 10080 },
  },
  usageUnavailable: null,
};

/** The pool as its owner's providers read it: his ChatGPT account. */
const ownPool = (label: string): ProviderPool => ({
  id: POOL_ID,
  slug: 'codex-pool',
  label,
  engine: 'codex',
  login: ACCOUNT,
  logins: [ACCOUNT],
  resetsAt: null,
  unavailable: null,
  members: [],
});

/** The one API key a pool may have: orbit-org-1, jianghailong's. */
const ORBIT_ORG_1 = (viewer: string): SharedPoolKey => ({
  id: id(11),
  label: 'orbit-org-1',
  fingerprint: 'sk-…AB12',
  state: 'ACTIVE',
  enabled: true,
  shareCap: 50,
  spentUntil: null,
  contributor: { userId: JIANG, name: NAMES[JIANG], you: viewer === JIANG },
  usage: { ...spend(0), othersCostUsd: 0 },
  running: false,
  next: true,
});

/** Who can use the pool and its API keys (GET /providers/shared-pools[/:id]), as `viewer` reads them.
 *  `people` are the ones in it besides its owner; nobody has run anything on it yet. */
function access(
  viewer: string,
  people: string[],
  { label = 'Codex Pool', keys = [], shared = false }: { label?: string; keys?: SharedPoolKey[]; shared?: boolean } = {},
): SharedPool {
  const person = (userId: string): SharedPoolPerson => ({
    userId,
    name: NAMES[userId],
    role: userId === JIANG ? 'ADMIN' : 'MEMBER',
    creator: userId === JIANG,
    you: userId === viewer,
    keys: keys.filter((key) => key.contributor.userId === userId).length,
    sessions: 0,
    usage: spend(0),
  });
  return {
    id: POOL_ID,
    slug: 'codex-pool',
    label,
    engine: 'codex',
    // Made on the shared pools page (migration 0321): API keys alone, no ChatGPT account of anybody's.
    shared,
    ownerHasChatGPT: !shared,
    membersCanAdd: true,
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

describe('a Codex pool shared with people before it has an API key', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let sent: Sent[] = [];
  /** What the server answers, as whoever is signed in. */
  let ownPools: ProviderPool[] = [];
  let sharedList: SharedPool[] = [];
  let ownAccess: SharedPool | null = null;

  /** jianghailong, with `people` added to his Codex pool of his own. */
  const asOwner = (people: string[], options?: { label?: string; keys?: SharedPoolKey[] }) => {
    ownPools = [ownPool(options?.label ?? 'Codex Pool')];
    sharedList = [];
    ownAccess = access(JIANG, people, options);
  };

  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  const mount = async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[PAGE]}>
            <AntApp>
              <Routes>
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
  const who = () => container.querySelector<HTMLElement>('.who-card')!;
  const warning = () => who().querySelector<HTMLElement>('.who-warn');
  const button = (words: string, scope: ParentNode = document.body) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((el) => el.textContent?.trim() === words) ??
    null;
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

  it('tells its owner at the foot of Who can use it that the people they added can’t start a session yet, and offers Add an API key (02, boundary state)', async () => {
    await mount();
    expect(text(who().querySelector('.re-runner'))).toBe('Who can use it3');
    const warn = warning();
    expect(warn).not.toBeNull();
    // The card's last word, in amber with the warning triangle.
    expect(who().lastElementChild).toBe(warn);
    expect(warn!.querySelector('.anticon-warning')).not.toBeNull();
    expect(text(warn!.querySelector('b'))).toBe('Zhang Min and Lin Wei can’t start a session here yet.');
    expect(text(warn!.querySelector('span:not(.anticon)'))).toBe(
      'Zhang Min and Lin Wei can’t start a session here yet. Codex Pool has no API key, and your ChatGPT accounts only run your own sessions.',
    );
    const add = button('Add an API key', warn!);
    expect(add).not.toBeNull();
    expect(add!.classList.contains('ant-btn-primary')).toBe(true);

    // It opens Add a key, as the page's own Add account → Paste an OpenAI API key does; nothing is sent
    // on the way.
    await click(add);
    expect(text(dialog()?.querySelector('.ant-modal-title'))).toBe('Add a key to Codex Pool');
    expect(sent).toEqual([]);
  });

  it('names the pool by its own name, and whoever its owner added', async () => {
    asOwner([LIN], { label: 'Orbit Codex' });
    await mount();
    expect(text(warning()?.querySelector('span:not(.anticon)'))).toBe(
      'Lin Wei can’t start a session here yet. Orbit Codex has no API key, and your ChatGPT accounts only run your own sessions.',
    );
    await click(button('Add an API key', warning()!));
    expect(text(dialog()?.querySelector('.ant-modal-title'))).toBe('Add a key to Orbit Codex');
  });

  it('leaves the ChatGPT accounts out of it on a pool made on the shared pools page, which holds none', async () => {
    ownPools = [];
    sharedList = [access(JIANG, [ZHANG, LIN], { label: 'Team Codex', shared: true })];
    ownAccess = null;
    await mount();
    expect(text(warning()?.querySelector('span:not(.anticon)'))).toBe(
      'Zhang Min and Lin Wei can’t start a session here yet. Team Codex has no API key.',
    );
    expect(button('Add an API key', warning()!)).not.toBeNull();
  });

  it('says nothing of it once the pool has a key, or while nobody but its owner uses it', async () => {
    asOwner([ZHANG, LIN], { keys: [ORBIT_ORG_1(JIANG)] });
    await mount();
    expect(text(who().querySelector('.re-runner'))).toBe('Who can use it3');
    expect(warning()).toBeNull();
    expect(button('Add an API key')).toBeNull();
    await act(async () => root.unmount());
    container.remove();

    asOwner([]);
    await mount();
    expect(text(who().querySelector('.ant-segmented-item-selected'))).toBe('Just me');
    expect(warning()).toBeNull();
    expect(button('Add an API key')).toBeNull();
  });

  it('is said to its owner alone: somebody they added reads no such warning on the same pool', async () => {
    ownPools = [];
    sharedList = [access(ZHANG, [ZHANG, LIN])];
    ownAccess = null;
    await mount();
    expect(text(who().querySelector('.pool-head-note'))).toBe('Set by jianghailong · share of this month’s API key use');
    expect(warning()).toBeNull();
    expect(button('Add an API key')).toBeNull();
  });
});
