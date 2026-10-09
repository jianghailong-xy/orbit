// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import type { ProviderPool } from '../lib/providerPools';
import { InfrastructurePage } from './InfrastructurePage';

/**
 * The top of /infrastructure (docs/mocks/infrastructure-page/02-after-infrastructure.png). First what
 * needs a person, a line each: an engine signed out on a machine that is online, signed in again from
 * that line; a machine that is offline, with its page; an account pool no session can start on, with
 * its page — and no block at all while nothing does. Then what the agents can run on, a card per
 * engine (docs/mocks/provider-engine-decoupling/web-1-infrastructure.html): Ready with a machine signed
 * in to it, a key that runs on it or a pool of it — each key under every engine its `engines` names —
 * and Not set up, with the ways to get one, without.
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
      <AntdApp>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/infrastructure']}>
            <Probe />
            <Routes>
              <Route path="/infrastructure" element={<InfrastructurePage />} />
              <Route path="*" element={<div>elsewhere</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AntdApp>,
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

/** Needs attention, line by line: what it says, and the way out at its end. */
const attention = () =>
  [...document.body.querySelectorAll<HTMLElement>('.infra-attn-row')].map((row) => ({
    says: text(row.querySelector('.infra-attn-text')),
    action: text(row.querySelector('button')),
    to: row.querySelector('a')?.getAttribute('href') ?? null,
  }));
const attentionRow = (says: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.infra-attn-row')].find((row) =>
    text(row.querySelector('.infra-attn-text'))?.startsWith(says),
  )!;
/** An engine's card, by the name it heads with. */
const nameOf = (card: Element) => card.querySelector('.infra-engine-name')?.firstChild?.textContent;
const engineCard = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.infra-engine')].find((card) => nameOf(card) === name)!;
const stateOf = (name: string) => text(engineCard(name).querySelector('.infra-engine-state'));
const sourcesOf = (name: string) => [...engineCard(name).querySelectorAll('.infra-engine-src > div')].map(text);

