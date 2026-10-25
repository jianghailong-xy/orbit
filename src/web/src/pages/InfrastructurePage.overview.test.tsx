// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import type { ProviderPool } from '../lib/providerPools';
import { InfrastructurePage } from './InfrastructurePage';

/**
 * What /infrastructure says about what the agents can run on (docs/mocks/infrastructure-focus). First,
 * on each machine's card, its engines: a chip each for what its sessions can run on, and an engine
 * signed out there in amber, signed in again from its chip — with no block above the machines to say it
 * a second time: an offline machine's card and an unavailable pool's say theirs. Then, at the end of the
 * page, By engine, a row per engine (docs/mocks/provider-engine-decoupling/web-1-infrastructure.html):
 * Ready with a machine signed in to it, a key that runs on it or a pool of it — each key under every
 * engine its `engines` names — and Not set up, with the ways to get one, without.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const MAC = id(1);
const HPC = id(2);
const THINKPAD = id(3);
const POOL = id(9);

const machine = (runnerId: string, name: string, over: Partial<Runner> = {}): Runner => ({
  id: runnerId,
  name,
  online: true,
  activeSessions: 0,
  maxConcurrent: 4,
  lastHeartbeatAt: new Date().toISOString(),
  engines: [],
  ...over,
});
// The mock's three machines: Mac Studio with two Claude accounts and Codex signed out, HPC signed in
// to Claude, to two Codex accounts and to Kimi, and ThinkPad gone since yesterday.
const MAC_STUDIO = machine(MAC, 'Mac Studio', {
  engines: [
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', name: 'Personal Max', home: '/Users/me/.orbit/default', auth: 'yes' },
        { id: 'slot-2', name: 'Work', home: '/Users/me/.orbit/slot-2', auth: 'yes' },
      ],
    },
    { engine: 'codex', installed: true, auth: 'no' },
    { engine: 'kimi', installed: false, auth: 'unknown' },
  ],
});
const HPC_BOX = machine(HPC, 'HPC', {
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    {
      engine: 'codex',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', home: '/root/.codex', auth: 'yes' },
        { id: 'slot-2', name: 'Team', home: '/root/.orbit/codex-2', auth: 'yes' },
      ],
    },
    { engine: 'kimi', installed: true, auth: 'yes' },
  ],
});
const THINKPAD_BOX = machine(THINKPAD, 'ThinkPad', {
  online: false,
  lastHeartbeatAt: new Date(Date.now() - DAY - HOUR).toISOString(),
  // What it last said: offline, none of it is anything a session can use, or sign in.
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'no' },
  ],
});

const key = (n: number, label: string, over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: id(100 + n),
  slug: `key-${n}`,
  label,
  runtime: 'claude',
  engines: ['claude', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.anthropic.com',
  models: [
    { value: 'claude-opus-5', label: 'Claude Opus 5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ],
  defaultModel: 'claude-opus-5',
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  poolRefusal: null,
  ...over,
});
const ANTHROPIC = key(1, 'Anthropic (Claude)');
const ANTHROPIC_WORK = key(2, 'Anthropic · Work', { defaultModel: 'claude-sonnet-5' });
// DeepSeek's key runs on Claude Code, OpenCode and DeepSeek Harness, and is listed under all three.
const DEEPSEEK = key(3, 'DeepSeek', {
  engines: ['claude', 'opencode', 'dsh'] as ProviderRow['engines'],
  baseUrl: 'https://api.deepseek.com/anthropic',
  presetSlug: 'deepseek',
  models: [
    { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ],
  defaultModel: 'deepseek-v4-pro',
});
const MOONSHOT = key(4, 'Kimi (Moonshot)', {
  runtime: 'kimi',
  engines: ['kimi', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.moonshot.ai/v1',
  presetSlug: 'moonshot',
  models: [{ value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }],
  defaultModel: 'kimi-k2.7-code',
});
const OPENAI_OFF = key(5, 'OpenAI', {
  runtime: 'codex',
  engines: ['codex', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.openai.com/v1',
  presetSlug: 'openai',
  models: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
  defaultModel: 'gpt-5.6-sol',
  enabled: false,
});

const claudePool = (over: Partial<ProviderPool> = {}): ProviderPool => ({
  id: POOL,
  slug: 'claude-keys',
  label: 'Claude keys',
  engine: 'claude',
  resetsAt: null,
  unavailable: null,
  members: [
    {
      id: ANTHROPIC.id,
      slug: ANTHROPIC.slug,
      label: ANTHROPIC.label,
      presetSlug: 'anthropic',
      enabled: true,
      planUsage: null,
      state: 'NO_QUOTA',
      resetsAt: null,
      next: true,
    },
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let path = '';
let runners: Runner[] = [];
let keys: ProviderRow[] = [];
let pools: ProviderPool[] = [];
let sent: Array<{ method: string; path: string; body?: unknown }> = [];

function Probe() {
  const location = useLocation();
  path = location.pathname + location.search;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  runners = [MAC_STUDIO, HPC_BOX, THINKPAD_BOX];
  keys = [ANTHROPIC, ANTHROPIC_WORK, DEEPSEEK];
  pools = [claudePool()];
  sent = [];
  apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path: p, ...(init?.body === undefined ? {} : { body: init.body }) });
      return {};
    }
    if (p === '/runners') return runners;
    if (p === '/providers/mine') return keys;
    if (p === '/providers/pools') return pools;
    if (p.endsWith('/login')) return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    return [];
  }) as typeof api);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
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
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/infrastructure']}>
          <Probe />
          <Routes>
            <Route path="/infrastructure" element={<InfrastructurePage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const button = (words: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((el) => text(el) === words) ?? null;
const link = (words: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLAnchorElement>('a')].find((el) => text(el) === words) ?? null;

/** A machine's card, by its name. */
const machineCard = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.re-runner-card')].find(
    (card) => text(card.querySelector('.re-runner')) === name,
  )!;
