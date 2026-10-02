// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { encodeId } from '../lib/idCodec';
import type { ProviderPool } from '../lib/providerPools';
import type { SharedPool, SharedPoolKey, SharedPoolPerson } from '../lib/sharedPools';
import { ProviderPoolPage } from './ProviderPoolPage';
import { ProvidersPage } from './ProvidersPage';

/**
 * A shared pool — several people's OpenAI API keys under one name — on /providers and on its own page,
 * mounted for real against a fake API: the card and what each key's row says, what each person may do
 * there (an admin, the contributor of a key, a member with no key), and how a pool is made and a key
 * goes in, is refused, and is replaced. The key typed is sent once and never shown again.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const apiMock = vi.mocked(api);

const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const WIKOVA = id(1);
const ZHANG = id(2);
const CHEN = id(3);
const LIN = id(4);
const NAMES: Record<string, string> = { [WIKOVA]: 'Wikova', [ZHANG]: 'Zhang Min', [CHEN]: 'Chen Yu', [LIN]: 'Lin Wei' };
const POOL_ID = id(900);
const ROOT = '/providers/shared-pools';
const AT = `${ROOT}/${POOL_ID}`;
const NEW_KEY = 'sk-proj-9tRkQm2Zx8VbN4Lc7Hd39E4D';

const spend = (costUsd: number) => ({ inputTokens: 0, outputTokens: 0, costUsd });

/** The board's pool (docs/mocks/codex-shared-pool/02): four people, five keys in every state, as `viewer`
 *  reads it. */
function team(viewer: string, over: Partial<SharedPool> = {}): SharedPool {
  const person = (userId: string, keys: number, sessions: number, cost: number): SharedPoolPerson => ({
    userId,
    name: NAMES[userId],
    role: userId === WIKOVA ? 'ADMIN' : 'MEMBER',
    creator: userId === WIKOVA,
    you: userId === viewer,
    keys,
    sessions,
    usage: spend(cost),
  });
  const key = (n: number, label: string, contributor: string, over: Partial<SharedPoolKey>): SharedPoolKey => ({
    id: id(n),
    label,
    fingerprint: 'sk-…0000',
    state: 'ACTIVE',
    enabled: true,
    shareCap: 50,
    spentUntil: null,
    contributor: { userId: contributor, name: NAMES[contributor], you: contributor === viewer },
    usage: { ...spend(0), othersCostUsd: 0 },
    running: false,
    next: false,
    ...over,
  });
  const others = (usd: number) => ({ usage: { ...spend(usd), othersCostUsd: usd } });
  return {
    id: POOL_ID,
    slug: 'team-codex',
    label: 'Team Codex',
    engine: 'codex',
    membersCanAdd: true,
    ownKeyFirst: true,
    viewerRole: viewer === WIKOVA ? 'ADMIN' : 'MEMBER',
    window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    people: [person(WIKOVA, 2, 23, 34), person(ZHANG, 2, 19, 30), person(CHEN, 1, 14, 24), person(LIN, 0, 6, 12)],
    keys: [
      key(11, 'orbit-org-1', WIKOVA, { fingerprint: 'sk-…AB12', next: true, ...others(12.4) }),
      key(12, 'orbit-org-2', ZHANG, { fingerprint: 'sk-…7K2P', running: true, ...others(31) }),
      key(13, 'ios-build', CHEN, { fingerprint: 'sk-…QZ03', ...others(50) }),
      key(14, 'wikova-backup', WIKOVA, { fingerprint: 'sk-…M4T7', state: 'INVALID', ...others(6.2) }),
      key(15, 'zhang-old', ZHANG, { fingerprint: 'sk-…31FD', enabled: false }),
    ],
    ...over,
  };
}

/** The board's pool plus one key OpenAI has put out of budget (`spentUntil`, migration 0321), which
 *  P2's gateway sets on an upstream `insufficient_quota` and the claim skips. */
function teamWithOutOfBudget(): SharedPool {
  const board = team(WIKOVA);
  return {
    ...board,
    keys: [
      ...board.keys,
      {
        ...board.keys[0],
        id: id(16),
        label: 'chen-org-2',
        fingerprint: 'sk-…5V8N',
        spentUntil: '2026-09-30T06:00:00.000Z',
        next: false,
        contributor: { userId: CHEN, name: NAMES[CHEN], you: false },
        usage: { ...spend(18), othersCostUsd: 18 },
      },
    ],
  };
}

const CLAUDE_POOL: ProviderPool = {
  id: id(901),
  slug: 'claude-accounts',
  label: 'Claude accounts',
  resetsAt: null,
  members: [],
};

interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

describe('a shared pool on /providers and on its own page', { timeout: 30_000 }, () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let path = '';
  let shared: SharedPool[] = [];
  let sent: Sent[] = [];
  /** How the server answers a key put in. */
  let onAddKey: (body: { label: string; apiKey: string; shareCap: number | null }) => unknown = () => ({});

  function Probe() {
    path = useLocation().pathname;
    return null;
  }

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
    if (!row) throw new Error(`no member row for ${name}`);
    return row;
  };
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
  /** Type into an input the way a person does: React reads the native value off an input event. */
  const type = async (input: HTMLInputElement | null | undefined, value: string) => {
    if (!input) throw new Error('nothing to type into');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };
  const fieldInput = (label: string, scope: ParentNode) => {
    const field = Array.from(scope.querySelectorAll<HTMLElement>('.np-field')).find(
      (el) => el.querySelector('.np-field-l')?.textContent === label,
    );
    return field?.querySelector<HTMLInputElement>('input') ?? null;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    path = '';
    shared = [team(WIKOVA)];
    sent = [];
    onAddKey = () => ({});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    // The confirmations are popovers, which measure themselves.
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
        if (p === ROOT) return shared;
        if (p === '/providers/pools') return [CLAUDE_POOL];
        return [];
      }
      sent.push({ method, path: p, body: init?.body });
      if (method === 'POST' && p === ROOT) return team(WIKOVA, { people: team(WIKOVA).people.slice(0, 1), keys: [] });
      if (method === 'POST' && p === `${AT}/keys`) return onAddKey(init?.body as never);
      return team(WIKOVA);
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

  it("heads the pools with the shared one: Codex, SHARED, its people, and the key a session starts on next", async () => {
    await mount('/providers');
    const cards = container.querySelectorAll<HTMLElement>('.pool-sec .pool-card');
    expect(cards).toHaveLength(2);
    const [card, claude] = cards;
    const head = card.querySelector<HTMLElement>('.re-head')!;
    expect(head.querySelector('.re-runner')?.textContent).toBe('Team Codex');
    expect(head.querySelector('.pool-shared-chip')?.textContent).toBe('SHARED');
    expect(head.querySelectorAll('.pool-people .pool-av')).toHaveLength(4);
    expect(head.querySelector('.re-summary')?.textContent).toBe('2 of 5 keys available');
    expect(head.querySelector('.pool-gauge-name')?.textContent).toBe('Next: orbit-org-1');
    expect(head.querySelector('.pool-gauge-pct')?.textContent).toBe('Monthly 25%');
    // The account pool beside it wears Claude's mark and is nobody else's.
    expect(claude.querySelector('.re-runner')?.textContent).toBe('Claude accounts');
    expect(claude.querySelector('.pool-shared-chip')).toBeNull();
    expect(claude.querySelector('.pool-people')).toBeNull();
    // Where another pool is made.
    expect(button('New pool', container.querySelector('.pool-sec-head')!)).not.toBeNull();
    expect(container.querySelector('.pool-sec .re-sec-sub')?.textContent).toBe(
      'Several keys under one name — each session starts on one with room, and moves on when it runs out.',
    );
  });

  it("gives each key a row: whose it is and its fingerprint, where it stands, and what the others spent of its cap", async () => {
    await mount('/providers');
    const status = (label: string) => rowOf(label).querySelector('.pool-status')?.textContent;
    const money = (label: string) => rowOf(label).querySelector('.pool-key-money .re-quota-head')?.textContent;
    expect(rowOf('orbit-org-1').querySelector('.re-name')?.textContent).toBe('orbit-org-1youNEXT');
    expect(rowOf('orbit-org-1').querySelector('.pool-key-mask')?.textContent).toBe('Wikova · sk-…AB12');
    expect([
      'orbit-org-1',
      'orbit-org-2',
      'ios-build',
      'wikova-backup',
      'zhang-old',
    ].map((label) => [status(label), money(label)])).toEqual([
      ['Available', 'Others$12.40 of $50'],
      ['Running now', 'Others$31.00 of $50'],
      ['At cap · resets Oct 1', 'Others$50.00 of $50'],
      ['Invalid', 'Others$6.20 of $50'],
      ['Disabled', 'Others$0.00 of $50'],
    ]);
    // The refused key: its contributor (here also an admin) replaces it from the card; nothing is
    // taken out from the overview.
    expect(rowOf('wikova-backup').querySelector('.pool-why')?.textContent).toBe(
      'Rejected by OpenAI — replace it with a working key to put it back in the pool.',
    );
    expect(button('Replace key', rowOf('wikova-backup'))).not.toBeNull();
    expect(container.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(0);
    expect(container.querySelectorAll('[aria-label^="Disable "]')).toHaveLength(0);
  });

  it('says a key OpenAI put out of budget is out of budget, and counts it as no session can start on it', async () => {
    shared = [teamWithOutOfBudget()];
    await mount('/providers');
    expect(rowOf('chen-org-2').querySelector('.pool-status')?.textContent).toBe('Out of budget · resets Sep 30');
    // The one OpenAI put out of budget and the one at its cap are both out; the other two can run.
    expect(container.querySelector('.pool-sec .pool-card .re-summary')?.textContent).toBe('2 of 6 keys available');
    // It is not the key a session starting now runs on, and the card's head still names the one that is.
    expect(rowOf('chen-org-2').querySelector('.re-chip')).toBeNull();
    expect(container.querySelector('.pool-sec .pool-card .pool-gauge-name')?.textContent).toBe('Next: orbit-org-1');
  });

  it('heads a pool no key can run on with the mark that stopped them, and the first of them back', async () => {
    const board = team(WIKOVA);
    const spent = {
      ...board.keys[0],
      id: id(17),
      label: 'chen-org-2',
      spentUntil: '2026-09-30T06:00:00.000Z',
      next: false,
      running: false,
      contributor: { userId: CHEN, name: NAMES[CHEN], you: false },
    };
    shared = [{ ...board, keys: [spent] }];
    await mount('/providers');
    expect(container.querySelector('.pool-sec .pool-card .pool-gauge')?.textContent).toBe(
      'All out of budget · resets Sep 30',
    );
    expect(container.querySelector('.pool-sec .pool-card .re-summary')?.textContent).toBe('0 of 1 key available');
  });

  it('says the same of that key on the pool page, where the whole pool reads as its own head', async () => {
    shared = [teamWithOutOfBudget()];
    await mount(`/providers/pools/${POOL_ID}`);
    expect(rowOf('chen-org-2').querySelector('.pool-status')?.textContent).toBe('Out of budget · resets Sep 30');
    expect(text()).toContain('2 of 6 keys available');
  });

  it('shows somebody who may not replace a refused key who can, and no button', async () => {
    shared = [team(LIN)];
    await mount('/providers');
    expect(button('Replace key', rowOf('wikova-backup'))).toBeNull();
    expect(rowOf('wikova-backup').querySelector('.pool-why')?.textContent).toBe(
      'Rejected by OpenAI — only Wikova or the pool’s admins can replace it.',
    );
    // Not their key: no "you" on it, and the next key is theirs to be told of all the same.
    expect(rowOf('orbit-org-1').querySelector('.pool-you')).toBeNull();
  });

  it('replaces a refused key from its card with a working one, sending it once', async () => {
    await mount('/providers');
    await click(button('Replace key', rowOf('wikova-backup')));
    expect(dialog()?.querySelector('.ant-modal-title')?.textContent).toBe('Replace wikova-backup');
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Key"]'), NEW_KEY);
    await click(button('Replace key', dialog()!));
    expect(sent).toEqual([
      { method: 'PUT', path: `${AT}/keys/${id(14)}/secret`, body: { apiKey: NEW_KEY } },
    ]);
  });

  it('makes a shared Codex pool with the people it names, and opens it', async () => {
    await mount('/providers');
    await click(button('New pool'));
    const modal = dialog()!;
    expect(modal.querySelector('.ant-modal-title')?.textContent).toBe('New account pool');
    expect(modal.querySelector('.ant-segmented-item-selected')?.textContent?.trim()).toBe('Codex');
    // "Just me" is a pool of one's own ChatGPT account (ProvidersPage.codexLogin.test.tsx); shared, a
    // Codex pool holds the people's OpenAI API keys.
    await click(modal.querySelector('input[type="radio"][value="people"]'));
    await type(fieldInput('Name', modal), 'Team Codex');
    // An address typed and not yet a tag still counts.
    await type(modal.querySelector<HTMLInputElement>('.np-people input'), 'zhang@example.com');
    await click(modal.querySelector('.np-can-add input'));
    await click(button('Create pool', modal));
    expect(sent).toEqual([
      { method: 'POST', path: ROOT, body: { label: 'Team Codex' } },
      { method: 'POST', path: `${AT}/people`, body: { email: 'zhang@example.com' } },
      { method: 'PATCH', path: AT, body: { membersCanAdd: false } },
    ]);
    expect(path).toBe(`/providers/pools/${POOL_ID}`);
  });

  it("gives an admin the whole page: every key's removal, their own keys' switch, people, rules, and deleting it", async () => {
    await mount(`/providers/pools/${POOL_ID}`);
    expect(container.querySelector('.pool-page-title h1')?.textContent).toBe('Team Codex');
    expect(container.querySelector('.pool-page-title .pool-shared-chip')?.textContent).toBe('SHARED');
    expect(text()).toContain(
      'Shared Codex pool · 4 members · 2 of 5 keys available · each session starts on the key with the most room, and stays on it until that one runs out.',
    );
    expect(button('Add a key')).not.toBeNull();
    expect(container.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(5);
    expect(container.querySelectorAll('[aria-label^="Disable "]')).toHaveLength(2);
    expect(labelled('Disable orbit-org-1')).toHaveLength(1);
    expect(labelled('Disable wikova-backup')).toHaveLength(1);

    // Members: what each put in and ran, everyone's share, and a menu on everyone but oneself.
    expect(personOf('Wikova').textContent).toBe('WWikovayouADMIN2 keys · 23 sessions34%');
    expect(personOf('Lin Wei').querySelector('.pool-person-meta')?.textContent).toBe('No key · 6 sessions');
    expect(personOf('Lin Wei').querySelector('.pool-share-pct')?.textContent).toBe('12%');
    expect(container.querySelectorAll('[aria-label^="Manage "]')).toHaveLength(3);
    expect(labelled('Manage Wikova')).toHaveLength(0);
    expect(button('Add members')).not.toBeNull();

    // Rules are an admin's to change.
    const rules = container.querySelector<HTMLElement>('.pool-rules-card')!;
    expect(rules.querySelector('.pool-head-note')).toBeNull();
    const [membersCanAdd] = rules.querySelectorAll<HTMLButtonElement>('button.ant-switch');
    expect(membersCanAdd.disabled).toBe(false);
    await click(membersCanAdd);
    await click(labelled('Disable orbit-org-1')[0]);
    expect(sent).toEqual([
      { method: 'PATCH', path: AT, body: { membersCanAdd: false } },
      { method: 'PATCH', path: `${AT}/keys/${id(11)}`, body: { enabled: false } },
    ]);

    // Taking somebody else's key out asks first.
    sent = [];
    await click(labelled('Remove zhang-old from this pool')[0]);
    await click(button('Remove', document.body.querySelector('.ant-popconfirm')!));
    expect(sent).toEqual([{ method: 'DELETE', path: `${AT}/keys/${id(15)}` }]);

    expect(button('Delete pool')).not.toBeNull();
    expect(button('Leave pool')).toBeNull();
    expect(container.querySelector('.pool-danger-note')?.textContent).toBe(
      'Its keys are removed from the Orbit server and no session can run on it.',
    );
  });

  it("gives a member with no key a page that reads the rules and lets them leave, and nothing of anybody else's", async () => {
    shared = [team(LIN)];
    await mount(`/providers/pools/${POOL_ID}`);
    expect(container.querySelectorAll('[aria-label^="Remove "]')).toHaveLength(0);
    expect(container.querySelectorAll('[aria-label^="Disable "]')).toHaveLength(0);
    expect(container.querySelectorAll('[aria-label^="Manage "]')).toHaveLength(0);
    expect(button('Replace key')).toBeNull();
    expect(button('Add members')).toBeNull();
    expect(personOf('Lin Wei').querySelector('.pool-you')?.textContent).toBe('you');

    const rules = container.querySelector<HTMLElement>('.pool-rules-card')!;
    expect(rules.querySelector('.pool-head-note')?.textContent).toBe('Set by the pool’s admins');
    for (const toggle of rules.querySelectorAll<HTMLButtonElement>('button.ant-switch')) expect(toggle.disabled).toBe(true);

    // Members may add while the pool lets them.
    expect(button('Add a key')).not.toBeNull();
    expect(button('Delete pool')).toBeNull();
    expect(container.querySelector('.pool-danger-note')?.textContent).toBe('Your keys leave with you.');
    await click(button('Leave pool'));
    await click(button('Leave', document.body.querySelector('.ant-popconfirm')!));
    expect(sent).toEqual([{ method: 'POST', path: `${AT}/leave` }]);
    expect(path).toBe('/providers');
  });

  it('takes Add a key away from a member once only admins may put keys in', async () => {
    shared = [team(LIN, { membersCanAdd: false })];
    await mount(`/providers/pools/${POOL_ID}`);
    expect(button('Add a key')).toBeNull();
  });

  it('puts a key in: what it means, then its name, the key and the cap — and after, only its fingerprint', async () => {
    shared = [team(LIN)];
    onAddKey = () =>
      team(LIN, {
        keys: [
          ...team(LIN).keys,
          {
            ...team(LIN).keys[0],
            id: id(16),
            label: 'lin-org-1',
            fingerprint: 'sk-…9E4D',
            contributor: { userId: LIN, name: 'Lin Wei', you: true },
            next: false,
          },
        ],
      });
    await mount(`/providers/pools/${POOL_ID}`);
    await click(button('Add a key'));
    let modal = dialog()!;
    expect(modal.querySelector('.ant-modal-title')?.textContent).toBe('Add a key to Team Codex');
    expect(modal.textContent).toContain('Paste an OpenAI API key to put in this pool.');
    expect(modal.querySelector('.pa-facts')?.textContent).toContain(
      'Everyone in Team Codex can run sessions on it — 4 people. Their sessions spend this key’s budget.',
    );
    expect(modal.querySelector('.pa-risk')?.textContent).toBe(
      'Keys can’t be resold. Everything run with this key is billed to its account, and the person who adds it is responsible for it.',
    );

    await click(button('Continue', modal));
    modal = dialog()!;
    expect(button('Add key', modal)?.disabled).toBe(true);
    await type(fieldInput('Name', modal), 'lin-org-1');
    await type(modal.querySelector<HTMLInputElement>('input[aria-label="Key"]'), NEW_KEY);
    await type(modal.querySelector<HTMLInputElement>('input[aria-label="Limit"]'), '50');
    expect(modal.textContent).toContain(
      'Checked once, then only its fingerprint (sk-…9E4D) is shown — the key itself stays on the Orbit server.',
    );
    await click(button('Add key', modal));
    expect(sent).toEqual([
      { method: 'POST', path: `${AT}/keys`, body: { label: 'lin-org-1', apiKey: NEW_KEY, shareCap: 50 } },
    ]);

    modal = dialog()!;
    expect(modal.querySelector('.pa-done-t')?.textContent).toBe('lin-org-1 is in Team Codex');
    expect(modal.querySelector('.pa-done-s')?.textContent).toBe(
      'sk-…9E4D · ready for the next session. Only you and the pool’s admins can replace it.',
    );
    expect(modal.querySelector('.pa-acct-s')?.textContent).toBe('Lin Wei · sk-…9E4D · only its fingerprint is ever shown');
    // Sent once, and on this page nowhere after.
    expect(document.body.innerHTML).not.toContain(NEW_KEY);
    expect(button('Done', modal)).not.toBeNull();
  });

  it('refuses the same key twice, saying who added it, and offers another', async () => {
    shared = [team(LIN)];
    onAddKey = () => {
      throw new ApiError('This key is already in "Team Codex" — Wikova put it in', 409, 'POOL_KEY_DUPLICATE', {
        code: 'POOL_KEY_DUPLICATE',
        addedBy: { name: 'Wikova', you: false },
      });
    };
    await mount(`/providers/pools/${POOL_ID}`);
    await click(button('Add a key'));
    await click(button('Continue', dialog()!));
    await type(fieldInput('Name', dialog()!), 'lin-org-1');
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Key"]'), NEW_KEY);
    await click(button('Add key', dialog()!));
    const modal = dialog()!;
    expect(modal.querySelector('.pa-dup .pa-done-t')?.textContent).toBe('This key is already in Team Codex');
    expect(modal.querySelector('.pa-dup .pa-done-s')?.textContent).toBe(
      'Wikova added it. The same key twice doesn’t add budget — add a different one.',
    );
    expect(button('Close', modal)).not.toBeNull();
    await click(button('Add another key', modal));
    // Back to the form, the refused key gone from it.
    expect(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Key"]')?.value).toBe('');
    expect(fieldInput('Name', dialog()!)?.value).toBe('lin-org-1');
  });

  it("says what is wrong with a key that isn't one, where it was typed", async () => {
    shared = [team(LIN)];
    onAddKey = () => {
      throw new ApiError("That isn't an OpenAI API key — paste an organization or project key (sk-…)", 400, 'POOL_KEY_FORMAT');
    };
    await mount(`/providers/pools/${POOL_ID}`);
    await click(button('Add a key'));
    await click(button('Continue', dialog()!));
    await type(fieldInput('Name', dialog()!), 'mine');
    await type(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Key"]'), 'sk-ant-api03-nope');
    await click(button('Add key', dialog()!));
    expect(dialog()!.querySelector('.np-field-err')?.textContent).toBe(
      "That isn't an OpenAI API key — paste an organization or project key (sk-…)",
    );
    expect(dialog()!.querySelector('.pa-done')).toBeNull();
  });
});