describe('Needs attention, at the top of /infrastructure', () => {
  it('lists an engine signed out on a machine that is online, and signs it in from that line', async () => {
    await mount();
    expect(attention()[0]).toEqual({
      says: 'Codex is signed out on Mac Studio · Sessions there can’t use it',
      action: 'Sign in',
      to: null,
    });
    // ThinkPad's Codex said no too, but ThinkPad is offline: that is the line it gets.
    expect(attention().filter((line) => line.says?.includes('signed out'))).toHaveLength(1);

    // The sign-in the machine's own engine row opens, here under its line.
    const row = attentionRow('Codex is signed out on Mac Studio');
    await click(button('Sign in', row));
    await click(button('Sign in to Codex', row));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${MAC}/login`, body: { engine: 'codex' } }]);
  });

  it('says nothing of an engine still signed in on another account, or one whose CLI would not say', async () => {
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
    expect(document.body.querySelector('.infra-attn')).toBeNull();
  });

  it('lists a machine that is offline, and opens its page', async () => {
    await mount();
    expect(attention()[1]).toEqual({
      says: 'ThinkPad is offline · Last seen 1d ago · its subscriptions are unavailable until it’s back',
      action: 'Details',
      to: `/runners/${THINKPAD}`,
    });
    await click(attentionRow('ThinkPad is offline').querySelector('a'));
    expect(path).toBe(`/runners/${THINKPAD}`);
  });

  it('lists an account pool no session can start on, and opens its page', async () => {
    pools = [claudePool({ unavailable: 'No account can run' })];
    await mount();
    expect(attention()[2]).toEqual({
      says: 'Claude keys is unavailable · No account can run · no session can start on it',
      action: 'Manage',
      to: `/providers/pools/${POOL}`,
    });
    // Nor is it something Claude Code can run on.
    expect(sourcesOf('Claude Code')).not.toContainEqual(expect.stringMatching(/^Pool/));
    await click(attentionRow('Claude keys is unavailable').querySelector('a'));
    expect(path).toBe(`/providers/pools/${POOL}`);
  });

  it('is not there at all while nothing needs a person', async () => {
    runners = [HPC_BOX];
    await mount();
    expect(document.body.querySelector('.infra-attn')).toBeNull();
    // The page goes straight on to what the agents can run on.
    expect(text(document.body.querySelector('.re-sec-head h3'))).toBe('What your agents can run on');
  });
});

describe('What your agents can run on', () => {
  it('heads the page’s sections, an engine to a card, each Ready with what can pay for it now', async () => {
    await mount();
    expect([...document.body.querySelectorAll('.re-sec-head h3')].map(text)).toEqual([
      'What your agents can run on',
      'Machines',
      'API keys',
      'Account pools',
    ]);
    expect(text(document.body.querySelector('.re-sec-head .re-sec-sub'))).toBe(
      'Every engine, and everything that can pay for it right now.',
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
    // Online machines signed in to it, by how many of their accounts; keys that run on it; its pools.
    expect(sourcesOf('Claude Code')).toEqual([
      'Subscription · Mac Studio ×2, HPC',
      'API key · Anthropic (Claude) Claude Opus 5, Anthropic · Work Claude Sonnet 5, DeepSeek DeepSeek V4 Pro',
      'Pool · Claude keys',
    ]);
    // Mac Studio's Codex is signed out, and ThinkPad's Claude Code is on a machine that is offline.
    expect(sourcesOf('Codex')).toEqual(['Subscription · HPC ×2']);
    expect(sourcesOf('Kimi Code')).toEqual(['Subscription · HPC']);
    // The same three keys again: OpenCode runs every one of them, DeepSeek Harness the DeepSeek key.
    expect(sourcesOf('OpenCode')).toEqual([
      'API key · Anthropic (Claude) Claude Opus 5, Anthropic · Work Claude Sonnet 5, DeepSeek DeepSeek V4 Pro',
    ]);
    expect(sourcesOf('DeepSeek Harness')).toEqual(['API key · DeepSeek']);
  });

  it('puts one key under every engine it runs on, beside the model it starts on there', async () => {
    runners = [];
    pools = [];
    keys = [DEEPSEEK, MOONSHOT, OPENAI_OFF];
    await mount();
    // DeepSeek is a vendor of its own, and its one key runs on three engines.
    const claude = engineCard('Claude Code');
    expect(stateOf('Claude Code')).toBe('Ready');
    expect(sourcesOf('Claude Code')).toEqual(['API key · DeepSeek DeepSeek V4 Pro']);
    expect([...claude.querySelectorAll('.infra-model')].map(text)).toEqual(['DeepSeek V4 Pro']);
    expect(sourcesOf('OpenCode')).toEqual(['API key · DeepSeek DeepSeek V4 Pro, Kimi (Moonshot) Kimi K2.7 Code']);
    // Harness lists its models on each machine, and none has reported them: the key, and no model.
    expect(stateOf('DeepSeek Harness')).toBe('Ready');
    expect(sourcesOf('DeepSeek Harness')).toEqual(['API key · DeepSeek']);
    expect(sourcesOf('Kimi Code')).toEqual(['API key · Kimi (Moonshot) Kimi K2.7 Code']);
    // A key that is switched off is nothing Codex — or OpenCode — can run on.
    expect(stateOf('Codex')).toBe('Not set up');
    expect(sourcesOf('OpenCode').join()).not.toContain('OpenAI');
  });

  it('names a DeepSeek Harness session’s model from a machine’s Harness catalogue, the same for every DeepSeek key', async () => {
    const flash = '["deepseek", "deepseek-v4-flash"]';
    runners = [
      machine(HPC, 'HPC', {
        capabilities: ['provider:dsh'],
        engines: [{ engine: 'dsh', installed: true, auth: 'unknown', version: '0.2.0-rc.2' }],
        modelCatalog: {
          dsh: [
            { value: '["deepseek", "deepseek-v4-pro"]', label: 'DeepSeek V4 Pro' },
            { value: flash, label: 'DeepSeek V4 Flash' },
          ],
        } as Runner['modelCatalog'],
        runtimeDefaultModels: { dsh: flash } as Runner['runtimeDefaultModels'],
      }),
    ];
    pools = [];
    keys = [DEEPSEEK, key(6, 'DeepSeek 2', { ...DEEPSEEK, id: id(106), slug: 'deepseek-2', label: 'DeepSeek 2' })];
    await mount();
    expect(sourcesOf('DeepSeek Harness')).toEqual(['API key · DeepSeek DeepSeek V4 Flash, DeepSeek 2 DeepSeek V4 Flash']);
    // On Claude Code and OpenCode each key starts on its own list's default.
    expect(sourcesOf('Claude Code')).toEqual(['API key · DeepSeek DeepSeek V4 Pro, DeepSeek 2 DeepSeek V4 Pro']);
    expect(sourcesOf('OpenCode')).toEqual(['API key · DeepSeek DeepSeek V4 Pro, DeepSeek 2 DeepSeek V4 Pro']);
  });

  it('lists a Claude subscription token under Claude Code alone, as the server answers for it', async () => {
    runners = [];
    pools = [];
    keys = [key(7, 'Claude Max', { engines: ['claude'] as ProviderRow['engines'] }), ANTHROPIC_WORK];
    await mount();
    expect(sourcesOf('Claude Code')).toEqual(['API key · Claude Max Claude Opus 5, Anthropic · Work Claude Sonnet 5']);
    expect(sourcesOf('OpenCode')).toEqual(['API key · Anthropic · Work Claude Sonnet 5']);
  });

  it('says where OpenCode’s own sign-in is set up, beside the keys it runs', async () => {
    runners = [
      machine(HPC, 'HPC', { engines: [{ engine: 'opencode', installed: true, auth: 'yes', version: '1.18.35' }] }),
      machine(MAC, 'Mac Studio', { engines: [{ engine: 'opencode', installed: true, auth: 'no', version: '1.18.35' }] }),
    ];
    pools = [];
    keys = [MOONSHOT];
    await mount();
    expect(sourcesOf('OpenCode')).toEqual(['Own sign-in · HPC', 'API key · Kimi (Moonshot) Kimi K2.7 Code']);
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