/** What a machine's card says it runs on, a chip each — and the Sign in beside one signed out. */
const chips = (name: string) =>
  [...machineCard(name).querySelectorAll<HTMLElement>('.mc-pair')].map((pair) => ({
    says: text(pair.querySelector('.mc-chip')),
    out: pair.querySelector('.mc-chip')!.classList.contains('out'),
    action: text(pair.querySelector('button')) ?? null,
  }));
/** An engine's row in By engine, by the name it heads with. */
const nameOf = (card: Element) => card.querySelector('.infra-engine-name')?.firstChild?.textContent;
const engineCard = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.infra-engine')].find((card) => nameOf(card) === name)!;
const stateOf = (name: string) => text(engineCard(name).querySelector('.infra-engine-state'));
const sourcesOf = (name: string) => [...engineCard(name).querySelectorAll('.infra-engine-src > div')].map(text);

describe('a machine’s engines, on its card', () => {
  it('chips what its sessions can run on, an engine signed out in amber, and signs that one in from its chip', async () => {
    await mount();
    // Nothing above the machines says it again.
    expect(document.body.querySelector('.infra-attn')).toBeNull();
    expect(chips('Mac Studio')).toEqual([
      { says: 'Claude Code ×2', out: false, action: null },
      { says: 'Codex signed out', out: true, action: 'Sign in' },
    ]);
    expect(chips('HPC')).toEqual([
      { says: 'Claude Code', out: false, action: null },
      { says: 'Codex ×2', out: false, action: null },
      { says: 'Kimi Code', out: false, action: null },
    ]);
    // ThinkPad's Codex said no too, but ThinkPad is offline: what it said, with nothing to press.
    expect(chips('ThinkPad')).toEqual([
      { says: 'Claude Code', out: false, action: null },
      { says: 'Codex signed out', out: true, action: null },
    ]);
    expect(machineCard('ThinkPad').querySelector('.re-runner-status')?.textContent).toBe('Offline');

    // The chip's Sign in opens the folded card on that engine's row, at the sign-in the row opens itself.
    const mac = machineCard('Mac Studio');
    expect(mac.classList.contains('collapsed')).toBe(true);
    await click(button('Sign in', mac.querySelector('.mc-row')!));
    expect(mac.classList.contains('collapsed')).toBe(false);
    const codex = mac.querySelector<HTMLElement>('.re-row[data-engine="codex"]')!;
    expect(codex.querySelector('.rsi')).not.toBeNull();
    // ...and brings it into view.
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    expect(scroll.mock.contexts.at(-1)).toBe(codex.querySelector('.rsi')!.closest('.re-panel'));
    await click(button('Sign in to Codex', codex));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${MAC}/login`, body: { engine: 'codex' } }]);
  });

  it('signs nothing in for an engine still running on another account, and draws none whose CLI would not say', async () => {
    runners = [
      machine(HPC, 'HPC', {
        engines: [
          // Default is out, Work is in: sessions there still run on Claude Code.
          {
            engine: 'claude',
            installed: true,
            auth: 'no',
            accounts: [
              { id: 'default', home: '/root/.claude', auth: 'no' },
              { id: 'slot-2', name: 'Work', home: '/root/.orbit/claude-2', auth: 'yes' },
            ],
          },
          { engine: 'codex', installed: true, auth: 'unknown' },
          { engine: 'kimi', installed: false, auth: 'no' },
        ],
      }),
    ];
    pools = [];
    await mount();
    // Claude Code still runs on Work, so its chip says how many of its two accounts are in, in amber,
    // with no Sign in of the engine's own — Default's row has it; Codex wouldn't say, so it has none.
    expect(chips('HPC')).toEqual([{ says: 'Claude Code 1 of 2 signed in', out: true, action: null }]);
  });

  it('leaves an offline machine to its card and an unavailable pool to its own, and opens each one’s page', async () => {
    // Its one account switched off: nothing in it can run, and the server says so.
    const off = { ...claudePool().members[0], enabled: false, state: 'DISABLED' as const, next: false };
    pools = [claudePool({ unavailable: 'No account can run', members: [off] })];
    await mount();
    const thinkpad = machineCard('ThinkPad');
    expect(thinkpad.classList.contains('offline')).toBe(true);
    await click(thinkpad.querySelector('a.re-manage'));
    expect(path).toBe(`/runners/${THINKPAD}`);

    act(() => root?.unmount());
    host?.remove();
    await mount();
    const pool = document.body.querySelector<HTMLElement>(`.pool-card[data-pool="${POOL}"]`)!;
    expect(text(pool.querySelector('.re-head .pool-gauge'))).toBe('No account can run');
    // Nor is it something Claude Code can run on.
    expect(sourcesOf('Claude Code')).not.toContainEqual(expect.stringMatching(/^Pool/));
    await click(pool.querySelector('a.re-manage'));
    expect(path).toBe(`/providers/pools/${POOL}`);
  });
});

describe('By engine', () => {
  it('ends the page’s sections, an engine to a row, each Ready with what can pay for it now', async () => {
    await mount();
    expect([...document.body.querySelectorAll('.re-sec-head h3')].map(text)).toEqual([
      'Machines',
      'API keys',
      'Account pools',
      'By engine',
    ]);
    const head = [...document.body.querySelectorAll('.re-sec-head')].at(-1)!;
    expect(text(head.querySelector('.re-sec-sub'))).toBe(
      'Which engines can start a session right now, and on what — read from the machines, keys and pools above.',
    );
    expect(
      [...document.body.querySelectorAll<HTMLElement>('.infra-engine')].map((card) => [
        nameOf(card),
        text(card.querySelector('.infra-engine-state')),
      ]),
    ).toEqual([
      ['Claude Code', 'Ready'],
      ['Codex', 'Ready'],
      ['Kimi Code', 'Ready'],
      ['Antigravity CLI', 'Not set up'],
      ['OpenCode', 'Ready'],
      ['DeepSeek Harness', 'Ready'],
    ]);
    // Online machines signed in to it, by how many of their accounts — what their chips say; keys that run
    // on it, by name; its pools.
    expect(sourcesOf('Claude Code')).toEqual([
      'Subscription · Mac Studio ×2, HPC',
      'API key · Anthropic (Claude), Anthropic · Work, DeepSeek',
      'Pool · Claude keys',
    ]);
    // Mac Studio's Codex is signed out, and ThinkPad's Claude Code is on a machine that is offline.
    expect(sourcesOf('Codex')).toEqual(['Subscription · HPC ×2']);
    expect(sourcesOf('Kimi Code')).toEqual(['Subscription · HPC']);
    // The same three keys again: OpenCode runs every one of them, DeepSeek Harness the DeepSeek key.
    expect(sourcesOf('OpenCode')).toEqual(['API key · Anthropic (Claude), Anthropic · Work, DeepSeek']);
    expect(sourcesOf('DeepSeek Harness')).toEqual(['API key · DeepSeek']);
  });

  it('puts one key under every engine it runs on, by its name alone: the model it starts on is on its own row', async () => {
    runners = [];
    pools = [];
    keys = [DEEPSEEK, MOONSHOT, OPENAI_OFF];
    await mount();
    // DeepSeek is a vendor of its own, and its one key runs on three engines.
    const claude = engineCard('Claude Code');
    expect(stateOf('Claude Code')).toBe('Ready');
    expect(sourcesOf('Claude Code')).toEqual(['API key · DeepSeek']);
    expect(claude.querySelector('.infra-model')).toBeNull();
    expect(sourcesOf('OpenCode')).toEqual(['API key · DeepSeek, Kimi (Moonshot)']);
    expect(stateOf('DeepSeek Harness')).toBe('Ready');
    expect(sourcesOf('DeepSeek Harness')).toEqual(['API key · DeepSeek']);
    expect(sourcesOf('Kimi Code')).toEqual(['API key · Kimi (Moonshot)']);
    // A key that is switched off is nothing Codex — or OpenCode — can run on.
    expect(stateOf('Codex')).toBe('Not set up');
    expect(sourcesOf('OpenCode').join()).not.toContain('OpenAI');
    // The model each key starts on is on its row in API keys.
    const row = (label: string) =>
      [...document.body.querySelectorAll<HTMLElement>('.vk-row')].find((el) => text(el.querySelector('.vk-name')) === label)!;
    expect(text(row('DeepSeek').querySelector('.vk-model'))).toBe('Starts on DeepSeek V4 Pro');
    expect(text(row('Kimi (Moonshot)').querySelector('.vk-model'))).toBe('Starts on Kimi K2.7 Code');
  });

  it('lists a Claude subscription token under Claude Code alone, as the server answers for it', async () => {
    runners = [];
    pools = [];
    keys = [key(7, 'Claude Max', { engines: ['claude'] as ProviderRow['engines'] }), ANTHROPIC_WORK];
    await mount();
    expect(sourcesOf('Claude Code')).toEqual(['API key · Claude Max, Anthropic · Work']);
    expect(sourcesOf('OpenCode')).toEqual(['API key · Anthropic · Work']);
  });

  it('says where OpenCode’s own sign-in is set up, beside the keys it runs', async () => {
    runners = [
      machine(HPC, 'HPC', { engines: [{ engine: 'opencode', installed: true, auth: 'yes', version: '1.18.35' }] }),
      machine(MAC, 'Mac Studio', { engines: [{ engine: 'opencode', installed: true, auth: 'no', version: '1.18.35' }] }),
    ];
    pools = [];
    keys = [MOONSHOT];
    await mount();
    expect(sourcesOf('OpenCode')).toEqual(['Own sign-in · HPC', 'API key · Kimi (Moonshot)']);
  });

  it('calls DeepSeek Harness Not set up without a DeepSeek key, and connects one that runs on Claude Code and OpenCode too', async () => {
    keys = [ANTHROPIC, { ...DEEPSEEK, enabled: false }];
    await mount();
    const card = engineCard('DeepSeek Harness');
    expect(card.classList.contains('none')).toBe(true);
    expect(text(card.querySelector('.infra-engine-src'))).toBe(
      'No DeepSeek key. Connect a DeepSeek key — it runs on Claude Code and OpenCode too.',
    );
    expect(link('Connect a DeepSeek key', card)?.getAttribute('href')).toBe('/providers/new/deepseek');
  });

  it('calls an engine with nothing that can pay for it Not set up, and offers to install it on a machine or connect a key', async () => {
    await mount();
    const card = engineCard('Antigravity CLI');
    expect(card.classList.contains('none')).toBe(true);
    expect(text(card.querySelector('.infra-engine-src'))).toBe(
      'No machine signed in, no key. Install on a machine or connect a key.',
    );
    expect(link('connect a key', card)?.getAttribute('href')).toBe('/providers/new');
    // Installing is done on a machine's card: the first one online, opened on that engine's row.
    expect(link('Install on a machine', card)?.getAttribute('href')).toBe(`/infrastructure?runner=${MAC}&engine=antigravity`);
    await click(link('Install on a machine', card));
    const mac = [...document.body.querySelectorAll<HTMLElement>('.re-runner-card')].find(
      (el) => text(el.querySelector('.re-runner')) === 'Mac Studio',
    )!;
    expect(mac.querySelector('.re-toggle')?.getAttribute('aria-expanded')).toBe('true');
    const row = mac.querySelector<HTMLElement>('.re-row[data-engine="antigravity"]')!;
    expect(row.classList.contains('focused')).toBe(true);
    expect(button('Install', row)).not.toBeNull();
  });

  it('is Not set up on what cannot be used now: a machine offline, a key switched off, a pool nothing can start on', async () => {
    runners = [
      machine(THINKPAD, 'ThinkPad', { online: false, engines: [{ engine: 'codex', installed: true, auth: 'yes' }] }),
    ];
    keys = [OPENAI_OFF];
    pools = [claudePool({ label: 'My Codex', engine: 'codex', members: [], unavailable: 'Not signed in' })];
    await mount();
    expect(stateOf('Codex')).toBe('Not set up');
    expect(sourcesOf('Codex')).toEqual([]);
    // With no machine online to install on, the way to one is registering it.
    expect(link('Install on a machine', engineCard('Codex'))?.getAttribute('href')).toBe('/runners/register');
  });
});
